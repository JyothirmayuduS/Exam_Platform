import { useState } from "react";

type ExamSidebarProps = {
  answered: number;
  total: number;
  marked: number;
  timeString: string;
  messages?: string[];
  instructions?: string;
  note?: string;
};

const tabs = ["progress", "timer", "messages", "instructions", "notes"] as const;
type Tab = (typeof tabs)[number];

export default function ExamSidebar({
  answered,
  total,
  marked,
  timeString,
  messages = [],
  instructions = "Follow exam rules and avoid switching tabs/windows.",
  note = "Use keyboard shortcuts: ↑/↓ next/prev, Ctrl+S save, R mark review.",
}: ExamSidebarProps) {
  const [tab, setTab] = useState<Tab>("progress");

  return (
    <aside className="border border-line bg-paper-raised p-4">
      <div className="mb-3 flex flex-wrap gap-1">
        {tabs.map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`border px-2 py-1 font-mono text-[9px] uppercase tracking-wider ${tab === item ? "border-maroon bg-maroon text-paper" : "border-line"}`}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "progress" && (
        <div className="space-y-2 text-[12px]">
          <p>Answered: <strong>{answered}/{total}</strong></p>
          <p>Marked: <strong>{marked}</strong></p>
        </div>
      )}
      {tab === "timer" && <p className="font-mono text-[13px]">Total time: {timeString}</p>}
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
