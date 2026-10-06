import { useCallback, useEffect, useRef, useState } from "react";

export type SaveStatus = "idle" | "saving" | "saved" | "failed" | "local";

type UseAutosaveOpts = {
  enabled: boolean;
  payload: unknown;
  onSave: () => Promise<boolean>;
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
  const inFlight = useRef(false);
  const dirty = useRef(false);

  const persist = useCallback(async () => {
    if (!enabled || inFlight.current || !dirty.current) return false;
    inFlight.current = true;
    setStatus("saving");

    try {
      const ok = await onSave();
      setStatus(ok ? "saved" : "failed");
      if (ok) {
        dirty.current = false;
        setLastSavedAt(new Date().toLocaleTimeString());
      }
      if (!ok && !navigator.onLine) {
        setStatus("local");
      }
      return ok;
    } catch {
      setStatus(navigator.onLine ? "failed" : "local");
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [enabled, onSave]);

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

  return {
    status,
    lastSavedAt,
    saveNow: persist,
  };
}
