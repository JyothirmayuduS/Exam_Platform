import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";

// ── Audio Level Meter ─────────────────────────────────────────────────────────
// Measures real-time microphone input level using Web Audio API.
// Returns: bars (0-8 level), recording state, sample blob, error string.

export type AudioTestState = "idle" | "testing" | "recording" | "done" | "error";

export function useAudioTest() {
  const [state, setState] = useState<AudioTestState>("idle");
  const [level, setLevel] = useState(0); // 0-1 RMS amplitude
  const [error, setError] = useState<string | null>(null);
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number>(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    setLevel(0);
  };

  const startTest = async () => {
    stop();
    setState("testing");
    setError(null);
    if (sampleUrl) {
      URL.revokeObjectURL(sampleUrl);
      setSampleUrl(null);
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Permission denied";
      setError(msg.includes("denied") || msg.includes("Permission") ? "Microphone permission was denied. Please allow it in your browser settings." : msg);
      setState("error");
    }
  };

  const startRecording = () => {
    if (!streamRef.current) return;
    chunksRef.current = [];
    let mimeType = "";
    if (typeof MediaRecorder.isTypeSupported === "function") {
      mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(t => MediaRecorder.isTypeSupported(t)) || "";
    }
    const rec = mimeType ? new MediaRecorder(streamRef.current, { mimeType }) : new MediaRecorder(streamRef.current);
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const type = chunksRef.current[0]?.type || rec.mimeType || mimeType || "audio/mp4";
      const blob = new Blob(chunksRef.current, { type });
      if (sampleUrl) URL.revokeObjectURL(sampleUrl);
      setSampleUrl(URL.createObjectURL(blob));
      setState("done");
    };
    rec.start();
    recorderRef.current = rec;
    setState("recording");
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    stop();
  };

  useEffect(() => {
    return () => {
      stop();
      if (sampleUrl) URL.revokeObjectURL(sampleUrl);
    };
  }, [sampleUrl]);

  return { state, level, error, sampleUrl, startTest, startRecording, stopRecording };
}

// ── Audio Level Bars component ────────────────────────────────────────────────
export function AudioBars({ level }: { level: number }) {
  const bars = 8;
  const filled = Math.round(level * bars);
  return (
    <div className="flex items-end gap-0.5 h-8">
      {Array.from({ length: bars }, (_, i) => {
        const active = i < filled;
        const color = i < 5 ? "bg-success" : i < 7 ? "bg-amber" : "bg-alert";
        const height = `${((i + 1) / bars) * 100}%`;
        return (
          <div
            key={i}
            className={`flex-1 transition-all duration-75 ${active ? color : "bg-line"}`}
            style={{ height }}
          />
        );
      })}
    </div>
  );
}

// ── Device Detection utilities ────────────────────────────────────────────────

export type DeviceRisk = { label: string; detected: boolean; severity: "warn" | "block" | "info" };

export async function runDeviceDetection(): Promise<DeviceRisk[]> {
  const results: DeviceRisk[] = [];

  // 1. Virtual webcam detection
  if (navigator.mediaDevices?.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === "videoinput");
      const virtualKeywords = ["obs", "virtual", "snap camera", "epoccam", "camtwist", "iriun", "droidcam", "e2esoftware"];
      const foundVirtual = videoDevices.some((d) =>
        virtualKeywords.some((kw) => d.label.toLowerCase().includes(kw))
      );
      results.push({ label: "Virtual webcam", detected: foundVirtual, severity: "block" });

      // Dual monitor detection (more than one video source that's a screen)
      const screenSources = devices.filter((d) => d.kind === "videoinput" && d.label.toLowerCase().includes("screen"));
      results.push({ label: "Dual/external monitor", detected: screenSources.length > 0, severity: "warn" });
    } catch {
      results.push({ label: "Virtual webcam", detected: false, severity: "block" });
    }
  }

  // 2. Virtual machine detection (heuristic: low GPU, touch=0, no battery)
  const isVM = (() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
    if (!gl) return true; // No WebGL = likely VM
    const renderer = gl.getParameter(gl.RENDERER) as string;
    const virtualRenderers = ["swiftshader", "llvmpipe", "virtualbox", "vmware", "softpipe", "microsoft basic"];
    return virtualRenderers.some((v) => renderer.toLowerCase().includes(v));
  })();
  results.push({ label: "Virtual machine", detected: isVM, severity: "warn" });

  // 3. VPN / Proxy detection (checks if RTCPeerConnection leaks a LAN IP)
  let vpnDetected = false;
  try {
    await new Promise<void>((resolve) => {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("");
      pc.createOffer().then((o) => pc.setLocalDescription(o));
      pc.onicecandidate = (e) => {
        if (!e.candidate) { resolve(); return; }
        const ip = /(\d+\.\d+\.\d+\.\d+)/.exec(e.candidate.candidate)?.[1];
        if (ip && (ip.startsWith("10.") || ip.startsWith("172.") || ip.startsWith("192.168."))) {
          // Internal IP suggests NAT / VPN tunnel
          vpnDetected = true;
        }
        pc.close();
        resolve();
      };
      setTimeout(resolve, 1500);
    });
  } catch { /* ignore */ }
  results.push({ label: "VPN / proxy detected", detected: vpnDetected, severity: "info" });

  return results;
}

// ── Screen Share Preview ──────────────────────────────────────────────────────

// Extended state machine for screen sharing:
// idle        — not started
// requesting  — set_window_sharing sent, awaiting getDisplayMedia
// active      — live stream running, real video track confirmed
// cancelled   — user dismissed the native picker without selecting
// denied      — OS system permission denied (TCC)
// error       — unexpected error (no API, stream ended immediately, etc.)
// unsupported — getDisplayMedia API not present
export type ScreenShareState = "idle" | "requesting" | "active" | "cancelled" | "denied" | "error" | "unsupported";

export function useScreenShareTest() {
  const [state, setState] = useState<ScreenShareState>("idle");
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const start = async (): Promise<MediaStream | null> => {
    console.log("[SCREEN] Test button clicked");
    setError(null);
    setState("requesting");

    const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c?: unknown) => Promise<MediaStream> };

    // Check API availability first — no point trying if the browser/webview
    // simply does not expose getDisplayMedia at all.
    console.log("[SCREEN] getDisplayMedia available =", typeof md.getDisplayMedia === "function");
    if (typeof md.getDisplayMedia !== "function") {
      setError("Screen sharing is not available in this WebView configuration.");
      setState("unsupported");
      return null;
    }

    // ── Lift NSWindowSharingNone BEFORE calling getDisplayMedia ───────────────
    // The exam window is marked NSWindowSharingNone at startup so it is
    // excluded from OS screen-capture APIs (Cmd+Shift+3 shows desktop behind
    // the exam window). That same flag blocks WKWebView's own getDisplayMedia
    // picker on macOS — the picker cannot list or capture a window that is
    // excluded from capture APIs. We must lift it BEFORE the picker appears,
    // then re-lock it AFTER the stream is acquired (or on failure).
    //
    // We fire-and-don't-await set_window_sharing so the invoke promise does not
    // break the user-gesture association in WebKit. The 80 ms pause gives the
    // Rust command time to complete before getDisplayMedia is called.
    if (isTauri()) {
      console.log("[SCREEN] Lifting NSWindowSharingNone to allow picker");
      // Await the command so we KNOW the window level has been lowered and
      // NSWindowSharingReadOnly is set before calling getDisplayMedia.
      // getDisplayMedia in WKWebView does not have the strict same-microtask
      // gesture requirement that getUserMedia has, so awaiting here is safe.
      await invoke("set_window_sharing", { allow: true }).catch(() => {});
      // Extra tick: give the RunLoop time to process the NSWindow level change
      // before WebKit internally tries to enumerate capture sources.
      await new Promise<void>((r) => setTimeout(r, 200));
    }

    console.log("[SCREEN] Starting display capture request");

    let stream: MediaStream | null = null;
    try {
      stream = await md.getDisplayMedia({ video: true, audio: false });
      console.log("[SCREEN] Capture stream received");
    } catch (captureErr) {
      // Re-lock the window immediately on failure.
      if (isTauri()) void invoke("set_window_sharing", { allow: false }).catch(() => {});

      const name = captureErr instanceof Error ? captureErr.name : "unknown";
      const msg  = captureErr instanceof Error ? captureErr.message : String(captureErr);
      console.log("[SCREEN] Capture error name =", name);
      console.log("[SCREEN] Capture error message =", msg);

      // NotAllowedError: user dismissed the picker OR the OS denied TCC.
      // We distinguish them: if the error message mentions "permission" or
      // "denied" the OS blocked it; otherwise the user cancelled.
      if (name === "NotAllowedError") {
        const isSystemDenied =
          msg.toLowerCase().includes("permission") ||
          msg.toLowerCase().includes("denied") ||
          msg.toLowerCase().includes("not allowed");
        if (isSystemDenied) {
          setError(
            "Screen recording permission is denied. " +
            "Open System Settings → Privacy & Security → " +
            "Screen & System Audio Recording and enable Vignan Exam Browser, " +
            "then click Test Screen Sharing again."
          );
          setState("denied");
        } else {
          // User clicked Cancel / closed the picker without selecting.
          setError(null);
          setState("cancelled");
        }
      } else if (name === "AbortError") {
        setError(null);
        setState("cancelled");
      } else {
        setError(`Screen sharing failed: ${msg}`);
        setState("error");
      }
      return null;
    }

    // Re-lock the window now that we have the stream descriptor.
    if (isTauri()) void invoke("set_window_sharing", { allow: false }).catch(() => {});

    // ── Verify we have a real, live video track ───────────────────────────────
    const tracks = stream.getVideoTracks();
    console.log("[SCREEN] Video tracks =", tracks.length);
    console.log("[SCREEN] Video track state =", tracks[0]?.readyState ?? "n/a");

    if (tracks.length === 0 || tracks[0].readyState !== "live") {
      stream.getTracks().forEach((t) => t.stop());
      setError("No live video track was produced by screen sharing.");
      setState("error");
      return null;
    }

    // ── Success path ──────────────────────────────────────────────────────────
    streamRef.current = stream;
    if (videoRef.current) videoRef.current.srcObject = stream;
    // If the user stops sharing from the OS toolbar, update state accordingly.
    tracks[0].addEventListener("ended", stop);
    setState("active");
    return stream;
  };

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState("idle");
  };

  useEffect(() => () => stop(), []);

  return { state, error, videoRef, start, stop };
}
