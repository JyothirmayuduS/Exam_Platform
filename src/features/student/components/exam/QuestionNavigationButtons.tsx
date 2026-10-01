type QuestionNavigationButtonsProps = {
  currentIndex: number;
  total: number;
  lastVisited: string | null;
  isReviewed: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
  onGoLastVisited: () => void;
  onToggleReview: () => void;
  onSaveNow: () => void;
  /** Opens the submit flow — replaces Save/Review on the final question. */
  onSubmit?: () => void;
};

export default function QuestionNavigationButtons({
  currentIndex,
  total,
  lastVisited,
  isReviewed,
  onPrev,
  onNext,
  onJump,
  onGoLastVisited,
  onToggleReview,
  onSaveNow,
  onSubmit,
}: QuestionNavigationButtonsProps) {
  const isLast = currentIndex === total - 1;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <button onClick={onPrev} disabled={currentIndex === 0} className="border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider disabled:opacity-60">Previous</button>
      <button onClick={onNext} disabled={isLast} className="border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider disabled:opacity-60">Next</button>

      <label className="ml-2 flex items-center gap-2 text-[12px]">
        <span className="font-mono text-[10px] uppercase tracking-wider">Jump to</span>
        <select
          value={currentIndex}
          onChange={(e) => onJump(Number(e.target.value))}
          className="border border-line px-2 py-1.5"
          aria-label="Jump to question"
        >
          {Array.from({ length: total }, (_, i) => (
            <option key={i} value={i}>Q {i + 1}</option>
          ))}
        </select>
      </label>

      <button
        onClick={onGoLastVisited}
        disabled={!lastVisited}
        className="border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider disabled:opacity-60"
      >
        Last visited
      </button>

      {isLast ? (
        // Final question: hand over to submit — the student shouldn't have to
        // hunt for the submit button after answering the last question.
        <button
          onClick={onSubmit}
          className="ml-auto border border-maroon bg-maroon px-5 py-2 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-maroon-dark"
        >
          Submit exam
        </button>
      ) : (
        <>
          <button onClick={onToggleReview} className="border border-amber bg-amber/10 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-amber">
            {isReviewed ? "Unmark review" : "Review"}
          </button>
          <button onClick={onSaveNow} className="ml-auto border border-ink px-3 py-2 font-mono text-[11px] uppercase tracking-wider">Save</button>
        </>
      )}
    </div>
  );
}
