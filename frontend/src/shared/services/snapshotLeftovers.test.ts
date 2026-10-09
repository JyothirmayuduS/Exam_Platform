import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimSnapshotFolder,
  releaseSnapshotFolder,
  resumeLeftoverSnapshots,
  SNAPSHOT_RETRY_MS,
  stopLeftoverSnapshots,
} from "@/shared/services/snapshotLeftovers";
import type { SnapshotStore, UploadResult } from "@/shared/services/snapshotOutbox";

vi.mock("@/shared/services/r2Function", () => ({ r2PutBlobResult: vi.fn() }));

afterEach(() => { stopLeftoverSnapshots(); vi.useRealTimers(); });

function disk(keys: string[]): SnapshotStore & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>(keys.map((k) => [k, new Blob([k])]));
  return { data, keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    put: async (key, blob) => { data.set(key, blob); }, get: async (key) => data.get(key),
    remove: async (key) => { data.delete(key); } };
}

const mine = ["Exam/R1/screenshots/snap_1000.jpg", "Exam/R1/screenshots/snap_2000.jpg", "Exam/R1/screenshots/snap_3000.jpg"];
const theirs = ["Exam/R2/screenshots/snap_1000.jpg", "Exam/R2/screenshots/snap_2000.jpg"];
const pieces = ["Exam/R1/recordings/parts/exam_0000000001000_0000000000000.webm"];

describe("leftover webcam snapshots", () => {
  it("upload at the next sign-in for that student only; other students' stay on disk", async () => {
    const store = disk([...mine, ...theirs, ...pieces]);
    const upload = vi.fn(async (): Promise<UploadResult> => true);
    const log = vi.fn();

    // Nobody signed in yet: nothing uploads.
    const before = await resumeLeftoverSnapshots({ owners: [], store, upload, log });
    expect(before.resumed).toEqual([]);
    expect(before.waiting).toBe(5);
    expect(upload).not.toHaveBeenCalled();

    // R1 signs in.
    const report = await resumeLeftoverSnapshots({ owners: ["R1", "student-uuid"], store, upload, log });
    expect(report.resumed).toEqual(["Exam/R1/screenshots/"]);
    expect(report.waiting).toBe(2);
    expect(report.waitingOwners).toEqual(["R2"]);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect([...store.data.keys()].sort()).toEqual([...theirs, ...pieces].sort()));
    expect(upload.mock.calls.map((c) => (c as unknown as [string])[0]).sort()).toEqual(mine);
    expect(log.mock.calls.some(([m]) => String(m).includes("2 camera snapshot(s) from 1 other student(s)"))).toBe(true);
  });

  it("stops on a 403 and leaves the snapshots on disk", async () => {
    vi.useFakeTimers();
    const store = disk(mine);
    const upload = vi.fn(async (): Promise<UploadResult> => ({ refused: 403, reason: "forbidden" }));
    const log = vi.fn();
    await resumeLeftoverSnapshots({ owners: ["R1"], store, upload, log });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_MS * 5);
    expect(upload.mock.calls.length).toBeLessThanOrEqual(3);
    expect(store.data.size).toBe(3);
    expect(log.mock.calls.some(([m]) => String(m).includes("HTTP 403"))).toBe(true);
  });

  it("retries after a failed upload until the link is back", async () => {
    vi.useFakeTimers();
    const store = disk(mine);
    let online = false;
    const upload = vi.fn(async (): Promise<UploadResult> => online);
    await resumeLeftoverSnapshots({ owners: ["R1"], store, upload });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_MS);
    expect(store.data.size).toBe(3);
    online = true;
    await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_MS);
    expect(store.data.size).toBe(0);
  });

  it("leaves a folder to the exam capture that owns it", async () => {
    const store = disk(mine);
    const upload = vi.fn(async (): Promise<UploadResult> => true);
    void claimSnapshotFolder("Exam/R1/screenshots/");
    const report = await resumeLeftoverSnapshots({ owners: ["R1"], store, upload });
    expect(report.resumed).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    releaseSnapshotFolder("Exam/R1/screenshots/");
  });
});
