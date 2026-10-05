import { useState, useEffect, useMemo } from "react";
import { PageHeading, Button, Metric } from "@/features/teacher/components/PageChrome";
import useLiveAttempts from "@/features/teacher/hooks/useLiveAttempts";
import { listExamsForTeacher, listLiveAttempts, updateExam, type ExamRecord } from "@/shared/data/examApi";
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
  const [activeTab, setActiveTab] = useState("Overview");
  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [examId, setExamId] = useState<string>("");
  const [busy, setBusy] = useState(false);
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
  const settings = (selectedExam?.settings ?? {}) as Record<string, unknown>;
  const resultsPublished = settings.results_published === true;
  const answerKeyPublished = settings.answer_key_published === true;

  // Real stats from scored attempts of the selected exam.
  const scores = liveAttempts
    .filter((a): a is typeof a & { score: number } => typeof a.score === "number")
    .map((a) => a.score)
    .sort((x, y) => x - y);
  const mean = scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
  const median = scores.length ? (scores.length % 2 ? scores[Math.floor(scores.length / 2)] : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2) : null;
  const stdDev = scores.length > 1 && mean != null ? Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length) : null;
  const highest = scores.length ? scores[scores.length - 1] : null;
  const flagged = liveAttempts.filter((a) => a.flags.length > 0);
  const submitted = liveAttempts.filter((a) => a.state === "Submitted");

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
  const releaseResults = async () => {
    if (!examId) return;
    setBusy(true);
    const ok = await updateExam(examId, { settings: { results_published: true } });
    setBusy(false);
    notify(ok ? "Results released to students" : "Could not release results — database unavailable");
  };
  const publishAnswerKey = async () => {
    if (!examId) return;
    setBusy(true);
    const ok = await updateExam(examId, { settings: { answer_key_published: true } });
    setBusy(false);
    notify(ok ? "Answer key published to students" : "Could not publish answer key — database unavailable");
  };

  // Score distribution buckets (0-100 in steps of 10).
  const buckets = useMemo(() => {
    const out = Array.from({ length: 10 }, () => 0);
    for (const s of scores) {
      const idx = Math.min(9, Math.max(0, Math.floor(s / 10)));
      out[idx] += 1;
    }
    return out;
  }, [scores]);
  const maxBucket = Math.max(1, ...buckets);

  return (
    <>
      <JobBanner label={pdfProgress ?? (zipping ? zipStep ?? "Packing evidence ZIP…" : null)} />
      <PageHeading eyebrow="Reports" title="Performance reports" detail="Live stats, exports, and result publishing — straight from the database." action={
        <div className="flex flex-wrap items-center gap-2">
          <select value={examId} onChange={(e) => setExamId(e.target.value)} className="border border-line bg-paper px-2 py-2.5 font-mono text-[10px] uppercase tracking-wider text-soft">
            {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            {exams.length === 0 && <option value="">No exams yet — create one first</option>}
          </select>
          <Button onClick={() => void releaseResults()}>{busy ? "Releasing…" : resultsPublished ? "✓ Results Released" : "Release Results"}</Button>
          <Button onClick={() => void publishAnswerKey()}>{answerKeyPublished ? "✓ Answer Key Published" : "Publish Answer Key"}</Button>
          <Button onClick={() => void exportPdf()} disabled={!!pdfProgress}>{pdfProgress ? "Exporting…" : "Export PDF"}</Button>
          <Button onClick={exportCsv}>Export CSV</Button>
        </div>
      } />
      {pdfProgress && <p role="status" className="sr-only">{pdfProgress}</p>}
      <div className="mt-8 flex gap-2 border-b border-line pb-3 font-mono text-[10px] uppercase tracking-wider text-soft">
        {["Overview", "Item Analysis", "Student Reports", "Trends"].map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} className={`px-3 py-1.5 hover:text-ink ${activeTab === tab ? "border-b-2 border-forest text-forest pb-3 -mb-[14px]" : ""}`}>{tab}</button>
        ))}
      </div>

      {activeTab === "Overview" && (
        <>
          <div className="mt-8 grid gap-4 sm:grid-cols-4">
            <Metric label="Average (Mean)" value={mean != null ? `${mean.toFixed(1)}%` : "—"} detail={`Across ${scores.length} scored attempt(s)`} tone="text-ink"/>
            <Metric label="Median Score" value={median != null ? `${median.toFixed(1)}%` : "—"} detail={scores.length ? "Middle of the pack" : "No scores yet"} tone="text-forest"/>
            <Metric label="Standard Dev" value={stdDev != null ? `${stdDev.toFixed(1)}%` : "—"} detail="Score spread" tone="text-amber"/>
            <Metric label="Highest Score" value={highest != null ? `${highest.toFixed(1)}%` : "—"} detail={submitted.length ? `${submitted.length} submitted` : "No submissions"} tone="text-success"/>
          </div>
          <div className="mt-8 border border-line p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-xl font-semibold">Score Distribution</h2>
              <span className="font-mono text-[10px] text-soft">{scores.length} scored attempt(s)</span>
            </div>
            <div className="mt-8 flex h-44 items-end gap-3 border-b border-line px-4">
              {buckets.map((count, i) => (
                <div key={i} className="group flex flex-1 flex-col items-center gap-2">
                  <span className="font-mono text-[9px] text-soft">{count || ""}</span>
                  <div className="w-full bg-forest/40 transition-colors group-hover:bg-forest/80" style={{ height: `${Math.round((count / maxBucket) * 100)}%` }}/>
                  <span className="font-mono text-[9px] text-soft">{i * 10}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-center font-mono text-[10px] text-soft uppercase tracking-widest">Score Brackets (%)</p>
          </div>
          {flagged.length > 0 && <div className="mt-6 border border-alert/30 bg-alert/5 p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-alert">Proctoring flags</p><p className="mt-2 text-[13px]">{flagged.length} candidate(s) carry violation flags in this exam — review recordings before finalising marks.</p></div>}
        </>
      )}

      {activeTab === "Item Analysis" && <QuestionItemAnalysis examId={examId} />}

      {activeTab === "Student Reports" && (
        <div className="mt-8 border border-line bg-paper">
          <div className="flex items-center justify-between border-b border-line bg-raised px-5 py-3">
            <div><h2 className="font-serif text-lg font-semibold">Individual Student Reports</h2>
            <p className="mt-1 font-mono text-[10px] text-soft">Per-candidate PDFs plus a ZIP of every student's recordings (recording/) and screenshots (ss/).</p></div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void exportZip()} disabled={submitted.length === 0 || zipping}>{zipping ? "Zipping…" : "Download Evidence ZIP"}</Button>
              <Button onClick={() => void exportPdf(submitted)} disabled={submitted.length === 0 || !!pdfProgress}>Generate All PDFs</Button>
            </div>
          </div>
          <div className="divide-y divide-line">
            {submitted.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <div><p className="text-[13px] font-medium">{a.name}</p><p className="mt-0.5 font-mono text-[10px] text-soft">{a.roll} · {a.answered}/{a.total} answered · score {a.score != null ? `${a.score}%` : "pending"}</p></div>
                <Button onClick={() => void exportPdf([a])} disabled={!!pdfProgress}>PDF</Button>
              </div>
            ))}
            {submitted.length === 0 && <p className="px-5 py-10 text-center text-[12px] text-soft">No submissions for this exam yet.</p>}
          </div>
        </div>
      )}

      {activeTab === "Trends" && <ExamTrends exams={exams} />}
    </>
  );
}

function QuestionItemAnalysis({ examId }: { examId: string }) {
  const [questions, setQuestions] = useState<{ id: string; title: string; type: string; unit: string | null; difficulty: string | null; marks: number }[]>([]);
  useEffect(() => {
    let active = true;
    if (!examId) return;
    import("@/shared/data/examApi").then(({ loadExamBundle }) => {
      loadExamBundle(examId).then((bundle) => { if (active && bundle.questions) setQuestions(bundle.questions as typeof questions); });
    });
    return () => { active = false; };
  }, [examId]);
  return (
    <div className="mt-8 border border-line bg-paper">
      <div className="border-b border-line bg-raised px-5 py-3">
        <h2 className="font-serif text-lg font-semibold">Question pool · Item Analysis</h2>
        <p className="mt-1 font-mono text-[10px] text-soft">Real question pool for this exam — {questions.length} question(s).</p>
      </div>
      {questions.length === 0 ? (
        <div className="p-10 text-center"><p className="font-serif text-lg">No questions in this exam's pool</p><p className="mt-2 text-[12px] text-soft">Add questions from My questions or the paper builder, then come back for item stats.</p></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-[13px]">
            <thead><tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-soft"><th className="px-5 py-3">ID</th><th className="px-5 py-3">Question</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Unit</th><th className="px-5 py-3">Difficulty</th><th className="px-5 py-3">Marks</th></tr></thead>
            <tbody>
              {questions.map((q) => (
                <tr key={q.id} className="border-b border-line last:border-0 hover:bg-raised">
                  <td className="px-5 py-3 font-mono text-[11px] text-soft">{q.id}</td>
                  <td className="max-w-[320px] truncate px-5 py-3">{q.title}</td>
                  <td className="px-5 py-3">{q.type}</td>
                  <td className="px-5 py-3 text-soft">{q.unit ?? "—"}</td>
                  <td className="px-5 py-3">{q.difficulty ?? "—"}</td>
                  <td className="px-5 py-3">{q.marks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
