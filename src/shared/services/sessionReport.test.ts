import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSnapshotTimeline, downloadSessionReportPdf, drawSnapshotTimeline, type ReportRow } from "@/shared/services/sessionReport";
import { listStudentArtifacts, getArtifactBlob } from "@/shared/services/examStorage";

const pdf = vi.hoisted(() => ({
  internal: { pageSize: { getWidth: () => 842, getHeight: () => 595 } },
  addPage: vi.fn(), setFillColor: vi.fn(), rect: vi.fn(), setTextColor: vi.fn(),
  setFont: vi.fn(), setFontSize: vi.fn(), text: vi.fn(), setDrawColor: vi.fn(),
  setLineWidth: vi.fn(), addImage: vi.fn(), save: vi.fn(),
  splitTextToSize: vi.fn((text: string) => [text]),
}));
vi.mock("jspdf", () => ({ jsPDF: class { constructor() { return pdf; } } }));
vi.mock("@/shared/services/examStorage", () => ({ listStudentArtifacts: vi.fn(), getArtifactBlob: vi.fn().mockResolvedValue(null) }));
const start = Date.parse("2026-09-01T10:00:00Z");
function snapshots(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    key: `Exam/R1/screenshots/snap_${start + i * 1000}.jpg`, kind: "screenshots" as const,
    name: `snap_${start + i * 1000}.jpg`, size: 10, lastModified: null,
  }));
}
function warning(ms: number, description = "Voice/audio detected"): ReportRow["violations"][number] {
  return { description, type: "audio_detected", severity: "high", offset_seconds: ms / 1000, created_at: new Date(start + ms).toISOString() };
}
const row: ReportRow = { name: "Candidate", roll: "R1", state: "Submitted", progress: 100, startedAt: new Date(start).toISOString(), violations: [] };

beforeEach(() => { vi.clearAllMocks(); vi.mocked(getArtifactBlob).mockResolvedValue(null); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("snapshot reports", () => {
  it("keeps every frame for a multi-hour clean exam, not only the first 720", async () => {
    vi.mocked(listStudentArtifacts).mockResolvedValue(snapshots(10801).reverse());
    const timeline = await collectSnapshotTimeline("EXAM-R1", "R1", []);
    expect(listStudentArtifacts).toHaveBeenCalledWith("EXAM", "R1");
    expect(timeline).toHaveLength(10801);
    expect(timeline?.at(-1)?.epochMs).toBe(start + 10800000);
    expect(timeline?.every((s) => s.violations.length === 0)).toBe(true);
  });

  it("puts voice warnings under the same-second image, including the final second", async () => {
    vi.mocked(listStudentArtifacts).mockResolvedValue(snapshots(3));
    const first = warning(100), last = warning(2900);
    const timeline = await collectSnapshotTimeline("EXAM", "R1", [first, last]);
    expect(timeline?.[0].violations).toEqual([first]);
    expect(timeline?.[1].violations).toEqual([]);
    expect(timeline?.[2].violations).toEqual([last]);
  });

  it("renders every stored frame even when there are no warnings", async () => {
    vi.mocked(listStudentArtifacts).mockResolvedValue(snapshots(725));
    await downloadSessionReportPdf("Exam", "EXAM-R1", [row]);
    const texts = pdf.text.mock.calls.flatMap((c) => c[0]);
    expect(texts.filter((s) => s === "(frame unavailable)")).toHaveLength(725);
    expect(pdf.save).toHaveBeenCalledWith("Session_Report_EXAM-R1.pdf");
  });

  it("prints all warnings and full speech text beneath an image without a two-warning cap", async () => {
    vi.mocked(listStudentArtifacts).mockResolvedValue(snapshots(1));
    const words = `Speech detected: ${"a long spoken phrase ".repeat(10)}END OF SPEECH`;
    await downloadSessionReportPdf("Exam", "EXAM", [{ ...row, violations: [warning(1, "First"), warning(2, "Second"), warning(3, words)] }]);
    const texts = pdf.text.mock.calls.flatMap((c) => c[0]);
    expect(texts.some((s) => typeof s === "string" && s.includes("Warning") && s.includes("END OF SPEECH"))).toBe(true);
    expect(texts.some((s) => typeof s === "string" && s.includes("more in violation detail"))).toBe(false);
  });

  it("includes both clean and flagged students in a bulk PDF", async () => {
    vi.mocked(listStudentArtifacts).mockResolvedValue(snapshots(2));
    await downloadSessionReportPdf("Exam", "EXAM", [row, { ...row, roll: "R2", violations: [warning(1100)] }]);
    expect(listStudentArtifacts).toHaveBeenCalledWith("EXAM", "R1");
    expect(listStudentArtifacts).toHaveBeenCalledWith("EXAM", "R2");
    expect(pdf.text.mock.calls.filter((c) => c[0] === "(frame unavailable)")).toHaveLength(4);
  });

  it("creates real PDF image pages beyond the former cap", async () => {
    const { jsPDF } = await vi.importActual<typeof import("jspdf")>("jspdf");
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const addImage = vi.spyOn(doc, "addImage");
    vi.mocked(listStudentArtifacts).mockResolvedValue(snapshots(725));
    vi.mocked(getArtifactBlob).mockResolvedValue(new Blob(["fixture"]));
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 640, height: 480, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    // Actual lossless image bytes; jsPDF detects the format from the data URL.
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoUFAAAAHkAMHqWxkXAAAAAElFTkSuQmCC");
    expect(await drawSnapshotTimeline(doc, row, "EXAM")).toBe(725);
    expect(addImage).toHaveBeenCalledTimes(725);
    expect(doc.getNumberOfPages()).toBeGreaterThan(100);
    expect(doc.output()).toMatch(/^%PDF-/);
  });

  it("makes missing evidence visible instead of silently omitting the timeline", async () => {
    vi.mocked(listStudentArtifacts).mockResolvedValue([]);
    await downloadSessionReportPdf("Exam", "EXAM", [row]);
    expect(pdf.text.mock.calls.flatMap((c) => c[0]).some((s) => typeof s === "string" && s.includes("No snapshots available"))).toBe(true);
  });
});
