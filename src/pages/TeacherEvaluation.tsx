import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { loadExamBundle, updateAttemptScore, listAttemptViolations, getAttemptExamId, saveViolation, addGradingComment, listGradingComments, listFaculty, assignGradingDelegates, type ViolationEvent, type GradingComment } from "../lib/examApi";
import { type Attempt, type Flag } from "../data/examSession";
import { questionsForPaper, remapAnswer, type PaperSlot } from "../lib/paperBuilder";
import useLiveAttempts from "../hooks/useLiveAttempts";
import useCurrentProfile, { profileSubtitle } from "../hooks/useCurrentProfile";
import ProctorAI from "../components/ProctorAI";
import { RecordingReviewModal } from "../components/RecordingReview";
import { uploadArtifactBlob, getArtifactObjectUrl } from "../lib/examStorage";
import { getTeacherNav } from "./TeacherDashboard";
import { getSupabase } from "../lib/supabase";

type QType = "MCQ" | "MSQ" | "TrueFalse" | "Numerical" | "Subjective" | "Coding";
type RubricItem = { id: string; label: string; detail: string; marks: number };
type TestCase = { name: string; passed: boolean };
type Question = {
  id: string; no: number; type: QType; prompt: string; marks: number;
  options?: string[]; correct?: number; chosen?: number | null;
  correctSet?: number[]; chosenSet?: number[];
  expected?: string; response?: string; language?: string;
  tests?: TestCase[]; rubric?: RubricItem[];
};
type Status = "To grade" | "In review" | "Graded";
type Candidate = Attempt & { order: number; status: Status; paper: Question[]; awarded?: number };

const SUBJECTIVE_RUBRIC: RubricItem[] = [
  { id: "s1", label: "Explains starvation", detail: "Identifies why a low-priority process may wait indefinitely", marks: 4 },
  { id: "s2", label: "Explains prevention", detail: "Describes aging or an equivalent fairness mechanism", marks: 4 },
  { id: "s3", label: "Clarity & accuracy", detail: "Uses precise scheduling terminology", marks: 2 },
];
const DBMS_RUBRIC: RubricItem[] = [
  { id: "d1", label: "Defines the anomaly", detail: "Correctly explains the update / insert / delete anomaly", marks: 4 },
  { id: "d2", label: "Applies normalization", detail: "Shows decomposition to the correct normal form", marks: 4 },
  { id: "d3", label: "Clarity & accuracy", detail: "Uses precise relational terminology", marks: 2 },
];

const CODE_TESTS = ["Empty queue", "Single element", "FIFO ordering", "Interleaved enqueue / dequeue", "Large-input stress"];
function codingTests(passed: number): TestCase[] {
  return CODE_TESTS.map((name, i) => ({ name, passed: i < passed }));
}

// Build a gradeable paper for ONE attempt: its own question snapshot (falling
// back to the full pool for legacy attempts), with student answers re-mapped
// from the displayed option order back to the original order for grading.
function buildPaper(questions: any[], answers: Record<string, any>, paper?: unknown): Question[] {
  const slots: PaperSlot[] = Array.isArray(paper) ? (paper as PaperSlot[]) : [];
  const slotByQid = new Map(slots.map((s) => [s.id, s]));
  return questions.map((q, i) => {
    const qType: QType = q.type as QType;
    const slot = slotByQid.get(q.id);
    const raw = answers[q.id];
    const ans = remapAnswer(slot, q.options, raw);
    
    // Map DB question to UI question
    const base: any = {
      id: q.id,
      no: i + 1,
      type: qType,
      prompt: q.title,
      marks: q.marks,
      options: q.options || [],
    };
    
    if (qType === "MCQ" || qType === "TrueFalse") {
      base.correct = q.answer ? parseInt(q.answer) : 0;
      base.chosen = typeof ans === "number" ? ans : null;
    } else if (qType === "MSQ") {
      base.correctSet = q.answer ? JSON.parse(q.answer) : [];
      base.chosenSet = Array.isArray(ans) ? ans : [];
    } else if (qType === "Numerical") {
      base.expected = q.answer || "";
      base.response = typeof ans === "string" ? ans : "";
    } else if (qType === "Subjective") {
      base.response = typeof ans === "string" ? ans : "";
      // Mock rubric for now
      base.rubric = SUBJECTIVE_RUBRIC;
    } else if (qType === "Coding") {
      base.language = "python";
      base.response = typeof ans === "string" ? ans : "";
      base.tests = codingTests(0); // Mock tests for now
    }
    
    return base as Question;
  });
}

const key = (cid: string, qid: string, item?: string) => (item ? `${cid}:${qid}:${item}` : `${cid}:${qid}`);
const isAuto = (q: Question) => q.type !== "Subjective";
function setsEqual(a: number[] = [], b: number[] = []) {
  const x = [...a].sort((m, n) => m - n); const y = [...b].sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
function codingPassed(q: Question) { const t = q.tests ?? []; return { passed: t.filter((c) => c.passed).length, total: t.length }; }
function autoScore(q: Question): number {
  switch (q.type) {
    case "MCQ":
    case "TrueFalse": return q.chosen != null && q.chosen === q.correct ? q.marks : 0;
    case "MSQ": return setsEqual(q.chosenSet, q.correctSet) ? q.marks : 0;
    case "Numerical": return (q.response ?? "").trim().toLowerCase() === (q.expected ?? "").trim().toLowerCase() ? q.marks : 0;
    case "Coding": { const { passed, total } = codingPassed(q); return total ? Math.round((passed / total) * q.marks) : 0; }
    default: return 0;
  }
}
const typeLabel = (t: QType) => (t === "TrueFalse" ? "True / False" : t === "MSQ" ? "Multi-select" : t);
const paperMax = (p: Question[]) => p.reduce((t, q) => t + q.marks, 0);
function fmt(s: number) { const m = Math.floor(s / 60).toString().padStart(2, "0"); const sec = (s % 60).toString().padStart(2, "0"); return `${m}:${sec}`; }

export default function TeacherEvaluation({ notify }: { notify: (message: string) => void }) {
  const { profile } = useCurrentProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  // The exam whose submitted papers are graded. When a candidate is opened from
  // Submissions (?review=<attemptId>) the attempt's own exam is resolved, so a
  // linked paper always grades against the right pool and snapshot.
  const [examId, setExamId] = useState("EXAM-2026-014");
  useEffect(() => {
    const reviewId = searchParams.get("review");
    if (!reviewId) return;
    let alive = true;
    void getAttemptExamId(reviewId).then((resolved) => {
      if (alive && resolved) setExamId(resolved);
    });
    return () => { alive = false; };
  }, [searchParams]);

  const { data: liveAttempts = [] } = useLiveAttempts(examId);

  const liveAttemptsCount = liveAttempts.filter((a) => a.state !== "Submitted").length;
  const submittedAttemptsCount = liveAttempts.filter((a) => a.state === "Submitted").length;
  const nav = getTeacherNav(liveAttemptsCount, submittedAttemptsCount, 0);

  const { data: examBundle } = useQuery({
    queryKey: ["examBundle", examId],
    queryFn: () => loadExamBundle(examId),
  });

  const [roster, setRoster] = useState<Candidate[]>([]);
  
  useEffect(() => {
    if (!examBundle) return;
    const questions = examBundle.questions ?? [];
    
    // Merge live DB attempts with the mock paper content for evaluation
    const mapped: Candidate[] = liveAttempts
      .filter((a) => a.state === "Submitted") // We only grade submitted
      .map((a, i) => {
        // Grade the student's OWN paper: filter the pool to their snapshot.
        const paper = buildPaper(questionsForPaper(a.paper, questions), a.answers || {}, a.paper);
        return {
          ...a,
          order: i + 1,
          paper,
          status: a.score != null ? "Graded" : "To grade",
          awarded: a.score ?? undefined,
        };
      });
      
    // Apply review param
    const deepLink = searchParams.get("review");
    setRoster(mapped.map((c) => (c.id === deepLink && c.status === "To grade" ? { ...c, status: "In review" } : c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveAttempts, examBundle]);

  const [statusFilter, setStatusFilter] = useState<"All" | Status>("All");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [subject, setSubject] = useState("All exams");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("Submission time");
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [showBulkDelegateModal, setShowBulkDelegateModal] = useState(false);
  const [faculty, setFaculty] = useState<{ name: string; department: string | null; email: string | null }[]>([]);
  const [delegateName, setDelegateName] = useState("");
  useEffect(() => {
    let active = true;
    void listFaculty().then((rows) => { if (active) setFaculty(rows); });
    return () => { active = false; };
  }, []);
  const confirmDelegate = async () => {
    const n = await assignGradingDelegates(selectedCandidates, delegateName);
    setShowBulkDelegateModal(false);
    setSelectedCandidates([]);
    setDelegateName("");
    notify(n > 0 ? `Assigned ${delegateName} to ${n} candidate(s)` : "Could not assign — no valid attempts selected");
  };

  const subjects = useMemo(() => ["All exams", ...Array.from(new Set(roster.map((c) => c.exam)))], [roster]);

  const preSort = useMemo(() => roster.filter((c) => {
    if (flaggedOnly && c.flags.length === 0) return false;
    if (subject !== "All exams" && c.exam !== subject) return false;
    const q = search.trim().toLowerCase();
    return !q || `${c.name} ${c.roll}`.toLowerCase().includes(q);
  }), [roster, flaggedOnly, subject, search]);

  const counts = useMemo(() => ({
    All: preSort.length,
    "To grade": preSort.filter((c) => c.status === "To grade").length,
    "In review": preSort.filter((c) => c.status === "In review").length,
    Graded: preSort.filter((c) => c.status === "Graded").length,
  }), [preSort]);

  const visible = useMemo(() => {
    const list = [...preSort.filter((c) => statusFilter === "All" || c.status === statusFilter)];
    if (sort === "Name") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "Roll number") list.sort((a, b) => a.roll.localeCompare(b.roll));
    else if (sort === "Score") list.sort((a, b) => (b.awarded ?? -1) - (a.awarded ?? -1));
    else list.sort((a, b) => a.order - b.order);
    list.sort((a, b) => Number(b.flags.length > 0) - Number(a.flags.length > 0));
    return list;
  }, [preSort, statusFilter, sort]);

  const gradeQueue = useMemo(() => {
    const q = roster.filter((c) => c.status !== "Graded").sort((a, b) => a.order - b.order);
    q.sort((a, b) => Number(b.flags.length > 0) - Number(a.flags.length > 0));
    return q;
  }, [roster]);

  const total = roster.length;
  const gradedCount = roster.filter((c) => c.status === "Graded").length;
  const toGradeCount = roster.filter((c) => c.status === "To grade").length;
  const inReviewCount = roster.filter((c) => c.status === "In review").length;
  const flaggedCount = roster.filter((c) => c.flags.length > 0).length;
  const pct = total ? Math.round((gradedCount / total) * 100) : 0;

  const reviewId = searchParams.get("review");
  const active = reviewId ? roster.find((c) => c.id === reviewId) ?? null : null;
  const missingReview = Boolean(reviewId) && !active;

  const markInReview = (cid: string) =>
    setRoster((cur) => cur.map((c) => (c.id === cid && c.status === "To grade" ? { ...c, status: "In review" } : c)));
  const setReviewParam = (cid: string, replace: boolean) =>
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set("review", cid); return p; }, { replace });
  const openReview = (cid: string) => { markInReview(cid); setReviewParam(cid, false); };
  const navigateReview = (cid: string) => { markInReview(cid); setReviewParam(cid, true); };
  const closeReview = () =>
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.delete("review"); return p; }, { replace: true });
  const finalizeGrade = async (cid: string, awarded: number) => {
    await updateAttemptScore(cid, awarded);
    setRoster((cur) => cur.map((c) => (c.id === cid ? { ...c, status: "Graded", awarded } : c)));
  };

  const [visibility, setVisibility] = useState<"OFF" | "ON">("OFF");
  const [saving, setSaving] = useState(false);
  const handleSave = () => {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      notify("Evaluation saved");
    }, 1000);
  };

  const handleBulkGrade = async () => {
    setSaving(true);
    for (const cid of selectedCandidates) {
      const candidate = roster.find(c => c.id === cid);
      if (candidate) {
        const score = candidate.paper.reduce((s, q) => s + autoScore(q), 0);
        await updateAttemptScore(cid, score);
      }
    }
    setRoster((cur) => cur.map((c) => {
      if (!selectedCandidates.includes(c.id)) return c;
      const score = c.paper.reduce((s, q) => s + autoScore(q), 0);
      return { ...c, status: "Graded", awarded: score };
    }));
    setSaving(false);
    notify(`Bulk graded ${selectedCandidates.length} candidates`);
    setSelectedCandidates([]);
  };

  const handleExportCSV = () => {
    const header = "Candidate Name,Roll Number,Exam,Status,Score,Flags\n";
    const rows = selectedCandidates.map(cid => {
      const c = roster.find(x => x.id === cid);
      if (!c) return "";
      return `"${c.name}","${c.roll}","${c.exam}","${c.status}","${c.awarded ?? 0}","${c.flags.length}"`;
    }).join("\n");
    
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "candidates_export.csv";
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    
    notify(`Exported ${selectedCandidates.length} candidates to CSV`);
    setSelectedCandidates([]);
  };

  const [showGuide, setShowGuide] = useState(false);

  return <>
    <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty console / Evaluate</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold">Evaluate submitted papers</h1>
        <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Only submitted papers appear here — live attempts are tracked in Submissions. Objective and coding answers are scored automatically from the answer key; theory answers are reviewed by you. Every grading session is camera-monitored.</p>
      </div>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
        <div className="flex divide-x divide-line border border-line-strong bg-paper">
          <button onClick={() => setShowGuide(true)} className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:bg-paper-raised hover:text-ink">Grading guide</button>
        </div>
        <button disabled={saving} onClick={handleSave} className="border border-forest bg-forest px-6 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper transition-colors hover:bg-forest-light disabled:cursor-wait disabled:opacity-80">
          {saving ? "Saving..." : "Save progress"}
        </button>
      </div>
    </div>

    {missingReview && <section className="mt-6 flex flex-wrap items-center justify-between gap-3 border border-amber/40 bg-amber/5 px-5 py-4">
      <p className="text-[13px]">That attempt has no submitted paper yet, so there is nothing to grade. Track it in Submissions until the candidate submits.</p>
      <button onClick={closeReview} className="border border-amber px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-amber hover:bg-amber/10">Dismiss</button>
    </section>}

    <section className="mt-8 grid gap-5 border border-line bg-paper-raised p-5 lg:grid-cols-[1fr_auto] lg:items-end">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Grading progress</p>
        <div className="mt-3 flex items-end gap-4"><p className="font-serif text-4xl">{gradedCount} <span className="text-xl text-ink-soft">/ {total}</span></p><p className="pb-1 text-[12px] text-ink-soft">papers graded · {toGradeCount} waiting to grade</p></div>
        <div className="mt-4 h-2 max-w-2xl bg-line"><div className="h-full bg-forest" style={{ width: `${pct}%` }} /></div>
      </div>
      <div className="grid grid-cols-3 gap-px border border-line bg-line">
        <StatTile value={toGradeCount} label="To grade" tone="text-amber" />
        <StatTile value={inReviewCount} label="In review" tone="text-forest" />
        <StatTile value={flaggedCount} label="Flagged" tone="text-alert" />
      </div>
    </section>

    <section className="mt-6 border border-line bg-paper p-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["All", "To grade", "In review", "Graded"] as const).map((s) => <button key={s} onClick={() => setStatusFilter(s)} className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${statusFilter === s ? "border-forest bg-forest text-paper" : "border-line-strong text-ink-soft hover:border-forest hover:text-ink"}`}>{s} · {counts[s]}</button>)}
        <span className="mx-1 hidden h-6 w-px bg-line sm:block" />
        <button onClick={() => setFlaggedOnly((v) => !v)} className={`flex items-center gap-2 border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${flaggedOnly ? "border-alert bg-alert/5 text-alert" : "border-line-strong text-ink-soft hover:border-alert hover:text-alert"}`}><span className={`h-1.5 w-1.5 ${flaggedOnly ? "bg-alert" : "bg-ink-soft"}`} /> Flagged only</button>
        <span className="mx-1 hidden h-6 w-px bg-line sm:block" />
        <button onClick={() => setShowBulkDelegateModal(true)} className="border border-line-strong px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest transition-colors">Assign Delegate</button>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_190px_190px]">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search candidate name or roll number" className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest" />
        <label className="sr-only" htmlFor="subj">Exam</label>
        <select id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest">{subjects.map((s) => <option key={s}>{s}</option>)}</select>
        <label className="sr-only" htmlFor="sort">Sort by</label>
        <select id="sort" value={sort} onChange={(e) => setSort(e.target.value)} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest"><option>Submission time</option><option>Score</option><option>Roll number</option><option>Name</option></select>
      </div>
    </section>

    <section className="mt-6 border border-line bg-paper">
      <div className="flex items-center justify-between border-b border-line bg-paper-raised px-5 py-3 min-h-[48px]">
        {selectedCandidates.length > 0 ? (
          <div className="flex items-center gap-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-forest font-bold">{selectedCandidates.length} candidate{selectedCandidates.length > 1 ? "s" : ""} selected</p>
            <div className="flex gap-2">
              <button disabled={saving} onClick={handleBulkGrade} className="border border-forest bg-forest/5 px-3 py-1 font-mono text-[9px] uppercase tracking-wider text-forest hover:bg-forest hover:text-paper transition-colors disabled:opacity-50">Bulk Grade</button>
              <button disabled={saving} onClick={handleExportCSV} className="border border-line-strong bg-paper px-3 py-1 font-mono text-[9px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest transition-colors disabled:opacity-50">Export CSV</button>
            </div>
          </div>
        ) : (
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Submitted candidates</p>
        )}
        <span className="font-mono text-[10px] text-ink-soft">Showing {visible.length} of {total}{flaggedOnly ? " · flagged" : ""}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-[13px]">
          <thead><tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-ink-soft"><th className="px-5 py-3 w-10"><input type="checkbox" className="accent-forest w-3.5 h-3.5 cursor-pointer" checked={visible.length > 0 && selectedCandidates.length === visible.length} onChange={() => { if (visible.length > 0 && selectedCandidates.length === visible.length) { setSelectedCandidates([]); } else { setSelectedCandidates(visible.map(c => c.id)); } }} /></th><th className="px-5 py-3">Candidate</th><th className="px-5 py-3">Exam</th><th className="px-5 py-3">Submitted</th><th className="px-5 py-3">Paper</th><th className="px-5 py-3">Proctoring</th><th className="px-5 py-3">Status</th><th className="px-5 py-3" /></tr></thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id} className={`border-b border-line last:border-0 ${selectedCandidates.includes(c.id) ? "bg-forest/[0.03]" : c.flags.length ? "bg-alert/[0.03]" : "hover:bg-paper-raised"}`}>
                <td className="px-5 py-4"><input type="checkbox" className="accent-forest w-3.5 h-3.5 cursor-pointer" checked={selectedCandidates.includes(c.id)} onChange={() => setSelectedCandidates(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])} /></td>
                <td className="px-5 py-4"><button onClick={() => openReview(c.id)} className="text-left font-medium hover:text-forest hover:underline">{c.name}</button><p className="mt-0.5 font-mono text-[10px] text-ink-soft">{c.roll}</p></td>
                <td className="px-5 py-4 text-[12px] text-ink-soft">{c.exam}</td>
                <td className="px-5 py-4 text-[12px] text-ink-soft">{c.submittedAgo}</td>
                <td className="px-5 py-4 text-[12px] text-ink-soft">{c.paper.length} questions · {paperMax(c.paper)} marks</td>
                <td className="px-5 py-4">{c.flags.length ? <span className="border border-alert/30 bg-alert/5 px-2 py-1 font-mono text-[10px] text-alert">{c.flags.length} flag{c.flags.length > 1 ? "s" : ""}</span> : <span className="font-mono text-[10px] text-success">Clean</span>}</td>
                <td className="px-5 py-4"><StatusChip status={c.status} awarded={c.awarded} /></td>
                <td className="px-5 py-4 text-right"><button onClick={() => openReview(c.id)} className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Review →</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length === 0 && <div className="p-10 text-center"><p className="font-serif text-lg">No candidates match these filters</p><p className="mt-1 text-[12px] text-ink-soft">Try clearing the search or switching the status tab.</p></div>}
    </section>

    {active && <ReviewSession candidate={active} queue={gradeQueue} onClose={closeReview} onNavigate={navigateReview} onFinalize={finalizeGrade} notify={notify} profileName={profile?.full_name ?? "Faculty"} />}

    {showBulkDelegateModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-paper/80 backdrop-blur-sm">
        <div className="w-full max-w-md border border-line-strong bg-paper p-6 shadow-2xl animate-fade-in">
          <h2 className="font-serif text-xl font-semibold">Assign Delegate</h2>
          <p className="mt-2 text-[13px] text-ink-soft">Select a faculty member to cross-check the marks for the {selectedCandidates.length} selected candidates.</p>
          <div className="mt-6 flex flex-col gap-3">
            {faculty.map((p) => (
              <label key={p.name} className="flex items-center gap-3 border border-line p-3 hover:bg-forest/5 cursor-pointer transition-colors">
                <input type="radio" name="bulk_delegate" checked={delegateName === p.name} onChange={() => setDelegateName(p.name)} className="accent-forest w-4 h-4" />
                <span className="font-mono text-[11px] uppercase tracking-wider text-ink">{p.name}</span>
                {p.department && <span className="text-[10px] text-ink-soft">{p.department}</span>}
              </label>
            ))}
            {faculty.length === 0 && <p className="text-[12px] text-ink-soft">No other faculty found — add teachers to the platform first.</p>}
          </div>
          <div className="mt-8 flex justify-end gap-3">
            <button onClick={() => setShowBulkDelegateModal(false)} className="px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">Cancel</button>
            <button onClick={() => void confirmDelegate()} disabled={!delegateName} className="bg-forest px-6 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest/90 disabled:cursor-not-allowed disabled:bg-line/50 disabled:text-ink-soft">Confirm Assignment</button>
          </div>
        </div>
      </div>
    )}

    {showGuide && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm">
        <div className="w-full max-w-md border border-line bg-paper p-6 shadow-xl">
          <h2 className="font-serif text-2xl font-semibold">Grading Guide</h2>
          <p className="mt-2 text-[13px] text-ink-soft">Standard rubric for subjective evaluation</p>
          <div className="mt-5 space-y-4">
            <div className="border border-line p-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Exceptional (90-100%)</p>
              <p className="mt-1 text-[13px]">Demonstrates deep understanding, accurate terminology, and complete logical flow. No conceptual errors.</p>
            </div>
            <div className="border border-line p-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-amber">Proficient (70-89%)</p>
              <p className="mt-1 text-[13px]">Good understanding but may miss minor edge cases. Logic is generally sound.</p>
            </div>
            <div className="border border-line p-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-alert">Needs Work (&lt;70%)</p>
              <p className="mt-1 text-[13px]">Significant conceptual misunderstandings. Core components of the answer are missing or incorrect.</p>
            </div>
          </div>
          <button onClick={() => setShowGuide(false)} className="mt-6 w-full border border-line-strong bg-paper py-2.5 font-mono text-[10px] uppercase tracking-wider hover:border-forest hover:text-forest">Close Guide</button>
        </div>
      </div>
    )}
  </>;
}

function StatTile({ value, label, tone }: { value: number; label: string; tone: string }) {
  return <div className="bg-paper px-4 py-3 text-center"><p className={`font-serif text-2xl ${tone}`}>{value}</p><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p></div>;
}
function StatusChip({ status, awarded }: { status: Status; awarded?: number }) {
  const tone = status === "Graded" ? "text-success" : status === "In review" ? "text-forest" : "text-amber";
  return <span className={`font-mono text-[10px] uppercase tracking-wider ${tone}`}>{status === "Graded" && awarded != null ? `Graded · ${awarded}` : status}</span>;
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><span className="text-ink-soft">{label}</span><span className="tabular font-medium">{value}</span></div>;
}

type CamState = "connecting" | "live" | "denied" | "unavailable";
function useEvaluatorCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<CamState>("connecting");
  const [seconds, setSeconds] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    setState("connecting");
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) { setState("unavailable"); return; }
    md.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        setState("live");
        setStream(s);
        const v = videoRef.current;
        if (v) { v.srcObject = s; v.play().catch(() => undefined); }
      })
      .catch(() => { if (!cancelled) setState("denied"); });
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [attempt]);

  useEffect(() => {
    if (state !== "live") return;
    const id = window.setInterval(() => setSeconds((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [state]);

  return { videoRef, state, seconds, stream, retry: () => { setSeconds(0); setAttempt((x) => x + 1); } };
}

function ReviewSession({ candidate, queue, onClose, onNavigate, onFinalize, notify, profileName }: {
  candidate: Candidate; queue: Candidate[];
  onClose: () => void; onNavigate: (cid: string) => void;
  onFinalize: (cid: string, awarded: number) => void; notify: (m: string) => void; profileName: string
}) {
  const cam = useEvaluatorCamera();
  const [manualScores, setManualScores] = useState<Record<string, number>>({});
  const [rubricChecks, setRubricChecks] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [pipMin, setPipMin] = useState(false);
  const [showDelegateModal, setShowDelegateModal] = useState(false);
  const [reviewRec, setReviewRec] = useState<{ attemptId: string; roll: string; name: string } | null>(null);

  const cid = candidate.id;
  const paper = candidate.paper;
  const max = paperMax(paper);
  const manualQs = paper.filter((q) => !isAuto(q));
  const autoTotal = paper.filter(isAuto).reduce((t, q) => t + autoScore(q), 0);
  const manualTotal = manualQs.reduce((t, q) => t + (manualScores[key(cid, q.id)] ?? 0), 0);
  const gradedManual = manualQs.filter((q) => manualScores[key(cid, q.id)] != null).length;
  const awarded = autoTotal + manualTotal;

  const setScore = (qid: string, marks: number, maxMarks: number) =>
    setManualScores((cur) => ({ ...cur, [key(cid, qid)]: Math.max(0, Math.min(maxMarks, Number.isNaN(marks) ? 0 : marks)) }));
  const toggleItem = (q: Question, itemId: string) => {
    const nextChecks = { ...rubricChecks, [key(cid, q.id, itemId)]: !rubricChecks[key(cid, q.id, itemId)] };
    setRubricChecks(nextChecks);
    const suggested = (q.rubric ?? []).reduce((t, it) => t + (nextChecks[key(cid, q.id, it.id)] ? it.marks : 0), 0);
    setManualScores((cur) => ({ ...cur, [key(cid, q.id)]: suggested }));
  };
  const setFb = (qid: string, v: string) => setFeedback((cur) => ({ ...cur, [key(cid, qid)]: v }));

  const idx = queue.findIndex((c) => c.id === cid);
  const position = idx >= 0 ? idx + 1 : 1;
  const prevCand = idx > 0 ? queue[idx - 1] : null;
  const nextCand = idx >= 0 && idx + 1 < queue.length ? queue[idx + 1] : null;
  const nextUngraded = queue.slice(idx + 1).find((c) => c.status !== "Graded") ?? queue.find((c) => c.id !== cid && c.status !== "Graded") ?? null;
  const finish = (goNext: boolean) => {
    onFinalize(cid, awarded);
    notify(`${candidate.name} · ${awarded}/${max} recorded`);
    if (goNext && nextUngraded) onNavigate(nextUngraded.id);
    else onClose();
  };

  const flagModeration = () => {
    if (!candidate.studentId) {
      notify("No student record linked to this attempt — cannot flag for moderation.");
      return;
    }
    void saveViolation(
      candidate.id,
      candidate.examId ?? "EXAM-2026-014",
      candidate.studentId,
      "grading_moderation",
      `Answer paper of ${candidate.name} (${candidate.roll}) flagged for moderation by ${profileName}`,
      { severity: "critical", source: "teacher" },
    );
    notify("Flagged for moderation — logged in the violation report.");
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-paper">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-paper-raised px-5 py-3 lg:px-8">
        <div className="flex min-w-0 items-center gap-4">
          <button onClick={onClose} className="shrink-0 border border-line-strong px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">← Roster</button>
          <div className="min-w-0"><p className="font-mono text-[10px] uppercase tracking-widest text-forest">Evaluation session · monitored</p><h2 className="truncate font-serif text-lg font-semibold">{candidate.name} <span className="font-mono text-[11px] font-normal text-ink-soft">{candidate.roll}</span></h2></div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex items-center gap-1">
            <button onClick={() => prevCand && onNavigate(prevCand.id)} disabled={!prevCand} title={prevCand ? `Previous · ${prevCand.name}` : "First in queue"} className="border border-line-strong px-2.5 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft enabled:hover:border-forest enabled:hover:text-ink disabled:opacity-40">‹ Prev</button>
            <span className="px-1.5 font-mono text-[10px] text-ink-soft" title="Position in grading queue">{position} / {queue.length}</span>
            <button onClick={() => nextCand && onNavigate(nextCand.id)} disabled={!nextCand} title={nextCand ? `Next · ${nextCand.name}` : "Last in queue"} className="border border-line-strong px-2.5 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft enabled:hover:border-forest enabled:hover:text-ink disabled:opacity-40">Next ›</button>
          </div>
          <div className="hidden text-right sm:block"><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Running score</p><p className="font-serif text-lg">{awarded} <span className="text-[12px] text-ink-soft">/ {max}</span></p></div>
          <RecPill state={cam.state} seconds={cam.seconds} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden">
        <main className="min-w-0 px-5 py-7 lg:px-10 xl:flex-1 xl:overflow-y-auto">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-center justify-between"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{candidate.exam}</p><p className="font-mono text-[10px] text-ink-soft">Submitted {candidate.submittedAgo}</p></div>
            <h1 className="mt-2 font-serif text-3xl font-semibold">Answer paper</h1>
            {candidate.flags.length > 0 && <IntegrityBanner flags={candidate.flags} name={candidate.name} notify={notify} onOpenRecording={() => setReviewRec({ attemptId: candidate.id, roll: candidate.roll, name: candidate.name })} />}
            <div className="mt-7 space-y-5">
              {paper.map((q) => <QuestionCard key={q.id} q={q} cid={cid} manualScores={manualScores} rubricChecks={rubricChecks} feedback={feedback} setScore={setScore} toggleItem={toggleItem} setFeedback={setFb} />)}
            </div>
          </div>
        </main>

        <aside className="w-full border-t border-line bg-paper-raised xl:w-[340px] xl:shrink-0 xl:overflow-y-auto xl:border-l xl:border-t-0">
          <ScoreSummary awarded={awarded} max={max} autoTotal={autoTotal} manualTotal={manualTotal} gradedManual={gradedManual} manualCount={manualQs.length} onFinish={() => finish(false)} onFinishNext={() => finish(true)} onDelegate={() => setShowDelegateModal(true)} onFlagModeration={flagModeration} hasNext={Boolean(nextUngraded)} nextName={nextUngraded?.name} />
          <CandidateFacts candidate={candidate} />
        </aside>
      </div>

      <CameraPip cam={cam} minimized={pipMin} onToggle={() => setPipMin((v) => !v)} profileName={profileName} notify={notify} />
      {reviewRec && (
        <RecordingReviewBridge
          attemptId={reviewRec.attemptId}
          roll={reviewRec.roll}
          name={reviewRec.name}
          onClose={() => setReviewRec(null)}
        />
      )}
    </div>
  );
}

/** Fetches the real violation events for one attempt, then opens the review. */
function RecordingReviewBridge({ attemptId, roll, name, onClose }: {
  attemptId: string; roll: string; name: string; onClose: () => void;
}) {
  const [violations, setViolations] = useState<ViolationEvent[]>([]);
  const [examId, setExamId] = useState("EXAM-2026-014");
  useEffect(() => {
    let alive = true;
    void listAttemptViolations(attemptId).then((vs) => {
      if (!alive) return;
      if (vs.length > 0) setExamId(vs[0].exam_id);
      setViolations(vs);
    });
    return () => { alive = false; };
  }, [attemptId]);
  return <RecordingReviewModal examId={examId} roll={roll} name={name} violations={violations} onClose={onClose} />;
}

function RecPill({ state, seconds }: { state: CamState; seconds: number }) {
  const live = state === "live";
  return (
    <div className={`flex items-center gap-2 border px-3 py-2 ${live ? "border-alert/40 bg-alert/5" : "border-line-strong bg-paper"}`}>
      <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-alert" : "bg-ink-soft"}`} />
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{live ? "Rec" : state === "connecting" ? "Cam…" : "Cam off"}</span>
      {live && <span className="tabular font-mono text-[11px] text-ink">{fmt(seconds)}</span>}
    </div>
  );
}

function CameraPip({ cam, minimized, onToggle, profileName, notify }: { cam: ReturnType<typeof useEvaluatorCamera>; minimized: boolean; onToggle: () => void; profileName: string; notify: (m: string) => void }) {
  const { videoRef, state, seconds, stream } = cam;
  const [faceWarning, setFaceWarning] = useState(false);
  const showVideo = state === "connecting" || state === "live";
  const status = state === "live" ? `Rec ${fmt(seconds)}` : state === "connecting" ? "Connecting" : state === "denied" ? "Blocked" : "Camera off";
  return (
    <div className="absolute bottom-4 left-4 z-40 w-[210px] overflow-hidden border border-[#30493a] bg-[#1f3027] shadow-[0_12px_30px_-12px_rgba(0,0,0,0.5)] sm:w-[240px]">
      <div className="flex items-center justify-between bg-[#223528] px-2.5 py-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-paper/85">
          <span className={`h-1.5 w-1.5 rounded-full ${state === "live" ? "animate-pulse bg-alert" : "bg-paper/50"}`} />
          {status}
        </span>
        <button onClick={onToggle} className="px-1 font-mono text-[12px] leading-none text-paper/70 hover:text-paper" title={minimized ? "Expand self-view" : "Minimize self-view"}>{minimized ? "▢" : "—"}</button>
      </div>
      <div className={minimized ? "hidden" : "relative aspect-video"}>
        {showVideo ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted className={`h-full w-full -scale-x-100 object-cover ${faceWarning ? 'opacity-30' : ''}`} />
            {stream && (
              <ProctorAI
                cameraStream={stream}
                active={state === "live"}
                onViolation={(v) => {
                  if (v.type === "no_face" || v.type === "partial_face") setFaceWarning(true);
                  if (v.type !== "gaze_away") {
                    notify(`AI Alert: ${v.label}`);
                  }
                }}
                onStatus={(s) => {
                  if (s.faceCount > 0) setFaceWarning(false);
                }}
              />
            )}
            {faceWarning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-alert/90 p-3 text-center text-paper">
                <p className="font-serif text-[14px] font-medium leading-tight text-white">Face not detected</p>
                <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-paper/80">Please stay in frame</p>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-3 text-center text-paper">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-paper/40 font-serif text-[13px]">V</span>
            <p className="mt-2 font-mono text-[9px] uppercase tracking-wider text-paper/80">{state === "denied" ? "Camera blocked" : "No camera"}</p>
            {(state === "denied" || state === "unavailable") && <button onClick={cam.retry} className="mt-2 border border-paper/40 px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-paper/90 hover:bg-paper/10">Enable camera</button>}
          </div>
        )}
        {state === "connecting" && <div className="absolute inset-0 flex items-center justify-center bg-[#1f3027]/70 font-mono text-[9px] uppercase tracking-wider text-paper/80">Starting camera…</div>}
        <span className="absolute bottom-1.5 right-1.5 bg-ink/70 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-paper">Evaluator · {profileName}</span>
      </div>
    </div>
  );
}

function IntegrityBanner({ flags, name, notify, onOpenRecording }: { flags: Flag[]; name: string; notify: (m: string) => void; onOpenRecording: () => void }) {
  return (
    <div className="mt-5 border border-alert/30 bg-alert/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div><p className="font-mono text-[10px] uppercase tracking-widest text-alert">Proctoring · review before finalizing</p><p className="mt-1 text-[13px]">This candidate's exam raised {flags.length} flag{flags.length > 1 ? "s" : ""}. Review the recording before confirming marks.</p></div>
        <button onClick={onOpenRecording} className="shrink-0 border border-alert px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-alert hover:bg-alert/10">Open recording</button>
      </div>
      <ul className="mt-3 space-y-1.5">
        {flags.map((f, i) => <li key={i} className="flex items-center gap-2 text-[12px]"><span className={`h-1.5 w-1.5 ${f.severity === "critical" ? "bg-alert" : "bg-amber"}`} /><span className="font-medium">{f.label}</span><span className="font-mono text-[10px] text-ink-soft">{f.at}</span></li>)}
      </ul>
    </div>
  );
}

function QuestionCard({ q, cid, manualScores, rubricChecks, feedback, setScore, toggleItem, setFeedback }: {
  q: Question; cid: string; manualScores: Record<string, number>; rubricChecks: Record<string, boolean>; feedback: Record<string, string>;
  setScore: (qid: string, marks: number, maxMarks: number) => void; toggleItem: (q: Question, itemId: string) => void; setFeedback: (qid: string, v: string) => void;
}) {
  const auto = isAuto(q);
  const scored = manualScores[key(cid, q.id)] != null;
  const score = auto ? autoScore(q) : (manualScores[key(cid, q.id)] ?? 0);
  const full = score === q.marks;
  const badge = auto ? `Auto · ${score}/${q.marks}` : scored ? `Scored · ${score}/${q.marks}` : "Needs review";
  const badgeTone = auto ? (full ? "text-success" : score === 0 ? "text-alert" : "text-amber") : scored ? "text-forest" : "text-amber";
  return (
    <section className="border border-line bg-paper">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper-raised px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Question {q.no} · {typeLabel(q.type)} · {q.marks} marks</p>
        <span className={`font-mono text-[10px] uppercase tracking-wider ${badgeTone}`}>{auto ? "◆ " : ""}{badge}</span>
      </div>
      <div className="p-4 sm:p-5">
        <p className="font-serif text-[16px] leading-snug">{q.prompt}</p>
        {(q.type === "MCQ" || q.type === "TrueFalse") && <McqAnswer q={q} />}
        {q.type === "MSQ" && <MsqAnswer q={q} />}
        {q.type === "Numerical" && <NumericalAnswer q={q} />}
        {q.type === "Coding" && <CodingAnswer q={q} />}
        {q.type === "Subjective" && <ManualAnswer q={q} cid={cid} score={score} rubricChecks={rubricChecks} feedback={feedback} setScore={setScore} toggleItem={toggleItem} setFeedback={setFeedback} />}
      </div>
    </section>
  );
}

function McqAnswer({ q }: { q: Question }) {
  return (
    <div className="mt-4 space-y-2">
      {(q.options ?? []).map((opt, i) => {
        const chosen = q.chosen === i;
        const isCorrect = q.correct === i;
        const tone = isCorrect ? "border-success bg-success/5" : chosen ? "border-alert bg-alert/5" : "border-line";
        const markTone = isCorrect ? "border-success text-success" : chosen ? "border-alert text-alert" : "border-line-strong text-ink-soft";
        return (
          <div key={i} className={`flex items-center gap-3 border px-3 py-2.5 text-[13px] ${tone}`}>
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] ${markTone}`}>{String.fromCharCode(65 + i)}</span>
            <span className="flex-1">{opt}</span>
            {isCorrect && <span className="font-mono text-[9px] uppercase tracking-wider text-success">{chosen ? "Student ✓" : "Correct"}</span>}
            {chosen && !isCorrect && <span className="font-mono text-[9px] uppercase tracking-wider text-alert">Student's answer</span>}
          </div>
        );
      })}
      {q.chosen == null && <p className="text-[12px] text-amber">Not answered</p>}
    </div>
  );
}

function MsqAnswer({ q }: { q: Question }) {
  const chosen = q.chosenSet ?? [];
  const correct = q.correctSet ?? [];
  const allCorrect = setsEqual(chosen, correct);
  return (
    <div className="mt-4 space-y-2">
      {(q.options ?? []).map((opt, i) => {
        const isChosen = chosen.includes(i);
        const isCorrect = correct.includes(i);
        const tone = isCorrect ? "border-success bg-success/5" : isChosen ? "border-alert bg-alert/5" : "border-line";
        const markTone = isCorrect ? "border-success text-success" : isChosen ? "border-alert text-alert" : "border-line-strong text-ink-soft";
        return (
          <div key={i} className={`flex items-center gap-3 border px-3 py-2.5 text-[13px] ${tone}`}>
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] ${markTone}`}>{isChosen ? "✓" : String.fromCharCode(65 + i)}</span>
            <span className="flex-1">{opt}</span>
            {isCorrect && isChosen && <span className="font-mono text-[9px] uppercase tracking-wider text-success">Student ✓</span>}
            {isCorrect && !isChosen && <span className="font-mono text-[9px] uppercase tracking-wider text-amber">Missed</span>}
            {!isCorrect && isChosen && <span className="font-mono text-[9px] uppercase tracking-wider text-alert">Wrong pick</span>}
          </div>
        );
      })}
      <p className={`font-mono text-[10px] uppercase tracking-wider ${allCorrect ? "text-success" : "text-alert"}`}>{allCorrect ? "Exact match with the answer key · full marks" : "Selection does not match the key · no marks (all-or-nothing)"}</p>
    </div>
  );
}

function NumericalAnswer({ q }: { q: Question }) {
  const correct = (q.response ?? "").trim().toLowerCase() === (q.expected ?? "").trim().toLowerCase();
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <div className={`border p-3 ${correct ? "border-success bg-success/5" : "border-alert bg-alert/5"}`}>
        <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Student response</p>
        <p className="mt-1 font-mono text-[15px]">{q.response || "—"}</p>
      </div>
      <div className="border border-line bg-paper-raised p-3">
        <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Expected</p>
        <p className="mt-1 font-mono text-[15px]">{q.expected}</p>
      </div>
    </div>
  );
}

function CodingAnswer({ q }: { q: Question }) {
  const { passed, total } = codingPassed(q);
  const allPass = total > 0 && passed === total;
  const scoreTone = allPass ? "text-success" : passed === 0 ? "text-alert" : "text-amber";
  return (
    <div className="mt-4">
      <pre className="overflow-x-auto border border-[#2b332c] bg-[#202924] p-4 font-mono text-[12px] leading-relaxed text-paper/90"><code>{q.response || "// no submission"}</code></pre>
      <div className="mt-4 border border-line">
        <div className="flex items-center justify-between border-b border-line bg-paper-raised px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Hidden test cases · auto-graded</p>
          <span className={`font-mono text-[10px] uppercase tracking-wider ${scoreTone}`}>{passed}/{total} passed</span>
        </div>
        <ul className="divide-y divide-line">
          {(q.tests ?? []).map((t, i) => (
            <li key={i} className="flex items-center justify-between px-3 py-2 text-[12px]">
              <span className="flex items-center gap-2"><span className={`h-1.5 w-1.5 ${t.passed ? "bg-success" : "bg-alert"}`} />{t.name}</span>
              <span className={`font-mono text-[9px] uppercase tracking-wider ${t.passed ? "text-success" : "text-alert"}`}>{t.passed ? "Pass" : "Fail"}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-3 border-l-2 border-forest bg-success/5 px-3 py-2 text-[11px] text-ink-soft">Scored automatically from the hidden test cases — {passed} of {total} passed → {autoScore(q)}/{q.marks} marks. No manual review needed.</p>
    </div>
  );
}

function ManualAnswer({ q, cid, score, rubricChecks, feedback, setScore, toggleItem, setFeedback }: {
  q: Question; cid: string; score: number; rubricChecks: Record<string, boolean>; feedback: Record<string, string>;
  setScore: (qid: string, marks: number, maxMarks: number) => void; toggleItem: (q: Question, itemId: string) => void; setFeedback: (qid: string, v: string) => void;
}) {
  const fb = feedback[key(cid, q.id)] ?? "";
  // Detect uploaded image: response starts with "[Uploaded answer: URL]"
  const uploadedMatch = typeof q.response === "string" && q.response.startsWith("[Uploaded answer:")
    ? q.response.match(/^\[Uploaded answer:\s*(.+?)\s*\]$/)
    : null;
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(uploadedMatch ? uploadedMatch[1] : null);

  // Grading comments (inline text + voice notes) — persisted in grading_comments.
  const [comments, setComments] = useState<GradingComment[]>([]);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const loadComments = () => {
    void listGradingComments(cid).then((rows) =>
      setComments(rows.filter((c) => String(c.question_id) === String(q.id))),
    );
  };
  useEffect(loadComments, [cid, q.id]);

  const addInlineComment = async () => {
    const text = window.prompt("Inline comment for this answer:", "");
    if (!text?.trim()) return;
    const ok = await addGradingComment({ attemptId: cid, questionId: String(q.id), comment: text });
    if (ok) loadComments();
  };

  const toggleVoice = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const key = `grading/voice/${cid}_${q.id}_${Date.now()}.webm`;
        const stored = await uploadArtifactBlob(key, blob, "audio/webm");
        await addGradingComment({
          attemptId: cid,
          questionId: String(q.id),
          comment: "Voice note",
          voiceKey: stored?.key ?? key,
        });
        setRecording(false);
        loadComments();
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      window.alert("Microphone permission was denied.");
    }
  };

  // Also fetch the upload directly from question_submissions AND student_answers
  useEffect(() => {
    if (uploadedMatch) return;
    const db = getSupabase();
    if (!db || !cid) return;

    const fetchUrl = (path: string | null | undefined) => {
      if (!path) return;
      if (path.startsWith("http")) {
        setUploadedUrl(path);
      } else {
        const { data: urlData } = db.storage.from("exam-records").getPublicUrl(path);
        if (urlData?.publicUrl) setUploadedUrl(urlData.publicUrl);
      }
    };

    // 1. Check student_answers table (direct desktop image upload)
    db.from("student_answers")
      .select("uploaded_image_url, answer_text")
      .eq("attempt_id", cid)
      .eq("question_id", String(q.id))
      .maybeSingle()
      .then(({ data, error }: { data: any; error: any }) => {
        if (!error && data?.uploaded_image_url) {
          fetchUrl(data.uploaded_image_url);
        }
      });

    // 2. Check question_submissions (mobile upload via QR)
    db.from("question_submissions")
      .select("pdf_storage_path, original_storage_path")
      .eq("attempt_id", cid)
      .eq("question_id", String(q.id))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }: { data: any; error: any }) => {
        if (error || !data) return;
        const path = data.pdf_storage_path || data.original_storage_path;
        if (path) fetchUrl(path);
      });
  }, [cid, q.id, uploadedMatch]);

  return (
    <div className="mt-4">
      {uploadedUrl ? (
        <div className="border-l-2 border-forest bg-paper-raised p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-forest font-bold mb-2">✓ Uploaded Handwritten Answer</p>
          <a href={uploadedUrl} target="_blank" rel="noopener noreferrer">
            <img
              src={uploadedUrl}
              alt="Student's handwritten answer"
              className="w-full max-h-[600px] object-contain border border-line bg-paper cursor-zoom-in"
            />
          </a>
          <p className="mt-2 font-mono text-[9px] text-ink-soft">Click image to view full size</p>
        </div>
      ) : (
        <article className="whitespace-pre-wrap border-l-2 border-forest bg-paper-raised p-4 text-[14px] leading-7">{q.response || "No answer submitted."}</article>
      )}
      {q.rubric && (
        <div className="mt-4 border border-line">
          <p className="border-b border-line bg-paper-raised px-3 py-2 font-mono text-[9px] uppercase tracking-widest text-ink-soft">Rubric · tick to build the score</p>
          <div className="divide-y divide-line">
            {q.rubric.map((it) => (
              <label key={it.id} className="flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-paper-raised">
                <input type="checkbox" checked={Boolean(rubricChecks[key(cid, q.id, it.id)])} onChange={() => toggleItem(q, it.id)} className="mt-0.5 h-4 w-4 accent-forest" />
                <span className="flex-1"><span className="text-[12px] font-medium">{it.label} <span className="font-mono text-[10px] text-forest">{it.marks} marks</span></span><span className="mt-0.5 block text-[11px] text-ink-soft">{it.detail}</span></span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Award</span>
          <input type="number" min={0} max={q.marks} value={score} onChange={(e) => setScore(q.id, Number(e.target.value), q.marks)} className="w-16 border border-forest bg-paper px-2 py-1.5 text-center font-serif text-lg outline-none" />
          <span className="font-serif text-[13px] text-ink-soft">/ {q.marks}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: q.marks + 1 }, (_, m) => <button key={m} onClick={() => setScore(q.id, m, q.marks)} className={`h-7 w-7 border font-mono text-[10px] ${score === m ? "border-forest bg-forest text-paper" : "border-line-strong text-ink-soft hover:border-forest"}`}>{m}</button>)}
        </div>
      </div>
      <div className="mt-3 relative">
        <textarea value={fb} onChange={(e) => setFeedback(q.id, e.target.value)} rows={3} placeholder="Feedback for this answer (optional)…" className="block w-full resize-y border border-line-strong bg-paper px-3 py-2 pb-10 text-[13px] outline-none focus:border-forest" />
        <div className="absolute bottom-2 left-2 flex gap-2">
          <button onClick={() => void addInlineComment()} className="border border-line-strong px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Inline Text Comment</button>
          <button onClick={() => void toggleVoice()} className="border border-line-strong px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">
            {recording ? "■ Stop recording" : "Voice Comment"}
          </button>
        </div>
      </div>
      {comments.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {comments.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 border-l-2 border-forest bg-forest/5 px-3 py-2 text-[12px]">
              <span className="min-w-0 flex-1 text-ink">{c.comment || "Voice note"}</span>
              {c.voice_key && <VoicePlayButton voiceKey={c.voice_key} />}
              <span className="font-mono text-[9px] text-ink-soft">
                {new Date(c.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

function VoicePlayButton({ voiceKey }: { voiceKey: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void getArtifactObjectUrl(voiceKey).then((u) => { if (alive && u) setUrl(u); });
    return () => { alive = false; };
  }, [voiceKey]);
  if (!url) return <span className="font-mono text-[9px] text-ink-soft">loading voice…</span>;
  return <audio controls src={url} className="h-8 w-44" />;
}

function ScoreSummary({ awarded, max, autoTotal, manualTotal, gradedManual, manualCount, onFinish, onFinishNext, onDelegate, onFlagModeration, hasNext, nextName }: {
  awarded: number; max: number; autoTotal: number; manualTotal: number; gradedManual: number; manualCount: number;
  onFinish: () => void; onFinishNext: () => void; onDelegate: () => void; onFlagModeration: () => void; hasNext: boolean; nextName?: string;
}) {
  const done = manualCount === 0 || gradedManual === manualCount;
  return (
    <div className="border-b border-line p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Score summary</p>
      <div className="mt-3 flex items-end gap-3"><p className="font-serif text-4xl">{awarded}</p><p className="pb-1 font-serif text-lg text-ink-soft">/ {max}</p></div>
      <div className="mt-3 space-y-1.5 text-[12px]">
        <Row label="Auto-graded (objective + coding)" value={`${autoTotal}`} />
        <Row label="Theory (manual review)" value={`${manualTotal}`} />
        <Row label="Theory answers scored" value={`${gradedManual} / ${manualCount}`} />
      </div>
      <div className={`mt-3 border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${done ? "border-success/40 bg-success/5 text-success" : "border-amber/40 bg-amber/5 text-amber"}`}>{done ? "✓ Ready to record" : `${manualCount - gradedManual} theory answer(s) still need a score`}</div>
      <div className="mt-4 grid gap-2">
        {hasNext && <button onClick={onFinishNext} className="border border-forest bg-forest px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">Save &amp; next → {nextName}</button>}
        <button onClick={onFinish} className="border border-forest px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-forest hover:bg-success/5">{hasNext ? "Save & close" : "Save & finish"}</button>
        <button onClick={onDelegate} className="border border-line-strong px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-forest hover:text-forest">Delegate for cross-check</button>
        <button onClick={onFlagModeration} className="border border-alert/50 text-alert bg-alert/5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-alert/10">Flag for Moderation</button>
      </div>
    </div>
  );
}

function CandidateFacts({ candidate }: { candidate: Candidate }) {
  return (
    <div className="p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Candidate</p>
      <div className="mt-3 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center border border-line-strong font-serif text-ink-soft">{candidate.initials}</span>
        <div><p className="font-serif text-[15px] font-medium">{candidate.name}</p><p className="font-mono text-[10px] text-ink-soft">{candidate.roll}</p></div>
      </div>
      <div className="mt-4 space-y-2 text-[12px]">
        <Row label="Exam" value={candidate.exam} />
        <Row label="Submitted" value={candidate.submittedAgo} />
        <Row label="Proctoring" value={candidate.flags.length ? `${candidate.flags.length} flag(s)` : "Clean"} />
        <Row label="Plagiarism" value="Checked: 0% match" />
      </div>
    </div>
  );
}











