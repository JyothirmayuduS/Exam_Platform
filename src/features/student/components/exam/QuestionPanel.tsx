import { useMemo, useState } from "react";
import type { QuestionState, QuestionStatus } from "@/features/student/hooks/useExamState";

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
  getStatus: (questionId: string) => QuestionState;
  onJump: (index: number) => void;
};

const statusClassMap: Record<QuestionStatus, string> = {
  answered: "bg-success border-success text-white",
  visited: "bg-paper-raised border-line text-ink",
  unvisited: "bg-paper border-line text-ink",
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
    <aside className="rounded-lg border border-line bg-paper p-3.5 space-y-3">
      <h2 className="font-sans text-[12px] font-semibold tracking-wider text-soft">Question Navigator</h2>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by #, text, type..."
        className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 text-[13px] outline-none focus:border-pri"
        aria-label="Search questions"
      />
      <div className="grid max-h-[230px] grid-cols-5 gap-1.5 overflow-auto p-0.5">
        {visible.map(({ q, index }) => {
          const state = getStatus(q.id);
          const isCurrent = index === currentIndex;
          return (
            <button
              key={q.id}
              onClick={() => onJump(index)}
              className={`relative flex aspect-square items-center justify-center rounded-md border text-[13px] font-semibold transition-colors ${statusClassMap[state.status]} ${isCurrent ? "ring-2 ring-pri ring-offset-1" : "hover:bg-line/40"}`}
              aria-label={`Go to question ${index + 1}`}
            >
              {state.marked && <div className="absolute right-1 top-1 h-2 w-2 rounded-full border border-paper bg-amber" />}
              {index + 1}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-1.5 border-t border-line pt-3 font-sans text-[11px] text-soft">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] border border-line bg-success" />Answered</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] border border-line bg-amber" />Marked</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] border border-line bg-paper-raised" />Visited</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[3px] border border-line bg-paper" />Not visited</span>
      </div>
    </aside>
  );
}
