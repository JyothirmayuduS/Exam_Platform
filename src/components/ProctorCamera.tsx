import { useEffect, useRef, useState } from "react";
import { startProctorPublishing, type ProctorHandle, type ProctorState } from "../lib/proctor";
import { env } from "../lib/env";
import { startFrameCapture, type FrameCaptureHandle } from "../lib/storage";

// Student self-view. Publishes to LiveKit when configured; otherwise shows a
// local camera preview so proctoring is visible even in the prototype.
// Renders inline (fills its container) — the exam page places it in a fixed
// right-hand rail so it never overlaps the question or the navigator.
//
// When `examId`/`studentId` are provided and VITE_PROCTOR_CAPTURE=true, a JPEG
// frame is captured from the preview every second and uploaded to R2 via the
// store-artifact edge function (degrades to a no-op without a backend).
export default function ProctorCamera({
  room,
  identity,
  examId,
  studentId,
  screenStream,
}: {
  room: string;
  identity: string;
  examId?: string;
  studentId?: string;
  screenStream?: MediaStream | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<ProctorState>("connecting");

  useEffect(() => {
    let handle: ProctorHandle | null = null;
    let localStream: MediaStream | null = null;
    let cancelled = false;

    (async () => {
      handle = await startProctorPublishing({ room, identity, screenStream, onState: setState });
      if (cancelled) { handle?.stop(); return; }
      if (!handle) {
        // Local-only fallback: attach the raw camera feed to the preview element.
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          if (cancelled) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; return; }
          if (videoRef.current) videoRef.current.srcObject = localStream;
          setState("local-only");
        } catch {
          if (!cancelled) setState("disconnected");
        }
      }
    })();

    return () => {
      cancelled = true;
      handle?.stop();
      localStream?.getTracks().forEach((t) => t.stop());
    };
  }, [room, identity]);

  // Per-second proctoring screenshot capture → R2 (opt-in, graceful no-op).
  useEffect(() => {
    if (!env.proctorCapture || !examId || !studentId) return;
    const video = videoRef.current;
    if (!video) return;
    let capture: FrameCaptureHandle | null = null;
    const start = () => {
      if (capture) return;
      capture = startFrameCapture({ video, examId, studentId, intervalMs: 1000 });
    };
    // Only begin once the camera is actually producing frames.
    video.addEventListener("playing", start);
    if (video.readyState >= 2 && !video.paused) start();
    return () => {
      video.removeEventListener("playing", start);
      capture?.stop();
    };
  }, [examId, studentId]);

  const dot = state === "connected" ? "bg-success" : state === "local-only" ? "bg-amber" : state === "disconnected" ? "bg-alert" : "bg-amber animate-pulse";
  const label = state === "connected" ? "Proctor live" : state === "local-only" ? "Camera on" : state === "reconnecting" ? "Reconnecting" : state === "disconnected" ? "Camera lost" : "Connecting";

  return (
    <div className="overflow-hidden border border-line-strong bg-ink">
      <video ref={videoRef} autoPlay playsInline muted className="aspect-[4/3] w-full bg-black object-cover" />
      <div className="flex items-center gap-2 border-t border-white/10 px-2.5 py-2">
        <span className={`h-1.5 w-1.5 ${dot}`} />
        <span className="font-mono text-[9px] uppercase tracking-wider text-paper">{label}</span>
      </div>
    </div>
  );
}
