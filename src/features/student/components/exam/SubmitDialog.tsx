import { useEffect, useRef } from "react";
import "./ExamStyle.css";

type SubmitDialogProps = {
  open: boolean;
  answered: number;
  total: number;
  marked: number;
  /** Question numbers (1-based) still unanswered; listed as ranges. */
  unanswered?: number[];
  onCancel: () => void;
  onConfirm: () => void;
};

/** "1, 2, 3, 5, 7, 8, 9" → "1–3, 5, 7–9" */
export function formatRanges(nums: number[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i + 1 ? `${nums[i]}–${nums[j]}` : nums.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  return out.join(", ");
}

export default function SubmitDialog({ open, answered, total, marked, unanswered, onCancel, onConfirm }: SubmitDialogProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    backRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  const pending = total - answered;

  return (
    <div className="exam-scrim" role="dialog" aria-modal="true" aria-labelledby="submit-title">
      <div className="exam-dialog">
        <h3 id="submit-title">Submit exam?</h3>
        <div className="exam-mute">You cannot change answers after submitting.</div>
        <div className="exam-sum">
          <div className="exam-stat"><b>{answered}</b><span>Answered</span></div>
          <div className="exam-stat"><b>{pending}</b><span>Unanswered</span></div>
          <div className="exam-stat"><b>{marked}</b><span>Marked</span></div>
        </div>
        <div className="exam-sm exam-mute">
          {pending === 0
            ? "All questions answered."
            : unanswered?.length
              ? `Unanswered: ${formatRanges(unanswered)}`
              : `${pending} question${pending === 1 ? "" : "s"} not answered.`}
        </div>
        <div className="exam-dact">
          <button ref={backRef} onClick={onCancel} className="exam-btn">Back to exam</button>
          <button onClick={onConfirm} className="exam-btn ok">Confirm and submit</button>
        </div>
      </div>
    </div>
  );
}
