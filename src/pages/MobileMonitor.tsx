import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Room, RoomEvent, Track } from "livekit-client";
import {
  validateMonitorToken,
  sendMonitorHeartbeat,
  sendMonitorEvent,
  sendMonitorSnapshotData,
  endMonitorSession,
  type MonitorPhase,
} from "../lib/monitorSession";

/**
 * MobileMonitor — the student's phone page for the secondary proctoring feed.
 *
 * Flow: validate one-time token → camera permission (rear lens) → publish the
 * live desk feed into the exam's LiveKit room → run interruption signals
 * (visibility, focus, viewport, WebRTC state, heartbeat) → snapshot fallback
 * when WebRTC fails. Minimal DOM + no heavy deps: this runs on personal phones.
 */

const HEARTBEAT_MS = 2_000; // spec: ping every 2 s
const SNAPSHOT_MS = 25_000; // fallback evidence cadence (15–30 s window)

export default function MobileMonitor() {
  const { token = "" } = useParams();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<MonitorPhase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [snapshotMode, setSnapshotMode] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const roomRef = useRef<InstanceType<typeof Room> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const camTrackRef = useRef<MediaStreamTrack | null>(null);
  const publishRef = useRef<MediaStreamTrack | null>(null);
  const hbTimer = useRef<number | null>(null);
  const snapTimer = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Snapshot-grab canvas, created lazily (memory-friendly on phones).
  const ensureCanvas = () => {
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    return canvasRef.current;
  };

  // ── token validation ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await validateMonitorToken(token);
        if (cancelled) return;
        setPhase("connected");
        setInfo(`Exam room ready — ${s.livekitRoom}`);
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : "Invalid or expired monitor token");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ── camera start (user gesture, rear lens preferred) ────────────────
  const startCamera = async () => {
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      camTrackRef.current = track;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCameraOn(true);
      void sendMonitorEvent(token, { type: "CAMERA_STARTED" });
      void connectAndPublish();
    } catch (err) {
      void sendMonitorEvent(token, { type: "CAMERA_PERMISSION_DENIED" });
      setErrorMsg(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Camera permission denied. Monitoring requires the camera."
          : "No camera available on this device.",
      );
    }
  };

  // ── LiveKit connect + publish ───────────────────────────────────────
  const connectAndPublish = async () => {
    setPhase("publishing");
    try {
      // Mint the LiveKit token through the edge function's mobile branch.
      const db = (await import("../lib/supabase")).getSupabase();
      if (!db) throw new Error("Supabase not configured");
      const { data, error } = await db.functions.invoke("livekit-token", { body: { mobileToken: token } });
      if (error || !data?.token) throw new Error((error?.message as string) || "LiveKit token mint failed");

      const room = new Room({ adaptiveStream: false, dynacast: true });
      roomRef.current = room;
      room
        .on(RoomEvent.Connected, () => {
          setPhase("live");
          void sendMonitorEvent(token, { type: "LIVEKIT_CONNECTED" });
        })
        .on(RoomEvent.Disconnected, () => {
          setPhase("degraded");
          void sendMonitorEvent(token, { type: "LIVEKIT_DISCONNECTED" });
          startSnapshotFallback();
        })
        .on(RoomEvent.Reconnecting, () => setPhase("publishing"))
        .on(RoomEvent.Reconnected, () => {
          setPhase("live");
          stopSnapshotFallback();
        });

      await room.connect(data.url as string, data.token as string);

      if (camTrackRef.current) {
        const clone = camTrackRef.current.clone();
        publishRef.current = clone;
        await room.localParticipant.publishTrack(clone, {
          source: Track.Source.Camera,
          name: "phone-desk",
        });
      }
    } catch (err) {
      console.warn("[mobile-monitor] LiveKit unavailable, falling back to snapshots:", err);
      setPhase("degraded");
      void sendMonitorEvent(token, { type: "LIVEKIT_DISCONNECTED", metadata: { reason: "connect_failed" } });
      startSnapshotFallback();
    }
  };

  // ── snapshot fallback (evidence never goes dark) ────────────────────
  const startSnapshotFallback = () => {
    if (snapTimer.current) return;
    setSnapshotMode(true);
    snapTimer.current = window.setInterval(async () => {
      const track = camTrackRef.current;
      if (!track || track.readyState !== "live") return;
      const video = document.createElement("video");
      video.srcObject = new MediaStream([track]);
      try {
        await video.play();
        const canvas = ensureCanvas();
        canvas.width = 960;
        canvas.height = Math.round((960 * (video.videoHeight || 720)) / (video.videoWidth || 1280));
        canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
        await sendMonitorSnapshotData(token, dataUrl);
      } catch {
        /* best-effort */
      } finally {
        video.srcObject = null;
      }
    }, SNAPSHOT_MS);
  };

  const stopSnapshotFallback = () => {
    if (snapTimer.current) {
      window.clearInterval(snapTimer.current);
      snapTimer.current = null;
    }
    setSnapshotMode(false);
  };

  // ── interruption signals ────────────────────────────────────────────
  useEffect(() => {
    if (!cameraOn) return;

    // 1. visibilitychange
    const onVis = () => {
      void sendMonitorEvent(token, {
        type: document.hidden ? "VISIBILITY_HIDDEN" : "VISIBILITY_VISIBLE",
      });
    };
    // 2. focus polling (catches split-screen/popups where the tab stays visible)
    const focusTimer = window.setInterval(() => {
      void sendMonitorEvent(token, { type: document.hasFocus() ? "FOCUS_REGAINED" : "FOCUS_LOST" });
    }, HEARTBEAT_MS);
    // 3. viewport shrink (split-screen / floating window)
    let lastW = window.innerWidth;
    let lastH = window.innerHeight;
    const onResize = () => {
      const shrunk = window.innerWidth < lastW * 0.6 || window.innerHeight < lastH * 0.6;
      if (shrunk) {
        void sendMonitorEvent(token, { type: "VIEWPORT_RESIZED", metadata: { from: [lastW, lastH], to: [window.innerWidth, window.innerHeight] } });
      }
      lastW = window.innerWidth;
      lastH = window.innerHeight;
    };
    // 4. track ended → connection killed
    const onTrackEnd = () => {
      void sendMonitorEvent(token, { type: "CAMERA_STOPPED" });
      setPhase("degraded");
    };
    camTrackRef.current?.addEventListener("ended", onTrackEnd);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("resize", onResize);

    // 5. heartbeat every 2 s — server detects staleness
    hbTimer.current = window.setInterval(() => {
      void sendMonitorHeartbeat(token).catch(() => undefined);
    }, HEARTBEAT_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", onResize);
      camTrackRef.current?.removeEventListener("ended", onTrackEnd);
      if (focusTimer) window.clearInterval(focusTimer);
      if (hbTimer.current) window.clearInterval(hbTimer.current);
    };
  }, [cameraOn, token]);

  // ── teardown on unmount / end ───────────────────────────────────────
  const teardown = () => {
    if (hbTimer.current) window.clearInterval(hbTimer.current);
    if (snapTimer.current) window.clearInterval(snapTimer.current);
    camTrackRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void roomRef.current?.disconnect();
    streamRef.current = null;
    camTrackRef.current = null;
    publishRef.current = null;
    roomRef.current = null;
  };

  useEffect(() => () => teardown(), []);

  const endSession = async () => {
    void sendMonitorEvent(token, { type: "SESSION_ENDED" });
    void endMonitorSession(token, "student_ended");
    teardown();
    setPhase("ended");
  };

  // ── UI (matches the platform design system: mono/ink/paper, zero radius) ──
  if (errorMsg) {
    return (
      <div className="min-h-screen bg-paper px-6 py-16 text-center">
        <h1 className="font-mono text-[13px] uppercase tracking-widest text-alert font-bold">Monitor session invalid</h1>
        <p className="mx-auto mt-4 max-w-sm text-[14px] text-soft">{errorMsg}</p>
        <p className="mt-6 font-mono text-[10px] uppercase tracking-widest text-soft">Return to your laptop and generate a fresh QR code</p>
      </div>
    );
  }

  if (phase === "ended") {
    return (
      <div className="min-h-screen bg-paper px-6 py-16 text-center">
        <p className="text-5xl">✓</p>
        <h1 className="mt-4 font-mono text-[13px] uppercase tracking-widest text-success font-bold">Monitoring complete</h1>
        <p className="mx-auto mt-3 max-w-sm text-[14px] text-soft">You can return to your laptop exam now. The phone feed has been disconnected.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-line px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-soft">CDOE ExamShield — Secondary Monitor</p>
        <p className="mt-0.5 font-mono text-[12px] font-bold uppercase tracking-wider text-ink">Desk &amp; hands feed</p>
      </header>

      <main className="mx-auto max-w-md space-y-5 px-4 py-6">
        {!cameraOn ? (
          <section className="space-y-4">
            <p className="font-serif text-[15px] text-ink">
              Your laptop has started a secondary monitoring session. Place the phone so the rear camera shows your desk and hands while you write.
            </p>
            <div className="border border-line bg-raised/40 p-4">
              <p className="font-mono text-[10px] uppercase tracking-wider text-soft">Instructions</p>
              <ol className="mt-2 space-y-1 text-[13px] text-ink">
                <li>1. Prop the phone at an angle facing your desk.</li>
                <li>2. Keep the phone plugged in if possible.</li>
                <li>3. Do not lock or leave the page.</li>
              </ol>
            </div>
            <button
              onClick={startCamera}
              className="w-full border border-maroon bg-maroon py-3 font-mono text-[12px] uppercase tracking-widest text-paper"
            >
              Start desk camera
            </button>
          </section>
        ) : (
          <>
            <div className="relative border border-line bg-ink">
              <video ref={videoRef} playsInline muted className="h-auto w-full" />
              {/* framing guide */}
              <div className="pointer-events-none absolute inset-4 border border-dashed border-paper/60" />
              <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center font-mono text-[10px] uppercase tracking-widest text-paper/80">
                Keep desk + writing hand in frame
              </p>
            </div>

            <div className="border border-line bg-raised/30 px-4 py-3 font-mono text-[10px] uppercase tracking-wider">
              <div className="flex items-center justify-between">
                <span className="text-soft">Feed</span>
                <span className={phase === "live" ? "text-success font-bold" : "text-amber font-bold"}>
                  {phase === "live" ? "LIVE ✓" : snapshotMode ? "SNAPSHOTS" : phase.toUpperCase()}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-soft">Mode</span>
                <span className="text-ink">{snapshotMode ? "Evidence snapshots (fallback)" : "Continuous video"}</span>
              </div>
              {info && (
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-soft">Room</span>
                  <span className="text-ink">{info}</span>
                </div>
              )}
            </div>

            <button onClick={endSession} className="w-full border border-line py-2.5 font-mono text-[11px] uppercase tracking-widest text-soft hover:bg-raised">
              End monitoring
            </button>
          </>
        )}
      </main>
    </div>
  );
}
