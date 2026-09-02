import { useCallback, useEffect, useRef, useState } from "react";
import { startProctorPublishing, type ProctorHandle, type ProctorState } from "../lib/proctor";
import { env } from "../lib/env";
import { startFrameCapture, type FrameCaptureHandle } from "../lib/storage";
import { startVideoRecording, type RecorderHandle } from "../lib/recorder";

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
  const cameraRecordRef = useRef<RecorderHandle | null>(null);
  const screenRecordRef = useRef<RecorderHandle | null>(null);

  // Issue #10: track when a violation started so we can auto-clear a stale
  // red border if the parent never sends violationActive=false (state drift).
  const violationSinceRef = useRef<number | null>(null);
  const [violationElapsedSec, setViolationElapsedSec] = useState(0);
  const [internalViolationActive, setInternalViolationActive] = useState(false);
  const VIOLATION_AUTO_CLEAR_MS = 5 * 60 * 1_000; // 5 minutes

  // Keep a stable ref to the latest `connect` so the cleanup effect
  // always calls the most-recent version without being a dependency itself.
  const connectRef = useRef(async () => {});
  const connect = useCallback(async () => {
    // Clean up any prior session before attempting a new one.
    handleRef.current?.stop();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;

    setState("connecting");

    // ── Attempt LiveKit / proctor server connection ────────────────────────
    // Wrap in try-catch so ANY failure (auth, network, timeout, bad room ID)
    // is caught and handled gracefully instead of propagating as an unhandled
    // promise rejection that leaves the component in an undefined state.
    let handle: Awaited<ReturnType<typeof startProctorPublishing>> = null;
    try {
      // Race the connect against a 15-second timeout so we never wait forever
      // on a hung LiveKit server (e.g., during maintenance).
      const CONNECT_TIMEOUT_MS = 15_000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Proctor connection timed out after 15s")), CONNECT_TIMEOUT_MS)
      );
      handle = await Promise.race([
        startProctorPublishing({ room, identity, screenStream, onState: setState }),
        timeoutPromise,
      ]);
    } catch (err) {
      // Classify the error so the logs are actionable.
      const message = err instanceof Error ? err.message : String(err);
      const isAuth    = message.toLowerCase().includes("auth") || message.toLowerCase().includes("permission");
      const isTimeout = message.toLowerCase().includes("timed out");
      const category  = isAuth ? "auth" : isTimeout ? "timeout" : "network";

      console.error(`[ProctorCamera] startProctorPublishing failed (${category}):`, err);

      // Report to Sentry if available (non-blocking).
      try {
        const S = await import("@sentry/react").catch(() => null);
        S?.captureException(err, { tags: { proctorCategory: category, room, identity } });
      } catch { /* sentry unavailable — ignore */ }

      // Fall back to local-only camera so the exam can still proceed and the
      // component is in a known, valid state rather than limbo.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        localStreamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setState("local-only");
        console.warn("[ProctorCamera] falling back to local-only camera after proctor failure");
      } catch (camErr) {
        console.error("[ProctorCamera] local camera fallback also failed:", camErr);
        setState("disconnected");
      }
      return; // done — skip the handle assignment below
    }

    handleRef.current = handle;

    // If the server returned null (feature disabled / not configured) rather
    // than throwing, still fall back to local camera gracefully.
    if (!handle) {
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


  // Always keep the ref current so effects can call the latest version.
  useEffect(() => { connectRef.current = connect; }, [connect]);

  // Initial connect: runs only when room/identity change (correct). Calls
  // connectRef.current() so it always uses the latest closure — no stale capture.
  useEffect(() => {
    let cancelled = false;
    void connectRef.current().catch(() => { if (!cancelled) setState("disconnected"); });
    return () => {
      cancelled = true;
      handleRef.current?.stop();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      captureRef.current?.stop();
      cameraRecordRef.current?.stop();
      screenRecordRef.current?.stop();
      // Null out refs so GC can collect the streams immediately.
      localStreamRef.current = null;
      captureRef.current = null;
      cameraRecordRef.current = null;
      screenRecordRef.current = null;
    };
  }, [room, identity]); // ✅ No eslint-disable needed — connectRef is stable

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

  // Per-second proctoring screenshot capture & Video Recording
  useEffect(() => {
    if (!env.proctorCapture || !examId || !studentId) return;
    const video = videoRef.current;
    if (!video) return;

    let unmounted = false;
    // Atomic guard: prevents a second rapid `playing` event from starting a
    // duplicate recorder before the refs have been assigned from the first call.
    let starting = false;

    const start = () => {
      if (starting || captureRef.current) return;
      starting = true; // lock immediately — synchronous, so safe before any await

      try {
        captureRef.current = startFrameCapture({ video, examId, studentId, intervalMs: 1000 });
        console.debug("[ProctorCamera] frame capture started", { examId, studentId });
      } catch (err) {
        console.error("[ProctorCamera] frame capture failed to start", err);
      }

      // Camera recording — guarded independently so a screen-share failure
      // doesn't prevent camera recording from starting.
      if (!cameraRecordRef.current && video.srcObject instanceof MediaStream) {
        try {
          cameraRecordRef.current = startVideoRecording({
            stream: video.srcObject,
            examId,
            studentId,
            kind: "camera",
          });
          console.debug("[ProctorCamera] camera recording started");
        } catch (err) {
          console.error("[ProctorCamera] camera recording failed to start", err);
        }
      }

      if (!screenRecordRef.current && screenStream) {
        try {
          screenRecordRef.current = startVideoRecording({
            stream: screenStream,
            examId,
            studentId,
            kind: "screen",
          });
          console.debug("[ProctorCamera] screen recording started");
        } catch (err) {
          console.error("[ProctorCamera] screen recording failed to start", err);
        }
      }

      // If the component unmounted while we were in start(), tear everything
      // down immediately so streams aren't orphaned.
      if (unmounted) {
        captureRef.current?.stop(); captureRef.current = null;
        cameraRecordRef.current?.stop(); cameraRecordRef.current = null;
        screenRecordRef.current?.stop(); screenRecordRef.current = null;
        console.debug("[ProctorCamera] unmounted during start — streams released");
      }

      starting = false; // release lock
    };

    video.addEventListener("playing", start);
    if (video.readyState >= 2 && !video.paused) start();

    return () => {
      unmounted = true;
      video.removeEventListener("playing", start);
      captureRef.current?.stop();
      cameraRecordRef.current?.stop();
      screenRecordRef.current?.stop();
      captureRef.current = null;
      cameraRecordRef.current = null;
      screenRecordRef.current = null;
      console.debug("[ProctorCamera] recording cleanup — streams released", { examId, studentId });

    };
  }, [examId, studentId, screenStream]);

  // Issue #10: sync internal violation state and track elapsed time.
  // Auto-clear after 5 minutes if the parent never sends violationActive=false.
  useEffect(() => {
    if (violationActive) {
      violationSinceRef.current = Date.now();
      setInternalViolationActive(true);
      setViolationElapsedSec(0);
    } else {
      violationSinceRef.current = null;
      setInternalViolationActive(false);
      setViolationElapsedSec(0);
    }
  }, [violationActive]);

  useEffect(() => {
    if (!internalViolationActive) return;
    const tick = setInterval(() => {
      const elapsed = violationSinceRef.current
        ? Math.floor((Date.now() - violationSinceRef.current) / 1000)
        : 0;
      setViolationElapsedSec(elapsed);
      // Auto-clear if stuck for too long (parent state drift guard)
      if (elapsed * 1000 >= VIOLATION_AUTO_CLEAR_MS) {
        console.warn("[ProctorCamera] violation auto-cleared after 5 min (parent may have dropped update)");
        violationSinceRef.current = null;
        setInternalViolationActive(false);
        setViolationElapsedSec(0);
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [internalViolationActive, VIOLATION_AUTO_CLEAR_MS]);

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
      <div className={`relative overflow-hidden border bg-ink transition-all ${internalViolationActive ? "border-alert shadow-[0_0_12px_rgba(var(--color-alert),0.5)]" : "border-line-strong"}`}>
        <video ref={videoRef} autoPlay playsInline muted className="aspect-[4/3] w-full bg-black object-cover" />

        {/* Violation overlay — uses internal state with 5-min auto-clear */}
        {internalViolationActive && (
          <div className="absolute inset-0 border-4 border-alert/80 pointer-events-none">
            <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-alert/90 px-2 py-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-paper" />
              <span className="font-mono text-[9px] uppercase tracking-wider text-paper">Violation flagged</span>
              {violationElapsedSec > 0 && (
                <span className="font-mono text-[9px] text-paper/70 ml-1">
                  {violationElapsedSec}s
                </span>
              )}
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
