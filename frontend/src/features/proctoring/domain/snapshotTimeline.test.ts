import { describe, expect, it } from "vitest";
import { pageAt, sampleFrames, snapshotTime, timelinePage, TIMELINE_PAGE, wholeExamStep } from "@/features/proctoring/domain/snapshotTimeline";

const t0 = 1_791_000_000_000;
/** One frame a second for a 2-hour exam. */
const exam = Array.from({ length: 7_201 }, (_, s) => ({ key: `E/R/screenshots/snap_${t0 + s * 1000}.jpg`, timestamp: t0 + s * 1000 }));

describe("snapshot timeline", () => {
  it("reads the frame time from the stored name", () => {
    expect(snapshotTime("snap_1791000000000.jpg")).toBe(t0);
    expect(snapshotTime("backup.jpg")).toBeNull();
  });

  it("fits the whole 2-hour exam on one page by default, reaching the last minute", () => {
    const page = timelinePage(exam, 0, 0);
    expect(page.stepSec).toBe(wholeExamStep(exam));
    expect(page.stepSec).toBe(61);
    expect(page.frames.length).toBeLessThanOrEqual(TIMELINE_PAGE);
    expect(page.pages).toBe(1);
    expect(page.frames[0].timestamp).toBe(t0);
    expect(page.frames.at(-1)!.timestamp).toBeGreaterThanOrEqual(t0 + 7_140_000);
  });

  it("pages through every frame, 120 at a time, up to the end of the exam", () => {
    const first = timelinePage(exam, 1, 0);
    expect(first.pages).toBe(61);
    expect(first.frames).toHaveLength(120);
    const last = timelinePage(exam, 1, 60);
    expect(last.frames.at(-1)!.timestamp).toBe(t0 + 7_200_000);
    expect(timelinePage(exam, 1, 999).page).toBe(60);
  });

  it("finds the page with the frame at a given time", () => {
    const at = t0 + 3_725_000; // 1:02:05
    const page = pageAt(exam, 1, at);
    expect(timelinePage(exam, 1, page).frames.some((f) => f.timestamp === at)).toBe(true);
  });

  it("keeps gaps visible when sampling", () => {
    const gappy = [0, 1, 2, 40, 41].map((s) => ({ key: String(s), timestamp: t0 + s * 1000 }));
    expect(sampleFrames(gappy, 10).map((f) => f.key)).toEqual(["0", "40"]);
  });
});
