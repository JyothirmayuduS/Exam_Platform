import { getSupabase } from "./supabase";
import { supabaseConfigured } from "./env";

export type RecorderHandle = { stop: () => void };

/**
 * Ask the store-artifact Edge Function for a short-lived presigned R2 PUT URL.
 * Recordings are stored under: ${examId}/${studentId}/recordings/${kind}_${timestamp}.webm
 */
async function getR2UploadUrl(opts: {
  examId: string;
  studentId: string;
  kind: "camera" | "screen";
}): Promise<{ url: string; key: string } | null> {
  if (!supabaseConfigured) return null;
  const db = getSupabase();
  if (!db) return null;

  const filename = `${opts.kind}_${Date.now()}.webm`;

  try {
    const { data, error } = await db.functions.invoke("store-artifact", {
      body: {
        examId: opts.examId,
        studentId: opts.studentId,
        kind: "recording",
        name: filename,
        contentType: "video/webm",
      },
    });
    if (error || !data?.url) {
      console.warn(`[recorder] store-artifact error for ${opts.kind}:`, error);
      return null;
    }
    return { url: data.url as string, key: (data.key as string) ?? "" };
  } catch (err) {
    console.warn(`[recorder] Failed to get R2 upload URL for ${opts.kind}:`, err);
    return null;
  }
}

/**
 * Start recording a MediaStream (camera or screen) and upload it directly to
 * Cloudflare R2 via a presigned PUT URL from the store-artifact Edge Function.
 *
 * No per-second screenshots, no PDF, no Cloudflare Stream — everything goes
 * to one R2 bucket under the per-exam/per-student folder layout.
 */
export function startVideoRecording(opts: {
  stream: MediaStream;
  examId: string;
  studentId: string;
  kind: "camera" | "screen";
  chunkDurationMs?: number;
}): RecorderHandle {
  const { stream, examId, studentId, kind, chunkDurationMs = 1000 } = opts;

  // 1. Setup the MediaRecorder (collect chunks for one final upload on stop).
  //    We always upload the complete blob on stop to ensure the recording is
  //    a valid, self-contained webm file in R2.
  const mimeType = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].find(type => MediaRecorder.isTypeSupported(type)) || 'video/webm';

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2_500_000, // 2.5 Mbps HD
  });

  const chunks: Blob[] = [];
  let started = false;

  // Kick off the recording. Upload happens once on `stop` so the resulting
  // file in R2 is a valid webm that can be played back directly.
  const start = () => {
    if (started) return;
    started = true;
    recorder.start(chunkDurationMs);
    console.debug(`[recorder] ${kind} MediaRecorder started`);
  };

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: "video/webm" });
    if (blob.size === 0) {
      console.warn(`[recorder] ${kind} recording is empty, skipping R2 upload`);
      return;
    }
    // Request a fresh presigned URL (the one we requested at start may be
    // for a different filename/timestamp) and PUT the complete webm.
    void (async () => {
      try {
        const presigned = await getR2UploadUrl({ examId, studentId, kind });
        if (!presigned) {
          console.error(`[recorder] ❌ ${kind} R2 upload failed: no presigned URL`);
          return;
        }
        const res = await fetch(presigned.url, {
          method: "PUT",
          headers: { "Content-Type": "video/webm" },
          body: blob,
        });
        if (res.ok) {
          console.log(`[recorder] ✅ ${kind} uploaded to R2: ${presigned.key} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
        } else {
          console.error(`[recorder] ❌ ${kind} R2 PUT failed: ${res.status} ${res.statusText}`);
        }
      } catch (err) {
        console.error(`[recorder] ❌ ${kind} R2 upload error:`, err);
      }
    })();
  };

  // Start immediately (no need to wait for TUS URL).
  start();

  return {
    stop: () => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }
  };
}
