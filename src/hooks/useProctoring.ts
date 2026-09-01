import { useCallback, useEffect, useRef, useState } from "react";
import type { AIViolation } from "../components/ProctorAI";

export type Violation = { id: number; kind: string; at: string };

export default function useProctoring(active: boolean) {
  const [violations, setViolations] = useState<Violation[]>([]);
  const [activeViolation, setActiveViolation] = useState<Violation | null>(null);
  const violationId = useRef(0);

  const flag = useCallback((kind: string) => {
    const v: Violation = {
      id: (violationId.current += 1),
      kind,
      at: new Date().toLocaleTimeString(),
    };
    setViolations((list) => [...list, v]);
    setActiveViolation(v);
  }, []);

  const handleAIViolation = useCallback((v: AIViolation) => {
    flag(`[AI] ${v.label}`);
  }, [flag]);

  useEffect(() => {
    if (!active) return;

    const onVisibility = () => {
      if (document.hidden) flag("Tab / window switched away");
    };
    const onBlur = () => flag("Exam window lost focus");
    const onFullscreen = () => {
      if (!document.fullscreenElement) flag("Exited full-screen mode");
    };
    const onOffline = () => flag("Network Disconnected / Offline");

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("offline", onOffline);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onFullscreen);
      window.removeEventListener("offline", onOffline);
    };
  }, [active, flag]);

  useEffect(() => {
    if (!activeViolation) return;
    const id = window.setTimeout(() => setActiveViolation(null), 5000);
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
