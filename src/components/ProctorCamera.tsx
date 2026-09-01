import { useCallback, useEffect, useRef, useState } from "react";
import { startProctorPublishing, type ProctorHandle, type ProctorState } from "../lib/proctor";
import { env } from "../lib/env";
import { startFrameCapture, type FrameCaptureHandle } from "../lib/storage";

export default function ProctorCamera({
  room,
  identity,
  examId,
  studentId,
  screenStream,
  violationActive = false,
  proctorMessages = [],
}: {
  room: string;
  identity: string;
  examId?: string;
  studentId?: string;
  screenStream?: MediaStream | null;
  violationActive?: boolean;
  proctorMessages?: string[];
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<ProctorState>("connecting");
  const [retryCount, setRetryCount] = useState(0);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const handleRef = useRef<ProctorHandle | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<FrameCaptureHandle | null>(null);

  const connect = useCallback(async () => {
    // Clean up any prior session
    handleRef.current?.stop();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;

    setState("connecting");

    const handle = await startProctorPublishing({ room, identity, screenStream, onState: setState });
    handleRef.current = handle;

    if (!handle) {
      // Local-only fallback
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        localStreamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setState("local-only");
      } catch {
        setState("disconnected");
      }
    }
  }, [room, identity, screenStream]);

  // Initial connect
  useEffect(() => {
    let cancelled = false;
    void connect().catch(() => { if (!cancelled) setState("disconnected"); });
    return () => {
      cancelled = true;
      handleRef.current?.stop();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      captureRef.current?.stop();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, identity]);

  // Auto-reconnect when camera dies
  useEffect(() => {
    if (state !== "disconnected") return;
    const delay = Math.min(2000 * (retryCount + 1), 10000); // 2s, 4s, 6s… max 10s
    const id = setTimeout(() => {
      setRetryCount((c) => c + 1);
      void connect();
    }, delay);
    return () => clearTimeout(id);
  }, [state, retryCount, connect]);

  // Per-second proctoring screenshot capture
  useEffect(() => {
    if (!env.proctorCapture || !examId || !studentId) return;
    const video = videoRef.current;
    if (!video) return;
    const start = () => {
      if (captureRef.current) return;
      captureRef.current = startFrameCapture({ video, examId, studentId, intervalMs: 1000 });
    };
    video.addEventListener("playing", start);
    if (video.readyState >= 2 && !video.paused) start();
    return () => { video.removeEventListener("playing", start); captureRef.current?.stop(); };
  }, [examId, studentId]);

  // Show new proctor messages as a toast
  useEffect(() => {
    if (proctorMessages.length === 0) return;
    const latest = proctorMessages[proctorMessages.length - 1];
    setLastMessage(latest ?? null);
    const id = setTimeout(() => setLastMessage(null), 5000);
    return () => clearTimeout(id);
  }, [proctorMessages]);

  const dot =
    state === "connected" ? "bg-success" :
    state === "local-only" ? "bg-amber" :
    state === "disconnected" ? "bg-alert" :
    "bg-amber animate-pulse";

  const label =
    state === "connected" ? "Proctor live" :
    state === "local-only" ? "Camera on" :
    state === "reconnecting" ? `Reconnecting (${retryCount})…` :
    state === "disconnected" ? "Camera lost" :
    "Connecting…";

  return (
    <div className="space-y-2">
      {/* Camera feed */}
      <div className={`relative overflow-hidden border bg-ink transition-all ${violationActive ? "border-alert shadow-[0_0_12px_rgba(var(--color-alert),0.5)]" : "border-line-strong"}`}>
        <video ref={videoRef} autoPlay playsInline muted className="aspect-[4/3] w-full bg-black object-cover" />

        {/* Violation overlay */}
        {violationActive && (
          <div className="absolute inset-0 border-4 border-alert/80 pointer-events-none">
            <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-alert/90 px-2 py-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-paper" />
              <span className="font-mono text-[9px] uppercase tracking-wider text-paper">Violation flagged</span>
            </div>
          </div>
        )}

        {/* Camera lost overlay */}
        {state === "disconnected" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-ink/90">
            <p className="font-mono text-[10px] text-paper/70">Camera disconnected</p>
            <button
              onClick={() => { setRetryCount(0); void connect(); }}
              className="mt-2 border border-white/20 px-3 py-1.5 font-mono text-[9px] uppercase tracking-wider text-paper/80 hover:bg-white/10"
            >
              Reconnect →
            </button>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-2 px-0.5">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="font-mono text-[9px] uppercase tracking-wider text-ink-soft flex-1">{label}</span>
        {state === "disconnected" && retryCount > 0 && (
          <span className="font-mono text-[9px] text-alert">Retrying…</span>
        )}
      </div>

      {/* Proctor message notification */}
      {lastMessage && (
        <div className="border border-amber/50 bg-amber/10 px-3 py-2 text-[12px]">
          <p className="font-mono text-[9px] uppercase tracking-widest text-amber mb-0.5">Proctor message</p>
          <p>{lastMessage}</p>
        </div>
      )}
    </div>
  );
}
