import { useEffect, useState } from "react";
import { saveQuestion, type DBQuestion } from "../lib/examApi";

type Props = { notify: (message: string) => void; navigate: (path: string) => void };

const inputClass = "mt-1 block w-full border border-line-strong bg-paper px-3 py-2.5 text-[13px] text-ink outline-none focus:border-forest";
const TYPES = ["MCQ", "MSQ", "True / False", "Numerical", "Subjective"];
const DIFFICULTIES = ["Easy", "Medium", "Hard"];
const UNITS = ["Trees & Graphs", "Normalization", "Sorting", "OS Scheduling", "Networking", "Databases", "Custom / Other"];

type ParsedRow = {
  rowNo: number;
  title: string;
  type: string;
  options: string[];
  answer: string;
  unit: string;
  difficulty: string;
  marks: number;
  valid: boolean;
  reason?: string;
};

/**
 * Real question editor: every field (type, title, options + correct answer,
 * unit, difficulty, marks) is captured and saved to the `questions` table via
 * saveQuestion. Bulk import parses the CSV client-side, shows the true number
 * of valid rows, and inserts them one by one with real per-row results.
 */
export default function QuestionEditorV4({ notify, navigate }: Props) {
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const examId = params.get("exam") ?? undefined;
  const bulkRequested = params.get("bulk") === "1";
  const editId = params.get("edit");
  const backParam = params.get("back");
  const exitPath = backParam && backParam.startsWith("/teacher/") ? backParam : "/teacher/questions";

  // ── Single question fields (controlled + persisted) ────────────────────────
  const [type, setType] = useState("MCQ");
  const [title, setTitle] = useState("");
  const [unit, setUnit] = useState("Custom / Other");
  const [difficulty, setDifficulty] = useState("Medium");
  const [marks, setMarks] = useState(1);
  const [options, setOptions] = useState<string[]>(["", "", "", ""]);
  const [correct, setCorrect] = useState<number | null>(0);          // MCQ / T-F
  const [correctSet, setCorrectSet] = useState<number[]>([]);        // MSQ
  const [expected, setExpected] = useState("");                      // Numerical
  const [subjectiveMode, setSubjectiveMode] = useState<"both" | "qr" | "textbox">("both");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // ── Bulk import (real parse + real insert) ────────────────────────────────
  const [bulkOpen, setBulkOpen] = useState(bulkRequested);
  const [bulkFile, setBulkFile] = useState("");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: number; failed: number; sample?: string } | null>(null);

  // Editing an existing question: prefill from the DB.
  useEffect(() => {
    if (!editId || loaded) return;
    let active = true;
    void import("../lib/supabase").then(async (m) => {
      const db = m.getSupabase();
      if (!db) return;
      const { data } = await db.from("questions").select("*").eq("id", editId).maybeSingle();
      if (!active || !data) return;
      const q = data as unknown as DBQuestion;
      setType(q.type || "MCQ");
      setTitle(q.title || "");
      setUnit(q.unit || "Custom / Other");
      setDifficulty(q.difficulty || "Medium");
      setMarks(q.marks || 1);
      const opts = Array.isArray(q.options) && q.options.length >= 2 ? q.options.slice(0, 4).map(String) : ["", "", "", ""];
      setOptions([...opts, ...Array(4 - opts.length).fill("")].slice(0, 4));
      const ans = q.answer;
      if (q.type === "MSQ") {
        try {
          const arr = Array.isArray(JSON.parse(ans || "[]")) ? JSON.parse(ans || "[]") : [];
          setCorrectSet(arr.map(Number).filter((n: number) => Number.isFinite(n)));
        } catch { setCorrectSet([]); }
        setCorrect(null);
      } else if (q.type === "True / False") {
        setCorrect(ans === "1" ? 1 : 0);
      } else if (q.type === "Numerical") {
        setExpected(ans || "");
        setCorrect(null);
      } else {
        const idx = Number(ans);
        setCorrect(Number.isFinite(idx) ? idx : 0);
      }
      setLoaded(true);
    });
    return () => { active = false; };
  }, [editId, loaded]);

  // ── Single-question save ───────────────────────────────────────────────────
  const buildPayload = (): { payload: Omit<DBQuestion, "id">; error?: string } | null => {
    const t = title.trim();
    if (!t) return { payload: undefined as never, error: "Question prompt is required." };
    let optionsArr: string[] | null = null;
    let answer: string | null = null;
    if (type === "MCQ") {
      optionsArr = options.map((o) => o.trim());
      const filled = optionsArr.filter(Boolean);
      if (filled.length < 2) return { payload: undefined as never, error: "MCQ needs at least two options." };
      if (correct == null) return { payload: undefined as never, error: "Pick the correct option." };
      answer = String(correct);
    } else if (type === "True / False") {
      optionsArr = ["True", "False"];
      answer = correct === 1 ? "1" : "0";
    } else if (type === "MSQ") {
      optionsArr = options.map((o) => o.trim());
      if (optionsArr.filter(Boolean).length < 2) return { payload: undefined as never, error: "MSQ needs at least two options." };
      answer = JSON.stringify([...correctSet].sort((a, b) => a - b));
    } else if (type === "Numerical") {
      answer = expected.trim();
      if (!answer) return { payload: undefined as never, error: "Enter the expected numerical answer." };
    }
    return {
      payload: {
        exam_id: examId ?? null,
        title: t.slice(0, 2000),
        type,
        unit,
        difficulty,
        marks: Math.max(0, marks),
        options: optionsArr,
        answer,
        subjective_mode: type === "Subjective" ? subjectiveMode : null,
      },
    };
  };

  const saveOne = async (): Promise<void> => {
    const built = buildPayload();
    if (!built?.payload) { notify(built?.error ?? "Cannot save yet — review the highlighted fields."); return; }
    setSaving(true);
    const res = await saveQuestion({ ...built.payload, id: editId ?? undefined });
    setSaving(false);
    if (res.ok) {
      notify(editId ? `Question ${editId} updated.` : `${type} question saved to the bank.`);
      window.setTimeout(() => navigate(exitPath), 400);
    } else {
      notify(`Could not save: ${res.error}. Run supabase/demo-policies.sql if RLS blocks the anon flow.`);
    }
  };

  // ── Bulk CSV: parse → validate → insert ────────────────────────────────────
  const handleBulkFile = async (file: File | undefined) => {
    if (!file) return;
    setBulkFile(file.name);
    setImportResult(null);
    const text = await file.text();
    const parsed = parseCsv(text);
    const header = parsed[0]?.map((h) => h.trim().toLowerCase()) ?? [];
    const data = parsed.slice(1).filter((r) => r.some((cell) => cell.trim() !== ""));
    const idx = (name: string) => Math.max(0, header.indexOf(name));
    const prepared = data.map((r, i) => {
      const titleRaw = String(r[idx("question")] ?? "").trim();
      const typeRaw = String(r[idx("type")] ?? "").trim();
      const difficultyRaw = String(r[idx("difficulty")] ?? "Medium").trim();
      const unitRaw = String(r[idx("unit")] ?? "Custom / Other").trim();
      const marksRaw = Number(r[idx("marks")] ?? "1");
      const optionsRaw = [
        String(r[idx("option_a")] ?? "").trim(),
        String(r[idx("option_b")] ?? "").trim(),
        String(r[idx("option_c")] ?? "").trim(),
        String(r[idx("option_d")] ?? "").trim(),
      ];
      const isMcqLike = typeRaw === "MCQ" || typeRaw === "MSQ" || !typeRaw;
      const row: ParsedRow = {
        rowNo: i + 2,
        title: titleRaw,
        type: typeRaw || "MCQ",
        options: optionsRaw,
        answer: String(r[idx("answer")] ?? "").trim(),
        unit: unitRaw,
        difficulty: DIFFICULTIES.includes(difficultyRaw) ? difficultyRaw : "Medium",
        marks: Number.isFinite(marksRaw) ? marksRaw : 1,
        valid: false,
      };
      const reasons: string[] = [];
      if (!row.title) reasons.push("no question text");
      if (isMcqLike && optionsRaw.filter(Boolean).length < 2) reasons.push("needs ≥2 options");
      row.valid = reasons.length === 0;
      row.reason = reasons.join("; ");
      return row;
    });
    setRows(prepared);
    if (data.length === 0) {
      notify("No data rows found in that file — check the header matches the template.");
    } else {
      notify(`Parsed ${prepared.length} rows — ${prepared.filter((r) => r.valid).length} valid, ${prepared.filter((r) => !r.valid).length} need attention.`);
    }
  };

  const importRows = async () => {
    const valid = rows.filter((r) => r.valid);
    if (valid.length === 0) return;
    setImporting(true);
    let ok = 0;
    let failed = 0;
    let sampleErr = "";
    for (const r of valid) {
      const res = await saveQuestion({
        exam_id: examId ?? null,
        title: r.title,
        type: r.type,
        unit: r.unit,
        difficulty: r.difficulty,
        marks: r.marks,
        options: r.options,
        answer: r.type === "MSQ" ? JSON.stringify([]) : r.answer || null,
      });
      if (res.ok) ok += 1;
      else { failed += 1; if (!sampleErr) sampleErr = res.error ?? "unknown error"; }
    }
    setImporting(false);
    setImportResult({ ok, failed, sample: sampleErr || undefined });
    notify(`Imported ${ok} question${ok === 1 ? "" : "s"}${failed ? ` — ${failed} failed${sampleErr ? ` (${sampleErr})` : ""}` : " successfully"}.`);
    if (ok > 0) window.setTimeout(() => navigate(exitPath), 500);
  };

  const exportTemplate = () => {
    const header = "exam_id,question,type,option_a,option_b,option_c,option_d,answer,unit,difficulty,marks\n";
    const sample = `${examId ?? ""},Which traversal visits the root between the left and right subtrees?,MCQ,Inorder,Preorder,Postorder,Level order,Inorder,Trees & Graphs,Medium,1\n`;
    const url = URL.createObjectURL(new Blob([header + sample], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = examId ? `${examId}-questions-template.csv` : "question-bank-template.csv";
    a.click();
    URL.revokeObjectURL(url);
    notify("Template downloaded");
  };

  const isTf = type === "True / False";
  const isMcq = type === "MCQ";
  const isMsq = type === "MSQ";
  const isNum = type === "Numerical";
  const isSubj = type === "Subjective";

  return (
    <div>
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Question bank / {editId ? `Edit ${editId}` : "New question"}{examId ? ` · ${examId}` : ""}</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">{editId ? "Edit question" : "Create a question"}</h1>
          <p className="mt-2 text-[13px] text-ink-soft">Saved straight to the database — difficulty, unit and marks are part of the question, so they show up in the pool and the paper.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => setBulkOpen((o) => !o)} className="border border-forest px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-forest">↑ Bulk upload CSV/Excel</button>
          <button onClick={() => navigate(exitPath)} className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">← Back</button>
        </div>
      </div>

      {bulkOpen && (
        <section className="mt-6 border border-forest bg-success/5 p-5 sm:p-6">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Bulk question upload</p>
              <h2 className="mt-1 font-serif text-2xl font-semibold">Add many questions at once</h2>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-soft">
                Upload a CSV (the template matches the import format). Rows are validated here and inserted into the database in one pass.
              </p>
            </div>
            <button onClick={() => setBulkOpen(false)} className="self-start font-mono text-[10px] uppercase tracking-wider text-ink-soft">Close ×</button>
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_250px]">
            <label className="flex cursor-pointer flex-col items-center justify-center border border-dashed border-forest bg-paper px-6 py-8 text-center transition hover:bg-paper-raised">
              <span className="text-2xl text-forest">↑</span>
              <span className="mt-2 text-[13px] font-medium">{bulkFile || "Choose CSV file"}</span>
              <span className="mt-1 text-[12px] text-ink-soft">.csv · up to 500 questions · difficulty &amp; marks columns supported</span>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void handleBulkFile(e.target.files?.[0])} />
            </label>
            <div className="border border-line bg-paper p-4">
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Template · {examId || "general bank"}</p>
              <p className="mt-3 text-[12px] leading-relaxed text-ink-soft">exam_id, question, type, option_a, option_b, option_c, option_d, answer, unit, difficulty, marks</p>
              <button onClick={exportTemplate} className="mt-4 font-mono text-[10px] uppercase tracking-wider text-forest hover:underline">↓ Download CSV template</button>
            </div>
          </div>

          {rows.length > 0 && (
            <div className="mt-4 border-t border-forest/20 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] font-medium text-success">
                  ✓ {rows.length} rows parsed — {rows.filter((r) => r.valid).length} valid, {rows.filter((r) => !r.valid).length} need attention
                </p>
                <button
                  onClick={() => void importRows()}
                  disabled={importing || rows.filter((r) => r.valid).length === 0}
                  className="border border-forest bg-forest px-5 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {importing ? "Importing…" : `Import ${rows.filter((r) => r.valid).length} valid question${rows.filter((r) => r.valid).length === 1 ? "" : "s"}`}
                </button>
              </div>
              {importResult && (
                <p className="mt-2 font-mono text-[11px] text-ink-soft">
                  Result: {importResult.ok} inserted · {importResult.failed} failed{importResult.sample ? ` · e.g. ${importResult.sample}` : ""}
                </p>
              )}
              <div className="mt-3 max-h-56 overflow-y-auto border border-line bg-paper">
                <table className="w-full text-left text-[12px]">
                  <thead className="bg-paper-raised font-mono text-[10px] uppercase tracking-wider text-ink-soft">
                    <tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">Question</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Difficulty</th><th className="px-3 py-2">Status</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.rowNo} className="border-t border-line">
                        <td className="px-3 py-2 font-mono text-ink-soft">{r.rowNo}</td>
                        <td className="px-3 py-2">{r.title || "—"}</td>
                        <td className="px-3 py-2">{r.type}</td>
                        <td className="px-3 py-2">{r.difficulty}</td>
                        <td className={`px-3 py-2 font-mono text-[10px] ${r.valid ? "text-success" : "text-alert"}`}>{r.valid ? "✓ valid" : r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <section className="border border-line bg-paper p-6">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">1 · Question format</p>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {TYPES.map((item) => (
                <button key={item} onClick={() => setType(item)} className={`border px-3 py-3 text-left text-[12px] ${type === item ? "border-forest bg-success/5 text-forest" : "border-line-strong text-ink-soft hover:border-forest"}`}>
                  <span className="block font-medium">{item}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="border border-line bg-paper p-6 sm:p-8">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">2 · Student content</p>
            <label className="mt-4 block text-[12px] text-ink-soft">
              Question title / prompt <span className="text-alert">*</span>
              <textarea value={title} onChange={(e) => setTitle(e.target.value)} rows={4} placeholder="Write the complete question…" className={`${inputClass} resize-y text-[14px]`} />
            </label>

            {(isMcq || isMsq) && (
              <div className="mt-6">
                <p className="text-[12px] font-medium">{isMsq ? "Options (pick every correct one)" : "Options"}</p>
                {options.map((opt, i) => {
                  const picked = isMsq ? correctSet.includes(i) : correct === i;
                  return (
                    <div key={i} className={`mt-3 border px-3 py-2.5 ${picked ? "border-forest bg-success/5" : "border-line-strong"}`}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-soft">Option {String.fromCharCode(65 + i)}</span>
                        <button
                          type="button"
                          onClick={() => (isMsq
                            ? setCorrectSet((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))
                            : setCorrect(i))}
                          className={`font-mono text-[9px] uppercase tracking-wider ${picked ? "text-forest" : "text-ink-soft hover:text-forest"}`}
                        >
                          {picked ? "✓ correct" : "mark correct"}
                        </button>
                      </div>
                      <input value={opt} onChange={(e) => setOptions((cur) => cur.map((o, j) => (j === i ? e.target.value : o)))} placeholder={`Enter option ${String.fromCharCode(65 + i)}`} className={inputClass} />
                    </div>
                  );
                })}
              </div>
            )}

            {isTf && (
              <div className="mt-6 grid grid-cols-2 gap-3">
                {["True", "False"].map((label, i) => (
                  <button key={label} type="button" onClick={() => setCorrect(i)} className={`border p-4 text-left text-[13px] ${correct === i ? "border-forest bg-success/5 text-forest" : "border-line-strong text-ink-soft"}`}>
                    {correct === i ? "● " : "○ "}{label}
                  </button>
                ))}
              </div>
            )}

            {isNum && (
              <div className="mt-6">
                <label className="block text-[12px] text-ink-soft">
                  Expected numerical answer
                  <input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="e.g. 42 or 3.14" className={inputClass} />
                </label>
              </div>
            )}

            {isSubj && (
              <div className="mt-6 grid gap-2 sm:grid-cols-3">
                {([["both", "QR + Answer box"], ["qr", "QR upload only"], ["textbox", "Answer box only"]] as const).map(([mode, label]) => (
                  <button key={mode} type="button" onClick={() => setSubjectiveMode(mode)} className={`border px-3 py-3 text-[12px] ${subjectiveMode === mode ? "border-forest bg-success/5 text-forest" : "border-line-strong text-ink-soft"}`}>
                    {subjectiveMode === mode ? "● " : "○ "}{label}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="border border-line bg-paper p-6 sm:p-8">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">3 · Scoring and organization</p>
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <label className="block text-[12px] text-ink-soft">
                Unit
                <select value={unit} onChange={(e) => setUnit(e.target.value)} className={inputClass}>
                  {UNITS.map((u) => <option key={u}>{u}</option>)}
                </select>
              </label>
              <label className="block text-[12px] text-ink-soft">
                Difficulty
                <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className={inputClass}>
                  {DIFFICULTIES.map((d) => <option key={d}>{d}</option>)}
                </select>
              </label>
              <label className="block text-[12px] text-ink-soft">
                Marks
                <input type="number" min={0} step={0.5} value={marks} onChange={(e) => setMarks(Number(e.target.value) || 0)} className={inputClass} />
              </label>
            </div>
          </section>
        </div>

        <aside>
          <section className="border border-line p-5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Save question</p>
            <div className="mt-3 space-y-1.5 text-[12px] text-ink-soft">
              <p><span className="text-ink">Type:</span> {type}{examId ? ` · exam ${examId}` : " · general bank"}</p>
              <p><span className="text-ink">Difficulty:</span> {difficulty}</p>
              <p><span className="text-ink">Marks:</span> {marks}</p>
              <p className="text-[11px]">Saved questions appear in the pool picker on the exam setup page.</p>
            </div>
            <button onClick={() => void saveOne()} disabled={saving || !title.trim()} className="mt-4 w-full border border-forest bg-forest py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? "Saving…" : editId ? "Update question" : "Save to question bank"}
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** Tiny CSV parser: quotes, commas inside quotes, CRLF — good enough for the template. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n");
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
  return rows.filter((r) => r.some((c) => c.trim() !== "") || rows.indexOf(r) === 0);
}
