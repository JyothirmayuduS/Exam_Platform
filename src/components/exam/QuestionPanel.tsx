import { useMemo, useState } from "react";
import type { QuestionStatus } from "../../hooks/useExamState";

type Question = {
  id: number;
  text: string;
  category: string;
  options: string[];
  type?: "mcq" | "subjective";
};

type QuestionPanelProps = {
  questions: Question[];
  currentIndex: number;
  getStatus: (questionId: number) => QuestionStatus;
  onJump: (index: number) => void;
};

const statusClassMap: Record<QuestionStatus, string> = {
  answered: "border-success bg-success text-paper",
  marked: "border-amber bg-amber text-paper",
  visited: "border-line-strong bg-paper text-ink",
  unvisited: "border-line bg-paper text-ink-soft",
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
    <aside className="space-y-3 border border-line bg-paper-raised p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Question navigator</p>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by #, text, type, topic"
        className="w-full border border-line px-2 py-1.5 text-[12px]"
        aria-label="Search questions"
      />
      <div className="grid grid-cols-5 gap-1.5">
        {visible.map(({ q, index }) => {
          const status = getStatus(q.id);
          const isCurrent = index === currentIndex;
          return (
            <button
              key={q.id}
              onClick={() => onJump(index)}
              className={`flex h-9 items-center justify-center border font-mono text-[12px] transition-colors ${statusClassMap[status]} ${isCurrent ? "ring-2 ring-blue-500 ring-offset-1" : ""}`}
              aria-label={`Go to question ${q.id}`}
            >
              {q.id}
            </button>
          );
        })}
      </div>
      <div className="space-y-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 border border-success bg-success" />Answered</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 border border-amber bg-amber" />Marked for review</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 border border-line-strong" />Visited</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 border border-line" />Not visited</span>
      </div>
    </aside>
  );
}
