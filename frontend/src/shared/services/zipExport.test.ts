// Tests for the per-student evidence ZIP export: every candidate gets a
// folder containing recording/ (one full video per recording, joined from
// its pieces; finished webm for older exams) and ss/ (screenshots + violations), plus the report PDF at the
// student root — all packed into ONE downloadable zip.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { unzipSync } from "fflate";
import { listStudentArtifacts, getArtifactObjectUrl } from "@/shared/services/examStorage";
import { downloadExamEvidenceZip } from "@/shared/services/zipExport";

vi.mock("@/shared/services/examStorage", () => ({
  listStudentArtifacts: vi.fn(),
  getArtifactObjectUrl: vi.fn(),
  getArtifactUrls: vi.fn(async () => new Map()),
}));

function mockResponse(bytes: number[]): { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> } {
  return { ok: true, arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

const RECORDING_BYTES = [1, 2, 3, 4];
const SNAPSHOT_BYTES = [10, 20, 30];

describe("downloadExamEvidenceZip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});