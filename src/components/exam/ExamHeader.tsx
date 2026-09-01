type ExamHeaderProps = {
  examName: string;
  studentName: string;
  currentQuestion: number;
  totalQuestions: number;
  timeString: string;
  timerToneClass: string;
  onExit: () => void;
  onToggleFullscreen: () => void;
  isFullscreen: boolean;
};

export default function ExamHeader({
  examName,
  studentName,
  currentQuestion,
  totalQuestions,
  timeString,
  timerToneClass,
  onExit,
  onToggleFullscreen,
  isFullscreen,
}: ExamHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/95 px-4 py-3 backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4">
        <div>
          <p className="font-serif text-[15px] font-semibold">{examName}</p>
          <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">{studentName} · Q {currentQuestion}/{totalQuestions}</p>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <div className={`tabular border px-3 py-1.5 font-mono text-[15px] font-medium ${timerToneClass}`}>
            {timeString}
          </div>
          <button
            onClick={onToggleFullscreen}
            className="border border-line-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink"
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? "Minimize" : "Fullscreen"}
          </button>
          <button
            onClick={onExit}
            className="border border-alert bg-alert px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-paper"
            aria-label="Emergency exit"
          >
            Exit
          </button>
        </div>
      </div>
    </header>
  );
}
