import { useEffect, useMemo, useState } from "react";

type ExamCountdownProps = {
  startAt: string | null;
  durationMinutes: number;
  className?: string;
};

function pad(v: number): string {
  return String(v).padStart(2, "0");
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export default function ExamCountdown({ startAt, durationMinutes, className = "" }: ExamCountdownProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const { label, tone } = useMemo(() => {
    if (!startAt) {
      return { label: "Exam schedule pending", tone: "text-ink-soft" };
    }

    const start = new Date(startAt).getTime();
    const end = start + durationMinutes * 60 * 1000;

    if (Number.isNaN(start)) {
      return { label: "Invalid schedule", tone: "text-alert" };
    }

    if (now >= end) {
      return { label: "Exam Closed", tone: "text-alert" };
    }

    if (now >= start) {
      return { label: "Exam Live Now!", tone: "text-success" };
    }

    const remaining = start - now;
    const mins = remaining / 60000;
    const tone = mins > 60 ? "text-success" : mins >= 15 ? "text-amber" : "text-alert";
    return { label: formatCountdown(remaining), tone };
  }, [durationMinutes, now, startAt]);

  return <span className={`font-mono text-[11px] ${tone} ${className}`}>{label}</span>;
}
