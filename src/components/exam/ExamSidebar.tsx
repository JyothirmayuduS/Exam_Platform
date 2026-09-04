import { useState } from "react";
import { FiAlertTriangle } from "react-icons/fi";

type ExamSidebarProps = {
  answered: number;
  total: number;
  marked: number;
  timeString: string;
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
  timeString,
  secondsLeft,
  messages = [],
  instructions = "Follow exam rules and avoid switching tabs/windows.",
  note = "Use keyboard shortcuts: ↑/↓ next/prev, Ctrl+S save, R mark review, Space toggle T/F, ? help.",
}: ExamSidebarProps) {
  const [tab, setTab] = useState<Tab>("progress");

  const timerColor =
    secondsLeft <= 60 ? "text-alert border-alert bg-alert/10" :
    secondsLeft <= 300 ? "text-amber border-amber bg-amber/10" :
    "text-success border-success bg-success/10";

  const timerLabel =
    secondsLeft <= 60 ? <><FiAlertTriangle className="inline text-alert" aria-hidden /> Less than 1 minute!</> :
    secondsLeft <= 300 ? <><FiAlertTriangle className="inline text-amber" aria-hidden /> 5 minutes remaining</> :
    "Time remaining";

  return (
    <aside className="border border-line bg-paper-raised p-4 space-y-4">
      {/* Prominent timer */}
      <div className={`border p-3 text-center rounded-none ${timerColor}`}>
        <p className="font-mono text-[9px] uppercase tracking-widest mb-1 opacity-70">{timerLabel}</p>
        <p className="font-mono text-[28px] font-bold tabular-nums leading-none">{timeString}</p>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between font-mono text-[9px] uppercase tracking-widest text-ink-soft mb-1">
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
            className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-wider ${tab === item ? "border-maroon bg-maroon text-paper" : "border-line text-ink-soft hover:text-ink"}`}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "progress" && (
        <div className="space-y-2 text-[12px]">
          <div className="flex justify-between"><span className="text-ink-soft">Answered</span><span className="font-semibold text-success">{answered}</span></div>
          <div className="flex justify-between"><span className="text-ink-soft">Unanswered</span><span className="font-semibold">{total - answered}</span></div>
          <div className="flex justify-between"><span className="text-ink-soft">Marked</span><span className="font-semibold text-amber">{marked}</span></div>
        </div>
      )}
      {tab === "messages" && (
        <div className="space-y-1 text-[12px] text-ink-soft">
          {messages.length === 0 ? <p>No proctor messages</p> : messages.map((m, i) => <p key={i}>• {m}</p>)}
        </div>
      )}
      {tab === "instructions" && <p className="text-[12px] text-ink-soft">{instructions}</p>}
      {tab === "notes" && <p className="text-[12px] text-ink-soft">{note}</p>}
    </aside>
  );
}
