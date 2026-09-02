import { useState } from "react";
import { getSupabase } from "../lib/supabase";

export default function ReportErrorModal({ isOpen, onClose, notify }: { isOpen: boolean; onClose: () => void; notify: (m: string) => void }) {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    
    setLoading(true);
    const db = getSupabase();
    if (db) {
      await db.functions.invoke("report-error", {
        body: {
          kind: "User Report",
          message,
          url: window.location.href,
        },
      });
    }
    setLoading(false);
    notify("Thank you! Your report has been submitted.");
    setMessage("");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md border border-line-strong bg-paper shadow-2xl">
        <div className="border-b border-line-strong px-6 py-4 flex justify-between items-center bg-paper-raised">
          <h2 className="font-serif text-xl font-semibold">Report an Issue</h2>
          <button onClick={onClose} className="text-ink-soft hover:text-ink">✕</button>
        </div>
        
        <form onSubmit={handleSubmit} className="p-6">
          <p className="text-[13px] text-ink-soft mb-4">
            If you encountered a bug or unexpected behavior, please describe what happened so our team can fix it.
          </p>
          
          <textarea 
            className="w-full min-h-[120px] resize-y border border-line-strong bg-paper p-3 text-[13px] outline-none focus:border-forest"
            placeholder="What were you trying to do, and what went wrong?"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={loading}
          />
          
          <div className="mt-6 flex justify-end gap-3">
            <button 
              type="button" 
              onClick={onClose} 
              disabled={loading}
              className="border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
            <button 
              type="submit"
              disabled={loading || !message.trim()}
              className="border border-forest bg-forest px-6 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? "Sending..." : "Submit Report"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
