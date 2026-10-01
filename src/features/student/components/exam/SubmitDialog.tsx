type SubmitDialogProps = {
  open: boolean;
  answered: number;
  total: number;
  marked: number;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function SubmitDialog({ open, answered, total, marked, onCancel, onConfirm }: SubmitDialogProps) {
  if (!open) return null;

  const pending = total - answered;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-md border border-line bg-paper p-5">
        <h3 className="font-serif text-xl font-semibold">Submit exam?</h3>
        <p className="mt-2 text-[13px]">{answered} answered out of {total}</p>
        <p className="text-[13px]">{marked} marked for review</p>
        {pending > 0 && (
          <p className="mt-2 text-[12px] text-alert">Warning: {pending} question(s) not answered.</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="border border-line px-3 py-2 font-mono text-[11px] uppercase tracking-wider">Cancel</button>
          <button onClick={onConfirm} className="border border-maroon bg-maroon px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-paper">Submit</button>
        </div>
      </div>
    </div>
  );
}
