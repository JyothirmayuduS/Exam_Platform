import { useCallback, useEffect, useRef, useState } from "react";
import type { AIViolation } from "@/features/proctoring/components/ProctorAI";
import { saveViolation } from "@/shared/data/examApi";
import { onMinimizeAttempt } from "@/shared/platform/lockdownBridge";
import { aiFlagCountsTowardLimit } from "@/features/proctoring/domain/flagLimit";

/** `counts`: whether the flag counts toward the exam's auto-action limit. */
export type Violation = { id: number; kind: string; at: string; evidenceBlob?: Blob; counts: boolean };

export type FlagOptions = { counts?: boolean };

export default function useProctoring(active: boolean, attemptId?: string, examId?: string, studentId?: string) {
  const [violations, setViolations] = useState<Violation[]>([]);
  const [activeViolation, setActiveViolation] = useState<Violation | null>(null);
  const violationId = useRef(0);

  const flag = useCallback((kind: string, evidenceBlob?: Blob, opts: FlagOptions = {}) => {
    const v: Violation = {
      id: (violationId.current += 1),
      kind,
      at: new Date().toLocaleTimeString(),
      evidenceBlob,
      counts: opts.counts === true,
    };
    setViolations((list) => [...list, v]);
    setActiveViolation(v);
    
    // Save to database if we are in a real exam context
    if (attemptId && examId && studentId) {
      saveViolation(attemptId, examId, studentId, kind, kind).catch(console.error);
    }
  }, [attemptId, examId, studentId]);

  const handleAIViolation = useCallback((v: AIViolation) => {
    flag(`[AI] ${v.label}`, v.evidenceBlob, { counts: aiFlagCountsTowardLimit(v.type, v.confidence) });
  }, [flag]);

  useEffect(() => {
    if (!active) return;

    const onVisibility = () => {
      if (document.hidden) flag("Tab / window switched away", undefined, { counts: true });
    };
    const onBlur = () => flag("Exam window lost focus", undefined, { counts: true });
    const onFullscreen = () => {
      if (!document.fullscreenElement) flag("Exited full-screen mode", undefined, { counts: true });
    };
    const onOffline = () => flag("Network Disconnected / Offline");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("offline", onOffline);

    let disposed = false;
    let unlistenMinimize: (() => void) | undefined;
    void onMinimizeAttempt(() => flag("Tried to minimize the exam window", undefined, { counts: true })).then((un) => {
      if (disposed) un();
      else unlistenMinimize = un;
    });

    return () => {
      disposed = true;
      unlistenMinimize?.();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onFullscreen);
      window.removeEventListener("offline", onOffline);
    };
  }, [active, flag]);

  // BANNER_MS — how long the on-screen alert stays. Not a detection cooldown.
  const BANNER_MS = 5_000;
  useEffect(() => {
    if (!activeViolation) return;
    const id = window.setTimeout(() => setActiveViolation(null), BANNER_MS);
    return () => window.clearTimeout(id);
  }, [activeViolation]);

  return {
    violations,
    activeViolation,
    setActiveViolation,
    flag,
    handleAIViolation,
  };
}
