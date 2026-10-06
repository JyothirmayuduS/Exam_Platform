import { useState } from "react";
import { FiAlertTriangle } from "react-icons/fi";

type ExamSidebarProps = {
  answered: number;
  total: number;
  marked: number;
  /** Kept for API compatibility — the timer card itself was removed: the
   *  header countdown + AnswerPanel already show time, and a second big
   *  timer here repeated the same number one column over. */
  timeString?: string;
  secondsLeft: number;
  messages?: string[];
  instructions?: string;
  note?: string;
};

const tabs = ["progress", "messages", "instructions", "notes"] as const;
type Tab = (typeof tabs)[number];

export default function ExamSidebar({
  answered,
  total,
  marked,
  secondsLeft,
  messages = [],
  instructions = "Follow exam rules and avoid switching tabs/windows.",
  note = "Use keyboard shortcuts: ↑/↓ next/prev, Ctrl+S save, R mark review, Space toggle T/F, ? help.",
}: ExamSidebarProps) {
  const [tab, setTab] = useState<Tab>("progress");

  return (
    <aside className="rounded-xl border border-line/40 bg-white p-5 shadow-sm space-y-6">
      {/* Time-pressure hint only */}
      {secondsLeft <= 300 && (
        <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
          secondsLeft <= 60 ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-700"
        }`}>
          <FiAlertTriangle aria-hidden className="shrink-0 h-5 w-5" />
          <span className="font-semibold">{secondsLeft <= 60 ? "Less than 1 minute left!" : "5 minutes remaining"}</span>
        </div>
      )}

      {/* Progress bar */}
      <div>
        <div className="flex justify-between font-sans text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
          <span>Progress</span>
          <span>{answered}/{total}</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-emerald-500 transition-all duration-500" style={{ width: `${(answered / Math.max(total, 1)) * 100}%` }} />
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex flex-wrap gap-2 border-b border-line/40 pb-2">
        {tabs.map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`rounded-md px-3 py-1.5 font-sans text-xs font-semibold uppercase tracking-wider transition-colors ${tab === item ? "bg-slate-800 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100"}`}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "progress" && (
        <div className="space-y-3 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Answered</span><span className="font-semibold text-emerald-600">{answered}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Unanswered</span><span className="font-semibold text-slate-700">{total - answered}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">Marked for Review</span><span className="font-semibold text-amber-500">{marked}</span></div>
        </div>
      )}
      {tab === "messages" && (
        <div className="space-y-2 text-sm text-slate-600">
          {messages.length === 0 ? <p className="italic text-slate-400">No proctor messages</p> : messages.map((m, i) => <p key={i} className="rounded bg-slate-50 p-2">💬 {m}</p>)}
        </div>
      )}
      {tab === "instructions" && <p className="text-sm leading-relaxed text-slate-600">{instructions}</p>}
      {tab === "notes" && <p className="text-sm leading-relaxed text-slate-600">{note}</p>}
    </aside>
  );
}
