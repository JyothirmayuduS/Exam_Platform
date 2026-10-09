// Tests for the per-student evidence ZIP export: every candidate gets a
// folder containing recording/ (one full video per recording, joined from
// its pieces; finished webm for older exams) and ss/ (screenshots + violations), plus the report PDF at the
// student root — all packed into ONE downloadable zip.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { unzipSync } from "fflate";
import { listStudentArtifacts, getArtifactObjectUrl, signArtifactBatch } from "@/shared/services/examStorage";
import { downloadExamEvidenceZip } from "@/shared/services/zipExport";
import { createBlobSink } from "@/shared/services/zipStream";

vi.mock("@/shared/services/examStorage", () => ({
  listStudentArtifacts: vi.fn(),
  getArtifactObjectUrl: vi.fn(),
  getArtifactUrls: vi.fn(async () => new Map()),
  signArtifactBatch: vi.fn(),
}));

function mockResponse(bytes: number[]): { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> } {
  return { ok: true, arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

const RECORDING_BYTES = [1, 2, 3, 4];
const SNAPSHOT_BYTES = [10, 20, 30];

describe("downloadExamEvidenceZip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Batch signing, answered here by the single-key mock each test sets up.
    vi.mocked(signArtifactBatch).mockImplementation(async (keys: string[]) => {
      const out = new Map<string, string>();
      for (const k of keys) {
        const u = await vi.mocked(getArtifactObjectUrl)(k);
        if (u) out.set(k, u);
      }
      return out;
    });
    vi.useFakeTimers();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse([0]) as unknown as Response),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("packs each student into a folder with recording/ and ss/ subfolders", async () => {
    vi.mocked(listStudentArtifacts)
      .mockResolvedValueOnce([
        { key: "Test-3/21VGN0314/recordings/recording_1756.webm", kind: "recordings", name: "recording_1756.webm", size: 10, lastModified: "2026-09-01T00:00:00Z" },
        { key: "Test-3/21VGN0314/screenshots/snap_1.jpg", kind: "screenshots", name: "snap_1.jpg", size: 10, lastModified: null },
        { key: "Test-3/21VGN0314/violations/1756_face.jpg", kind: "violations", name: "1756_face.jpg", size: 10, lastModified: null },
        { key: "Test-3/21VGN0314/report/report_1756.pdf", kind: "report", name: "report_1756.pdf", size: 10, lastModified: null },
      ])
      .mockResolvedValueOnce([
        { key: "Test-3/21VGN0315/recordings/recording_1780.webm", kind: "recordings", name: "recording_1780.webm", size: 10, lastModified: "2026-09-01T00:01:00Z" },
        { key: "Test-3/21VGN0315/screenshots/snap_2.jpg", kind: "screenshots", name: "snap_2.jpg", size: 10, lastModified: null },
      ]);
    vi.mocked(getArtifactObjectUrl).mockResolvedValue("https://r2.example/object");
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(mockResponse(RECORDING_BYTES) as unknown as Response)
      .mockResolvedValueOnce(mockResponse(SNAPSHOT_BYTES) as unknown as Response)
      .mockResolvedValueOnce(mockResponse([7]) as unknown as Response)
      .mockResolvedValueOnce(mockResponse([8]) as unknown as Response)
      .mockResolvedValueOnce(mockResponse(RECORDING_BYTES) as unknown as Response)
      .mockResolvedValueOnce(mockResponse(SNAPSHOT_BYTES) as unknown as Response);

    const captured: HTMLAnchorElement[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        captured.push(this);
      });

    const res = await downloadExamEvidenceZip({
      examId: "EXAM-2026-0001",
      examName: "Test-3",
      students: [
        { roll: "21VGN0314", name: "John Doe" },
        { roll: "21VGN0315", name: "Jane Roe" },
      ],
    });

    expect(res.studentCount).toBe(2);
    expect(res.fileCount).toBe(6);
    expect(res.errors).toEqual([]);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(captured[0]?.download).toBe("Test-3_evidence.zip");
    expect(captured[0]?.href).toContain("blob:mock");

    // Read the zip bytes back and verify the folder layout.
    const zipBlob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    const unzipped = unzipSync(new Uint8Array(await zipBlob.arrayBuffer()));
    const paths = Object.keys(unzipped).sort();
    expect(paths).toEqual([
      "21VGN0314 - John Doe/recording/recording_1756.webm",
      "21VGN0314 - John Doe/report.pdf",
      "21VGN0314 - John Doe/ss/snap_1.jpg",
      "21VGN0314 - John Doe/ss/violations/1756_face.jpg",
      "21VGN0315 - Jane Roe/recording/recording_1780.webm",
      "21VGN0315 - Jane Roe/ss/snap_2.jpg",
    ]);
    expect(Array.from(unzipped["21VGN0314 - John Doe/recording/recording_1756.webm"])).toEqual(RECORDING_BYTES);
    expect(Array.from(unzipped["21VGN0315 - Jane Roe/ss/snap_2.jpg"])).toEqual(SNAPSHOT_BYTES);
  });

  it("exports each recording as ONE full video joined from its pieces, in order", async () => {
    const piece = (family: string, seq: number) => ({
      key: `Test-3/21VGN0314/recordings/parts/${family}_${String(seq).padStart(13, "0")}.webm`,
      kind: "recordings" as const, name: `${family}_${seq}.webm`, size: 1, lastModified: null,
    });
    // Listed out of order; seq 9 < 10 < 100 must sort numerically.
    vi.mocked(listStudentArtifacts).mockResolvedValueOnce([
      piece("exam", 100), piece("exam", 9), piece("screen", 5), piece("exam", 10), piece("screen", 6),
    ]);
    vi.mocked(getArtifactObjectUrl).mockImplementation(async (key: string) => `https://r2.example/${key}`);
    vi.mocked(fetch).mockImplementation(async (url) => {
      const seq = Number(String(url).match(/_(\d+)\.webm$/)?.[1]);
      return mockResponse([seq]) as unknown as Response;
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const res = await downloadExamEvidenceZip({
      examId: "EXAM-2026-0001",
      students: [{ roll: "21VGN0314", name: "John Doe" }],
    });

    expect(res.errors).toEqual([]);
    expect(res.fileCount).toBe(2);
    const zipBlob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    const unzipped = unzipSync(new Uint8Array(await zipBlob.arrayBuffer()));
    expect(Object.keys(unzipped).sort()).toEqual([
      "21VGN0314 - John Doe/recording/camera_full_exam.webm",
      "21VGN0314 - John Doe/recording/screen_full_exam.webm",
    ]);
    expect(Array.from(unzipped["21VGN0314 - John Doe/recording/camera_full_exam.webm"])).toEqual([9, 10, 100]);
    expect(Array.from(unzipped["21VGN0314 - John Doe/recording/screen_full_exam.webm"])).toEqual([5, 6]);
  });

  it("does not trigger a download when nothing is stored, and reports fetch failures", async () => {
    vi.mocked(listStudentArtifacts)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { key: "Test-3/21VGN0315/recordings/recording_1.webm", kind: "recordings", name: "recording_1.webm", size: 10, lastModified: null },
      ]);
    vi.mocked(getArtifactObjectUrl).mockResolvedValue(null); // signing fails

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const res = await downloadExamEvidenceZip({
      examId: "EXAM-2026-0001",
      students: [
        { roll: "21VGN0314", name: "John Doe" },
        { roll: "21VGN0315", name: "Jane Roe" },
      ],
    });

    expect(res.fileCount).toBe(0);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("puts a note in the zip and reports a piece that could not be fetched", async () => {
    const start = 1_700_000_000_000;
    const key = (i: number) => `Test-3/21VGN0314/recordings/parts/exam_${start + (i + 1) * 10_000}_${start}.webm`;
    vi.mocked(listStudentArtifacts).mockResolvedValueOnce([0, 1, 2].map((i) => (
      { key: key(i), kind: "recordings" as const, name: key(i).split("/").pop()!, size: 1, lastModified: null })));
    vi.mocked(getArtifactObjectUrl).mockImplementation(async (k: string) => `https://r2.example/${k}`);
    vi.mocked(fetch).mockImplementation(async (url) => (String(url).endsWith(key(1))
      ? { ok: false, status: 404 } as unknown as Response
      : mockResponse([5]) as unknown as Response));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const res = await downloadExamEvidenceZip({ examId: "E", students: [{ roll: "21VGN0314", name: "John Doe" }] });

    expect(res.errors).toEqual(["21VGN0314: 1 piece(s) of the camera recording could not be included"]);
    const zipBlob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    const unzipped = unzipSync(new Uint8Array(await zipBlob.arrayBuffer()));
    expect(Array.from(unzipped["21VGN0314 - John Doe/recording/camera_full_exam.webm"])).toEqual([5, 5]);
    const note = new TextDecoder().decode(unzipped["21VGN0314 - John Doe/recording/camera_MISSING_PIECES.txt"]);
    expect(note).toContain("1 of 3 pieces");
    expect(note).toContain(`00:10–00:20: piece ${key(1).split("/").pop()} is missing from storage (HTTP 404)`);
  });

  it("exports a whole class one student at a time without holding every video in memory", async () => {
    vi.useRealTimers();
    const STUDENTS = 40;
    const PIECES = 6;
    const PIECE_BYTES = 256 * 1024;
    const start = 1_700_000_000_000;
    const students = Array.from({ length: STUDENTS }, (_, i) => ({ roll: `R${String(i).padStart(3, "0")}`, name: `Student ${i}` }));
    vi.mocked(listStudentArtifacts).mockImplementation(async (_exam: string, roll: string) => [
      ...Array.from({ length: PIECES }, (_, i) => {
        const k = `Class/${roll}/recordings/parts/screen_${start + (i + 1) * 10_000}_${start}.webm`;
        return { key: k, kind: "recordings" as const, name: k.split("/").pop()!, size: PIECE_BYTES, lastModified: null };
      }),
      { key: `Class/${roll}/report/report.pdf`, kind: "report" as const, name: "report.pdf", size: 3, lastModified: null },
    ]);
    vi.mocked(getArtifactObjectUrl).mockImplementation(async (k: string) => `https://r2.example/${k}`);

    // Bytes downloaded but not yet written out of the page: what the tab holds.
    let downloaded = 0;
    let written = 0;
    let peakHeld = 0;
    vi.mocked(fetch).mockImplementation(async (url) => {
      const pdf = String(url).endsWith(".pdf");
      const roll = Number(String(url).match(/Class\/R(\d+)\//)?.[1]);
      return {
        ok: true, status: 200,
        arrayBuffer: async () => {
          const bytes = new Uint8Array(pdf ? 3 : PIECE_BYTES).fill(roll % 251);
          downloaded += bytes.length;
          peakHeld = Math.max(peakHeld, downloaded - written);
          return bytes.buffer;
        },
      } as unknown as Response;
    });

    const out: Uint8Array[] = [];
    let closed = false;
    const sink = {
      write: async (chunk: Uint8Array) => {
        written += chunk.length;
        out.push(chunk);
        await new Promise((r) => setTimeout(r, 0));
      },
      close: async () => { closed = true; },
    };
    const progress: string[] = [];
    const res = await downloadExamEvidenceZip({ examId: "E", students, sink, onProgress: (m) => progress.push(m) });

    expect(closed).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.studentCount).toBe(STUDENTS);
    expect(res.fileCount).toBe(STUDENTS * 2);
    const total = STUDENTS * PIECES * PIECE_BYTES;
    expect(downloaded).toBeGreaterThanOrEqual(total);
    // At most the piece being joined plus its read-ahead, never a student's
    // whole recording, let alone the class.
    expect(peakHeld).toBeLessThanOrEqual(3 * PIECE_BYTES + 1024);
    expect(peakHeld).toBeLessThan(PIECES * PIECE_BYTES);
    // Students are visited in order, one after another.
    const order = progress.filter((m) => m.endsWith("reading artifacts…")).map((m) => m.split(":")[0]);
    expect(order).toEqual(students.map((s) => s.name));

    const total2 = out.reduce((n, c) => n + c.length, 0);
    const zipBytes = new Uint8Array(total2);
    let at = 0;
    for (const c of out) { zipBytes.set(c, at); at += c.length; }
    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped)).toHaveLength(STUDENTS * 2);
    const video = unzipped["R007 - Student 7/recording/screen_full_exam.webm"];
    expect(video.length).toBe(PIECES * PIECE_BYTES);
    expect(video.every((x) => x === 7)).toBe(true);
  });

  it("the default sink moves zip bytes out of the page as it goes", async () => {
    const sink = createBlobSink("application/zip", 1024);
    let peak = 0;
    for (let i = 0; i < 100; i++) {
      await sink.write(new Uint8Array(300));
      peak = Math.max(peak, sink.heldBytes());
    }
    expect(peak).toBeLessThan(1024 + 300);
    const blob = await sink.close();
    expect(blob?.size).toBe(30_000);
  });
});