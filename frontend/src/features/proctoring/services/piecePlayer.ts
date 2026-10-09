// Play a recording stored as pieces as one full-length video.
//
// Pieces are joined (webmJoin) onto the exam timeline and appended to a Media
// Source buffer around the playhead only: about AHEAD_SEC ahead and
// BEHIND_SEC behind, so a two-hour exam never fills memory. Seeking to a time
// that is not buffered (a violation marker, an earlier point that was
// dropped, or further ahead) reloads from the piece that covers it. The gap
// between two recorder sessions (a page reload) is skipped. Links are signed
// again before they expire (pieceFetch), and pieces that cannot be signed or
// fetched are reported in the status instead of being skipped silently.
import type { PieceFetcher, MissingPiece } from "@/shared/services/pieceFetch";
import { PieceError } from "@/shared/services/pieceFetch";
import type { PieceTimeline } from "@/shared/services/recordingParts";
import {
  IncompatibleSessionError,
  parseSessionHeader,
  startsWithWebmHeader,
  WebmJoiner,
  webmMimeType,
  type SessionHeader,
} from "@/shared/services/webmJoin";

export const AHEAD_SEC = 90;
export const BEHIND_SEC = 30;

export type PlayerStatus = {
  /** Pieces appended at least once. */
  loaded: number;
  total: number;
  missing: MissingPiece[];
  error: string | null;
  /** This browser cannot stream these pieces; join them into one file instead. */
  needsFile: boolean;
};

export type PiecePlayer = { destroy: () => void };

function sbWait(sb: SourceBuffer, op: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("Part of the video could not be decoded")); };
    const cleanup = () => {
      sb.removeEventListener("updateend", done);
      sb.removeEventListener("error", fail);
    };
    sb.addEventListener("updateend", done);
    sb.addEventListener("error", fail);
    try { op(); } catch (err) { cleanup(); reject(err); }
  });
}

export function startPiecePlayer(opts: {
  video: HTMLVideoElement;
  timeline: PieceTimeline<unknown>;
  fetcher: PieceFetcher;
  onStatus: (s: PlayerStatus) => void;
  /** Where to start playing (seconds), e.g. after a reload. */
  startAt?: number;
}): PiecePlayer {
  const { video, timeline, fetcher } = opts;
  const pieces = timeline.pieces;
  const n = pieces.length;
  const status: PlayerStatus = { loaded: 0, total: n, missing: [], error: null, needsFile: false };
  const report = () => opts.onStatus({ ...status, missing: [...status.missing] });
  const missing = new Map<string, MissingPiece>();
  const loaded = new Set<number>();
  const headers = new Map<number, SessionHeader>();
  const cache = new Map<number, Promise<Uint8Array>>();
  let joiner = new WebmJoiner();
  let sb: SourceBuffer | null = null;
  let gen = 0;
  let cursor = 0;
  let session: number | null = null;
  let destroyed = false;
  let wake: (() => void) | null = null;

  const fail = (message: string, needsFile = false) => {
    if (destroyed) return;
    status.error = needsFile ? null : message;
    status.needsFile = needsFile;
    report();
  };
  const markMissing = (i: number, reason: string) => {
    const p = pieces[i];
    if (!missing.has(p.key)) {
      missing.set(p.key, { key: p.key, start: p.start, end: p.end, reason });
      status.missing = [...missing.values()].sort((a, b) => a.start - b.start);
      report();
    }
  };

  if (typeof MediaSource === "undefined" || n === 0) {
    queueMicrotask(() => fail("Streaming is not available in this browser", true));
    return { destroy: () => { destroyed = true; } };
  }

  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  video.src = url;

  const load = (i: number) => {
    let p = cache.get(i);
    if (!p) {
      p = fetcher.bytes(pieces[i].key);
      p.catch(() => undefined);
      cache.set(i, p);
    }
    return p;
  };
  const idle = () => new Promise<void>((resolve) => {
    const t = setTimeout(() => { wake = null; resolve(); }, 1000);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });
  const buffered = (t: number) => {
    if (!sb) return false;
    const r = sb.buffered;
    for (let i = 0; i < r.length; i++) if (t >= r.start(i) && t < r.end(i) - 0.1) return true;
    return false;
  };
  /** Start of the next piece when `t` falls between two pieces (a session gap). */
  const gapTarget = (t: number): number | null => {
    const next = pieces.find((p) => p.end > t);
    return next && next.start > t + 0.5 ? next.start : null;
  };
  const sbIdle = async () => {
    while (sb?.updating) await new Promise((r) => sb!.addEventListener("updateend", r, { once: true }));
  };
  const headerFor = async (i: number): Promise<SessionHeader | null> => {
    const s = pieces[i].session;
    const cached = headers.get(s);
    if (cached) return cached;
    const head = pieces.findIndex((p) => p.session === s && p.head);
    if (head < 0 || head === i) return null;
    try {
      const parsed = parseSessionHeader(await load(head));
      if (parsed && parsed !== "bad") { headers.set(s, parsed.header); return parsed.header; }
    } catch { /* reported when that piece is played */ }
    return null;
  };

  const append = async (out: Uint8Array, g: number) => {
    if (out.length === 0 || !sb) return;
    await sbIdle();
    const t = video.currentTime;
    if (sb.buffered.length && sb.buffered.start(0) < t - BEHIND_SEC) {
      await sbWait(sb, () => sb!.remove(0, t - BEHIND_SEC));
    }
    for (;;) {
      if (g !== gen || destroyed) return;
      try {
        await sbWait(sb, () => sb!.appendBuffer(out as Uint8Array<ArrayBuffer>));
        return;
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "QuotaExceededError")) throw err;
        const keepFrom = Math.max(0, video.currentTime - 10);
        if (sb.buffered.length && sb.buffered.start(0) < keepFrom) await sbWait(sb, () => sb!.remove(0, keepFrom));
        else await idle();
      }
    }
  };

  const run = async (g: number, from: number) => {
    for (let i = from; i < n; i++) {
      cursor = i;
      while (pieces[i].start > video.currentTime + AHEAD_SEC) {
        await idle();
        if (g !== gen || destroyed) return;
      }
      for (let j = i + 1; j <= Math.min(n - 1, i + 2); j++) void load(j);
      let data: Uint8Array;
      try {
        data = await load(i);
      } catch (err) {
        cache.delete(i);
        if (g !== gen || destroyed) return;
        markMissing(i, err instanceof PieceError ? err.reason : "could not be downloaded");
        joiner.skipToCluster();
        continue;
      }
      cache.delete(i);
      if (g !== gen || destroyed) return;
      const p = pieces[i];
      const header = startsWithWebmHeader(data);
      if (header) {
        const parsed = parseSessionHeader(data);
        if (parsed && parsed !== "bad") headers.set(p.session, parsed.header);
      } else if (!joiner.header) {
        // A recording's first piece that is not WebM (an MP4 recorder) cannot
        // be streamed here.
        if (p.head && !sb) { fail("not webm", true); return; }
        const h = await headerFor(i);
        if (g !== gen || destroyed) return;
        if (h) joiner.resync(h, p.offsetMs);
      }
      if (!header && p.session !== session && joiner.header) joiner.resync(headers.get(p.session) ?? null, p.offsetMs);
      session = p.session;
      let out: Uint8Array;
      try {
        out = joiner.push(data, p.offsetMs);
      } catch (err) {
        if (!(err instanceof IncompatibleSessionError)) throw err;
        markMissing(i, "was recorded in a different format and plays only in the downloaded video");
        joiner.skipToCluster();
        continue;
      }
      if (!joiner.header) { markMissing(i, "cannot be played without the recording's first piece"); continue; }
      if (!sb) {
        const type = webmMimeType(joiner.header);
        if (!type || !MediaSource.isTypeSupported(type)) { fail("unsupported codec", true); return; }
        sb = ms.addSourceBuffer(type);
        sb.mode = "segments";
        if (timeline.durationSec > 0) ms.duration = timeline.durationSec;
      }
      await append(out, g);
      if (g !== gen || destroyed) return;
      if (!loaded.has(i)) { loaded.add(i); status.loaded = loaded.size; report(); }
    }
    cursor = n;
    await sbIdle();
    if (g === gen && !destroyed && ms.readyState === "open") {
      try { ms.endOfStream(); } catch { /* a seek reopened it */ }
    }
  };

  const go = (g: number, from: number) => {
    run(g, from).catch((err) => {
      if (g === gen) fail(err instanceof Error ? err.message : String(err));
    });
  };

  const jumpTo = async (t: number) => {
    const g = ++gen;
    wake?.();
    cache.clear();
    let k = pieces.findIndex((p) => p.end > t);
    if (k < 0) k = n - 1;
    const from = k > 0 && pieces[k - 1].session === pieces[k].session ? k - 1 : k;
    const header = pieces[from].head ? null : await headerFor(from);
    await sbIdle();
    if (g !== gen || destroyed) return;
    if (sb) {
      if (ms.readyState === "open") { try { sb.abort(); } catch { /* not parsing */ } }
      if (sb.buffered.length) {
        try { await sbWait(sb, () => sb!.remove(0, Math.max(ms.duration || 0, timeline.durationSec, t + 1))); } catch { /* nothing to drop */ }
      }
    }
    if (g !== gen || destroyed) return;
    if (pieces[from].head) joiner.reset();
    else joiner.resync(header, pieces[from].offsetMs, { resetClock: true });
    session = pieces[from].session;
    go(g, from);
  };

  const onSeeking = () => {
    const t = video.currentTime;
    const gap = gapTarget(t);
    if (gap !== null) { video.currentTime = gap; return; }
    if (buffered(t)) { wake?.(); return; }
    // The sequential loader is about to reach this point anyway.
    if (cursor < n && t >= pieces[cursor].start - 1 && t <= pieces[Math.min(n - 1, cursor + 2)].end) { wake?.(); return; }
    void jumpTo(t);
  };
  const onStall = () => {
    wake?.();
    const t = video.currentTime;
    if (buffered(t) || !sb) return;
    const gap = gapTarget(t);
    if (gap !== null) { video.currentTime = gap; return; }
    // Skip a small hole between sessions or around a missing piece.
    const r = sb.buffered;
    for (let i = 0; i < r.length; i++) {
      if (r.start(i) > t && r.start(i) - t < 3) { video.currentTime = r.start(i) + 0.01; return; }
    }
    const here = pieces.find((p) => p.start <= t && p.end > t);
    if (here && missing.has(here.key)) {
      const next = pieces.find((p) => p.start >= here.end && !missing.has(p.key));
      if (next) video.currentTime = next.start;
    }
  };
  const onTime = () => wake?.();

  video.addEventListener("seeking", onSeeking);
  video.addEventListener("waiting", onStall);
  video.addEventListener("stalled", onStall);
  video.addEventListener("timeupdate", onTime);

  ms.addEventListener("sourceopen", () => {
    report();
    const start = opts.startAt ?? 0;
    if (start > 0) {
      video.currentTime = start;
      void jumpTo(start);
    } else {
      go(++gen, 0);
    }
  }, { once: true });

  return {
    destroy: () => {
      destroyed = true;
      gen += 1;
      wake?.();
      cache.clear();
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("waiting", onStall);
      video.removeEventListener("stalled", onStall);
      video.removeEventListener("timeupdate", onTime);
      URL.revokeObjectURL(url);
    },
  };
}
