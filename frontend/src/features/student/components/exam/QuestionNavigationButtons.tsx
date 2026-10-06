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
  /** Timed sections: navigation stays inside [start, end). */
  range?: { start: number; end: number };
  /** Timed sections: shown instead of "Save and next" on a section's last question. */
  onFinishSection?: () => void;
};

export default function QuestionNavigationButtons({
  currentIndex,
  total,
  onPrev,
  onNext,
  onSubmit,
  range,
  onFinishSection,
}: QuestionNavigationButtonsProps) {
  const start = range?.start ?? 0;
  const end = range?.end ?? total;
  const isLast = currentIndex === total - 1;
  const endOfSection = !isLast && currentIndex === end - 1 && !!onFinishSection;
  return (
    <div className="exam-ft" style={{ border: 0, margin: 0, paddingTop: 0 }}>
      <div className="exam-nv">
        <button
          onClick={onPrev}
          disabled={currentIndex <= start}
          className="exam-btn"
        >
          Previous
        </button>
        <button
          onClick={isLast ? onSubmit : endOfSection ? onFinishSection : onNext}
          className={`exam-btn ${isLast ? "ok" : "pri"}`}
        >
          {isLast ? "Submit exam" : endOfSection ? "Finish section" : "Save and next"}
        </button>
      </div>
    </div>
  );
}
