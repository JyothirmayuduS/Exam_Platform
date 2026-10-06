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

describe("per-second camera capture", () => {
  function video() {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,YWJj");
    const element = document.createElement("video");
    Object.defineProperties(element, { videoWidth: { value: 640 }, videoHeight: { value: 480 }, readyState: { value: 2 } });
    return element;
  }
  it("captures every second without AI warnings, timestamps at capture, and flushes on stop", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-09-01T10:00:00Z");
    vi.setSystemTime(start);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "R1" });
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(5000);
    expect(outbox.enqueue).toHaveBeenCalledTimes(6);
    expect(outbox.enqueue.mock.calls.map((c) => c[0])).toEqual(Array.from({ length: 6 }, (_, i) => `EXAM/R1/screenshots/snap_${start + i * 1000}.jpg`));
    expect(await handle.stop()).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(outbox.enqueue).toHaveBeenCalledTimes(6);
    expect(outbox.flush).toHaveBeenCalledTimes(1);
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
