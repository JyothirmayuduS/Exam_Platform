// Session report exports (teacher + proctor side).
//
// Generates the PDF and CSV client-side with jsPDF from the live roster +
// violation events already loaded from the DB, PLUS the candidate's stored
// per-second camera snapshots from private artifact storage. No
// HTML masquerading as a PDF.
//
// Snapshot timeline: for EVERY candidate the report embeds each stored
// snapshot (the frames the exam client captures every second) with its
// timestamp, and any violation whose moment falls under that snapshot is
// printed directly beneath it — so the reviewer sees exactly what the camera
// saw when each flag fired.

import { jsPDF } from "jspdf";
import { listStudentArtifacts, getArtifactBlob } from "@/shared/services/examStorage";

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

// No duration/frame cap: fetch and render a row at a time instead of keeping
// a second copy of every thumbnail in memory. The PDF itself still grows.
const SNAPS_PER_ROW = 3;

function snapEpochFromKey(key: string): number | null {
  const m = /snap_(\d{10,})\.jpe?g$/i.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the snapshot timeline for one candidate: every stored interval
 * snapshot, sorted by capture time, with the violations whose moment falls
 * in the same second (or within one second for legacy/jittered captures).
 * Returns null when storage is unavailable or holds no snapshots.
 */
export async function collectSnapshotTimeline(
  examId: string,
  roll: string,
  violations: ReportRow["violations"],
  startedAt?: string | null,
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
  if (!artifacts || artifacts.length === 0) {
    console.info(`[sessionReport] no stored artifacts for ${folderExamId}/${roll} — snapshot timeline skipped`);
    return null;
  }
  if (!artifacts.some((a) => a.kind === "screenshots")) {
    console.info(
      `[sessionReport] ${artifacts.length} artifact(s) for ${folderExamId}/${roll} but none are interval snapshots (kinds: ${[...new Set(artifacts.map((a) => a.kind))].join(", ")})`,
    );
  }

  const snaps = artifacts
    .filter((a) => a.kind === "screenshots")
    .map((a) => ({ key: a.key, epochMs: snapEpochFromKey(a.key) }))
    .filter((s): s is { key: string; epochMs: number } => s.epochMs !== null)
    .sort((a, b) => a.epochMs - b.epochMs);
  if (snaps.length === 0) return null;

  const timeline: SnapshotEntry[] = snaps.map((snap) => ({ ...snap, violations: [] }));
  const seconds = new Map<number, SnapshotEntry>();
  for (const snap of timeline) {
    const second = Math.floor(snap.epochMs / 1000);
    if (!seconds.has(second)) seconds.set(second, snap);
  }
  const startMs = Date.parse(startedAt ?? "");
  for (const v of violations) {
    const createdMs = Date.parse(v.created_at);
    const t = Number.isFinite(createdMs) ? createdMs
      : v.offset_seconds != null && Number.isFinite(startMs) ? startMs + v.offset_seconds * 1000 : NaN;
    if (!Number.isFinite(t)) continue;
    let match = seconds.get(Math.floor(t / 1000));
    if (!match) {
      // Binary search keeps multi-hour reports linearithmic, rather than
      // scanning the entire violation log for every frame.
      let lo = 0, hi = timeline.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (timeline[mid].epochMs < t) lo = mid + 1;
        else hi = mid;
      }
      match = [timeline[lo - 1], timeline[lo]].filter(Boolean)
        .sort((a, b) => Math.abs(a.epochMs - t) - Math.abs(b.epochMs - t))[0];
      // Never imply a warning during a camera gap was photographed. It still
      // appears in the full violation detail section.
      if (match && Math.abs(match.epochMs - t) > 1000) match = undefined;
    }
    match?.violations.push(v);
  }
  return timeline;
}

/** Fetch a stored snapshot and downscale it to a small embedded JPEG. */
async function snapshotThumbDataUrl(key: string, maxEdge = 480): Promise<string | null> {
  try {
    const blob = await getArtifactBlob(key);
    if (!blob) return null;
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

/** Render all available evidence, including clean frames and explicit gaps. */
export async function drawSnapshotTimeline(doc: jsPDF, row: ReportRow, examId: string): Promise<number> {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 32;
  const timeline = await collectSnapshotTimeline(examId, row.roll, row.violations, row.startedAt);
  const startMs = Date.parse(row.startedAt ?? "");
  const newPage = () => {
    doc.addPage();
    doc.setFillColor(26, 58, 42);
    doc.rect(0, 0, W, 56, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(`Snapshot Timeline - ${row.name} (${row.roll})`, M, 26);
    doc.setFontSize(8);
    doc.text(`${timeline?.length ?? 0} stored snapshots | Target: 1 webcam frame/second | Warnings are not required for capture.`, M, 43);
  };
  newPage();
  if (!timeline?.length) {
    doc.setTextColor(155, 28, 28);
    doc.setFontSize(10);
    doc.text("No snapshots available. Evidence may be missing, still uploading, or storage is unreachable.", M, 85);
    return 0;
  }

  const gutter = 12;
  const cellW = (W - M * 2 - gutter * (SNAPS_PER_ROW - 1)) / SNAPS_PER_ROW;
  const imgH = Math.round(cellW * 0.75);
  const lineH = 10;
  const baseH = imgH + 27;
  const maxLines = Math.max(1, Math.floor((H - 110 - baseH) / lineH));
  let y = 74;
  for (let i = 0; i < timeline.length; i += SNAPS_PER_ROW) {
    const slice = timeline.slice(i, i + SNAPS_PER_ROW);
    const thumbs = await Promise.all(slice.map((s) => snapshotThumbDataUrl(s.key)));
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    const captions = slice.map((snap, j) => {
      const lines: string[] = [];
      const previous = timeline[i + j - 1];
      if (previous && snap.epochMs - previous.epochMs > 2000) {
        lines.push(`Evidence gap: ${fmtReportClock((snap.epochMs - previous.epochMs) / 1000)} since previous frame.`);
      }
      for (const v of snap.violations) {
        const stamp = Number.isFinite(Date.parse(v.created_at)) ? fmtWallClock(Date.parse(v.created_at)) : fmtReportClock(v.offset_seconds);
        lines.push(`Warning [${v.severity}] ${stamp}: ${v.description || v.type}`);
      }
      if (!snap.violations.length) lines.push("No warning recorded for this snapshot.");
      return lines.flatMap((line) => doc.splitTextToSize(line, cellW) as string[]);
    });
    const longest = Math.max(...captions.map((c) => c.length));
    // An unusually long transcript continues below the SAME image on another
    // page instead of being cut off or overlapping the next row.
    for (let offset = 0; offset < longest; offset += maxLines) {
      const lineCount = Math.min(maxLines, longest - offset);
      const rowH = baseH + lineCount * lineH;
      if (y + rowH > H - 30) { newPage(); y = 74; }
      slice.forEach((snap, col) => {
        if (offset > 0 && captions[col].length <= offset) return;
        const x = M + col * (cellW + gutter);
        doc.setDrawColor(180, 180, 180);
        doc.setLineWidth(0.7);
        doc.rect(x, y, cellW, imgH, "S");
        let embedded = false;
        if (thumbs[col]) {
          try {
            const thumb = thumbs[col]!;
            // Preserve the camera's aspect ratio rather than stretching faces.
            const props = doc.getImageProperties(thumb);
            const scale = Math.min(cellW / props.width, imgH / props.height);
            const w = props.width * scale, h = props.height * scale;
            doc.addImage(thumb, "JPEG", x + (cellW - w) / 2, y + (imgH - h) / 2, w, h, undefined, "FAST");
            embedded = true;
          } catch { /* explicitly mark unavailable images below */ }
        }
        if (!embedded) {
          doc.setTextColor(130, 130, 130);
          doc.setFontSize(7);
          doc.text("(frame unavailable)", x + 4, y + imgH / 2);
        }
        doc.setFont("courier", "bold");
        doc.setFontSize(7.5);
        doc.setTextColor(30, 30, 30);
        const elapsed = Number.isFinite(startMs) && snap.epochMs >= startMs ? ` +${fmtReportClock((snap.epochMs - startMs) / 1000)}` : "";
        doc.text(`${fmtWallClock(snap.epochMs)}${elapsed}${offset ? " (continued)" : ""}`, x, y + imgH + 12);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(snap.violations.length ? 155 : 100, snap.violations.length ? 28 : 100, snap.violations.length ? 28 : 100);
        captions[col].slice(offset, offset + maxLines).forEach((line, n) => {
          doc.text(line, x, y + imgH + 24 + n * lineH);
        });
      });
      y += rowH + 10;
    }
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
        const detailLines = doc.splitTextToSize(`${vi + 1}. ${v.description || v.type}${stamp}`, CW - 32) as string[];
        for (const line of detailLines) {
          if (y > 510) { doc.addPage(); y = 60; }
          doc.text(line, M + 16, y);
          y += 12;
        }
        if (y > 510) { doc.addPage(); y = 60; }
        doc.setFontSize(7.5);
        doc.setTextColor(130, 130, 130);
        doc.text(
          `${v.type} · ${v.severity} · ${new Date(v.created_at).toLocaleString()}`,
          M + 16,
          y,
        );
        doc.setFontSize(9);
        y += 18;
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
        doc.addPage();
        doc.setFontSize(11);
        doc.setTextColor(155, 28, 28);
        doc.text(`Snapshot export incomplete for ${r.name} (${r.roll}). Please retry this student's report.`, M, 60);
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
