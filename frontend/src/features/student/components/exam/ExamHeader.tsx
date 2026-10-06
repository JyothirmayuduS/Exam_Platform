import type { SaveStatus } from "@/features/student/hooks/useAutosave";
import { isTauri } from "@/shared/platform/platform";
import "./ExamStyle.css";

type ExamHeaderProps = {
  examName: string;
  studentName: string;
  /** Roll number shown next to the student's name. */
  studentRoll?: string;
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

const SAVE_LABEL: Record<SaveStatus, string> = {
  idle: "Autosave on",
  saving: "Saving…",
  saved: "All changes saved",
  local: "Offline — saved on this device",
  failed: "Not saved — retrying",
};

export default function ExamHeader({
  examName,
  studentName,
  studentRoll,
  timeString,
  timerToneClass,
  onExit,
  onToggleFullscreen,
  isFullscreen,
  autosaveStatus,
}: ExamHeaderProps) {
  const timerClass = timerToneClass.includes("alert") ? "c" : timerToneClass.includes("amber") ? "w" : "";
  const saveClass = autosaveStatus === "saving" ? "saving" : autosaveStatus === "local" || autosaveStatus === "failed" ? "offline" : "";

  return (
    <header className="exam-header">
      <div className="exam-brand">
        <svg className="exam-logo" viewBox="0 0 64 64" role="img" aria-label="Vignan">
          <rect width="64" height="64" rx="10" fill="#F7F5F0" />
          <path d="M32 46 14 18h8.4l9.6 17.6L41.6 18H50L32 46Z" fill="#284B34" />
          <circle cx="48.5" cy="18.5" r="4.5" fill="#B7791F" />
        </svg>
        <div>
          <div className="exam-b1">Vignan Exam Browser</div>
          <div className="exam-b2">Vignan University</div>
        </div>
      </div>

      <div>
        <div className="exam-ttl">{examName}</div>
        <div className="exam-sm exam-mute">
          {studentName}
          {studentRoll ? ` · ${studentRoll}` : ""}
        </div>
      </div>

      <div className="exam-sp" />

      <div className={`exam-saved ${saveClass}`} role="status">
        <i />
        {SAVE_LABEL[autosaveStatus]}
      </div>

      <div className={`exam-timer ${timerClass}`} role="timer" aria-live="off" aria-label={`Time remaining ${timeString}`}>
        {timeString}
      </div>

      {!isTauri() && (
        <button type="button" onClick={onToggleFullscreen} className="exam-btn">
          {isFullscreen ? "Exit full screen" : "Full screen"}
        </button>
      )}
      <button type="button" onClick={onExit} className="exam-btn">
        Submit exam
      </button>
    </header>
  );
}
