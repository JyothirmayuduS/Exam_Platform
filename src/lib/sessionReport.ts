// Session report exports (teacher + proctor side).
//
// Generates the PDF and CSV client-side with jsPDF from the live roster +
// violation events already loaded from the DB, PLUS the candidate's stored
// per-interval camera snapshots from Cloudflare R2. No server round trip, no
// HTML masquerading as a PDF.
//
// Snapshot timeline: for EVERY candidate the report embeds each stored
// snapshot (the frames the exam client uploads every few seconds) with its
// timestamp, and any violation whose moment falls under that snapshot is
// printed directly beneath it — so the reviewer sees exactly what the camera
// saw when each flag fired.

import { jsPDF } from "jspdf";
import { listStudentArtifacts, getArtifactObjectUrl } from "./examStorage";

export type ReportRow = {
  name: string;
  roll: string;
  state: string;
  progress: number;
  /** Attempt start (ISO) — turns snapshot captions into elapsed exam time. */
  startedAt?: string | null;
  violations: {
    description: string;
    type: string;
    severity: string;
    offset_seconds: number | null;
    created_at: string;
  }[];
};

export function fmtReportClock(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtWallClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour12: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot timeline (per candidate)
// ─────────────────────────────────────────────────────────────────────────────

/** One stored snapshot with the violations that happened under it. */
export type SnapshotEntry = {
  key: string;
  epochMs: number;
  violations: ReportRow["violations"];
};

/** Safety cap — a marathon exam must not produce an unbounded PDF. */
const MAX_SNAPS_PER_CANDIDATE = 720;
const SNAPS_PER_ROW = 2;
const SNAPS_PER_PAGE = SNAPS_PER_ROW * 3; // 2 cols × 3 rows

function snapEpochFromKey(key: string): number | null {
  const m = /snap_(\d{10,})\.jpe?g$/i.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the snapshot timeline for one candidate: every stored interval
 * snapshot, sorted by capture time, with the violations whose moment falls
 * under it (wall-clock window between the previous and this snapshot).
 * Returns null when storage is unavailable or holds no snapshots.
 */
export async function collectSnapshotTimeline(
  examId: string,
  roll: string,
  violations: ReportRow["violations"],
): Promise<SnapshotEntry[] | null> {
  if (!examId || !roll || roll === "—") return null;
  // Per-candidate exports append the roll to the examId argument
  // (`${examId}-${roll}`) for the FILENAME. That polluted id must never reach
  // the storage lookup — the artifacts live under `<examFolder>/<roll>/`, and
  // a lookup for folder "EXAM-…-21VGN0314" finds nothing, which is why the
  // per-student PDFs had zero snapshot pages while the whole-exam export had
  // them. Split the suffix off when it matches this row's roll.
  let folderExamId = examId;
  if (roll && examId.endsWith(`-${roll}`)) {
    folderExamId = examId.slice(0, examId.length - roll.length - 1);
  }
  let artifacts;
  try {
    artifacts = await listStudentArtifacts(folderExamId, roll);
  } catch {
    return null;
  }
  if (!artifacts || artifacts.length === 0) return null;

  const snaps = artifacts
    .filter((a) => a.kind === "screenshots")
    .map((a) => ({ key: a.key, epochMs: snapEpochFromKey(a.key) }))
    .filter((s): s is { key: string; epochMs: number } => s.epochMs !== null)
    .sort((a, b) => a.epochMs - b.epochMs)
    .slice(0, MAX_SNAPS_PER_CANDIDATE);
  if (snaps.length === 0) return null;

  const timed = violations
    .map((v) => ({ v, t: new Date(v.created_at).getTime() }))
    .filter((x) => Number.isFinite(x.t));

  return snaps.map((snap, i) => {
    const prev = i > 0 ? snaps[i - 1].epochMs : Number.NEGATIVE_INFINITY;
    return {
      key: snap.key,
      epochMs: snap.epochMs,
      violations: timed.filter((x) => x.t > prev && x.t <= snap.epochMs).map((x) => x.v),
    };
  });
}

/** Fetch a stored snapshot and downscale it to a small embedded JPEG. */
async function snapshotThumbDataUrl(key: string, maxEdge = 480): Promise<string | null> {
  try {
    const url = await getArtifactObjectUrl(key, 600);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return c.toDataURL("image/jpeg", 0.6);
  } catch {
    return null;
  }
}

/** Render one candidate's snapshot timeline into the open PDF document. */
async function drawSnapshotTimeline(
  doc: jsPDF,
  row: ReportRow,
  examId: string,
): Promise<number> {
  const W = doc.internal.pageSize.getWidth();
  const M = 32;
  const CW = W - M * 2;

  const timeline = await collectSnapshotTimeline(examId, row.roll, row.violations);
  if (!timeline || timeline.length === 0) return 0;

  const startMs = row.startedAt ? new Date(row.startedAt).getTime() : null;
  const elapsedLabel = (epochMs: number): string =>
    startMs && epochMs >= startMs ? `+${fmtReportClock((epochMs - startMs) / 1000)}` : "";

  // Section header page.
  doc.addPage();
  doc.setFillColor(26, 58, 42);
  doc.rect(0, 0, W, 56, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(`Snapshot Timeline — ${row.name} (${row.roll})`, M, 26);
  doc.setFontSize(9);
  const withViolations = timeline.filter((s) => s.violations.length > 0).length;
  doc.text(
    `${timeline.length} camera snapshot(s) · ${withViolations} under a violation — frames upload automatically every few seconds during the exam.`,
    M,
    42,
  );

  // Fetch thumbs in small batches to keep memory bounded.
  const thumbs: (string | null)[] = new Array(timeline.length).fill(null);
  const BATCH = 6;
  for (let i = 0; i < timeline.length; i += BATCH) {
    const slice = timeline.slice(i, i + BATCH);
    const results = await Promise.all(slice.map((s) => snapshotThumbDataUrl(s.key)));
    results.forEach((r, j) => { thumbs[i + j] = r; });
  }

  const gutter = 10;
  const cellW = (CW - gutter) / SNAPS_PER_ROW;
  const imgH = Math.round(cellW * 0.5625); // 16:9-ish camera crop
  const captionH = 11;
  const violationH = 9;
  const rowH = imgH + captionH + violationH * 2 + 8;

  let y = 74;
  let placed = 0;
  for (let i = 0; i < timeline.length; i++) {
    const col = placed % SNAPS_PER_ROW;
    if (col === 0) {
      if (y + rowH > doc.internal.pageSize.getHeight() - 40) {
        doc.addPage();
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.setTextColor(90, 90, 90);
        doc.text(`Snapshot Timeline — ${row.name} (${row.roll}) · continued`, M, 34);
        y = 52;
      }
    }
    const snap = timeline[i];
    const x = M + col * (cellW + gutter);

    // Frame
    doc.setDrawColor(180, 180, 180);
    doc.setLineWidth(0.7);
    doc.rect(x, y, cellW, imgH, "S");
    const thumb = thumbs[i];
    if (thumb) {
      try {
        doc.addImage(thumb, "JPEG", x, y, cellW, imgH, undefined, "FAST");
      } catch { /* bad image — keep the empty frame */ }
    } else {
      doc.setTextColor(150, 150, 150);
      doc.setFont("courier", "normal");
      doc.setFontSize(6.5);
      doc.text("(frame unavailable)", x + 4, y + imgH / 2);
    }

    // Caption: wall clock + elapsed exam time + violation count badge
    doc.setFont("courier", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(30, 30, 30);
    const elapsed = elapsedLabel(snap.epochMs);
    doc.text(
      `${fmtWallClock(snap.epochMs)}${elapsed ? ` · ${elapsed}` : ""}`,
      x,
      y + imgH + captionH - 3,
    );
    if (snap.violations.length > 0) {
      doc.setTextColor(200, 0, 0);
      doc.text(`${snap.violations.length} violation(s)`, x + cellW, y + imgH + captionH - 3, { align: "right" });
    }

    // Violations under THIS snapshot, with their timestamps.
    let vy = y + imgH + captionH + 1;
    doc.setFont("courier", "normal");
    if (snap.violations.length > 0) {
      for (const v of snap.violations.slice(0, 2)) {
        doc.setFontSize(6.3);
        doc.setTextColor(155, 28, 28);
        const line = `! ${v.description || v.type}`.slice(0, 68);
        doc.text(line, x, vy);
        doc.setTextColor(110, 110, 110);
        doc.text(fmtWallClock(new Date(v.created_at).getTime()), x + cellW, vy, { align: "right" });
        vy += violationH;
      }
      if (snap.violations.length > 2) {
        doc.setFontSize(6.3);
        doc.setTextColor(155, 28, 28);
        doc.text(`+ ${snap.violations.length - 2} more in violation detail`, x, vy);
      }
    } else {
      doc.setFontSize(6.3);
      doc.setTextColor(150, 150, 150);
      doc.text("no violation under this snap", x, vy);
    }

    placed += 1;
    if (placed % SNAPS_PER_ROW === 0) y += rowH;
  }

  return timeline.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF
// ─────────────────────────────────────────────────────────────────────────────

export async function downloadSessionReportPdf(
  examName: string,
  examId: string,
  rows: ReportRow[],
  generatedAt = new Date(),
  opts: { includeSnapshots?: boolean } = {},
): Promise<void> {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4", compress: true });
  const W = doc.internal.pageSize.getWidth();
  const M = 32;
  const CW = W - M * 2;

  const flagged = rows.filter((r) => r.violations.length > 0);
  const submitted = rows.filter((r) => r.state === "Submitted").length;

  // Header
  doc.setFillColor(26, 58, 42);
  doc.rect(0, 0, W, 64, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(`${examName} — Session Report`, M, 28);
  doc.setFont("courier", "normal");
  doc.setFontSize(9);
  doc.text(
    `${examId}  ·  ${generatedAt.toLocaleString()}  ·  ${rows.length} candidates · ${submitted} submitted · ${flagged.length} flagged`,
    M,
    46,
  );

  // Candidate table
  let y = 92;
  doc.setFontSize(9.5);
  rows.forEach((r, i) => {
    if (y > 500) {
      doc.addPage();
      y = 60;
      doc.setFontSize(9.5);
    }
    const fill = i % 2 === 1;
    if (fill) {
      doc.setFillColor(244, 244, 240);
      doc.rect(M, y - 12, CW, 18, "F");
    }
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(`${i + 1}`, M + 2, y);
    doc.text(r.name, M + 26, y);
    doc.setFont("courier", "normal");
    doc.setTextColor(90, 90, 90);
    doc.text(r.roll, M + 200, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(60, 60, 60);
    doc.text(r.state, M + 300, y);
    doc.text(`${r.progress}%`, M + 370, y);
    doc.setTextColor(r.violations.length > 0 ? 200 : 130, r.violations.length > 0 ? 0 : 130, 0);
    doc.text(r.violations.length > 0 ? `${r.violations.length} flag(s)` : "clean", M + 415, y);
    y += 18;
  });

  // Violation detail page(s)
  if (flagged.length > 0) {
    doc.addPage();
    doc.setFillColor(155, 28, 28);
    doc.rect(0, 0, W, 56, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("Violation Detail", M, 26);
    doc.setFontSize(9);
    doc.text(`${flagged.length} candidate(s) with proctoring flags — review each recording before finalising marks.`, M, 42);

    y = 84;
    doc.setFontSize(9);
    flagged.forEach((r) => {
      if (y > 520) { doc.addPage(); y = 60; doc.setFontSize(9); }
      doc.setFont("helvetica", "bold");
      doc.setTextColor(155, 28, 28);
      doc.text(`${r.name} (${r.roll})`, M, y);
      y += 14;
      r.violations.forEach((v, vi) => {
        if (y > 520) { doc.addPage(); y = 60; doc.setFontSize(9); }
        doc.setFont("courier", "normal");
        doc.setTextColor(40, 40, 40);
        const stamp = v.offset_seconds != null ? ` @ ${fmtReportClock(v.offset_seconds)}` : "";
        doc.text(`${vi + 1}. ${v.description || v.type}${stamp}`, M + 16, y);
        doc.setFontSize(7.5);
        doc.setTextColor(130, 130, 130);
        doc.text(
          `${v.type} · ${v.severity} · ${new Date(v.created_at).toLocaleString()}`,
          M + 16,
          y + 10,
        );
        doc.setFontSize(9);
        y += 24;
      });
      y += 10;
    });
  }

  // Per-candidate snapshot timeline: every stored snap with the violations
  // that occurred under it and their timestamps. NOTE: drawSnapshotTimeline
  // receives the examId only for the DB/storage folder resolution — the
  // collector also tolerates the `${examId}-${roll}` filename id.
  if (opts.includeSnapshots !== false) {
    for (const r of rows) {
      try {
        await drawSnapshotTimeline(doc, r, examId);
      } catch (err) {
        console.warn(`[sessionReport] snapshot timeline failed for ${r.roll}:`, err);
      }
    }
  }

  // Filename: keep the caller's id — per-candidate exports pass
  // `${examId}-${roll}` so each student's PDF is uniquely named.
  doc.save(`Session_Report_${examId}.pdf`);
}

/** Generic CSV download: `headers` are the column names, each `row` is the
 *  array of cell values for one line (objects use their `toString`). */
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadSessionReportCsv(examId: string, rows: ReportRow[]): void {
  const header = "Candidate,Roll,State,Progress,Flags,Flag Details";
  const lines = rows.map((r) => {
    const details = r.violations
      .map((v) => `${v.type}@${fmtReportClock(v.offset_seconds)}:${v.description}`)
      .join(" | ");
    return `"${r.name.replace(/"/g, '""')}","${r.roll}","${r.state}","${r.progress}%","${r.violations.length}",${details ? `"${details.replace(/"/g, '""')}"` : '""'}`;
  });
  const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `proctor_log_${examId}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
