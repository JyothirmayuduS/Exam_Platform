import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadExamRecords } from "@/shared/services/examStorage";
import { startPartUploads } from "@/shared/services/recordingParts";
import { r2PutBlob } from "@/shared/services/r2Function";
import type { SnapshotStore } from "@/shared/services/snapshotOutbox";

vi.mock("@/shared/data/env", () => ({ supabaseConfigured: true }));
vi.mock("@/shared/services/r2Function", () => {
  const r2PutBlob = vi.fn(async (o: { examId: string; ownerSegment: string; kind: string; name: string }) =>
    `${o.examId}/${o.ownerSegment}/${o.kind}/${o.name}`);
  return {
    r2List: vi.fn(),
    r2FetchData: vi.fn(),
    r2PresignGet: vi.fn(),
    r2ListFolders: vi.fn(),
    r2PutBlob,
    r2PutBlobResult: vi.fn(async (o: Parameters<typeof r2PutBlob>[0]) => ({ key: await r2PutBlob(o) })),
  };
});
vi.mock("@/shared/data/api/exams", () => ({ listExams: vi.fn().mockResolvedValue([]) }));
vi.mock("@/shared/data/api/students", () => ({ getStudentIdByRoll: vi.fn().mockResolvedValue(null) }));

function disk(): SnapshotStore {
  const data = new Map<string, Blob>();
  return { keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
    put: async (key, blob) => { data.set(key, blob); }, get: async (key) => data.get(key),
    remove: async (key) => { data.delete(key); } };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("submit stores the recording once", () => {
  it("uploads the camera pieces and no second full copy", async () => {
    const pieces = [1000, 2000, 3000];
    const parts = startPartUploads({ folder: "Exam", owner: "R1", family: "exam", store: disk() });
    for (const size of pieces) parts.enqueue(new Blob([new Uint8Array(size)]));

    // What StudentExam's doSubmit does: drain the pieces, then the evidence.
    const [flushed, result] = await Promise.all([
      parts.flush(),
      uploadExamRecords({ examId: "EXAM", examName: "Exam", roll: "R1", studentName: "Student", violationSnapshots: [] }),
    ]);
    parts.stop();

    expect(flushed).toBe(true);
    expect(result).not.toHaveProperty("recordingKey");
    const recordingUploads = vi.mocked(r2PutBlob).mock.calls
      .map(([o]) => o)
      .filter((o) => o.kind === "recordings");
    expect(recordingUploads).toHaveLength(pieces.length);
    expect(recordingUploads.every((o) => o.name.startsWith("parts/exam_"))).toBe(true);
    // Stored bytes equal the recorded bytes: nothing is uploaded twice.
    const stored = recordingUploads.reduce((sum, o) => sum + o.blob.size, 0);
    expect(stored).toBe(pieces.reduce((a, b) => a + b, 0));
  });
});
