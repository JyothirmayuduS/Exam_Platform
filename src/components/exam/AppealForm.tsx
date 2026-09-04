import { useState } from "react";

type AppealFormProps = {
  examId: string;
  questionNo: number;
  currentMarks: number;
  maxMarks: number;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
};

export default function AppealForm({ questionNo, currentMarks, maxMarks, onSubmit, onCancel }: AppealFormProps) {
  const [reason, setReason] = useState("");

  return (
    <div className="border border-amber/50 bg-amber/5 p-5 mt-4 text-[13px]">
      <div className="flex items-center gap-2 mb-3">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber/20 text-amber font-bold">!</span>
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-amber">File an Appeal for Q{questionNo}</h3>
      </div>
      
      <p className="text-ink-soft mb-4">
        You were awarded <strong className="text-ink">{currentMarks} / {maxMarks} marks</strong> for this question. 
        If you believe there was a grading error, you can submit an appeal for the examiner to review.
      </p>

      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Explain why your answer is correct or deserves more marks (min 20 characters)..."
        className="w-full h-24 border border-line bg-paper p-3 font-sans text-[13px] text-ink focus:border-amber focus:outline-none resize-none"
      />

      <div className="mt-4 flex gap-3">
        <button
          onClick={() => onSubmit(reason)}
          disabled={reason.length < 20}
          className="bg-amber text-white font-mono text-[10px] uppercase tracking-wider px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors hover:bg-amber/90"
        >
          Submit Appeal
        </button>
        <button
          onClick={onCancel}
          className="border border-line text-ink font-mono text-[10px] uppercase tracking-wider px-4 py-2 hover:bg-paper-raised"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
