import { FiCheckCircle, FiAlertCircle } from "react-icons/fi";
import type { SaveStatus } from "@/features/student/hooks/useAutosave";

type AnswerPanelProps = {
  answerStatus: "Answered" | "Not Answered" | "Review";
  saveStatus: SaveStatus;
  lastSavedAt: string | null;
  draftedCount: number;
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
  if (status === "saving") return "text-amber-500";
  if (status === "saved") return "text-emerald-600";
  if (status === "failed") return "text-red-500";
  if (status === "local") return "text-slate-500";
  return "text-slate-400";
}

export default function AnswerPanel({
  answerStatus,
  saveStatus,
  lastSavedAt,
  draftedCount,
  onSubmit,
}: AnswerPanelProps) {
  return (
    <aside className="rounded-xl border border-line/40 bg-white p-5 shadow-sm space-y-4">
      <p className="font-sans text-xs font-semibold uppercase tracking-wider text-slate-500">Answer Panel</p>
      <div className="rounded-lg bg-slate-50 p-3">
        <p className="text-sm font-medium text-slate-700">Status: <span className="font-normal">{answerStatus}</span></p>
      </div>
      <div className="space-y-1.5">
        <p className={`flex items-center gap-2 font-sans text-xs font-medium ${saveTone(saveStatus)}`}>
          {saveStatus === "saved" ? <FiCheckCircle aria-hidden className="h-4 w-4" /> : <FiAlertCircle aria-hidden className="h-4 w-4" />} 
          {saveText(saveStatus)}{lastSavedAt ? ` · ${lastSavedAt}` : ""}
        </p>
        <p className="font-sans text-[11px] text-slate-400">{draftedCount} answers drafted</p>
      </div>
      <button 
        onClick={onSubmit} 
        className="mt-2 w-full rounded-lg bg-emerald-600 px-4 py-3 font-sans text-sm font-bold uppercase tracking-wider text-white shadow-sm transition-all hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-500 focus:ring-offset-1"
      >
        Submit Exam
      </button>
    </aside>
  );
}
