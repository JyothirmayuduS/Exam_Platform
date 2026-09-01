import { useMemo, useState } from "react";

type Exam = {
  id: string;
  name: string;
  batch: string;
  state: string;
  tone: string;
};

type Question = {
  id: string;
  title: string;
  unit: string;
  type: string;
  difficulty: string;
  marks: number;
  used: number;
};

const bank: Question[] = [
  { id: "Q-1042", title: "Which traversal visits the root between the left and right subtrees?", unit: "Trees & Graphs", type: "MCQ", difficulty: "Medium", marks: 1, used: 4 },
  { id: "Q-1043", title: "Which normal form removes transitive dependencies?", unit: "Normalization", type: "MCQ", difficulty: "Hard", marks: 1, used: 2 },
  { id: "Q-1044", title: "Calculate the number of comparisons made by merge sort.", unit: "Sorting", type: "Numerical", difficulty: "Easy", marks: 2, used: 6 },
  { id: "Q-1045", title: "Explain how priority scheduling can lead to starvation.", unit: "OS Scheduling", type: "Subjective", difficulty: "Medium", marks: 10, used: 1 },
  { id: "Q-1046", title: "Which protocol is responsible for reliable delivery?", unit: "Networking", type: "MCQ", difficulty: "Medium", marks: 1, used: 3 },
  { id: "Q-1047", title: "What is the worst-case time complexity of quicksort?", unit: "Sorting", type: "MCQ", difficulty: "Medium", marks: 1, used: 5 },
  { id: "Q-1048", title: "A balanced BST of height h holds at most how many nodes?", unit: "Trees & Graphs", type: "Numerical", difficulty: "Hard", marks: 2, used: 2 },
  { id: "Q-1049", title: "Write a function to detect a cycle in a singly linked list.", unit: "Trees & Graphs", type: "Coding", difficulty: "Hard", marks: 5, used: 3 },
  { id: "Q-1050", title: "Which data structure uses FIFO ordering?", unit: "Trees & Graphs", type: "MCQ", difficulty: "Easy", marks: 1, used: 7 },
  { id: "Q-1051", title: "Explain the difference between BCNF and 3NF with an example.", unit: "Normalization", type: "Subjective", difficulty: "Hard", marks: 10, used: 2 },
  { id: "Q-1052", title: "Compute the average turnaround time for the given round-robin schedule.", unit: "OS Scheduling", type: "Numerical", difficulty: "Medium", marks: 3, used: 1 },
  { id: "Q-1053", title: "Which layer of the OSI model performs routing?", unit: "Networking", type: "MCQ", difficulty: "Easy", marks: 1, used: 4 },
];

export default function TeacherQuestionBank({ availableExams, navigate, notify }: { availableExams: Exam[]; navigate: (path: string) => void; notify: (message: string) => void }) {
  const [selectedExamId, setSelectedExamId] = useState("");
  const [pool, setPool] = useState<string[]>(["Q-1042", "Q-1044"]);
  const [query, setQuery] = useState("");
  const [unit, setUnit] = useState("All units");
  const [type, setType] = useState("All types");
  const [activeTab, setActiveTab] = useState<"bank" | "pool">("bank");
  const [questionsPerStudent, setQuestionsPerStudent] = useState(2);
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [shuffleOrder, setShuffleOrder] = useState(true);
  const selectedExam = availableExams.find((exam) => exam.id === selectedExamId);
  const filtered = useMemo(() => bank.filter((question) => {
    const matchesQuery = `${question.id} ${question.title} ${question.unit}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (unit === "All units" || question.unit === unit) && (type === "All types" || question.type === type);
  }), [query, unit, type]);
  const poolQuestions = bank.filter((question) => pool.includes(question.id));
  const addAll = () => {
    const next = Array.from(new Set([...pool, ...filtered.map((question) => question.id)]));
    setPool(next);
    if (selectedExam) notify(`${next.length - pool.length} questions added to ${selectedExam.name}`);
  };
  const toggleQuestion = (id: string) => {
    const inPool = pool.includes(id);
    setPool((current) => inPool ? current.filter((item) => item !== id) : [...current, id]);
    if (selectedExam) notify(`${id} ${inPool ? "removed from" : "added to"} ${selectedExam.name}`);
  };

  return <>
    <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Faculty console / Questions</p><h1 className="mt-2 font-serif text-3xl font-semibold">Build your question paper</h1><p className="mt-2 text-[13px] text-ink-soft">Choose an exam, add questions to its pool, and then set up delivery.</p></div>
      <div className="flex gap-2"><button onClick={() => navigate("/teacher/exams/new")} className="border border-line-strong px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft">+ Create exam</button><button onClick={() => navigate("/teacher/questions/new")} className="border border-forest bg-forest px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper">+ New question</button></div>
    </div>

    {selectedExam ? <section className="mt-8 border border-line bg-paper p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between"><div><p className="font-mono text-[10px] uppercase tracking-widest text-forest">Step 1 · Select exam</p><h2 className="mt-1 font-serif text-2xl font-semibold">Which exam are you building?</h2></div><label className="w-full max-w-md text-[11px] text-ink-soft">Exam<select value={selectedExamId} onChange={(event) => setSelectedExamId(event.target.value)} className="mt-1 block w-full border border-forest bg-paper px-3 py-3 text-[13px] outline-none"><option value="">Select an exam</option>{availableExams.map((exam) => <option key={exam.id} value={exam.id}>{exam.name} · {exam.state}</option>)}</select></label></div>
      {selectedExam ? <div className="mt-6 grid gap-3 border-t border-line pt-5 sm:grid-cols-3"><Stat label="Selected exam" value={selectedExam.name} detail={selectedExam.batch}/><Stat label="Questions in pool" value={String(pool.length)} detail="Questions ready to deliver"/><Stat label="Next step" value={pool.length >= 5 ? "Configure delivery" : `${5 - pool.length} more recommended`} detail="Randomization comes after the pool"/></div> : <div className="mt-5 border border-dashed border-line-strong bg-paper-raised p-5 text-[13px] text-ink-soft">Select one of your created exams to start adding questions. The question list will stay inactive until an exam is selected.</div>}
    </section> : <ExamChooser exams={availableExams} onChoose={setSelectedExamId} />}

    {selectedExam && <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="min-w-0 border border-line bg-paper">
        <div className="border-b border-line bg-paper-raised p-5 sm:p-6"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><p className="font-mono text-[10px] uppercase tracking-widest text-forest">Step 2 · Add questions</p><h2 className="mt-1 font-serif text-2xl font-semibold">Question bank</h2><p className="mt-2 text-[12px] text-ink-soft">Add questions one at a time, or add all filtered results.</p></div><button onClick={addAll} className="border border-forest px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-forest">Add all shown</button></div><div className="mt-5 flex gap-1 border-b border-line"><button onClick={() => setActiveTab("bank")} className={`border-b-2 px-3 py-3 font-mono text-[10px] uppercase tracking-wider ${activeTab === "bank" ? "border-forest text-forest" : "border-transparent text-ink-soft"}`}>Available · {filtered.length}</button><button onClick={() => setActiveTab("pool")} className={`border-b-2 px-3 py-3 font-mono text-[10px] uppercase tracking-wider ${activeTab === "pool" ? "border-forest text-forest" : "border-transparent text-ink-soft"}`}>In this exam · {pool.length}</button></div><div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_170px_170px]"><label className="sr-only" htmlFor="question-search">Search questions</label><input id="question-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by question, ID, or topic" className="border border-line-strong bg-paper px-3 py-3 text-[13px] outline-none focus:border-forest"/><select value={unit} onChange={(event) => setUnit(event.target.value)} className="border border-line-strong bg-paper px-3 py-3 text-[13px]"><option>All units</option>{Array.from(new Set(bank.map((question) => question.unit))).map((item) => <option key={item}>{item}</option>)}</select><select value={type} onChange={(event) => setType(event.target.value)} className="border border-line-strong bg-paper px-3 py-3 text-[13px]"><option>All types</option>{Array.from(new Set(bank.map((question) => question.type))).map((item) => <option key={item}>{item}</option>)}</select></div></div>
        <div className="divide-y divide-line">{(activeTab === "pool" ? poolQuestions.filter((question) => filtered.some((item) => item.id === question.id)) : filtered).map((question) => { const inPool = pool.includes(question.id); return <QuestionRow key={question.id} question={question} inPool={inPool} onToggle={() => toggleQuestion(question.id)} onPreview={() => notify(`${question.id} preview opened`)} />; })}{(activeTab === "pool" ? poolQuestions.filter((question) => filtered.some((item) => item.id === question.id)) : filtered).length === 0 && <div className="p-10 text-center"><p className="font-serif text-xl">No questions here yet</p><p className="mt-2 text-[12px] text-ink-soft">Change your filters or add questions from the available bank.</p></div>}</div>
      </section>
      <aside className="space-y-5"><section className="border border-forest bg-success/5 p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-widest text-forest">Step 3 · Review pool</p><h2 className="mt-1 font-serif text-xl font-semibold">{selectedExam.name}</h2></div><span className="font-mono text-[11px] text-forest">{pool.length} added</span></div><div className="mt-5 h-2 bg-line"><div className="h-full bg-forest transition-all" style={{ width: `${Math.min(100, pool.length * 20)}%` }}/></div><p className="mt-3 text-[12px] text-ink-soft">{pool.length < 5 ? "Add a few more questions so random papers have enough variety." : "Your pool has enough questions for random selection."}</p><div className="mt-5 space-y-2">{poolQuestions.map((question) => <div key={question.id} className="flex items-start justify-between gap-3 border-b border-forest/15 pb-3 text-[12px]"><div><span className="font-mono text-[10px] text-forest">{question.id}</span><p className="mt-1 leading-snug">{question.title}</p></div><button onClick={() => toggleQuestion(question.id)} className="text-ink-soft hover:text-alert" aria-label={`Remove ${question.id}`}>×</button></div>)}</div><button onClick={() => setActiveTab("pool")} className="mt-4 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">View full pool →</button></section><section className="border border-line bg-paper-raised p-5"><p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Step 4 · Delivery</p><h2 className="mt-1 font-serif text-xl font-semibold">Set paper rules</h2><div className="mt-4 grid grid-cols-2 gap-3"><label className="text-[11px] text-ink-soft">Per student<input type="number" min="1" max={pool.length || 1} value={questionsPerStudent} onChange={(event) => setQuestionsPerStudent(Math.min(pool.length || 1, Math.max(1, Number(event.target.value))))} className="mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px]"/></label><div className="flex items-end pb-2 text-[11px] text-ink-soft">of {pool.length} in pool</div></div><label className="mt-4 flex items-center justify-between border-t border-line pt-4 text-[12px]"><span><span className="block font-medium">Randomly select questions</span><span className="text-[11px] text-ink-soft">Different questions for each paper</span></span><input type="checkbox" checked={shuffleQuestions} onChange={(event) => setShuffleQuestions(event.target.checked)} className="h-4 w-4 accent-forest"/></label><label className="mt-4 flex items-center justify-between border-t border-line pt-4 text-[12px]"><span><span className="block font-medium">Shuffle question order</span><span className="text-[11px] text-ink-soft">Change the order for each student</span></span><input type="checkbox" checked={shuffleOrder} onChange={(event) => setShuffleOrder(event.target.checked)} className="h-4 w-4 accent-forest"/></label><button onClick={() => navigate(`/teacher/exams/${selectedExam.id === "EXAM-2026-014" ? "exam-1" : "exam-2"}`)} className="mt-5 w-full border border-forest bg-forest px-3 py-3 font-mono text-[10px] uppercase tracking-wider text-paper">Save delivery settings →</button></section></aside>
    </div>}
  </>;
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="border-l-2 border-forest pl-3"><p className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{label}</p><p className="mt-1 truncate text-[14px] font-medium">{value}</p><p className="mt-1 truncate text-[11px] text-ink-soft">{detail}</p></div>; }
function ExamChooser({ exams, onChoose }: { exams: Exam[]; onChoose: (id: string) => void }) { return <section className="mt-8 border border-line bg-paper p-5 shadow-sm sm:p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><p className="font-mono text-[10px] uppercase tracking-widest text-forest">Step 1 · Select exam</p><h2 className="mt-1 font-serif text-2xl font-semibold">Your created exams</h2><p className="mt-2 text-[13px] text-ink-soft">Choose an exam to add questions, set the pool, and configure shuffle options.</p></div><span className="font-mono text-[10px] text-ink-soft">{exams.length} exams</span></div><div className="mt-6 grid gap-3 md:grid-cols-2">{exams.map((exam) => <button key={exam.id} onClick={() => onChoose(exam.id)} className="group border border-line-strong bg-paper p-5 text-left transition hover:border-forest hover:bg-success/5"><div className="flex items-start justify-between gap-3"><div><span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">{exam.id}</span><p className="mt-2 font-serif text-lg font-semibold group-hover:text-forest">{exam.name}</p><p className="mt-1 text-[12px] text-ink-soft">{exam.batch}</p></div><span className={`font-mono text-[10px] uppercase tracking-wider ${exam.tone}`}>{exam.state}</span></div><div className="mt-5 flex items-center justify-between border-t border-line pt-4"><span className="text-[12px] text-ink-soft">Open question workspace</span><span className="font-mono text-[11px] text-forest">→</span></div></button>)}</div>{exams.length === 0 && <div className="mt-5 border border-dashed border-line-strong p-8 text-center text-[13px] text-ink-soft">No exams created yet. Create an exam first, then return here to add its questions.</div>}</section>; }
function QuestionRow({ question, inPool, onToggle, onPreview }: { question: Question; inPool: boolean; onToggle: () => void; onPreview: () => void }) { return <div className="flex flex-col gap-4 p-5 transition-colors hover:bg-paper-raised sm:flex-row sm:items-start sm:justify-between"><div className="flex min-w-0 gap-3"><div className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center border ${inPool ? "border-forest bg-forest text-paper" : "border-line-strong text-transparent"}`}>✓</div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[10px] text-ink-soft">{question.id}</span><span className="bg-paper-raised px-2 py-1 font-mono text-[10px] text-ink-soft">{question.unit}</span><span className="bg-paper-raised px-2 py-1 font-mono text-[10px] text-ink-soft">{question.type}</span><span className="bg-paper-raised px-2 py-1 font-mono text-[10px] text-ink-soft">{question.difficulty}</span></div><p className="mt-3 text-[14px] leading-relaxed">{question.title}</p><p className="mt-2 text-[11px] text-ink-soft">{question.marks} {question.marks === 1 ? "mark" : "marks"} · Used in {question.used} {question.used === 1 ? "exam" : "exams"}</p></div></div><div className="flex shrink-0 items-center gap-4 sm:pt-1"><button onClick={onPreview} className="font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink">Preview</button><button onClick={onToggle} className={`border px-3 py-2 font-mono text-[10px] uppercase tracking-wider ${inPool ? "border-line-strong text-ink-soft" : "border-forest bg-forest text-paper"}`}>{inPool ? "Remove" : "Add question"}</button></div></div>; }
