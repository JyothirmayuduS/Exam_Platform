// Proctoring artifact storage — student side.
//
// Exam artifacts (per-second screenshots, the final PDF report, LiveKit
// recordings) are stored in Cloudflare R2 under an exam/student folder layout:
//
//   ${examId}/${studentId}/screenshots/${epochMs}.jpg
//   ${examId}/${studentId}/report/report.pdf
//   ${examId}/${studentId}/recording/...
//
// The browser NEVER holds R2 credentials. Instead it asks the Supabase Edge
// Function `store-artifact` for a short-lived presigned PUT URL (SigV4, minted
// server-side) and uploads the blob directly to R2 with a plain fetch PUT.
//
// Everything degrades: if Supabase/R2 isn't configured, or the presign call
// fails, the helpers no-op (return false) so the exam UI keeps working in the
// prototype without a backend.

import { supabaseConfigured } from "./env";
import { getSupabase } from "./supabase";

export type ArtifactKind = "screenshots" | "report" | "recording";

/**
 * Ask the Edge Function for a short-lived presigned R2 PUT URL for one object.
 * `name` is the leaf filename within the kind folder (e.g. "1712345678901.jpg").
 * Returns null when the backend isn't configured or the request fails.
 */
export async function presignUpload(opts: {
  examId: string;
  studentId: string;
  kind: ArtifactKind;
  name: string;
  contentType: string;
}): Promise<{ url: string; key: string } | null> {
  if (!supabaseConfigured) return null;
  const db = getSupabase();
  if (!db) return null;
  try {
    const { data, error } = await db.functions.invoke("store-artifact", {
      body: {
        examId: opts.examId,
        studentId: opts.studentId,
        kind: opts.kind,
        name: opts.name,
        contentType: opts.contentType,
      },
    });
    if (error || !data?.url) return null;
    return { url: data.url as string, key: (data.key as string) ?? "" };
  } catch (err) {
    console.warn("[storage] presign failed:", err);
    return null;
  }
}

/** Presign + PUT a single blob to R2. Returns the stored object key, or null. */
export async function uploadArtifact(opts: {
  examId: string;
  studentId: string;
  kind: ArtifactKind;
  name: string;
  blob: Blob;
}): Promise<string | null> {
  const contentType = opts.blob.type || "application/octet-stream";
  const signed = await presignUpload({
    examId: opts.examId,
    studentId: opts.studentId,
    kind: opts.kind,
    name: opts.name,
    contentType,
  });
  if (!signed) return null;
  try {
    const res = await fetch(signed.url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: opts.blob,
    });
    if (!res.ok) {
      console.warn("[storage] R2 PUT failed:", res.status, res.statusText);
      return null;
    }
    return signed.key;
  } catch (err) {
    console.warn("[storage] R2 upload error:", err);
    return null;
  }
}

/**
 * Capture a single JPEG frame from a <video> element and upload it as a
 * per-second proctoring screenshot. Returns the object key, or null on any
 * failure (never throws — proctoring must not break the exam).
 */
export async function captureAndUploadFrame(opts: {
  video: HTMLVideoElement;
  examId: string;
  studentId: string;
  quality?: number;
}): Promise<string | null> {
  const { video } = opts;
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null; // camera not ready yet

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", opts.quality ?? 0.6),
  );
  if (!blob) return null;

  return uploadArtifact({
    examId: opts.examId,
    studentId: opts.studentId,
    kind: "screenshots",
    name: `${Date.now()}.jpg`,
    blob,
  });
}

export type FrameCaptureHandle = { stop: () => void };

/**
 * Start capturing a screenshot every `intervalMs` (default 1000ms → 1/sec) from
 * the given video element and uploading it. Returns a handle to stop. No-ops
 * (returns a no-op handle) when the backend isn't configured.
 */
export function startFrameCapture(opts: {
  video: HTMLVideoElement;
  examId: string;
  studentId: string;
  intervalMs?: number;
}): FrameCaptureHandle {
  if (!supabaseConfigured) return { stop: () => {} };
  let busy = false;
  const tick = async () => {
    if (busy) return; // skip if the previous upload is still in flight
    busy = true;
    try {
      await captureAndUploadFrame({
        video: opts.video,
        examId: opts.examId,
        studentId: opts.studentId,
      });
    } finally {
      busy = false;
    }
  };
  const id = window.setInterval(() => void tick(), opts.intervalMs ?? 1000);
  return { stop: () => window.clearInterval(id) };
}
