import { useMemo, useState } from "react";
import type { QuestionStatus } from "@/features/student/hooks/useExamState";

type Question = {
  id: string;
  text: string;
  category: string;
  options: string[];
  type?: "mcq" | "subjective";
};

type QuestionPanelProps = {
  questions: Question[];
  currentIndex: number;
  getStatus: (questionId: string) => QuestionStatus;
  onJump: (index: number) => void;
};

const statusClassMap: Record<QuestionStatus, string> = {
  answered: "border-emerald-500 bg-emerald-500 text-white shadow-sm",
  marked: "border-amber-500 bg-amber-500 text-white shadow-sm",
  visited: "border-slate-300 bg-white text-slate-700",
  unvisited: "border-slate-200 bg-slate-50 text-slate-400",
};

export default function QuestionPanel({ questions, currentIndex, getStatus, onJump }: QuestionPanelProps) {
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const value = search.trim().toLowerCase();
    if (!value) return questions.map((q, index) => ({ q, index }));

    return questions
      .map((q, index) => ({ q, index }))
      .filter(({ q }) => {
        const answerType = q.type ?? (q.options.length ? "mcq" : "subjective");
        return (
          String(q.id) === value
          || q.text.toLowerCase().includes(value)
          || q.category.toLowerCase().includes(value)
          || answerType.includes(value)
        );
      });
  }, [questions, search]);

  return (
    <aside className="space-y-4 rounded-xl border border-line/40 bg-white p-5 shadow-sm">
      <p className="font-sans text-xs font-semibold uppercase tracking-wider text-slate-500">Question Navigator</p>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by #, text, type..."
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 outline-none transition-colors focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
        aria-label="Search questions"
      />
      <div className="grid grid-cols-5 gap-2">
        {visible.map(({ q, index }) => {
          const status = getStatus(q.id);
          const isCurrent = index === currentIndex;
          return (
            <button
              key={q.id}
              onClick={() => onJump(index)}
              className={`flex h-10 items-center justify-center rounded-lg border font-sans text-xs font-bold transition-all duration-200 ${statusClassMap[status]} ${isCurrent ? "ring-2 ring-emerald-500 ring-offset-2 scale-105" : "hover:brightness-95"}`}
              aria-label={`Go to question ${index + 1}`}
            >
              {index + 1}
            </button>
          );
        })}
      </div>
      <div className="mt-4 space-y-2 font-sans text-[11px] font-medium tracking-wide text-slate-500 pt-2 border-t border-slate-100">
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-emerald-500 shadow-sm" />Answered</span>
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-amber-500 shadow-sm" />Marked for review</span>
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border border-slate-300 bg-white" />Visited</span>
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border border-slate-200 bg-slate-50" />Not visited</span>
      </div>
    </aside>
  );
}
