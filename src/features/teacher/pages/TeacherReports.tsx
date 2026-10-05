import { useState, useEffect, useMemo } from "react";
import { PageHeading, Button, Metric } from "@/features/teacher/components/PageChrome";
import useLiveAttempts from "@/features/teacher/hooks/useLiveAttempts";
import { useQuery } from "@tanstack/react-query";
import { listExamsForTeacher, listLiveAttempts, loadExamBundle, type ExamRecord } from "@/shared/data/examApi";
import { examClosed, visibilityFor, type ReleaseSettings } from "@/shared/domain/exam";
import ResultReleasePanel from "@/features/teacher/components/ResultReleasePanel";
import { PASS_PERCENT, buildExamReport, type ItemRow } from "@/features/teacher/services/reportStats";
import JobBanner from "@/shared/components/JobBanner";
import {
  downloadSessionReportPdf,
  downloadCsv,
  reportProgress,
  reportViolationsFromFlags,
  type ReportRow,
} from "@/shared/services/sessionReport";
import { downloadExamEvidenceZip } from "@/shared/services/zipExport";

export function Reports({ notify }: { notify: (s: string) => void }) {
  const [activeTab, setActiveTab] = useState<Tab>("Overview");
  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [examId, setExamId] = useState<string>("");
  const { data: liveAttempts = [] } = useLiveAttempts(examId || "");

  useEffect(() => {
    let active = true;
    void listExamsForTeacher().then((list) => {
      if (!active) return;
      setExams(list);
      if (!examId && list.length) setExamId(list[0].id);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedExam = exams.find((e) => e.id === examId);
  const { data: pool = [] } = useQuery({
    queryKey: ["examPool", examId],
    queryFn: async () => (await loadExamBundle(examId)).questions,
    enabled: !!examId,
  });
  const report = useMemo(() => buildExamReport(liveAttempts, pool), [liveAttempts, pool]);
  const flagged = liveAttempts.filter((a) => a.flags.length > 0);
  const submitted = liveAttempts.filter((a) => a.state === "Submitted");
  const releaseState = releaseSummary(selectedExam);

  const toReportRow = (a: (typeof liveAttempts)[number]): ReportRow => ({
    name: a.name,
    roll: a.roll,
    state: a.state,
    progress: reportProgress(a),
    startedAt: a.startedAtIso ?? null,
    violations: reportViolationsFromFlags(a.flags),
  });
  const [pdfProgress, setPdfProgress] = useState<string | null>(null);
  const exportPdf = async (candidates?: typeof liveAttempts) => {
    if (pdfProgress) return;
    const jobs = candidates ? candidates.map((a) => ({ id: `${examId}-${a.roll}`, rows: [toReportRow(a)] }))
      : [{ id: examId || "all", rows: liveAttempts.map(toReportRow) }];
    try {
      // One PDF at a time: long-exam images must not be loaded for every
      // student concurrently. No sampling or frame limits in either path.
      for (let i = 0; i < jobs.length; i++) {
        setPdfProgress(`Preparing PDF ${i + 1} of ${jobs.length}…`);
        await downloadSessionReportPdf(selectedExam?.name ?? "Exam", jobs[i].id, jobs[i].rows, new Date(), {
          onProgress: (message) => setPdfProgress(`PDF ${i + 1} of ${jobs.length} · ${message}`),
        });
      }
      notify("PDF downloaded");
    } catch (err) {
      console.error("[Reports] PDF export failed:", err);
      notify("PDF export failed. Please retry a single student's report.");
    } finally { setPdfProgress(null); }
  };
  const exportCsv = () => {
    downloadCsv(
      `results_${examId || "all"}`,
      ["Candidate", "Roll", "State", "Answered", "Total", "Score", "Flags"],
      liveAttempts.map((a) => [a.name, a.roll, a.state, a.answered, a.total, a.score ?? "", a.flags.length]),
    );
    notify(`Results CSV exported · ${liveAttempts.length} rows`);
  };
  const [zipping, setZipping] = useState(false);
  const [zipStep, setZipStep] = useState<string | null>(null);
  const exportZip = async () => {
    if (!examId || submitted.length === 0 || zipping) return;
    setZipping(true);
    try {
      const res = await downloadExamEvidenceZip({
        onProgress: setZipStep,
        examId,
        examName: selectedExam?.name ?? null,
        students: submitted.map((a) => ({ roll: a.roll, name: a.name })),
      });
      if (res.fileCount === 0) {
        notify("No recordings or screenshots found in storage for this exam.");
      } else if (res.errors.length > 0) {
        notify(`ZIP downloaded · ${res.fileCount} file(s) for ${res.studentCount} student(s) · ${res.errors.length} item(s) failed`);
      } else {
        notify(`ZIP downloaded · ${res.fileCount} file(s) for ${res.studentCount} student(s)`);
      }
    } catch (err) {
      console.error("[Reports] evidence ZIP export failed:", err);
      notify("ZIP export failed — storage may be unavailable.");
    } finally {
      setZipStep(null);
      setZipping(false);
    }
  };
  const pct = (v: number | null) => (v != null ? `${v.toFixed(1)}%` : "—");
  const maxBucket = Math.max(1, ...report.buckets);

  return (
    <>
      <JobBanner label={pdfProgress ?? (zipping ? zipStep ?? "Packing evidence ZIP…" : null)} />
      <PageHeading eyebrow="Reports" title="Performance reports" detail="Scores, question analysis and result release for one exam at a time." action={
        <div className="flex flex-wrap items-center gap-2">
          <select value={examId} onChange={(e) => setExamId(e.target.value)} aria-label="Exam" className="max-w-[260px] border border-line bg-paper px-2 py-2.5 font-mono text-[10px] uppercase tracking-wider text-soft">
            {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            {exams.length === 0 && <option value="">No exams yet — create one first</option>}
          </select>
          <Button onClick={() => void exportPdf()} disabled={!!pdfProgress || !examId}>{pdfProgress ? "Exporting…" : "Export PDF"}</Button>
          <Button onClick={exportCsv} disabled={!examId}>Export CSV</Button>
        </div>
      } />
      {pdfProgress && <p role="status" className="sr-only">{pdfProgress}</p>}

      {selectedExam && (
        <button onClick={() => setActiveTab("Release")} className="mt-6 flex w-full flex-wrap items-center justify-between gap-2 border border-line bg-raised px-4 py-3 text-left text-[12.5px] transition hover:border-forest">
          <span><span className="font-medium">Students currently see: </span>{releaseState}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-forest">Manage release →</span>
        </button>
      )}

      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-line font-mono text-[10px] uppercase tracking-wider text-soft" role="tablist">
        {TABS.map((tab) => (
          <button key={tab} role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)} className={`-mb-px shrink-0 border-b-2 px-3 py-2.5 hover:text-ink ${activeTab === tab ? "border-forest text-forest" : "border-transparent"}`}>{tab}</button>
        ))}
      </div>

      {activeTab === "Overview" && (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Submitted" value={String(report.submitted)} detail={`${report.graded} graded · ${Math.max(0, report.submitted - report.graded)} awaiting marks`} tone="text-ink" />
            <Metric label="Average" value={pct(report.mean)} detail={report.median != null ? `Median ${pct(report.median)}` : "No graded papers yet"} tone="text-forest" />
            <Metric label="Pass rate" value={pct(report.passRate)} detail={`Scoring ${PASS_PERCENT}% or more`} tone={report.passRate != null && report.passRate < 50 ? "text-alert" : "text-success"} />
            <Metric label="Range" value={report.highest != null ? `${report.lowest!.toFixed(0)}–${report.highest.toFixed(0)}%` : "—"} detail="Lowest to highest" tone="text-ink" />
          </div>

          <div className="mt-6 border border-line bg-paper p-6">
            <div className="flex items-baseline justify-between">
              <h2 className="font-serif text-xl font-semibold">Score distribution</h2>
              <span className="font-mono text-[10px] text-soft">{report.graded} graded paper(s) · % of each student's paper total</span>
            </div>
            {report.graded === 0 ? (
              <p className="py-12 text-center text-[12.5px] text-soft">The distribution appears once papers are graded in Evaluate.</p>
            ) : (
              <div className="mt-6 flex h-48 items-end gap-2 border-b border-line">
                {report.buckets.map((count, i) => (
                  <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5" title={`${count} student(s) scored ${i * 10}–${i === 9 ? 100 : i * 10 + 9}%`}>
                    <span className="font-mono text-[10px] tabular-nums text-soft">{count || ""}</span>
                    <div className={`w-full ${i * 10 < PASS_PERCENT ? "bg-alert/50" : "bg-forest/70"}`} style={{ height: `${(count / maxBucket) * 82}%`, minHeight: count ? 2 : 0 }} />
                  </div>
                ))}
              </div>
            )}
            {report.graded > 0 && (
              <div className="mt-2 flex gap-2">
                {report.buckets.map((_, i) => <span key={i} className="flex-1 text-center font-mono text-[9px] tabular-nums text-soft">{i * 10}</span>)}
              </div>
            )}
          </div>

          {flagged.length > 0 && (
            <div className="mt-6 border-l-2 border-alert bg-alert/5 px-5 py-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-alert">Proctoring flags</p>
              <p className="mt-1.5 text-[13px]">{flagged.length} candidate(s) have violation flags. Review their recordings before releasing results.</p>
            </div>
          )}
        </>
      )}

      {activeTab === "Questions" && <QuestionItemAnalysis items={report.items} submitted={report.submitted} />}

      {activeTab === "Students" && (
        <div className="mt-6 border border-line bg-paper">
          <div className="flex flex-col justify-between gap-3 border-b border-line bg-raised px-5 py-3 sm:flex-row sm:items-center">
            <div>
              <h2 className="font-serif text-lg font-semibold">Students</h2>
              <p className="mt-0.5 text-[12px] text-soft">Ranked by percentage. PDF reports include proctoring evidence.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void exportZip()} disabled={submitted.length === 0 || zipping}>{zipping ? "Zipping…" : "Evidence ZIP"}</Button>
              <Button onClick={() => void exportPdf(submitted)} disabled={submitted.length === 0 || !!pdfProgress}>All PDFs</Button>
            </div>
          </div>
          {report.rows.length === 0 ? (
            <p className="px-5 py-12 text-center text-[12.5px] text-soft">No submissions for this exam yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-soft">
                    <th className="px-5 py-3 w-12">#</th><th className="px-3 py-3">Student</th><th className="px-3 py-3">Answered</th>
                    <th className="px-3 py-3 text-right">Marks</th><th className="px-3 py-3 text-right">Percent</th><th className="px-3 py-3">Result</th><th className="px-3 py-3">Flags</th><th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r, i) => (
                    <tr key={r.id} className="border-b border-line last:border-0 hover:bg-raised">
                      <td className="px-5 py-3 font-mono text-[11px] tabular-nums text-soft">{r.pct != null ? i + 1 : "—"}</td>
                      <td className="px-3 py-3"><p className="font-medium">{r.name}</p><p className="font-mono text-[10px] text-soft">{r.roll}</p></td>
                      <td className="px-3 py-3 tabular-nums text-soft">{r.answered}/{r.total}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{r.score != null ? `${r.score} / ${r.max}` : "—"}</td>
                      <td className="px-3 py-3 text-right font-medium tabular-nums">{pct(r.pct)}</td>
                      <td className="px-3 py-3">
                        {r.passed == null ? <span className="font-mono text-[10px] uppercase tracking-wider text-amber">Not graded</span>
                          : <span className={`font-mono text-[10px] uppercase tracking-wider ${r.passed ? "text-success" : "text-alert"}`}>{r.passed ? "Pass" : "Below pass"}</span>}
                      </td>
                      <td className={`px-3 py-3 tabular-nums ${r.flags ? "text-alert" : "text-soft"}`}>{r.flags || "—"}</td>
                      <td className="px-5 py-3 text-right">
                        <Button onClick={() => { const a = submitted.find((s) => s.id === r.id); if (a) void exportPdf([a]); }} disabled={!!pdfProgress}>PDF</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "Release" && selectedExam && (
        <div className="mt-6">
          <ResultReleasePanel
            exam={selectedExam}
            submitted={report.submitted}
            graded={report.graded}
            notify={notify}
            onSaved={(next) => setExams((list) => list.map((e) => (e.id === selectedExam.id ? { ...e, settings: next } : e)))}
          />
        </div>
      )}

      {activeTab === "Across exams" && <ExamTrends exams={exams} />}
    </>
  );
}

const TABS = ["Overview", "Questions", "Students", "Release", "Across exams"] as const;
type Tab = (typeof TABS)[number];

function releaseSummary(exam: ExamRecord | undefined): string {
  if (!exam) return "";
  const v = visibilityFor((exam.settings ?? {}) as ReleaseSettings, { examClosed: examClosed(exam), graded: true });
  if (v.answerKey) return "their score and the answer key.";
  if (v.score) return "their score (answer key hidden).";
  return "nothing yet — results and answer key are hidden.";
}

function QuestionItemAnalysis({ items, submitted }: { items: ItemRow[]; submitted: number }) {
  if (items.length === 0) {
    return <div className="mt-6 border border-line bg-paper p-10 text-center"><p className="font-serif text-lg">No questions in this exam</p><p className="mt-2 text-[12px] text-soft">Add questions in the paper builder, then come back for question stats.</p></div>;
  }
  return (
    <div className="mt-6 border border-line bg-paper">
      <div className="border-b border-line bg-raised px-5 py-3">
        <h2 className="font-serif text-lg font-semibold">Question analysis</h2>
        <p className="mt-0.5 text-[12px] text-soft">From {submitted} submitted paper(s). Questions answered correctly by under 40% are marked difficult — check the key and wording.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-soft">
              <th className="px-5 py-3 w-12">Q</th><th className="px-3 py-3">Question</th><th className="px-3 py-3">Type</th><th className="px-3 py-3 text-right">Marks</th>
              <th className="px-3 py-3 text-right">Attempted</th><th className="px-3 py-3 w-56">Correct</th>
            </tr>
          </thead>
          <tbody>
            {items.map((q) => (
              <tr key={q.id} className="border-b border-line last:border-0 hover:bg-raised">
                <td className="px-5 py-3 font-mono text-[11px] tabular-nums text-soft">{q.no}</td>
                <td className="max-w-[360px] truncate px-3 py-3" title={q.title}>{q.title}</td>
                <td className="px-3 py-3 text-soft">{q.kindLabel}</td>
                <td className="px-3 py-3 text-right tabular-nums">{q.marks}</td>
                <td className="px-3 py-3 text-right tabular-nums text-soft">{q.served ? `${q.attempted}/${q.served}` : "—"}</td>
                <td className="px-3 py-3">
                  {q.pctCorrect == null ? (
                    <span className="text-[12px] text-soft">{q.correct == null ? "Graded by hand" : "No responses yet"}</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 bg-line"><div className={`h-full ${q.pctCorrect < 40 ? "bg-alert" : "bg-forest"}`} style={{ width: `${q.pctCorrect}%` }} /></div>
                      <span className={`w-12 text-right font-mono text-[11px] tabular-nums ${q.pctCorrect < 40 ? "text-alert" : ""}`}>{q.pctCorrect.toFixed(0)}%</span>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExamTrends({ exams }: { exams: ExamRecord[] }) {
  const [stats, setStats] = useState<{ id: string; name: string; total: number; submitted: number }[]>([]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const rows = await Promise.all(exams.slice(0, 8).map(async (e) => {
        const attempts = await listLiveAttempts(e.id);
        return { id: e.id, name: e.name, total: attempts.length, submitted: attempts.filter((a) => a.state === "submitted").length };
      }));
      if (active) setStats(rows);
    };
    void load();
    return () => { active = false; };
  }, [exams]);
  if (stats.length === 0) return <div className="mt-8 border border-line bg-paper p-10 text-center"><p className="font-serif text-lg">No exam data yet</p><p className="mt-2 text-[12px] text-soft">Submission trends appear here once candidates start attempting your exams.</p></div>;
  const maxTotal = Math.max(1, ...stats.map((s) => s.total));
  return (
    <div className="mt-8 border border-line bg-paper p-6">
      <h2 className="font-serif text-lg font-semibold">Submission trends by exam</h2>
      <p className="mt-1 font-mono text-[10px] text-soft">Live attempt counts per exam.</p>
      <div className="mt-6 space-y-4">
        {stats.map((s) => (
          <div key={s.id} className="flex items-center gap-4">
            <span className="w-56 truncate text-[13px]">{s.name}</span>
            <div className="h-3 flex-1 bg-line"><div className="h-full bg-forest" style={{ width: `${Math.round((s.total / maxTotal) * 100)}%` }} /></div>
            <span className="w-28 shrink-0 text-right font-mono text-[10px] text-soft">{s.submitted}/{s.total} submitted</span>
          </div>
        ))}
      </div>
    </div>
  );
}
