// Proctoring artifact storage — Cloudflare R2 ONLY.
//
// Recordings, per-second screenshots, violation snapshots and the PDF report
// all live in Cloudflare R2 (S3-compatible). Supabase is never used for these
// artifacts — it only holds the small metadata rows (attempts, violation_events).
//
// Credentials come from the VITE_S3_* keys in .env.local (S3-compatible access
// key / secret / endpoint / bucket for R2). Nothing is hard-coded here.
//
// Folder layout (kept identical between the exam side and the review side):
//   ${examId}/${roll}/recordings/${name}.webm
//   ${examId}/${roll}/screenshots/snap_${epochMs}.jpg
//   ${examId}/${roll}/violations/${epochMs}_${type}.jpg
//   ${examId}/${roll}/report/report_${epochMs}.pdf

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { jsPDF } from "jspdf";
import { getSupabase } from "./supabase";
import { supabaseConfigured } from "./env";

// Storage policy: Cloudflare R2 is PRIMARY, Supabase Storage is the BACKUP.
// Every artifact is written to R2 first; only when the R2 write fails (bad
// credentials, bucket CORS, network) does the same object fall back to the
// Supabase bucket, so a Cloudflare outage never loses a recording or snapshot.
export type StorageProvider = "r2" | "supabase";

export type StoredArtifact = {
  key: string;
  provider: StorageProvider;
};

function supabaseBucketName(): string {
  return import.meta.env.VITE_SUPABASE_BUCKET_NAME || "exam-records";
}

const r2Endpoint = import.meta.env.VITE_S3_ENDPOINT || "";
const r2Bucket = import.meta.env.VITE_S3_BUCKET_NAME || "";
const r2AccessKey = import.meta.env.VITE_S3_ACCESS_KEY || "";
const r2SecretKey = import.meta.env.VITE_S3_SECRET_KEY || "";

/** True only when real R2 (Cloudflare) credentials are configured. */
export const r2Configured = !!(r2Endpoint && r2Bucket && r2AccessKey && r2SecretKey);

const s3Client = new S3Client({
  region: "auto",
  // R2 requires path-style addressing (endpoint/bucket/key, no bucket subdomain).
  forcePathStyle: true,
  endpoint: r2Endpoint,
  credentials: {
    accessKeyId: r2AccessKey,
    secretAccessKey: r2SecretKey,
  },
});

export type ArtifactKind = "recordings" | "screenshots" | "violations" | "report";

export type R2Artifact = {
  key: string;
  kind: ArtifactKind;
  name: string;
  size: number;
  lastModified: string | null;
};

function buildR2Path(
  examId: string,
  roll: string,
  kind: ArtifactKind,
  filename: string,
): string {
  return `${examId}/${roll}/${kind}/${filename}`;
}

/** List the objects under one prefix (e.g. `EXAM-2026-014/21VGN0158/`). */
export async function listR2Artifacts(prefix: string): Promise<R2Artifact[] | null> {
  if (!r2Configured) return null;
  try {
    const cmd = new ListObjectsV2Command({ Bucket: r2Bucket, Prefix: prefix });
    const out = await s3Client.send(cmd);
    return (out.Contents ?? []).map((o) => {
      const key = o.Key ?? "";
      const parts = key.split("/");
      const kind = (parts[2] as ArtifactKind | undefined) ?? "screenshots";
      return {
        key,
        kind,
        name: parts[parts.length - 1] ?? key,
        size: o.Size ?? 0,
        lastModified: o.LastModified?.toISOString() ?? null,
      };
    });
  } catch (err) {
    console.warn(`[examStorage] R2 list failed (${prefix}):`, err);
    return null;
  }
}

/** List all artifacts for one exam + roll: `${examId}/${roll}/`. */
export async function listStudentArtifacts(
  examId: string,
  roll: string,
): Promise<R2Artifact[] | null> {
  const prefix = `${examId}/${roll}/`;
  // Primary: Cloudflare R2. When R2 isn't configured / errors, fall back to the
  // Supabase backup bucket so artifacts are still reviewable.
  if (r2Configured) {
    const r2 = await listR2Artifacts(prefix);
    if (r2) return r2;
  }
  return listSupabaseArtifacts(prefix);
}

/** Backup tier listing: objects stored in Supabase Storage for a prefix. */
async function listSupabaseArtifacts(prefix: string): Promise<R2Artifact[] | null> {
  if (!supabaseConfigured) return null;
  const db = getSupabase();
  if (!db) return null;
  try {
    const { data, error } = await db.storage
      .from(supabaseBucketName())
      .list(prefix.replace(/\/+$/, "") + "/", { limit: 1000, offset: 0 });
    if (error || !data) {
      console.warn(`[examStorage] Supabase backup list failed (${prefix}):`, error?.message ?? "no data");
      return null;
    }
    return data
      .filter((o: { id?: string | null; name?: string }) => Boolean(o.id && o.name)) // only real objects, skip folder markers
      .map((o: { id?: string | null; name?: string; metadata?: { size?: number }; created_at?: string | null }) => {
        const key = `${prefix}${o.name}`;
        const parts = key.split("/");
        return {
          key,
          kind: (parts[2] as ArtifactKind | undefined) ?? "screenshots",
          name: o.name,
          size: o.metadata?.size ?? 0,
          lastModified: o.created_at ?? null,
        };
      });
  } catch (err) {
    console.warn(`[examStorage] Supabase backup list error (${prefix}):`, err);
    return null;
  }
}

/**
 * Playable/embeddable URL for an artifact, from whichever provider holds it:
 * R2 presigned GET first, then the Supabase public URL.
 */
export async function getArtifactObjectUrl(key: string, expiresIn = 3600): Promise<string | null> {
  const r2 = await getR2ObjectUrl(key, expiresIn);
  if (r2) return r2;
  if (supabaseConfigured) {
    const db = getSupabase();
    if (db) {
      const { data } = db.storage.from(supabaseBucketName()).getPublicUrl(key);
      if (data?.publicUrl) return data.publicUrl;
    }
  }
  return null;
}

/**
 * A playable/embeddable URL for an R2 object. Uses a short-lived presigned GET
 * so private buckets work; returns null when R2 isn't configured.
 */
export async function getR2ObjectUrl(key: string, expiresIn = 3600): Promise<string | null> {
  if (!r2Configured) return null;
  try {
    const cmd = new GetObjectCommand({ Bucket: r2Bucket, Key: key });
    return await getSignedUrl(s3Client, cmd, { expiresIn });
  } catch (err) {
    console.warn(`[examStorage] R2 presign failed (${key}):`, err);
    return null;
  }
}

/** Upload one blob to R2 (primary). Returns the object key, or null on failure. */
async function uploadToR2(path: string, blob: Blob, contentType: string): Promise<string | null> {
  if (!r2Configured) {
    console.warn(`[examStorage] R2 not configured — ${path} will go to the Supabase backup bucket`);
    return null;
  }
  try {
    const cmd = new PutObjectCommand({
      Bucket: r2Bucket,
      Key: path,
      Body: blob,
      ContentType: contentType,
    });
    await s3Client.send(cmd);
    console.log(`[examStorage] R2 ✓ ${path} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
    return path;
  } catch (err) {
    console.warn(`[examStorage] R2 upload failed (${path}):`, err);
    return null;
  }
}

/** Backup tier: Supabase Storage (only used when the R2 write fails). */
async function uploadToSupabase(path: string, blob: Blob, contentType: string): Promise<string | null> {
  if (!supabaseConfigured) {
    console.warn(`[examStorage] Supabase backup not configured — ${path} could not be stored`);
    return null;
  }
  const db = getSupabase();
  if (!db) return null;
  try {
    const { error } = await db.storage.from(supabaseBucketName()).upload(path, blob, {
      contentType,
      upsert: true,
    });
    if (error) {
      console.warn(`[examStorage] Supabase backup failed (${path}):`, error.message);
      return null;
    }
    console.log(`[examStorage] Supabase ✓ (backup) ${path}`);
    return path;
  } catch (err) {
    console.warn(`[examStorage] Supabase backup error (${path}):`, err);
    return null;
  }
}

/** Write R2 first, fall back to Supabase. Returns where the object landed. */
async function storeArtifact(path: string, blob: Blob, contentType: string): Promise<StoredArtifact | null> {
  const r2key = await uploadToR2(path, blob, contentType);
  if (r2key) return { key: r2key, provider: "r2" };
  const sbKey = await uploadToSupabase(path, blob, contentType);
  return sbKey ? { key: sbKey, provider: "supabase" } : null;
}

/** Store an arbitrary blob (R2 primary → Supabase backup). */
export async function uploadArtifactBlob(
  key: string,
  blob: Blob,
  contentType: string,
): Promise<StoredArtifact | null> {
  return storeArtifact(key, blob, contentType);
}

/** Store a flagged frame as a violation snapshot (used by the proctor console). */
export async function storeViolationSnapshot(opts: {
  examId: string;
  roll: string;
  label: string;
  blob: Blob;
}): Promise<StoredArtifact | null> {
  const safeLabel = opts.label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  return storeArtifact(
    buildR2Path(opts.examId, opts.roll, "violations", `${Date.now()}_${safeLabel}.jpg`),
    opts.blob,
    "image/jpeg",
  );
}

export function captureFrame(video: HTMLVideoElement, quality = 0.6): Blob | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  let out: Blob | null = null;
  c.toBlob((r) => { out = r; }, "image/jpeg", quality);
  return out;
}

/** One violation snapshot captured at the moment of the flag. */
export type ViolationSnap = {
  label: string;
  blob: Blob;
  /** Seconds from the exam start — also drawn on the recording seek bar. */
  offsetSec?: number | null;
};

export type ScreenshotHandle = {
  setVideo: (video: HTMLVideoElement | null) => void;
  stop: () => void;
  captureViolationSnapshot: (violationType: string) => Promise<Blob | null>;
};

/** Capture a JPEG frame every second + a high-quality frame per violation. */
export function startScreenshotCapture(opts: {
  examId: string;
  roll: string;
  intervalMs?: number;
}): ScreenshotHandle {
  const { examId, roll, intervalMs = 1000 } = opts;
  let video: HTMLVideoElement | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped || !video) return;
    const blob = captureFrame(video);
    if (!blob) return;
    await storeArtifact(
      buildR2Path(examId, roll, "screenshots", `snap_${Date.now()}.jpg`),
      blob,
      "image/jpeg",
    );
  };

  void tick();
  const id = window.setInterval(() => void tick(), intervalMs);

  return {
    setVideo: (v) => { video = v; },
    stop: () => {
      stopped = true;
      window.clearInterval(id);
      video = null;
    },
    captureViolationSnapshot: async (violationType: string) => {
      if (!video) return null;
      const blob = captureFrame(video, 0.9);
      if (!blob) return null;
      const safeType = violationType.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
      await storeArtifact(
        buildR2Path(examId, roll, "violations", `${Date.now()}_${safeType}.jpg`),
        blob,
        "image/jpeg",
      );
      return blob;
    },
  };
}

/**
 * Upload everything recorded during the exam (recording + violation snapshots +
 * a PDF report) to Cloudflare R2.
 */
export async function uploadExamRecords(opts: {
  examId: string;
  roll: string;
  studentName: string;
  videoBlob: Blob;
  violationSnapshots?: ViolationSnap[];
  durationSec?: number;
}): Promise<{ recordingKey: string | null; pdfKey: string | null; snapshotKeys: string[] }> {
  const { examId, roll, studentName, videoBlob, violationSnapshots = [], durationSec } = opts;
  const uploaded = { recordingKey: null as string | null, pdfKey: null as string | null, snapshotKeys: [] as string[] };

  // 1. Recording → Cloudflare R2 (primary), Supabase Storage (backup).
  const recFilename = `recording_${Date.now()}.webm`;
  const rec = await storeArtifact(
    buildR2Path(examId, roll, "recordings", recFilename),
    videoBlob,
    "video/webm",
  );
  uploaded.recordingKey = rec?.key ?? null;

  // 2. Violation snapshots (frames captured at the flagged moments).
  for (const snap of violationSnapshots) {
    const safeLabel = snap.label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
    const stored = await storeArtifact(
      buildR2Path(examId, roll, "violations", `${Date.now()}_${safeLabel}.jpg`),
      snap.blob,
      "image/jpeg",
    );
    if (stored) uploaded.snapshotKeys.push(stored.key);
  }

  // 3. PDF report (generated locally with jsPDF).
  try {
    const pdfBlob = await generateProctorReport({
      examId,
      roll,
      studentName,
      violationSnapshots,
      durationSec,
      recordingKey: uploaded.recordingKey,
    });
    const pdf = await storeArtifact(
      buildR2Path(examId, roll, "report", `report_${Date.now()}.pdf`),
      pdfBlob,
      "application/pdf",
    );
    uploaded.pdfKey = pdf?.key ?? null;
  } catch (err) {
    console.error("[examStorage] PDF generation failed:", err);
  }

  return uploaded;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF report — generated in the browser with jsPDF (deterministic, no server).
// Each page is a real PDF page with the violation frames embedded.
// ─────────────────────────────────────────────────────────────────────────────

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function fmtClock(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function generateProctorReport(opts: {
  examId: string;
  roll: string;
  studentName: string;
  violationSnapshots?: ViolationSnap[];
  durationSec?: number;
  recordingKey?: string | null;
}): Promise<Blob> {
  const { examId, roll, studentName, violationSnapshots = [], durationSec, recordingKey } = opts;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4", compress: true });
  const W = doc.internal.pageSize.getWidth(); // ~595
  const M = 40;
  const CW = W - M * 2;

  const header = (title: string, subtitle: string) => {
    doc.setFillColor(26, 58, 42);
    doc.rect(0, 0, W, 74, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text("VIGNAN'S INSTITUTE OF INFORMATION TECHNOLOGY", M, 30);
    doc.setFont("courier", "bold");
    doc.setFontSize(11);
    doc.text(title, M, 50);
    doc.setFontSize(8);
    doc.text(subtitle, M, 64);
  };

  const now = new Date();
  header("PROCTORING EXAMINATION REPORT", `${now.toLocaleDateString()} · ${now.toLocaleTimeString()}`);

  // Student / session details
  let y = 96;
  doc.setDrawColor(26, 58, 42);
  doc.setLineWidth(1.5);
  doc.line(M, y, W - M, y);
  y += 22;
  doc.setTextColor(20, 20, 20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("STUDENT DETAILS", M, y);
  y += 18;

  const details: [string, string][] = [
    ["Student", studentName],
    ["Roll / ID", roll],
    ["Exam", examId],
    ["Recording", recordingKey ?? "not uploaded"],
    ["Flags", violationSnapshots.length > 0 ? `${violationSnapshots.length} flagged moment(s)` : "None"],
  ];
  doc.setFontSize(10);
  for (const [label, value] of details) {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(110, 110, 110);
    doc.text(label.toUpperCase(), M, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(20, 20, 20);
    doc.text(String(value).slice(0, 90), M + 110, y);
    y += 15;
  }
  y += 8;

  // Violation summary
  doc.setDrawColor(26, 58, 42);
  doc.setLineWidth(1.5);
  doc.line(M, y, W - M, y);
  y += 22;
  doc.setTextColor(20, 20, 20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("VIOLATION SUMMARY", M, y);
  y += 18;

  if (violationSnapshots.length === 0) {
    doc.setFont("courier", "normal");
    doc.setFontSize(10);
    doc.setTextColor(42, 122, 42);
    doc.text("No violations detected during this exam session.", M, y);
    y += 20;
  } else {
    doc.setFontSize(9.5);
    violationSnapshots.slice(0, 14).forEach((v, i) => {
      const over = y > 760;
      if (over) { doc.addPage(); y = 60; }
      doc.setTextColor(200, 0, 0);
      doc.setFont("helvetica", "bold");
      const stamp = v.offsetSec != null ? `@ ${fmtClock(v.offsetSec)}` : "";
      doc.text(`${i + 1}. ${v.label} ${stamp}`, M, y);
      y += 14;
    });
    doc.setFont("courier", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(120, 120, 120);
    doc.text("Flagged moments are marked in RED on the recording timeline.", M, y + 4);
  }

  // Duration + signature footer on page 1
  doc.setFontSize(9);
  doc.setTextColor(130, 130, 130);
  doc.text(
    `Duration: ${durationSec != null ? fmtClock(durationSec) : "—"}   ·   Generated ${now.toLocaleString()}`,
    M,
    800,
  );

  // One page per violation frame (2 per page) — real images, not placeholders.
  if (violationSnapshots.length > 0) {
    for (let i = 0; i < violationSnapshots.length; i += 2) {
      doc.addPage();
      const slice = violationSnapshots.slice(i, i + 2);
      doc.setFillColor(200, 0, 0);
      doc.rect(0, 0, W, 56, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(14);
      doc.text(`VIOLATION EVIDENCE — ${examId} · ${roll}`, M, 26);
      doc.setFontSize(9);
      doc.text(`Frames ${i + 1}–${i + slice.length} of ${violationSnapshots.length}`, M, 42);

      let frameY = 92;
      for (const snap of slice) {
        doc.setDrawColor(200, 0, 0);
        doc.setLineWidth(1);
        doc.rect(M, frameY, CW, 300, "S");
        doc.setTextColor(200, 0, 0);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        const stamp = snap.offsetSec != null ? ` @ ${fmtClock(snap.offsetSec)}` : "";
        doc.text(`Violation: ${snap.label}${stamp}`, M + 8, frameY + 20);
        try {
          const dataUrl = await blobToDataUrl(snap.blob);
          const imgW = CW - 16;
          const imgH = 240;
          doc.addImage(dataUrl, "JPEG", M + 8, frameY + 30, imgW, imgH, undefined, "FAST");
        } catch (err) {
          console.warn("[examStorage] could not embed violation frame in PDF:", err);
          doc.setTextColor(150, 150, 150);
          doc.setFont("courier", "normal");
          doc.setFontSize(9);
          doc.text("(frame unavailable)", M + 8, frameY + 160);
        }
        frameY += 330;
      }
    }
  }

  return doc.output("blob");
}
