import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startScreenshotCapture, listStudentArtifacts, getArtifactBlob } from "./examStorage";
import { getSupabase } from "./supabase";
import { getStudentIdByRoll } from "./api/students";
import { r2List, r2FetchData, r2PresignGet } from "./r2Function";

const outbox = vi.hoisted(() => ({ enqueue: vi.fn(), retry: vi.fn(), flush: vi.fn().mockResolvedValue(true) }));
vi.mock("./snapshotOutbox", () => ({ createSnapshotOutbox: vi.fn(() => outbox) }));
vi.mock("./supabase", () => ({ getSupabase: vi.fn() }));
vi.mock("./env", () => ({ supabaseConfigured: true }));
vi.mock("./r2Function", () => ({ r2List: vi.fn(), r2FetchData: vi.fn(), r2PresignGet: vi.fn(), r2ListFolders: vi.fn(), r2PutBlob: vi.fn() }));
vi.mock("./api/exams", () => ({ listExams: vi.fn().mockResolvedValue([{ id: "EXAM", name: "Exam" }]) }));
vi.mock("./api/students", () => ({ getStudentIdByRoll: vi.fn().mockResolvedValue(null) }));

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
  it("merges R2 with recursively paginated backup frames beyond 1000", async () => {
    const file = (name: string) => ({ id: name, name, metadata: { size: 100 }, created_at: null });
    const list = vi.fn(async (path: string, options: { offset: number }) => {
      if (path.endsWith("screenshots")) return { error: null, data: options.offset === 0
        ? Array.from({ length: 1000 }, (_, i) => file(`snap_${i}.jpg`)) : [file("snap_1000.jpg")] };
      return { error: null, data: path.startsWith("Exam/") ? [{ id: null, name: "screenshots" }] : [] };
    });
    vi.mocked(getSupabase).mockReturnValue({ storage: { from: () => ({ list }) } } as unknown as ReturnType<typeof getSupabase>);
    vi.mocked(r2List).mockResolvedValue([{ key: "Exam/R1/screenshots/r2.jpg", name: "r2.jpg", size: 100, lastModified: null }]);
    const result = await listStudentArtifacts("EXAM", "R1");
    expect(result).toHaveLength(1002);
    expect(result?.some((f) => f.key === "Exam/R1/screenshots/snap_1000.jpg")).toBe(true);
    expect(list).toHaveBeenCalledWith("Exam/R1/screenshots", expect.objectContaining({ offset: 1000 }));
  });
  it("also finds legacy UUID-owned frames when a report supplies a roll", async () => {
    vi.mocked(getStudentIdByRoll).mockResolvedValueOnce("student-uuid");
    vi.mocked(r2List).mockImplementation(async (prefix) => prefix === "Exam/student-uuid" ? [{ key: `${prefix}/screenshots/legacy.jpg`, name: "legacy.jpg", size: 10, lastModified: null }] : []);
    vi.mocked(getSupabase).mockReturnValue(null);
    const result = await listStudentArtifacts("EXAM", "R1");
    expect(result?.map((r) => r.key)).toEqual(["Exam/student-uuid/screenshots/legacy.jpg"]);
  });

  it("reads backup bytes when a valid R2 presign points to a nonexistent object", async () => {
    const blob = new Blob(["backup frame"]);
    vi.mocked(r2FetchData).mockResolvedValue(null);
    vi.mocked(r2PresignGet).mockResolvedValue("https://example.invalid/missing");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const download = vi.fn().mockResolvedValue({ data: blob, error: null });
    vi.mocked(getSupabase).mockReturnValue({ storage: { from: () => ({ download }) } } as unknown as ReturnType<typeof getSupabase>);
    expect(await getArtifactBlob("Exam/R1/screenshots/backup.jpg")).toBe(blob);
    expect(download).toHaveBeenCalledWith("Exam/R1/screenshots/backup.jpg");
  });
});
