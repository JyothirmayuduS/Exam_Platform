// WebM recording of the proctor streams (camera + screen), uploaded to
// Cloudflare R2 on stop. Uploads go through the server-signed store-artifact
// Edge Function (lib/r2Function.ts) — the browser never holds R2 credentials.
//
// Recordings land under:
//   ${examId}/${roll}/recordings/${kind}_${timestamp}.webm
//
// R2 primary; falls back to Supabase Storage when R2 is unavailable.

import { getSupabase } from "./supabase";
import { supabaseConfigured } from "./env";
import { r2PutBlob } from "./r2Function";

export type RecorderHandle = { stop: () => void };

async function putRecording(opts: {
  examId: string;
  roll: string;
  kind: "camera" | "screen";
  blob: Blob;
}): Promise<string | null> {
  const { examId, roll, kind, blob } = opts;
  const key = `${examId}/${roll}/recordings/${kind}_${Date.now()}.webm`;

  // Primary: Cloudflare R2 via the server-signed PUT path.
  try {
    const r2key = await r2PutBlob({
      examId,
      ownerSegment: roll,
      kind: "recordings",
      name: `${kind}_${Date.now()}.webm`,
      blob,
    });
    if (r2key) {
      console.log(`[recorder] [ok] ${kind} uploaded to R2: ${r2key} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
      return r2key;
    }
    console.error(`[recorder] [fail] ${kind} R2 upload failed — trying Supabase backup`);
  } catch (err) {
    console.error(`[recorder] [fail] ${kind} R2 upload failed — trying Supabase backup:`, err);
  }

  if (supabaseConfigured) {
    const db = getSupabase();
    if (db) {
      const bucket = import.meta.env.VITE_SUPABASE_BUCKET_NAME || "exam-records";
      const { error } = await db.storage.from(bucket).upload(key, blob, {
        contentType: "video/webm",
        upsert: true,
      });
      if (!error) {
        console.log(`[recorder] [ok] ${kind} uploaded to Supabase (backup): ${key}`);
        return key;
      }
      console.error(`[recorder] [fail] ${kind} Supabase backup upload failed:`, error.message);
    }
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
  roll: string;
  kind: "camera" | "screen";
  chunkDurationMs?: number;
  /** Upload each chunk to R2 live (crash-proof parts). Default true. */
  liveParts?: boolean;
}): RecorderHandle {
  const { stream, examId, roll, kind, chunkDurationMs = 10_000, liveParts = true } = opts;

  const mimeType =
    [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ].find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2_500_000, // 2.5 Mbps HD
  });

  const chunks: Blob[] = [];
  let started = false;
  let partSeq = 0;
  // Serialised chain so parts upload in order without overlapping.
  let partChain: Promise<void> = Promise.resolve();

  const start = () => {
    if (started) return;
    started = true;
    recorder.start(chunkDurationMs);
    console.debug(`[recorder] ${kind} MediaRecorder started`);
  };

  recorder.ondataavailable = (e) => {
    if (!e.data || e.data.size <= 0) return;
    chunks.push(e.data);
    if (liveParts) {
      const blob = e.data;
      partChain = partChain.then(async () => {
        try {
          partSeq += 1;
          await r2PutBlob({
            examId,
            ownerSegment: roll,
            kind: "recordings",
            name: `parts/${kind}_${String(partSeq).padStart(8, "0")}.webm`,
            blob,
          });
        } catch {
          /* live part upload is best-effort */
        }
      });
    }
  };

  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: "video/webm" });
    if (blob.size === 0) {
      console.warn(`[recorder] ${kind} recording is empty, skipping R2 upload`);
      return;
    }
    void putRecording({ examId, roll, kind, blob });
  };

  start();

  return {
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}
