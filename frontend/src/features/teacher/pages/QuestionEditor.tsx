import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FiArrowLeft, FiCheck, FiCheckCircle, FiCheckSquare, FiDownload, FiEdit3, FiHash,
  FiMinus, FiPlus, FiToggleLeft, FiUpload, FiX, FiFileText, FiAlertCircle,
} from "react-icons/fi";
import { fetchAnswerKeys, QUESTION_COLUMNS, saveQuestion, type DBQuestion } from "@/shared/data/examApi";
import { Button } from "@/shared/components/ui";

type Props = { notify: (message: string) => void; navigate: (path: string) => void };

const TYPES = [
  { id: "MCQ", label: "Single choice", hint: "One correct option", icon: <FiCheckCircle /> },
  { id: "MSQ", label: "Multiple choice", hint: "Several correct options", icon: <FiCheckSquare /> },
  { id: "True / False", label: "True / False", hint: "Two fixed choices", icon: <FiToggleLeft /> },
  { id: "Numerical", label: "Numerical", hint: "Exact value answer", icon: <FiHash /> },
  { id: "Subjective", label: "Written", hint: "Typed or uploaded answer", icon: <FiEdit3 /> },
] as const;
const DIFFICULTIES = ["Easy", "Medium", "Hard"];
const UNITS = ["Trees & Graphs", "Normalization", "Sorting", "OS Scheduling", "Networking", "Databases"];
const SUBJECTIVE_MODES = [
  { id: "both", label: "Upload or type", hint: "Student can scan a sheet via QR or type the answer" },
  { id: "qr", label: "Upload only", hint: "Handwritten sheet scanned from the phone" },
  { id: "textbox", label: "Type only", hint: "Answer typed into a text box" },
] as const;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_ROWS = 500;
const CSV_COLUMNS = ["exam_id", "question", "type", "option_a", "option_b", "option_c", "option_d", "answer", "unit", "difficulty", "marks"];

const fieldClass = "block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-soft/70 focus:border-forest";
const letter = (i: number) => String.fromCharCode(65 + i);

type ParsedRow = {
  rowNo: number;
  title: string;
  type: string;
  options: string[] | null;
  answer: string | null;
  unit: string;
  difficulty: string;
  marks: number;
  valid: boolean;
  reason?: string;
};

export default function QuestionEditor({ notify, navigate }: Props) {
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const examId = params.get("exam") ?? undefined;
  const editId = params.get("edit");
  const backParam = params.get("back");
  const exitPath = backParam && backParam.startsWith("/teacher/") ? backParam : "/teacher/questions";
  const backLabel = exitPath.includes("/exams/") ? "Back to paper builder" : "Back to question bank";

  const [mode, setMode] = useState<"single" | "bulk">(params.get("bulk") === "1" && !editId ? "bulk" : "single");

  // ── Single question ───────────────────────────────────────────────────────
  const [type, setType] = useState("MCQ");
  const [title, setTitle] = useState("");
  const [unit, setUnit] = useState("");
  const [difficulty, setDifficulty] = useState("Medium");
  const [marks, setMarks] = useState(1);
  const [options, setOptions] = useState<string[]>(["", "", "", ""]);
  const [correct, setCorrect] = useState<number | null>(null);
  const [correctSet, setCorrectSet] = useState<number[]>([]);
  const [expected, setExpected] = useState("");
  const [subjectiveMode, setSubjectiveMode] = useState<"both" | "qr" | "textbox">("both");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // ── Bulk import ───────────────────────────────────────────────────────────
  const [bulkFile, setBulkFile] = useState("");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importDone, setImportDone] = useState(0);
  const [importResult, setImportResult] = useState<{ ok: number; failed: number; sample?: string } | null>(null);

  useEffect(() => {
    if (!editId || loaded) return;
    let active = true;
    void import("@/shared/data/supabase").then(async (m) => {
      const db = m.getSupabase();
      if (!db) return;
      const { data } = await db.from("questions").select(QUESTION_COLUMNS).eq("id", editId).maybeSingle();
      if (!active || !data) return;
      const keys = await fetchAnswerKeys([editId]);
      if (!active) return;
      const q = { ...(data as unknown as DBQuestion), answer: keys.get(editId) ?? null };
      setType(q.type || "MCQ");
      setTitle(q.title || "");
      setUnit(q.unit && q.unit !== "Custom / Other" ? q.unit : "");
      setDifficulty(q.difficulty || "Medium");
      setMarks(q.marks || 1);
      const opts = Array.isArray(q.options) && q.options.length >= MIN_OPTIONS ? q.options.slice(0, MAX_OPTIONS).map(String) : ["", "", "", ""];
      setOptions(opts);
      const ans = q.answer;
      if (q.type === "MSQ") {
        try {
          const arr = JSON.parse(ans || "[]");
          setCorrectSet(Array.isArray(arr) ? arr.map(Number).filter((n: number) => Number.isFinite(n)) : []);
        } catch { setCorrectSet([]); }
      } else if (q.type === "True / False") {
        setCorrect(ans === "1" ? 1 : 0);
      } else if (q.type === "Numerical") {
        setExpected(ans || "");
      } else {
        const idx = Number(ans);
        setCorrect(ans != null && Number.isFinite(idx) ? idx : null);
      }
      if (q.subjective_mode) setSubjectiveMode(q.subjective_mode as "both" | "qr" | "textbox");
      setLoaded(true);
    });
    return () => { active = false; };
  }, [editId, loaded]);

  const isChoice = type === "MCQ" || type === "MSQ";
  const filledCount = options.filter((o) => o.trim()).length;

  const checks = useMemo(() => {
    const list: { label: string; ok: boolean }[] = [{ label: "Question text written", ok: title.trim().length > 0 }];
    if (isChoice) {
      list.push({ label: "At least two options filled", ok: filledCount >= MIN_OPTIONS });
      list.push(type === "MCQ"
        ? { label: "Correct option marked", ok: correct != null && !!options[correct]?.trim() }
        : { label: "One or more correct options marked", ok: correctSet.some((i) => options[i]?.trim()) });
    } else if (type === "True / False") {
      list.push({ label: "Correct answer chosen", ok: correct === 0 || correct === 1 });
    } else if (type === "Numerical") {
      list.push({ label: "Expected answer entered", ok: expected.trim().length > 0 });
    }
    list.push({ label: "Marks above zero", ok: marks > 0 });
    return list;
  }, [title, isChoice, filledCount, type, correct, correctSet, options, expected, marks]);
  const ready = checks.every((c) => c.ok);

  const changeType = (next: string) => {
    if (next === type) return;
    setType(next);
    setCorrect(next === "True / False" ? 0 : null);
    setCorrectSet([]);
  };

  const removeOption = (i: number) => {
    setOptions((cur) => cur.filter((_, j) => j !== i));
    setCorrect((c) => (c == null ? c : c === i ? null : c > i ? c - 1 : c));
    setCorrectSet((cur) => cur.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)));
  };

  const toggleCorrect = (i: number) => {
    if (type === "MSQ") setCorrectSet((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]));
    else setCorrect(i);
  };

  const buildPayload = (): Omit<DBQuestion, "id"> => {
    let optionsArr: string[] | null = null;
    let answer: string | null = null;
    if (isChoice) {
      // Saved options are compacted, so answers index the filled list.
      const keep = options.map((o, i) => ({ text: o.trim(), i })).filter((o) => o.text);
      optionsArr = keep.map((o) => o.text);
      answer = type === "MCQ"
        ? String(keep.findIndex((o) => o.i === correct))
        : JSON.stringify(keep.map((o, n) => (correctSet.includes(o.i) ? n : -1)).filter((n) => n >= 0));
    } else if (type === "True / False") {
      optionsArr = ["True", "False"];
      answer = correct === 1 ? "1" : "0";
    } else if (type === "Numerical") {
      answer = expected.trim();
    }
    return {
      exam_id: examId ?? null,
      title: title.trim().slice(0, 2000),
      type,
      unit: unit.trim() || "Custom / Other",
      difficulty,
      marks: Math.max(0, marks),
      options: optionsArr,
      answer,
      subjective_mode: type === "Subjective" ? subjectiveMode : null,
    };
  };

  const resetForNext = () => {
    setTitle("");
    setOptions(["", "", "", ""]);
    setCorrect(type === "True / False" ? 0 : null);
    setCorrectSet([]);
    setExpected("");
    promptRef.current?.focus();
  };

  const saveOne = async (addAnother = false) => {
    if (saving) return;
    if (!ready) {
      notify(`Before saving: ${checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join(", ")}.`);
      return;
    }
    setSaving(true);
    const res = await saveQuestion({ ...buildPayload(), id: editId ?? undefined });
    setSaving(false);
    if (!res.ok) {
      notify(`Could not save: ${res.error}. Sign in with your teacher account and try again.`);
      return;
    }
    if (addAnother) {
      notify("Question saved. Ready for the next one.");
      resetForNext();
    } else {
      notify(editId ? "Question updated." : "Question saved to the bank.");
      window.setTimeout(() => navigate(exitPath), 300);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === "single" && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void saveOne(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Bulk: parse, validate, insert ─────────────────────────────────────────
  const handleBulkFile = async (file: File | undefined) => {
    if (!file) return;
    setBulkFile(file.name);
    setImportResult(null);
    const parsed = parseCsv(await file.text());
    const header = parsed[0]?.map((h) => h.trim().toLowerCase()) ?? [];
    const col = (r: string[], name: string) => {
      const i = header.indexOf(name);
      return i < 0 ? "" : String(r[i] ?? "").trim();
    };
    const data = parsed.slice(1).filter((r) => r.some((cell) => cell.trim() !== ""));
    if (data.length > MAX_ROWS) notify(`Only the first ${MAX_ROWS} rows are imported at a time.`);
    const prepared = data.slice(0, MAX_ROWS).map((r, i) => prepareRow(i + 2, {
      title: col(r, "question"),
      type: col(r, "type"),
      options: [col(r, "option_a"), col(r, "option_b"), col(r, "option_c"), col(r, "option_d")],
      answer: col(r, "answer"),
      unit: col(r, "unit"),
      difficulty: col(r, "difficulty"),
      marks: col(r, "marks"),
    }));
    setRows(prepared);
    if (!header.includes("question")) notify("The file has no “question” column. Download the template and match its header.");
    else if (prepared.length === 0) notify("No data rows found in that file.");
  };

  const validRows = rows.filter((r) => r.valid);

  const importRows = async () => {
    if (validRows.length === 0 || importing) return;
    setImporting(true);
    setImportDone(0);
    let ok = 0;
    let failed = 0;
    let sample = "";
    let cursor = 0;
    const worker = async () => {
      while (cursor < validRows.length) {
        const r = validRows[cursor++];
        const res = await saveQuestion({
          exam_id: examId ?? null,
          title: r.title,
          type: r.type,
          unit: r.unit,
          difficulty: r.difficulty,
          marks: r.marks,
          options: r.options,
          answer: r.answer,
        });
        if (res.ok) ok += 1;
        else { failed += 1; if (!sample) sample = res.error ?? "unknown error"; }
        setImportDone((n) => n + 1);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, validRows.length) }, worker));
    setImporting(false);
    setImportResult({ ok, failed, sample: sample || undefined });
    notify(`Imported ${ok} question${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`);
    if (ok > 0 && failed === 0) window.setTimeout(() => navigate(exitPath), 600);
  };

  const exportTemplate = () => {
    const ex = examId ?? "";
    const csv = [
      CSV_COLUMNS.join(","),
      `${ex},Which traversal visits the root between the left and right subtrees?,MCQ,Inorder,Preorder,Postorder,Level order,A,Trees & Graphs,Medium,1`,
      `${ex},Which of these are stable sorting algorithms?,MSQ,Merge sort,Quick sort,Insertion sort,Heap sort,A;C,Sorting,Medium,2`,
      `${ex},A primary key can contain NULL values.,True / False,,,,,False,Databases,Easy,1`,
      `${ex},How many edges does a tree with 10 nodes have?,Numerical,,,,,9,Trees & Graphs,Easy,1`,
      `${ex},Explain the difference between 2NF and 3NF with an example.,Subjective,,,,,,Normalization,Hard,5`,
    ].join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = examId ? `${examId}-questions-template.csv` : "question-bank-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const destination = examId ? `Exam ${examId}` : "General question bank";

  return (
    <div className="pb-28">
      {/* Header */}
      <button onClick={() => navigate(exitPath)} className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft transition-colors hover:text-forest">
        <FiArrowLeft aria-hidden /> {backLabel}
      </button>
      <div className="mt-3 flex flex-col justify-between gap-5 border-b border-line pb-6 md:flex-row md:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Question bank · {destination}</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight">{editId ? "Edit question" : mode === "bulk" ? "Import questions" : "New question"}</h1>
          <p className="mt-2 max-w-xl text-[13px] text-ink-soft">
            {mode === "bulk"
              ? "Upload a CSV, check every row, then add the valid ones in one go."
              : "Write the question, set the answer, and it is ready for any paper that draws from this bank."}
          </p>
        </div>
        {!editId && (
          <div role="tablist" aria-label="Entry mode" className="flex self-start border border-line bg-paper-raised p-1 md:self-auto">
            {([["single", "Single question", <FiEdit3 key="s" />], ["bulk", "Bulk import", <FiUpload key="b" />]] as const).map(([id, label, icon]) => (
              <button
                key={id}
                role="tab"
                aria-selected={mode === id}
                onClick={() => setMode(id)}
                className={`inline-flex items-center gap-2 px-4 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors ${mode === id ? "bg-forest text-paper" : "text-ink-soft hover:text-ink"}`}
              >
                {icon} {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {mode === "single" ? (
        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* Editor */}
          <div className="border border-line bg-paper">
            <Section step="1" title="Format" detail="How the student answers this question.">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {TYPES.map((t) => {
                  const on = type === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => changeType(t.id)}
                      className={`flex flex-col items-start gap-2 border px-3 py-3 text-left transition-colors ${on ? "border-forest bg-forest/[0.05]" : "border-line-strong hover:border-forest"}`}
                    >
                      <span className={`text-[15px] ${on ? "text-forest" : "text-ink-soft"}`}>{t.icon}</span>
                      <span>
                        <span className={`block text-[13px] font-medium ${on ? "text-forest" : "text-ink"}`}>{t.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{t.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section step="2" title="Question" detail="Exactly what the student reads.">
              <textarea
                ref={promptRef}
                value={title}
                onChange={(e) => setTitle(e.target.value.slice(0, 2000))}
                rows={5}
                autoFocus={!editId}
                placeholder="e.g. Which traversal visits the root between the left and right subtrees?"
                className={`${fieldClass} resize-y text-[14px] leading-relaxed`}
              />
              <p className="mt-1.5 text-right font-mono text-[10px] text-ink-soft">{title.length} / 2000</p>
            </Section>

            <Section step="3" title="Answer" detail={answerHint(type)} last>
              {isChoice && (
                <div className="space-y-2">
                  {options.map((opt, i) => {
                    const picked = type === "MSQ" ? correctSet.includes(i) : correct === i;
                    return (
                      <div key={i} className={`flex items-center gap-3 border px-3 py-2 transition-colors ${picked ? "border-forest bg-forest/[0.05]" : "border-line-strong"}`}>
                        <button
                          type="button"
                          onClick={() => toggleCorrect(i)}
                          aria-label={`Mark option ${letter(i)} correct`}
                          aria-pressed={picked}
                          className={`flex h-5 w-5 shrink-0 items-center justify-center border text-[11px] transition-colors ${type === "MSQ" ? "" : "rounded-full"} ${picked ? "border-forest bg-forest text-paper" : "border-line-strong bg-paper text-transparent hover:border-forest"}`}
                        >
                          <FiCheck aria-hidden />
                        </button>
                        <span className="w-4 shrink-0 font-mono text-[11px] text-ink-soft">{letter(i)}</span>
                        <input
                          value={opt}
                          onChange={(e) => setOptions((cur) => cur.map((o, j) => (j === i ? e.target.value : o)))}
                          placeholder={`Option ${letter(i)}`}
                          className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-ink outline-none placeholder:text-ink-soft/70"
                        />
                        {picked && <span className="hidden font-mono text-[9px] uppercase tracking-wider text-forest sm:inline">Correct</span>}
                        {options.length > MIN_OPTIONS && (
                          <button type="button" onClick={() => removeOption(i)} aria-label={`Remove option ${letter(i)}`} className="shrink-0 p-1 text-ink-soft transition-colors hover:text-alert">
                            <FiX aria-hidden />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {options.length < MAX_OPTIONS && (
                    <button type="button" onClick={() => setOptions((cur) => [...cur, ""])} className="inline-flex items-center gap-1.5 px-1 py-1.5 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">
                      <FiPlus aria-hidden /> Add option
                    </button>
                  )}
                </div>
              )}

              {type === "True / False" && (
                <div className="grid grid-cols-2 gap-3">
                  {["True", "False"].map((label, i) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={correct === i}
                      onClick={() => setCorrect(i)}
                      className={`flex items-center gap-3 border px-4 py-4 text-left text-[14px] transition-colors ${correct === i ? "border-forest bg-forest/[0.05] text-forest" : "border-line-strong text-ink hover:border-forest"}`}
                    >
                      <span className={`flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${correct === i ? "border-forest bg-forest text-paper" : "border-line-strong text-transparent"}`}><FiCheck aria-hidden /></span>
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {type === "Numerical" && (
                <div className="max-w-xs">
                  <input
                    value={expected}
                    onChange={(e) => setExpected(e.target.value)}
                    inputMode="decimal"
                    placeholder="e.g. 42 or 3.14"
                    className={`${fieldClass} font-mono`}
                  />
                  <p className="mt-1.5 text-[11px] text-ink-soft">The student's answer must match this value.</p>
                </div>
              )}

              {type === "Subjective" && (
                <div className="grid gap-2 sm:grid-cols-3">
                  {SUBJECTIVE_MODES.map((m) => {
                    const on = subjectiveMode === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSubjectiveMode(m.id)}
                        className={`border px-3 py-3 text-left transition-colors ${on ? "border-forest bg-forest/[0.05]" : "border-line-strong hover:border-forest"}`}
                      >
                        <span className={`block text-[13px] font-medium ${on ? "text-forest" : "text-ink"}`}>{m.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{m.hint}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Section>
          </div>

          {/* Sidebar */}
          <aside className="space-y-4 lg:sticky lg:top-6">
            <Card title="Details">
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-ink-soft">Unit / topic</span>
                <input list="question-units" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="e.g. Sorting" className={fieldClass} />
                <datalist id="question-units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
              </label>
              <div className="mt-4">
                <span className="mb-1.5 block text-[12px] text-ink-soft">Difficulty</span>
                <div className="grid grid-cols-3 border border-line-strong">
                  {DIFFICULTIES.map((d, i) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={difficulty === d}
                      onClick={() => setDifficulty(d)}
                      className={`py-2 text-[12px] transition-colors ${i > 0 ? "border-l border-line-strong" : ""} ${difficulty === d ? "bg-forest text-paper" : "bg-paper text-ink-soft hover:text-ink"}`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-4">
                <span className="mb-1.5 block text-[12px] text-ink-soft">Marks</span>
                <div className="flex border border-line-strong">
                  <button type="button" aria-label="Decrease marks" onClick={() => setMarks((m) => Math.max(0, m - 0.5))} className="px-3 text-ink-soft transition-colors hover:bg-paper-raised hover:text-ink"><FiMinus aria-hidden /></button>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={marks}
                    onChange={(e) => setMarks(Math.max(0, Number(e.target.value) || 0))}
                    className="w-full border-x border-line-strong bg-paper py-2 text-center font-mono text-[14px] text-ink outline-none"
                  />
                  <button type="button" aria-label="Increase marks" onClick={() => setMarks((m) => m + 0.5)} className="px-3 text-ink-soft transition-colors hover:bg-paper-raised hover:text-ink"><FiPlus aria-hidden /></button>
                </div>
              </div>
            </Card>

            <Card title="Student preview">
              <div className="flex items-baseline justify-between gap-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                <span>{TYPES.find((t) => t.id === type)?.label}</span>
                <span>{marks} mark{marks === 1 ? "" : "s"}</span>
              </div>
              <p className={`mt-2 whitespace-pre-wrap text-[13px] leading-relaxed ${title.trim() ? "text-ink" : "italic text-ink-soft"}`}>
                {title.trim() || "Your question appears here."}
              </p>
              {isChoice && filledCount > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {options.map((o, i) => o.trim() && (
                    <li key={i} className="flex items-start gap-2 text-[12px] text-ink">
                      <span className={`mt-0.5 h-3 w-3 shrink-0 border border-line-strong ${type === "MSQ" ? "" : "rounded-full"}`} />
                      <span>{o}</span>
                    </li>
                  ))}
                </ul>
              )}
              {type === "True / False" && (
                <div className="mt-3 flex gap-4 text-[12px] text-ink">
                  {["True", "False"].map((l) => <span key={l} className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border border-line-strong" />{l}</span>)}
                </div>
              )}
              {type === "Numerical" && <div className="mt-3 border border-line-strong px-3 py-2 font-mono text-[12px] text-ink-soft">Enter a number</div>}
              {type === "Subjective" && (
                <div className="mt-3 border border-dashed border-line-strong px-3 py-3 text-[12px] text-ink-soft">
                  {SUBJECTIVE_MODES.find((m) => m.id === subjectiveMode)?.label} answer area
                </div>
              )}
            </Card>

            <Card title="Before you save">
              <ul className="space-y-2">
                {checks.map((c) => (
                  <li key={c.label} className={`flex items-center gap-2 text-[12px] ${c.ok ? "text-ink" : "text-ink-soft"}`}>
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] ${c.ok ? "border-forest bg-forest text-paper" : "border-line-strong text-transparent"}`}><FiCheck aria-hidden /></span>
                    {c.label}
                  </li>
                ))}
              </ul>
            </Card>
          </aside>
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <StepCard step="1" title="Get the template" done={false}>
              <p className="text-[12px] leading-relaxed text-ink-soft">Five sample rows, one per question type. Answers can be a letter (A, B…), the option text, or several letters like A;C.</p>
              <Button size="sm" variant="secondary" icon={<FiDownload />} onClick={exportTemplate} className="mt-4">Download CSV template</Button>
            </StepCard>
            <StepCard step="2" title="Upload your file" done={!!bulkFile}>
              <label
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); void handleBulkFile(e.dataTransfer.files?.[0]); }}
                className={`flex cursor-pointer flex-col items-center justify-center border border-dashed px-4 py-6 text-center transition-colors ${dragging ? "border-forest bg-forest/[0.05]" : "border-line-strong hover:border-forest"}`}
              >
                <FiUpload className="text-xl text-forest" aria-hidden />
                <span className="mt-2 max-w-full truncate text-[13px] font-medium text-ink">{bulkFile || "Drop a CSV here or click to choose"}</span>
                <span className="mt-1 text-[11px] text-ink-soft">Up to {MAX_ROWS} rows</span>
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void handleBulkFile(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
            </StepCard>
            <StepCard step="3" title="Review and import" done={!!importResult && importResult.failed === 0}>
              {rows.length === 0 ? (
                <p className="text-[12px] text-ink-soft">Rows appear below once a file is uploaded.</p>
              ) : (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Stat value={rows.length} label="Rows" />
                  <Stat value={validRows.length} label="Ready" tone="text-forest" />
                  <Stat value={rows.length - validRows.length} label="To fix" tone={rows.length - validRows.length ? "text-alert" : "text-ink-soft"} />
                </div>
              )}
              {importResult && (
                <p className="mt-3 text-[12px] text-ink-soft">
                  {importResult.ok} added{importResult.failed ? `, ${importResult.failed} failed${importResult.sample ? ` (${importResult.sample})` : ""}` : ""}.
                </p>
              )}
            </StepCard>
          </div>

          {rows.length > 0 && (
            <div className="border border-line bg-paper">
              <div className="flex items-center justify-between border-b border-line px-5 py-3">
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Rows in {bulkFile}</p>
                {rows.length - validRows.length > 0 && <p className="text-[12px] text-alert">Rows marked to fix are skipped.</p>}
              </div>
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full min-w-[720px] text-left text-[12px]">
                  <thead className="sticky top-0 bg-paper-raised font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                    <tr>
                      <th className="px-4 py-2.5">Row</th>
                      <th className="px-4 py-2.5">Question</th>
                      <th className="px-4 py-2.5">Type</th>
                      <th className="px-4 py-2.5">Difficulty</th>
                      <th className="px-4 py-2.5">Marks</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.rowNo} className="border-t border-line align-top">
                        <td className="px-4 py-2.5 font-mono text-ink-soft">{r.rowNo}</td>
                        <td className="max-w-[420px] px-4 py-2.5 text-ink">{r.title || <span className="text-ink-soft">—</span>}</td>
                        <td className="px-4 py-2.5 text-ink-soft">{r.type || "—"}</td>
                        <td className="px-4 py-2.5 text-ink-soft">{r.difficulty}</td>
                        <td className="px-4 py-2.5 font-mono text-ink-soft">{r.marks}</td>
                        <td className="px-4 py-2.5">
                          {r.valid
                            ? <span className="inline-flex items-center gap-1 text-forest"><FiCheck aria-hidden /> Ready</span>
                            : <span className="inline-flex items-start gap-1 text-alert"><FiAlertCircle className="mt-0.5 shrink-0" aria-hidden /> {r.reason}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-paper lg:left-60">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3 lg:px-8">
          <p className="flex items-center gap-2 text-[12px] text-ink-soft">
            <FiFileText aria-hidden />
            Saving to <span className="text-ink">{destination}</span>
            {mode === "single" && <span className="hidden font-mono text-[10px] md:inline">· Ctrl + Enter to save</span>}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate(exitPath)}>Cancel</Button>
            {mode === "single" ? (
              <>
                {!editId && (
                  <Button variant="secondary" onClick={() => void saveOne(true)} disabled={saving || !ready}>Save &amp; add another</Button>
                )}
                <Button icon={<FiCheck />} onClick={() => void saveOne(false)} disabled={saving || !ready}>
                  {saving ? "Saving…" : editId ? "Update question" : "Save question"}
                </Button>
              </>
            ) : (
              <Button icon={<FiUpload />} onClick={() => void importRows()} disabled={importing || validRows.length === 0}>
                {importing ? `Importing ${importDone} of ${validRows.length}…` : `Import ${validRows.length} question${validRows.length === 1 ? "" : "s"}`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function answerHint(type: string): string {
  switch (type) {
    case "MCQ": return "Fill the options and click the circle beside the correct one.";
    case "MSQ": return "Fill the options and tick every correct one.";
    case "True / False": return "Choose the correct statement.";
    case "Numerical": return "The exact value used for auto-marking.";
    default: return "How the student submits their written answer.";
  }
}

function Section({ step, title, detail, children, last = false }: { step: string; title: string; detail: string; children: ReactNode; last?: boolean }) {
  return (
    <section className={`grid gap-4 px-5 py-6 sm:px-6 md:grid-cols-[160px_minmax(0,1fr)] ${last ? "" : "border-b border-line"}`}>
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Step {step}</p>
        <h2 className="mt-1 font-serif text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-[12px] leading-snug text-ink-soft">{detail}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-line bg-paper p-5">
      <p className="mb-4 font-mono text-[10px] uppercase tracking-widest text-ink-soft">{title}</p>
      {children}
    </section>
  );
}

function StepCard({ step, title, done, children }: { step: string; title: string; done: boolean; children: ReactNode }) {
  return (
    <section className="flex flex-col border border-line bg-paper p-5">
      <div className="mb-3 flex items-center gap-3">
        <span className={`flex h-6 w-6 items-center justify-center border font-mono text-[11px] ${done ? "border-forest bg-forest text-paper" : "border-line-strong text-ink-soft"}`}>
          {done ? <FiCheck aria-hidden /> : step}
        </span>
        <h2 className="font-serif text-[16px] font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Stat({ value, label, tone = "text-ink" }: { value: number; label: string; tone?: string }) {
  return (
    <div className="border border-line px-2 py-2">
      <p className={`font-serif text-2xl ${tone}`}>{value}</p>
      <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">{label}</p>
    </div>
  );
}

const TYPE_ALIASES: Record<string, string> = {
  mcq: "MCQ", single: "MCQ", "single choice": "MCQ",
  msq: "MSQ", multiple: "MSQ", "multiple choice": "MSQ",
  "true / false": "True / False", "true/false": "True / False", tf: "True / False", "t/f": "True / False", boolean: "True / False",
  numerical: "Numerical", numeric: "Numerical", number: "Numerical",
  subjective: "Subjective", written: "Subjective", descriptive: "Subjective",
};

/** Validate one CSV row and convert its answer to the stored format. */
export function prepareRow(
  rowNo: number,
  raw: { title: string; type: string; options: string[]; answer: string; unit: string; difficulty: string; marks: string },
): ParsedRow {
  const type = raw.type ? TYPE_ALIASES[raw.type.trim().toLowerCase()] ?? "" : "MCQ";
  const marksNum = raw.marks === "" ? 1 : Number(raw.marks);
  const difficulty = DIFFICULTIES.find((d) => d.toLowerCase() === raw.difficulty.toLowerCase()) ?? "Medium";
  const reasons: string[] = [];
  let options: string[] | null = null;
  let answer: string | null = null;

  if (!raw.title) reasons.push("no question text");
  if (!type) reasons.push(`unknown type “${raw.type}”`);
  if (!Number.isFinite(marksNum) || marksNum < 0) reasons.push("marks must be a number");

  if (type === "MCQ" || type === "MSQ") {
    options = raw.options.filter(Boolean);
    if (options.length < MIN_OPTIONS) reasons.push("needs at least two options");
    const toIndex = (token: string): number => {
      const t = token.trim();
      if (/^[A-Fa-f]$/.test(t)) {
        const original = t.toUpperCase().charCodeAt(0) - 65;
        return raw.options[original] ? options!.indexOf(raw.options[original]) : -1;
      }
      return options!.findIndex((o) => o.toLowerCase() === t.toLowerCase());
    };
    if (type === "MCQ") {
      const idx = raw.answer ? toIndex(raw.answer) : -1;
      if (idx < 0) reasons.push("answer must be a letter or match an option");
      else answer = String(idx);
    } else {
      const idxs = raw.answer.split(/[;|]/).map((s) => s.trim()).filter(Boolean).map(toIndex);
      if (idxs.length === 0 || idxs.some((i) => i < 0)) reasons.push("answer must list letters like A;C");
      else answer = JSON.stringify([...new Set(idxs)].sort((a, b) => a - b));
    }
  } else if (type === "True / False") {
    options = ["True", "False"];
    if (/^(t|true|a)$/i.test(raw.answer)) answer = "0";
    else if (/^(f|false|b)$/i.test(raw.answer)) answer = "1";
    else reasons.push("answer must be True or False");
  } else if (type === "Numerical") {
    if (!raw.answer) reasons.push("no expected answer");
    else answer = raw.answer;
  }

  return {
    rowNo,
    title: raw.title.slice(0, 2000),
    type: type || raw.type,
    options,
    answer,
    unit: raw.unit || "Custom / Other",
    difficulty,
    marks: Number.isFinite(marksNum) && marksNum >= 0 ? marksNum : 1,
    valid: reasons.length === 0,
    reason: reasons.join("; ") || undefined,
  };
}

/** Tiny CSV parser: quotes, commas inside quotes, CRLF — good enough for the template. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}
