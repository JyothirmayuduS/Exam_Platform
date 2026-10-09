import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startScreenshotCapture } from "@/shared/services/examStorage";
import { r2PutBlob } from "@/shared/services/r2Function";

vi.mock("@/shared/data/env", () => ({ supabaseConfigured: true }));
vi.mock("@/shared/services/r2Function", () => ({
  r2List: vi.fn(), r2FetchData: vi.fn(), r2PresignGet: vi.fn(), r2ListFolders: vi.fn(), r2PutBlob: vi.fn(),
}));
vi.mock("@/shared/data/api/exams", () => ({ listExams: vi.fn().mockResolvedValue([]) }));
vi.mock("@/shared/data/api/students", () => ({ getStudentIdByRoll: vi.fn().mockResolvedValue(null) }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function video() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,YWJj");
  const element = document.createElement("video");
  Object.defineProperties(element, { videoWidth: { value: 640 }, videoHeight: { value: 480 }, readyState: { value: 2 } });
  return element;
}

describe("per-second snapshots on a weak link (real outbox)", () => {
  it("captures every second while the link is weak, uploads none, then uploads every one after it recovers", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-09-01T10:00:00Z");
    vi.setSystemTime(start);
    vi.mocked(r2PutBlob).mockImplementation(async (o) => `${o.examId}/${o.ownerSegment}/${o.kind}/${o.name}`);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "R1" });
    handle.setLowBandwidth(true);
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r2PutBlob).not.toHaveBeenCalled();

    handle.setLowBandwidth(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const names = () => new Set(vi.mocked(r2PutBlob).mock.calls.map(([o]) => o.name));
    for (let s = 0; s <= 30; s++) expect(names()).toContain(`snap_${start + s * 1_000}.jpg`);

    const done = handle.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(true);
    expect(names().size).toBe(33);
  });

  it("submit still drains frames held by a weak link", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-09-01T10:00:00Z");
    vi.setSystemTime(start);
    vi.mocked(r2PutBlob).mockImplementation(async (o) => `${o.examId}/${o.ownerSegment}/${o.kind}/${o.name}`);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "R1" });
    handle.setLowBandwidth(true);
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(9_000);
    expect(r2PutBlob).not.toHaveBeenCalled();
    const done = handle.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(true);
    expect(r2PutBlob).toHaveBeenCalledTimes(10);
  });
});
