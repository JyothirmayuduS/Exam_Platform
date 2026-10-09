import { describe, expect, it, vi } from "vitest";
import { createPieceFetcher, describeMissing, joinPieces, LINK_TTL_SEC, signKeys } from "@/shared/services/pieceFetch";
import { getArtifactObjectUrl, signArtifactBatch } from "@/shared/services/examStorage";
import { pieceTimeline, partName } from "@/shared/services/recordingParts";

vi.mock("@/shared/services/examStorage", () => ({
  signArtifactBatch: vi.fn(),
  getArtifactUrls: vi.fn(async () => new Map()),
  getArtifactObjectUrl: vi.fn(async () => null),
}));

const ok = (bytes: Uint8Array) => ({ ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer }) as unknown as Response;
const status = (code: number) => ({ ok: false, status: code, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response;

/** Storage that refuses links past their expiry, like presigned R2 URLs. */
function presigned(now: () => number) {
  const sign = vi.fn(async (keys: string[], ttl: number) =>
    new Map(keys.map((k) => [k, `https://r2.example/${k}?exp=${now() + ttl * 1000}`])));
  const fetchImpl = vi.fn(async (url: string) => {
    const exp = Number(new URL(url).searchParams.get("exp"));
    return now() > exp ? status(403) : ok(new TextEncoder().encode(new URL(url).pathname));
  });
  return { sign, fetchImpl };
}

describe("piece links during a long review", () => {
  it("re-signs before links expire so a 2.5-hour recording plays to the end", async () => {
    let t = 1_700_000_000_000;
    const now = () => t;
    const keys = Array.from({ length: 900 }, (_, i) => `E/R/recordings/parts/exam_${i}.webm`);
    const { sign, fetchImpl } = presigned(now);
    const fetcher = createPieceFetcher({ keys, sign, fetchImpl, now, backoffMs: 0 });
    for (const key of keys) {
      const bytes = await fetcher.bytes(key);
      expect(new TextDecoder().decode(bytes)).toBe(`/${key}`);
      t += 10_000;
    }
    expect(fetchImpl.mock.results.length).toBe(keys.length);
    expect(fetcher.signCalls()).toBeGreaterThanOrEqual(Math.ceil((900 * 10) / LINK_TTL_SEC));
    expect(sign.mock.calls.every(([batch]) => batch.length <= 40)).toBe(true);
  });

  it("re-signs a link that was signed long ago when the reviewer seeks back", async () => {
    let t = 1_700_000_000_000;
    const now = () => t;
    const { sign, fetchImpl } = presigned(now);
    const fetcher = createPieceFetcher({ keys: ["a", "b"], sign, fetchImpl, now, backoffMs: 0 });
    const first = await fetcher.url("a");
    t += 2 * 3600_000;
    const again = await fetcher.url("a");
    expect(again).not.toBe(first);
    await expect(fetcher.bytes("a")).resolves.toBeInstanceOf(Uint8Array);
  });

  it("signs again when storage refuses a link that should still be valid", async () => {
    const sign = vi.fn(async (keys: string[]) => new Map(keys.map((k) => [k, `https://r2.example/${k}?n=${sign.mock.calls.length}`])));
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("n=1") ? status(403) : ok(new Uint8Array([1]))));
    const fetcher = createPieceFetcher({ keys: ["a"], sign, fetchImpl, backoffMs: 0 });
    expect(Array.from(await fetcher.bytes("a"))).toEqual([1]);
    expect(sign).toHaveBeenCalledTimes(2);
  });
});

describe("failed pieces", () => {
  const start = 1_700_000_000_000;
  const art = (i: number) => ({ key: `E/R/recordings/parts/${partName("exam", start + (i + 1) * 10_000, start)}` });

  it("reports a piece that cannot be fetched with its place in the exam, and keeps the rest", async () => {
    const timeline = pieceTimeline([art(0), art(1), art(2)]);
    const missingKey = timeline.pieces[1].key;
    const fetcher = createPieceFetcher({
      keys: timeline.pieces.map((p) => p.key),
      sign: async (keys) => new Map(keys.map((k) => [k, `https://r2.example/${k}`])),
      fetchImpl: async (url) => (url.endsWith(missingKey) ? status(404) : ok(new Uint8Array([7, 7]))),
      backoffMs: 0,
    });
    const written: number[] = [];
    const result = await joinPieces({ timeline, fetcher, write: async (c) => { written.push(...c); } });
    expect(written).toEqual([7, 7, 7, 7]);
    expect(result.missing).toEqual([{ key: missingKey, start: 10, end: 20, reason: "is missing from storage (HTTP 404)" }]);
    expect(describeMissing(result.missing)).toEqual([
      `00:10–00:20: piece ${missingKey.split("/").pop()} is missing from storage (HTTP 404)`,
    ]);
  });

  it("reports a piece whose link cannot be signed", async () => {
    const timeline = pieceTimeline([art(0), art(1)]);
    const fetcher = createPieceFetcher({
      keys: timeline.pieces.map((p) => p.key),
      sign: async (keys) => new Map(keys.filter((k) => k !== timeline.pieces[0].key).map((k) => [k, `https://r2.example/${k}`])),
      fetchImpl: async () => ok(new Uint8Array([1])),
      backoffMs: 0,
    });
    const result = await joinPieces({ timeline, fetcher, write: async () => {} });
    expect(result.missing.map((m) => [m.key, m.reason])).toEqual([[timeline.pieces[0].key, "could not be signed"]]);
  });
});

describe("signing batches", () => {
  it("retries a failed batch as a batch with backoff, never one call per key", async () => {
    vi.useFakeTimers();
    try {
      const keys = Array.from({ length: 40 }, (_, i) => `E/R/recordings/parts/exam_${i}.webm`);
      let calls = 0;
      vi.mocked(signArtifactBatch).mockImplementation(async (batch: string[]) => {
        calls += 1;
        if (calls < 3) throw new Error("store-artifact 503");
        return new Map(batch.map((k) => [k, `https://r2.example/${k}`]));
      });
      const signed = signKeys(keys, 3600, { backoffMs: 1000 });
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1 + 2000);
      const result = await signed;
      expect(result.size).toBe(40);
      expect(vi.mocked(signArtifactBatch).mock.calls.every(([batch]) => batch.length === 40)).toBe(true);
      expect(getArtifactObjectUrl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports pieces as unsigned when every attempt of the batch fails, still without per-key calls", async () => {
    vi.mocked(signArtifactBatch).mockReset().mockRejectedValue(new Error("store-artifact down"));
    const timeline = pieceTimeline([0, 1, 2].map((i) => ({ key: `E/R/recordings/parts/${partName("exam", 1_700_000_010_000 + i * 10_000, 1_700_000_000_000)}` })));
    const fetcher = createPieceFetcher({
      keys: timeline.pieces.map((p) => p.key),
      sign: (k, ttl) => signKeys(k, ttl, { backoffMs: 0 }),
      fetchImpl: async () => ok(new Uint8Array([1])),
      backoffMs: 0,
    });
    const result = await joinPieces({ timeline, fetcher, write: async () => {} });
    expect(result.missing.map((m) => m.reason)).toEqual(["could not be signed", "could not be signed", "could not be signed"]);
    expect(getArtifactObjectUrl).not.toHaveBeenCalled();
    expect(vi.mocked(signArtifactBatch).mock.calls.every(([batch]) => batch.length >= 1)).toBe(true);
  });
});
