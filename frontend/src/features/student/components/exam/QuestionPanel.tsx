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
  /** Timed sections: questions outside the section in progress. */
  isLocked?: (index: number) => boolean;
};

const statusClassMap: Record<QuestionStatus, string> = {
  answered: "bg-success border-success text-white",
  visited: "bg-paper-raised border-line text-ink",
  unvisited: "bg-paper border-line text-ink",
};

export default function QuestionPanel({ questions, currentIndex, getStatus, onJump, isLocked }: QuestionPanelProps) {
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
      <h2>Question navigator</h2>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by number or text"
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

          const locked = isLocked?.(index) ?? false;
          return (
            <button
              key={q.id}
              onClick={() => onJump(index)}
              disabled={locked}
              className={classes}
              style={locked ? { opacity: 0.35, cursor: "not-allowed" } : undefined}
              title={locked ? "Not in the current section" : undefined}
              aria-label={`Go to question ${index + 1}${locked ? " (locked)" : ""}`}
            >
              {index + 1}
            </button>
          );
        })}
      </div>
      <div className="exam-leg">
        <span><i style={{ background: "var(--pri)", borderColor: "var(--pri)" }} />Answered</span>
        <span><i style={{ background: "var(--warnc)", borderColor: "var(--warnc)", borderRadius: "50%" }} />Marked</span>
        <span><i style={{ background: "var(--ps)" }} />Visited</span>
        <span><i />Not visited</span>
      </div>
    </section>
  );
}
