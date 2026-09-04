import { useState, useEffect, useMemo } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import QuestionEditorV4 from "./QuestionEditorV4";
import ExaminerDashboard from "./ExaminerDashboard";
import ExamStudio from "./ExamStudio";
import TeacherExams from "./TeacherExams";
import TeacherQuestionBank from "./TeacherQuestionBank";
import TeacherQuestionSetup from "./TeacherQuestionSetup";
import TeacherStudents from "./TeacherStudents";
import TeacherSubmissions from "./TeacherSubmissions";
import TeacherEvaluation from "./TeacherEvaluation";
import { needsAttention } from "../data/examSession";
import useLiveAttempts from "../hooks/useLiveAttempts";
import {
  listExamsForTeacher,
  listLiveAttempts,
  setAttemptPaused,
  sendProctorMessage,
  updateExam,
  getExamRoster,
  saveTeacherSettings,
  getTeacherSettings,
  updateTeacherProfile,
  type ExamRecord,
} from "../lib/examApi";
import { downloadSessionReportPdf, downloadCsv, type ReportRow } from "../lib/sessionReport";
import { getSupabase } from "../lib/supabase";
import useCurrentProfile, { profileSubtitle } from "../hooks/useCurrentProfile";



export default function TeacherDashboard() {
  const location = useLocation();
  const navigate = useNavigate();
  const [toasts, setToasts] = useState<{id: number, msg: string}[]>([]);
  const notify = (msg: string) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };
  const { profile } = useCurrentProfile();
  
  const [createdExams, setCreatedExams] = useState<any[]>([]);
  const [loadingExams, setLoadingExams] = useState(true);

  useEffect(() => {
    let active = true;
    const fetchExams = async () => {
      setLoadingExams(true);
      const dbExams = await listExamsForTeacher();
      if (active && dbExams) {
        setCreatedExams(
          dbExams.map((e) => ({
            id: e.id,
            name: e.name,
            batch: e.batch,
            state: e.status === "draft" ? "Draft" : e.status === "scheduled" ? "Scheduled" : "Live",
            count: `${e.pool_count || 0} questions`,
            tone: e.status === "draft" ? "text-amber" : "text-success",
            progress: e.status === "draft" ? 18 : 100,
            schedule: e.scheduled_at,
            duration: e.duration_minutes,
            mode: e.mode,
          }))
        );
      }
      if (active) setLoadingExams(false);
    };
    fetchExams();
    return () => { active = false; };
  }, []);

  const pathParts = location.pathname.split("/").filter(Boolean);
  const section = pathParts[1] || "overview";
  const subSection = pathParts[2] || "";
  const examAction = pathParts[3] || "";

  // Fetch live attempts for the active exam for the nav badges
  const { data: attempts = [] } = useLiveAttempts("EXAM-2026-014");

  const liveAttemptsCount = attempts.filter((a) => a.state !== "Submitted").length;
  const submittedAttemptsCount = attempts.filter((a) => a.state === "Submitted").length;
  const needsAttentionCount = attempts.filter(needsAttention).length;

  const nav = getTeacherNav(liveAttemptsCount, submittedAttemptsCount, needsAttentionCount, createdExams.length);

  // Real average score across attempts that carry a score (auto-graded/updated).
  const scored = attempts.filter((a) => typeof a.score === "number");
  const avgScore = scored.length
    ? (scored.reduce((sum, a) => sum + (a.score as number), 0) / scored.length).toFixed(1)
    : null;

  return (
    <>
      <RoleLayout role="Teacher" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#284B34" items={nav}>
        {section === "overview" && <Overview notify={notify} navigate={navigate} examsList={createdExams} loading={loadingExams} avgScore={avgScore} scoredCount={scored.length} stats={{ live: liveAttemptsCount, submitted: submittedAttemptsCount, flagged: needsAttentionCount }} />}
    {section === "exams" && subSection === "new" && <TeacherExams notify={notify} navigate={navigate} exams={createdExams} autoCreate onCreate={(exam) => setCreatedExams((current) => [{ id: exam.id, name: exam.name, batch: exam.batch, state: exam.status === "draft" ? "Draft" : exam.status === "scheduled" ? "Scheduled" : "Live", count: `${exam.pool_count} questions`, tone: exam.status === "draft" ? "text-amber" : "text-success", progress: exam.status === "draft" ? 18 : 100, schedule: exam.scheduled_at, duration: exam.duration_minutes, mode: exam.mode }, ...current])} />}
    {section === "exams" && subSection && subSection !== "new" && examAction === "settings" && <ExamSettings notify={notify} navigate={navigate} examId={subSection} examsList={createdExams} />}
    {section === "exams" && subSection && subSection !== "new" && examAction === "build" && <ExamStudio notify={notify} navigate={navigate} examId={subSection} onSaved={(exam) => setCreatedExams((current) => { const rest = current.filter((e) => e.id !== exam.id); return [{ id: exam.id, name: exam.name, batch: exam.batch, state: exam.status === "draft" ? "Draft" : exam.status === "scheduled" ? "Scheduled" : "Live", count: `${exam.pool_count} questions`, tone: exam.status === "draft" ? "text-amber" : "text-success", progress: exam.status === "draft" ? 18 : 100, schedule: exam.scheduled_at, duration: exam.duration_minutes, mode: exam.mode }, ...rest]; })} />}
    {section === "exams" && subSection && subSection !== "new" && !examAction && <ExamWorkspace notify={notify} navigate={navigate} examId={subSection} examsList={createdExams} />}
    {section === "exams" && !subSection && <TeacherExams notify={notify} navigate={navigate} exams={createdExams} onCreate={(exam) => setCreatedExams((current) => [{ id: exam.id, name: exam.name, batch: exam.batch, state: exam.status === "draft" ? "Draft" : exam.status === "scheduled" ? "Scheduled" : "Live", count: `${exam.pool_count} questions`, tone: exam.status === "draft" ? "text-amber" : "text-success", progress: exam.status === "draft" ? 18 : 100, schedule: exam.scheduled_at, duration: exam.duration_minutes, mode: exam.mode }, ...current])} />}
    {section === "exams" && !subSection && <TeacherExams notify={notify} navigate={navigate} exams={createdExams} />}
    {section === "dashboard" && <ExaminerDashboard notify={notify} navigate={navigate} />}
    {section === "questions" && !subSection && <TeacherQuestionSetup notify={notify} navigate={navigate} exams={createdExams} />}
    {section === "questions" && subSection === "new" && <QuestionEditorV4 notify={notify} navigate={navigate} />}
    {section === "bank" && <TeacherQuestionBank notify={notify} navigate={navigate} />}
    {section === "students" && <TeacherStudents notify={notify} navigate={navigate} exams={createdExams} />}
    {section === "submissions" && <TeacherSubmissions notify={notify} />}
    {section === "evaluate" && <TeacherEvaluation notify={notify} />}
    {section === "reports" && <Reports notify={notify} />}
        {section === "settings" && <SettingsPanel notify={notify} />}
      </RoleLayout>
      
      <div className="fixed right-6 top-6 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="animate-fade-in border-l-2 border-alert bg-paper px-4 py-3 shadow-xl pointer-events-auto">
            <p className="font-serif text-[14px] text-ink">{t.msg}</p>
          </div>
        ))}
      </div>
    </>
  );
}

export function PageHeading({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: React.ReactNode }) { return <div className="flex flex-col justify-between gap-4 border-b border-line pb-6 md:flex-row md:items-end"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{eyebrow}</p><h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">{title}</h1><p className="mt-2 text-[13px] text-ink-soft">{detail}</p></div>{action && <div>{action}</div>}</div>; }
export function Button({ children, onClick, primary = false, disabled = false }: { children: React.ReactNode; onClick?: () => void; primary?: boolean; disabled?: boolean }) { return <button onClick={onClick} disabled={disabled} className={`border px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider ${disabled ? "cursor-not-allowed border-line-strong bg-line/30 text-ink-soft" : primary ? "border-forest bg-forest text-paper hover:bg-forest-light" : "border-line-strong text-ink-soft hover:border-forest hover:text-ink"}`}>{children}</button>; }
function Metric({ label, value, detail, tone, onClick }: { label: string; value: string; detail: string; tone: string; onClick?: () => void }) { return <div onClick={onClick} className={`border border-line bg-paper-raised p-5 ${onClick ? "cursor-pointer hover:border-forest" : ""}`}><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{label}</p><p className={`mt-2 font-serif text-3xl ${tone}`}>{value}</p><p className="mt-1 text-[12px] text-ink-soft">{detail}</p></div>; }
function Overview({ notify, navigate, examsList, loading, avgScore, scoredCount, stats }: { notify: (s: string) => void; navigate: (s: string) => void; examsList: any[]; loading: boolean; avgScore: string | null; scoredCount: number; stats: { live: number, submitted: number, flagged: number } }) {
  const { profile } = useCurrentProfile();
  return <><PageHeading eyebrow="Overview" title={`Good morning, ${profile?.full_name?.split(' ')[0] ?? 'Faculty'}.`} detail="Here is what needs your attention today." action={<Button primary onClick={() => navigate("/teacher/exams/new")}>+ New exam</Button>} /><div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Live candidates" value={String(stats.live)} detail="Currently active" tone="text-alert" onClick={() => navigate("/teacher/submissions")}/><Metric label="Needs review" value={String(stats.submitted)} detail={`${stats.flagged} flagged`} tone="text-amber" onClick={() => navigate("/teacher/evaluate")}/><Metric label="Question bank" value={String(examsList.reduce((acc, e) => acc + (parseInt(e.count) || 0), 0))} detail="Questions across exams" tone="text-forest" onClick={() => navigate("/teacher/questions")}/><Metric label="Avg. score" value={avgScore != null ? `${avgScore}%` : "—"} detail={avgScore != null ? `Across ${scoredCount} scored attempt(s)` : "No scored attempts yet"} tone="text-ink" onClick={() => navigate("/teacher/reports")}/></div><div className="mt-9 grid gap-8 xl:grid-cols-[1fr_340px]"><section><div className="flex items-center justify-between"><h2 className="font-serif text-xl font-semibold">Exam activity</h2><button onClick={() => navigate("/teacher/exams")} className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">Manage exams →</button></div><div className="mt-3 space-y-2">{loading ? <div className="p-5 text-center text-[12px] text-ink-soft">Loading...</div> : examsList.length === 0 ? <div className="p-5 text-center text-[12px] text-ink-soft">No exams found.</div> : examsList.slice(0, 5).map((exam) => <div key={exam.id} className="border border-line bg-paper p-5"><div className="flex flex-col justify-between gap-3 sm:flex-row"><div><p className="font-serif text-[16px] font-medium">{exam.name}</p><p className="mt-1 text-[12px] text-ink-soft">{exam.batch}</p></div><span className={`font-mono text-[10px] uppercase tracking-wider ${exam.tone}`}>{exam.state}</span></div><div className="mt-5 flex items-center gap-4"><div className="h-1.5 flex-1 bg-line"><div className="h-full bg-forest" style={{ width: `${exam.progress}%` }}/></div><span className="min-w-[110px] text-right font-mono text-[10px] text-ink-soft">{exam.count}</span></div></div>)}</div></section><aside><div className="flex items-center justify-between"><h2 className="font-serif text-xl font-semibold">Action queue</h2><span className="rounded-full bg-ink px-2 py-0.5 font-mono text-[9px] text-paper">{stats.flagged + stats.submitted}</span></div><div className="mt-3 divide-y divide-line border border-line">{[{ label: "Review flagged submissions", count: `${stats.flagged} pending`, to: "/teacher/submissions" }, { label: "Grade subjective answers", count: `${stats.submitted} remaining`, to: "/teacher/evaluate" }, { label: "Open performance reports", count: "Analytics", to: "/teacher/reports" }].map((item) => <button key={item.label} onClick={() => navigate(item.to)} className="flex w-full items-center justify-between gap-4 bg-paper-raised p-4 text-left hover:bg-paper"><span className="text-[13px]">{item.label}</span><span className="whitespace-nowrap font-mono text-[10px] text-amber">{item.count} →</span></button>)}</div></aside></div></>;
}






function ExamWorkspace({ notify, navigate, examId, examsList }: { notify: (s: string) => void; navigate: (s: string) => void; examId: string; examsList: any[] }) {
  const exam = examsList.find(e => e.id === examId);
  if (!exam) return <div className="p-10 text-center text-ink-soft">Loading exam workspace...</div>;
  if (exam.state === "Live") return <ExamDetail notify={notify} navigate={navigate} exam={exam} />;
  return <ExamWorkspacePage notify={notify} navigate={navigate} exam={exam} />;
}

function ExamWorkspacePage({ notify, navigate, exam }: { notify: (s: string) => void; navigate: (s: string) => void; exam: any }) {
  const [tab, setTab] = useState("Overview");
  const [roster, setRoster] = useState<{ email?: string | null }[]>([]);
  useEffect(() => {
    let active = true;
    void getExamRoster(exam.id).then((rows) => { if (active) setRoster(rows); });
    return () => { active = false; };
  }, [exam.id]);
  const setupRows: [string, string, boolean][] = [
    ["Course & batch", exam.batch, true],
    ["Schedule", exam.schedule || "Not scheduled", true],
    ["Duration", `${exam.duration || 45} minutes`, true],
    ["Security", `${exam.mode === "lockdown" ? "Lockdown enabled" : "Standard mode"}`, true],
  ];
  const emailVerified = roster.filter((r) => r.email && r.email.includes("@")).length;
  return <><PageHeading eyebrow={`Exams / ${exam.name}`} title={exam.name} detail={`Exam ID ${exam.id} · ${exam.batch}`} action={<Button onClick={() => navigate("/teacher/exams")}>← All exams</Button>} />
    <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border border-amber/30 bg-amber/5 px-5 py-4"><div><span className={`font-mono text-[10px] uppercase tracking-widest ${exam.tone}`}>{exam.state} · {exam.state === "Draft" ? "Not published" : "Ready"}</span><p className="mt-1 text-[13px]">Questions, delivery rules, difficulty and publishing are set in the paper builder for this test.</p></div><button onClick={() => navigate(`/teacher/exams/${exam.id}/build`)} className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Open paper builder →</button></div>
    <div className="mt-8 border-b border-line"><div className="flex gap-1 overflow-x-auto">{["Overview", "Questions", "Candidates", "Answers & results"].map((item) => <button key={item} onClick={() => setTab(item)} className={`whitespace-nowrap border-b-2 px-4 py-3 font-mono text-[10px] uppercase tracking-wider ${tab === item ? "border-forest text-forest" : "border-transparent text-ink-soft hover:text-ink"}`}>{item}</button>)}</div></div>
    {tab === "Overview" && <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_330px]"><section className="border border-line bg-paper p-6"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam setup</p><h2 className="mt-1 font-serif text-xl font-semibold">Configuration</h2></div><span className="font-mono text-[10px] text-success">✓ Ready</span></div><div className="mt-6 divide-y divide-line">{setupRows.map(([label, value, complete]) => <div key={label} className="flex items-center justify-between gap-4 py-4"><div><p className="text-[13px] font-medium">{label}</p><p className="mt-1 text-[12px] text-ink-soft">{value}</p></div><span className={`font-mono text-[10px] ${complete ? "text-success" : "text-amber"}`}>{complete ? "✓ Set" : "Review"}</span></div>)}<div className="flex items-center justify-between gap-4 py-4"><div><p className="text-[13px] font-medium">Question set & delivery</p><p className="mt-1 text-[12px] text-ink-soft">Managed in the Questions tab</p></div><button onClick={() => setTab("Questions")} className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Manage →</button></div></div></section><aside className="space-y-5"><section className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">At a glance</p><div className="mt-4 space-y-3"><InfoRow label="Questions" value={exam.count}/><InfoRow label="Duration" value={`${exam.duration}m`}/></div></section><section className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Questions & publishing</p><p className="mt-2 text-[13px] text-ink-soft">Build the pool, set how many each student gets, then publish — all in one flow.</p><button onClick={() => setTab("Questions")} className="mt-4 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Open Questions tab →</button></section><section className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Live controls</p><p className="mt-2 text-[13px] text-ink-soft">Auto-submit, late entry and in-exam rules.</p><button onClick={() => navigate(`/teacher/exams/${exam.id}/settings`)} className="mt-4 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Edit exam settings →</button></section></aside></div>}      {tab === "Questions" && <section className="mt-8 max-w-5xl"><InlineQuestionBuilder examId={exam.id} notify={notify} navigate={navigate} /></section>}
    {tab === "Candidates" && <section className="mt-8 max-w-4xl"><div className="flex items-end justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Assigned candidates</p><h2 className="mt-1 font-serif text-xl font-semibold">{exam.batch}</h2></div><Button onClick={() => navigate("/teacher/students")}>Manage roster</Button></div><div className="mt-4 grid gap-4 sm:grid-cols-3"><Metric label="Enrolled" value={String(roster.length)} detail="From enrollments" tone="text-ink"/><Metric label="Email verified" value={String(emailVerified)} detail={roster.length ? `${Math.round((emailVerified / roster.length) * 100)}% verified` : "No emails yet"} tone="text-success"/><Metric label="Access" value={exam.state === "Draft" ? "Locked" : "Open"} detail={exam.state === "Draft" ? "Until published" : "Join link live"} tone="text-amber"/></div><div className="mt-6 border border-line p-5 text-[13px] text-ink-soft">Candidates receive the join link automatically when this exam is published from the Question bank. Add or remove students on the <button onClick={() => navigate("/teacher/students")} className="font-mono text-[11px] uppercase tracking-wider text-forest hover:underline">Students page →</button></div></section>}
    {tab === "Answers & results" && <section className="mt-8 max-w-4xl"><AnswerReleaseControl notify={notify} examId={exam.id} /></section>}
  </>;
}
function InfoRow({ label, value }: { label: string; value: string }) { return <div className="flex justify-between border-b border-line pb-2 text-[12px] last:border-0"><span className="text-ink-soft">{label}</span><span>{value}</span></div>; }
function AnswerReleaseControl({ notify, examId }: { notify: (s: string) => void; examId: string }) {
  const [mode, setMode] = useState<"auto" | "manual">("manual");
  const [autoWhen, setAutoWhen] = useState<"submit" | "close">("close");
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const modes: { key: "auto" | "manual"; title: string; detail: string }[] = [
    { key: "auto", title: "Show automatically", detail: "Students see the correct answers and their auto-graded score without waiting for you." },
    { key: "manual", title: "Teacher reveals manually", detail: "Answers stay hidden until you choose to release them — safest while grading theory." },
  ];
  const persist = async (patch: Record<string, unknown>) => {
    setSaving(true);
    const ok = await updateExam(examId, { settings: patch });
    setSaving(false);
    notify(ok ? "Answer release settings saved" : "Could not save — database unavailable");
  };
  return <section className="mt-6 border border-line bg-paper p-5 sm:p-6">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Answer release</p><h3 className="mt-1 font-serif text-lg font-semibold">When can students see the correct answers?</h3><p className="mt-1 max-w-2xl text-[12px] text-ink-soft">Objective and coding questions are always scored instantly — this only controls when candidates may view the answer key and their result.</p></div><span className={`whitespace-nowrap border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${revealed ? "border-success bg-success/5 text-success" : mode === "auto" ? "border-forest bg-success/5 text-forest" : "border-amber bg-amber/5 text-amber"}`}>{saving ? "Saving…" : revealed ? "✓ Answers released" : mode === "auto" ? "Auto release on" : "Hidden · manual"}</span></div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2">{modes.map((m) => <button key={m.key} onClick={() => { setMode(m.key); setRevealed(false); void persist({ release_mode: m.key }); }} className={`border p-4 text-left ${mode === m.key ? "border-forest bg-success/5" : "border-line hover:border-line-strong"}`}><span className="flex items-center gap-2"><span className={`flex h-4 w-4 items-center justify-center rounded-full border ${mode === m.key ? "border-forest" : "border-line-strong"}`}>{mode === m.key && <span className="h-2 w-2 rounded-full bg-forest"/>}</span><span className="text-[13px] font-medium">{m.title}</span></span><span className="mt-2 block text-[12px] text-ink-soft">{m.detail}</span></button>)}</div>
    {mode === "auto" && <div className="mt-4 border-l-2 border-forest bg-success/5 px-4 py-3"><p className="font-mono text-[10px] uppercase tracking-wider text-forest">Release timing</p><div className="mt-2 flex flex-wrap gap-2">{([["submit", "As soon as each student submits"], ["close", "When the exam window closes"]] as const).map(([key, label]) => <button key={key} onClick={() => { setAutoWhen(key); void persist({ release_timing: key }); }} className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${autoWhen === key ? "border-forest bg-paper text-forest" : "border-line-strong text-ink-soft hover:text-ink"}`}>{label}</button>)}</div><p className="mt-2 text-[11px] text-ink-soft">Releasing while the exam is still live lets early finishers share the key — “when the exam window closes” is the safer default.</p></div>}
    {mode === "manual" && <div className="mt-4 flex flex-col justify-between gap-3 border-t border-line pt-4 sm:flex-row sm:items-center"><p className="text-[12px] text-ink-soft">{revealed ? "Answers are now visible to candidates in their results view." : "Answers are hidden. Reveal them once grading and review are complete."}</p><button onClick={() => { setRevealed(true); void persist({ results_published: true }); }} disabled={revealed || saving} className="whitespace-nowrap border border-forest bg-forest px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper enabled:hover:bg-forest-light disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-line/30 disabled:text-ink-soft">{revealed ? "✓ Answers released" : saving ? "Saving…" : "Reveal answers now"}</button></div>}
  </section>;
}

function InlineQuestionBuilder({ examId, notify, navigate }: { examId: string; notify: (s: string) => void; navigate: (s: string) => void }) {
  const [questions, setQuestions] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("Multiple choice");
  const [difficulty, setDifficulty] = useState("Medium");
  const [unit, setUnit] = useState("General");
  const [marks, setMarks] = useState(1);
  const [options, setOptions] = useState(["", "", "", ""]);
  const [answer, setAnswer] = useState("0");
  
  const isChoice = type === "Multiple choice";
  
  useEffect(() => {
    let mounted = true;
    import("../lib/examApi").then(({ loadExamBundle }) => {
      loadExamBundle(examId).then((bundle) => {
        if (mounted && bundle.questions) {
          setQuestions(bundle.questions);
        }
      });
    });
    return () => { mounted = false; };
  }, [examId]);
  
  const handleSave = async () => {
    if (!title.trim()) return notify("Please enter a question prompt.");
    
    // We import saveQuestion inline to avoid top-level import conflicts temporarily
    const { saveQuestion } = await import("../lib/examApi");
    const payload = {
      exam_id: examId,
      title,
      type: type === "Multiple choice" ? "MCQ" : type,
      marks,
      unit: unit.trim() || "General",
      difficulty,
      options: isChoice ? options.filter(o => o.trim() !== "") : null,
      answer: isChoice ? options[parseInt(answer)] || null : null,
    };
    const res = await saveQuestion(payload);
    if (res.ok && res.data) {
      setQuestions([...questions, res.data]);
      setIsAdding(false);
      setTitle("");
      setOptions(["", "", "", ""]);
      notify("Question saved to bank and exam pool.");
    } else {
      notify("Failed to save: " + res.error);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-serif text-2xl font-semibold">Exam Questions</h2>
          <p className="mt-1 text-[13px] text-ink-soft">Build or import questions for this assessment.</p>
        </div>
        <div className="flex gap-2">
          <Button primary onClick={() => setIsAdding(true)}>+ Quick Add</Button>
          <Button onClick={() => navigate(`/teacher/exams/${examId}/build`)}>Open full paper builder →</Button>
        </div>
      </div>
      
      {isAdding && (
        <div className="border border-forest bg-paper p-5 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-serif text-lg">New Question</h3>
            <button onClick={() => setIsAdding(false)} className="text-[12px] text-ink-soft hover:text-ink">Cancel</button>
          </div>
          
          <div className="space-y-4">
            <label className="block text-[12px] text-ink-soft">Question Type
              <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 block w-full sm:w-64 border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink">
                <option>Multiple choice</option>
                <option>Subjective</option>
                <option>Numerical</option>
                <option>Coding</option>
              </select>
            </label>
            
            <label className="block text-[12px] text-ink-soft">Prompt
              <textarea value={title} onChange={(e) => setTitle(e.target.value)} rows={3} placeholder="Type your question here..." className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-forest" />
            </label>
            
            {isChoice && (
              <div className="space-y-3">
                <p className="text-[12px] text-ink-soft">Options</p>
                {options.map((opt, i) => (
                  <div key={i} className="flex gap-3 items-center">
                    <input type="radio" name="correct" checked={answer === String(i)} onChange={() => setAnswer(String(i))} className="accent-forest" />
                    <input value={opt} onChange={(e) => {
                      const newOpts = [...options];
                      newOpts[i] = e.target.value;
                      setOptions(newOpts);
                    }} placeholder={`Option ${i + 1}`} className="block w-full border border-line-strong bg-paper px-3 py-2 text-[13px]" />
                  </div>
                ))}
              </div>
            )}
            
            <label className="block text-[12px] text-ink-soft">Marks
              <input type="number" min="1" value={marks} onChange={(e) => setMarks(Number(e.target.value))} className="mt-1 block w-24 border border-line-strong bg-paper px-3 py-2 text-[13px]" />
            </label>
            
            <div className="flex flex-wrap gap-4">
              <label className="block text-[12px] text-ink-soft">Difficulty
                <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className="mt-1 block w-36 border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink">
                  <option>Easy</option><option>Medium</option><option>Hard</option>
                </select>
              </label>
              <label className="block text-[12px] text-ink-soft">Unit / topic
                <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. Trees" className="mt-1 block w-48 border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-forest" />
              </label>
            </div>
            
            <div className="pt-2">
              <Button primary onClick={handleSave}>Save Question</Button>
            </div>
          </div>
        </div>
      )}
      
      <div className="border border-line bg-paper">
        <div className="border-b border-line bg-paper-raised px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          Current Pool ({questions.length})
        </div>
        <div className="divide-y divide-line">
          {questions.length === 0 ? (
            <div className="p-10 text-center">
              <p className="font-serif text-xl">No questions yet</p>
              <p className="mt-2 text-[12px] text-ink-soft">Click Quick Add, import from CSV, or open the full paper builder to pull questions from your bank.</p>
            </div>
          ) : (
            questions.map((q, i) => (
              <div key={q.id || i} className="p-5 flex justify-between gap-4 items-start">
                <div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[10px] text-ink-soft">{q.id}</span>
                    <span className="bg-paper-raised px-2 py-0.5 font-mono text-[9px] text-ink-soft">{q.type}</span>
                    <span className="bg-paper-raised px-2 py-0.5 font-mono text-[9px] text-ink-soft">{q.marks} marks</span>
                  </div>
                  <p className="mt-2 text-[14px]">{q.title}</p>
                </div>
                <button className="text-[11px] text-ink-soft hover:text-ink">Edit</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}function ExamDetail({ notify, navigate, exam }: { notify: (s: string) => void; navigate: (s: string) => void; exam: any }) { 
  const { data: liveAttempts = [] } = useLiveAttempts(exam.id);
  const submitted = liveAttempts.filter(a => a.state === "Submitted").length;
  const inProgress = liveAttempts.filter(a => a.state === "In progress").length;
  const pausedCount = liveAttempts.filter(a => a.state === "Paused").length;
  const offline = liveAttempts.filter(a => a.state === "Not started").length;
  const flagCount = liveAttempts.reduce((n, a) => n + a.flags.length, 0);
  const criticalFlags = liveAttempts.reduce((n, a) => n + a.flags.filter((f) => f.severity === "critical").length, 0);
  const [rosterCount, setRosterCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void getExamRoster(exam.id).then((rows) => { if (active) setRosterCount(rows.length); });
    return () => { active = false; };
  }, [exam.id]);
  const totalCandidates = rosterCount ?? Math.max(liveAttempts.length, 1);
  const pauseAll = async () => {
    setBusy(true);
    const rows = await listLiveAttempts(exam.id);
    let ok = 0;
    for (const r of rows) if (r.state === "in_progress" && (await setAttemptPaused(r.id, true))) ok += 1;
    setBusy(false);
    notify(ok ? `Paused ${ok} live attempt(s)` : "No live attempts to pause");
  };
  const broadcast = () => {
    const body = window.prompt("Announcement for all candidates:");
    if (!body?.trim()) return;
    void sendProctorMessage({ examId: exam.id, sender: "Teacher", senderRole: "teacher", body, kind: "broadcast" }).then((ok) =>
      notify(ok ? "Announcement broadcast to all candidates" : "Broadcast failed — database unavailable"),
    );
  };
  const exportReport = () => {
    const rows: ReportRow[] = liveAttempts.map((a) => ({
      name: a.name,
      roll: a.roll,
      state: a.state,
      progress: a.total ? Math.round((a.answered / a.total) * 100) : 0,
      violations: a.flags.map((f) => ({ description: f.label, type: "flag", severity: f.severity, offset_seconds: null, created_at: f.at })),
    }));
    downloadSessionReportPdf(exam.name, exam.id, rows);
    notify(`Session report exported · ${rows.length} candidates`);
  };
  return <><PageHeading eyebrow="Exams / Open" title={exam.name} detail={`${exam.batch} · Live session`} action={<Button onClick={() => navigate("/teacher/exams")}>← Back to exams</Button>} /><div className="mt-8 flex flex-wrap items-center justify-between gap-4 border border-alert/30 bg-alert/5 px-5 py-4"><div><p className="font-mono text-[10px] uppercase tracking-widest text-alert">Live session</p><p className="mt-1 text-[13px]">The exam is in progress. Candidate activity is updating in real time.</p></div><span className="font-mono text-[11px] text-alert">● Running</span></div><div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Candidates" value={String(totalCandidates)} detail={`${inProgress} active · ${pausedCount} paused · ${offline} not started`} tone="text-ink"/><Metric label="Submitted" value={String(submitted)} detail="Received" tone="text-success"/><Metric label="In progress" value={String(inProgress)} detail="Active now" tone="text-ink"/><Metric label="Flags" value={String(flagCount)} detail={`${criticalFlags} critical`} tone={flagCount ? "text-alert" : "text-ink"}/></div><div className="mt-8 grid gap-6 xl:grid-cols-[1fr_360px]"><div className="space-y-6"><section className="border border-line bg-paper p-6"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Session progress</p><h2 className="mt-2 font-serif text-xl font-semibold">Candidate completion</h2></div><span className="font-mono text-[10px] text-alert">LIVE NOW</span></div><div className="mt-6 h-3 bg-line"><div className="h-full bg-forest" style={{ width: `${Math.min(100, Math.max(0, (submitted / totalCandidates) * 100))}%` }}/></div><div className="mt-3 flex justify-between font-mono text-[10px] text-ink-soft"><span>{submitted} of {totalCandidates} submitted</span><span>{flagCount} flag(s)</span></div><div className="mt-7 grid gap-3 sm:grid-cols-3"><StatusRow label="Submitted" value={String(submitted)} tone="bg-success"/><StatusRow label="In progress" value={String(inProgress)} tone="bg-forest"/><StatusRow label="Paused" value={String(pausedCount)} tone="bg-amber"/></div></section><section className="border border-line"><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Recent activity</p><h2 className="mt-1 font-serif text-xl font-semibold">What is happening now</h2></div><Button onClick={() => navigate("/teacher/submissions")}>View all</Button></div><div className="divide-y divide-line">{liveAttempts.slice(0,4).map((a) => <div key={a.id} className="flex gap-4 px-5 py-4"><span className="w-16 shrink-0 font-mono text-[10px] text-ink-soft"></span><div><p className="text-[13px]">{a.name}</p><p className="mt-1 text-[11px] text-ink-soft">{a.state}{a.flags.length ? ` · ${a.flags.length} flag(s)` : ""}</p></div></div>)}</div></section></div><aside className="space-y-6"><section className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam controls</p><div className="mt-4 grid gap-2"><Button onClick={() => void pauseAll()}>{busy ? "Pausing…" : "Pause exam"}</Button><Button onClick={broadcast}>Broadcast message</Button><Button onClick={() => navigate(`/teacher/exams/${exam.id}/settings`)}>Edit settings</Button><Button onClick={exportReport}>Export live report</Button></div></section><section className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam information</p><div className="mt-4 space-y-3 text-[12px]"><Info label="Questions" value={exam.count}/><Info label="Duration" value={`${exam.duration} minutes`}/><Info label="Security" value={exam.mode === "lockdown" ? "Lockdown Browser" : "Standard"}/><Info label="Assigned" value={exam.batch}/></div></section></aside></div></>; }

function StatusRow({ label, value, tone }: { label: string; value: string; tone: string }) { return <div><div className="flex items-center gap-2"><span className={`h-2 w-2 ${tone}`}/><span className="font-mono text-[11px] text-ink-soft">{label}</span></div><p className="mt-1 pl-4 font-serif text-xl">{value}</p></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3 border-b border-line pb-2 last:border-0"><span className="text-ink-soft">{label}</span><span className="text-right">{value}</span></div>; }
function ExamSettings({ notify, navigate, examId, examsList }: { notify: (s: string) => void; navigate: (s: string) => void; examId: string; examsList: any[] }) {
  const exam = examsList.find(e => e.id === examId);
  const initial = (exam?.settings ?? {}) as Record<string, any>;
  const [allowLateEntry, setAllowLateEntry] = useState<boolean>(initial.allow_late_entry !== false);
  const [allowQuestions, setAllowQuestions] = useState<boolean>(initial.allow_candidate_questions !== false);
  const [autoSubmitEnabled, setAutoSubmitEnabled] = useState<boolean>(initial.auto_submit !== false);
  const [onTimeLimit, setOnTimeLimit] = useState<boolean>(initial.auto_submit_on_time_limit !== false);
  const [onViolationCount, setOnViolationCount] = useState<boolean>(initial.auto_submit_on_violation_count !== false);
  const [violationLimit, setViolationLimit] = useState<number>(Number(initial.violation_count_threshold ?? 3));
  const [saving, setSaving] = useState(false);
  if (!exam) return <div className="p-10 text-center">Loading...</div>;
  const save = async () => {
    setSaving(true);
    const ok = await updateExam(examId, {
      settings: {
        allow_late_entry: allowLateEntry,
        allow_candidate_questions: allowQuestions,
        auto_submit: autoSubmitEnabled,
        auto_submit_on_time_limit: onTimeLimit,
        auto_submit_on_violation_count: onViolationCount,
        violation_count_threshold: violationLimit,
      },
    });
    setSaving(false);
    notify(ok ? "Exam settings saved" : "Could not save — database unavailable");
  };
  return <><PageHeading eyebrow="Exams / Settings" title="Exam settings" detail="Update the exam configuration carefully." action={<Button onClick={() => navigate(`/teacher/exams/${examId}`)}>← Back to exam</Button>} /><div className="mt-8 max-w-2xl space-y-6"><div className="border border-line p-6"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam configuration</p><div className="mt-5 grid gap-5 sm:grid-cols-2"><Field label="Exam title" value={exam.name}/><Field label="Assigned batch" value={exam.batch}/><Field label="Duration" value={`${exam.duration}m`}/><Field label="Proctoring tier" value={exam.mode === "lockdown" ? "Lockdown Browser" : "Standard"}/></div></div><div className="border border-line p-6"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Live controls</p><div className="mt-4 space-y-4 text-[13px]"><label className="flex items-center justify-between gap-4"><span>Allow late entry</span><input type="checkbox" checked={allowLateEntry} onChange={(e) => setAllowLateEntry(e.target.checked)} className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Allow candidate questions</span><input type="checkbox" checked={allowQuestions} onChange={(e) => setAllowQuestions(e.target.checked)} className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Auto-submit enabled</span><input type="checkbox" checked={autoSubmitEnabled} onChange={(e) => setAutoSubmitEnabled(e.target.checked)} className="h-4 w-4 accent-forest"/></label>{autoSubmitEnabled && <><label className="flex items-center justify-between gap-4"><span>Auto-submit at time limit</span><input type="checkbox" checked={onTimeLimit} onChange={(e) => setOnTimeLimit(e.target.checked)} className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Auto-submit on violation count</span><input type="checkbox" checked={onViolationCount} onChange={(e) => setOnViolationCount(e.target.checked)} className="h-4 w-4 accent-forest"/></label>{onViolationCount && <label className="block text-[12px] text-ink-soft">Violation count threshold<input type="number" min="1" max="20" value={violationLimit} onChange={(e) => setViolationLimit(Math.max(1, Number(e.target.value)))} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px]"/></label>}</>}</div></div><div className="flex gap-2"><Button primary onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</Button><Button onClick={() => navigate(`/teacher/exams/${examId}`)}>Cancel</Button></div></div></>; }
function SelectField({ label, options, value, onChange }: { label: string; options: string[]; value?: string; onChange?: (value: string) => void }) { return <label className="block text-[12px] text-ink-soft">{label}<select value={value} onChange={(e) => onChange?.(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink">{options.map((option) => <option key={option}>{option}</option>)}</select></label>; }


export const getTeacherNav = (liveAttemptsCount: number, submittedAttemptsCount: number, needsAttentionCount: number, examCount = 0) => [
  { label: "Overview", to: "/teacher", end: true },
  { label: "Dashboard", to: "/teacher/dashboard" },
  { label: "Exams", to: "/teacher/exams", badge: examCount ? String(examCount) : undefined },
  { label: "Question bank", to: "/teacher/questions" },
  { label: "My questions", to: "/teacher/bank" },
  { label: "Students", to: "/teacher/students" },
  { label: "Submissions", to: "/teacher/submissions", badge: String(liveAttemptsCount) },
  { label: "Evaluate", to: "/teacher/evaluate", badge: String(submittedAttemptsCount) },
  { label: "Proctoring", to: "/teacher/proctoring", badge: String(needsAttentionCount) },
  { label: "Reports", to: "/teacher/reports" },
  { label: "Settings", to: "/teacher/settings" },
];

function Reports({ notify }: { notify: (s: string) => void }) {
  const [activeTab, setActiveTab] = useState("Overview");
  const [exams, setExams] = useState<ExamRecord[]>([]);
  const [examId, setExamId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const { data: liveAttempts = [] } = useLiveAttempts(examId || "EXAM-2026-014");

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
    progress: a.total ? Math.round((a.answered / a.total) * 100) : 0,
    violations: a.flags.map((f) => ({ description: f.label, type: "flag", severity: f.severity, offset_seconds: null, created_at: f.at })),
  });
  const exportPdf = () => {
    downloadSessionReportPdf(selectedExam?.name ?? "Exam", examId || "all", liveAttempts.map(toReportRow));
    notify(`Session report exported · ${liveAttempts.length} candidates`);
  };
  const exportCsv = () => {
    downloadCsv(
      `results_${examId || "all"}`,
      ["Candidate", "Roll", "State", "Answered", "Total", "Score", "Flags"],
      liveAttempts.map((a) => [a.name, a.roll, a.state, a.answered, a.total, a.score ?? "", a.flags.length]),
    );
    notify(`Results CSV exported · ${liveAttempts.length} rows`);
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
      <PageHeading eyebrow="Reports" title="Performance reports" detail="Live stats, exports, and result publishing — straight from the database." action={
        <div className="flex flex-wrap items-center gap-2">
          <select value={examId} onChange={(e) => setExamId(e.target.value)} className="border border-line-strong bg-paper px-2 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
            {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            {exams.length === 0 && <option value="EXAM-2026-014">Data Structures & Algorithms</option>}
          </select>
          <Button onClick={() => void releaseResults()}>{busy ? "Releasing…" : resultsPublished ? "✓ Results Released" : "Release Results"}</Button>
          <Button onClick={() => void publishAnswerKey()}>{answerKeyPublished ? "✓ Answer Key Published" : "Publish Answer Key"}</Button>
          <Button onClick={exportPdf}>Export PDF</Button>
          <Button onClick={exportCsv}>Export CSV</Button>
        </div>
      } />
      <div className="mt-8 flex gap-2 border-b border-line pb-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
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
              <span className="font-mono text-[10px] text-ink-soft">{scores.length} scored attempt(s)</span>
            </div>
            <div className="mt-8 flex h-44 items-end gap-3 border-b border-line px-4">
              {buckets.map((count, i) => (
                <div key={i} className="group flex flex-1 flex-col items-center gap-2">
                  <span className="font-mono text-[9px] text-ink-soft">{count || ""}</span>
                  <div className="w-full bg-forest/40 transition-colors group-hover:bg-forest/80" style={{ height: `${Math.round((count / maxBucket) * 100)}%` }}/>
                  <span className="font-mono text-[9px] text-ink-soft">{i * 10}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-center font-mono text-[10px] text-ink-soft uppercase tracking-widest">Score Brackets (%)</p>
          </div>
          {flagged.length > 0 && <div className="mt-6 border border-alert/30 bg-alert/5 p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-alert">Proctoring flags</p><p className="mt-2 text-[13px]">{flagged.length} candidate(s) carry violation flags in this exam — review recordings before finalising marks.</p></div>}
        </>
      )}

      {activeTab === "Item Analysis" && <QuestionItemAnalysis examId={examId} />}

      {activeTab === "Student Reports" && (
        <div className="mt-8 border border-line bg-paper">
          <div className="flex items-center justify-between border-b border-line bg-paper-raised px-5 py-3">
            <div><h2 className="font-serif text-lg font-semibold">Individual Student Reports</h2>
            <p className="mt-1 font-mono text-[10px] text-ink-soft">Per-candidate session PDFs from the live roster.</p></div>
            <Button onClick={() => { submitted.forEach((a) => downloadSessionReportPdf(selectedExam?.name ?? "Exam", `${examId}-${a.roll}`, [toReportRow(a)])); notify(`Exported ${submitted.length} PDF(s)`); }} disabled={submitted.length === 0}>Generate All PDFs</Button>
          </div>
          <div className="divide-y divide-line">
            {submitted.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <div><p className="text-[13px] font-medium">{a.name}</p><p className="mt-0.5 font-mono text-[10px] text-ink-soft">{a.roll} · {a.answered}/{a.total} answered · score {a.score != null ? `${a.score}%` : "pending"}</p></div>
                <Button onClick={() => { downloadSessionReportPdf(selectedExam?.name ?? "Exam", `${examId}-${a.roll}`, [toReportRow(a)]); }}>PDF</Button>
              </div>
            ))}
            {submitted.length === 0 && <p className="px-5 py-10 text-center text-[12px] text-ink-soft">No submissions for this exam yet.</p>}
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
    import("../lib/examApi").then(({ loadExamBundle }) => {
      loadExamBundle(examId).then((bundle) => { if (active && bundle.questions) setQuestions(bundle.questions as typeof questions); });
    });
    return () => { active = false; };
  }, [examId]);
  return (
    <div className="mt-8 border border-line bg-paper">
      <div className="border-b border-line bg-paper-raised px-5 py-3">
        <h2 className="font-serif text-lg font-semibold">Question pool · Item Analysis</h2>
        <p className="mt-1 font-mono text-[10px] text-ink-soft">Real question pool for this exam — {questions.length} question(s).</p>
      </div>
      {questions.length === 0 ? (
        <div className="p-10 text-center"><p className="font-serif text-lg">No questions in this exam's pool</p><p className="mt-2 text-[12px] text-ink-soft">Add questions from the Question bank, then come back for item stats.</p></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-[13px]">
            <thead><tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-ink-soft"><th className="px-5 py-3">ID</th><th className="px-5 py-3">Question</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Unit</th><th className="px-5 py-3">Difficulty</th><th className="px-5 py-3">Marks</th></tr></thead>
            <tbody>
              {questions.map((q) => (
                <tr key={q.id} className="border-b border-line last:border-0 hover:bg-paper-raised">
                  <td className="px-5 py-3 font-mono text-[11px] text-ink-soft">{q.id}</td>
                  <td className="max-w-[320px] truncate px-5 py-3">{q.title}</td>
                  <td className="px-5 py-3">{q.type}</td>
                  <td className="px-5 py-3 text-ink-soft">{q.unit ?? "—"}</td>
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
  if (stats.length === 0) return <div className="mt-8 border border-line bg-paper p-10 text-center"><p className="font-serif text-lg">No exam data yet</p><p className="mt-2 text-[12px] text-ink-soft">Submission trends appear here once candidates start attempting your exams.</p></div>;
  const maxTotal = Math.max(1, ...stats.map((s) => s.total));
  return (
    <div className="mt-8 border border-line bg-paper p-6">
      <h2 className="font-serif text-lg font-semibold">Submission trends by exam</h2>
      <p className="mt-1 font-mono text-[10px] text-ink-soft">Live attempt counts per exam.</p>
      <div className="mt-6 space-y-4">
        {stats.map((s) => (
          <div key={s.id} className="flex items-center gap-4">
            <span className="w-56 truncate text-[13px]">{s.name}</span>
            <div className="h-3 flex-1 bg-line"><div className="h-full bg-forest" style={{ width: `${Math.round((s.total / maxTotal) * 100)}%` }} /></div>
            <span className="w-28 shrink-0 text-right font-mono text-[10px] text-ink-soft">{s.submitted}/{s.total} submitted</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsPanel({ notify }: { notify: (s: string) => void }) {
  const [tab, setTab] = useState("Profile");
  const { profile } = useCurrentProfile();
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [name, setName] = useState(profile?.full_name ?? "");
  const [department, setDepartment] = useState(profile?.kind === "teacher" ? (profile.department ?? "") : "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [apiKey, setApiKey] = useState("");
  const [template, setTemplate] = useState({ subject: "You are invited to {exam_name}", body: "Dear {candidate_name},\n\nYou have been enrolled in {exam_name}.\n\nPlease ensure your system meets the requirements." });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void getTeacherSettings().then((s) => {
      if (!active) return;
      setSettings(s);
      setApiKey(String(s.api_key ?? ""));
      if (s.email_template_subject) setTemplate((t) => ({ ...t, subject: String(s.email_template_subject) }));
      if (s.email_template_body) setTemplate((t) => ({ ...t, body: String(s.email_template_body) }));
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (profile?.full_name) setName(profile.full_name);
    if (profile?.kind === "teacher" && profile.department) setDepartment(profile.department);
    if (profile?.email) setEmail(profile.email);
  }, [profile]);

  const setFlag = (key: string, value: boolean) => setSettings((cur) => ({ ...cur, [key]: value }));
  const saveProfile = async () => {
    setSaving(true);
    const ok = await updateTeacherProfile({ full_name: name, department, email });
    setSaving(false);
    notify(ok ? "Profile saved" : "Could not save profile — database unavailable");
  };
  const saveAll = async () => {
    setSaving(true);
    const ok = await saveTeacherSettings({ ...settings, email_template_subject: template.subject, email_template_body: template.body, api_key: apiKey });
    setSaving(false);
    notify(ok ? "Settings saved" : "Could not save settings — database unavailable");
  };
  const generateKey = async () => {
    const key = `fb_live_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    setApiKey(key);
    const ok = await saveTeacherSettings({ api_key: key });
    notify(ok ? "New API key generated and stored" : "Key generated but could not be stored");
  };
  const copyKey = async () => {
    if (!apiKey) { notify("No API key yet — generate one first"); return; }
    try { await navigator.clipboard.writeText(apiKey); notify("API key copied to clipboard"); } catch { notify("Clipboard unavailable — select and copy manually"); }
  };
  const sendTestEmail = async () => {
    const db = getSupabase();
    if (!db) { notify("Email service unavailable (offline)"); return; }
    const { error } = await db.functions.invoke("send-reminder-email", { body: { examId: "EXAM-2026-014", studentEmail: email || profile?.email || null } });
    notify(error ? `Test email failed: ${error.message}` : "Test email sent");
  };
  const b = (key: string) => settings[key] !== false;
  return <><PageHeading eyebrow="Settings" title="Teacher workspace settings" detail="Control your profile, exam defaults, security rules, and notifications."/><div className="mt-8 grid gap-8 lg:grid-cols-[210px_1fr]"><nav className="space-y-1">{["Profile", "Department defaults", "Security & proctoring", "Notifications", "Email templates", "Integrations", "API keys"].map((item) => <button key={item} onClick={() => setTab(item)} className={`w-full border-l-2 px-3 py-2.5 text-left text-[13px] ${tab === item ? "border-forest bg-paper-raised text-forest" : "border-transparent text-ink-soft hover:bg-paper-raised hover:text-ink"}`}>{item}</button>)}</nav><div className="max-w-3xl border border-line bg-paper p-6 sm:p-8">{tab === "Profile" && <SettingsSection title="Faculty profile" detail="This information appears on exam instructions and reports."><div className="grid gap-5 sm:grid-cols-2"><EditableField label="Full name" value={name} onChange={setName}/><EditableField label="Department" value={department} onChange={setDepartment}/><EditableField label="Email address" value={email} onChange={setEmail}/></div><div className="mt-5 flex justify-end"><Button primary onClick={() => void saveProfile()}>{saving ? "Saving…" : "Save profile"}</Button></div></SettingsSection>}{tab === "Department defaults" && <SettingsSection title="Department defaults" detail="These values prefill whenever you create a new exam."><div className="grid gap-5 sm:grid-cols-2"><SelectField label="Default duration" options={["00:45", "01:00", "01:30"]} value={String(settings.default_duration ?? "00:45")} onChange={(v) => setSettings((c) => ({ ...c, default_duration: v }))}/><SelectField label="Default question type" options={["Mixed question set", "MCQ only", "Subjective only"]} value={String(settings.default_question_type ?? "Mixed question set")} onChange={(v) => setSettings((c) => ({ ...c, default_question_type: v }))}/><SelectField label="Default batch" options={["CSE — Sem III", "CSE — Sem V", "ECE — Sem III"]} value={String(settings.default_batch ?? "CSE — Sem III")} onChange={(v) => setSettings((c) => ({ ...c, default_batch: v }))}/><SelectField label="Default proctoring" options={["AI Proctoring", "Basic Lockdown", "Live Proctoring"]} value={String(settings.default_proctoring ?? "AI Proctoring")} onChange={(v) => setSettings((c) => ({ ...c, default_proctoring: v }))}/></div><Toggle label="Auto-save exam drafts" detail="Save changes as you move through the exam builder." checked={b("auto_save_drafts")} onChange={(v) => setFlag("auto_save_drafts", v)}/><Toggle label="Shuffle questions by default" detail="Randomize question order for each candidate." checked={b("shuffle_questions")} onChange={(v) => setFlag("shuffle_questions", v)}/></SettingsSection>}{tab === "Security & proctoring" && <SettingsSection title="Security & proctoring" detail="Set the minimum security standard for new assessments."><Toggle label="Require camera and microphone" detail="Candidates must pass device checks before starting." checked={b("require_camera")} onChange={(v) => setFlag("require_camera", v)}/><Toggle label="Block tab switching and copy/paste" detail="Lock the exam window during active sessions." checked={b("block_tab_switch")} onChange={(v) => setFlag("block_tab_switch", v)}/><Toggle label="Enable second-face detection" detail="Create a flag when another face enters the frame." checked={b("second_face_detection")} onChange={(v) => setFlag("second_face_detection", v)}/><Toggle label="Allow late entry" detail="Let candidates join after the scheduled start time." checked={settings.allow_late_entry === true} onChange={(v) => setFlag("allow_late_entry", v)}/></SettingsSection>}{tab === "Notifications" && <SettingsSection title="Notifications" detail="Choose which events should reach your faculty inbox."><Toggle label="Critical proctoring flags" detail="Notify immediately when a severe incident is detected." checked={b("notify_critical_flags")} onChange={(v) => setFlag("notify_critical_flags", v)}/><Toggle label="Submission milestones" detail="Notify when 25%, 50%, 75%, and 100% submit." checked={b("notify_submission_milestones")} onChange={(v) => setFlag("notify_submission_milestones", v)}/><Toggle label="Evaluation reminders" detail="Send a daily reminder for ungraded subjective answers." checked={settings.evaluation_reminders === true} onChange={(v) => setFlag("evaluation_reminders", v)}/><SelectField label="Daily summary time" options={["08:00 AM", "12:00 PM", "06:00 PM"]} value={String(settings.daily_summary_time ?? "08:00 AM")} onChange={(v) => setSettings((c) => ({ ...c, daily_summary_time: v }))}/></SettingsSection>}{tab === "Email templates" && <SettingsSection title="Email templates" detail="Customize automated emails sent to candidates."><div className="grid gap-5"><label className="block text-[12px] text-ink-soft">Subject<input value={template.subject} onChange={(e) => setTemplate((t) => ({ ...t, subject: e.target.value }))} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/></label><label className="block text-[12px] text-ink-soft">Body<textarea rows={6} value={template.body} onChange={(e) => setTemplate((t) => ({ ...t, body: e.target.value }))} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/></label><div className="flex gap-2"><Button primary onClick={() => void saveAll()}>{saving ? "Saving…" : "Save Template"}</Button><Button onClick={() => void sendTestEmail()}>Send Test Email</Button></div></div></SettingsSection>}{tab === "Integrations" && <SettingsSection title="Integrations" detail="Connect the tools your department already uses."><Integration name="Canvas Gradebook" detail="Two-way sync for scores and rubrics" connected={false}/><Integration name="Vignan LMS" detail="Roster sync and result publishing" connected/><Integration name="Institution email" detail="Send exam invitations and alerts" connected/><Integration name="Plagiarism review" detail="Optional post-submission similarity checks"/></SettingsSection>}{tab === "API keys" && <SettingsSection title="API keys" detail="Manage programmatic access to your assessment data."><div className="space-y-4"><div className="flex items-center justify-between gap-3 border border-line p-4"><div className="min-w-0"><p className="font-mono text-[13px] font-medium">Production API Key</p><p className="mt-1 break-all font-mono text-[11px] text-ink-soft">{apiKey || "No key generated yet"}</p></div><Button onClick={() => void copyKey()}>Copy Key</Button></div><Button primary onClick={() => void generateKey()}>+ Generate New Key</Button></div></SettingsSection>}<div className="mt-8 flex justify-end border-t border-line pt-5"><Button primary onClick={() => void saveAll()}>{saving ? "Saving…" : "Save changes"}</Button></div></div></div></>; }
function SettingsSection({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) { return <section><h2 className="font-serif text-2xl font-semibold">{title}</h2><p className="mt-2 text-[13px] text-ink-soft">{detail}</p><div className="mt-7 space-y-5">{children}</div></section>; }
function EditableField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) { return <label className="block text-[12px] text-ink-soft">{label}<input value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/></label>; }
function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (v: boolean) => void }) { return <label className="flex items-start justify-between gap-5 border-b border-line pb-4"><span><span className="block text-[13px] font-medium">{label}</span><span className="mt-1 block text-[12px] text-ink-soft">{detail}</span></span><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-4 w-4 accent-forest"/></label>; }
function Integration({ name, detail, connected = false }: { name: string; detail: string; connected?: boolean }) { return <div className="flex items-center justify-between gap-4 border-b border-line pb-4"><span><span className="block text-[13px] font-medium">{name}</span><span className="mt-1 block text-[12px] text-ink-soft">{detail}</span></span><span className={`font-mono text-[10px] uppercase tracking-wider ${connected ? "text-success" : "text-ink-soft"}`}>{connected ? "Connected" : "Connect"}</span></div>; }
function Field({ label, value }: { label: string; value: string }) { return <label className="text-[12px] text-ink-soft">{label}<input value={value} readOnly className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink"/></label>; }


