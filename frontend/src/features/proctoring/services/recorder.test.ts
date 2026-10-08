import { afterEach, describe, expect, it, vi } from "vitest";
import { startVideoRecording, RECORDING_CHUNK_MS } from "@/features/proctoring/services/recorder";
import { startPartUploads } from "@/shared/services/recordingParts";
import type { SnapshotStore } from "@/shared/services/snapshotOutbox";

function disk(): SnapshotStore {
  const data = new Map<string, Blob>();
  return { keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    put: async (key, blob) => { data.set(key, blob); }, get: async (key) => data.get(key),
    remove: async (key) => { data.delete(key); } };
}

class FakeRecorder {
  static last: FakeRecorder;
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  timeslice: number | undefined;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() { FakeRecorder.last = this; }
  start(timeslice?: number) { this.timeslice = timeslice; this.state = "recording"; }
  emit(bytes: number) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
  stop() { this.emit(10); this.state = "inactive"; this.onstop?.(); }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("screen recording", () => {
  it("records in 10 s pieces and never builds or uploads a whole-exam blob", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const uploads: { name: string; size: number }[] = [];
    const uploader = startPartUploads({
      folder: "Exam", owner: "R1", family: "screen", store: disk(),
      upload: async (o) => { uploads.push({ name: o.name, size: o.blob.size }); return o.name; },
    });
    const enqueue = vi.spyOn(uploader, "enqueue");
    const handle = startVideoRecording({ stream: {} as MediaStream, examId: "E", roll: "R1", kind: "screen", uploader });

    expect(RECORDING_CHUNK_MS).toBe(10_000);
    expect(FakeRecorder.last.timeslice).toBe(10_000);
    for (const size of [100, 200, 300]) FakeRecorder.last.emit(size);
    handle.stop();
    expect(await handle.flush()).toBe(true);

    // Every chunk handed off as its own piece; nothing concatenated.
    expect(enqueue.mock.calls.map(([b]) => b.size)).toEqual([100, 200, 300, 10]);
    expect(uploads).toHaveLength(4);
    expect(uploads.every((u) => /^parts\/screen_\d+\.webm$/.test(u.name))).toBe(true);
    expect(Math.max(...uploads.map((u) => u.size))).toBe(300);
    uploader.stop();
  });

  it("holds pieces on the device on a weak link", async () => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const upload = vi.fn(async (o: { name: string }) => o.name);
    const uploader = startPartUploads({ folder: "Exam", owner: "R1", family: "screen", store: disk(), upload });
    const handle = startVideoRecording({ stream: {} as MediaStream, examId: "E", roll: "R1", kind: "screen", uploader });
    handle.setLowBandwidth(true);
    FakeRecorder.last.emit(100);
    await new Promise((r) => setTimeout(r, 20));
    expect(upload).not.toHaveBeenCalled();
    handle.setLowBandwidth(false);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    uploader.stop();
  });
});
