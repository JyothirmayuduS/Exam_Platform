import { useCallback, useEffect, useRef, useState } from "react";

export type SaveStatus = "idle" | "saving" | "saved" | "failed" | "local";

type UseAutosaveOpts = {
  enabled: boolean;
  payload: unknown;
  onSave: () => Promise<boolean>;
  /** Periodic save; a failed save is retried on this timer until it lands. */
  intervalMs?: number;
};

export default function useAutosave({
  enabled,
  payload,
  onSave,
  intervalMs = 10000,
}: UseAutosaveOpts) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  /** Consecutive failed saves; 0 after any success. */
  const [failures, setFailures] = useState(0);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  // onSave closes over the countdown and changes every second; reading it
  // through a ref keeps `persist` stable so the retry interval is not reset.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const persist = useCallback(async () => {
    if (!enabled || inFlight.current || !dirty.current) return false;
    inFlight.current = true;
    setStatus("saving");

    try {
      const ok = await onSaveRef.current();
      if (ok) {
        dirty.current = false;
        setStatus("saved");
        setFailures(0);
        setLastSavedAt(new Date().toLocaleTimeString());
      } else {
        setStatus(navigator.onLine ? "failed" : "local");
        setFailures((n) => n + 1);
      }
      return ok;
    } catch {
      setStatus(navigator.onLine ? "failed" : "local");
      setFailures((n) => n + 1);
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    dirty.current = true;
    const id = window.setTimeout(() => {
      void persist();
    }, 1200);
    return () => window.clearTimeout(id);
  }, [enabled, payload, persist]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      void persist();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs, persist]);

  useEffect(() => {
    if (!enabled) return;
    const onOnline = () => void persist();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [enabled, persist]);

  return {
    status,
    lastSavedAt,
    failures,
    saveNow: persist,
  };
}
