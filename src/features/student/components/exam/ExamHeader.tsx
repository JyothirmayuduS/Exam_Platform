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
}: ExamHeaderProps) {
  const isAlert = timerToneClass.includes("alert");

  return (
    <header className="exam-header">
      <div className="exam-brand">
        <div className="exam-logo">V</div>
        <div>
          <div className="exam-b1">Vignan Lockdown</div>
          <div className="exam-b2">Vignan University</div>
        </div>
      </div>

      <div>
        <div className="exam-ttl">{examName}</div>
        <div className="exam-sm exam-mute">
          {studentName} · Question {currentQuestion} of {totalQuestions}
        </div>
      </div>

      <div className="exam-sp" />

      <div
        className={`exam-saved ${
          autosaveStatus === "saving"
            ? "saving"
            : autosaveStatus === "local" || autosaveStatus === "failed"
            ? "offline"
            : ""
        }`}
      >
        <i />
        {autosaveStatus === "saving"
          ? "Saving"
          : autosaveStatus === "saved"
          ? "Saved"
          : autosaveStatus === "local"
          ? "Offline"
          : "Unsaved"}
      </div>

      <div className={`exam-timer ${isAlert ? "alert" : ""}`} role="timer" aria-live="polite">
        {timeString}
      </div>

      <button type="button" onClick={onToggleFullscreen} className="exam-btn" style={{ marginLeft: 8 }}>
        {isFullscreen ? "Window" : "Fullscreen"}
      </button>
      <button type="button" onClick={onExit} className="exam-btn pri" style={{ marginLeft: 8 }}>
        Exit
      </button>
    </header>
  );
}
