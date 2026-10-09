import { describe, expect, it } from "vitest";
import { violationExamSeconds } from "@/features/proctoring/domain/violationTime";
import { partName, pieceTimeline } from "@/shared/services/recordingParts";

describe("violation markers", () => {
  it("sit at the exam time recorded with the violation, whatever the insert time says", () => {
    // Server inserted the row 4 minutes "later" than the student PC's clock.
    const v = { offset_seconds: 3725, created_at: "2026-09-01T11:06:05Z" };
    expect(violationExamSeconds(v, "2026-09-01T10:00:00Z")).toBe(3725);
  });

  it("line up with a recording that continues after a reload", () => {
    const start = 1_700_000_000_000;
    const reload = start + 1_800_000;
    const pieces = [
      { key: `E/R/recordings/parts/${partName("exam", start + 10_000, start)}` },
      { key: `E/R/recordings/parts/${partName("exam", reload + 10_000, reload)}` },
    ];
    const t = pieceTimeline(pieces);
    const marker = violationExamSeconds({ offset_seconds: 1_805, created_at: null });
    const piece = t.pieces.find((p) => marker! >= p.start && marker! < p.end);
    expect(piece?.key).toBe(pieces[1].key);
  });

  it("falls back to server time minus the attempt's server start for rows without an offset", () => {
    expect(violationExamSeconds({ offset_seconds: null, created_at: "2026-09-01T10:30:00Z" }, "2026-09-01T10:00:00Z")).toBe(1800);
  });

  it("is not placed when no exam time is known, rather than guessed from another clock", () => {
    expect(violationExamSeconds({ offset_seconds: null, created_at: "2026-09-01T10:30:00Z" })).toBeNull();
  });
});
