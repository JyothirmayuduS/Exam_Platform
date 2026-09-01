import { useState } from "react";
import { publishExam, type ExamRecord } from "../lib/examApi";

type Exam = { id: string; name: string; batch: string; state: string; tone: string };
type Question = { id: string; title: string; unit: string; type: string; difficulty: string; marks: number };
type ExamMode = "practice" | "lockdown";
type Settings = {
  perStudent: number; randomSelect: boolean; shuffleOrder: boolean; shuffleOptions: boolean;
  autoSubmit: boolean; duration: number; mode: ExamMode; attempts: number;
  negative: boolean; calculator: boolean; instantFeedback: boolean;
};
type Publish = { status: "draft" | "published" | "scheduled"; link?: string; when?: string; notified?: number };

const ENROLLED = 42;
const RECIPIENTS = [
  "21vgn0142@vignan.ac.in",
  "21vgn0158@vignan.ac.in",
  "21vgn0163@vignan.ac.in",
  "21vgn0171@vignan.ac.in",
];

const QUESTIONS: Question[] = [
  { id: "Q-1042", title: "Which traversal visits the root between the left and right subtrees?", unit: "Trees & Graphs", type: "MCQ", difficulty: "Medium", marks: 1 },
  { id: "Q-1043", title: "Which normal form removes transitive dependencies?", unit: "Normalization", type: "MCQ", difficulty: "Hard", marks: 1 },
  { id: "Q-1044", title: "Calculate the number of comparisons merge sort makes on 8 elements.", unit: "Sorting", type: "Numerical", difficulty: "Easy", marks: 2 },
  { id: "Q-1045", title: "Explain how priority scheduling can lead to starvation and how ageing solves it.", unit: "OS Scheduling", type: "Subjective", difficulty: "Medium", marks: 10 },
  { id: "Q-1046", title: "Which protocol provides reliable, ordered delivery of a byte stream?", unit: "Networking", type: "MCQ", difficulty: "Medium", marks: 1 },
  { id: "Q-1047", title: "Write a function that returns the height of a binary tree.", unit: "Trees & Graphs", type: "Coding", difficulty: "Medium", marks: 5 },
  { id: "Q-1048", title: "A hash table with chaining has load factor 0.75 — state the expected lookup cost.", unit: "Hashing", type: "Numerical", difficulty: "Medium", marks: 2 },
  { id: "Q-1049", title: "TCP and UDP both operate at the transport layer.", unit: "Networking", type: "True / False", difficulty: "Easy", marks: 1 },
];

const STEP_LABELS = ["Add questions", "Delivery & rules", "Review & publish"];
function studentLink(exam: Exam | null) { return `https://vignan.exam/join/${(exam?.id ?? "exam").toLowerCase()}`; }

export default function TeacherQuestionSetup({ exams, navigate, notify }: { exams: Exam[]; navigate: (path: string) => void; notify: (message: string) => void }) {
  const [selected, setSelected] = useState<Exam | null>(null);
  const [step, setStep] = useState(0);
  const [pool, setPool] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkFile, setBulkFile] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const [publish, setPublish] = useState<Publish>({ status: "draft" });
  const [schedDate, setSchedDate] = useState("");
  const [schedTime, setSchedTime] = useState("");
  const [copied, setCopied] = useState(false);
  const [notifyStudents, setNotifyStudents] = useState(true);
  const [s, setS] = useState<Settings>({ perStudent: 5, randomSelect: true, shuffleOrder: true, shuffleOptions: true, autoSubmit: true, duration: 45, mode: "lockdown", attempts: 1, negative: false, calculator: false, instantFeedback: false });
  const set = <K extends keyof Settings,>(k: K, v: Settings[K]) => setS((cur) => ({ ...cur, [k]: v }));

  const poolQuestions = QUESTIONS.filter((q) => pool.includes(q.id));
  const visible = QUESTIONS.filter((q) => `${q.id} ${q.title} ${q.unit}`.toLowerCase().includes(search.toLowerCase()) && (filter === "All" || q.type === filter));
  const totalMarks = poolQuestions.reduce((sum, q) => sum + q.marks, 0);
  const perStudent = Math.min(s.perStudent, Math.max(1, pool.length));

  const chooseExam = (exam: Exam) => {
    setSelected(exam); setStep(0);
    setPool(exam.id === "EXAM-2026-014" ? ["Q-1042", "Q-1044", "Q-1046"] : []);
    setSearch(""); setFilter("All"); setBulkOpen(false); setBulkFile(null);
    setPublish({ status: "draft" }); setDraftSaved(false);
  };
  const toggle = (id: string) => {
    const inPool = pool.includes(id);
    setPool((cur) => inPool ? cur.filter((x) => x !== id) : [...cur, id]);
    if (selected) notify(`${id} ${inPool ? "removed from" : "added to"} ${selected.name}`);
  };
  const addAllShown = () => { setPool((cur) => Array.from(new Set([...cur, ...visible.map((q) => q.id)]))); notify("Visible questions added to the pool"); };
  const downloadTemplate = () => {
    if (!selected) return;
    const header = "exam_id,question,type,option_a,option_b,option_c,option_d,answer,unit,difficulty,marks\n";
    const sample = `${selected.id},Which traversal visits the root between the left and right subtrees?,MCQ,Inorder,Preorder,Postorder,Level order,Inorder,Trees & Graphs,Medium,1\n`;
    const blank = `${selected.id},,MCQ,,,,,,,,\n`;
    const url = URL.createObjectURL(new Blob([header + sample + blank], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `${selected.id}-questions-template.csv`; a.click(); URL.revokeObjectURL(url);
    notify(`Template for ${selected.id} downloaded`);
  };
  const onBulkStage = (file: File | undefined) => { if (!file || !selected) return; setBulkFile(file.name); notify(`${file.name} staged for ${selected.id}`); };
  const buildRecord = (status: ExamRecord["status"], scheduledAt: string | null): ExamRecord | null => {
    if (!selected) return null;
    return {
      id: selected.id, name: selected.name, batch: selected.batch,
      mode: s.mode, status, duration_minutes: s.duration,
      per_student: perStudent, pool_count: pool.length, total_marks: totalMarks,
      scheduled_at: scheduledAt, join_link: studentLink(selected),
      settings: { ...s },
    };
  };
  // Persist to Supabase and report the real outcome. `offline` = no backend
  // configured (prototype demo data); a DB error usually means RLS is still
  // auth-scoped — run supabase/demo-policies.sql once to open the anon flow.
  const persist = (rec: ExamRecord | null, okMsg: string) => {
    if (!rec) return;
    void publishExam(rec).then((res) => {
      if (res.ok) notify(okMsg);
      else if (res.error === "offline") notify("Published in demo mode — connect Supabase to reach students live.");
      else notify(`Couldn't reach students: ${res.error}. Run supabase/demo-policies.sql, then republish.`);
    });
  };
  const publishNow = () => {
    const n = notifyStudents ? ENROLLED : 0;
    setPublish({ status: "published", link: studentLink(selected), notified: n });
    persist(buildRecord("published", null), n ? `Exam published — join link emailed to ${n} students` : "Exam published — students can start now");
  };
  const schedule = () => {
    if (!schedDate || !schedTime) return;
    const n = notifyStudents ? ENROLLED : 0;
    const whenIso = new Date(`${schedDate}T${schedTime}`).toISOString();
    setPublish({ status: "scheduled", link: studentLink(selected), when: `${schedDate} · ${schedTime}`, notified: n });
    persist(buildRecord("scheduled", whenIso), n ? `Scheduled for ${schedDate} ${schedTime} — students will be emailed` : `Scheduled for ${schedDate} ${schedTime}`);
  };
  const copyLink = () => { navigator.clipboard?.writeText(publish.link ?? "").catch(() => undefined); setCopied(true); notify("Student link copied"); window.setTimeout(() => setCopied(false), 2000); };
  const canContinue = step === 0 ? pool.length > 0 : true;

  if (!selected) return <ExamPicker exams={exams} navigate={navigate} onChoose={chooseExam} />;
  if (publish.status !== "draft") return <PublishedView selected={selected} publish={publish} settings={s} pool={pool.length} totalMarks={totalMarks} copied={copied} onCopy={copyLink} onReset={() => setPublish({ status: "draft" })} onExit={() => { setSelected(null); setPublish({ status: "draft" }); }} navigate={navigate} />;

  return (
    <div>
      <SetupHeader selected={selected} onExit={() => setSelected(null)} onSaveDraft={() => { setDraftSaved(true); notify("Draft saved"); }} draftSaved={draftSaved} pool={pool.length} totalMarks={totalMarks} perStudent={perStudent} mode={s.mode} />
      <Stepper step={step} onJump={(i) => { if (i === 0 || pool.length > 0) setStep(i); }} poolReady={pool.length > 0} />
      <div className="mt-8">
        {step === 0 && <StepAdd examId={selected.id} visible={visible} poolQuestions={poolQuestions} pool={pool} search={search} setSearch={setSearch} filter={filter} setFilter={setFilter} toggle={toggle} addAllShown={addAllShown} navigate={navigate} bulkOpen={bulkOpen} setBulkOpen={setBulkOpen} bulkFile={bulkFile} onBulkStage={onBulkStage} downloadTemplate={downloadTemplate} />}
        {step === 1 && <StepRules s={s} set={set} poolCount={pool.length} />}
        {step === 2 && <StepPublish selected={selected} settings={s} pool={pool.length} totalMarks={totalMarks} perStudent={perStudent} schedDate={schedDate} setSchedDate={setSchedDate} schedTime={schedTime} setSchedTime={setSchedTime} onPublishNow={publishNow} onSchedule={schedule} notifyStudents={notifyStudents} setNotifyStudents={setNotifyStudents} />}
      </div>
      <StepNav step={step} canContinue={canContinue} onBack={() => setStep((x) => Math.max(0, x - 1))} onNext={() => setStep((x) => Math.min(2, x + 1))} />
    </div>
  );
}

function ExamPicker({ exams, navigate, onChoose }: { exams: Exam[]; navigate: (p: string) => void; onChoose: (e: Exam) => void }) {
  return (
    <div>
      <div className="flex flex-col justify-between gap-5 border-b border-line pb-7 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty console / Questions</p>
          <h1 className="mt-2 font-serif text-4xl font-semibold">Build an exam</h1>
          <p className="mt-2 max-w-xl text-[13px] text-ink-soft">Pick an exam, add its questions, set the rules, then publish — in three guided steps.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate("/teacher/exams/new")} className="border border-line-strong px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:border-forest hover:text-forest">+ Create exam</button>
          <button onClick={() => navigate("/teacher/questions/new")} className="border border-forest bg-forest px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-paper transition hover:bg-forest-light">+ New question</button>
        </div>
      </div>
      <p className="mt-6 font-mono text-[10px] uppercase tracking-widest text-forest">Your exams · {exams.length}</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {exams.map((exam) => {
          const seeded = exam.id === "EXAM-2026-014";
          return (
            <button key={exam.id} onClick={() => onChoose(exam)} className="group border border-line bg-paper p-6 text-left transition hover:-translate-y-0.5 hover:border-forest hover:shadow-md">
              <div className="flex items-start justify-between gap-5">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{exam.id}</p>
                  <h3 className="mt-3 font-serif text-2xl font-semibold group-hover:text-forest">{exam.name}</h3>
                  <p className="mt-2 text-[13px] text-ink-soft">{exam.batch}</p>
                </div>
                <span className={`font-mono text-[10px] uppercase tracking-wider ${exam.tone}`}>{exam.state}</span>
              </div>
              <div className="mt-8 grid grid-cols-3 border-t border-line pt-4">
                <PickStat label="Pool" value={seeded ? "3 questions" : "Not started"} />
                <PickStat label="Mode" value={seeded ? "Lockdown" : "—"} />
                <div className="text-right"><span className="font-mono text-[10px] uppercase tracking-wider text-forest">Open →</span></div>
              </div>
            </button>
          );
        })}
      </div>
      {exams.length === 0 && (
        <div className="mt-4 border border-dashed border-line-strong p-12 text-center">
          <p className="font-serif text-xl">No exams yet</p>
          <p className="mt-2 text-[13px] text-ink-soft">Create an exam first. It appears here when you are ready to add questions.</p>
          <button onClick={() => navigate("/teacher/exams/new")} className="mt-5 border border-forest bg-forest px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-paper">Create your first exam</button>
        </div>
      )}
    </div>
  );
}
function PickStat({ label, value }: { label: string; value: string }) { return <div><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p><p className="mt-1 text-[12px]">{value}</p></div>; }

function SetupHeader({ selected, onExit, onSaveDraft, draftSaved, pool, totalMarks, perStudent, mode }: { selected: Exam; onExit: () => void; onSaveDraft: () => void; draftSaved: boolean; pool: number; totalMarks: number; perStudent: number; mode: ExamMode }) {
  return (
    <div className="border-b border-line pb-6">
      <button onClick={onExit} className="font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:text-forest">← All exams</button>
      <div className="mt-4 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">{selected.id}</p>
          <h1 className="mt-2 font-serif text-4xl font-semibold">{selected.name}</h1>
          <p className="mt-2 text-[13px] text-ink-soft">{selected.batch}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HeadStat label="In pool" value={String(pool)} />
          <HeadStat label="Marks" value={String(totalMarks)} />
          <HeadStat label="Per student" value={String(perStudent)} />
          <HeadStat label="Mode" value={mode === "lockdown" ? "Lockdown" : "Practice"} tone={mode === "lockdown" ? "text-maroon" : "text-forest"} />
          <button onClick={onSaveDraft} className="border border-line-strong px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition hover:border-forest hover:text-forest">{draftSaved ? "✓ Saved" : "Save draft"}</button>
        </div>
      </div>
    </div>
  );
}
function HeadStat({ label, value, tone = "text-ink" }: { label: string; value: string; tone?: string }) { return <div className="border border-line bg-paper-raised px-3 py-2 text-center"><p className={`font-serif text-lg leading-none ${tone}`}>{value}</p><p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p></div>; }

function Stepper({ step, onJump, poolReady }: { step: number; onJump: (i: number) => void; poolReady: boolean }) {
  return (
    <div className="mt-6 grid gap-px border border-line bg-line sm:grid-cols-3">
      {STEP_LABELS.map((label, i) => {
        const active = i === step, done = i < step, locked = i > 0 && !poolReady;
        return (
          <button key={label} onClick={() => onJump(i)} disabled={locked} className={`flex items-center gap-3 bg-paper px-5 py-4 text-left transition ${active ? "bg-paper-raised" : ""} ${locked ? "cursor-not-allowed opacity-50" : "hover:bg-paper-raised"}`}>
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center border font-mono text-[11px] ${active ? "border-forest bg-forest text-paper" : done ? "border-forest text-forest" : "border-line-strong text-ink-soft"}`}>{done ? "✓" : i + 1}</span>
            <span>
              <span className="block font-mono text-[9px] uppercase tracking-widest text-ink-soft">Step {i + 1}</span>
              <span className={`block text-[13px] font-medium ${active ? "text-forest" : "text-ink"}`}>{label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
function StepNav({ step, canContinue, onBack, onNext }: { step: number; canContinue: boolean; onBack: () => void; onNext: () => void }) {
  return (
    <div className="mt-8 flex items-center justify-between border-t border-line pt-6">
      <button onClick={onBack} disabled={step === 0} className={`border px-5 py-3 font-mono text-[10px] uppercase tracking-wider ${step === 0 ? "cursor-not-allowed border-line text-ink-soft/40" : "border-line-strong text-ink-soft hover:border-forest hover:text-forest"}`}>← Back</button>
      {step < 2 ? (
        <button onClick={onNext} disabled={!canContinue} title={canContinue ? undefined : "Add at least one question first"} className={`border px-6 py-3 font-mono text-[10px] uppercase tracking-wider ${canContinue ? "border-forest bg-forest text-paper hover:bg-forest-light" : "cursor-not-allowed border-line bg-paper-raised text-ink-soft"}`}>{step === 0 ? "Next: rules →" : "Next: publish →"}</button>
      ) : <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Choose an option below ↓</span>}
    </div>
  );
}

type AddProps = {
  examId: string; visible: Question[]; poolQuestions: Question[]; pool: string[];
  search: string; setSearch: (v: string) => void; filter: string; setFilter: (v: string) => void;
  toggle: (id: string) => void; addAllShown: () => void; navigate: (p: string) => void;
  bulkOpen: boolean; setBulkOpen: (v: boolean) => void; bulkFile: string | null;
  onBulkStage: (f: File | undefined) => void; downloadTemplate: () => void;
};
function StepAdd(p: AddProps) {
  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        <button onClick={() => p.navigate(`/teacher/questions/new?exam=${p.examId}`)} className="group border border-line bg-paper p-6 text-left transition hover:border-forest hover:shadow-md">
          <div className="flex items-center justify-between"><span className="font-mono text-[10px] uppercase tracking-widest text-forest">Manual</span><span className="font-serif text-2xl text-ink-soft group-hover:text-forest">✎</span></div>
          <h3 className="mt-3 font-serif text-xl font-semibold">Write a question</h3>
          <p className="mt-2 text-[12px] text-ink-soft">Open the editor and craft questions one at a time — MCQ, coding, subjective and more. Each is linked to {p.examId}.</p>
          <span className="mt-4 inline-block font-mono text-[10px] uppercase tracking-wider text-forest">Open editor →</span>
        </button>
        <button onClick={() => p.setBulkOpen(!p.bulkOpen)} className={`group border p-6 text-left transition hover:shadow-md ${p.bulkOpen ? "border-forest bg-success/5" : "border-line bg-paper hover:border-forest"}`}>
          <div className="flex items-center justify-between"><span className="font-mono text-[10px] uppercase tracking-widest text-forest">Bulk</span><span className="font-serif text-2xl text-ink-soft group-hover:text-forest">↑</span></div>
          <h3 className="mt-3 font-serif text-xl font-semibold">Import from a file</h3>
          <p className="mt-2 text-[12px] text-ink-soft">Upload up to 500 questions from CSV or Excel. The template already carries the {p.examId} exam ID.</p>
          <span className="mt-4 inline-block font-mono text-[10px] uppercase tracking-wider text-forest">{p.bulkOpen ? "Hide importer" : "Open importer →"}</span>
        </button>
      </div>
      {p.bulkOpen && (
        <section className="mt-4 border border-forest bg-success/5 p-5 sm:p-6">
          <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
            <label className="flex cursor-pointer flex-col items-center justify-center border border-dashed border-forest bg-paper px-6 py-8 text-center transition hover:bg-paper-raised">
              <span className="text-2xl text-forest">↑</span>
              <span className="mt-2 text-[13px] font-medium">Choose CSV or Excel file</span>
              <span className="mt-1 text-[12px] text-ink-soft">.csv, .xlsx, .xls · up to 500 questions</span>
              <input type="file" accept=".csv,.xlsx,.xls" className="sr-only" onChange={(e) => p.onBulkStage(e.target.files?.[0])} />
            </label>
            <div className="border border-line bg-paper p-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Template · {p.examId}</p>
              <p className="mt-3 text-[12px] leading-relaxed text-ink-soft">Columns: exam_id, question, type, options, answer, unit, difficulty, marks. The exam ID is pre-filled so rows land in the right exam.</p>
              <button onClick={p.downloadTemplate} className="mt-4 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">↓ Download template</button>
            </div>
          </div>
          {p.bulkFile && (
            <div className="mt-4 flex flex-col justify-between gap-3 border-t border-forest/20 pt-4 sm:flex-row sm:items-center">
              <div><p className="text-[13px] font-medium text-success">✓ {p.bulkFile} staged for {p.examId}</p><p className="mt-1 text-[11px] text-ink-soft">Rows are validated on import — you review them before they join the pool.</p></div>
              <button onClick={() => p.navigate(`/teacher/questions/new?exam=${p.examId}&bulk=1`)} className="border border-forest bg-forest px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper">Review imported rows →</button>
            </div>
          )}
        </section>
      )}
      <BankPanel {...p} />
    </div>
  );
}

function BankPanel(p: AddProps) {
  return (
    <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="border border-line bg-paper">
        <div className="border-b border-line bg-paper-raised p-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div><p className="font-mono text-[10px] uppercase tracking-widest text-forest">From the question bank</p><h2 className="mt-1 font-serif text-xl font-semibold">Pick existing questions</h2></div>
            <button onClick={p.addAllShown} className="border border-forest px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-forest hover:bg-forest hover:text-paper">Add all shown</button>
          </div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input value={p.search} onChange={(e) => p.setSearch(e.target.value)} placeholder="Search questions, IDs, or topics" className="min-w-0 flex-1 border border-line-strong bg-paper px-3 py-3 text-[13px] outline-none focus:border-forest" />
            <select value={p.filter} onChange={(e) => p.setFilter(e.target.value)} className="border border-line-strong bg-paper px-3 py-3 text-[13px]">
              <option>All</option><option>MCQ</option><option>MSQ</option><option>Numerical</option><option>True / False</option><option>Subjective</option><option>Coding</option>
            </select>
          </div>
        </div>
        <div className="divide-y divide-line">
          {p.visible.map((q) => <BankRow key={q.id} q={q} added={p.pool.includes(q.id)} onToggle={() => p.toggle(q.id)} />)}
          {p.visible.length === 0 && <p className="p-6 text-center text-[12px] text-ink-soft">No questions match your search.</p>}
        </div>
      </section>
      <aside>
        <section className="border border-forest bg-success/5 p-5">
          <div className="flex items-center justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-forest">Exam pool</p><h2 className="mt-1 font-serif text-xl font-semibold">Ready to deliver</h2></div><span className="font-mono text-[11px] text-forest">{p.poolQuestions.length} total</span></div>
          <div className="mt-5 border-t border-forest/20 pt-4">
            {p.poolQuestions.length ? p.poolQuestions.map((q) => (
              <div key={q.id} className="flex items-start justify-between gap-3 border-b border-forest/15 py-3 last:border-0">
                <div><span className="font-mono text-[10px] text-forest">{q.id}</span><p className="mt-1 text-[12px] leading-snug">{q.title}</p></div>
                <button onClick={() => p.toggle(q.id)} className="text-ink-soft hover:text-alert" aria-label={`Remove ${q.id}`}>×</button>
              </div>
            )) : <p className="py-5 text-[12px] text-ink-soft">Add from the bank, write new ones, or import a file. They collect here.</p>}
          </div>
        </section>
      </aside>
    </div>
  );
}
function BankRow({ q, added, onToggle }: { q: Question; added: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-col gap-4 p-5 hover:bg-paper-raised sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <span className={`mt-1 h-5 w-5 shrink-0 border text-center text-[12px] leading-5 ${added ? "border-forest bg-forest text-paper" : "border-line-strong text-transparent"}`}>✓</span>
        <div>
          <div className="flex flex-wrap gap-2"><span className="font-mono text-[10px] text-ink-soft">{q.id}</span><span className="bg-paper-raised px-2 py-1 font-mono text-[10px] text-ink-soft">{q.unit}</span><span className="bg-paper-raised px-2 py-1 font-mono text-[10px] text-ink-soft">{q.type}</span></div>
          <p className="mt-3 text-[14px] leading-relaxed">{q.title}</p>
          <p className="mt-2 text-[11px] text-ink-soft">{q.marks} {q.marks === 1 ? "mark" : "marks"} · {q.difficulty}</p>
        </div>
      </div>
      <button onClick={onToggle} className={`shrink-0 border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${added ? "border-line-strong text-ink-soft" : "border-forest bg-forest text-paper"}`}>{added ? "Remove" : "Add to pool"}</button>
    </div>
  );
}

type SetFn = <K extends keyof Settings>(k: K, v: Settings[K]) => void;
function StepRules({ s, set, poolCount }: { s: Settings; set: SetFn; poolCount: number }) {
  const maxPer = Math.max(1, poolCount);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <section className="border border-line bg-paper p-6">
          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Exam mode</p>
          <h2 className="mt-1 font-serif text-xl font-semibold">How should this run?</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <ModeCard active={s.mode === "practice"} onClick={() => set("mode", "practice")} title="Practice" tone="forest" points={["Relaxed — no lockdown", "Multiple attempts allowed", "Instant score after submit", "Great for revision & mock tests"]} />
            <ModeCard active={s.mode === "lockdown"} onClick={() => set("mode", "lockdown")} title="Lockdown" tone="maroon" points={["Full-screen, tab-switch blocked", "Camera + mic proctoring on", "Single timed attempt", "For graded, high-stakes exams"]} />
          </div>
        </section>
        <section className="border border-line bg-paper p-6">
          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Question delivery</p>
          <h2 className="mt-1 font-serif text-xl font-semibold">What each student sees</h2>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <NumField label="Questions per student" hint={`Up to ${maxPer} in the pool`} value={Math.min(s.perStudent, maxPer)} min={1} max={maxPer} onChange={(v) => set("perStudent", v)} />
            <NumField label="Duration (minutes)" hint="Total time allowed" value={s.duration} min={1} max={300} onChange={(v) => set("duration", v)} />
          </div>
          <ToggleRow label="Randomly select questions" detail="Each student gets a different set drawn from the pool." checked={s.randomSelect} onChange={(v) => set("randomSelect", v)} />
          <ToggleRow label="Shuffle question order" detail="Questions appear in a different order per student." checked={s.shuffleOrder} onChange={(v) => set("shuffleOrder", v)} />
          <ToggleRow label="Shuffle answer options" detail="Options within MCQ / MSQ are randomized." checked={s.shuffleOptions} onChange={(v) => set("shuffleOptions", v)} />
        </section>
        <section className="border border-line bg-paper p-6">
          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Rules & scoring</p>
          <h2 className="mt-1 font-serif text-xl font-semibold">Submission and marking</h2>
          <ToggleRow label="Auto-submit when time runs out" detail="The paper submits automatically at 00:00 so no one runs over." checked={s.autoSubmit} onChange={(v) => set("autoSubmit", v)} />
          <ToggleRow label="Negative marking" detail="Deduct marks for wrong answers on auto-graded questions." checked={s.negative} onChange={(v) => set("negative", v)} />
          <ToggleRow label="Allow calculator & rough sheet" detail="Show an on-screen calculator and scratch pad." checked={s.calculator} onChange={(v) => set("calculator", v)} />
          {s.mode === "practice" ? (
            <div className="mt-5 border-t border-line pt-4">
              <NumField label="Attempts allowed" hint="Practice mode only" value={s.attempts} min={1} max={10} onChange={(v) => set("attempts", v)} />
              <ToggleRow label="Show answers after each attempt" detail="Students see correct answers and explanations instantly." checked={s.instantFeedback} onChange={(v) => set("instantFeedback", v)} />
            </div>
          ) : <div className="mt-5 border-l-2 border-maroon bg-maroon/5 px-4 py-3 text-[12px] text-ink-soft">Lockdown enforces a single attempt. Results stay hidden until you release them from the Evaluate page.</div>}
        </section>
      </div>
      <RulesPreview s={s} poolCount={poolCount} maxPer={maxPer} />
    </div>
  );
}

function RulesPreview({ s, poolCount, maxPer }: { s: Settings; poolCount: number; maxPer: number }) {
  return (
    <aside>
      <section className="border border-line bg-paper-raised p-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Live preview</p>
        <h2 className="mt-1 font-serif text-lg font-semibold">Student paper</h2>
        <dl className="mt-4 space-y-2 text-[12px]">
          <PreviewRow label="Mode" value={s.mode === "lockdown" ? "Lockdown · proctored" : "Practice · relaxed"} />
          <PreviewRow label="Questions" value={`${Math.min(s.perStudent, maxPer)} of ${poolCount}`} />
          <PreviewRow label="Duration" value={`${s.duration} min`} />
          <PreviewRow label="Selection" value={s.randomSelect ? "Random per student" : "Same for everyone"} />
          <PreviewRow label="Order" value={s.shuffleOrder ? "Shuffled" : "Fixed"} />
          <PreviewRow label="Options" value={s.shuffleOptions ? "Shuffled" : "Fixed"} />
          <PreviewRow label="Auto-submit" value={s.autoSubmit ? "On time-up" : "Manual only"} />
          <PreviewRow label="Negative marking" value={s.negative ? "Yes" : "No"} />
          <PreviewRow label="Calculator" value={s.calculator ? "Allowed" : "Off"} />
          <PreviewRow label="Attempts" value={s.mode === "practice" ? String(s.attempts) : "1"} />
        </dl>
      </section>
    </aside>
  );
}
function ModeCard({ active, onClick, title, points, tone }: { active: boolean; onClick: () => void; title: string; points: string[]; tone: "forest" | "maroon" }) {
  const border = active ? (tone === "maroon" ? "border-maroon bg-maroon/5" : "border-forest bg-success/5") : "border-line-strong";
  const knob = active ? (tone === "maroon" ? "border-maroon bg-maroon text-paper" : "border-forest bg-forest text-paper") : "border-line-strong text-transparent";
  return (
    <button onClick={onClick} className={`border p-5 text-left transition ${border}`}>
      <div className="flex items-center justify-between"><span className="font-serif text-lg font-semibold">{title}</span><span className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${knob}`}>●</span></div>
      <ul className="mt-4 space-y-2">{points.map((pt) => <li key={pt} className="flex gap-2 text-[12px] text-ink-soft"><span className={tone === "maroon" ? "text-maroon" : "text-forest"}>›</span>{pt}</li>)}</ul>
    </button>
  );
}
function NumField({ label, hint, value, min, max, onChange }: { label: string; hint: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="block text-[12px] text-ink-soft">
      <span className="font-medium text-ink">{label}</span><span className="mt-0.5 block text-[11px]">{hint}</span>
      <input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))} className="mt-2 block w-full border border-line-strong bg-paper px-3 py-3 text-[13px] outline-none focus:border-forest" />
    </label>
  );
}
function ToggleRow({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="mt-5 flex items-start justify-between gap-4 border-t border-line pt-4">
      <span><span className="block text-[12px] font-medium">{label}</span><span className="mt-1 block text-[11px] text-ink-soft">{detail}</span></span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative mt-0.5 h-5 w-9 shrink-0 border transition ${checked ? "border-forest bg-forest" : "border-line-strong bg-paper"}`}>
        <span className={`absolute top-0.5 h-3.5 w-3.5 transition-all ${checked ? "left-[18px] bg-paper" : "left-0.5 border border-line-strong bg-paper"}`} />
      </button>
    </div>
  );
}
function PreviewRow({ label, value }: { label: string; value: string }) { return <div className="flex items-center justify-between gap-3 border-b border-line/60 pb-2 last:border-0"><dt className="text-ink-soft">{label}</dt><dd className="font-medium">{value}</dd></div>; }

function StepPublish({ selected, settings, pool, totalMarks, perStudent, schedDate, setSchedDate, schedTime, setSchedTime, onPublishNow, onSchedule, notifyStudents, setNotifyStudents }: { selected: Exam; settings: Settings; pool: number; totalMarks: number; perStudent: number; schedDate: string; setSchedDate: (v: string) => void; schedTime: string; setSchedTime: (v: string) => void; onPublishNow: () => void; onSchedule: () => void; notifyStudents: boolean; setNotifyStudents: (v: boolean) => void }) {
  const ready = pool > 0;
  const checklist: [string, boolean][] = [
    [`${pool} question${pool === 1 ? "" : "s"} in the pool`, pool > 0],
    [`${perStudent} delivered per student`, perStudent > 0],
    [`Duration set to ${settings.duration} min`, settings.duration > 0],
    [`${settings.mode === "lockdown" ? "Lockdown" : "Practice"} mode configured`, true],
  ];
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="border border-line bg-paper p-6 sm:p-8">
        <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Final review</p>
        <h2 className="mt-1 font-serif text-2xl font-semibold">{selected.name}</h2>
        <p className="mt-1 text-[12px] text-ink-soft">{selected.id} · {selected.batch}</p>
        <div className="mt-6 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
          <BigStat label="Questions" value={String(pool)} /><BigStat label="Per student" value={String(perStudent)} /><BigStat label="Total marks" value={String(totalMarks)} /><BigStat label="Duration" value={`${settings.duration}m`} />
        </div>
        <div className="mt-6 space-y-3">
          {checklist.map(([label, ok]) => <div key={label} className="flex items-center gap-3 border-b border-line pb-3 text-[13px] last:border-0"><span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${ok ? "bg-success text-paper" : "border border-amber text-amber"}`}>{ok ? "✓" : "!"}</span><span>{label}</span></div>)}
        </div>
      </section>
      <aside className="space-y-4">
        <section className="border border-line bg-paper p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Notify students</p>
              <h3 className="mt-1 font-serif text-lg font-semibold">Email the join link</h3>
            </div>
            <button role="switch" aria-checked={notifyStudents} onClick={() => setNotifyStudents(!notifyStudents)} className={`mt-1 flex h-6 w-11 shrink-0 items-center rounded-full border transition ${notifyStudents ? "justify-end border-forest bg-forest" : "justify-start border-line-strong bg-paper-raised"}`}><span className="mx-0.5 h-4 w-4 rounded-full bg-paper" /></button>
          </div>
          <p className="mt-2 text-[12px] text-ink-soft">{notifyStudents ? <>An email with the join link and start time goes to all <span className="text-ink">{ENROLLED} students</span> in {selected.batch}.</> : "Publishing silently — no email is sent. You can share the link yourself."}</p>
          {notifyStudents && <div className="mt-3 border border-line bg-paper-raised p-3"><p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">Recipients preview</p><div className="mt-1.5 space-y-0.5">{RECIPIENTS.map((e) => <p key={e} className="truncate font-mono text-[11px] text-ink-soft">{e}</p>)}<p className="font-mono text-[11px] text-ink-soft">+ {ENROLLED - RECIPIENTS.length} more…</p></div></div>}
        </section>
        <section className="border border-forest bg-success/5 p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Publish now</p>
          <h3 className="mt-1 font-serif text-lg font-semibold">Go live instantly</h3>
          <p className="mt-2 text-[12px] text-ink-soft">Students in {selected.batch} can start the moment you click. The join link is generated right away{notifyStudents ? " and emailed automatically" : ""}.</p>
          <button onClick={onPublishNow} disabled={!ready} className={`mt-4 w-full py-3 font-mono text-[10px] uppercase tracking-wider ${ready ? "border border-forest bg-forest text-paper hover:bg-forest-light" : "cursor-not-allowed border border-line bg-paper-raised text-ink-soft"}`}>{notifyStudents ? `● Publish & email ${ENROLLED} students` : "● Publish now"}</button>
        </section>
        <section className="border border-line bg-paper p-5">
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Or schedule</p>
          <h3 className="mt-1 font-serif text-lg font-semibold">Set a start time</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] text-ink-soft">Date<input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest" /></label>
            <label className="text-[11px] text-ink-soft">Time<input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest" /></label>
          </div>
          <button onClick={onSchedule} disabled={!ready || !schedDate || !schedTime} className={`mt-4 w-full py-3 font-mono text-[10px] uppercase tracking-wider ${ready && schedDate && schedTime ? "border border-line-strong text-ink hover:border-forest hover:text-forest" : "cursor-not-allowed border border-line text-ink-soft/50"}`}>{notifyStudents ? "◷ Schedule & email students" : "◷ Schedule exam"}</button>
        </section>
      </aside>
    </div>
  );
}
function BigStat({ label, value }: { label: string; value: string }) { return <div className="bg-paper px-4 py-4 text-center"><p className="font-serif text-2xl">{value}</p><p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p></div>; }
function PublishedView({ selected, publish, settings, pool, totalMarks, copied, onCopy, onReset, onExit, navigate }: { selected: Exam; publish: Publish; settings: Settings; pool: number; totalMarks: number; copied: boolean; onCopy: () => void; onReset: () => void; onExit: () => void; navigate: (p: string) => void }) {
  const scheduled = publish.status === "scheduled";
  return (
    <div className="mx-auto max-w-3xl">
      <div className="border border-forest bg-success/5 p-8 text-center">
        <span className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full text-2xl text-paper ${scheduled ? "bg-amber" : "bg-success"}`}>{scheduled ? "◷" : "✓"}</span>
        <h1 className="mt-5 font-serif text-3xl font-semibold">{scheduled ? "Exam scheduled" : "Exam published"}</h1>
        <p className="mt-2 text-[13px] text-ink-soft">{scheduled ? `${selected.name} will open on ${publish.when}.` : `${selected.name} is live now for ${selected.batch}.`}</p>
      </div>
      <div className="mt-4 border border-line bg-paper p-6">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Student join link</p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 truncate border border-line bg-paper-raised px-3 py-3 font-mono text-[12px]">{publish.link}</code>
          <button onClick={onCopy} className="border border-forest bg-forest px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">{copied ? "✓ Copied" : "Copy link"}</button>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
          <BigStat label="Questions" value={String(pool)} /><BigStat label="Total marks" value={String(totalMarks)} /><BigStat label="Duration" value={`${settings.duration}m`} /><BigStat label="Mode" value={settings.mode === "lockdown" ? "Lockdown" : "Practice"} />
        </div>
        {publish.notified
          ? <div className="mt-4 flex flex-wrap items-center gap-3 border border-forest bg-success/5 px-4 py-3"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-success text-[13px] text-paper">✉</span><p className="text-[12px] text-ink"><span className="font-semibold">Join link emailed to {publish.notified} students.</span> {scheduled ? "A reminder will resend when the exam opens." : "Delivered to their college inboxes just now."}</p></div>
          : <div className="mt-4 border border-line bg-paper-raised px-4 py-3 text-[12px] text-ink-soft">No email sent — share the join link above with your students.</div>}
      </div>
      <div className="mt-4 flex flex-wrap justify-between gap-3">
        <button onClick={onReset} className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-forest">← Edit settings</button>
        <div className="flex gap-2">
          <button onClick={() => navigate("/teacher/submissions")} className="border border-line-strong px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-forest">Track submissions →</button>
          <button onClick={onExit} className="border border-forest bg-forest px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light">Done</button>
        </div>
      </div>
    </div>
  );
}
