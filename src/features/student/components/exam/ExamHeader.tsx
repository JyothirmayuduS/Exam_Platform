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
  // Map the timer tone class to our old colors (alert/amber/success/ink)
  const isAlert = timerToneClass.includes("alert");
  const isWarn = timerToneClass.includes("amber");
  
  const timerClass = isAlert 
    ? "border-alert bg-alert/10 text-alert" 
    : isWarn 
    ? "border-amber bg-amber/10 text-amber" 
    : "border-line bg-paper text-ink";

  return (
    <header className="sticky top-0 z-40 flex flex-wrap items-center gap-4 border-b-2 border-pri bg-[#0B2545] px-5 py-2 text-white">
      {/* Brand */}
      <div className="flex items-center gap-3 border-r border-white/25 pr-4">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-white font-bold text-[#0B2545]">E</div>
        <div>
          <div className="text-[14px] font-semibold leading-tight">ExamShield</div>
          <div className="text-[11px] text-white/70">Vignan University</div>
        </div>
      </div>

      {/* Info */}
      <div>
        <div className="text-[14px] font-semibold">{examName}</div>
        <div className="text-[12px] text-white/70">{studentName} · Q {currentQuestion} of {totalQuestions}</div>
      </div>

      <div className="flex-1" />

      {/* Actions & Status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5 text-[12px] text-white/80">
          {autosaveStatus === "saving" && <span className="h-2 w-2 animate-pulse rounded-full bg-amber" />}
          {autosaveStatus === "saved" && <span className="h-2 w-2 rounded-full bg-success" />}
          {autosaveStatus === "local" && <span className="h-2 w-2 rounded-full bg-alert" />}
          {autosaveStatus === "failed" && <span className="h-2 w-2 rounded-full bg-alert" />}
          <span>{autosaveStatus === "saving" ? "Saving…" : autosaveStatus === "saved" ? "All changes saved" : autosaveStatus === "local" ? "Offline" : "Unsaved"}</span>
        </div>
        
        <div className={`min-w-[86px] rounded-md border px-3 py-0.5 text-center text-[20px] font-semibold tabular-nums ${timerClass}`}>
          {timeString}
        </div>
        
        <button
          onClick={onToggleFullscreen}
          className="rounded-md border border-line/40 bg-white/10 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider hover:bg-white/20"
        >
          {isFullscreen ? "Minimize" : "Fullscreen"}
        </button>
        <button
          onClick={onExit}
          className="rounded-md bg-alert px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-white hover:bg-alert/90"
        >
          Exit
        </button>
      </div>
    </header>
  );
}
