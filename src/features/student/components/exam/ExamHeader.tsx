import type { SaveStatus } from "@/features/student/hooks/useAutosave";

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
  autosaveStatus: SaveStatus;
  lastSavedAt: string | null;
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
  autosaveStatus,
  lastSavedAt,
}: ExamHeaderProps) {
  // Map the timer tone class from old styles to new Tailwind colors
  const mappedTimerToneClass = timerToneClass.includes("alert") 
    ? "border-red-200 bg-red-50 text-red-700"
    : timerToneClass.includes("amber")
    ? "border-amber-200 bg-amber-50 text-amber-700"
    : "border-slate-200 bg-white text-slate-700";

  return (
    <header className="sticky top-0 z-40 border-b border-line/40 bg-white/95 px-4 py-3 shadow-sm backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4">
        <div>
          <p className="font-serif text-lg font-semibold text-slate-800">{examName}</p>
          <p className="font-sans text-xs font-medium uppercase tracking-wider text-slate-500">{studentName} <span className="mx-2 text-slate-300">|</span> Q {currentQuestion} of {totalQuestions}</p>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          <div className="hidden sm:flex items-center gap-2 px-2">
            {autosaveStatus === "saving" && <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />}
            {autosaveStatus === "saved" && <span className="h-2 w-2 rounded-full bg-emerald-500" />}
            {autosaveStatus === "local" && <span className="h-2 w-2 rounded-full bg-red-500" />}
            {autosaveStatus === "failed" && <span className="h-2 w-2 rounded-full bg-red-500" />}
            <span className="font-sans text-[10px] font-bold uppercase tracking-wider text-slate-400">
              {autosaveStatus === "saving" ? "Saving…" : autosaveStatus === "saved" ? "Saved" : autosaveStatus === "local" ? "Offline" : "Unsaved"}
            </span>
          </div>
          <div className={`tabular-nums rounded-lg border px-4 py-2 font-mono text-lg font-bold shadow-sm ${mappedTimerToneClass}`}>
            {timeString}
          </div>
          <button
            onClick={onToggleFullscreen}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-sans text-xs font-semibold uppercase tracking-wider text-slate-600 shadow-sm transition-colors hover:bg-slate-50 focus:ring-2 focus:ring-slate-200"
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? "Minimize" : "Fullscreen"}
          </button>
          <button
            onClick={onExit}
            className="rounded-lg border border-red-600 bg-red-600 px-4 py-2 font-sans text-xs font-bold uppercase tracking-wider text-white shadow-sm transition-colors hover:bg-red-700 focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
            aria-label="Emergency exit"
          >
            Exit
          </button>
        </div>
      </div>
    </header>
  );
}
