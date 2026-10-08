import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startScreenshotCapture, listStudentArtifacts, getArtifactBlob } from "@/shared/services/examStorage";
import { getStudentIdByRoll } from "@/shared/data/api/students";
import { r2List, r2FetchData, r2PresignGet, r2PutBlob } from "@/shared/services/r2Function";

const outbox = vi.hoisted(() => ({ enqueue: vi.fn(), retry: vi.fn(), flush: vi.fn().mockResolvedValue(true) }));
vi.mock("@/shared/services/snapshotOutbox", () => ({ createSnapshotOutbox: vi.fn(() => outbox) }));
vi.mock("@/shared/data/env", () => ({ supabaseConfigured: true }));
vi.mock("@/shared/services/r2Function", () => ({
  r2List: vi.fn(),
  r2FetchData: vi.fn(),
  r2PresignGet: vi.fn(),
  r2ListFolders: vi.fn(),
  r2PutBlob: vi.fn(),
}));
vi.mock("@/shared/data/api/exams", () => ({ listExams: vi.fn().mockResolvedValue([{ id: "EXAM", name: "Exam" }]) }));
vi.mock("@/shared/data/api/students", () => ({ getStudentIdByRoll: vi.fn().mockResolvedValue(null) }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("webcam snapshots", () => {
  const canvasWidths: number[] = [];
  function video(width = 640, height = 480) {
    canvasWidths.length = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      canvasWidths.push(this.width);
      return { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement["getContext"]);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,YWJj");
    const element = document.createElement("video");
    Object.defineProperties(element, { videoWidth: { value: width }, videoHeight: { value: height }, readyState: { value: 2 } });
    return element;
  }
  const start = Date.parse("2026-09-01T10:00:00Z");

  it("does not take a snapshot every second: one at start, then one every 20 s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "R1" });
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(19_000);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(41_000);
    expect(outbox.enqueue.mock.calls.map((c) => c[0])).toEqual(
      [0, 20_000, 40_000, 60_000].map((ms) => `EXAM/R1/screenshots/snap_${start + ms}.jpg`),
    );
    expect(await handle.stop()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outbox.enqueue).toHaveBeenCalledTimes(4);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
  });

  it("slows to one every 30 s on a weak connection and back to 20 s when it recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "R1" });
    handle.setVideo(video());
    handle.setLowBandwidth(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(outbox.enqueue).toHaveBeenCalledTimes(4); // 0, 30, 60, 90 s
    handle.setLowBandwidth(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(outbox.enqueue).toHaveBeenCalledTimes(6); // +20, +40 s
    expect(await handle.stop()).toBe(true);
  });

  it("compresses periodic snapshots to small thumbnails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "R1" });
    handle.setVideo(video(1920, 1080));
    expect(canvasWidths).toEqual([480]);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenLastCalledWith("image/jpeg", 0.5);
    await handle.stop();
  });

  it("still captures a frame the moment a violation is flagged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    vi.mocked(r2PutBlob).mockResolvedValue("EXAM/R1/violations/x.jpg");
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "R1" });
    handle.setVideo(video(1920, 1080));
    await vi.advanceTimersByTimeAsync(5_000);
    const flaggedAt = start + 5_000;
    const blob = await handle.captureViolationSnapshot("phone_detected", flaggedAt);
    expect(blob).toBeInstanceOf(Blob);
    expect(r2PutBlob).toHaveBeenCalledWith(expect.objectContaining({
      examId: "EXAM", ownerSegment: "R1", kind: "violations", name: `${flaggedAt}_phone_detected.jpg`,
    }));
    // Compressed, but sharper than the periodic thumbnails.
    expect(canvasWidths.at(-1)).toBe(960);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenLastCalledWith("image/jpeg", 0.7);
    // The violation frame is extra: the periodic schedule is unchanged.
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    await handle.stop();
  });
});

describe("complete evidence listing", () => {
  it("lists R2 artifacts only (no Supabase Storage)", async () => {
    vi.mocked(r2List).mockResolvedValue([
      { key: "Exam/R1/screenshots/r2.jpg", name: "r2.jpg", size: 100, lastModified: null },
      { key: "Exam/R1/screenshots/snap_1000.jpg", name: "snap_1000.jpg", size: 100, lastModified: null },
    ]);
    const result = await listStudentArtifacts("EXAM", "R1");
    expect(result).toHaveLength(2);
    expect(result?.some((f) => f.key === "Exam/R1/screenshots/snap_1000.jpg")).toBe(true);
  });

  it("also finds legacy UUID-owned frames when a report supplies a roll", async () => {
    vi.mocked(getStudentIdByRoll).mockResolvedValueOnce("student-uuid");
    vi.mocked(r2List).mockImplementation(async (prefix) =>
      prefix === "Exam/student-uuid"
        ? [{ key: `${prefix}/screenshots/legacy.jpg`, name: "legacy.jpg", size: 10, lastModified: null }]
        : [],
    );
    const result = await listStudentArtifacts("EXAM", "R1");
    expect(result?.map((r) => r.key)).toEqual(["Exam/student-uuid/screenshots/legacy.jpg"]);
  });

  it("returns null when R2 cannot serve the object", async () => {
    vi.mocked(r2FetchData).mockResolvedValue(null);
    vi.mocked(r2PresignGet).mockResolvedValue("https://example.invalid/missing");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await getArtifactBlob("Exam/R1/screenshots/backup.jpg")).toBeNull();
  });

  it("reads bytes via R2 fetch-data relay", async () => {
    const bytes = new TextEncoder().encode("frame");
    vi.mocked(r2FetchData).mockResolvedValue({ bytes, contentType: "image/jpeg" });
    const blob = await getArtifactBlob("Exam/R1/screenshots/ok.jpg");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe("image/jpeg");
  });
});
