// After submit: land every piece of exam evidence and say honestly whether it
// all made it. Recording pieces are drained on any link for as long as the
// app stays open (the kiosk does not exit while pieces remain on the device).
import type { PartUploader } from "@/shared/services/recordingParts";

export type EvidenceOutcome = {
  state: "stored" | "partial";
  detail: string;
  /** Every recording piece on the device has uploaded. */
  piecesLanded: true;
};

export const SECURED_DETAIL = "Exam recording secured.";

/**
 * Upload the submit-time evidence while draining the camera and screen
 * pieces. Resolves only when no recording piece is left on the device.
 * "stored" requires the camera pieces (at least one), every screen piece,
 * every violation snapshot and the PDF.
 */
export async function secureExamEvidence(opts: {
  camera: PartUploader | null;
  screen: PartUploader | null;
  /** Violation snapshots + PDF (examStorage.uploadExamRecords). */
  uploadRecords: () => Promise<{ pdfKey: string | null; snapshotKeys: string[] }>;
  violationSnapshotCount: number;
  /** Periodic webcam snapshots finished uploading without gaps. */
  snapshots: Promise<boolean>;
  /** Pieces still on the device, reported about once a second. */
  onPiecesLeft?: (left: number) => void;
  /** No recording piece is left on the device. */
  onPiecesLanded?: () => void;
}): Promise<EvidenceOutcome> {
  const uploaders = [opts.camera, opts.screen].filter((u): u is PartUploader => !!u);
  const left = () => uploaders.reduce((n, u) => n + u.pendingCount(), 0);
  let draining = true;
  const ticker = opts.onPiecesLeft
    ? setInterval(() => { if (draining) opts.onPiecesLeft!(left()); }, 1000)
    : undefined;
  const pieces = Promise.all(uploaders.map((u) => u.drain())).finally(() => {
    draining = false;
    clearInterval(ticker);
    opts.onPiecesLeft?.(0);
    opts.onPiecesLanded?.();
  });

  let records: { pdfKey: string | null; snapshotKeys: string[] } = { pdfKey: null, snapshotKeys: [] };
  try { records = await opts.uploadRecords(); } catch { /* reported below */ }
  const snapshotsOk = await opts.snapshots.catch(() => false);
  await pieces;

  const problems: string[] = [];
  if ((opts.camera?.producedCount() ?? 0) === 0) problems.push("the camera recording has no video");
  if (records.snapshotKeys.length < opts.violationSnapshotCount) problems.push("some violation snapshots did not upload");
  if (!records.pdfKey) problems.push("the session report did not upload");
  if (!snapshotsOk) problems.push("some camera snapshots are missing");
  if (problems.length === 0) return { state: "stored", detail: SECURED_DETAIL, piecesLanded: true };
  return {
    state: "partial",
    detail: `Some exam evidence is missing: ${problems.join("; ")}. Please inform your invigilator before closing the app.`,
    piecesLanded: true,
  };
}
