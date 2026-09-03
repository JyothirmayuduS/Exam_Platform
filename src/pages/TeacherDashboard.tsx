import { useState, useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import RoleLayout from "../components/RoleLayout";
import ExamWizard from "../components/teacher/ExamWizard";
import QuestionEditorV4 from "./QuestionEditorV4";
import TeacherQuestionSetup from "./TeacherQuestionSetup";
import TeacherStudents from "./TeacherStudents";
import TeacherSubmissions from "./TeacherSubmissions";
import TeacherEvaluation from "./TeacherEvaluation";
import { needsAttention } from "../data/examSession";
import useLiveAttempts from "../hooks/useLiveAttempts";
import { listExamsForTeacher, type ExamRecord } from "../lib/examApi";
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

  const nav = getTeacherNav(liveAttemptsCount, submittedAttemptsCount, needsAttentionCount);

  return (
    <>
      <RoleLayout role="Teacher" name={profile?.full_name ?? ""} subtitle={profileSubtitle(profile)} tone="#284B34" items={nav}>
        {section === "overview" && <Overview notify={notify} navigate={navigate} examsList={createdExams} loading={loadingExams} stats={{ live: liveAttemptsCount, submitted: submittedAttemptsCount, flagged: needsAttentionCount }} />}
    {section === "exams" && subSection === "new" && <ExamWizard notify={notify} navigate={navigate} onCreate={(exam) => setCreatedExams((current) => [{ id: exam.id, name: exam.name, batch: exam.batch, state: exam.status === "draft" ? "Draft" : exam.status === "scheduled" ? "Scheduled" : "Live", count: `${exam.pool_count} questions`, tone: exam.status === "draft" ? "text-amber" : "text-success", progress: exam.status === "draft" ? 18 : 100, schedule: exam.scheduled_at, duration: exam.duration_minutes, mode: exam.mode }, ...current])} />}
    {section === "exams" && subSection && subSection !== "new" && examAction === "settings" && <ExamSettings notify={notify} navigate={navigate} examId={subSection} examsList={createdExams} />}
    {section === "exams" && subSection && subSection !== "new" && !examAction && <ExamWorkspace notify={notify} navigate={navigate} examId={subSection} examsList={createdExams} />}
    {section === "exams" && !subSection && <ExamManager notify={notify} navigate={navigate} availableExams={createdExams} />}
    {section === "questions" && !subSection && <TeacherQuestionSetup notify={notify} navigate={navigate} exams={createdExams} />}
    {section === "questions" && subSection === "new" && <QuestionEditorV4 notify={notify} navigate={navigate} />}
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
export function Button({ children, onClick, primary = false }: { children: React.ReactNode; onClick?: () => void; primary?: boolean }) { return <button onClick={onClick} className={`border px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider ${primary ? "border-forest bg-forest text-paper hover:bg-forest-light" : "border-line-strong text-ink-soft hover:border-forest hover:text-ink"}`}>{children}</button>; }
function Metric({ label, value, detail, tone, onClick }: { label: string; value: string; detail: string; tone: string; onClick?: () => void }) { return <div onClick={onClick} className={`border border-line bg-paper-raised p-5 ${onClick ? "cursor-pointer hover:border-forest" : ""}`}><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{label}</p><p className={`mt-2 font-serif text-3xl ${tone}`}>{value}</p><p className="mt-1 text-[12px] text-ink-soft">{detail}</p></div>; }
function Overview({ notify, navigate, examsList, loading, stats }: { notify: (s: string) => void; navigate: (s: string) => void; examsList: any[]; loading: boolean; stats: { live: number, submitted: number, flagged: number } }) {
  const { profile } = useCurrentProfile();
  return <><PageHeading eyebrow="Overview" title={`Good morning, ${profile?.full_name?.split(' ')[0] ?? 'Faculty'}.`} detail="Here is what needs your attention today." action={<Button primary onClick={() => navigate("/teacher/exams/new")}>+ New exam</Button>} /><div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Live candidates" value={String(stats.live)} detail="Currently active" tone="text-alert" onClick={() => navigate("/teacher/submissions")}/><Metric label="Needs review" value={String(stats.submitted)} detail={`${stats.flagged} flagged`} tone="text-amber" onClick={() => navigate("/teacher/evaluate")}/><Metric label="Question bank" value={String(examsList.reduce((acc, e) => acc + (parseInt(e.count) || 0), 0))} detail="Questions across exams" tone="text-forest" onClick={() => navigate("/teacher/questions")}/><Metric label="Avg. score" value="78.4%" detail={`across ${examsList.length} exams`} tone="text-ink" onClick={() => navigate("/teacher/reports")}/></div><div className="mt-9 grid gap-8 xl:grid-cols-[1fr_340px]"><section><div className="flex items-center justify-between"><h2 className="font-serif text-xl font-semibold">Exam activity</h2><button onClick={() => navigate("/teacher/exams")} className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">Manage exams →</button></div><div className="mt-3 space-y-2">{loading ? <div className="p-5 text-center text-[12px] text-ink-soft">Loading...</div> : examsList.length === 0 ? <div className="p-5 text-center text-[12px] text-ink-soft">No exams found.</div> : examsList.slice(0, 5).map((exam) => <div key={exam.id} className="border border-line bg-paper p-5"><div className="flex flex-col justify-between gap-3 sm:flex-row"><div><p className="font-serif text-[16px] font-medium">{exam.name}</p><p className="mt-1 text-[12px] text-ink-soft">{exam.batch}</p></div><span className={`font-mono text-[10px] uppercase tracking-wider ${exam.tone}`}>{exam.state}</span></div><div className="mt-5 flex items-center gap-4"><div className="h-1.5 flex-1 bg-line"><div className="h-full bg-forest" style={{ width: `${exam.progress}%` }}/></div><span className="min-w-[110px] text-right font-mono text-[10px] text-ink-soft">{exam.count}</span></div></div>)}</div></section><aside><div className="flex items-center justify-between"><h2 className="font-serif text-xl font-semibold">Action queue</h2><span className="rounded-full bg-ink px-2 py-0.5 font-mono text-[9px] text-paper">3</span></div><div className="mt-3 divide-y divide-line border border-line">{[["Review flagged submissions", `${stats.flagged} pending`], ["Grade subjective answers", `${stats.submitted} remaining`], ["Publish DSA results", "Ready to publish"]].map(([label, count]) => <button key={label} onClick={() => notify(label)} className="flex w-full items-center justify-between gap-4 bg-paper-raised p-4 text-left hover:bg-paper"><span className="text-[13px]">{label}</span><span className="whitespace-nowrap font-mono text-[10px] text-amber">{count} →</span></button>)}</div></aside></div></>;
}

function ExamManager({ notify, navigate, availableExams }: { notify: (s: string) => void; navigate: (s: string) => void; availableExams: any[] }) {
  const [filter, setFilter] = useState("All exams");
  const filtered = filter === "All exams" ? availableExams : availableExams.filter((exam: any) => exam.state === filter);
  return <><PageHeading eyebrow="Exams" title="Plan and manage assessments" detail="Create exam papers, assign classes, set schedules, and publish with confidence." action={<Button primary onClick={() => navigate("/teacher/exams/new")}>+ Create new exam</Button>} />
    <div className="mt-8 grid gap-4 sm:grid-cols-3"><Metric label="Published this term" value={String(availableExams.filter(e => e.state === "Live").length)} detail="Currently active" tone="text-forest"/><Metric label="Scheduled next" value={String(availableExams.filter(e => e.state === "Scheduled").length)} detail="Upcoming assessments" tone="text-amber"/><Metric label="Drafts" value={String(availableExams.filter(e => e.state === "Draft").length)} detail="Need your attention" tone="text-ink"/></div>
    <section className="mt-8 border border-line bg-paper-raised p-5"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam workspace</p><h2 className="mt-1 font-serif text-xl font-semibold">Your assessments</h2></div><div className="flex gap-1 border border-line bg-paper p-1">{["All exams", "Live", "Scheduled", "Completed", "Draft"].map((item) => <button key={item} onClick={() => setFilter(item)} className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${filter === item ? "bg-forest text-paper" : "text-ink-soft hover:text-ink"}`}>{item}</button>)}</div></div><div className="mt-5 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]"><thead><tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-ink-soft"><th className="pb-3">Exam</th><th className="pb-3">Course &amp; batch</th><th className="pb-3">Schedule</th><th className="pb-3">Readiness</th><th className="pb-3">Status</th><th className="pb-3"></th></tr></thead><tbody>{filtered.map((exam, index) => <tr key={exam.id} className="border-b border-line last:border-0"><td className="py-4 pr-4"><p className="font-serif text-[15px] font-medium">{exam.name}</p><p className="mt-1 font-mono text-[10px] text-ink-soft">{exam.id}</p></td><td className="py-4 pr-4 text-ink-soft">{exam.batch}</td><td className="py-4 pr-4 text-ink-soft">{exam.state === "Live" ? "Today · 10:00 AM" : exam.state === "Scheduled" ? "Tomorrow · 2:00 PM" : "Not scheduled"}</td><td className="py-4 pr-4"><div className="flex items-center gap-2"><div className="h-1.5 w-20 bg-line"><div className="h-full bg-forest" style={{ width: `${exam.state === "Scheduled" ? 76 : exam.state === "Draft" ? 18 : 100}%` }}/></div><span className="font-mono text-[10px] text-ink-soft">{exam.state === "Scheduled" ? "76%" : exam.state === "Draft" ? "Start here" : "Ready"}</span></div></td><td className="py-4 pr-4"><span className={`font-mono text-[10px] uppercase ${exam.tone}`}>{exam.state}</span></td><td className="py-4 text-right"><button onClick={() => navigate(`/teacher/exams/${exam.id}`)} className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Open →</button></td></tr>)}</tbody></table></div></section>
    <div className="mt-8 grid gap-6 lg:grid-cols-2"><section className="border border-line p-5"><div className="flex items-center justify-between"><h2 className="font-serif text-xl font-semibold">Upcoming schedule</h2><button onClick={() => notify("Calendar view opened")} className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Calendar →</button></div><div className="mt-4 space-y-3"><Schedule date="18 MAR" title="Digital Electronics" detail="ECE — Sem III · 96 candidates · 2:00 PM"/><Schedule date="21 MAR" title="Operating Systems" detail="CSE — Sem IV · 110 candidates · 10:00 AM"/></div></section><section className="border border-line p-5"><h2 className="font-serif text-xl font-semibold">Before you publish</h2><div className="mt-4 space-y-3 text-[12px] text-ink-soft"><p>✓ Question set has at least one question</p><p>✓ Candidate batch is assigned</p><p>✓ Duration and schedule are configured</p><p className="text-amber">○ Review proctoring policy before publishing</p></div><button onClick={() => navigate("/teacher/exams/new")} className="mt-5 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Open exam builder →</button></section></div>
  </>;
}
function Schedule({ date, title, detail }: { date: string; title: string; detail: string }) { return <div className="flex gap-4 border-l-2 border-forest pl-3"><span className="w-12 font-mono text-[10px] text-forest">{date}</span><div><p className="text-[13px] font-medium">{title}</p><p className="mt-1 text-[11px] text-ink-soft">{detail}</p></div></div>; }



function ExamWorkspace({ notify, navigate, examId, examsList }: { notify: (s: string) => void; navigate: (s: string) => void; examId: string; examsList: any[] }) {
  const exam = examsList.find(e => e.id === examId);
  if (!exam) return <div className="p-10 text-center text-ink-soft">Loading exam workspace...</div>;
  if (exam.state === "Live") return <ExamDetail notify={notify} navigate={navigate} exam={exam} />;
  return <ExamWorkspacePage notify={notify} navigate={navigate} exam={exam} />;
}

function ExamWorkspacePage({ notify, navigate, exam }: { notify: (s: string) => void; navigate: (s: string) => void; exam: any }) {
  const [tab, setTab] = useState("Overview");
  const [saved, setSaved] = useState(false);
  const setupRows: [string, string, boolean][] = [
    ["Course & batch", exam.batch, true],
    ["Schedule", exam.schedule || "Not scheduled", true],
    ["Duration", `${exam.duration || 45} minutes`, true],
    ["Security", `${exam.mode === "lockdown" ? "Lockdown enabled" : "Standard mode"}`, true],
  ];
  return <><PageHeading eyebrow={`Exams / ${exam.name}`} title={exam.name} detail={`Exam ID ${exam.id} · ${exam.batch}`} action={<div className="flex gap-2"><Button onClick={() => navigate("/teacher/exams")}>← All exams</Button><Button primary onClick={() => { setSaved(true); notify("Exam details saved"); }}>Save changes</Button></div>} />
    <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border border-amber/30 bg-amber/5 px-5 py-4"><div><span className={`font-mono text-[10px] uppercase tracking-widest ${exam.tone}`}>{exam.state} · {exam.state === "Draft" ? "Not published" : "Ready"}</span><p className="mt-1 text-[13px]">Questions, delivery rules and publishing all live in the Question bank — this page covers the exam itself.</p></div><button onClick={() => navigate("/teacher/questions")} className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Open in Question bank →</button></div>
    {saved && <p className="mt-4 text-[12px] text-success">Changes saved.</p>}
    <div className="mt-8 border-b border-line"><div className="flex gap-1 overflow-x-auto">{["Overview", "Questions", "Candidates", "Answers & results"].map((item) => <button key={item} onClick={() => setTab(item)} className={`whitespace-nowrap border-b-2 px-4 py-3 font-mono text-[10px] uppercase tracking-wider ${tab === item ? "border-forest text-forest" : "border-transparent text-ink-soft hover:text-ink"}`}>{item}</button>)}</div></div>
    {tab === "Overview" && <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_330px]"><section className="border border-line bg-paper p-6"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam setup</p><h2 className="mt-1 font-serif text-xl font-semibold">Configuration</h2></div><span className="font-mono text-[10px] text-success">✓ Ready</span></div><div className="mt-6 divide-y divide-line">{setupRows.map(([label, value, complete]) => <div key={label} className="flex items-center justify-between gap-4 py-4"><div><p className="text-[13px] font-medium">{label}</p><p className="mt-1 text-[12px] text-ink-soft">{value}</p></div><span className={`font-mono text-[10px] ${complete ? "text-success" : "text-amber"}`}>{complete ? "✓ Set" : "Review"}</span></div>)}<div className="flex items-center justify-between gap-4 py-4"><div><p className="text-[13px] font-medium">Question set & delivery</p><p className="mt-1 text-[12px] text-ink-soft">Managed in the Questions tab</p></div><button onClick={() => setTab("Questions")} className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Manage →</button></div></div></section><aside className="space-y-5"><section className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">At a glance</p><div className="mt-4 space-y-3"><InfoRow label="Questions" value={exam.count}/><InfoRow label="Duration" value={`${exam.duration}m`}/></div></section><section className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Questions & publishing</p><p className="mt-2 text-[13px] text-ink-soft">Build the pool, set how many each student gets, then publish — all in one flow.</p><button onClick={() => setTab("Questions")} className="mt-4 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Open Questions tab →</button></section><section className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Live controls</p><p className="mt-2 text-[13px] text-ink-soft">Auto-submit, late entry and in-exam rules.</p><button onClick={() => navigate(`/teacher/exams/${exam.id}/settings`)} className="mt-4 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Edit exam settings →</button></section></aside></div>}
    {tab === "Questions" && <section className="mt-8 max-w-5xl"><InlineQuestionBuilder examId={exam.id} notify={notify} /></section>}
    {tab === "Candidates" && <section className="mt-8 max-w-4xl"><div className="flex items-end justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Assigned candidates</p><h2 className="mt-1 font-serif text-xl font-semibold">{exam.batch}</h2></div><Button onClick={() => navigate("/teacher/students")}>Manage roster</Button></div><div className="mt-4 grid gap-4 sm:grid-cols-3"><Metric label="Enrolled" value="142" detail="Roster synced" tone="text-ink"/><Metric label="Email verified" value="138" detail="97% verified" tone="text-success"/><Metric label="Access" value="Locked" detail="Until published" tone="text-amber"/></div><div className="mt-6 border border-line p-5 text-[13px] text-ink-soft">Candidates receive the join link automatically when this exam is published from the Question bank. Add or remove students on the <button onClick={() => navigate("/teacher/students")} className="font-mono text-[11px] uppercase tracking-wider text-forest hover:underline">Students page →</button></div></section>}
    {tab === "Answers & results" && <section className="mt-8 max-w-4xl"><AnswerReleaseControl notify={notify} /></section>}
  </>;
}
function InfoRow({ label, value }: { label: string; value: string }) { return <div className="flex justify-between border-b border-line pb-2 text-[12px] last:border-0"><span className="text-ink-soft">{label}</span><span>{value}</span></div>; }
function AnswerReleaseControl({ notify }: { notify: (s: string) => void }) {
  const [mode, setMode] = useState<"auto" | "manual">("manual");
  const [autoWhen, setAutoWhen] = useState<"submit" | "close">("close");
  const [revealed, setRevealed] = useState(false);
  const modes: { key: "auto" | "manual"; title: string; detail: string }[] = [
    { key: "auto", title: "Show automatically", detail: "Students see the correct answers and their auto-graded score without waiting for you." },
    { key: "manual", title: "Teacher reveals manually", detail: "Answers stay hidden until you choose to release them — safest while grading theory." },
  ];
  return <section className="mt-6 border border-line bg-paper p-5 sm:p-6">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Answer release</p><h3 className="mt-1 font-serif text-lg font-semibold">When can students see the correct answers?</h3><p className="mt-1 max-w-2xl text-[12px] text-ink-soft">Objective and coding questions are always scored instantly — this only controls when candidates may view the answer key and their result.</p></div><span className={`whitespace-nowrap border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${revealed ? "border-success bg-success/5 text-success" : mode === "auto" ? "border-forest bg-success/5 text-forest" : "border-amber bg-amber/5 text-amber"}`}>{revealed ? "✓ Answers released" : mode === "auto" ? "Auto release on" : "Hidden · manual"}</span></div>
    <div className="mt-5 grid gap-3 sm:grid-cols-2">{modes.map((m) => <button key={m.key} onClick={() => { setMode(m.key); setRevealed(false); notify(m.key === "auto" ? "Students will see answers automatically" : "Answers will stay hidden until you reveal them"); }} className={`border p-4 text-left ${mode === m.key ? "border-forest bg-success/5" : "border-line hover:border-line-strong"}`}><span className="flex items-center gap-2"><span className={`flex h-4 w-4 items-center justify-center rounded-full border ${mode === m.key ? "border-forest" : "border-line-strong"}`}>{mode === m.key && <span className="h-2 w-2 rounded-full bg-forest"/>}</span><span className="text-[13px] font-medium">{m.title}</span></span><span className="mt-2 block text-[12px] text-ink-soft">{m.detail}</span></button>)}</div>
    {mode === "auto" && <div className="mt-4 border-l-2 border-forest bg-success/5 px-4 py-3"><p className="font-mono text-[10px] uppercase tracking-wider text-forest">Release timing</p><div className="mt-2 flex flex-wrap gap-2">{([["submit", "As soon as each student submits"], ["close", "When the exam window closes"]] as const).map(([key, label]) => <button key={key} onClick={() => setAutoWhen(key)} className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${autoWhen === key ? "border-forest bg-paper text-forest" : "border-line-strong text-ink-soft hover:text-ink"}`}>{label}</button>)}</div><p className="mt-2 text-[11px] text-ink-soft">Releasing while the exam is still live lets early finishers share the key — “when the exam window closes” is the safer default.</p></div>}
    {mode === "manual" && <div className="mt-4 flex flex-col justify-between gap-3 border-t border-line pt-4 sm:flex-row sm:items-center"><p className="text-[12px] text-ink-soft">{revealed ? "Answers are now visible to candidates in their results view." : "Answers are hidden. Reveal them once grading and review are complete."}</p><button onClick={() => { setRevealed(true); notify("Correct answers revealed to students"); }} disabled={revealed} className="whitespace-nowrap border border-forest bg-forest px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper enabled:hover:bg-forest-light disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-line/30 disabled:text-ink-soft">{revealed ? "✓ Answers released" : "Reveal answers now"}</button></div>}
  </section>;
}

function InlineQuestionBuilder({ examId, notify }: { examId: string; notify: (s: string) => void }) {
  const [questions, setQuestions] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("Multiple choice");
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
      unit: "General",
      difficulty: "Medium",
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
          <Button onClick={() => notify("Select from bank modal opened")}>Select from Bank</Button>
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
              <p className="mt-2 text-[12px] text-ink-soft">Click Quick Add or Select from Bank to start building your exam.</p>
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
  const offline = liveAttempts.filter(a => a.state === "Not started").length;
  
  return <><PageHeading eyebrow="Exams / Open" title={exam.name} detail={`${exam.batch} · Live session`} action={<Button onClick={() => navigate("/teacher/exams")}>← Back to exams</Button>} /><div className="mt-8 flex flex-wrap items-center justify-between gap-4 border border-alert/30 bg-alert/5 px-5 py-4"><div><p className="font-mono text-[10px] uppercase tracking-widest text-alert">Live session</p><p className="mt-1 text-[13px]">The exam is in progress. Candidate activity is updating in real time.</p></div><span className="font-mono text-[11px] text-alert">● Running</span></div><div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Candidates" value="142" detail={`${inProgress} active · ${offline} offline`} tone="text-ink"/><Metric label="Submitted" value={String(submitted)} detail="Received" tone="text-success"/><Metric label="In progress" value={String(inProgress)} detail="Active" tone="text-ink"/><Metric label="Flags" value="0" detail="0 critical" tone="text-alert"/></div><div className="mt-8 grid gap-6 xl:grid-cols-[1fr_360px]"><div className="space-y-6"><section className="border border-line bg-paper p-6"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Session progress</p><h2 className="mt-2 font-serif text-xl font-semibold">Candidate completion</h2></div><span className="font-mono text-[10px] text-alert">LIVE NOW</span></div><div className="mt-6 h-3 bg-line"><div className="h-full bg-forest" style={{ width: `${Math.min(100, Math.max(0, (submitted / 142) * 100))}%` }}/></div><div className="mt-3 flex justify-between font-mono text-[10px] text-ink-soft"><span>Started {exam.schedule}</span><span></span></div><div className="mt-7 grid gap-3 sm:grid-cols-3"><StatusRow label="Submitted" value={String(submitted)} tone="bg-success"/><StatusRow label="In progress" value={String(inProgress)} tone="bg-forest"/><StatusRow label="Offline" value={String(offline)} tone="bg-line-strong"/></div></section><section className="border border-line"><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Recent activity</p><h2 className="mt-1 font-serif text-xl font-semibold">What is happening now</h2></div><Button onClick={() => navigate("/teacher/submissions")}>View all</Button></div><div className="divide-y divide-line">{liveAttempts.slice(0,4).map((a) => <div key={a.id} className="flex gap-4 px-5 py-4"><span className="w-16 shrink-0 font-mono text-[10px] text-ink-soft"></span><div><p className="text-[13px]">{a.name}</p><p className="mt-1 text-[11px] text-ink-soft">{a.state}</p></div></div>)}</div></section></div><aside className="space-y-6"><section className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam controls</p><div className="mt-4 grid gap-2"><Button onClick={() => notify("Exam paused for all candidates")}>Pause exam</Button><Button onClick={() => notify("Message composer opened")}>Broadcast message</Button><Button onClick={() => navigate(`/teacher/exams/${exam.id}/settings`)}>Edit settings</Button><Button onClick={() => notify("Live report export queued")}>Export live report</Button></div></section><section className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam information</p><div className="mt-4 space-y-3 text-[12px]"><Info label="Questions" value={exam.count}/><Info label="Duration" value={`${exam.duration} minutes`}/><Info label="Security" value={exam.mode === "lockdown" ? "Lockdown Browser" : "Standard"}/><Info label="Assigned" value={exam.batch}/></div></section></aside></div></>; }

function StatusRow({ label, value, tone }: { label: string; value: string; tone: string }) { return <div><div className="flex items-center gap-2"><span className={`h-2 w-2 ${tone}`}/><span className="font-mono text-[11px] text-ink-soft">{label}</span></div><p className="mt-1 pl-4 font-serif text-xl">{value}</p></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3 border-b border-line pb-2 last:border-0"><span className="text-ink-soft">{label}</span><span className="text-right">{value}</span></div>; }
function ExamSettings({ notify, navigate, examId, examsList }: { notify: (s: string) => void; navigate: (s: string) => void; examId: string; examsList: any[] }) {
  const exam = examsList.find(e => e.id === examId);
  const [autoSubmitEnabled, setAutoSubmitEnabled] = useState(true);
  const [onTimeLimit, setOnTimeLimit] = useState(true);
  const [onViolationCount, setOnViolationCount] = useState(true);
  const [violationLimit, setViolationLimit] = useState(3);
  if (!exam) return <div className="p-10 text-center">Loading...</div>;
  return <><PageHeading eyebrow="Exams / Settings" title="Exam settings" detail="Update the exam configuration carefully." action={<Button onClick={() => navigate(`/teacher/exams/${examId}`)}>← Back to exam</Button>} /><div className="mt-8 max-w-2xl space-y-6"><div className="border border-line p-6"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam configuration</p><div className="mt-5 grid gap-5 sm:grid-cols-2"><Field label="Exam title" value={exam.name}/><Field label="Assigned batch" value={exam.batch}/><Field label="Duration" value={`${exam.duration}m`}/><Field label="Proctoring tier" value={exam.mode === "lockdown" ? "Lockdown Browser" : "Standard"}/></div></div><div className="border border-line p-6"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Live controls</p><div className="mt-4 space-y-4 text-[13px]"><label className="flex items-center justify-between gap-4"><span>Allow late entry</span><input type="checkbox" defaultChecked className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Allow candidate questions</span><input type="checkbox" defaultChecked className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Auto-submit enabled</span><input type="checkbox" checked={autoSubmitEnabled} onChange={(e) => setAutoSubmitEnabled(e.target.checked)} className="h-4 w-4 accent-forest"/></label>{autoSubmitEnabled && <><label className="flex items-center justify-between gap-4"><span>Auto-submit at time limit</span><input type="checkbox" checked={onTimeLimit} onChange={(e) => setOnTimeLimit(e.target.checked)} className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Auto-submit on violation count</span><input type="checkbox" checked={onViolationCount} onChange={(e) => setOnViolationCount(e.target.checked)} className="h-4 w-4 accent-forest"/></label>{onViolationCount && <label className="block text-[12px] text-ink-soft">Violation count threshold<input type="number" min="1" max="20" value={violationLimit} onChange={(e) => setViolationLimit(Math.max(1, Number(e.target.value)))} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px]"/></label>}</>}</div></div><div className="flex gap-2"><Button primary onClick={() => notify("Exam settings saved")}>Save settings</Button><Button onClick={() => navigate(`/teacher/exams/${examId}`)}>Cancel</Button></div></div></>; }
function FormStep({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) { return <div><h2 className="font-serif text-2xl font-semibold">{title}</h2><p className="mt-2 text-[13px] text-ink-soft">{detail}</p><div className="mt-7">{children}</div></div>; }
function SelectField({ label, options, value, onChange }: { label: string; options: string[]; value?: string; onChange?: (value: string) => void }) { return <label className="block text-[12px] text-ink-soft">{label}<select value={value} onChange={(e) => onChange?.(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink">{options.map((option) => <option key={option}>{option}</option>)}</select></label>; }

function Table({ heads, rows, notify }: { heads: string[]; rows: string[][]; notify: (s: string) => void }) { return <div className="overflow-x-auto border border-line"><table className="w-full min-w-[620px] text-left text-[13px]"><thead><tr className="border-b border-line bg-paper-raised font-mono text-[10px] uppercase tracking-wider text-ink-soft">{heads.map((head) => <th key={head} className="px-4 py-3">{head}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row[0]} className="border-b border-line last:border-0 hover:bg-paper-raised">{row.map((cell, i) => <td key={`${row[0]}-${i}`} className={`px-4 py-3 ${i === 0 ? "font-mono text-[12px] text-ink-soft" : ""}`}><button onClick={() => notify(`${row[1] || row[0]} selected`)} className="text-left hover:text-forest">{cell}</button></td>)}</tr>)}</tbody></table></div>; }

function QuestionEditor({ notify, navigate }: { notify: (s: string) => void; navigate: (s: string) => void }) {
  const [type, setType] = useState("Multiple choice");
  const [prompt, setPrompt] = useState("");
  const [options, setOptions] = useState(["", "", "", ""]);
  const [answer, setAnswer] = useState(0);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  const [subjectiveMode, setSubjectiveMode] = useState<"both" | "qr" | "textbox">("both");
  const types = ["Multiple choice", "Multiple select", "True / false", "Numerical", "Subjective"];
  const isChoice = type === "Multiple choice" || type === "Multiple select";
  const updateOption = (index: number, value: string) => setOptions((current) => current.map((option, i) => i === index ? value : option));
  const save = () => { if (prompt.trim() && (!isChoice || options.filter(Boolean).length >= 2)) { setSaved(true); notify(`Question saved with ${type === "Subjective" ? (subjectiveMode === "qr" ? "QR Based" : subjectiveMode === "textbox" ? "Answer Box" : "Both QR & Answer Box") : type} format to the question bank`); } };
  return <><PageHeading eyebrow="Question bank / New question" title="Create question" detail="Write, configure, and preview exactly what students will see." action={<Button onClick={() => navigate("/teacher/questions")}>← Back to question bank</Button>} />
    <div className="mt-8 grid gap-8 xl:grid-cols-[1fr_360px]"><div className="space-y-6"><section className="border border-line bg-paper p-6 sm:p-8"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Step 1 · Question</p><h2 className="mt-1 font-serif text-xl font-semibold">Question content</h2></div><span className="font-mono text-[10px] text-alert">* Required</span></div><div className="mt-6 flex flex-wrap gap-2">{types.map((item) => <button key={item} onClick={() => setType(item)} className={`border px-3 py-2 text-[12px] ${type === item ? "border-forest bg-success/5 text-forest" : "border-line-strong text-ink-soft hover:text-ink"}`}>{item}</button>)}</div><label className="mt-6 block text-[12px] text-ink-soft">Question prompt <span className="text-alert">*</span><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Example: Which traversal visits the root between the left and right subtrees?" className="mt-1 block w-full resize-y border border-line-strong bg-paper px-3 py-3 text-[14px] text-ink outline-none focus:border-forest"/><span className="mt-1 block text-right font-mono text-[10px] text-ink-soft">{prompt.length} / 500 characters</span></label>{isChoice && <div className="mt-6"><div className="flex items-center justify-between"><p className="text-[12px] text-ink-soft">Answer choices <span className="text-alert">*</span></p><span className="font-mono text-[10px] text-ink-soft">Select the correct answer</span></div><div className="mt-2 space-y-2">{options.map((option, index) => <div key={index} className="flex items-center gap-2"><input type={type === "Multiple select" ? "checkbox" : "radio"} name="correct" checked={answer === index} onChange={() => setAnswer(index)} className="accent-forest"/><input value={option} onChange={(e) => updateOption(index, e.target.value)} placeholder={`Option ${String.fromCharCode(65 + index)}`} className="flex-1 border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest"/><button onClick={() => updateOption(index, "")} className="px-2 text-ink-soft hover:text-alert">×</button></div>)}</div><button onClick={() => setOptions((current) => [...current, ""])} className="mt-3 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">+ Add another option</button></div>}{type === "True / false" && <div className="mt-6 grid grid-cols-2 gap-3"><button onClick={() => setAnswer(0)} className={`border p-3 text-left text-[13px] ${answer === 0 ? "border-forest bg-success/5" : "border-line"}`}>○ True</button><button onClick={() => setAnswer(1)} className={`border p-3 text-left text-[13px] ${answer === 1 ? "border-forest bg-success/5" : "border-line"}`}>○ False</button></div>}{type === "Numerical" && <label className="mt-6 block text-[12px] text-ink-soft">Correct numerical answer<input placeholder="e.g.  O(n log n)" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/></label>}{type === "Subjective" && (
      <div className="mt-6 space-y-4">
        <p className="border-l-2 border-amber bg-amber/5 px-3 py-2 text-[12px] text-ink-soft">Subjective answers will be manually evaluated from the teacher’s Evaluate queue.</p>
        <div>
          <label className="block text-[12px] font-medium text-ink mb-2">Student Submission Mode <span className="text-alert">*</span></label>
          <div className="grid gap-2 sm:grid-cols-3">
            {[
              { id: "both", label: "Both (Choice)", desc: "Type in browser or scan QR" },
              { id: "qr", label: "QR Scan Based", desc: "Handwritten sheet upload" },
              { id: "textbox", label: "Answer Box Only", desc: "Typed online text" },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSubjectiveMode(opt.id as "both" | "qr" | "textbox")}
                className={`border p-3 text-left transition-colors ${
                  subjectiveMode === opt.id
                    ? "border-forest bg-forest text-paper"
                    : "border-line bg-paper text-ink hover:border-forest/60"
                }`}
              >
                <p className="font-medium text-[13px]">{opt.label}</p>
                <p className={`mt-0.5 text-[10px] ${subjectiveMode === opt.id ? "text-paper/80" : "text-ink-soft"}`}>{opt.desc}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    )}</section><section className="border border-line bg-paper p-6 sm:p-8"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Step 2 · Metadata</p><h2 className="mt-1 font-serif text-xl font-semibold">Scoring and organization</h2><div className="mt-6 grid gap-5 sm:grid-cols-2"><SelectField label="Unit" options={["Trees & Graphs", "Normalization", "Sorting", "OS Scheduling", "Networking"]}/><SelectField label="Difficulty" options={["Easy", "Medium", "Hard"]}/><label className="block text-[12px] text-ink-soft">Marks<input type="number" defaultValue={1} min={1} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/></label><label className="block text-[12px] text-ink-soft">Negative marking<select className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px]"><option>None</option><option>-0.25 marks</option><option>-0.5 marks</option></select></label></div><label className="mt-5 block text-[12px] text-ink-soft">Explanation / solution <textarea rows={3} placeholder="Optional: explain why the correct answer is right…" className="mt-1 block w-full resize-y border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/></label><label className="mt-5 block text-[12px] text-ink-soft">Tags<input placeholder="e.g. trees, traversal, midterm" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/><span className="mt-1 block text-[10px] text-ink-soft">Use commas to separate tags for easier searching.</span></label></section></div><aside className="space-y-5"><section className="sticky top-24 border border-line bg-paper-raised p-5"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Live preview</p><h2 className="mt-1 font-serif text-xl font-semibold">Student view</h2></div><button onClick={() => setPreview(!preview)} className="font-mono text-[10px] uppercase text-forest">{preview ? "Hide" : "Show"}</button></div>{preview && <div className="mt-5 border border-line bg-paper p-4"><p className="font-mono text-[10px] text-ink-soft">Question 01 · {type} {type === "Subjective" && `(${subjectiveMode === "qr" ? "QR Upload" : subjectiveMode === "textbox" ? "Answer Box" : "Both"})`}</p><p className="mt-3 text-[13px] leading-relaxed">{prompt || "Your question will appear here…"}</p>{isChoice && <div className="mt-4 space-y-2">{options.filter(Boolean).map((option, index) => <div key={option + index} className="border border-line px-3 py-2 text-[12px]">○ {option}</div>)}</div>}</div>}<div className="mt-5 space-y-3 text-[12px] text-ink-soft"><p className={prompt.trim() ? "text-success" : "text-alert"}>{prompt.trim() ? "✓" : "○"} Question prompt</p><p className={!isChoice || options.filter(Boolean).length >= 2 ? "text-success" : "text-alert"}>{!isChoice || options.filter(Boolean).length >= 2 ? "✓" : "○"} Answer configuration</p><p className="text-success">✓ Scoring configured</p><p className="text-success">✓ Organization fields ready</p></div></section><div className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Save question</p><p className="mt-2 text-[12px] text-ink-soft">This question will be available in the question bank and can be added to any exam.</p><div className="mt-4 grid gap-2"><Button primary onClick={save}>Save to question bank</Button><Button onClick={() => { setPrompt(""); setOptions(["", "", "", ""]); setSaved(false); }}>Clear form</Button></div>{saved && <p className="mt-4 text-[12px] text-success">Question saved successfully.</p>}</div></aside></div></>;
}
void Submissions;
function Submissions({ notify }: { notify: (s: string) => void }) { return <><PageHeading eyebrow="Submissions" title="Live submissions" detail="Data Structures & Algorithms · Session is currently active." action={<Button onClick={() => notify("Broadcast composer opened")}>Broadcast message</Button>} /><div className="mt-8 grid gap-4 sm:grid-cols-3"><Metric label="Submitted" value="34" detail="24% of candidates" tone="text-success"/><Metric label="In progress" value="84" detail="59% of candidates" tone="text-ink"/><Metric label="Flagged" value="4" detail="Needs attention" tone="text-alert"/></div><div className="mt-8"><Table heads={["Roll no.", "Name", "Status", "Progress", "Flags"]} rows={[]} notify={notify}/></div></>; }

export const getTeacherNav = (liveAttemptsCount: number, submittedAttemptsCount: number, needsAttentionCount: number) => [
  { label: "Overview", to: "/teacher", end: true },
  { label: "Exams", to: "/teacher/exams", badge: "6" },
  { label: "Question bank", to: "/teacher/questions" },
  { label: "Students", to: "/teacher/students" },
  { label: "Submissions", to: "/teacher/submissions", badge: String(liveAttemptsCount) },
  { label: "Evaluate", to: "/teacher/evaluate", badge: String(submittedAttemptsCount) },
  { label: "Proctoring", to: "/teacher/proctoring", badge: String(needsAttentionCount) },
  { label: "Reports", to: "/teacher/reports" },
  { label: "Settings", to: "/teacher/settings" },
];

void Evaluate;
function Evaluate({ notify }: { notify: (s: string) => void }) { const [saved, setSaved] = useState(false); return <><PageHeading eyebrow="Evaluate" title="Grade submitted work" detail="4 submissions need review. Your rubric is available beside each response."/><div className="mt-8 grid gap-6 lg:grid-cols-[280px_1fr]"><div className="border border-line"><div className="border-b border-line bg-paper-raised px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">Pending review · 4</div>{["M. Sai Charan", "K. Rohan Teja", "A. Deepika Reddy", "S. Vamsi Krishna"].map((name, i) => <button key={name} onClick={() => notify(`${name} selected for grading`)} className={`block w-full border-b border-line px-4 py-3 text-left last:border-0 ${i === 0 ? "border-l-2 border-forest bg-paper-raised" : "hover:bg-paper-raised"}`}><p className="text-[13px] font-medium">{name}</p><p className="font-mono text-[10px] text-ink-soft">Q5 · Subjective</p></button>)}</div><div className="border border-line p-6"><p className="font-mono text-[10px] uppercase tracking-widest text-forest">Subjective · Q5 · 10 marks</p><p className="mt-3 font-serif text-[17px]">Explain how priority scheduling can lead to starvation and describe one technique to prevent it.</p><div className="mt-5 border border-line bg-paper-raised p-4 text-[13px] leading-relaxed text-ink-soft">Priority scheduling always runs the highest priority process first, so a low priority process may never get CPU time. Aging can fix this by gradually increasing the priority of a process the longer it waits.</div><div className="mt-5 flex flex-wrap items-center gap-3"><label className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Award marks <input type="number" defaultValue={8} max={10} className="ml-2 w-16 border border-line-strong bg-paper px-2 py-1 text-center font-mono text-[13px]"/> / 10</label><Button primary onClick={() => { setSaved(true); notify("Marks saved — next response loaded"); }}>Save & next</Button></div>{saved && <p className="mt-4 text-[12px] text-success">✓ Evaluation saved to the gradebook.</p>}</div></div></>; }
function Reports({ notify }: { notify: (s: string) => void }) {
  const [activeTab, setActiveTab] = useState("Overview");
  return (
    <>
      <PageHeading eyebrow="Reports" title="Performance reports" detail="Interactive analytics, statistical analysis, and result publishing." action={
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => notify("Results released to students")}>Release Results</Button>
          <Button onClick={() => notify("Answer key published")}>Publish Answer Key</Button>
          <Button onClick={() => notify("Exported PDF Report")}>Export PDF</Button>
          <Button onClick={() => notify("Exported Excel Data")}>Export Excel</Button>
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
            <Metric label="Average (Mean)" value="78.4%" detail="Across 142 candidates" tone="text-ink"/>
            <Metric label="Median Score" value="80.1%" detail="Slightly left-skewed" tone="text-forest"/>
            <Metric label="Standard Dev" value="12.4%" detail="Score spread" tone="text-amber"/>
            <Metric label="Highest Score" value="98.5%" detail="Data Structures & Algo" tone="text-success"/>
          </div>
          <div className="mt-8 border border-line p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-xl font-semibold">Interactive Score Distribution</h2>
              <select className="border border-line-strong bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink-soft"><option>DSA Midterm</option><option>OS Final</option></select>
            </div>
            <div className="mt-8 flex h-44 items-end gap-3 border-b border-line px-4">
              {[35, 48, 62, 78, 92, 64, 44, 24].map((height, i) => (
                <div key={i} className="flex flex-1 flex-col items-center gap-2 group cursor-pointer">
                  <div className="w-full bg-forest/40 transition-colors group-hover:bg-forest/80" style={{ height: `${height}%` }}/>
                  <span className="font-mono text-[9px] text-ink-soft">{`${40 + i * 10}`}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-center font-mono text-[10px] text-ink-soft uppercase tracking-widest">Score Brackets</p>
          </div>
        </>
      )}

      {activeTab === "Item Analysis" && (
        <div className="mt-8 border border-line bg-paper">
          <div className="border-b border-line bg-paper-raised px-5 py-3">
            <h2 className="font-serif text-lg font-semibold">Question Performance (Item Analysis)</h2>
            <p className="mt-1 font-mono text-[10px] text-ink-soft">Difficulty and Discrimination Index (Point Biserial)</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                  <th className="px-5 py-3">Question ID</th>
                  <th className="px-5 py-3">Topic</th>
                  <th className="px-5 py-3">Correct %</th>
                  <th className="px-5 py-3">Difficulty</th>
                  <th className="px-5 py-3">Discrimination (PBQ)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-line hover:bg-paper-raised">
                  <td className="px-5 py-3">Q-1042</td><td className="px-5 py-3">Trees & Graphs</td><td className="px-5 py-3 text-success">88%</td><td className="px-5 py-3">Easy</td><td className="px-5 py-3 text-ink-soft">0.24 (Low)</td>
                </tr>
                <tr className="border-b border-line hover:bg-paper-raised">
                  <td className="px-5 py-3">Q-1049</td><td className="px-5 py-3">Dynamic Programming</td><td className="px-5 py-3 text-alert">32%</td><td className="px-5 py-3 text-alert">Hard</td><td className="px-5 py-3 text-success">0.68 (Excellent)</td>
                </tr>
                <tr className="border-b border-line hover:bg-paper-raised">
                  <td className="px-5 py-3">Q-1051</td><td className="px-5 py-3">Normalization</td><td className="px-5 py-3">65%</td><td className="px-5 py-3 text-amber">Medium</td><td className="px-5 py-3 text-success">0.45 (Good)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "Student Reports" && (
        <div className="mt-8 border border-line bg-paper p-10 text-center">
          <p className="font-serif text-lg">Individual Student Reports</p>
          <p className="mt-2 text-[12px] text-ink-soft">Generate and distribute detailed PDF performance tear-sheets for each candidate.</p>
          <Button onClick={() => notify("Generating 142 PDFs...")}>Generate All PDFs</Button>
        </div>
      )}

      {activeTab === "Trends" && (
        <div className="mt-8 border border-line bg-paper p-10 text-center">
          <p className="font-serif text-lg">Performance Trends Over Time</p>
          <p className="mt-2 text-[12px] text-ink-soft">Comparing cohort averages across Sem III and Sem IV.</p>
          <div className="mt-6 flex h-32 items-end justify-center gap-10 border-b border-line pb-4">
            <div className="w-8 bg-forest/30" style={{ height: "65%" }}></div>
            <div className="w-8 bg-forest/50" style={{ height: "71%" }}></div>
            <div className="w-8 bg-forest/70" style={{ height: "78%" }}></div>
            <div className="w-8 bg-forest/90" style={{ height: "82%" }}></div>
          </div>
          <div className="mt-2 flex justify-center gap-10 font-mono text-[9px] text-ink-soft">
            <span className="w-8 text-center">Exam 1</span>
            <span className="w-8 text-center">Exam 2</span>
            <span className="w-8 text-center">Exam 3</span>
            <span className="w-8 text-center">Exam 4</span>
          </div>
        </div>
      )}
    </>
  );
}
function Settings({ notify }: { notify: (s: string) => void }) { const { profile } = useCurrentProfile(); return <><PageHeading eyebrow="Settings" title="Workspace settings" detail="Manage your faculty profile, exam defaults, and notifications."/><div className="mt-8 max-w-2xl space-y-6"><div className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty profile</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><Field label="Full name" value={profile?.full_name ?? "Loading..."}/><Field label="Department" value={profile?.kind === "teacher" ? profile.department : "Unknown"}/><Field label="Email" value={profile?.email ?? ""}/><Field label="Role" value="Teacher · Faculty"/></div></div><div className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Exam defaults</p><div className="mt-4 space-y-3 text-[13px]"><label className="flex items-center justify-between gap-4"><span>Auto-save answers</span><input type="checkbox" defaultChecked className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Enable AI proctoring by default</span><input type="checkbox" defaultChecked className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Notify me when a candidate is flagged</span><input type="checkbox" defaultChecked className="h-4 w-4 accent-forest"/></label></div></div><Button primary onClick={() => notify("Settings saved successfully")}>Save changes</Button></div></>; }
function SettingsPanel({ notify }: { notify: (s: string) => void }) { const [tab, setTab] = useState("Profile"); const { profile } = useCurrentProfile(); void Settings; return <><PageHeading eyebrow="Settings" title="Teacher workspace settings" detail="Control your profile, exam defaults, security rules, and notifications."/><div className="mt-8 grid gap-8 lg:grid-cols-[210px_1fr]"><nav className="space-y-1">{["Profile", "Department defaults", "Security & proctoring", "Notifications", "Email templates", "Integrations", "API keys"].map((item) => <button key={item} onClick={() => setTab(item)} className={`w-full border-l-2 px-3 py-2.5 text-left text-[13px] ${tab === item ? "border-forest bg-paper-raised text-forest" : "border-transparent text-ink-soft hover:bg-paper-raised hover:text-ink"}`}>{item}</button>)}</nav><div className="max-w-3xl border border-line bg-paper p-6 sm:p-8">{tab === "Profile" && <SettingsSection title="Faculty profile" detail="This information appears on exam instructions and reports."><div className="grid gap-5 sm:grid-cols-2"><EditableField label="Full name" value={profile?.full_name ?? "Loading..."}/><EditableField label="Department" value={profile?.kind === "teacher" ? profile.department : "Unknown"}/><EditableField label="Institution" value="Vignan University"/><EditableField label="Faculty ID" value="FAC-CSE-019"/></div><div className="mt-5"><EditableField label="Email address" value={profile?.email ?? ""}/></div></SettingsSection>}{tab === "Department defaults" && <SettingsSection title="Department defaults" detail="These values prefill whenever you create a new exam for the CS Department."><div className="grid gap-5 sm:grid-cols-2"><SelectField label="Default duration" options={["00:45", "01:00", "01:30"]}/><SelectField label="Default question type" options={["Mixed question set", "MCQ only", "Subjective only"]}/><SelectField label="Default batch" options={["CSE — Sem III · Sec A/B", "CSE — Sem V", "ECE — Sem III"]}/><SelectField label="Default proctoring" options={["AI Proctoring", "Basic Lockdown", "Live Proctoring"]}/></div><Toggle label="Auto-save exam drafts" detail="Save changes as you move through the exam builder." checked/><Toggle label="Shuffle questions by default" detail="Randomize question order for each candidate." checked/></SettingsSection>}{tab === "Security & proctoring" && <SettingsSection title="Security & proctoring" detail="Set the minimum security standard for new assessments."><Toggle label="Require camera and microphone" detail="Candidates must pass device checks before starting." checked/><Toggle label="Block tab switching and copy/paste" detail="Lock the exam window during active sessions." checked/><Toggle label="Enable second-face detection" detail="Create a flag when another face enters the frame." checked/><Toggle label="Allow late entry" detail="Let candidates join after the scheduled start time." checked={false}/></SettingsSection>}{tab === "Notifications" && <SettingsSection title="Notifications" detail="Choose which events should reach your faculty inbox."><Toggle label="Critical proctoring flags" detail="Notify immediately when a severe incident is detected." checked/><Toggle label="Submission milestones" detail="Notify when 25%, 50%, 75%, and 100% submit." checked/><Toggle label="Evaluation reminders" detail="Send a daily reminder for ungraded subjective answers." checked={false}/><SelectField label="Daily summary time" options={["08:00 AM", "12:00 PM", "06:00 PM"]}/></SettingsSection>}{tab === "Email templates" && <SettingsSection title="Email templates" detail="Customize automated emails sent to candidates."><div className="grid gap-5"><SelectField label="Template to edit" options={["Exam Invitation", "Result Published", "Proctoring Warning"]} /><label className="block text-[12px] text-ink-soft">Subject<input defaultValue="You are invited to {exam_name}" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/></label><label className="block text-[12px] text-ink-soft">Body<textarea rows={6} defaultValue="Dear {candidate_name},\n\nYou have been enrolled in {exam_name}.\n\nPlease ensure your system meets the requirements." className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/></label><div className="flex gap-2"><Button primary onClick={() => notify("Template saved")}>Save Template</Button><Button onClick={() => notify("Test email sent")}>Send Test Email</Button></div></div></SettingsSection>}{tab === "Integrations" && <SettingsSection title="Integrations" detail="Connect the tools your department already uses."><Integration name="Canvas Gradebook" detail="Two-way sync for scores and rubrics" connected={false}/><Integration name="Vignan LMS" detail="Roster sync and result publishing" connected/><Integration name="Institution email" detail="Send exam invitations and alerts" connected/><Integration name="Plagiarism review" detail="Optional post-submission similarity checks"/></SettingsSection>}{tab === "API keys" && <SettingsSection title="API keys" detail="Manage programmatic access to your assessment data."><div className="space-y-4"><div className="flex items-center justify-between border border-line p-4"><div><p className="font-mono text-[13px] font-medium">Production API Key</p><p className="mt-1 text-[12px] text-ink-soft">Created on Aug 12, 2026</p></div><Button onClick={() => notify("Key copied")}>Copy Key</Button></div><Button primary onClick={() => notify("New key generated")}>+ Generate New Key</Button></div></SettingsSection>}<div className="mt-8 flex justify-end border-t border-line pt-5"><Button primary onClick={() => notify("Settings saved")}>Save changes</Button></div></div></div></>; }
function SettingsSection({ title, detail, children }: { title: string; detail: string; children: React.ReactNode }) { return <section><h2 className="font-serif text-2xl font-semibold">{title}</h2><p className="mt-2 text-[13px] text-ink-soft">{detail}</p><div className="mt-7 space-y-5">{children}</div></section>; }
function EditableField({ label, value }: { label: string; value: string }) { return <label className="block text-[12px] text-ink-soft">{label}<input defaultValue={value} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest"/></label>; }
function Toggle({ label, detail, checked }: { label: string; detail: string; checked: boolean }) { return <label className="flex items-start justify-between gap-5 border-b border-line pb-4"><span><span className="block text-[13px] font-medium">{label}</span><span className="mt-1 block text-[12px] text-ink-soft">{detail}</span></span><input type="checkbox" defaultChecked={checked} className="mt-1 h-4 w-4 accent-forest"/></label>; }
function Integration({ name, detail, connected = false }: { name: string; detail: string; connected?: boolean }) { return <div className="flex items-center justify-between gap-4 border-b border-line pb-4"><span><span className="block text-[13px] font-medium">{name}</span><span className="mt-1 block text-[12px] text-ink-soft">{detail}</span></span><span className={`font-mono text-[10px] uppercase tracking-wider ${connected ? "text-success" : "text-ink-soft"}`}>{connected ? "Connected" : "Connect"}</span></div>; }
function Field({ label, value }: { label: string; value: string }) { return <label className="text-[12px] text-ink-soft">{label}<input value={value} readOnly className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2 text-[13px] text-ink"/></label>; }

void QuestionEditor;
void QuestionEditorV2;
function QuestionEditorV2({ notify, navigate }: { notify: (s: string) => void; navigate: (s: string) => void }) {
  const [unit, setUnit] = useState("Trees & Graphs");
  const [customUnit, setCustomUnit] = useState("");
  const [negativeMark, setNegativeMark] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  const [type, setType] = useState("MCQ");
  const save = () => { if (prompt.trim()) { setSaved(true); notify("Question saved to the question bank"); } };
  return <><PageHeading eyebrow="Question bank / New question" title="Create question" detail="Add the prompt, answer, scoring, and organization before saving." action={<Button onClick={() => navigate("/teacher/questions")}>← Back to question bank</Button>} /><div className="mt-8 grid gap-8 xl:grid-cols-[1fr_360px]"><div className="space-y-6"><section className="border border-line bg-paper p-6 sm:p-8"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Question content</p><h2 className="mt-1 font-serif text-xl font-semibold">What should students answer?</h2><div className="mt-6 flex flex-wrap gap-2">{["MCQ", "Multiple select", "True / false", "Numerical", "Subjective"].map((item) => <button key={item} onClick={() => setType(item)} className={`border px-3 py-2 text-[12px] ${type === item ? "border-forest bg-success/5 text-forest" : "border-line-strong text-ink-soft"}`}>{item}</button>)}</div><label className="mt-6 block text-[12px] text-ink-soft">Question prompt <span className="text-alert">*</span><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Write the question students will see…" className="mt-1 block w-full resize-y border border-line-strong bg-paper px-3 py-3 text-[14px] outline-none focus:border-forest"/><span className="mt-1 block text-right font-mono text-[10px] text-ink-soft">{prompt.length} / 500</span></label>{type === "MCQ" && <div className="mt-6"><p className="text-[12px] text-ink-soft">Answer choices</p><div className="mt-2 grid gap-3 sm:grid-cols-2">{["A", "B", "C", "D"].map((option) => <input key={option} placeholder={`Option ${option}`} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/>)}</div><label className="mt-3 block text-[12px] text-ink-soft">Correct answer<select className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px]"><option>Option A</option><option>Option B</option><option>Option C</option><option>Option D</option></select></label></div>}{type === "Subjective" && <p className="mt-6 border-l-2 border-amber bg-amber/5 px-3 py-2 text-[12px] text-ink-soft">Subjective responses will be graded from the Evaluate queue.</p>}</section><section className="border border-line bg-paper p-6 sm:p-8"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Scoring and organization</p><h2 className="mt-1 font-serif text-xl font-semibold">How should this question be classified?</h2><div className="mt-6 grid gap-5 sm:grid-cols-2"><div><SelectField label="Unit" value={unit} onChange={setUnit} options={["Trees & Graphs", "Normalization", "Sorting", "OS Scheduling", "Networking", "Custom / Other"]}/>{unit === "Custom / Other" && <input value={customUnit} onChange={(e) => setCustomUnit(e.target.value)} placeholder="Enter your unit name" className="mt-2 block w-full border border-forest bg-paper px-3 py-2.5 text-[13px] outline-none"/>}</div><SelectField label="Difficulty" options={["Easy", "Medium", "Hard"]}/><label className="block text-[12px] text-ink-soft">Marks<input type="number" min={0} step="0.5" defaultValue={1} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/></label><label className="block text-[12px] text-ink-soft">Negative marking<input value={negativeMark} onChange={(e) => setNegativeMark(e.target.value)} placeholder="Enter value, e.g. 0.25" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/><span className="mt-1 block text-[10px] text-ink-soft">Leave blank if there is no negative marking.</span></label></div><label className="mt-5 block text-[12px] text-ink-soft">Explanation / solution<textarea rows={3} placeholder="Optional explanation for review and feedback…" className="mt-1 block w-full resize-y border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/></label><label className="mt-5 block text-[12px] text-ink-soft">Tags<input placeholder="e.g. trees, traversal, midterm" className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/><span className="mt-1 block text-[10px] text-ink-soft">Use commas to make this question easy to find later.</span></label></section></div><aside className="space-y-5"><section className="sticky top-24 border border-line bg-paper-raised p-5"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Live preview</p><h2 className="mt-1 font-serif text-xl font-semibold">Student view</h2></div><button onClick={() => setPreview(!preview)} className="font-mono text-[10px] uppercase text-forest">{preview ? "Hide" : "Show"}</button></div>{preview && <div className="mt-5 border border-line bg-paper p-4"><p className="font-mono text-[10px] text-ink-soft">Question 01 · {type}</p><p className="mt-3 text-[13px] leading-relaxed">{prompt || "Your question will appear here…"}</p></div>}<div className="mt-5 space-y-3 text-[12px] text-ink-soft"><p className={prompt.trim() ? "text-success" : "text-alert"}>{prompt.trim() ? "✓" : "○"} Question prompt</p><p className="text-success">✓ Answer format selected</p><p className="text-success">✓ Scoring fields ready</p><p className={unit === "Custom / Other" && !customUnit.trim() ? "text-alert" : "text-success"}>{unit === "Custom / Other" && !customUnit.trim() ? "○" : "✓"} Unit assigned</p></div></section><div className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Save question</p><p className="mt-2 text-[12px] text-ink-soft">The question will be available when you build or edit an exam.</p><div className="mt-4 grid gap-2"><Button primary onClick={save}>Save to question bank</Button><Button onClick={() => { setPrompt(""); setCustomUnit(""); setNegativeMark(""); setSaved(false); }}>Clear form</Button></div>{saved && <p className="mt-4 text-[12px] text-success">Question saved successfully.</p>}</div></aside></div></>;
}
