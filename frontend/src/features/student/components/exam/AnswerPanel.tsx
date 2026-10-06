import type { SaveStatus } from "@/features/student/hooks/useAutosave";
import "./ExamStyle.css";

type AnswerPanelProps = {
  answerStatus: "Answered" | "Not Answered" | "Review";
  saveStatus: SaveStatus;
  lastSavedAt: string | null;
  draftedCount: number;
  onSubmit: () => void;
};

function saveText(status: SaveStatus): string {
  if (status === "saving") return "Saving…";
  if (status === "saved") return "Saved";
  if (status === "failed") return "Save failed";
  if (status === "local") return "Saved locally";
  return "Autosave idle";
}

export default function AnswerPanel({
  answerStatus,
  saveStatus,
  lastSavedAt,
  draftedCount,
  onSubmit,
}: AnswerPanelProps) {
  return (
    <section className="exam-panel">
      <h2>Answer panel</h2>
      <div className="exam-chip" style={{ marginBottom: 8 }}>
        <span>Status</span><span>{answerStatus}</span>
      </div>
      <p className="exam-sm exam-mute" style={{ marginBottom: 8 }}>
        {saveText(saveStatus)}{lastSavedAt ? ` · ${lastSavedAt}` : ""}
      </p>
      <p className="exam-sm exam-mute" style={{ marginBottom: 12 }}>{draftedCount} answers drafted</p>
      <button onClick={onSubmit} className="exam-btn pri" style={{ width: "100%" }}>
        Submit exam
      </button>
    </section>
  );
}
