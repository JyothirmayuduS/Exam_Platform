import type { SaveStatus } from "@/features/student/hooks/useAutosave";
import "./ExamStyle.css";

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
    <header className="exam-header">
      {/* Brand */}
      <div className="exam-brand">
        <div className="exam-logo">E</div>
        <div>
          <div className="exam-b1">ExamShield</div>
          <div className="exam-b2">Vignan University</div>
        </div>
      </div>

      {/* Info */}
      <div>
        <div className="exam-ttl">{examName}</div>
        <div className="exam-sm exam-mute">{studentName} · Q {currentQuestion} of {totalQuestions}</div>
      </div>

      <div className="exam-sp" />

      {/* Actions & Status */}
      <div className={`exam-saved ${autosaveStatus === 'saving' ? 'saving' : (autosaveStatus === 'local' || autosaveStatus === 'failed') ? 'offline' : ''}`}>
        <i />{autosaveStatus === "saving" ? "Saving…" : autosaveStatus === "saved" ? "All changes saved" : autosaveStatus === "local" ? "Offline" : "Unsaved"}
      </div>
      
      <div className={`exam-timer ${isAlert ? "alert" : ""}`} role="timer">
        {timeString}
      </div>
      
      <button onClick={onToggleFullscreen} className="exam-btn" style={{ marginLeft: "12px" }}>
        {isFullscreen ? "Minimize" : "Fullscreen"}
      </button>
      <button onClick={onExit} className="exam-btn pri" style={{ marginLeft: "12px" }}>
        Exit
      </button>
    </header>
  );
}
