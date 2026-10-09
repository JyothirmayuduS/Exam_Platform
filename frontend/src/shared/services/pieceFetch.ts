// Fetch stored recording pieces for review and export.
//
// Presigned links expire (1 h by default), and a two-hour exam takes longer
// than that to watch or download, so links are signed in small batches just
// before they are needed and signed again before they expire, or when storage
// answers 401/403. A piece that cannot be signed or fetched is reported, never
// silently skipped.
import { getArtifactObjectUrl, getArtifactUrls } from "@/shared/services/examStorage";
import { PART_SECONDS, type PieceTimeline, type TimedPiece } from "@/shared/services/recordingParts";
import { IncompatibleSessionError, startsWithWebmHeader, WebmJoiner } from "@/shared/services/webmJoin";

export const LINK_TTL_SEC = 3600;
/** Sign again when less than this much validity is left. */
export const LINK_REFRESH_MARGIN_SEC = 300;
const SIGN_BATCH = 40;

export class PieceError extends Error {
  readonly key: string;
  readonly reason: string;
  constructor(key: string, reason: string) {
    super(reason);
    this.key = key;
    this.reason = reason;
  }
}

/** Batch-sign; keys the batch call left out are signed one by one. */
export async function signKeys(keys: string[], expiresSec: number): Promise<Map<string, string>> {
  const signed = await getArtifactUrls(keys, expiresSec);
  const missing = keys.filter((k) => !signed.has(k));
  const single = await Promise.all(missing.map((k) => getArtifactObjectUrl(k, expiresSec).catch(() => null)));
  missing.forEach((k, i) => { const u = single[i]; if (u) signed.set(k, u); });
  return signed;
}

export type PieceFetcher = {
  /** A link valid for at least LINK_REFRESH_MARGIN_SEC more. */
  url: (key: string) => Promise<string>;
  bytes: (key: string) => Promise<Uint8Array>;
  /** Number of signing round trips so far. */
  signCalls: () => number;
};

export function createPieceFetcher(opts: {
  /** Keys in playback order; neighbours are signed together. */
  keys: string[];
  sign?: (keys: string[], expiresSec: number) => Promise<Map<string, string>>;
  fetchImpl?: (url: string) => Promise<Response>;
  ttlSec?: number;
  now?: () => number;
  retries?: number;
  backoffMs?: number;
}): PieceFetcher {
  const sign = opts.sign ?? signKeys;
  const doFetch = opts.fetchImpl ?? ((url: string) => fetch(url));
  const ttl = opts.ttlSec ?? LINK_TTL_SEC;
  const now = opts.now ?? Date.now;
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 500;
  const order = new Map(opts.keys.map((k, i) => [k, i]));
  const links = new Map<string, { url: string; expires: number }>();
  const inflight = new Map<string, Promise<void>>();
  let calls = 0;

  const fresh = (key: string) => {
    const l = links.get(key);
    return l && l.expires - now() > LINK_REFRESH_MARGIN_SEC * 1000 ? l.url : null;
  };

  const signAround = (key: string): Promise<void> => {
    const running = inflight.get(key);
    if (running) return running;
    const at = order.get(key);
    const batch = at === undefined
      ? [key]
      : opts.keys.slice(at, at + SIGN_BATCH).filter((k, i) => i === 0 || (!fresh(k) && !inflight.has(k)));
    const work = (async () => {
      calls += 1;
      const signedAt = now();
      let signed: Map<string, string>;
      try { signed = await sign(batch, ttl); } catch { signed = new Map(); }
      for (const k of batch) {
        const url = signed.get(k);
        if (url) links.set(k, { url, expires: signedAt + ttl * 1000 });
      }
    })().finally(() => { for (const k of batch) inflight.delete(k); });
    for (const k of batch) inflight.set(k, work);
    return work;
  };

  const url = async (key: string): Promise<string> => {
    let u = fresh(key);
    if (u) return u;
    await signAround(key);
    u = fresh(key);
    if (u) return u;
    // One more try on its own before giving up.
    links.delete(key);
    await signAround(key);
    u = fresh(key);
    if (!u) throw new PieceError(key, "could not be signed");
    return u;
  };

  const bytes = async (key: string): Promise<Uint8Array> => {
    let reason = "could not be downloaded";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, backoff * 2 ** (attempt - 1)));
      const link = await url(key);
      let res: Response;
      try {
        res = await doFetch(link);
      } catch {
        reason = "could not be downloaded (network error)";
        continue;
      }
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      if (res.status === 401 || res.status === 403 || res.status === 400) {
        links.delete(key);
        reason = `link was refused (HTTP ${res.status})`;
        continue;
      }
      if (res.status === 404) throw new PieceError(key, "is missing from storage (HTTP 404)");
      reason = `could not be downloaded (HTTP ${res.status})`;
    }
    throw new PieceError(key, reason);
  };

  return { url, bytes, signCalls: () => calls };
}

export type MissingPiece = { key: string; start: number; end: number; reason: string };

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** One line per missing piece, with its place on the exam timeline. */
export function describeMissing(missing: MissingPiece[]): string[] {
  return missing.map((m) => `${clock(m.start)}–${clock(m.end)}: piece ${m.key.split("/").pop()} ${m.reason}`);
}

export type JoinResult = {
  missing: MissingPiece[];
  bytes: number;
  /** Extra files started when a later session could not share the first file's format. */
  files: number;
};

/**
 * Stream one recording (its pieces in timeline order) as one file through
 * `write`. Only the piece being joined and a small read-ahead are in memory.
 * `nextFile` is called when a later session has a different format and must
 * go in a file of its own.
 */
export async function joinPieces<T>(opts: {
  timeline: PieceTimeline<T>;
  fetcher: PieceFetcher;
  write: (chunk: Uint8Array) => Promise<void>;
  nextFile?: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  readAhead?: number;
}): Promise<JoinResult> {
  const { timeline, fetcher, write } = opts;
  const pieces = timeline.pieces;
  const missing: MissingPiece[] = [];
  const ahead = opts.readAhead ?? 2;
  const pending = new Map<number, Promise<Uint8Array>>();
  const load = (i: number) => {
    let p = pending.get(i);
    if (!p) {
      p = fetcher.bytes(pieces[i].key);
      p.catch(() => undefined);
      pending.set(i, p);
    }
    return p;
  };
  let joiner = new WebmJoiner();
  let raw: boolean | null = null;
  let session: number | null = null;
  let total = 0;
  let files = 1;
  const out = async (chunk: Uint8Array) => {
    if (chunk.length === 0) return;
    total += chunk.length;
    await write(chunk);
  };
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j <= Math.min(pieces.length - 1, i + ahead); j++) void load(j);
    const piece: TimedPiece<T> = pieces[i];
    let data: Uint8Array;
    try {
      data = await load(i);
    } catch (err) {
      pending.delete(i);
      missing.push({ key: piece.key, start: piece.start, end: piece.end, reason: err instanceof PieceError ? err.reason : "could not be downloaded" });
      if (raw === false) joiner.skipToCluster();
      opts.onProgress?.(i + 1, pieces.length);
      continue;
    }
    pending.delete(i);
    const header = startsWithWebmHeader(data);
    // Containers other than WebM (an MP4 fallback recorder) are one session
    // of fragments that play when concatenated as they are.
    if (raw === null) raw = !header && data.length > 0 && !looksLikeWebmCluster(data);
    if (raw) {
      await out(data);
    } else {
      // A session whose header piece was lost continues with the previous
      // session's track layout, at its own place on the timeline.
      if (!header && piece.session !== session && joiner.header) joiner.resync(null, piece.offsetMs);
      session = piece.session;
      try {
        await out(joiner.push(data, piece.offsetMs));
      } catch (err) {
        if (!(err instanceof IncompatibleSessionError) || !opts.nextFile) throw err;
        await opts.nextFile();
        files += 1;
        joiner = new WebmJoiner();
        await out(joiner.push(data, piece.offsetMs));
      }
      if (!joiner.header) {
        missing.push({ key: piece.key, start: piece.start, end: piece.end, reason: "cannot be played without the recording's first piece" });
      }
    }
    opts.onProgress?.(i + 1, pieces.length);
  }
  return { missing, bytes: total, files };
}

function looksLikeWebmCluster(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x1f && b[1] === 0x43 && b[2] === 0xb6 && b[3] === 0x75;
}

/** Approximate length of a recording stored as pieces. */
export function timelineMinutes(t: PieceTimeline<unknown>): number {
  return Math.max(1, Math.round((t.durationSec || t.pieces.length * PART_SECONDS) / 60));
}
