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
    <aside className="border border-line bg-raised p-4 space-y-4">
      {/* Time-pressure hint only — the countdown itself lives in the sticky
          header (and turns amber/red there). No duplicated big timer card. */}
      {secondsLeft <= 300 && (
        <div className={`flex items-center gap-2 border px-3 py-2 text-[12px] ${
          secondsLeft <= 60 ? "border-alert bg-alert/10 text-alert" : "border-amber bg-amber/10 text-amber"
        }`}>
          <FiAlertTriangle aria-hidden className="shrink-0" />
          <span className="font-medium">{secondsLeft <= 60 ? "Less than 1 minute left!" : "5 minutes remaining"}</span>
        </div>
      )}

      {/* Progress bar */}
      <div>
        <div className="flex justify-between font-mono text-[9px] uppercase tracking-widest text-soft mb-1">
          <span>Progress</span>
          <span>{answered}/{total}</span>
        </div>
        <div className="h-1.5 w-full bg-line">
          <div className="h-full bg-success transition-all duration-500" style={{ width: `${(answered / Math.max(total, 1)) * 100}%` }} />
        </div>
      </div>

      {/* Tab nav */}
      <div className="flex flex-wrap gap-1">
        {tabs.map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-wider ${tab === item ? "border-maroon bg-maroon text-paper" : "border-line text-soft hover:text-ink"}`}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "progress" && (
        <div className="space-y-2 text-[12px]">
          <div className="flex justify-between"><span className="text-soft">Answered</span><span className="font-semibold text-success">{answered}</span></div>
          <div className="flex justify-between"><span className="text-soft">Unanswered</span><span className="font-semibold">{total - answered}</span></div>
          <div className="flex justify-between"><span className="text-soft">Marked</span><span className="font-semibold text-amber">{marked}</span></div>
        </div>
      )}
      {tab === "messages" && (
        <div className="space-y-1 text-[12px] text-soft">
          {messages.length === 0 ? <p>No proctor messages</p> : messages.map((m, i) => <p key={i}>• {m}</p>)}
        </div>
      )}
      {tab === "instructions" && <p className="text-[12px] text-soft">{instructions}</p>}
      {tab === "notes" && <p className="text-[12px] text-soft">{note}</p>}
    </aside>
  );
}
