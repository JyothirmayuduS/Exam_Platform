// WebM recording of the proctor streams (camera + screen), uploaded to
// Cloudflare R2 on stop.
//
// Keys come from .env.local (VITE_S3_* — S3-compatible R2 credentials), the
// same ones examStorage uses, so recordings land under:
//   ${examId}/${roll}/recordings/${kind}_${timestamp}.webm
//
// R2 only — nothing is written to Supabase Storage for proctor artifacts.

import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSupabase } from "./supabase";
import { supabaseConfigured } from "./env";

const r2Endpoint = import.meta.env.VITE_S3_ENDPOINT || "";
const r2Bucket = import.meta.env.VITE_S3_BUCKET_NAME || "";
const r2AccessKey = import.meta.env.VITE_S3_ACCESS_KEY || "";
const r2SecretKey = import.meta.env.VITE_S3_SECRET_KEY || "";

const s3Client = new S3Client({
  region: "auto",
  forcePathStyle: true,
  endpoint: r2Endpoint,
  credentials: {
    accessKeyId: r2AccessKey,
    secretAccessKey: r2SecretKey,
  },
});

export type RecorderHandle = { stop: () => void };

async function putRecording(opts: {
  examId: string;
  roll: string;
  kind: "camera" | "screen";
  blob: Blob;
}): Promise<string | null> {
  const { examId, roll, kind, blob } = opts;
  const key = `${examId}/${roll}/recordings/${kind}_${Date.now()}.webm`;

  // Primary: Cloudflare R2. Backup: Supabase Storage when R2 is unavailable.
  if (r2Endpoint && r2Bucket && r2AccessKey && r2SecretKey) {
    try {
      const cmd = new PutObjectCommand({
        Bucket: r2Bucket,
        Key: key,
        Body: blob,
        ContentType: "video/webm",
      });
      await s3Client.send(cmd);
      console.log(`[recorder] ✅ ${kind} uploaded to R2: ${key} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
      return key;
    } catch (err) {
      console.error(`[recorder] ❌ ${kind} R2 upload failed — trying Supabase backup:`, err);
    }
  } else {
    console.warn(`[recorder] R2 not configured for ${kind} — using Supabase backup bucket`);
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
        console.log(`[recorder] ✅ ${kind} uploaded to Supabase (backup): ${key}`);
        return key;
      }
      console.error(`[recorder] ❌ ${kind} Supabase backup upload failed:`, error.message);
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
}): RecorderHandle {
  const { stream, examId, roll, kind, chunkDurationMs = 1000 } = opts;

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
    void putRecording({ examId, roll, kind, blob });
  };

  start();

  return {
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}
