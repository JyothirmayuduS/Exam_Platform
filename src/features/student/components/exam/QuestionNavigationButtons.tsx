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
    <div className="mt-5 flex justify-between gap-2.5 pt-3.5">
      <button 
        onClick={onPrev} 
        disabled={currentIndex === 0} 
        className="min-w-[80px] rounded-md border border-line bg-paper px-3.5 py-1.5 font-sans text-[13px] font-medium transition-colors hover:bg-bg disabled:opacity-50"
      >
        Prev
      </button>
      <div className="flex gap-2.5">
        <button 
          onClick={onNext}
          disabled={isLast}
          className="min-w-[100px] rounded-md border border-line bg-paper px-3.5 py-1.5 font-sans text-[13px] font-medium transition-colors hover:bg-bg disabled:opacity-50"
        >
          Save & next
        </button>
        <button
          onClick={onSubmit}
          className="rounded-md border-none bg-forest px-4 py-1.5 font-sans text-[13px] font-semibold text-white transition-colors hover:opacity-90"
        >
          Submit exam
        </button>
      </div>
    </div>
  );
}
