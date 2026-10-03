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
    <div className="mt-6 flex flex-wrap items-center gap-3">
      <button onClick={onPrev} disabled={currentIndex === 0} className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-sans text-xs font-semibold uppercase tracking-wider text-slate-600 transition-colors hover:bg-slate-50 focus:ring-2 focus:ring-slate-200 disabled:opacity-50">Previous</button>
      <button onClick={onNext} disabled={isLast} className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-sans text-xs font-semibold uppercase tracking-wider text-slate-600 transition-colors hover:bg-slate-50 focus:ring-2 focus:ring-slate-200 disabled:opacity-50">Next</button>

      <label className="ml-2 flex items-center gap-2 text-sm text-slate-600">
        <span className="font-sans text-xs font-semibold uppercase tracking-wider">Jump</span>
        <select
          value={currentIndex}
          onChange={(e) => onJump(Number(e.target.value))}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
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
        className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-sans text-xs font-semibold uppercase tracking-wider text-slate-600 transition-colors hover:bg-slate-50 focus:ring-2 focus:ring-slate-200 disabled:opacity-50"
      >
        Last visited
      </button>

      {isLast ? (
        // Final question: hand over to submit — the student shouldn't have to
        // hunt for the submit button after answering the last question.
        <button
          onClick={onSubmit}
          className="ml-auto rounded-lg border border-emerald-600 bg-emerald-600 px-6 py-2.5 font-sans text-xs font-bold uppercase tracking-wider text-white shadow-sm transition-colors hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1"
        >
          Submit exam
        </button>
      ) : (
        <>
          <button onClick={onToggleReview} className="rounded-lg border border-amber-500/50 bg-amber-50 px-4 py-2 font-sans text-xs font-semibold uppercase tracking-wider text-amber-600 transition-colors hover:bg-amber-100">
            {isReviewed ? "Unmark review" : "Review"}
          </button>
          <button onClick={onSaveNow} className="ml-auto rounded-lg border border-slate-800 bg-slate-800 px-4 py-2 font-sans text-xs font-semibold uppercase tracking-wider text-white shadow-sm transition-colors hover:bg-slate-900 focus:ring-2 focus:ring-slate-700 focus:ring-offset-1">Save</button>
        </>
      )}
    </div>
  );
}
