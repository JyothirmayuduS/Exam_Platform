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

/** Map roster flags into report violations, keeping the real type and offset. */
export function reportViolationsFromFlags(
  flags: { label: string; severity: string; at: string; atIso?: string; type?: string; offsetSeconds?: number | null }[],
): ReportRow["violations"] {
  return flags.map((f) => ({
    description: f.label,
    type: f.type || "flag",
    severity: f.severity,
    offset_seconds: f.offsetSeconds ?? null,
    created_at: f.atIso ?? f.at,
  }));
}

/** Progress %, falling back to counting saved answers when `answered` was never written. */
export function reportProgress(a: { answered: number; total: number; answers?: Record<string, unknown> }): number {
  if (!a.total) return 0;
  const saved = Object.values(a.answers ?? {}).filter((v) => v !== null && v !== undefined && v !== "").length;
  return Math.min(100, Math.round((Math.max(a.answered, saved) / a.total) * 100));
}

const PROCTOR_ACTION_TEXT = /paused by|resumed by|by proctor|by invigilator|warning sent to|incident escalated|forcefully submitted/i;

/** Invigilator actions (warnings, pause, resume, escalate, force submit) are not candidate violations. */
export function isProctorAction(v: { type: string; description: string }): boolean {
  return v.type.startsWith("proctor_") || PROCTOR_ACTION_TEXT.test(v.description);
}

/** Drop repeated identical entries logged within a few seconds of each other. */
export function dedupeViolations(list: ReportRow["violations"], windowMs = 5_000): ReportRow["violations"] {
  const lastAt = new Map<string, number>();
  const out: ReportRow["violations"] = [];
  const sorted = [...list].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const v of sorted) {
    const key = `${v.type}|${v.description}`;
    const t = Date.parse(v.created_at);
    const prev = lastAt.get(key);
    if (Number.isFinite(t) && prev !== undefined && t - prev < windowMs) continue;
    if (Number.isFinite(t)) lastAt.set(key, t);
    out.push(v);
  }
  return out;
}

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
    .filter((a) => a.kind === "screenshots" || a.kind === "violations" || a.kind === "ai_evidence")
    .map((a) => {
      const fromName = snapEpochFromKey(a.key) ?? snapEpochFromKey(a.name);
      const fromModified = a.lastModified ? Date.parse(a.lastModified) : NaN;
      const epochMs = fromName ?? (Number.isFinite(fromModified) ? fromModified : null);
      return epochMs == null ? null : { key: a.key, epochMs };
    })
    .filter((s): s is { key: string; epochMs: number } => s !== null)
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
export async function drawSnapshotTimeline(
  doc: jsPDF,
  row: ReportRow,
  examId: string,
  opts: { continuePage?: boolean } = {},
): Promise<number> {
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 32;
  const timeline = await collectSnapshotTimeline(examId, row.roll, row.violations, row.startedAt);
  const startMs = Date.parse(row.startedAt ?? "");
  const paintBanner = () => {
    doc.setFillColor(26, 58, 42);
    doc.rect(0, 0, W, 56, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(`Snapshot Timeline - ${row.name} (${row.roll})`, M, 26);
    doc.setFontSize(8);
    doc.text(`${timeline?.length ?? 0} stored snapshots | Target: 1 webcam frame/second | Warnings are not required for capture.`, M, 43);
  };
  const newPage = () => {
    doc.addPage();
    paintBanner();
  };
  if (opts.continuePage) paintBanner();
  else newPage();
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
      if (previous && snap.epochMs - previous.epochMs >= 1_600) {
        lines.push(`Evidence gap: ${Math.round((snap.epochMs - previous.epochMs) / 1000)} s since previous frame.`);
      }
      for (const v of snap.violations) {
        const stamp = Number.isFinite(Date.parse(v.created_at)) ? fmtWallClock(Date.parse(v.created_at)) : fmtReportClock(v.offset_seconds);
        const head = isProctorAction(v) ? "Proctor action" : `Warning [${v.severity}]`;
        lines.push(`${head} ${stamp}: ${v.description || v.type}`);
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
        const elapsed = Number.isFinite(startMs) ? ` +${fmtReportClock(Math.max(0, Math.round((snap.epochMs - startMs) / 1000)))}` : "";
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

/** List every stored recording and monitor clip so the PDF names the audio, not only the frames. */
async function drawAudioInventory(doc: jsPDF, row: ReportRow, examId: string): Promise<void> {
  let folderExamId = examId;
  if (row.roll && examId.endsWith(`-${row.roll}`)) {
    folderExamId = examId.slice(0, examId.length - row.roll.length - 1);
  }
  let artifacts;
  try {
    artifacts = await listStudentArtifacts(folderExamId, row.roll);
  } catch {
    return;
  }
  const clips = (artifacts ?? []).filter((a) => a.kind === "recordings" || a.kind === "monitor");
  const W = doc.internal.pageSize.getWidth();
  const M = 32;
  doc.addPage();
  doc.setFillColor(26, 58, 42);
  doc.rect(0, 0, W, 56, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(`Audio and recordings — ${row.name} (${row.roll})`, M, 26);
  doc.setFontSize(8);
  doc.text("Exam microphone audio is stored inside the recording files. Monitor clips are the phone-desk audio.", M, 43);
  let y = 84;
  doc.setTextColor(30, 30, 30);
  doc.setFontSize(10);
  if (clips.length === 0) {
    doc.setTextColor(155, 28, 28);
    doc.text("No recording or monitor audio was stored for this candidate.", M, y);
    return;
  }
  for (const clip of clips) {
    if (y > 520) { doc.addPage(); y = 60; }
    const when = clip.lastModified ? new Date(clip.lastModified).toLocaleString() : "time unknown";
    const kb = clip.size ? `${Math.max(1, Math.round(clip.size / 1024))} KB` : "size unknown";
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 30, 30);
    doc.text(clip.kind === "monitor" ? "Monitor audio" : "Exam recording (camera + microphone)", M, y);
    y += 14;
    doc.setFont("courier", "normal");
    doc.setFontSize(8);
    doc.setTextColor(80, 80, 80);
    const lines = doc.splitTextToSize(`${clip.name} · ${kb} · ${when}`, W - M * 2) as string[];
    for (const line of lines) {
      doc.text(line, M, y);
      y += 11;
    }
    y += 10;
    doc.setFontSize(10);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF
// ─────────────────────────────────────────────────────────────────────────────

export async function downloadSessionReportPdf(
  examName: string,
  examId: string,
  rows: ReportRow[],
  generatedAt = new Date(),
  opts: { includeSnapshots?: boolean; onProgress?: (message: string) => void } = {},
): Promise<void> {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4", compress: true });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 32;
  const CW = W - M * 2;

  rows = rows.map((r) => ({ ...r, violations: dedupeViolations(r.violations) }));
  const aiOf = (r: ReportRow) => r.violations.filter((v) => !isProctorAction(v));
  const actionsOf = (r: ReportRow) => r.violations.filter((v) => isProctorAction(v));
  const flagged = rows.filter((r) => aiOf(r).length > 0);
  const submitted = rows.filter((r) => r.state === "Submitted").length;
  const single = rows.length === 1;
  const bottom = H - 40;

  // Header
  doc.setFillColor(26, 58, 42);
  doc.rect(0, 0, W, 64, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(single ? `${examName} — ${rows[0].name} (${rows[0].roll})` : `${examName} — Session Report`, M, 28);
  doc.setFont("courier", "normal");
  doc.setFontSize(9);
  doc.text(
    single
      ? `${generatedAt.toLocaleString()}  ·  ${rows[0].state} · ${rows[0].progress}% answered · ${aiOf(rows[0]).length} violation(s) · ${actionsOf(rows[0]).length} proctor action(s)`
      : `${generatedAt.toLocaleString()}  ·  ${rows.length} candidates · ${submitted} submitted · ${flagged.length} flagged`,
    M,
    46,
  );

  let y = 92;
  if (!single) {
    doc.setFontSize(9.5);
    rows.forEach((r, i) => {
      if (y > bottom) {
        doc.addPage();
        y = 60;
        doc.setFontSize(9.5);
      }
      if (i % 2 === 1) {
        doc.setFillColor(244, 244, 240);
        doc.rect(M, y - 12, CW, 18, "F");
      }
      const n = aiOf(r).length;
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
      doc.setTextColor(n > 0 ? 200 : 130, n > 0 ? 0 : 130, 0);
      doc.text(n > 0 ? `${n} violation(s)` : "clean", M + 415, y);
      y += 18;
    });
  }

  const section = (title: string, subtitle: string, rgb: [number, number, number]) => {
    if (!single || y > bottom - 80) {
      doc.addPage();
      y = 0;
    } else {
      y += 6;
    }
    doc.setFillColor(...rgb);
    doc.rect(0, y, W, 44, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(title, M, y + 20);
    doc.setFontSize(8.5);
    doc.text(subtitle, M, y + 35);
    y += 66;
  };

  const list = (items: ReportRow["violations"]) => {
    items.forEach((v, vi) => {
      if (y > bottom) { doc.addPage(); y = 60; }
      doc.setFont("courier", "normal");
      doc.setFontSize(9);
      doc.setTextColor(40, 40, 40);
      const stamp = v.offset_seconds != null ? ` @ ${fmtReportClock(v.offset_seconds)}` : "";
      const detailLines = doc.splitTextToSize(`${vi + 1}. ${v.description || v.type}${stamp}`, CW - 32) as string[];
      for (const line of detailLines) {
        if (y > bottom) { doc.addPage(); y = 60; }
        doc.text(line, M + 16, y);
        y += 12;
      }
      doc.setFontSize(7.5);
      doc.setTextColor(130, 130, 130);
      doc.text(`${v.type} · ${v.severity} · ${new Date(v.created_at).toLocaleString()}`, M + 16, y);
      y += 16;
    });
  };

  if (flagged.length > 0) {
    section("Violation Detail", `${flagged.length} candidate(s) with proctoring violations — review each recording before finalising marks.`, [155, 28, 28]);
    for (const r of flagged) {
      if (y > bottom) { doc.addPage(); y = 60; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(155, 28, 28);
      doc.text(`${r.name} (${r.roll})`, M, y);
      y += 14;
      list(aiOf(r));
      y += 8;
    }
  }

  const withActions = rows.filter((r) => actionsOf(r).length > 0);
  if (withActions.length > 0) {
    section("Proctor Actions", "Warnings, pauses, escalations and submissions by the invigilator. Not counted as candidate violations.", [70, 70, 64]);
    for (const r of withActions) {
      if (y > bottom) { doc.addPage(); y = 60; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor(50, 50, 50);
      doc.text(`${r.name} (${r.roll})`, M, y);
      y += 14;
      list(actionsOf(r));
      y += 8;
    }
  }

  // Every export embeds the full per-second snapshot timeline and the audio
  // inventory. The timeline always starts on its own page so page 1 holds the
  // summary and violations.
  {
    let index = 0;
    for (const r of rows) {
      index += 1;
      opts.onProgress?.(`Building PDF · ${r.name} · every snapshot and the audio (${index} of ${rows.length})`);
      try {
        await drawSnapshotTimeline(doc, r, examId);
        await drawAudioInventory(doc, r, examId);
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
  opts.onProgress?.("Saving the PDF…");
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
