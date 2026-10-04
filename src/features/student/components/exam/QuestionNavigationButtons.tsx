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
  onPrev,
  onNext,
  onSubmit,
}: QuestionNavigationButtonsProps) {
  const isLast = currentIndex === total - 1;
  return (
    <div className="exam-ft" style={{ border: 0, margin: 0, paddingTop: 0 }}>
      <div className="exam-nv">
        <button 
          onClick={onPrev} 
          disabled={currentIndex === 0} 
          className="exam-btn"
        >
          Previous
        </button>
        <button 
          onClick={isLast ? onSubmit : onNext}
          className="exam-btn pri"
        >
          {isLast ? "Submit exam" : "Save and next"}
        </button>
      </div>
    </div>
  );
}
