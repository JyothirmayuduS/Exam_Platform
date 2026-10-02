import { useEffect, useRef, useState } from "react";

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
    setSampleUrl(null);
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
    const rec = new MediaRecorder(streamRef.current);
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
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

  useEffect(() => () => stop(), []);

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

export function useScreenShareTest() {
  const [state, setState] = useState<"idle" | "active" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const start = async () => {
    setError(null);
    try {
      const md = navigator.mediaDevices as MediaDevices & { getDisplayMedia?: (c?: unknown) => Promise<MediaStream> };
      if (!md.getDisplayMedia) throw new Error("Screen share not supported in this browser. Use Chrome, Firefox, or Edge.");
      const stream = await md.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", stop);
      setState("active");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed";
      setError(msg.includes("denied") || msg.includes("Permission") ? "Screen share permission denied. Click 'Share' when the browser asks." : msg);
      setState("error");
    }
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
