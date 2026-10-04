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
    <section className="exam-panel">
      <h2>Question Navigator</h2>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by #, text, type..."
        className="exam-search"
        aria-label="Search questions"
      />
      <div className="exam-grid">
        {visible.map(({ q, index }) => {
          const state = getStatus(q.id);
          const isCurrent = index === currentIndex;
          
          let classes = "exam-n";
          if (isCurrent) classes += " c";
          if (state.status === "answered") classes += " a";
          else if (state.status === "visited") classes += " v";
          if (state.marked) classes += " m";

          return (
            <button
              key={q.id}
              onClick={() => onJump(index)}
              className={classes}
              aria-label={`Go to question ${index + 1}`}
            >
              {index + 1}
            </button>
          );
        })}
      </div>
      <div className="exam-leg">
        <span><i style={{ background: "var(--ok)" }} />Answered</span>
        <span><i style={{ background: "var(--warn)" }} />Marked</span>
        <span><i style={{ background: "var(--ps)" }} />Visited</span>
        <span><i />Not visited</span>
      </div>
    </section>
  );
}
