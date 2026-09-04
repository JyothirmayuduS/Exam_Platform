import { FiCheckCircle, FiAlertCircle } from "react-icons/fi";
import type { SaveStatus } from "../../hooks/useAutosave";

type AnswerPanelProps = {
  answerStatus: "Answered" | "Not Answered" | "Review";
  saveStatus: SaveStatus;
  lastSavedAt: string | null;
  draftedCount: number;
  timeString: string;
  onSubmit: () => void;
};

function saveText(status: SaveStatus): string {
  if (status === "saving") return "Saving...";
  if (status === "saved") return "Saved";
  if (status === "failed") return "Save Failed";
  if (status === "local") return "Saved locally";
  return "Autosave idle";
}

function saveTone(status: SaveStatus): string {
  if (status === "saving") return "text-amber";
  if (status === "saved") return "text-success";
  if (status === "failed") return "text-alert";
  if (status === "local") return "text-ink-soft";
  return "text-ink-soft";
}

export default function AnswerPanel({
  answerStatus,
  saveStatus,
  lastSavedAt,
  draftedCount,
  timeString,
  onSubmit,
}: AnswerPanelProps) {
  return (
    <aside className="space-y-3 border border-line bg-paper-raised p-4">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Answer panel</p>
      <p className="text-[13px]"><span className="font-medium">Status:</span> {answerStatus}</p>
      <p className={`flex items-center gap-1.5 font-mono text-[11px] ${saveTone(saveStatus)}`}>{saveStatus === "saved" ? <FiCheckCircle aria-hidden /> : <FiAlertCircle aria-hidden />} {saveText(saveStatus)}{lastSavedAt ? ` · ${lastSavedAt}` : ""}</p>
      <p className="font-mono text-[11px] text-ink-soft">{draftedCount} answers drafted</p>
      <div className="border border-line bg-paper px-3 py-2 font-mono text-[13px]">
        Time remaining: {timeString}
      </div>
      <button onClick={onSubmit} className="w-full border border-maroon bg-maroon px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-maroon-dark">
        Submit exam
      </button>
    </aside>
  );
}
