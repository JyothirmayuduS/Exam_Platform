import { useEffect, useMemo, useRef, useState } from "react";
import { FiCheck, FiPaperclip, FiAlertTriangle } from "react-icons/fi";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { loadExamBundle, updateAttemptScore, type DBQuestion, listAttemptViolations, getAttemptExamId, saveViolation, addGradingComment, listGradingComments, listFaculty, assignGradingDelegates, type ViolationEvent, type GradingComment } from "@/shared/data/examApi";
import { type Attempt, type Flag } from "@/shared/services/rosterModel";
import {
  gradeObjective,
  isAutoGraded,
  numericEqual,
  paperTotal,
  penaltyFor,
  questionKind,
  questionsForPaper,
  remapAnswer,
  round2,
  type NegativeSettings,
  type PaperSlot,
  type QuestionKind,
  type Verdict,
} from "@/shared/domain/exam";
import useLiveAttempts from "@/features/teacher/hooks/useLiveAttempts";
import useTeacherExams from "@/features/teacher/hooks/useTeacherExams";
import useCurrentProfile, { profileSubtitle } from "@/features/auth/hooks/useCurrentProfile";
import AIIntegrityCard from "@/features/proctoring/components/AIIntegrityCard";
import { RecordingReviewModal } from "@/features/proctoring/components/RecordingReview";
import { uploadArtifactBlob, getArtifactObjectUrl } from "@/shared/services/examStorage";
import { compressImage } from "@/shared/services/subjectiveUpload";
import { getTeacherNav } from "@/features/teacher/navigation";
import { getSupabase } from "@/shared/data/supabase";

type QType = "MCQ" | "MSQ" | "TrueFalse" | "Numerical" | "Subjective" | "Coding";
const QTYPE_OF_KIND: Record<QuestionKind, QType> = {
  mcq: "MCQ", msq: "MSQ", truefalse: "TrueFalse", numerical: "Numerical", subjective: "Subjective", coding: "Coding",
};
type Question = {
  id: string; no: number; type: QType; kind: QuestionKind; prompt: string; marks: number;
  options?: string[]; correct?: number; chosen?: number | null;
  correctSet?: number[]; chosenSet?: number[];
  expected?: string; response?: string;
  /** Objective questions only: how the response compares with the key. */
  verdict?: Verdict;
  /** Marks deducted if the answer is wrong (0 without negative marking). */
  penalty: number;
};

const toIndex = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v);
  return null;
};
const toIndexList = (v: unknown): number[] => {
  let list: unknown = v;
  if (typeof v === "string") {
    try { list = JSON.parse(v); } catch { list = []; }
  }
  return Array.isArray(list) ? list.map(toIndex).filter((n): n is number => n !== null) : [];
};
type Status = "To grade" | "In review" | "Graded";
type Candidate = Attempt & { order: number; status: Status; paper: Question[]; awarded?: number };

// Build a gradeable paper for ONE attempt: its own question snapshot (falling
// back to the full pool for legacy attempts), with student answers re-mapped
// from the displayed option order back to the original order for grading.
function buildPaper(questions: DBQuestion[], answers: Record<string, unknown>, paper: unknown, settings: NegativeSettings | null): Question[] {
  const slots: PaperSlot[] = Array.isArray(paper) ? (paper as PaperSlot[]) : [];
  const slotByQid = new Map(slots.map((s) => [s.id, s]));
  return questions.map((q, i) => {
    const kind = questionKind(q.type, q.options?.length ?? 0);
    const options = Array.isArray(q.options) ? q.options.map(String) : [];
    const ans = remapAnswer(slotByQid.get(q.id), options, answers[q.id]);
    const marks = q.marks || 1;
    const base: Question = {
      id: q.id,
      no: i + 1,
      type: QTYPE_OF_KIND[kind],
      kind,
      prompt: q.title,
      marks,
      options,
      penalty: penaltyFor(kind, marks, settings),
    };

    if (kind === "mcq" || kind === "truefalse") {
      base.correct = toIndex(q.answer) ?? undefined;
      base.chosen = toIndex(ans);
    } else if (kind === "msq") {
      base.correctSet = toIndexList(q.answer);
      base.chosenSet = toIndexList(Array.isArray(ans) ? JSON.stringify(ans) : ans);
    } else if (kind === "numerical") {
      base.expected = q.answer ?? "";
      base.response = ans == null ? "" : String(ans);
    } else {
      // Descriptive / coding: the student's text or uploaded-image answer,
      // graded by hand below.
      base.response = typeof ans === "string" ? ans : "";
    }
    if (isAutoGraded(kind)) base.verdict = gradeObjective(kind, q.answer, ans);
    return base;
  });
}

const key = (cid: string, qid: string, item?: string) => (item ? `${cid}:${qid}:${item}` : `${cid}:${qid}`);
// Objective questions (MCQ / MSQ / True-False / Numerical) score automatically
// against the answer key. Subjective and Coding answers are reviewed manually.
const isAuto = (q: Question) => isAutoGraded(q.kind);
function setsEqual(a: number[] = [], b: number[] = []) {
  const x = [...a].sort((m, n) => m - n); const y = [...b].sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
function autoScore(q: Question): number {
  if (!q.verdict) return 0;
  if (q.verdict === "correct") return q.marks;
  return q.verdict === "wrong" && q.penalty ? -q.penalty : 0;
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
  const [examId, setExamId] = useState<string | null>(null);
  useEffect(() => {
    const reviewId = searchParams.get("review");
    if (!reviewId) return;
    let alive = true;
    void getAttemptExamId(reviewId).then((resolved) => {
      if (alive && resolved) setExamId(resolved);
    });
    return () => { alive = false; };
  }, [searchParams]);

  const scope = useTeacherExams();
  const effectiveExamId = examId ?? scope.examId;
  const effectiveExamName =
    (examId ? scope.exams.find((e) => e.id === examId) : null)?.name ?? scope.exam?.name ?? "";
  const selectExamForEval = (id: string) => {
    setExamId(id);
    scope.selectExam(id);
  };

  const { data: liveAttempts = [] } = useLiveAttempts(effectiveExamId ?? "", effectiveExamName);

  const liveAttemptsCount = liveAttempts.filter((a) => a.state !== "Submitted").length;
  const submittedAttemptsCount = liveAttempts.filter((a) => a.state === "Submitted").length;
  const nav = getTeacherNav(liveAttemptsCount, submittedAttemptsCount, 0);

  const { data: examBundle } = useQuery({
    queryKey: ["examBundle", effectiveExamId],
    queryFn: () => (effectiveExamId ? loadExamBundle(effectiveExamId) : Promise.resolve({ exam: null, questions: [] })),
    enabled: !!effectiveExamId,
  });

  // Phone/desktop uploads of handwritten answers, keyed attempt → question →
  // storage path. Fills in answers that never synced back from the exam
  // screen, so the scan is always gradeable.
  const submittedIds = liveAttempts.filter((a) => a.state === "Submitted").map((a) => a.id).sort().join(",");
  const { data: uploads } = useQuery({
    queryKey: ["questionUploads", submittedIds],
    enabled: submittedIds.length > 0,
    queryFn: async () => {
      const db = getSupabase();
      const out: Record<string, Record<string, string>> = {};
      if (!db) return out;
      const { data } = await db
        .from("question_submissions")
        .select("attempt_id, question_id, pdf_storage_path, created_at")
        .in("attempt_id", submittedIds.split(","))
        .order("created_at", { ascending: true });
      for (const row of data ?? []) {
        if (!row.pdf_storage_path) continue;
        (out[String(row.attempt_id)] ??= {})[String(row.question_id)] = String(row.pdf_storage_path);
      }
      return out;
    },
  });

  const [roster, setRoster] = useState<Candidate[]>([]);
  
  useEffect(() => {
    if (!examBundle) return;
    const questions = examBundle.questions ?? [];
    const settings = (examBundle.exam?.settings ?? null) as NegativeSettings | null;
    
    // Merge live attempts with the exam's question pool from Supabase.
    const mapped: Candidate[] = liveAttempts
      .filter((a) => a.state === "Submitted") // We only grade submitted
      .map((a, i) => {
        // Grade the student's OWN paper: filter the pool to their snapshot.
        const answers: Record<string, unknown> = { ...(a.answers || {}) };
        for (const [qid, path] of Object.entries(uploads?.[a.id] ?? {})) {
          const cur = answers[qid];
          if (cur == null || (typeof cur === "string" && cur.trim() === "")) answers[qid] = `[Uploaded answer: ${path}]`;
        }
        const paper = buildPaper(questionsForPaper(a.paper, questions), answers, a.paper, settings);
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
  }, [liveAttempts, examBundle, uploads]);

  const [statusFilter, setStatusFilter] = useState<"All" | Status>("All");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
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

  const preSort = useMemo(() => roster.filter((c) => {
    if (flaggedOnly && c.flags.length === 0) return false;
    const q = search.trim().toLowerCase();
    return !q || `${c.name} ${c.roll}`.toLowerCase().includes(q);
  }), [roster, flaggedOnly, search]);

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

  const handleBulkGrade = async () => {
    setSaving(true);
    const purelyObjective = selectedCandidates.filter((cid) => {
      const c = roster.find((x) => x.id === cid);
      return c && c.paper.every((q) => isAuto(q));
    });
    const skipped = selectedCandidates.length - purelyObjective.length;
    for (const cid of purelyObjective) {
      const candidate = roster.find((c) => c.id === cid);
      if (!candidate) continue;
      const score = paperTotal(candidate.paper.map(autoScore));
      await updateAttemptScore(cid, score);
    }
    setRoster((cur) => cur.map((c) => {
      if (!purelyObjective.includes(c.id)) return c;
      const score = paperTotal(c.paper.map(autoScore));
      return { ...c, status: "Graded", awarded: score };
    }));
    setSaving(false);
    notify(skipped > 0 ? `Bulk graded ${purelyObjective.length} objective paper(s); ${skipped} skipped — they contain theory/code answers that need your review` : `Bulk graded ${purelyObjective.length} candidates`);
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
        <p className="mt-2 max-w-2xl text-[13px] text-ink-soft">Only submitted papers appear here — live attempts are tracked in Submissions. Objective answers are scored automatically from the answer key; theory and code answers are reviewed by you. Every grading session is camera-monitored.</p>
      </div>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
        <div className="flex divide-x divide-line border border-line-strong bg-paper">
          <button onClick={() => setShowGuide(true)} className="px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:bg-paper-raised hover:text-ink">Grading guide</button>
        </div>
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
        <select id="subj" value={effectiveExamId ?? ""} onChange={(e) => selectExamForEval(e.target.value)} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest">{scope.exams.filter((e) => e.status !== "draft").map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}{scope.exams.length === 0 && <option value="">No exams yet</option>}</select>
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
                <td className="px-5 py-4 text-right"><button onClick={() => openReview(c.id)} className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Review /</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length === 0 && <div className="p-10 text-center"><p className="font-serif text-lg">No candidates match these filters</p><p className="mt-1 text-[12px] text-ink-soft">Try clearing the search or switching the status tab.</p></div>}
    </section>

    {active && <ReviewSession commentsMandatory={(examBundle?.exam?.settings as { commentsMandatory?: boolean } | undefined)?.commentsMandatory === true} candidate={active} queue={gradeQueue} onClose={closeReview} onNavigate={navigateReview} onFinalize={finalizeGrade} notify={notify} profileName={profile?.full_name ?? "Faculty"} />}

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

function ReviewSession({ candidate, queue, onClose, onNavigate, onFinalize, notify, profileName, commentsMandatory }: {
  candidate: Candidate; queue: Candidate[]; commentsMandatory: boolean;
  onClose: () => void; onNavigate: (cid: string) => void;
  onFinalize: (cid: string, awarded: number) => Promise<void> | void; notify: (m: string) => void; profileName: string
}) {
  const cam = useEvaluatorCamera();
  const [manualScores, setManualScores] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [reviewRec, setReviewRec] = useState<{ attemptId: string; roll: string; name: string } | null>(null);

  const cid = candidate.id;
  const paper = candidate.paper;
  const max = paperMax(paper);
  const manualQs = paper.filter((q) => !isAuto(q));
  const autoTotal = round2(paper.filter(isAuto).reduce((t, q) => t + autoScore(q), 0));
  const manualTotal = manualQs.reduce((t, q) => t + (manualScores[key(cid, q.id)] ?? 0), 0);
  const gradedManual = manualQs.filter((q) => manualScores[key(cid, q.id)] != null).length;
  const awarded = paperTotal([autoTotal, manualTotal]);

  const setScore = (qid: string, marks: number, maxMarks: number) =>
    setManualScores((cur) => ({ ...cur, [key(cid, qid)]: Math.max(0, Math.min(maxMarks, Number.isNaN(marks) ? 0 : marks)) }));
  const setFb = (qid: string, v: string) => setFeedback((cur) => ({ ...cur, [key(cid, qid)]: v }));

  const idx = queue.findIndex((c) => c.id === cid);
  const position = idx >= 0 ? idx + 1 : 1;
  const prevCand = idx > 0 ? queue[idx - 1] : null;
  const nextCand = idx >= 0 && idx + 1 < queue.length ? queue[idx + 1] : null;
  const nextUngraded = queue.slice(idx + 1).find((c) => c.status !== "Graded") ?? queue.find((c) => c.id !== cid && c.status !== "Graded") ?? null;
  // Questions that already carry a saved grading comment (text, voice or image).
  const [commented, setCommented] = useState<Set<string>>(new Set());
  const [savingGrade, setSavingGrade] = useState(false);
  const [showMissing, setShowMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    setShowMissing(false);
    void listGradingComments(cid).then((rows) => {
      if (alive) setCommented(new Set(rows.map((r) => String(r.question_id))));
    });
    return () => { alive = false; };
  }, [cid]);
  const unscored = manualQs.filter((q) => manualScores[key(cid, q.id)] == null);
  const uncommented = commentsMandatory
    ? manualQs.filter((q) => !(feedback[key(cid, q.id)] ?? "").trim() && !commented.has(String(q.id)))
    : [];
  const blockers = [
    unscored.length ? `${unscored.length} written answer${unscored.length > 1 ? "s" : ""} still need a score` : null,
    uncommented.length ? `${uncommented.length} written answer${uncommented.length > 1 ? "s" : ""} need a comment (required for this exam)` : null,
  ].filter((b): b is string => !!b);

  const jumpTo = (qid: string) => document.getElementById(`q-${qid}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const finish = async (goNext: boolean) => {
    if (blockers.length) {
      setShowMissing(true);
      notify(blockers[0]);
      const first = unscored[0] ?? uncommented[0];
      if (first) jumpTo(first.id);
      return;
    }
    setSavingGrade(true);
    for (const q of manualQs) {
      const text = (feedback[key(cid, q.id)] ?? "").trim();
      if (text) await addGradingComment({ attemptId: cid, questionId: String(q.id), comment: text });
    }
    await onFinalize(cid, awarded);
    setSavingGrade(false);
    setFeedback((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith(`${cid}:`))));
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
      candidate.examId ?? "",
      candidate.studentId,
      "grading_moderation",
      `Answer paper of ${candidate.name} (${candidate.roll}) flagged for moderation by ${profileName}`,
      { severity: "critical", source: "teacher" },
    );
    notify("Flagged for moderation — logged in the violation report.");
  };

  const manualDone = manualQs.length - unscored.length;
  const openRecording = () => setReviewRec({ attemptId: candidate.id, roll: candidate.roll, name: candidate.name });

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-paper">
      <header className="flex shrink-0 items-center gap-4 border-b border-line bg-paper-raised px-4 py-2.5 lg:px-6">
        <button onClick={onClose} className="shrink-0 border border-line-strong px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">← Roster</button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-serif text-lg font-semibold leading-tight">
            {candidate.name} <span className="font-mono text-[11px] font-normal text-ink-soft">{candidate.roll}</span>
          </h2>
          <p className="truncate font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            {candidate.exam} · submitted {candidate.submittedAgo}
            {candidate.flags.length > 0 && <span className="text-alert"> · {candidate.flags.length} proctoring flags</span>}
          </p>
        </div>
        <div className="hidden items-center gap-1 md:flex">
          <button onClick={() => prevCand && onNavigate(prevCand.id)} disabled={!prevCand} title={prevCand ? `Previous · ${prevCand.name}` : "First in queue"} className="border border-line-strong px-2.5 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft enabled:hover:border-forest enabled:hover:text-ink disabled:opacity-40">‹</button>
          <span className="px-2 font-mono text-[10px] tabular-nums text-ink-soft" title="Position in grading queue">{position} of {queue.length}</span>
          <button onClick={() => nextCand && onNavigate(nextCand.id)} disabled={!nextCand} title={nextCand ? `Next · ${nextCand.name}` : "Last in queue"} className="border border-line-strong px-2.5 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft enabled:hover:border-forest enabled:hover:text-ink disabled:opacity-40">›</button>
        </div>
        <div className="shrink-0 border-l border-line pl-4 text-right">
          <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Score</p>
          <p className="font-serif text-xl leading-tight tabular-nums">{awarded}<span className="text-[13px] text-ink-soft"> / {max}</span></p>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[210px_minmax(0,1fr)_330px] lg:overflow-hidden">
        <nav aria-label="Questions" className="hidden border-r border-line bg-paper-raised lg:block lg:overflow-y-auto">
          <QuestionNav paper={paper} cid={cid} manualScores={manualScores} onJump={jumpTo} manualDone={manualDone} manualCount={manualQs.length} />
        </nav>

        <main className="min-w-0 px-5 py-6 lg:overflow-y-auto lg:px-10">
          <div className="mx-auto max-w-3xl space-y-5">
            {paper.map((q) => (
              <QuestionCard
                key={q.id} q={q} cid={cid} manualScores={manualScores} feedback={feedback} setScore={setScore} setFeedback={setFb}
                commentRequired={commentsMandatory && !commented.has(String(q.id))}
                showMissing={showMissing}
                onCommentSaved={() => setCommented((cur) => new Set(cur).add(String(q.id)))}
              />
            ))}
            {paper.length === 0 && <p className="py-16 text-center text-[13px] text-ink-soft">This paper has no questions.</p>}
          </div>
        </main>

        <aside className="border-t border-line bg-paper-raised lg:overflow-y-auto lg:border-l lg:border-t-0">
          <ScoreSummary awarded={awarded} max={max} autoTotal={autoTotal} manualTotal={manualTotal} gradedManual={gradedManual} manualCount={manualQs.length} blockers={blockers} saving={savingGrade} commentsMandatory={commentsMandatory} onFinish={() => void finish(false)} onFinishNext={() => void finish(true)} onFlagModeration={flagModeration} hasNext={Boolean(nextUngraded)} nextName={nextUngraded?.name} />
          <IntegrityPanel flags={candidate.flags} onOpenRecording={openRecording} />
          <div className="border-b border-line p-4"><AIIntegrityCard attemptId={cid} /></div>
          <EvaluatorCamera cam={cam} profileName={profileName} />
        </aside>
      </div>

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
  const [examId, setExamId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const vs = await listAttemptViolations(attemptId);
      if (!alive) return;
      setViolations(vs);
      // Exam id comes from the attempt itself (real), never a demo constant.
      const resolved = vs[0]?.exam_id ?? (await getAttemptExamId(attemptId));
      if (alive && resolved) setExamId(resolved);
    })();
    return () => { alive = false; };
  }, [attemptId]);
  if (!examId) return null;
  return <RecordingReviewModal examId={examId} roll={roll} name={name} violations={violations} onClose={onClose} />;
}

/** Self-view of the evaluator's camera. Display only: no AI checks run on the evaluator. */
function EvaluatorCamera({ cam, profileName }: { cam: ReturnType<typeof useEvaluatorCamera>; profileName: string }) {
  const { videoRef, state } = cam;
  const [hidden, setHidden] = useState(false);
  const showVideo = state === "connecting" || state === "live";
  return (
    <section className="p-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-ink-soft">
          <span className={`h-1.5 w-1.5 ${state === "live" ? "bg-success" : "bg-ink-soft"}`} />
          Your camera
        </p>
        {showVideo && <button onClick={() => setHidden((v) => !v)} className="font-mono text-[9px] uppercase tracking-wider text-ink-soft hover:text-ink">{hidden ? "Show" : "Hide"}</button>}
      </div>
      {showVideo ? (
        <div className={hidden ? "hidden" : "relative mt-3 aspect-video overflow-hidden border border-line bg-ink"}>
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
          {state === "connecting" && <div className="absolute inset-0 flex items-center justify-center font-mono text-[9px] uppercase tracking-wider text-paper/80">Starting camera…</div>}
          <span className="absolute bottom-1.5 left-1.5 bg-ink/70 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-paper">{profileName}</span>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-3 border border-line px-3 py-2.5 text-[12px] text-ink-soft">
          {state === "denied" ? "Camera blocked in browser" : "No camera available"}
          {(state === "denied" || state === "unavailable") && <button onClick={cam.retry} className="font-mono text-[9px] uppercase tracking-wider text-forest hover:underline">Try again</button>}
        </div>
      )}
      <p className="mt-2 text-[11px] text-ink-soft">Shown only to you. Nothing is recorded or analysed.</p>
    </section>
  );
}

function flagName(f: Flag): string {
  return f.label.replace(/^\[[^\]]+\]\s*/, "").replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+—.*$/, "").trim() || f.type || "Flag";
}

function IntegrityPanel({ flags, onOpenRecording }: { flags: Flag[]; onOpenRecording: () => void }) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; count: number; critical: number }>();
    for (const f of flags) {
      const name = flagName(f);
      const g = m.get(name) ?? { name, count: 0, critical: 0 };
      g.count += 1;
      if (f.severity === "critical") g.critical += 1;
      m.set(name, g);
    }
    return [...m.values()].sort((x, y) => y.critical - x.critical || y.count - x.count);
  }, [flags]);
  const critical = flags.filter((f) => f.severity === "critical").length;
  return (
    <section className="border-b border-line p-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam integrity</p>
        <button onClick={onOpenRecording} className="font-mono text-[9px] uppercase tracking-wider text-forest hover:underline">Watch recording →</button>
      </div>
      {flags.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-success">No proctoring flags during the exam.</p>
      ) : (
        <>
          <p className="mt-2 text-[13px]">
            <span className="font-medium tabular-nums">{flags.length}</span> flags
            {critical > 0 && <span className="text-alert"> · {critical} high severity</span>}
          </p>
          <ul className="mt-2 space-y-1">
            {groups.map((g) => (
              <li key={g.name} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`h-1.5 w-1.5 shrink-0 ${g.critical ? "bg-alert" : "bg-amber"}`} />
                  <span className="truncate" title={g.name}>{g.name}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-soft">{g.count}</span>
              </li>
            ))}
          </ul>
          <button onClick={() => setOpen((v) => !v)} className="mt-3 font-mono text-[9px] uppercase tracking-wider text-ink-soft hover:text-ink">
            {open ? "Hide timeline ▴" : "Show timeline ▾"}
          </button>
          {open && (
            <ol className="mt-2 max-h-64 overflow-y-auto border border-line bg-paper">
              {flags.map((f, i) => (
                <li key={i} className="flex items-center gap-2 border-b border-line/60 px-2.5 py-1.5 text-[11.5px] last:border-0">
                  <span className="w-11 shrink-0 font-mono text-[10px] tabular-nums text-ink-soft">{f.at?.replace(/^at /, "")}</span>
                  <span className={`h-1.5 w-1.5 shrink-0 ${f.severity === "critical" ? "bg-alert" : "bg-amber"}`} />
                  <span className="min-w-0 truncate" title={f.label}>{flagName(f)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function QuestionNav({ paper, cid, manualScores, onJump, manualDone, manualCount }: {
  paper: Question[]; cid: string; manualScores: Record<string, number>; onJump: (qid: string) => void; manualDone: number; manualCount: number;
}) {
  return (
    <div className="p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Questions</p>
      {manualCount > 0 && (
        <div className="mt-3">
          <p className="text-[12px]"><span className="font-medium tabular-nums">{manualDone}</span> of {manualCount} written answers scored</p>
          <div className="mt-1.5 h-1 bg-line"><div className="h-full bg-forest" style={{ width: `${(manualDone / manualCount) * 100}%` }} /></div>
        </div>
      )}
      <ol className="mt-4 space-y-1">
        {paper.map((q) => {
          const auto = isAuto(q);
          const scored = manualScores[key(cid, q.id)] != null;
          const value = auto ? autoScore(q) : scored ? manualScores[key(cid, q.id)] : null;
          const status = auto
            ? q.verdict === "correct" ? { text: "Correct", tone: "text-success" } : q.verdict === "wrong" ? { text: "Wrong", tone: "text-alert" } : { text: "Skipped", tone: "text-ink-soft" }
            : scored ? { text: "Scored", tone: "text-forest" } : { text: "To score", tone: "text-amber" };
          return (
            <li key={q.id}>
              <button onClick={() => onJump(q.id)} className={`flex w-full items-center gap-2.5 border px-2.5 py-2 text-left hover:border-forest ${!auto && !scored ? "border-amber/50 bg-amber/5" : "border-transparent"}`}>
                <span className="w-5 shrink-0 font-mono text-[11px] tabular-nums text-ink-soft">{q.no}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]">{typeLabel(q.type)}</span>
                  <span className={`block font-mono text-[9px] uppercase tracking-wider ${status.tone}`}>{status.text}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-soft">{value ?? "–"}/{q.marks}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function QuestionCard({ q, cid, manualScores, feedback, setScore, setFeedback, commentRequired, showMissing, onCommentSaved }: {
  q: Question; cid: string; manualScores: Record<string, number>; feedback: Record<string, string>;
  setScore: (qid: string, marks: number, maxMarks: number) => void; setFeedback: (qid: string, v: string) => void;
  commentRequired: boolean; showMissing: boolean; onCommentSaved: () => void;
}) {
  const auto = isAuto(q);
  const scored = manualScores[key(cid, q.id)] != null;
  const score = auto ? autoScore(q) : (manualScores[key(cid, q.id)] ?? 0);
  const full = score === q.marks;
  const autoBadge = q.verdict === "unanswered"
    ? `Auto · skipped · 0/${q.marks}`
    : score < 0 ? `Auto · wrong · −${-score} (negative)` : `Auto · ${score}/${q.marks}`;
  const badge = auto ? autoBadge : scored ? `Scored · ${score}/${q.marks}` : "Needs review";
  const badgeTone = auto ? (full ? "text-success" : score <= 0 ? "text-alert" : "text-amber") : scored ? "text-forest" : "text-amber";
  return (
    <section id={`q-${q.id}`} className={`scroll-mt-6 border bg-paper ${showMissing && !auto && !scored ? "border-amber" : "border-line"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper-raised px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Question {q.no} · {typeLabel(q.type)} · {q.marks} marks</p>
        <span className={`font-mono text-[10px] uppercase tracking-wider ${badgeTone}`}>{auto ? "◆ " : ""}{badge}</span>
      </div>
      <div className="p-4 sm:p-5">
        <p className="font-serif text-[16px] leading-snug">{q.prompt}</p>
        {(q.type === "MCQ" || q.type === "TrueFalse") && <McqAnswer q={q} />}
        {q.type === "MSQ" && <MsqAnswer q={q} />}
        {q.type === "Numerical" && <NumericalAnswer q={q} />}
        {(q.type === "Subjective" || q.type === "Coding") && <ManualAnswer q={q} cid={cid} score={score} scored={scored} feedback={feedback} setScore={setScore} setFeedback={setFeedback} commentRequired={commentRequired} showMissing={showMissing} onCommentSaved={onCommentSaved} />}
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
            {isCorrect && <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-success">{chosen ? <><FiCheck /> Student</> : <><FiCheck /> Correct</>}</span>}
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
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] ${markTone}`}>{isChosen ? <FiCheck /> : String.fromCharCode(65 + i)}</span>
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
  const correct = numericEqual(q.response, q.expected);
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

function ManualAnswer({ q, cid, score, scored, feedback, setScore, setFeedback, commentRequired, showMissing, onCommentSaved }: {
  q: Question; cid: string; score: number; scored: boolean; feedback: Record<string, string>;
  setScore: (qid: string, marks: number, maxMarks: number) => void; setFeedback: (qid: string, v: string) => void;
  commentRequired: boolean; showMissing: boolean; onCommentSaved: () => void;
}) {
  const fb = feedback[key(cid, q.id)] ?? "";
  // Detect uploaded answer: response starts with "[Uploaded answer: …]". The
  // payload used to be a 1-hour signed URL (which expired before grading) —
  // new submissions carry the STORAGE PATH, signed fresh below; legacy
  // http(s) payloads still display directly.
  const uploadedMatch = typeof q.response === "string" && q.response.startsWith("[Uploaded answer:")
    ? q.response.match(/^\[Uploaded answer:\s*(.+?)\s*\]$/)
    : null;
  const uploadRef = uploadedMatch?.[1]?.trim() ?? null;
  // Legacy signed URLs embed ".pdf?token=…" — test the whole reference.
  const uploadIsImage = uploadRef ? !uploadRef.toLowerCase().includes(".pdf") : false;
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(uploadRef && uploadRef.startsWith("http") ? uploadRef : null);

  // Mint a fresh signed URL for storage-path uploads (and, as a fallback,
  // resolve the row from question_submissions when the answer value itself is
  // missing — older sessions never stored it in the answer).
  useEffect(() => {
    if (!uploadRef || uploadRef.startsWith("http") || uploadRef.startsWith("blob:")) return;
    let alive = true;
    void getArtifactObjectUrl(uploadRef, 3600).then((signed) => {
      if (alive && signed) setUploadedUrl(signed);
    });
    return () => { alive = false; };
  }, [uploadRef]);

  // Grading comments (inline text + voice notes + image attachments) — persisted in grading_comments.
  const [comments, setComments] = useState<GradingComment[]>([]);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  // Teacher-side image attachment for a subjective answer (reference sheet,
  // evidence photo, model answer…). Stored like the student's scanned sheet,
  // with the storage KEY encoded in the comment so the signed URL is resolved
  // fresh at render time (mirrors the voice-note pattern, no schema change).
  const handleAttachImage = async (file: File) => {
    setAttaching(true);
    setAttachError(null);
    try {
      const compressed = await compressImage(file, { maxWidth: 1600, maxHeight: 2000, quality: 0.85 });
      const key = `grading/images/${cid}_${q.id}_${Date.now()}.jpg`;
      const stored = await uploadArtifactBlob(key, compressed, "image/jpeg");
      if (!stored) {
        setAttachError("Upload failed — storage unavailable");
        return;
      }
      const ok = await addGradingComment({
        attemptId: cid,
        questionId: String(q.id),
        comment: `[Image-key: ${stored.key}]`,
      });
      if (ok) loadComments();
      else setAttachError("Image uploaded but the comment could not be saved");
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setAttaching(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  const loadComments = () => {
    void listGradingComments(cid).then((rows) => {
      const mine = rows.filter((c) => String(c.question_id) === String(q.id));
      setComments(mine);
      if (mine.length) onCommentSaved();
    });
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

    const fetchUrl = async (path: string | null | undefined) => {
      if (!path) return;
      if (path.startsWith("http")) {
        setUploadedUrl(path);
      } else {
        const signed = await getArtifactObjectUrl(path, 3600);
        if (signed) setUploadedUrl(signed);
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
          void fetchUrl(data.uploaded_image_url);
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
        if (path) void fetchUrl(path);
      });
  }, [cid, q.id, uploadedMatch]);

  return (
    <div className="mt-4">
      {uploadRef && !uploadedUrl ? (
        <div className="border-l-2 border-forest bg-paper-raised p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-forest font-bold mb-2">✓ Uploaded Handwritten Answer</p>
          <div className="flex h-40 items-center justify-center border border-line bg-paper">
            <span className="animate-pulse font-mono text-[10px] uppercase tracking-widest text-ink-soft">Loading student's answer…</span>
          </div>
        </div>
      ) : uploadedUrl ? (
        <div className="border-l-2 border-forest bg-paper-raised p-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-forest font-bold mb-2">✓ Uploaded Handwritten Answer</p>
          {uploadIsImage ? (
            <a href={uploadedUrl} target="_blank" rel="noopener noreferrer">
              <img
                src={uploadedUrl}
                alt="Student's handwritten answer"
                className="w-full max-h-[600px] object-contain border border-line bg-paper cursor-zoom-in"
              />
            </a>
          ) : (
            <iframe
              src={`${uploadedUrl}#toolbar=0`}
              className="h-[600px] w-full border border-line bg-ink"
              title="Student's handwritten answer"
            />
          )}
          {!uploadIsImage && <p className="mt-2 font-mono text-[9px] text-ink-soft">Scanned PDF answer sheet</p>}
        </div>
      ) : q.type === "Coding" ? (
        <pre className="mt-1 overflow-x-auto border border-[#2b332c] bg-[#202924] p-4 font-mono text-[12px] leading-relaxed text-paper/90"><code>{q.response || "// no code submitted"}</code></pre>
      ) : (
        <article className="whitespace-pre-wrap border-l-2 border-forest bg-paper-raised p-4 text-[14px] leading-7">{q.response || "No answer submitted."}</article>
      )}
      <p className="mt-4 border-l-2 border-amber bg-amber/5 px-3 py-2 text-[11px] text-ink-soft">{q.type === "Coding" ? "Review the submitted code against the question's intent and award marks — this app has no hidden test-runner, so no score is fabricated automatically." : "Award marks by judging the answer against the question's expected points — no fabricated rubric is shown."}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Award</span>
          <input type="number" min={0} max={q.marks} value={scored ? score : ""} placeholder="–" onChange={(e) => setScore(q.id, Number(e.target.value), q.marks)} className={`w-16 border bg-paper px-2 py-1.5 text-center font-serif text-lg outline-none ${showMissing && !scored ? "border-amber" : "border-forest"}`} />
          <span className="font-serif text-[13px] text-ink-soft">/ {q.marks}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: q.marks + 1 }, (_, m) => <button key={m} onClick={() => setScore(q.id, m, q.marks)} className={`h-7 w-7 border font-mono text-[10px] ${scored && score === m ? "border-forest bg-forest text-paper" : "border-line-strong text-ink-soft hover:border-forest"}`}>{m}</button>)}
        </div>
      </div>
      <div className="mt-3 relative">
        <textarea value={fb} onChange={(e) => setFeedback(q.id, e.target.value)} rows={3} placeholder={commentRequired ? "Comment for the student (required for this exam)…" : "Comment for the student (optional) — saved with the grade…"} className={`block w-full resize-y border bg-paper px-3 py-2 pb-10 text-[13px] outline-none focus:border-forest ${showMissing && commentRequired && !fb.trim() ? "border-amber" : "border-line-strong"}`} />
        <div className="absolute bottom-2 left-2 flex flex-wrap items-center gap-2">
          <button onClick={() => void addInlineComment()} className="border border-line-strong px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">Inline Text Comment</button>
          <button onClick={() => void toggleVoice()} className="border border-line-strong px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink">
            {recording ? "■ Stop recording" : "Voice Comment"}
          </button>
          <button
            onClick={() => imageInputRef.current?.click()}
            disabled={attaching}
            className="flex items-center gap-1 border border-line-strong px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-ink disabled:opacity-60"
            title="Attach an image to this answer"
          >
            <FiPaperclip aria-hidden /> {attaching ? "Uploading…" : "Attach Image"}
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleAttachImage(f); }}
          />
        </div>
      </div>
      {commentRequired && showMissing && !fb.trim() && <p className="mt-1 text-[12px] text-amber">A comment is required on written answers for this exam.</p>}
      {attachError && <p className="mt-1 flex items-center gap-1.5 text-[12px] text-alert"><FiAlertTriangle aria-hidden /> {attachError}</p>}
      {comments.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {comments.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 border-l-2 border-forest bg-forest/5 px-3 py-2 text-[12px]">
              {c.comment.startsWith("[Image-key:") ? (
                <TeacherImageThumb comment={c.comment} />
              ) : (
                <span className="min-w-0 flex-1 text-ink">{c.comment || "Voice note"}</span>
              )}
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

function TeacherImageThumb({ comment }: { comment: string }) {
  const keyMatch = comment.match(/^\[Image-key:\s*(.+?)\s*\]$/);
  const storageKey = keyMatch ? keyMatch[1] : null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (storageKey) {
      void getArtifactObjectUrl(storageKey).then((u) => { if (alive && u) setUrl(u); });
    }
    return () => { alive = false; };
  }, [storageKey]);
  if (!storageKey) return <span className="min-w-0 flex-1 text-ink">{comment}</span>;
  return (
    <span className="min-w-0 flex-1">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
          <img src={url} alt="Teacher-attached image" className="max-h-40 w-auto border border-line bg-paper object-contain" />
        </a>
      ) : (
        <span className="font-mono text-[10px] text-ink-soft">loading image…</span>
      )}
    </span>
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

function ScoreSummary({ awarded, max, autoTotal, manualTotal, gradedManual, manualCount, blockers, saving, commentsMandatory, onFinish, onFinishNext, onFlagModeration, hasNext, nextName }: {
  awarded: number; max: number; autoTotal: number; manualTotal: number; gradedManual: number; manualCount: number;
  blockers: string[]; saving: boolean; commentsMandatory: boolean;
  onFinish: () => void; onFinishNext: () => void; onFlagModeration: () => void; hasNext: boolean; nextName?: string;
}) {
  const done = blockers.length === 0;
  return (
    <div className="border-b border-line p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Score summary</p>
      <div className="mt-3 flex items-end gap-3"><p className="font-serif text-4xl">{awarded}</p><p className="pb-1 font-serif text-lg text-ink-soft">/ {max}</p></div>
      <div className="mt-3 space-y-1.5 text-[12px]">
        <Row label="Auto-graded (objective)" value={`${autoTotal}`} />
        <Row label="Manual review (subjective + coding)" value={`${manualTotal}`} />
        <Row label="Manual answers scored" value={`${gradedManual} / ${manualCount}`} />
      </div>
      <div className={`mt-3 flex items-center gap-1.5 border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${done ? "border-success/40 bg-success/5 text-success" : "border-amber/40 bg-amber/5 text-amber"}`}>{done ? <><FiCheck /> Ready to record</> : <span className="space-y-0.5">{blockers.map((b) => <span key={b} className="block normal-case tracking-normal">{b}</span>)}</span>}</div>
      {commentsMandatory && manualCount > 0 && <p className="mt-2 text-[11px] text-ink-soft">This exam requires a comment on every written answer.</p>}
      <div className="mt-4 grid gap-2">
        {hasNext && <button onClick={onFinishNext} disabled={saving} className={`border border-forest bg-forest px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:opacity-50 ${done ? "" : "opacity-60"}`}>{saving ? "Saving…" : <>Save &amp; next / {nextName}</>}</button>}
        <button onClick={onFinish} disabled={saving} className={`border border-forest px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-forest hover:bg-success/5 disabled:opacity-50 ${done ? "" : "opacity-60"}`}>{saving ? "Saving…" : hasNext ? "Save & close" : "Save & finish"}</button>
        <button onClick={onFlagModeration} className="border border-alert/50 text-alert bg-alert/5 px-3 py-2 font-mono text-[10px] uppercase tracking-wider hover:bg-alert/10">Flag for Moderation</button>
      </div>
    </div>
  );
}












