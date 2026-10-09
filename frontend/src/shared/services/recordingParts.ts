// Recording pieces: the only stored copy of each exam recording.
//
// MediaRecorder emits a chunk every 10 s. Each chunk is written to the
// device's disk outbox and uploaded as
//   ${examFolder}/${owner}/recordings/parts/${family}_${seq}_${session}.webm
// then deleted locally. Nothing accumulates in memory, and no merged copy is
// uploaded at submit: review joins the pieces in order (RecordingReview,
// zipExport). A failed piece stays on disk and retries; on a weak link uploads
// pause and resume when it recovers. After submit, drain() keeps uploading on
// any link until nothing is left on the device.
//
// `seq` is the chunk's wall-clock time in ms (strictly increasing), so a
// recorder restarted after a reload never overwrites an earlier piece.
// `session` is the wall-clock ms at which that MediaRecorder started: every
// session begins with its own WebM header, and review places it on the exam
// timeline at that time. Pieces written before sessions were named
// (`${family}_${seq}.webm`, and the older 8-digit counters) are still read.
//
// One uploader owns a piece prefix (exam/owner/family) at a time. Starting a
// new one (recorder restart, app restart) retires the old one: it finishes its
// in-flight uploads, then the new one takes over everything left.
import { createSnapshotOutbox, defaultSnapshotStore, type SnapshotOutbox, type SnapshotStore } from "@/shared/services/snapshotOutbox";
import { r2PutBlob } from "@/shared/services/r2Function";

export type RecordingFamily = "exam" | "screen";

export type RecordingSession = {
  /** Wall-clock ms at which the recorder started. */
  start: number;
  enqueue: (blob: Blob) => void;
  /** The recorder has delivered its last chunk. Safe to call more than once. */
  end: () => void;
};

export type PartUploader = {
  /** A piece outside any recorder session (named without a session). */
  enqueue: (blob: Blob) => void;
  /** Open a recorder session; drain() waits until every session has ended. */
  beginSession: () => RecordingSession;
  setPaused: (on: boolean) => void;
  /** Upload everything still on the device once; true when nothing is pending. */
  flush: () => Promise<boolean>;
  /**
   * After submit: wait for open recorder sessions to end, then keep uploading
   * on any link, retrying every PART_RETRY_MS, until nothing is left.
   */
  drain: () => Promise<void>;
  pendingCount: () => number;
  /** Pieces recorders handed to this prefix since the page loaded. */
  producedCount: () => number;
  /** Release: the uploader shuts down by itself once nothing is left to send. */
  stop: () => void;
};

export const PART_RETRY_MS = 10_000;
export const PART_SECONDS = 10;
/** A recorder that never reports stop is treated as stopped after this long. */
export const STOP_GRACE_MS = 5_000;

/** Every family that has ever written pieces. */
export const PIECE_FAMILIES = [
  { family: "exam", label: "camera", title: "Camera + microphone" },
  { family: "screen", label: "screen", title: "Screen" },
  { family: "camera", label: "camera-legacy", title: "Camera (older kiosk)" },
  { family: "seg", label: "recording-legacy", title: "Exam recording (older kiosk)" },
] as const;

const pieceRe = (family: string) => new RegExp(`/parts/${family}_(\\d+)(?:_(\\d+))?\\.webm$`);

/** Pieces of one recorder family, in recording order. */
export function sortedParts<T extends { kind: string; key: string }>(arts: T[], family: string): T[] {
  const re = pieceRe(family);
  const seq = (k: string) => Number(k.match(re)?.[1] ?? 0);
  return arts
    .filter((a) => a.kind === "recordings" && re.test(a.key))
    .sort((a, b) => seq(a.key) - seq(b.key));
}

export function partName(family: RecordingFamily, seq: number, session?: number): string {
  const pad = (n: number) => String(n).padStart(13, "0");
  return `${family}_${pad(seq)}${session != null ? `_${pad(session)}` : ""}.webm`;
}

export type TimedPiece<T> = {
  piece: T;
  key: string;
  /** Seconds on the exam timeline. */
  start: number;
  end: number;
  /** Timeline ms of time 0 of the recorder session this piece belongs to. */
  offsetMs: number;
  /** Session id: the recorder start time, or an inferred stand-in. */
  session: number;
  /** First known piece of its session (carries the WebM header). */
  head: boolean;
};

export type PieceTimeline<T> = {
  pieces: TimedPiece<T>[];
  durationSec: number;
  /** Wall-clock ms of timeline 0, when piece names carry wall-clock times. */
  originMs: number | null;
};

const WALL_CLOCK_MS = 1e12;
const SESSION_GAP_MS = PART_SECONDS * 1000 * 1.5;

/**
 * Place sorted pieces on the exam timeline. With wall-clock names, timeline
 * time is real time since the first recorder started, so a later session
 * (after a reload) starts where it really did and violation times line up.
 * Older counter names fall back to 10 s per piece.
 */
export function pieceTimeline<T extends { key: string }>(sorted: T[]): PieceTimeline<T> {
  const parsed = sorted.map((p) => {
    const m = p.key.match(/_(\d+)(?:_(\d+))?\.webm$/);
    return { p, seq: Number(m?.[1] ?? 0), session: m?.[2] != null ? Number(m[2]) : null };
  });
  const out: TimedPiece<T>[] = [];
  if (parsed.length === 0) return { pieces: out, durationSec: 0, originMs: null };
  const wall = parsed[0].seq >= WALL_CLOCK_MS;
  if (!wall) {
    parsed.forEach(({ p }, i) => out.push({
      piece: p, key: p.key, start: i * PART_SECONDS, end: (i + 1) * PART_SECONDS,
      offsetMs: i * PART_SECONDS * 1000, session: 0, head: i === 0,
    }));
    return { pieces: out, durationSec: parsed.length * PART_SECONDS, originMs: null };
  }
  const first = parsed[0];
  const originMs = Math.min(first.session ?? first.seq - PART_SECONDS * 1000, first.seq);
  let prevEnd = 0;
  let prevSeq = -Infinity;
  let session = NaN;
  let sessionOffset = 0;
  for (const { p, seq, session: named } of parsed) {
    const endMs = Math.max(seq - originMs, prevEnd + 1);
    const inferredNew = named == null && seq - prevSeq > SESSION_GAP_MS;
    const isHead = named != null ? named !== session : inferredNew;
    if (isHead) {
      session = named ?? seq;
      sessionOffset = named != null
        ? Math.max(named - originMs, prevEnd)
        : Math.max(seq - originMs - PART_SECONDS * 1000, prevEnd);
    }
    const startMs = isHead ? sessionOffset : prevEnd;
    out.push({
      piece: p, key: p.key, start: startMs / 1000, end: endMs / 1000,
      // Unnamed pieces may still start a session (recorder failover); place
      // such a header where the piece starts.
      offsetMs: named != null ? sessionOffset : startMs,
      session, head: isHead,
    });
    prevEnd = endMs;
    prevSeq = seq;
  }
  return { pieces: out, durationSec: prevEnd / 1000, originMs };
}

type UploadFn = (opts: { examId: string; ownerSegment: string; kind: "recordings"; name: string; blob: Blob }) => Promise<string | null>;

type Uploader = PartUploader & {
  retire: () => Promise<Map<string, Blob>>;
  enqueueAt: (blob: Blob, session?: number) => void;
  /** Shut down if released and nothing is left. */
  check: () => void;
};

type Entry = {
  live: Uploader | null;
  sessions: number;
  sessionWaiters: (() => void)[];
  lastSeq: number;
  produced: number;
  draining: boolean;
};

const registry = new Map<string, Entry>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startPartUploads(opts: {
  folder: string;
  owner: string;
  family: RecordingFamily;
  onError?: (message: string) => void;
  store?: SnapshotStore;
  upload?: UploadFn;
  now?: () => number;
}): PartUploader {
  const base = `${opts.folder}/${opts.owner}/recordings/`;
  const prefix = `${base}parts/${opts.family}_`;
  const put = opts.upload ?? r2PutBlob;
  const now = opts.now ?? Date.now;
  let entry = registry.get(prefix);
  if (!entry) {
    entry = { live: null, sessions: 0, sessionWaiters: [], lastSeq: 0, produced: 0, draining: false };
    registry.set(prefix, entry);
  }
  const e = entry;
  const handover = e.live?.retire();

  let retired = false;
  let released = false;
  let shut = false;
  let retry: ReturnType<typeof setInterval> | undefined;
  const shutdownIfDone = () => {
    if (!released || retired || shut || e.sessions > 0 || !outbox.idle()) return;
    shut = true;
    clearInterval(retry);
    if (e.live === self) registry.delete(prefix);
  };
  const outbox: SnapshotOutbox = createSnapshotOutbox({
    prefix,
    store: opts.store,
    onError: opts.onError,
    after: handover,
    onIdle: () => shutdownIfDone(),
    pendingMessage: "Some recording pieces are waiting to upload. Keep the app open and check your connection.",
    upload: async (key, blob) => {
      try {
        return !!await put({ examId: opts.folder, ownerSegment: opts.owner, kind: "recordings", name: key.slice(base.length), blob });
      } catch {
        return false;
      }
    },
  });
  retry = setInterval(() => { outbox.retry(); shutdownIfDone(); }, PART_RETRY_MS);
  if (e.draining) outbox.setPaused(false);

  const live = (): Uploader => (retired && e.live && e.live !== self ? e.live : self);
  const endSession = () => {
    e.sessions = Math.max(0, e.sessions - 1);
    if (e.sessions === 0) {
      for (const wake of e.sessionWaiters.splice(0)) wake();
      e.live?.check();
    }
  };

  const self: Uploader = {
    enqueue: (blob) => self.enqueueAt(blob),
    enqueueAt: (blob, session) => {
      if (blob.size <= 0) return;
      if (retired && e.live && e.live !== self) { e.live.enqueueAt(blob, session); return; }
      e.lastSeq = Math.max(now(), e.lastSeq + 1);
      e.produced += 1;
      outbox.enqueue(`${base}parts/${partName(opts.family, e.lastSeq, session)}`, blob);
    },
    beginSession: () => {
      const start = now();
      let open = true;
      e.sessions += 1;
      return {
        start,
        enqueue: (blob) => live().enqueueAt(blob, start),
        end: () => {
          if (!open) return;
          open = false;
          endSession();
        },
      };
    },
    setPaused: (on) => {
      if (retired) { e.live?.setPaused(on); return; }
      if (!e.draining) outbox.setPaused(on);
    },
    flush: async () => {
      if (retired && e.live && e.live !== self) return e.live.flush();
      return outbox.flush();
    },
    drain: async () => {
      e.draining = true;
      live().setPaused(false);
      for (;;) {
        while (e.sessions > 0) await new Promise<void>((r) => e.sessionWaiters.push(r));
        if (await live().flush() && e.sessions === 0) return;
        if (e.sessions === 0) await sleep(PART_RETRY_MS);
      }
    },
    pendingCount: () => (retired && e.live && e.live !== self ? e.live.pendingCount() : outbox.pendingCount()),
    producedCount: () => e.produced,
    stop: () => {
      if (retired) return;
      released = true;
      shutdownIfDone();
    },
    check: () => shutdownIfDone(),
    retire: () => {
      retired = true;
      clearInterval(retry);
      return outbox.retire();
    },
  };
  e.live = self;
  return self;
}

/** The uploader that currently owns this prefix, or a new one that picks up leftovers. */
export function openPartUploads(opts: Parameters<typeof startPartUploads>[0]): PartUploader {
  const live = registry.get(`${opts.folder}/${opts.owner}/recordings/parts/${opts.family}_`)?.live;
  return live ?? startPartUploads(opts);
}

const LEFTOVER = /^(.+)\/([^/]+)\/recordings\/parts\/(exam|screen)_\d+(?:_\d+)?\.webm$/;

/**
 * App start: upload pieces left on this device by any earlier sitting (a
 * crash, a closed app, a reload). Each uploader shuts down once its pieces
 * have landed. Returns the piece prefixes found.
 */
export async function resumeLeftoverPieces(opts: { store?: SnapshotStore; upload?: UploadFn } = {}): Promise<string[]> {
  const store = opts.store ?? defaultSnapshotStore();
  if (!store) return [];
  let keys: string[];
  try { keys = await store.keys(""); } catch { return []; }
  const found = new Map<string, { folder: string; owner: string; family: RecordingFamily }>();
  for (const key of keys) {
    const m = key.match(LEFTOVER);
    if (!m) continue;
    const [, folder, owner, family] = m;
    found.set(`${folder}/${owner}/recordings/parts/${family}_`, { folder, owner, family: family as RecordingFamily });
  }
  for (const [prefix, where] of found) {
    if (registry.get(prefix)?.live) continue;
    startPartUploads({ ...where, store, upload: opts.upload }).stop();
  }
  return [...found.keys()];
}

/** The parts of MediaRecorder this module drives (a test seam). */
export type RecorderLike = {
  state: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start: (timeslice?: number) => void;
  stop: () => void;
};

/** Run `recorder` as one session of `parts`: every chunk becomes a piece. */
export function recordInto(media: MediaRecorder | RecorderLike, parts: PartUploader, timesliceMs: number): { session: RecordingSession; stop: () => void } {
  const recorder = media as RecorderLike;
  const session = parts.beginSession();
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) session.enqueue(e.data); };
  recorder.onstop = () => session.end();
  try {
    recorder.start(timesliceMs);
  } catch (err) {
    session.end();
    throw err;
  }
  return {
    session,
    stop: () => {
      if (recorder.state === "inactive") { session.end(); return; }
      try { recorder.stop(); } catch { session.end(); }
      setTimeout(session.end, STOP_GRACE_MS);
    },
  };
}
