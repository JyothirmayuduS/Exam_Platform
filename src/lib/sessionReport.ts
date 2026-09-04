// Session report exports (teacher + proctor side).
//
// Generates the PDF and CSV client-side with jsPDF from the live roster +
// violation events already loaded from the DB — no server round trip, no HTML
// masquerading as a PDF.

import { jsPDF } from "jspdf";

export type ReportRow = {
  name: string;
  roll: string;
  state: string;
  progress: number;
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

export function downloadSessionReportPdf(
  examName: string,
  examId: string,
  rows: ReportRow[],
  generatedAt = new Date(),
): void {
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
