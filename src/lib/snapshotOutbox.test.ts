import { describe, expect, it, vi } from "vitest";
import { createSnapshotOutbox, type SnapshotStore } from "./snapshotOutbox";

function disk(): SnapshotStore & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>();
  return { data, keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    put: async (key, blob) => { data.set(key, blob); }, get: async (key) => data.get(key),
    remove: async (key) => { data.delete(key); } };
}

describe("snapshot outbox", () => {
  it("queues every captured frame while slow uploads run, with bounded concurrency", async () => {
    const store = disk();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    let active = 0, peak = 0;
    const upload = vi.fn(async () => { peak = Math.max(peak, ++active); await delayed; active--; return true; });
    const outbox = createSnapshotOutbox({ prefix: "Exam/R1/", store, upload });
    for (let i = 0; i < 100; i++) outbox.enqueue(`Exam/R1/${i}.jpg`, new Blob([`${i}`]));
    const flush = outbox.flush();
    await vi.waitFor(() => expect(store.data.size).toBe(100));
    expect(upload).toHaveBeenCalledTimes(3);
    release();
    expect(await flush).toBe(true);
    expect(upload).toHaveBeenCalledTimes(100);
    expect(peak).toBe(3);
    expect(store.data.size).toBe(0);
  });

  it("retains failures for retry and only restores the same exam/student prefix", async () => {
    const store = disk();
    store.data.set("Exam/R2/private.jpg", new Blob(["other student"]));
    const first = createSnapshotOutbox({ prefix: "Exam/R1/", store, upload: async () => false });
    first.enqueue("Exam/R1/first.jpg", new Blob(["frame"]));
    expect(await first.flush()).toBe(false);
    expect(store.data.has("Exam/R1/first.jpg")).toBe(true);
    const upload = vi.fn(async () => true);
    const resumed = createSnapshotOutbox({ prefix: "Exam/R1/", store, upload });
    expect(await resumed.flush()).toBe(true);
    expect(upload).toHaveBeenCalledWith("Exam/R1/first.jpg", expect.any(Blob));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(store.data.has("Exam/R2/private.jpg")).toBe(true);
  });

  it("reports disk failure and still uploads the in-memory frame", async () => {
    const store = disk();
    store.put = async () => { throw new Error("Quota exceeded"); };
    const onError = vi.fn(), upload = vi.fn(async () => true);
    const outbox = createSnapshotOutbox({ prefix: "Exam/R1/", store, upload, onError });
    outbox.enqueue("Exam/R1/first.jpg", new Blob(["frame"]));
    expect(await outbox.flush()).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalled();
  });
});
