import { describe, expect, it, vi } from "vitest";
import { startPartUploads } from "@/shared/services/recordingParts";
import type { SnapshotStore } from "@/shared/services/snapshotOutbox";
import { SECURED_DETAIL, secureExamEvidence } from "@/shared/services/submitEvidence";

function disk(): SnapshotStore & { data: Map<string, Blob> } {
  const data = new Map<string, Blob>();
  return { data, keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    put: async (key, blob) => { data.set(key, blob); }, get: async (key) => data.get(key),
    remove: async (key) => { data.delete(key); } };
}

const records = async () => ({ pdfKey: "Exam/R/report/report.pdf", snapshotKeys: ["v1.jpg", "v2.jpg"] });

describe("securing exam evidence after submit", () => {
  it("says secured only after the screen pieces have landed too", async () => {
    const camera = startPartUploads({ folder: "Exam", owner: "S1", family: "exam", store: disk(), upload: async (o) => o.name });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const screenStore = disk();
    const screen = startPartUploads({
      folder: "Exam", owner: "S1", family: "screen", store: screenStore,
      upload: async (o) => { await gate; return o.name; },
    });
    camera.enqueue(new Blob(["camera"]));
    screen.enqueue(new Blob(["screen 1"]));
    screen.enqueue(new Blob(["screen 2"]));

    let landed = false;
    let settled = false;
    const outcome = secureExamEvidence({
      camera, screen, uploadRecords: records, violationSnapshotCount: 2, snapshots: Promise.resolve(true),
      onPiecesLanded: () => { landed = true; },
    }).finally(() => { settled = true; });

    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(landed).toBe(false);
    expect(screen.pendingCount()).toBe(2);

    open();
    const result = await outcome;
    expect(landed).toBe(true);
    expect(result).toEqual({ state: "stored", detail: SECURED_DETAIL, piecesLanded: true });
    expect(screenStore.data.size).toBe(0);
    camera.stop();
    screen.stop();
  });

  it("does not say secured when the camera produced no pieces", async () => {
    const camera = startPartUploads({ folder: "Exam", owner: "S2", family: "exam", store: disk(), upload: async (o) => o.name });
    const screen = startPartUploads({ folder: "Exam", owner: "S2", family: "screen", store: disk(), upload: async (o) => o.name });
    screen.enqueue(new Blob(["screen"]));
    const result = await secureExamEvidence({
      camera, screen, uploadRecords: records, violationSnapshotCount: 2, snapshots: Promise.resolve(true),
    });
    expect(result.state).toBe("partial");
    expect(result.detail).toContain("the camera recording has no video");
    camera.stop();
    screen.stop();
  });

  it("reports a missing PDF or violation snapshot", async () => {
    const camera = startPartUploads({ folder: "Exam", owner: "S3", family: "exam", store: disk(), upload: async (o) => o.name });
    camera.enqueue(new Blob(["camera"]));
    const uploadRecords = vi.fn(async () => ({ pdfKey: null, snapshotKeys: ["v1.jpg"] }));
    const result = await secureExamEvidence({
      camera, screen: null, uploadRecords, violationSnapshotCount: 2, snapshots: Promise.resolve(true),
    });
    expect(result.state).toBe("partial");
    expect(result.detail).toContain("violation snapshots");
    expect(result.detail).toContain("session report");
    camera.stop();
  });
});
