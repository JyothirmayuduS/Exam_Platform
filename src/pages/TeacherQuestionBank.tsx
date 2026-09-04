// My Questions — the real question bank, backed by the questions table.
// Every row is a DB question; search/filter run client-side over the loaded
// set, Edit opens the DB-backed editor (?edit=), Delete removes the row after
// a confirm. No demo rows, no notify-only buttons.

import { useCallback, useEffect, useMemo, useState } from "react";
import { listAllQuestions, deleteQuestion, type DBQuestion } from "../lib/examApi";
import { PageHeading, Button } from "./TeacherDashboard";

type BankQuestion = DBQuestion & { exam_name: string | null };

export default function TeacherQuestionBank({
  notify,
  navigate,
}: {
  notify: (message: string) => void;
  navigate: (path: string) => void;
}) {
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [examFilter, setExamFilter] = useState("All exams");
  const [typeFilter, setTypeFilter] = useState("All types");
  const [diffFilter, setDiffFilter] = useState("All difficulties");
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const rows = await listAllQuestions();
    setQuestions(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exams = useMemo(() => {
    const seen = new Map<string, string>();
    for (const q of questions) {
      if (q.exam_id && !seen.has(q.exam_id)) seen.set(q.exam_id, q.exam_name ?? q.exam_id);
    }
    return Array.from(seen.entries());
  }, [questions]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return questions.filter((q) => {
      const matchesTerm =
        !term ||
        `${q.id} ${q.title} ${q.unit ?? ""} ${q.exam_name ?? ""}`.toLowerCase().includes(term);
      const matchesExam = examFilter === "All exams" || q.exam_id === examFilter;
      const matchesType = typeFilter === "All types" || q.type === typeFilter;
      const matchesDiff = diffFilter === "All difficulties" || (q.difficulty ?? "Medium") === diffFilter;
      return matchesTerm && matchesExam && matchesType && matchesDiff;
    });
  }, [questions, search, examFilter, typeFilter, diffFilter]);

  const types = useMemo(() => Array.from(new Set(questions.map((q) => q.type))), [questions]);
  const diffs = useMemo(
    () => Array.from(new Set(questions.map((q) => q.difficulty ?? "Medium"))),
    [questions],
  );
  const easy = questions.filter((q) => (q.difficulty ?? "").toLowerCase() === "easy").length;
  const medium = questions.filter((q) => (q.difficulty ?? "").toLowerCase() === "medium").length;
  const hard = questions.filter((q) => (q.difficulty ?? "").toLowerCase() === "hard").length;

  const remove = async (q: BankQuestion) => {
    if (!window.confirm(`Delete "${q.title.slice(0, 60)}…" from the bank? This cannot be undone.`)) return;
    setDeleting(q.id);
    const ok = await deleteQuestion(q.id);
    setDeleting(null);
    if (ok) {
      notify(`${q.id} deleted`);
      void load();
    } else {
      notify("Couldn't delete — check your database permissions.");
    }
  };

  return (
    <div>
      <PageHeading
        eyebrow="Faculty console / Questions"
        title="My question bank"
        detail={`${questions.length} question${questions.length === 1 ? "" : "s"} across ${exams.length} exam${exams.length === 1 ? "" : "s"} — difficulty mix ${easy}E · ${medium}M · ${hard}H.`}
        action={<Button primary onClick={() => navigate("/teacher/questions/new")}>+ New question</Button>}
      />

      <div className="mt-6 grid gap-3 border border-line bg-paper-raised p-4 md:grid-cols-[minmax(0,1fr)_190px_150px_150px]">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by question, ID, exam or unit"
          className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none focus:border-forest"
        />
        <select value={examFilter} onChange={(e) => setExamFilter(e.target.value)} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none">
          <option>All exams</option>
          {exams.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none">
          <option>All types</option>
          {types.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select value={diffFilter} onChange={(e) => setDiffFilter(e.target.value)} className="border border-line-strong bg-paper px-3 py-2.5 text-[13px] outline-none">
          <option>All difficulties</option>
          {diffs.map((d) => <option key={d}>{d}</option>)}
        </select>
      </div>

      <div className="mt-5 overflow-hidden border border-line bg-paper">
        <div className="grid grid-cols-[72px_minmax(0,1fr)_auto] gap-3 border-b border-line bg-paper-raised px-5 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-soft">
          <span>ID</span><span>Question</span><span className="text-right">Actions</span>
        </div>
        {loading ? (
          <div className="p-10 text-center text-[12px] text-ink-soft">Loading your question bank…</div>
        ) : visible.length === 0 ? (
          <div className="p-12 text-center">
            <p className="font-serif text-xl">No questions match</p>
            <p className="mt-2 text-[12px] text-ink-soft">
              {questions.length === 0
                ? "Your bank is empty — write your first question or import from CSV."
                : "Change the search or clear a filter."}
            </p>
            {questions.length === 0 && (
              <button
                onClick={() => navigate("/teacher/questions/new")}
                className="mt-5 border border-forest bg-forest px-4 py-2.5 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light"
              >
                Write a question →
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-line">
            {visible.map((q) => (
              <div key={q.id} className="grid grid-cols-[72px_minmax(0,1fr)_auto] gap-3 px-5 py-4 hover:bg-paper-raised">
                <div>
                  <p className="font-mono text-[10px] text-forest">{q.id}</p>
                  <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">{q.marks} mark{q.marks === 1 ? "" : "s"}</p>
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {q.exam_name && (
                      <span className="bg-forest/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-forest">{q.exam_name}</span>
                    )}
                    <span className="bg-paper-raised px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-soft">{q.unit ?? "General"}</span>
                    <span className="bg-paper-raised px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-soft">{q.type}</span>
                    <span className={`px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
                      (q.difficulty ?? "").toLowerCase() === "easy" ? "bg-success/10 text-success" :
                      (q.difficulty ?? "").toLowerCase() === "hard" ? "bg-alert/10 text-alert" : "bg-amber/10 text-amber"
                    }`}>{q.difficulty ?? "Medium"}</span>
                  </div>
                  <p className="mt-2 text-[14px] leading-relaxed">{q.title}</p>
                </div>
                <div className="flex shrink-0 items-start gap-2">
                  <button
                    onClick={() => navigate(`/teacher/questions/new?edit=${q.id}`)}
                    className="border border-line-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-forest hover:text-forest"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => void remove(q)}
                    disabled={deleting === q.id}
                    className="border border-line-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:border-alert hover:text-alert disabled:opacity-40"
                  >
                    {deleting === q.id ? "…" : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}