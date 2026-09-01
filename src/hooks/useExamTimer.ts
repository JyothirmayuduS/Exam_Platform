import { useEffect, useMemo, useRef, useState } from "react";

type UseExamTimerOpts = {
  durationMinutes: number;
  active: boolean;
  onTimeUp: () => void | Promise<void>;
};

function format(seconds: number): string {
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

export default function useExamTimer({ durationMinutes, active, onTimeUp }: UseExamTimerOpts) {
  const [secondsLeft, setSecondsLeft] = useState(durationMinutes * 60);
  const timedOutRef = useRef(false);

  useEffect(() => {
    setSecondsLeft(durationMinutes * 60);
    timedOutRef.current = false;
  }, [durationMinutes]);

  useEffect(() => {
    if (!active) return;
    if (secondsLeft <= 0) return;
    const id = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [active, secondsLeft]);

  useEffect(() => {
    if (!active || secondsLeft > 0 || timedOutRef.current) return;
    timedOutRef.current = true;
    void onTimeUp();
  }, [active, onTimeUp, secondsLeft]);

  const tone = useMemo(() => {
    if (secondsLeft <= 60) return "text-alert border-alert";
    if (secondsLeft <= 300) return "text-amber border-amber";
    return "text-success border-success";
  }, [secondsLeft]);

  const warning = useMemo(() => {
    if (secondsLeft <= 60) return "1 minute remaining";
    if (secondsLeft <= 300) return "5 minutes remaining";
    return null;
  }, [secondsLeft]);

  return {
    secondsLeft,
    setSecondsLeft,
    timeString: format(secondsLeft),
    tone,
    warning,
  };
}
