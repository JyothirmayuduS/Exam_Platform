// Join MediaRecorder WebM pieces into ONE stream, piece by piece.
//
// Each recorder session (a page reload or a camera/screen failover starts a
// new one) begins with its own WebM header and counts time from 0, so plain
// concatenation stops playing at the first new header. The joiner keeps the
// first header it sees, drops later ones, and rewrites every cluster time to
// `session offset + time in session`, i.e. onto the exam timeline. Later
// sessions' track numbers are mapped onto the first header's by track type.
//
// Output clusters are written with unknown size (as MediaRecorder does), so
// nothing is buffered beyond the element being parsed: memory stays at about
// one piece no matter how long the exam is.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
  TimecodeScale: 0x2ad7b1,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

const LEVEL1 = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments]);
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

type Vint = { value: number; len: number; unknown: boolean };

function readId(b: Uint8Array, p: number): Vint | null | "bad" {
  if (p >= b.length) return null;
  const first = b[p];
  const len = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
  if (!len) return "bad";
  if (p + len > b.length) return null;
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + b[p + i];
  return { value, len, unknown: false };
}

function readSize(b: Uint8Array, p: number): Vint | null | "bad" {
  if (p >= b.length) return null;
  const first = b[p];
  if (first === 0) return "bad";
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (p + len > b.length) return null;
  const mask = 0xff >> len;
  let value = first & mask;
  let unknown = value === mask;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i];
    if (b[p + i] !== 0xff) unknown = false;
  }
  return { value, len, unknown };
}

function readUint(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function encodeId(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

function encodeSize(n: number): number[] {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Array<number>(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
      out[0] |= 0x80 >> (len - 1);
      return out;
    }
  }
  throw new Error("Element too large");
}

function element(id: number, body: Uint8Array): Uint8Array {
  const head = [...encodeId(id), ...encodeSize(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

type Child = { id: number; body: Uint8Array; raw: Uint8Array };

/** Children of a fully buffered master element body. */
function children(body: Uint8Array): Child[] {
  const out: Child[] = [];
  let p = 0;
  while (p < body.length) {
    const id = readId(body, p);
    if (!id || id === "bad") break;
    const size = readSize(body, p + id.len);
    if (!size || size === "bad" || size.unknown) break;
    const start = p + id.len + size.len;
    const end = start + size.value;
    if (end > body.length) break;
    out.push({ id: id.value, body: body.subarray(start, end), raw: body.subarray(p, end) });
    p = end;
  }
  return out;
}

export type WebmTrack = { number: number; type: number; codec: string };

export type SessionHeader = {
  /** EBML header + Info + Tracks, as stored. */
  ebml: Uint8Array;
  info: Uint8Array | null;
  tracks: Uint8Array;
  timecodeScale: number;
  trackList: WebmTrack[];
};

/** True when the bytes start with a WebM/Matroska header. */
export function startsWithWebmHeader(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

/**
 * Parse a session header (everything before the first cluster). Returns null
 * when more bytes are needed, "bad" when this is not a WebM header.
 */
export function parseSessionHeader(b: Uint8Array): { header: SessionHeader; clusterAt: number } | null | "bad" {
  if (b.length < 4) return null;
  if (!startsWithWebmHeader(b)) return "bad";
  const ebmlSize = readSize(b, 4);
  if (!ebmlSize) return null;
  if (ebmlSize === "bad" || ebmlSize.unknown) return "bad";
  const ebmlEnd = 4 + ebmlSize.len + ebmlSize.value;
  if (ebmlEnd > b.length) return null;
  const segId = readId(b, ebmlEnd);
  if (!segId) return null;
  if (segId === "bad" || segId.value !== ID.Segment) return "bad";
  const segSize = readSize(b, ebmlEnd + segId.len);
  if (!segSize) return null;
  if (segSize === "bad") return "bad";
  let p = ebmlEnd + segId.len + segSize.len;
  let info: Uint8Array | null = null;
  let tracks: Uint8Array | null = null;
  for (;;) {
    const id = readId(b, p);
    if (!id) return null;
    if (id === "bad") return "bad";
    if (id.value === ID.Cluster) break;
    const size = readSize(b, p + id.len);
    if (!size) return null;
    if (size === "bad" || size.unknown) return "bad";
    const end = p + id.len + size.len + size.value;
    if (end > b.length) return null;
    if (id.value === ID.Info) info = b.slice(p, end);
    if (id.value === ID.Tracks) tracks = b.slice(p, end);
    p = end;
  }
  if (!tracks) return "bad";
  let timecodeScale = 1_000_000;
  if (info) {
    const body = children(info.subarray(info.length - bodyLength(info)));
    const scale = body.find((c) => c.id === ID.TimecodeScale);
    if (scale) timecodeScale = readUint(scale.body) || timecodeScale;
  }
  const trackList: WebmTrack[] = [];
  for (const entry of children(tracks.subarray(tracks.length - bodyLength(tracks)))) {
    if (entry.id !== ID.TrackEntry) continue;
    const fields = children(entry.body);
    const num = fields.find((f) => f.id === ID.TrackNumber);
    const type = fields.find((f) => f.id === ID.TrackType);
    const codec = fields.find((f) => f.id === ID.CodecID);
    if (!num) continue;
    trackList.push({
      number: readUint(num.body),
      type: type ? readUint(type.body) : 0,
      codec: codec ? new TextDecoder("latin1").decode(codec.body).replace(/\0+$/, "") : "",
    });
  }
  return { header: { ebml: b.slice(0, ebmlEnd), info, tracks, timecodeScale, trackList }, clusterAt: p };
}

/** Length of a buffered element's body. */
function bodyLength(el: Uint8Array): number {
  const id = readId(el, 0);
  if (!id || id === "bad") return 0;
  const size = readSize(el, id.len);
  if (!size || size === "bad") return 0;
  return el.length - id.len - size.len;
}

/**
 * MSE type matching the tracks actually in the header. Chrome rejects the
 * init segment when the declared codecs list a track the file lacks (screen
 * recordings carry no audio).
 */
export function webmMimeType(header: SessionHeader): string | undefined {
  const codecs = header.trackList.map((t) => t.codec);
  const video = codecs.includes("V_VP9") ? "vp9" : codecs.includes("V_VP8") ? "vp8" : codecs.includes("V_AV1") ? "av01.0.08M.08" : null;
  if (!video) return undefined;
  const audio = codecs.includes("A_OPUS") ? "opus" : codecs.includes("A_VORBIS") ? "vorbis" : null;
  return `video/webm; codecs="${audio ? `${video},${audio}` : video}"`;
}

/** A later session whose video or audio codec differs cannot share one file. */
export class IncompatibleSessionError extends Error {
  constructor() { super("This part of the recording uses a different format"); }
}

type Session = { map: Map<number, number>; scale: number; offsetMs: number; seenCluster: boolean };

export class WebmJoiner {
  private master: SessionHeader | null = null;
  private session: Session | null = null;
  private buf: Uint8Array = new Uint8Array(0);
  private mode: "top" | "header" | "resync" = "top";
  private skip = 0;
  private inCluster = false;
  private clusterLeft: number | null = null;
  private clusterMs = 0;
  private lastMs = -Infinity;
  private nextOffsetMs = 0;
  private out: Uint8Array[] = [];

  /** Timeline ms of the last frame written, or -Infinity. */
  get lastFrameMs(): number { return this.lastMs; }
  get header(): SessionHeader | null { return this.master; }

  /**
   * Feed one piece. `offsetMs` is where a session header found in these bytes
   * starts on the timeline. Returns the output bytes produced.
   */
  push(bytes: Uint8Array, offsetMs?: number): Uint8Array {
    if (offsetMs !== undefined) this.nextOffsetMs = offsetMs;
    const b = this.buf.length ? concat([this.buf, bytes]) : bytes;
    let p = 0;
    for (;;) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, b.length - p);
        p += n;
        this.skip -= n;
        if (this.skip > 0) break;
        continue;
      }
      if (this.mode === "resync") {
        const found = findCluster(b, p);
        if (found.at < 0) { p = found.keepFrom; break; }
        p = found.at;
        this.mode = "top";
        continue;
      }
      if (this.mode === "header") {
        const parsed = parseSessionHeader(b.subarray(p));
        if (parsed === null) break;
        if (parsed === "bad") { p += 1; this.mode = "resync"; continue; }
        this.beginSession(parsed.header, this.nextOffsetMs);
        p += parsed.clusterAt;
        this.mode = "top";
        continue;
      }
      const id = readId(b, p);
      if (!id) break;
      if (id === "bad") { p += 1; this.mode = "resync"; continue; }
      const size = readSize(b, p + id.len);
      if (!size) break;
      if (size === "bad") { p += 1; this.mode = "resync"; continue; }
      const headLen = id.len + size.len;
      if (id.value === ID.EBML) { this.inCluster = false; this.mode = "header"; continue; }
      if (id.value === ID.Segment) { p += headLen; continue; }
      if (id.value === ID.Cluster) {
        this.inCluster = true;
        this.clusterLeft = size.unknown ? null : size.value;
        p += headLen;
        if (this.session) this.emit(new Uint8Array([...encodeId(ID.Cluster), ...UNKNOWN_SIZE]));
        continue;
      }
      if (LEVEL1.has(id.value) || !this.inCluster) {
        this.inCluster = false;
        if (size.unknown) { p += headLen; this.mode = "resync"; continue; }
        p += headLen;
        this.skip = size.value;
        continue;
      }
      if (size.unknown) { p += headLen; this.mode = "resync"; continue; }
      const end = p + headLen + size.value;
      if (end > b.length) break;
      this.child(id.value, b.subarray(p + headLen, end));
      if (this.clusterLeft !== null) {
        this.clusterLeft -= end - p;
        if (this.clusterLeft <= 0) this.inCluster = false;
      }
      p = end;
    }
    this.buf = b.slice(p);
    return this.take();
  }

  /** Start over at a piece that begins with a session header (seeking). */
  reset(): void {
    this.buf = new Uint8Array(0);
    this.skip = 0;
    this.inCluster = false;
    this.mode = "top";
    this.lastMs = -Infinity;
  }

  /** A piece is missing: drop partial data and continue at the next cluster. */
  skipToCluster(offsetMs?: number): void {
    if (offsetMs !== undefined) this.nextOffsetMs = offsetMs;
    this.buf = new Uint8Array(0);
    this.skip = 0;
    this.inCluster = false;
    this.mode = "resync";
  }

  /**
   * Continue inside a session from its next cluster (seeking, or a missing
   * session head). `header` is that session's header; without one the
   * previous session's track layout is assumed.
   */
  resync(header: SessionHeader | null, offsetMs: number, opts: { resetClock?: boolean } = {}): void {
    if (opts.resetClock) this.lastMs = -Infinity;
    if (header) this.beginSession(header, offsetMs);
    else if (this.session) this.session = { ...this.session, offsetMs, seenCluster: false };
    this.skipToCluster(offsetMs);
  }

  private take(): Uint8Array {
    const out = this.out.length ? concat(this.out) : new Uint8Array(0);
    this.out = [];
    return out;
  }

  private emit(bytes: Uint8Array): void { this.out.push(bytes); }

  private beginSession(header: SessionHeader, offsetMs: number): void {
    if (!this.master) {
      this.master = header;
      this.emit(header.ebml);
      this.emit(new Uint8Array([...encodeId(ID.Segment), ...UNKNOWN_SIZE]));
      if (header.info) this.emit(header.info);
      this.emit(header.tracks);
    }
    const master = this.master;
    if (header.timecodeScale !== master.timecodeScale) throw new IncompatibleSessionError();
    const map = new Map<number, number>();
    for (const t of header.trackList) {
      const same = master.trackList.find((m) => m.type === t.type);
      if (!same) continue;
      if (same.codec !== t.codec) throw new IncompatibleSessionError();
      map.set(t.number, same.number);
    }
    this.session = { map, scale: header.timecodeScale, offsetMs, seenCluster: false };
  }

  private child(id: number, body: Uint8Array): void {
    const s = this.session;
    if (!s) return;
    if (id === ID.Timecode) {
      const ms = (readUint(body) * s.scale) / 1e6;
      if (!s.seenCluster) {
        s.seenCluster = true;
        // Never step back in time: a session that would overlap the previous
        // one (estimated placement) starts just after it.
        if (ms + s.offsetMs <= this.lastMs) s.offsetMs = this.lastMs + 1 - ms;
      }
      this.clusterMs = ms + s.offsetMs;
      const units = Math.max(0, Math.round((this.clusterMs * 1e6) / s.scale));
      const v = new Uint8Array(8);
      let n = units;
      for (let i = 7; i >= 0; i--) { v[i] = n % 256; n = Math.floor(n / 256); }
      this.emit(element(ID.Timecode, v));
      return;
    }
    if (id === ID.SimpleBlock) {
      const block = this.block(body);
      if (block) this.emit(element(ID.SimpleBlock, block));
      return;
    }
    if (id === ID.BlockGroup) {
      const parts = children(body);
      const inner = parts.find((c) => c.id === ID.Block);
      const block = inner ? this.block(inner.body) : null;
      if (!block) return;
      this.emit(element(ID.BlockGroup, concat(parts.map((c) => (c === inner ? element(ID.Block, block) : c.raw)))));
    }
  }

  /** Remap a block's track number; null drops the block. */
  private block(body: Uint8Array): Uint8Array | null {
    const s = this.session!;
    const track = readSize(body, 0);
    if (!track || track === "bad" || body.length < track.len + 3) return null;
    const mapped = s.map.get(track.value);
    if (mapped === undefined) return null;
    const rel = ((body[track.len] << 8) | body[track.len + 1]) << 16 >> 16;
    this.lastMs = Math.max(this.lastMs, this.clusterMs + (rel * s.scale) / 1e6);
    if (mapped === track.value) return body;
    const head = encodeSize(mapped);
    return concat([new Uint8Array(head), body.subarray(track.len)]);
  }
}

/** Next cluster start at or after `from` (validated by its Timecode child). */
function findCluster(b: Uint8Array, from: number): { at: number; keepFrom: number } {
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] !== 0x1f || b[i + 1] !== 0x43 || b[i + 2] !== 0xb6 || b[i + 3] !== 0x75) continue;
    const size = readSize(b, i + 4);
    if (size === null) return { at: -1, keepFrom: i };
    if (size === "bad") continue;
    const child = readId(b, i + 4 + size.len);
    if (child === null) return { at: -1, keepFrom: i };
    if (child !== "bad" && child.value === ID.Timecode) return { at: i, keepFrom: i };
  }
  return { at: -1, keepFrom: Math.max(from, b.length - 16) };
}

/** Test and tooling helpers: build WebM elements. */
export const webmElement = (id: number, body: Uint8Array) => element(id, body);
export const WEBM_IDS = ID;
