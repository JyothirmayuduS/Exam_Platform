import { afterEach, describe, expect, it, vi } from "vitest";
import { startScreenshotCapture } from "@/shared/services/examStorage";
import { startPartUploads } from "@/shared/services/recordingParts";
import { secureExamEvidence, SECURED_DETAIL, WAIT_LIMIT_MS } from "@/shared/services/submitEvidence";
import type { SnapshotStore, UploadResult } from "@/shared/services/snapshotOutbox";

vi.mock("@/shared/data/env", () => ({ supabaseConfigured: true }));
vi.mock("@/shared/services/r2Function", () => ({
  r2List: vi.fn(), r2FetchData: vi.fn(), r2PresignGet: vi.fn(), r2ListFolders: vi.fn(), r2PutBlob: vi.fn(), r2PutBlobResult: vi.fn(),
}));
vi.mock("@/shared/data/api/exams", () => ({ listExams: vi.fn().mockResolvedValue([]) }));
vi.mock("@/shared/data/api/students", () => ({ getStudentIdByRoll: vi.fn().mockResolvedValue(null) }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const start = Date.parse("2026-09-01T10:00:00Z");

function disk(): SnapshotStore & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>();
  return { data, keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    put: async (key, blob) => { data.set(key, blob); }, get: async (key) => data.get(key),
    remove: async (key) => { data.delete(key); } };
}

function video() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,YWJj");
  const element = document.createElement("video");
  Object.defineProperties(element, { videoWidth: { value: 640 }, videoHeight: { value: 480 }, readyState: { value: 2 } });
  return element;
}

const name = (key: string) => key.split("/").pop()!;

describe("per-second snapshots on a weak link (real outbox)", () => {
  it("captures every second while the link is weak, uploads none, then uploads every one after it recovers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const upload = vi.fn(async (): Promise<UploadResult> => true);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "W1", store: disk(), upload });
    handle.setLowBandwidth(true);
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(upload).not.toHaveBeenCalled();
    expect(handle.pendingCount()).toBe(31);

    handle.setLowBandwidth(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const names = () => new Set(upload.mock.calls.map((c) => name((c as unknown as [string])[0])));
    for (let s = 0; s <= 30; s++) expect(names()).toContain(`snap_${start + s * 1_000}.jpg`);

    const done = handle.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(true);
    expect(names().size).toBe(33);
  });

  it("submit still drains frames held by a weak link", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const upload = vi.fn(async (): Promise<UploadResult> => true);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "W2", store: disk(), upload });
    handle.setLowBandwidth(true);
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(9_000);
    expect(upload).not.toHaveBeenCalled();
    const done = handle.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toBe(true);
    expect(upload).toHaveBeenCalledTimes(10);
  });
});

describe("snapshot gaps", () => {
  it("flags a gap after about 5 s without a frame", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "G1", store: disk(), upload: async () => true });
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(3_000);
    vi.setSystemTime(Date.now() + 5_000); // the page froze: no frame for 6 s
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await handle.stop()).toBe(false);
  });

  it("does not flag a short stall of a few seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "G2", store: disk(), upload: async () => true });
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(3_000);
    vi.setSystemTime(Date.now() + 3_000); // 4 s between frames
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await handle.stop()).toBe(true);
  });
});

describe("a large snapshot backlog at submit", () => {
  const records = async () => ({ pdfKey: "EXAM/S/report/report.pdf", snapshotKeys: [] });

  async function tenMinutesOnAWeakLink(roll: string, upload: (key: string, blob: Blob) => Promise<UploadResult>) {
    const handle = startScreenshotCapture({ examId: "EXAM", roll, store: disk(), upload });
    handle.setLowBandwidth(true);
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(handle.pendingCount()).toBe(601);
    const camera = startPartUploads({ folder: "EXAM", owner: roll, family: "exam", store: disk(), upload: async (o) => o.name });
    camera.enqueue(new Blob(["camera"]));
    return { handle, camera };
  }

  it("keeps the kiosk open until the backlog drains, then says secured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    // The link is back but slow: each snapshot takes a second to upload (3 at a time).
    const upload = vi.fn(() => new Promise<UploadResult>((r) => setTimeout(() => r(true), 1_000)));
    const { handle, camera } = await tenMinutesOnAWeakLink("B1", upload);

    let landed = false;
    const left: number[] = [];
    const onWaitLimit = vi.fn();
    const outcome = secureExamEvidence({
      camera, screen: null, uploadRecords: records, violationSnapshotCount: 0,
      snapshots: handle.stop(), snapshotQueue: handle,
      onPiecesLeft: (n) => left.push(n), onPiecesLanded: () => { landed = true; }, onWaitLimit,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(landed).toBe(false);
    expect(left.at(-1)!).toBeGreaterThan(400);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(landed).toBe(true);
    expect(left.at(-1)).toBe(0);
    expect(onWaitLimit).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(601);
    expect(await outcome).toEqual({ state: "stored", detail: SECURED_DETAIL, piecesLanded: true });
    camera.stop();
  });

  it("on a dead link stays open and offers the close-anyway warning after 10 minutes, counting the snapshots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const { handle, camera } = await tenMinutesOnAWeakLink("B2", async () => false);
    let landed = false;
    const onWaitLimit = vi.fn();
    void secureExamEvidence({
      camera, screen: null, uploadRecords: records, violationSnapshotCount: 0,
      snapshots: handle.stop(), snapshotQueue: handle,
      onPiecesLanded: () => { landed = true; }, onWaitLimit,
    });
    await vi.advanceTimersByTimeAsync(WAIT_LIMIT_MS - 1_000);
    expect(landed).toBe(false);
    expect(onWaitLimit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onWaitLimit).toHaveBeenCalledWith(601);
    expect(landed).toBe(false);
    camera.stop();
  });

  it("does not wait on snapshots storage refuses for good, and reports them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const upload = async (key: string): Promise<UploadResult> =>
      name(key) === `snap_${start}.jpg` ? { refused: 400, reason: "bad request" } : true;
    const handle = startScreenshotCapture({ examId: "EXAM", roll: "B3", store: disk(), upload });
    handle.setVideo(video());
    await vi.advanceTimersByTimeAsync(5_000);
    const camera = startPartUploads({ folder: "EXAM", owner: "B3", family: "exam", store: disk(), upload: async (o) => o.name });
    camera.enqueue(new Blob(["camera"]));
    let landed = false;
    const outcome = secureExamEvidence({
      camera, screen: null, uploadRecords: records, violationSnapshotCount: 0,
      snapshots: handle.stop(), snapshotQueue: handle, onPiecesLanded: () => { landed = true; },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(landed).toBe(true);
    const result = await outcome;
    expect(result.state).toBe("partial");
    expect(result.detail).toContain("1 camera snapshot was refused by storage and not uploaded (kept on this PC)");
    camera.stop();
  });
});
