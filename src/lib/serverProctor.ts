// serverProctor.ts — feeds tiny luminance grids of the candidate's screen feed
// to the `proctor-ai-server` edge function, which derives server-side signals
// (black screen, white-out, frozen frame) and persists them as violation_events
// with source 'ai'. The client can be muted or tampered with; this trail is
// server-authoritative.
import { getSupabase } from "./supabase";
import { supabaseConfigured } from "./env";

export type ServerProctorHandle = { stop: () => void };

const GRID = 8; // 8x8 luminance grid — ~200 bytes per frame

export function startServerProctorWatchdog(opts: {
  stream: MediaStream;
  /** Returns the live attempt id (may be undefined until the attempt starts). */
  attemptRef: () => string | undefined;
  examId: string;
  intervalMs?: number;
  enabled?: boolean;
}): ServerProctorHandle {
  const { stream, attemptRef, examId, intervalMs = 6000, enabled = true } = opts;

  if (!enabled || !supabaseConfigured || typeof document === "undefined") {
    return { stop: () => {} };
  }

  // A hidden <video> renders the screen stream into a tiny canvas.
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = "position:fixed;width:8px;height:8px;opacity:0;pointer-events:none;left:-9999px;top:0";
  video.srcObject = stream;
  void video.play().catch(() => {});
  document.body.appendChild(video);

  const canvas = document.createElement("canvas");
  canvas.width = GRID;
  canvas.height = GRID;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let previous: number[] | null = null;
  let frameNo = 0;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const attemptId = attemptRef();
    if (!attemptId || video.readyState < 2 || !ctx) return;

    try {
      ctx.drawImage(video, 0, 0, GRID, GRID);
      const data = ctx.getImageData(0, 0, GRID, GRID).data;
      const lum: number[] = [];
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        lum.push(l);
        sum += l;
      }
      const mean = sum / lum.length;
      const variance = lum.reduce((acc, l) => acc + (l - mean) ** 2, 0) / lum.length;
      const contrast = Math.sqrt(variance);

      let diff = 1;
      if (previous) {
        let changed = 0;
        for (let i = 0; i < lum.length; i++) {
          if (Math.abs(lum[i] - previous[i]) > 6) changed += 1;
        }
        diff = changed / lum.length;
      }
      previous = lum;
      frameNo += 1;

      const db = getSupabase();
      if (!db) return;
      await db.functions.invoke("proctor-ai-server", {
        body: {
          attemptId,
          examId,
          mean: Math.round(mean),
          contrast: Math.round(contrast * 10) / 10,
          diff: Math.round(diff * 100) / 100,
          frameNo,
          kind: "screen",
        },
      });
    } catch (err) {
      // Best-effort telemetry — never let the watchdog break the exam.
      console.warn("[serverProctor] frame analysis skipped:", err);
    }
  };

  const timer = window.setInterval(() => void tick(), intervalMs);

  return {
    stop: () => {
      stopped = true;
      window.clearInterval(timer);
      video.srcObject = null;
      video.remove();
    },
  };
}
