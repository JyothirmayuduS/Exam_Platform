import { useMemo, useState } from "react";
import { Button } from "@/features/teacher/components/PageChrome";
import type { ExamRecord } from "@/shared/data/examApi";
import { exportResults, type ExportFormat, type ExportScope, type ExportSummary } from "@/shared/data/api/resultsExport";

type ExportableExam = Pick<ExamRecord, "id" | "name" | "settings">;

const erp = (e: ExportableExam) => {
  const s = (e.settings ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  return { programme: str(s.programme), semester: str(s.semester), courseCode: str(s.courseCode) };
};

/** Download released results in the ERP's CSV / Excel layout, for one exam or
 *  for a whole programme and semester. */
export default function ErpExportPanel({ exams, selectedExam, notify }: { exams: ExportableExam[]; selectedExam: ExportableExam | undefined; notify: (m: string) => void }) {
  const [mode, setMode] = useState<"exam" | "programme">("exam");
  const groups = useMemo(() => {
    const m = new Map<string, { programme: string; semester: string; count: number }>();
    for (const e of exams) {
      const { programme, semester } = erp(e);
      if (!programme || !semester) continue;
      const key = `${programme.toLowerCase()}|${semester.toLowerCase()}`;
      const g = m.get(key) ?? { programme, semester, count: 0 };
      g.count += 1;
      m.set(key, g);
    }
    return [...m.entries()].sort((a, b) => a[1].programme.localeCompare(b[1].programme) || a[1].semester.localeCompare(b[1].semester, "en", { numeric: true }));
  }, [exams]);
  const [groupKey, setGroupKey] = useState("");
  const group = groups.find(([k]) => k === groupKey)?.[1] ?? groups[0]?.[1];
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [last, setLast] = useState<{ filename: string; summary: ExportSummary } | null>(null);

  const examErp = selectedExam ? erp(selectedExam) : null;
  const scope: ExportScope | null = mode === "exam"
    ? (selectedExam ? { scope: "exam", examId: selectedExam.id } : null)
    : (group ? { scope: "programme", programme: group.programme, semester: group.semester } : null);

  const run = async (format: ExportFormat) => {
    if (!scope || busy) return;
    setBusy(format);
    const res = await exportResults(scope, format);
    setBusy(null);
    if (!res.ok) { notify(res.error); return; }
    setLast({ filename: res.filename, summary: res.summary });
    notify(`Downloaded ${res.filename} · ${res.summary.rows} student row(s)`);
  };

  return (
    <div className="mt-6 border border-line bg-paper p-6">
      <h2 className="font-serif text-xl font-semibold">Export results for the ERP</h2>
      <p className="mt-1 max-w-2xl text-[12.5px] text-soft">
        One row per student with marks and result. Only released results are included; students who did not submit are listed as absent, and results you withheld for malpractice review are listed as withheld, without marks. Every export is recorded in the audit log.
      </p>

      <div className="mt-5 flex gap-1 font-mono text-[10px] uppercase tracking-wider" role="radiogroup" aria-label="Export scope">
        {([["exam", "This exam"], ["programme", "Programme & semester"]] as const).map(([v, label]) => (
          <button key={v} role="radio" aria-checked={mode === v} onClick={() => setMode(v)} className={`border px-3 py-2 ${mode === v ? "border-forest bg-success/5 text-forest" : "border-line text-soft hover:text-ink"}`}>{label}</button>
        ))}
      </div>

      {mode === "exam" ? (
        <div className="mt-4 text-[13px]">
          {selectedExam ? (
            <>
              <p><span className="font-medium">{selectedExam.name}</span> <span className="font-mono text-[11px] text-soft">{selectedExam.id}</span></p>
              <p className="mt-1 text-[12px] text-soft">
                {examErp?.courseCode || examErp?.programme || examErp?.semester
                  ? `Course ${examErp.courseCode || "—"} · ${examErp.programme || "no programme"} · semester ${examErp.semester || "—"}`
                  : "Course code, programme and semester are not set. Add them in the exam builder under Test options → Results & ERP so the ERP can match the rows."}
              </p>
            </>
          ) : <p className="text-soft">Pick an exam at the top of the page.</p>}
        </div>
      ) : (
        <div className="mt-4">
          {groups.length === 0 ? (
            <p className="text-[12.5px] text-soft">No exam has a programme and semester yet. Set them in the exam builder under Test options → Results & ERP.</p>
          ) : (
            <label className="block max-w-sm text-[12px] text-soft">Programme and semester
              <select value={groupKey || groups[0][0]} onChange={(e) => setGroupKey(e.target.value)} className="mt-1 block w-full border border-line bg-paper px-3 py-2.5 text-[13px] text-ink">
                {groups.map(([k, g]) => <option key={k} value={k}>{g.programme} · Semester {g.semester} ({g.count} exam{g.count === 1 ? "" : "s"})</option>)}
              </select>
              <span className="mt-1.5 block text-[11px]">Teachers get their own exams in this group; admins get every exam.</span>
            </label>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <Button primary onClick={() => void run("xlsx")} disabled={!scope || !!busy}>{busy === "xlsx" ? "Preparing…" : "Download Excel"}</Button>
        <Button onClick={() => void run("csv")} disabled={!scope || !!busy}>{busy === "csv" ? "Preparing…" : "Download CSV"}</Button>
      </div>

      {last && (
        <div className="mt-5 border-l-2 border-forest bg-raised px-4 py-3 text-[12.5px]">
          <p className="font-medium">{last.filename}</p>
          <p className="mt-1 text-soft">
            {last.summary.rows} row(s) · {last.summary.absent} absent · {last.summary.withheld} withheld
            {last.summary.pending > 0 && ` · ${last.summary.pending} left out (paper not graded yet, or exam still open)`}
          </p>
          {last.summary.skipped.length > 0 && (
            <p className="mt-1 text-soft">Not included, results not released: {last.summary.skipped.map((s) => s.name).join(", ")}</p>
          )}
        </div>
      )}
    </div>
  );
}
