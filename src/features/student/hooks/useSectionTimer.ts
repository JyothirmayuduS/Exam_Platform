import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SectionWindow } from "@/shared/domain/exam";

type Opts = {
  /** Empty when section timing is off. */
  windows: SectionWindow[];
  active: boolean;
  /** localStorage key so a reload resumes the same section and time. */
  storageKey: string | null;
  onExpire: (index: number) => void;
};

type Saved = { sig: string; index: number; secondsLeft: number };

function format(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** One countdown per section. Sections only move forward. */
export default function useSectionTimer({ windows, active, storageKey, onExpire }: Opts) {
  const sig = useMemo(() => windows.map((w) => `${w.name}:${w.start}-${w.end}:${w.seconds}`).join("|"), [windows]);
  const [index, setIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const expiredRef = useRef(-1);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (!windows.length) return;
    let saved: Saved | null = null;
    try {
      saved = storageKey ? (JSON.parse(localStorage.getItem(storageKey) ?? "null") as Saved | null) : null;
    } catch {
      saved = null;
    }
    if (saved && saved.sig === sig && saved.index < windows.length) {
      setIndex(saved.index);
      setSecondsLeft(Math.max(0, saved.secondsLeft));
    } else {
      setIndex(0);
      setSecondsLeft(windows[0].seconds);
    }
    expiredRef.current = -1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, storageKey]);

  useEffect(() => {
    if (!active || !windows.length || secondsLeft <= 0) return;
    const id = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [active, windows.length, secondsLeft]);

  useEffect(() => {
    if (!storageKey || !windows.length) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ sig, index, secondsLeft } satisfies Saved));
    } catch {
      /* storage full or blocked: the timer still runs in memory */
    }
  }, [storageKey, sig, index, secondsLeft, windows.length]);

  useEffect(() => {
    if (!active || !windows.length || secondsLeft > 0 || expiredRef.current === index) return;
    expiredRef.current = index;
    onExpireRef.current(index);
  }, [active, windows.length, secondsLeft, index]);

  const advance = useCallback(() => {
    if (index + 1 >= windows.length) return false;
    setIndex(index + 1);
    setSecondsLeft(windows[index + 1].seconds);
    return true;
  }, [index, windows]);

  const current = windows[index];
  return {
    enabled: windows.length > 0,
    index,
    current,
    isLast: index >= windows.length - 1,
    secondsLeft,
    timeString: format(secondsLeft),
    advance,
    /** True when question `i` belongs to the section in progress. */
    inCurrent: (i: number) => !current || (i >= current.start && i < current.end),
  };
}
