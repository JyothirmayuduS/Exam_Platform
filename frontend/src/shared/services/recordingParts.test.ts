import { afterEach, describe, expect, it, vi } from "vitest";
import { startPartUploads } from "@/shared/services/recordingParts";
import type { SnapshotStore } from "@/shared/services/snapshotOutbox";

function disk(): SnapshotStore & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>();
  return { data, keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    put: async (key, blob) => { data.set(key, blob); }, get: async (key) => data.get(key),
    remove: async (key) => { data.delete(key); } };
}

afterEach(() => { vi.useRealTimers(); });

describe("recording pieces", () => {
  it("uploads each piece once under parts/, in order, with unique names", async () => {
    const upload = vi.fn(async (o: { name: string }) => o.name);
    const parts = startPartUploads({ folder: "Exam", owner: "R1", family: "exam", store: disk(), upload, now: () => 5_000 });
    for (let i = 0; i < 3; i++) parts.enqueue(new Blob([`chunk${i}`]));
    expect(await parts.flush()).toBe(true);
    const names = upload.mock.calls.map(([o]) => o.name).sort();
    expect(names).toEqual([
      "parts/exam_0000000005000.webm",
      "parts/exam_0000000005001.webm",
      "parts/exam_0000000005002.webm",
    ]);
    parts.stop();
  });

  it("a recorder restarted after a reload never overwrites earlier pieces", async () => {
    const names: string[] = [];
    const upload = async (o: { name: string }) => { names.push(o.name); return o.name; };
    const before = startPartUploads({ folder: "Exam", owner: "R1", family: "exam", store: disk(), upload, now: () => 1_000 });
    before.enqueue(new Blob(["a"]));
    before.enqueue(new Blob(["b"]));
    await before.flush();
    before.stop();
    const after = startPartUploads({ folder: "Exam", owner: "R1", family: "exam", store: disk(), upload, now: () => 2_000 });
    after.enqueue(new Blob(["c"]));
    await after.flush();
    after.stop();
    expect(new Set(names).size).toBe(3);
  });

  it("a failed piece stays on the device and is retried until it uploads", async () => {
    vi.useFakeTimers();
    const store = disk();
    let online = false;
    const upload = vi.fn(async (o: { name: string }) => (online ? o.name : null));
    const parts = startPartUploads({ folder: "Exam", owner: "R1", family: "exam", store, upload, now: () => 1 });
    parts.enqueue(new Blob(["piece"]));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(parts.pendingCount()).toBe(1));
    expect([...store.data.keys()]).toEqual(["Exam/R1/recordings/parts/exam_0000000000001.webm"]);
    online = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(parts.pendingCount()).toBe(0));
    expect(store.data.size).toBe(0);
    parts.stop();
  });

  it("waits on a weak link and uploads when it recovers; submit still drains", async () => {
    const upload = vi.fn(async (o: { name: string }) => o.name);
    const store = disk();
    const parts = startPartUploads({ folder: "Exam", owner: "R1", family: "screen", store, upload });
    parts.setPaused(true);
    parts.enqueue(new Blob(["one"]));
    await vi.waitFor(() => expect(store.data.size).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(upload).not.toHaveBeenCalled();
    parts.setPaused(false);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));

    parts.setPaused(true);
    parts.enqueue(new Blob(["two"]));
    expect(await parts.flush()).toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
    parts.stop();
  });
});
