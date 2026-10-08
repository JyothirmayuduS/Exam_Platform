// WebM recording of the proctor streams (camera + screen), uploaded to
// Cloudflare R2 on stop. Uploads go through the server-signed store-artifact
// Edge Function (lib/r2Function.ts) — the browser never holds R2 credentials.
//
// Recordings land under:
//   ${examFolder}/${roll}/recordings/${kind}_${timestamp}.webm
//
// where ${examFolder} is the slug of the exam NAME (fallback: exam id).
// R2 only — no Supabase Storage fallback.

import { r2PutBlob } from "@/shared/services/r2Function";
import { storageFolderSegment } from "@/shared/services/examStorage";
import { RECORDING_BITRATE } from "@/shared/services/lowBandwidth";

export type RecorderHandle = {
  stop: () => void;
  /** Weak link: keep live parts on the device and upload them once it recovers. */
  setLowBandwidth: (on: boolean) => void;
};

async function putRecording(opts: {
  examId: string;
  examName?: string | null;
  roll: string;
  kind: "camera" | "screen";
  blob: Blob;
}): Promise<string | null> {
  const { examId, examName, roll, kind, blob } = opts;
  const folder = storageFolderSegment(examId, examName);
  const name = `${kind}_${Date.now()}.webm`;

  try {
    const r2key = await r2PutBlob({
      examId: folder,
      ownerSegment: roll,
      kind: "recordings",
      name,
      blob,
    });
    if (r2key) {
      console.log(`[recorder] [ok] ${kind} uploaded to R2: ${r2key} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
      return r2key;
    }
    console.error(`[recorder] [fail] ${kind} R2 upload failed`);
  } catch (err) {
    console.error(`[recorder] [fail] ${kind} R2 upload failed:`, err);
  }
  return null;
}

/**
 * Record a MediaStream (camera or screen) and PUT the finished webm to
 * Cloudflare R2 when the recorder stops.
 */
export function startVideoRecording(opts: {
  stream: MediaStream;
  examId: string;
  examName?: string | null;
  roll: string;
  kind: "camera" | "screen";
  /** Upload each chunk to R2 live (crash-proof parts). Default false to avoid unplayable chunks. */
  liveParts?: boolean;
}): RecorderHandle {
  const { stream, examId, examName, roll, kind, liveParts = false } = opts;
  const folder = storageFolderSegment(examId, examName);

  const mimeType =
    [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: RECORDING_BITRATE[kind],
  });

  const chunks: Blob[] = [];
  let started = false;
  let partSeq = 0;
  let lowBandwidth = false;
  // Parts upload one at a time, in order. While the link is weak they wait.
  const pendingParts: { seq: number; blob: Blob }[] = [];
  let draining = false;
  const drainParts = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pendingParts.length && !lowBandwidth) {
        const part = pendingParts[0];
        try {
          await r2PutBlob({
            examId: folder,
            ownerSegment: roll,
            kind: "recordings",
            name: `parts/${kind}_${String(part.seq).padStart(8, "0")}.webm`,
            blob: part.blob,
          });
        } catch {
          /* live part upload is best-effort */
        }
        pendingParts.shift();
      }
    } finally {
      draining = false;
    }
  };

  const start = () => {
    if (started) return;
    started = true;
    recorder.start();
    console.debug(`[recorder] ${kind} MediaRecorder started`);
  };

  recorder.ondataavailable = (e) => {
    if (!e.data || e.data.size <= 0) return;
    chunks.push(e.data);
    if (liveParts) {
      partSeq += 1;
      pendingParts.push({ seq: partSeq, blob: e.data });
      void drainParts();
    }
  };

  recorder.onstop = () => {
    lowBandwidth = false;
    void drainParts();
    const blob = new Blob(chunks, { type: "video/webm" });
    if (blob.size === 0) {
      console.warn(`[recorder] ${kind} recording is empty, skipping R2 upload`);
      return;
    }
    void putRecording({ examId, examName, roll, kind, blob });
  };

  start();

  return {
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
    setLowBandwidth: (on) => {
      lowBandwidth = on;
      if (!on) void drainParts();
    },
  };
}
