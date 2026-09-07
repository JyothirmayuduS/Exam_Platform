import { describe, it, expect, vi } from "vitest";
import { getItemAnalysis, refreshItemAnalysis } from "./itemAnalysis";

vi.mock("../supabase", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: [{ question_id: "q1", exam_id: "e1", difficulty: "medium", attempt_count: 10, avg_score: 7.5, stddev_score: 1.2, above_avg: 6, below_avg: 4 }], error: null })
      })
    }),
    rpc: () => Promise.resolve({ error: null })
  })
}));

describe("itemAnalysis", () => {
  it("getItemAnalysis returns stats array", async () => {
    const stats = await getItemAnalysis("e1");
    expect(Array.isArray(stats)).toBe(true);
    expect(stats[0]?.question_id).toBe("q1");
    expect(stats[0]?.attempt_count).toBe(10);
  });

  it("refreshItemAnalysis returns true on success", async () => {
    const ok = await refreshItemAnalysis();
    expect(ok).toBe(true);
  });

  it("getItemAnalysis returns empty when no supabase", async () => {
    // vi.doMock only affects modules imported AFTER it runs, so reset the
    // module registry and re-import the module under the null-DB mock.
    vi.resetModules();
    vi.doMock("../supabase", () => ({ getSupabase: () => null }));
    const { getItemAnalysis: getItemAnalysisNoDb } = await import("./itemAnalysis");
    const stats = await getItemAnalysisNoDb("e1");
    expect(stats).toEqual([]);
  });
});
