import { describe, expect, it, vi } from "vitest";
import { parseSessionHeader, webmElement as el, WEBM_IDS as ID, WebmJoiner, webmMimeType } from "@/shared/services/webmJoin";
import { createPieceFetcher, joinPieces } from "@/shared/services/pieceFetch";
import { partName, pieceTimeline } from "@/shared/services/recordingParts";

vi.mock("@/shared/services/examStorage", () => ({ getArtifactUrls: vi.fn(), getArtifactObjectUrl: vi.fn() }));

const VIDEO = 1;
const AUDIO = 2;
const cat = (...parts: (Uint8Array | number[])[]) => {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrs) { out.set(a, at); at += a.length; }
  return out;
};
const uint = (v: number, bytes = 1) => {
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  return out;
};
const text = (s: string) => new TextEncoder().encode(s);
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/** A recorder session header with the given track numbers (MediaRecorder style). */
function header(video: number, audio: number): Uint8Array {
  const track = (num: number, type: number, codec: string) =>
    el(ID.TrackEntry, cat(el(ID.TrackNumber, uint(num)), el(ID.TrackType, uint(type)), el(ID.CodecID, text(codec))));
  return cat(
    el(ID.EBML, el(0x4282, text("webm"))),
    [0x18, 0x53, 0x80, 0x67], UNKNOWN,
    el(ID.Info, el(ID.TimecodeScale, uint(1_000_000, 3))),
    el(ID.Tracks, cat(track(video, 1, "V_VP9"), track(audio, 2, "A_OPUS"))),
  );
}

const block = (track: number, rel: number, payload: number) => el(ID.SimpleBlock, cat([0x80 | track], uint(rel, 2), [0x80, payload]));

/** One 10 s piece: a cluster at `ms` with a video and an audio frame. */
function cluster(ms: number, video: number, audio: number, payload: number, unknownSize: boolean): Uint8Array {
  const body = cat(el(ID.Timecode, uint(ms, 4)), block(video, 0, payload), block(audio, 5, payload + 100));
  return unknownSize ? cat([0x1f, 0x43, 0xb6, 0x75], UNKNOWN, body) : el(ID.Cluster, body);
}

type Parsed = { headers: number; clusters: number[]; blocks: { track: number; ms: number; payload: number }[] };

/** Walk the joined file the way a player does. */
function read(b: Uint8Array): Parsed {
  const out: Parsed = { headers: 0, clusters: [], blocks: [] };
  const parsed = parseSessionHeader(b);
  if (!parsed || parsed === "bad") throw new Error("no header");
  for (let i = 0; i + 4 <= b.length; i++) if (b[i] === 0x1a && b[i + 1] === 0x45 && b[i + 2] === 0xdf && b[i + 3] === 0xa3) out.headers++;
  let p = parsed.clusterAt;
  let clusterMs = 0;
  while (p < b.length) {
    const idLen = b[p] & 0x80 ? 1 : b[p] & 0x40 ? 2 : b[p] & 0x20 ? 3 : 4;
    const id = Array.from(b.subarray(p, p + idLen)).reduce((v, x) => v * 256 + x, 0);
    let sizeLen = 1;
    while (!(b[p + idLen] & (0x80 >> (sizeLen - 1)))) sizeLen++;
    let size = b[p + idLen] & (0xff >> sizeLen);
    for (let i = 1; i < sizeLen; i++) size = size * 256 + b[p + idLen + i];
    const body = b.subarray(p + idLen + sizeLen);
    if (id === ID.Cluster) { p += idLen + sizeLen; continue; }
    if (id === ID.Timecode) {
      clusterMs = Array.from(body.subarray(0, size)).reduce((v, x) => v * 256 + x, 0);
      out.clusters.push(clusterMs);
    } else if (id === ID.SimpleBlock) {
      const rel = (body[1] << 8) | body[2];
      out.blocks.push({ track: body[0] & 0x7f, ms: clusterMs + rel, payload: body[4] });
    } else {
      throw new Error(`unexpected element ${id.toString(16)}`);
    }
    p += idLen + sizeLen + size;
  }
  return out;
}

describe("joining recorder sessions", () => {
  // Session A: the first recorder. Session B: the recorder started again after
  // a page reload 60 s later, with its track numbers the other way round.
  const a = 1_700_000_000_000;
  const b = a + 60_000;
  const pieces = new Map<string, Uint8Array>([
    [partName("exam", a + 10_000, a), cat(header(VIDEO, AUDIO), cluster(0, VIDEO, AUDIO, 1, false))],
    [partName("exam", a + 20_000, a), cluster(10_000, VIDEO, AUDIO, 2, false)],
    [partName("exam", b + 10_000, b), cat(header(AUDIO, VIDEO), cluster(0, AUDIO, VIDEO, 3, true))],
    [partName("exam", b + 20_000, b), cluster(10_000, AUDIO, VIDEO, 4, true)],
  ]);
  const arts = [...pieces.keys()].map((name) => ({ key: `E/R/recordings/parts/${name}` }));

  it("produces one playable file that continues past the reload at the real exam time", async () => {
    const timeline = pieceTimeline(arts);
    const fetcher = createPieceFetcher({
      keys: arts.map((x) => x.key),
      sign: async (keys) => new Map(keys.map((k) => [k, k])),
      fetchImpl: async (url) => ({ ok: true, status: 200, arrayBuffer: async () => pieces.get(url.split("/").pop()!)!.slice().buffer }) as unknown as Response,
    });
    const chunks: Uint8Array[] = [];
    const result = await joinPieces({ timeline, fetcher, write: async (c) => { chunks.push(c); } });
    expect(result.missing).toEqual([]);
    expect(result.files).toBe(1);

    const out = cat(...chunks);
    const parsed = parseSessionHeader(out);
    expect(parsed && parsed !== "bad" && webmMimeType(parsed.header)).toBe('video/webm; codecs="vp9,opus"');
    const file = read(out);
    expect(file.headers).toBe(1);
    expect(file.clusters).toEqual([0, 10_000, 60_000, 70_000]);
    // Session B's frames are mapped onto session A's track numbers.
    expect(file.blocks).toEqual([
      { track: VIDEO, ms: 0, payload: 1 }, { track: AUDIO, ms: 5, payload: 101 },
      { track: VIDEO, ms: 10_000, payload: 2 }, { track: AUDIO, ms: 10_005, payload: 102 },
      { track: VIDEO, ms: 60_000, payload: 3 }, { track: AUDIO, ms: 60_005, payload: 103 },
      { track: VIDEO, ms: 70_000, payload: 4 }, { track: AUDIO, ms: 70_005, payload: 104 },
    ]);
  });

  it("gives the same output when pieces arrive split mid-element", () => {
    const timeline = pieceTimeline(arts);
    const whole = new WebmJoiner();
    const split = new WebmJoiner();
    const a1: Uint8Array[] = [];
    const a2: Uint8Array[] = [];
    for (const p of timeline.pieces) {
      const bytes = pieces.get(p.key.split("/").pop()!)!;
      a1.push(whole.push(bytes, p.offsetMs));
      for (let i = 0; i < bytes.length; i += 7) a2.push(split.push(bytes.subarray(i, i + 7), p.offsetMs));
    }
    expect(Array.from(cat(...a2))).toEqual(Array.from(cat(...a1)));
  });
});
