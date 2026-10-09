import { useState, useEffect } from "react";
import { PlusIcon, ArrowLeftIcon, ArrowRightIcon, NumberField } from "@/shared/components/ui";
import { FiUpload } from "react-icons/fi";
import ResultReleasePanel from "@/features/teacher/components/ResultReleasePanel";
import AccommodationsPanel from "@/features/teacher/components/AccommodationsPanel";
import MoodleLinksPanel from "@/features/teacher/components/MoodleLinksPanel";
import { PageHeading, Button, Field, Metric } from "@/features/teacher/components/PageChrome";
import useLiveAttempts from "@/features/teacher/hooks/useLiveAttempts";
import {
  listQuestionsForExam,
  listLiveAttempts,
  setAttemptPaused,
  sendProctorMessage,
  updateExam,
  getExamRoster,
} from "@/shared/data/examApi";
import JobBanner from "@/shared/components/JobBanner";
import { usePromptDialog } from "@/shared/components/PromptDialog";
import { downloadSessionReportPdf, reportProgress, reportViolationsFromFlags, type ReportRow } from "@/shared/services/sessionReport";

export function ExamWorkspace({ notify, navigate, examId, examsList }: { notify: (s: string) => void; navigate: (s: string) => void; examId: string; examsList: any[] }) {
  const exam = examsList.find(e => e.id === examId);
  if (!exam) return <div className="p-10 text-center text-soft">Loading exam workspace...</div>;
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
  return <>      <PageHeading eyebrow={`Exams / ${exam.name}`} title={exam.name} detail={`Exam ID ${exam.id} · ${exam.batch}`} action={<Button icon={<ArrowLeftIcon />} onClick={() => navigate("/teacher/exams")}>All exams</Button>} />
    <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border border-amber/30 bg-amber/5 px-5 py-4"><div><span className={`font-mono text-[10px] uppercase tracking-widest ${exam.tone}`}>{exam.state} · {exam.state === "Draft" ? "Not published" : "Ready"}</span><p className="mt-1 text-[13px]">Questions, delivery rules, difficulty and publishing are set in the paper builder for this test.</p></div><Button size="sm" iconRight={<ArrowRightIcon />} onClick={() => navigate(`/teacher/exams/${exam.id}/build`)}>Open paper builder</Button></div>
    <div className="mt-8 border-b border-line"><div className="flex gap-1 overflow-x-auto">{["Overview", "Questions", "Candidates", "Answers & results"].map((item) => <button key={item} onClick={() => setTab(item)} className={`whitespace-nowrap border-b-2 px-4 py-3 font-mono text-[10px] uppercase tracking-wider ${tab === item ? "border-forest text-forest" : "border-transparent text-soft hover:text-ink"}`}>{item}</button>)}</div></div>
    {tab === "Overview" && <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_330px]"><section className="border border-line bg-paper p-6"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Exam setup</p><h2 className="mt-1 font-serif text-xl font-semibold">Configuration</h2></div><span className="font-mono text-[10px] text-success">✓ Ready</span></div><div className="mt-6 divide-y divide-line">{setupRows.map(([label, value, complete]) => <div key={label} className="flex items-center justify-between gap-4 py-4"><div><p className="text-[13px] font-medium">{label}</p><p className="mt-1 text-[12px] text-soft">{value}</p></div><span className={`font-mono text-[10px] ${complete ? "text-success" : "text-amber"}`}>{complete ? "✓ Set" : "Review"}</span></div>)}<div className="flex items-center justify-between gap-4 py-4"><div><p className="text-[13px] font-medium">Question set & delivery</p><p className="mt-1 text-[12px] text-soft">Managed in the Questions tab</p></div><button onClick={() => setTab("Questions")} className="font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Manage /</button></div></div></section><aside className="space-y-5"><section className="border border-line bg-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-soft">At a glance</p><div className="mt-4 space-y-3"><InfoRow label="Questions" value={exam.count}/><InfoRow label="Duration" value={`${exam.duration}m`}/></div></section><section className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Questions & publishing</p><p className="mt-2 text-[13px] text-soft">Build the pool, set how many each student gets, then publish — all in one flow.</p><button onClick={() => setTab("Questions")} className="mt-4 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Open Questions tab /</button></section><section className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Live controls</p><p className="mt-2 text-[13px] text-soft">Auto-submit, late entry and in-exam rules.</p><button onClick={() => navigate(`/teacher/exams/${exam.id}/settings`)} className="mt-4 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">Edit exam settings /</button></section></aside></div>}      {tab === "Questions" && <ExamPaperHub examId={exam.id} notify={notify} navigate={navigate} />}
    {tab === "Candidates" && <section className="mt-8 max-w-4xl"><div className="flex items-end justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Assigned candidates</p><h2 className="mt-1 font-serif text-xl font-semibold">{exam.batch}</h2></div><Button onClick={() => navigate("/teacher/students")}>Manage roster</Button></div><div className="mt-4 grid gap-4 sm:grid-cols-3"><Metric label="Enrolled" value={String(roster.length)} detail="From enrollments" tone="text-ink"/><Metric label="Email verified" value={String(emailVerified)} detail={roster.length ? `${Math.round((emailVerified / roster.length) * 100)}% verified` : "No emails yet"} tone="text-success"/><Metric label="Access" value={exam.state === "Draft" ? "Locked" : "Open"} detail={exam.state === "Draft" ? "Until published" : "Join link live"} tone="text-amber"/></div><div className="mt-6 border border-line p-5 text-[13px] text-soft">Candidates receive the join link automatically when you publish from the paper builder (Publish &amp; share). Add or remove students on the <button onClick={() => navigate("/teacher/students")} className="font-mono text-[11px] uppercase tracking-wider text-forest hover:underline">Students page /</button></div><AccommodationsPanel examId={exam.id} notify={notify} /><MoodleLinksPanel examId={exam.id} notify={notify} /></section>}
    {tab === "Answers & results" && <section className="mt-8 max-w-4xl"><ResultReleasePanel exam={exam} notify={notify} /></section>}
  </>;
}
function InfoRow({ label, value }: { label: string; value: string }) { return <div className="flex justify-between border-b border-line pb-2 text-[12px] last:border-0"><span className="text-soft">{label}</span><span>{value}</span></div>; }

// The one way to shape a test's paper: everything routes into ExamStudio, the
// dedicated paper builder. This tab summarizes the current pool and links out
// (write / import / pick from My questions all happen inside the builder).
function ExamPaperHub({ examId, notify, navigate }: { examId: string; notify: (s: string) => void; navigate: (s: string) => void }) {
  const [pool, setPool] = useState<{ count: number; marks: number } | null>(null);
  useEffect(() => {
    let active = true;
    void listQuestionsForExam(examId).then((qs) => { if (active) setPool({ count: qs.length, marks: qs.reduce((sum, q) => sum + (q.marks || 1), 0) }); });
    return () => { active = false; };
  }, [examId]);
  return (
    <div className="mt-8 max-w-4xl space-y-6">
      <section className="border border-line bg-paper p-6">
        <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Paper builder</p>
        <div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h2 className="font-serif text-2xl font-semibold">Shaping this test's paper</h2>
            <p className="mt-1 text-[13px] text-soft">Questions, sections, difficulty, delivery rules and publishing are set in one place — the paper builder.</p>
          </div>
          <Button primary iconRight={<ArrowRightIcon />} onClick={() => navigate(`/teacher/exams/${examId}/build`)}>Open paper builder</Button>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-px border border-line bg-line">
          <div className="bg-paper px-4 py-3"><p className="font-serif text-2xl">{pool ? String(pool.count) : "…"}</p><p className="font-mono text-[9px] uppercase tracking-wider text-soft">Questions in pool</p></div>
          <div className="bg-paper px-4 py-3"><p className="font-serif text-2xl">{pool ? String(pool.marks) : "…"}</p><p className="font-mono text-[9px] uppercase tracking-wider text-soft">Total marks</p></div>
          <div className="bg-paper px-4 py-3"><p className="font-serif text-2xl">1</p><p className="font-mono text-[9px] uppercase tracking-wider text-soft">Builder page</p></div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button icon={<PlusIcon />} onClick={() => navigate(`/teacher/exams/${examId}/build`)}>Write new question</Button>
          <Button variant="secondary" icon={<FiUpload />} onClick={() => navigate(`/teacher/exams/${examId}/build`)}>Import CSV</Button>
          <Button variant="secondary" onClick={() => navigate("/teacher/bank")}>Browse My questions</Button>
        </div>
        <p className="mt-4 text-[12px] text-soft">Use the old inline editor on this tab? It's retired — the paper builder is the single place to add, edit, remove and import questions.</p>
      </section>
    </div>
  );
}

function ExamDetail({ notify, navigate, exam }: { notify: (s: string) => void; navigate: (s: string) => void; exam: any }) { 
  const { data: liveAttempts = [] } = useLiveAttempts(exam.id);
  const submitted = liveAttempts.filter(a => a.state === "Submitted").length;
  const inProgress = liveAttempts.filter(a => a.state === "In progress").length;
  const pausedCount = liveAttempts.filter(a => a.state === "Paused").length;
  const offline = liveAttempts.filter(a => a.state === "Not started").length;
  const flagCount = liveAttempts.reduce((n, a) => n + a.flags.length, 0);
  const criticalFlags = liveAttempts.reduce((n, a) => n + a.flags.filter((f) => f.severity === "critical").length, 0);
  const [rosterCount, setRosterCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [pdfJob, setPdfJob] = useState<string | null>(null);
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
  const [promptDialog, ask] = usePromptDialog();
  const broadcast = async () => {
    const body = await ask({
      title: "Broadcast message",
      detail: `Shown to every candidate writing ${exam.name}.`,
      confirmLabel: "Broadcast",
      multiline: true,
    });
    if (!body) return;
    const ok = await sendProctorMessage({ examId: exam.id, sender: "Teacher", senderRole: "teacher", body, kind: "broadcast" });
    notify(ok ? "Announcement broadcast to all candidates" : "Broadcast failed — could not save the message");
  };
  const exportReport = () => {
    if (pdfJob) return;
    const rows: ReportRow[] = liveAttempts.map((a) => ({
      name: a.name,
      roll: a.roll,
      state: a.state,
      progress: reportProgress(a),
      startedAt: a.startedAtIso ?? null,
      violations: reportViolationsFromFlags(a.flags),
    }));
    setPdfJob("Preparing session report…");
    void downloadSessionReportPdf(exam.name, exam.id, rows, new Date(), { onProgress: setPdfJob })
      .then(() => notify("PDF downloaded"))
      .catch(() => notify("PDF export failed"))
      .finally(() => setPdfJob(null));
  };
  return <>{promptDialog}<JobBanner label={pdfJob} /><PageHeading eyebrow="Exams / Open" title={exam.name} detail={`${exam.batch} · Live session`} action={<Button onClick={() => navigate("/teacher/exams")}>← Back to exams</Button>} /><div className="mt-8 flex flex-wrap items-center justify-between gap-4 border border-alert/30 bg-alert/5 px-5 py-4"><div><p className="font-mono text-[10px] uppercase tracking-widest text-alert">Live session</p><p className="mt-1 text-[13px]">The exam is in progress. Candidate activity is updating in real time.</p></div><span className="font-mono text-[11px] text-alert">● Running</span></div><div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Candidates" value={String(totalCandidates)} detail={`${inProgress} active · ${pausedCount} paused · ${offline} not started`} tone="text-ink"/><Metric label="Submitted" value={String(submitted)} detail="Received" tone="text-success"/><Metric label="In progress" value={String(inProgress)} detail="Active now" tone="text-ink"/><Metric label="Flags" value={String(flagCount)} detail={`${criticalFlags} critical`} tone={flagCount ? "text-alert" : "text-ink"}/></div><div className="mt-8 grid gap-6 xl:grid-cols-[1fr_360px]"><div className="space-y-6"><section className="border border-line bg-paper p-6"><div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Session progress</p><h2 className="mt-2 font-serif text-xl font-semibold">Candidate completion</h2></div><span className="font-mono text-[10px] text-alert">LIVE NOW</span></div><div className="mt-6 h-3 bg-line"><div className="h-full bg-forest" style={{ width: `${Math.min(100, Math.max(0, (submitted / totalCandidates) * 100))}%` }}/></div><div className="mt-3 flex justify-between font-mono text-[10px] text-soft"><span>{submitted} of {totalCandidates} submitted</span><span>{flagCount} flag(s)</span></div><div className="mt-7 grid gap-3 sm:grid-cols-3"><StatusRow label="Submitted" value={String(submitted)} tone="bg-success"/><StatusRow label="In progress" value={String(inProgress)} tone="bg-forest"/><StatusRow label="Paused" value={String(pausedCount)} tone="bg-amber"/></div></section><section className="border border-line"><div className="flex items-center justify-between border-b border-line px-5 py-4"><div><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Recent activity</p><h2 className="mt-1 font-serif text-xl font-semibold">What is happening now</h2></div><Button onClick={() => navigate("/teacher/submissions")}>View all</Button></div><div className="divide-y divide-line">{liveAttempts.slice(0,4).map((a) => <div key={a.id} className="flex gap-4 px-5 py-4"><span className="w-16 shrink-0 font-mono text-[10px] text-soft"></span><div><p className="text-[13px]">{a.name}</p><p className="mt-1 text-[11px] text-soft">{a.state}{a.flags.length ? ` · ${a.flags.length} flag(s)` : ""}</p></div></div>)}</div></section></div><aside className="space-y-6"><section className="border border-line bg-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Exam controls</p><div className="mt-4 grid gap-2"><Button onClick={() => void pauseAll()}>{busy ? "Pausing…" : "Pause exam"}</Button><Button onClick={() => void broadcast()}>Broadcast message</Button><Button onClick={() => navigate(`/teacher/exams/${exam.id}/settings`)}>Edit settings</Button><Button onClick={exportReport}>Export live report</Button></div></section><section className="border border-line p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Exam information</p><div className="mt-4 space-y-3 text-[12px]"><Info label="Questions" value={exam.count}/><Info label="Duration" value={`${exam.duration} minutes`}/><Info label="Security" value={exam.mode === "lockdown" ? "Lockdown Browser" : "Standard"}/><Info label="Assigned" value={exam.batch}/></div></section></aside></div></>; }

function StatusRow({ label, value, tone }: { label: string; value: string; tone: string }) { return <div><div className="flex items-center gap-2"><span className={`h-2 w-2 ${tone}`}/><span className="font-mono text-[11px] text-soft">{label}</span></div><p className="mt-1 pl-4 font-serif text-xl">{value}</p></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3 border-b border-line pb-2 last:border-0"><span className="text-soft">{label}</span><span className="text-right">{value}</span></div>; }
export function ExamSettings({ notify, navigate, examId, examsList }: { notify: (s: string) => void; navigate: (s: string) => void; examId: string; examsList: any[] }) {
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
  return <><PageHeading eyebrow="Exams / Settings" title="Exam settings" detail="Update the exam configuration carefully." action={<Button onClick={() => navigate(`/teacher/exams/${examId}`)}>← Back to exam</Button>} /><div className="mt-8 max-w-2xl space-y-6"><div className="border border-line p-6"><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Exam configuration</p><div className="mt-5 grid gap-5 sm:grid-cols-2"><Field label="Exam title" value={exam.name}/><Field label="Assigned batch" value={exam.batch}/><Field label="Duration" value={`${exam.duration}m`}/><Field label="Proctoring tier" value={exam.mode === "lockdown" ? "Lockdown Browser" : "Standard"}/></div></div><div className="border border-line p-6"><p className="font-mono text-[10px] uppercase tracking-widest text-soft">Live controls</p><div className="mt-4 space-y-4 text-[13px]"><label className="flex items-center justify-between gap-4"><span>Allow late entry</span><input type="checkbox" checked={allowLateEntry} onChange={(e) => setAllowLateEntry(e.target.checked)} className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Allow candidate questions</span><input type="checkbox" checked={allowQuestions} onChange={(e) => setAllowQuestions(e.target.checked)} className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Auto-submit enabled</span><input type="checkbox" checked={autoSubmitEnabled} onChange={(e) => setAutoSubmitEnabled(e.target.checked)} className="h-4 w-4 accent-forest"/></label>{autoSubmitEnabled && <><label className="flex items-center justify-between gap-4"><span>Auto-submit at time limit</span><input type="checkbox" checked={onTimeLimit} onChange={(e) => setOnTimeLimit(e.target.checked)} className="h-4 w-4 accent-forest"/></label><label className="flex items-center justify-between gap-4"><span>Auto-submit on violation count</span><input type="checkbox" checked={onViolationCount} onChange={(e) => setOnViolationCount(e.target.checked)} className="h-4 w-4 accent-forest"/></label>{onViolationCount && <label className="block text-[12px] text-soft">Violation count threshold<NumberField value={violationLimit} onChange={setViolationLimit} min={1} max={20} fallback={violationLimit} aria-label="Violation count threshold" className="mt-1 block w-full border border-line bg-paper px-3 py-2 text-[13px]"/></label>}</>}</div></div><div className="flex gap-2"><Button primary onClick={() => void save()}>{saving ? "Saving…" : "Save settings"}</Button><Button onClick={() => navigate(`/teacher/exams/${examId}`)}>Cancel</Button></div></div></>; }
