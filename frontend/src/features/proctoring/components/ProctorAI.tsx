// ProctorAI.tsx — real-time AI proctoring for the Vignan Lockdown Exam
//
// This component is now a THIN CONTROLLER. All decision logic lives in the
// modular engine under src/features/proctoring/domain/ (unit-tested, no DOM):
//
//   models (MediaPipe)     / loaded here (same-origin first, CDN fallback)
//   face / gaze / audio    / read here from the shared camera <video>
//   raw object detections  / classified (labels.ts), identity-tracked and
//                            temporally confirmed (ObjectTracker.ts)
//   phone + head-pose      / fused (fusion.ts) — "head down" NEVER claims a
//                            phone by itself; "possible phone use" requires
//                            BOTH a confirmed phone AND a sustained head-down
//   dedupe / risk          / ViolationGate + RiskEngine
//   diagnostics            / diag sink read by ProctorDebugOverlay (dev only)
//
// The component renders an invisible <video> receiving the camera stream and
// emits violation events to the parent — its public props are unchanged.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CADENCE,
  PHONE_ACK_MS,
  EARBUDS_VISUAL_ACK_MS,
  GAZE,
  FACE,
  OBJECT,
  AUDIO,
  ObjectTracker,
  RiskEngine,
  ViolationGate,
  classifyObject,
  decideObjectEvent,
  gazeLabel,
  lowerRegion,
  pushObjectSample,
  proctorDiag,
  faceGeometryFromLandmarks,
  refineDetections,
  REFINE,
} from "@/features/proctoring/domain";
import type { BBox, Detection, FaceGeometry, ProctorCategory, RiskLevel } from "@/features/proctoring/domain";
import { acceptPhoneWithoutFace, phoneLikelihood, PHONE_VERIFY_MIN, type PixelStats } from "@/features/proctoring/domain/phoneVerifier";
import { blendshapeScores, HEAD_POSE, isLookingDown, LOOK_DOWN, lookDownScore, poseFromMatrix, type HeadPose } from "@/features/proctoring/domain/headPose";
import { LipActivity, LIPS, mouthOpenRatio } from "@/features/proctoring/domain/lipActivity";
import { ABSENCE, ABSENCE_LABEL, AbsenceMonitor, classifyAbsence, frameStats } from "@/features/proctoring/domain/absence";
import { DARK_BUD, earPatches, isDarkEarbud, type EarPatch } from "@/features/proctoring/domain/darkEarbud";
import { env } from "@/shared/data/env";
import ProctorDebugOverlay from "@/features/proctoring/components/ProctorDebugOverlay";

// ── Public types (kept for back-compat; machine ids now come from the engine) ─
export type AIViolationType = ProctorCategory;

export interface AIViolation {
  type: AIViolationType;
  label: string;       // human-readable description
  confidence: number;  // 0-1
  at: number;          // Date.now()
  /** Low-res JPEG camera frame captured at flag time — uploaded as evidence. */
  evidenceBlob?: Blob;
}

export interface AIStatus {
  loading: boolean;
  loadStep: string;
  error: boolean;
  faceCount: number;
  gazeDirection: "center" | "left" | "right" | "up" | "down";
  gazeScore: number;      // 1 = looking straight at screen
  phoneDetected: boolean;
  voiceLevel: number;     // 0-1 RMS amplitude
  voiceSpeaking: boolean;
  /** Risk engine (0..100) — set when it changes. */
  riskScore?: number;
  riskLevel?: RiskLevel;
  /** How well the candidate sits in the camera frame; "ok" when no face is read. */
  framing?: Framing;
}

export type Framing = "ok" | "too_far" | "too_close" | "off_left" | "off_right" | "too_high" | "too_low" | "cut_off";

/** Classify head placement from normalized face landmarks. */
export function classifyFraming(lms: ReadonlyArray<{ x: number; y: number }>): Framing {
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of lms) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX < 0.01 || maxX > 0.99 || minY < 0.01 || maxY > 0.99) return "cut_off";
  const w = maxX - minX;
  const h = maxY - minY;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  if (w < 0.12 || h < 0.16) return "too_far";
  if (w > 0.6 || h > 0.75) return "too_close";
  if (cx < 0.25) return "off_left";
  if (cx > 0.75) return "off_right";
  if (cy < 0.2) return "too_high";
  if (cy > 0.7) return "too_low";
  return "ok";
}

export const FRAMING_HINT: Record<Exclude<Framing, "ok">, string> = {
  too_far: "Move closer — your face is too small in the camera",
  too_close: "Sit back a little — your face fills the camera",
  off_left: "Move to your left so you are centred in the camera",
  off_right: "Move to your right so you are centred in the camera",
  too_high: "Lower the camera or sit up straight so your whole face shows",
  too_low: "Sit up straight — only part of your face is in the camera",
  cut_off: "Sit properly — your face is partly outside the camera frame",
};

interface Props {
  /** The camera + mic MediaStream from getUserMedia. */
  cameraStream: MediaStream | null;
  /** True only while the exam step is active. Models stay loaded but loop stops. */
  active: boolean;
  onViolation: (v: AIViolation) => void;
  onStatus?: (s: AIStatus) => void;
}

// ── Timing / cadence (all tunable in src/features/proctoring/domain/config.ts) ──────────────
const GAZE_MS    = CADENCE.GAZE_MS;
const FACE_MS    = CADENCE.FACE_MS;
const OBJECT_MS  = CADENCE.OBJECT_MS;
/** Gaze samples (~150 ms each) of bad seating before the student is told. */
const FRAMING_SUSTAIN = 7;
const AUDIO_MS   = CADENCE.AUDIO_MS;

// ── Asset loading: SAME-ORIGIN FIRST, CDN fallback ─────────────────────────
// The WASM runtime and the three model files are vendored into the app bundle
// (public/ai/…) and loaded from the app's OWN origin, so the AI engine works
// even when Google's model CDN (storage.googleapis.com) or jsDelivr is blocked
// or flaky on the candidate's network — the classic "AI never detects" failure
// in the field. The CDN URLs are kept as automatic fallbacks and each source
// is retried with backoff before giving up.
//
// BASE_URL keeps the paths correct under sub-path deployments and the Tauri
// asset protocol (Vite base is `/` in dev and on Vercel).
const APP_BASE = import.meta.env.BASE_URL || "/";
const MP_WASM = `${APP_BASE}ai/wasm`;

// Google's model CDN (fallback when the same-origin copy is unreachable).
const MODEL_FACE_DET_CDN =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const MODEL_FACE_LM_CDN =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_OBJ_DET_CDN =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

// Order matters: same-origin (guaranteed by the app's own hosting) first, then
// the CDN mirror. The SDK fetches modelAssetPath internally; createFromOptions
// throws when a source is unreachable, so we walk the list on failure.
const MODEL_FACE_DET_SOURCES = [`${APP_BASE}ai/models/blaze_face_short_range.tflite`, MODEL_FACE_DET_CDN];
const MODEL_FACE_LM_SOURCES  = [`${APP_BASE}ai/models/face_landmarker.task`, MODEL_FACE_LM_CDN];
const MODEL_OBJ_DET_SOURCES  = [`${APP_BASE}ai/models/efficientdet_lite0.tflite`, MODEL_OBJ_DET_CDN];

// ── Singleton WASM resolver (shared across mounts) ───────────────────────────
function dataUrlToBlob(dataUrl: string): Blob | undefined {
  try {
    const i = dataUrl.indexOf(",");
    const mime = dataUrl.slice(5, i).split(";")[0];
    const bin = atob(dataUrl.slice(i + 1));
    const arr = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    return new Blob([arr], { type: mime });
  } catch {
    return undefined;
  }
}

/** Per-kind confidence gate (mirrors the pipeline test's gating rule). */
function minConfForKind(kind: Detection["kind"]): number {
  if (kind === "phone") return OBJECT.PHONE_MIN_CONF;
  if (kind === "earbuds") return OBJECT.EARBUDS_MIN_CONF;
  return OBJECT.LAPTOP_MIN_CONF;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _visionCache: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _visionPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getVision(): Promise<any> {
  if (_visionCache) return _visionCache;
  if (!_visionPromise) {
    _visionPromise = import("@mediapipe/tasks-vision").then(({ FilesetResolver }) =>
      FilesetResolver.forVisionTasks(MP_WASM).then((v: unknown) => {
        _visionCache = v;
        return v;
      })
    );
  }
  return _visionPromise;
}

// ── Head-pose / gaze estimation ──────────────────────────────────────────────
// Uses 4 facial landmark indices from MediaPipe Face Landmarker to estimate
// rough yaw (left/right) and pitch (up/down) as pure geometric RATIOS:
//
//   1   / nose tip     33 / left eye outer corner
// 152   / chin        263 / right eye outer corner
//
// The ratios are NOT absolute angles — their neutral value depends on the
// camera's height and the student's seating. ProctorAI therefore calibrates a
// per-student baseline from their own neutral pose and flags only sustained
// DEVIATIONS from it (see gazeRef below). That kills the classic false positive
// where a laptop/phone camera angle makes "looking straight" read as "down".

type GazeEst = { yaw: number; pitch: number };

function estimateGaze(lms: ReadonlyArray<{ x: number; y: number; z: number }>): GazeEst {
  const nose = lms[1];
  const lEye = lms[33];
  const rEye = lms[263];
  const chin = lms[152];
  if (!nose || !lEye || !rEye || !chin) return { yaw: 0, pitch: 0 };

  const eyeMidX = (lEye.x + rEye.x) / 2;
  const eyeMidY = (lEye.y + rEye.y) / 2;
  const eyeSpan = Math.abs(rEye.x - lEye.x);
  if (eyeSpan < 0.005) return { yaw: 0, pitch: 0 };

  const yaw      = (nose.x - eyeMidX) / eyeSpan;
  const vertSpan = Math.abs(chin.y - eyeMidY) || 0.18;
  const pitch    = (nose.y - eyeMidY) / vertSpan; // ≈ 0.5 when looking straight

  return { yaw, pitch };
}

// Neutral-pose baseline + gaze state machine, kept per mount.
type GazeTracker = {
  pitch: number;   // slow EMA of the student's own neutral pose
  yaw: number;
  calibrated: boolean;
  calibSamples: number; // samples accumulated before baseline locks
  awayStreak: number;  // consecutive off-neutral samples (decays on neutral)
  clearStreak: number; // consecutive neutral samples since last flag
  poseYaw: number;     // neutral absolute head pose (degrees)
  posePitch: number;
  poseSamples: number;
  calib: { pitch: number[]; yaw: number[]; posePitch: number[]; poseYaw: number[] };
};

function freshGaze(): GazeTracker {
  return {
    pitch: 0, yaw: 0, calibrated: false, calibSamples: 0, awayStreak: 0, clearStreak: 0, poseYaw: 0, posePitch: 0, poseSamples: 0,
    calib: { pitch: [], yaw: [], posePitch: [], poseYaw: [] },
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// Calibrate from ~GAZE.CALIBRATE_SAMPLES near-neutral frames (~2 s) so a
// glance-down at start doesn't become the "looking at screen" baseline.
// After lock, only adapt while clearly neutral AND not mid-away streak.
function updateGazeBaseline(t: GazeTracker, g: GazeEst, dev: number, pose: HeadPose | null): void {
  if (t.calibrated) {
    if (dev < GAZE.DEVIATION * 0.6 && t.awayStreak === 0) {
      const k = 0.03;
      t.pitch += k * (g.pitch - t.pitch);
      t.yaw   += k * (g.yaw - t.yaw);
      if (pose) {
        t.poseYaw += k * (pose.yaw - t.poseYaw);
        t.posePitch += k * (pose.pitch - t.posePitch);
      }
    }
    return;
  }
  // Median over the calibration window: a mean let a start-of-exam fidget
  // shift neutral pitch by 12°.
  t.calibSamples += 1;
  t.calib.pitch.push(g.pitch);
  t.calib.yaw.push(g.yaw);
  t.pitch = median(t.calib.pitch);
  t.yaw = median(t.calib.yaw);
  if (pose) {
    t.poseSamples += 1;
    t.calib.posePitch.push(pose.pitch);
    t.calib.poseYaw.push(pose.yaw);
    t.posePitch = median(t.calib.posePitch);
    t.poseYaw = median(t.calib.poseYaw);
  }
  if (t.calibSamples >= GAZE.CALIBRATE_SAMPLES) {
    t.calibrated = true;
    t.calib = { pitch: [], yaw: [], posePitch: [], poseYaw: [] };
  }
}

/** Raw MediaPipe detection / normalized, confidence-gated engine Detections.
 *
 *  MediaPipe's ObjectDetector returns the bounding box in PIXELS
 *  (originX / originY / width / height), NOT normalized [0,1] units. Clamping
 *  those pixel values into [0,1] collapsed every phone to the bottom-right
 *  corner of the frame — which silently wrecked IoU identity tracking
 *  (geometry.ts), desk-ROI filtering and the debug overlay, the #1 cause of
 *  "proctoring never detects". We must divide by the actual video resolution.
 */
function toDetections(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
  video: HTMLVideoElement,
): Detection[] {
  const out: Detection[] = [];
  // Guard against a still-initializing / 0x0 video (iOS Safari sometimes reads
  // videoWidth 0 until the first decoded frame).
  const vw = Math.max(1, video.videoWidth || 0);
  const vh = Math.max(1, video.videoHeight || 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const d of result?.detections ?? []) {
    for (const c of d?.categories ?? []) {
      const kind = classifyObject(String(c.categoryName ?? ""));
      const score = Number(c.score ?? 0);
      if (!kind || !d.boundingBox) continue;
      const box = d.boundingBox;
      const minConf = minConfForKind(kind);
      if (score < minConf) continue; // gate here — the model threshold stays low
      // Real pixel dims, never negative, clamped to the visible frame.
      const px = Math.max(0, Number(box.originX ?? 0));
      const py = Math.max(0, Number(box.originY ?? 0));
      const pw = Math.max(0, Number(box.width ?? 0));
      const ph = Math.max(0, Number(box.height ?? 0));
      out.push({
        kind,
        label: String(c.categoryName),
        score,
        bbox: {
          x: Math.min(1, px / vw),
          y: Math.min(1, py / vh),
          width: Math.min(1, pw / vw),
          height: Math.min(1, ph / vh),
        },
      });
    }
  }
  return out;
}

/**
 * Extra detection pass on a zoomed crop of one region of the frame.
 *
 * Phones at the frame edge or held low and earbuds are small objects: the
 * full-frame pass misses them, but the same object fills a large part of a
 * crop (the detector rescales its input to 320 px). Every returned PIXEL box is
 * mapped back into FULL-FRAME normalized [0,1] coordinates so it composes with
 * the full-frame pass before identity tracking. `earMode` reports any
 * phone-like / ear-worn hit inside an ear crop as earbuds.
 */
function detectRegion(
  region: BBox,
  video: HTMLVideoElement,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roiDetector: any,
  earMode = false,
): Detection[] {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const roiX = Math.round(region.x * vw);
  const roiY = Math.round(region.y * vh);
  const roiW = Math.round(region.width * vw);
  const roiH = Math.round(region.height * vh);
  if (!roiDetector || roiW < 16 || roiH < 16) return [];

  try {
    const canvas = document.createElement("canvas");
    canvas.width = roiW;
    canvas.height = roiH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    ctx.drawImage(video, roiX, roiY, roiW, roiH, 0, 0, roiW, roiH);

    const result = roiDetector.detect(canvas);
    const out: Detection[] = [];
    for (const d of result?.detections ?? []) {
      for (const c of d?.categories ?? []) {
        const rawLabel = String(c.categoryName ?? "");
        let kind = classifyObject(rawLabel);
        if (earMode && (kind === "phone" || kind === "earbuds" || /mouse/i.test(rawLabel))) kind = "earbuds";
        else if (earMode) continue;
        const score = Number(c.score ?? 0);
        if (!kind || !d.boundingBox) continue;
        if (score < minConfForKind(kind)) continue;
        const box = d.boundingBox;
        const px = Math.max(0, Number(box.originX ?? 0)) + roiX;
        const py = Math.max(0, Number(box.originY ?? 0)) + roiY;
        const pw = Math.max(0, Number(box.width ?? 0));
        const ph = Math.max(0, Number(box.height ?? 0));
        out.push({
          kind,
          label: earMode ? `${rawLabel} (ear crop)` : rawLabel,
          score,
          bbox: {
            x: Math.min(1, px / vw),
            y: Math.min(1, py / vh),
            width: Math.min(1, pw / vw),
            height: Math.min(1, ph / vh),
          },
        });
      }
    }
    return out;
  } catch {
    return []; // crop pass is best-effort — never crash the detection loop
  }
}

let statsCanvas: HTMLCanvasElement | null = null;

/** Mean brightness / colourfulness of one normalized box of the video frame. */
function boxPixelStats(video: HTMLVideoElement, box: BBox): PixelStats | null {
  const vw = video.videoWidth, vh = video.videoHeight;
  const sw = box.width * vw, sh = box.height * vh;
  if (sw < 2 || sh < 2) return null;
  statsCanvas ??= document.createElement("canvas");
  statsCanvas.width = 24;
  statsCanvas.height = 24;
  const ctx = statsCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, box.x * vw, box.y * vh, sw, sh, 0, 0, 24, 24);
  const px = ctx.getImageData(0, 0, 24, 24).data;
  let lum = 0, sat = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    lum += (r + g + b) / 3;
    sat += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const n = px.length / 4;
  return { lum: lum / n / 255, sat: sat / n / 255 };
}

/** Drop detector "phones" the trained verifier rejects (hands at the chin, beards, shirt folds). */
function verifyPhones(dets: Detection[], video: HTMLVideoElement, face: BBox | null): Detection[] {
  return dets.filter((d) => {
    if (d.kind !== "phone") return true;
    if (acceptPhoneWithoutFace(d.score, d.bbox, face)) {
      pushObjectSample(`verify ${d.label} ${Math.round(d.score * 100)}% → accepted (no face)`);
      return true;
    }
    try {
      const px = boxPixelStats(video, d.bbox);
      if (!px) return true;
      const p = phoneLikelihood(d.score, d.bbox, face, px);
      pushObjectSample(`verify ${d.label} ${Math.round(d.score * 100)}% → ${Math.round(p * 100)}%${p < PHONE_VERIFY_MIN ? " rejected" : ""}`);
      return p >= PHONE_VERIFY_MIN;
    } catch {
      return true;
    }
  });
}

/**
 * White earbuds (AirPods-style) read as a compact patch of bright, colourless
 * pixels inside the ear zone that is far brighter than the cheek. Returns a
 * synthetic detection so it still needs tracker confirmation like any object.
 */
function whiteEarbudAt(video: HTMLVideoElement, ear: BBox, face: BBox): Detection | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const S = 48;
  try {
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    // Cheek reference: centre-left of the face box.
    ctx.drawImage(video, (face.x + face.width * 0.25) * vw, (face.y + face.height * 0.55) * vh, face.width * 0.15 * vw, face.height * 0.12 * vh, 0, 0, 8, 8);
    const cheek = ctx.getImageData(0, 0, 8, 8).data;
    let skin = 0;
    for (let i = 0; i < cheek.length; i += 4) skin += (cheek[i] + cheek[i + 1] + cheek[i + 2]) / 3;
    skin /= cheek.length / 4;

    ctx.drawImage(video, ear.x * vw, ear.y * vh, ear.width * vw, ear.height * vh, 0, 0, S, S);
    const px = ctx.getImageData(0, 0, S, S).data;
    const gate = Math.max(195, skin + 70);
    let bright = 0, sx = 0, sy = 0, edge = 0;
    for (let i = 0, n = 0; i < px.length; i += 4, n++) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const lum = (r + g + b) / 3;
      if (lum >= gate && Math.max(r, g, b) - Math.min(r, g, b) < 38) {
        bright++;
        const x = n % S, y = Math.floor(n / S);
        sx += x;
        sy += y;
        if (x === 0 || y === 0 || x === S - 1 || y === S - 1) edge++;
      }
    }
    const frac = bright / (S * S);
    if (frac < 0.006 || frac > 0.07) return null; // none, or a lit wall/window
    // A bud sits inside the ear; brightness reaching the crop edge is the wall
    // or window behind the head (76/199 bud-free frames flagged before this).
    if (edge > 0) return null;
    let spread = 0;
    const mx = sx / bright, my = sy / bright;
    for (let i = 0, n = 0; i < px.length; i += 4, n++) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if ((r + g + b) / 3 >= gate && Math.max(r, g, b) - Math.min(r, g, b) < 38) {
        spread += Math.hypot((n % S) - mx, Math.floor(n / S) - my);
      }
    }
    if (spread / bright > S * 0.18) return null; // scattered highlights, not one object
    const score = Math.min(0.6, 0.25 + frac * 5);
    const bw = (Math.sqrt(bright) / S) * ear.width * 1.6;
    return {
      kind: "earbuds",
      label: "white earbud at ear",
      score,
      bbox: { x: ear.x + (mx / S) * ear.width - bw / 2, y: ear.y + (my / S) * ear.height - bw / 2, width: bw, height: bw },
    };
  } catch {
    return null;
  }
}

let sampleCanvas: HTMLCanvasElement | null = null;

/** RGBA pixels of a normalized region of the video, scaled to w×h. */
function sampleVideo(video: HTMLVideoElement, box: BBox, w: number, h: number): Uint8ClampedArray | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  try {
    sampleCanvas ??= document.createElement("canvas");
    sampleCanvas.width = w;
    sampleCanvas.height = h;
    const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y);
    const x1 = Math.min(1, box.x + box.width), y1 = Math.min(1, box.y + box.height);
    if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return null;
    ctx.drawImage(video, x0 * vw, y0 * vh, (x1 - x0) * vw, (y1 - y0) * vh, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
}

function darkEarbudAt(video: HTMLVideoElement, ear: EarPatch): Detection | null {
  const px = sampleVideo(video, ear.box, DARK_BUD.SIZE, DARK_BUD.SIZE);
  if (!px || !isDarkEarbud(px)) return null;
  return { kind: "earbuds", label: "dark earbud at ear", score: 0.6, bbox: ear.box };
}

const FULL_FRAME: BBox = { x: 0, y: 0, width: 1, height: 1 };
const EDGE_LEFT: BBox = { x: 0, y: 0.15, width: 0.4, height: 0.85 };
const EDGE_RIGHT: BBox = { x: 0.6, y: 0.15, width: 0.4, height: 0.85 };

// ── Component ────────────────────────────────────────────────────────────────
export default function ProctorAI({ cameraStream, active, onViolation, onStatus }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // MediaPipe model instances (kept alive between re-renders)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const faceDetRef  = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const landmarkRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objDetRef   = useRef<any>(null);     // VIDEO mode for full-frame
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const objDetRoiRef = useRef<any>(null);    // IMAGE mode for desk-ROI crop

  // Engine singletons (stable for the component's lifetime; created once in an
  // effect so refs are never touched during render). They survive active/pause
  // cycles — only a true unmount (leaving the exam) discards risk + cooldowns.
  const trackerRef = useRef<ObjectTracker | null>(null);
  const gateRef    = useRef<ViolationGate | null>(null);
  const riskRef    = useRef<RiskEngine | null>(null);
  const riskShown  = useRef<string>("");

  useEffect(() => {
    trackerRef.current ??= new ObjectTracker();
    gateRef.current ??= new ViolationGate();
    riskRef.current ??= new RiskEngine();
  }, []);

  // Latest gaze state, consumed by fusion when an object confirms.
  const gazeFusion = useRef<{ headDown: boolean; headDownSince: number | null; direction: "center" | "left" | "right" | "up" | "down" }>({
    headDown: false,
    headDownSince: null,
    direction: "center",
  });

  // Audio analysis
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioBufRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  // Rolling ambient-noise floor for the adaptive voice gate (see AUDIO config).
  const noiseFloorRef = useRef(0.004);
  const noiseFloorAtRef = useRef(0);

  // Timing refs
  const rafRef   = useRef(0);
  const tFace    = useRef(0);
  const tGaze    = useRef(0);
  const tPhone   = useRef(0);
  const tAudio   = useRef(0);
  const lastAck  = useRef(0);
  const lastEarbudsAck = useRef(0);
  const lastEarbudsVisualAck = useRef(0);
  const faceGeoRef = useRef<FaceGeometry | null>(null);
  const earPatchRef = useRef<{ at: number; patches: EarPatch[] } | null>(null);
  const cropTurn = useRef(0);
  const frameDims = useRef(""); // diag: log the frame size once per change
  const personSeenAt = useRef(-Infinity);
  // rAF fps measurement (diagnostics)
  const fpsFrames = useRef(0);

  // Behavioral pattern detection for mobile phone use outside camera frame
  // Detects suspicious patterns like sustained head-down + hand movement
  const behavioralRef = useRef({
    headDownStartTime: null as number | null,
    frameDiffHistory: [] as Uint8ClampedArray[],
    suspiciousBehaviorStreak: 0,
    lastAnalysisTime: 0,
  });
  const fpsAt     = useRef(0);

  const [status, setStatus] = useState<AIStatus>({
    loading: true,
    loadStep: "Preparing AI proctor…",
    error: false,
    faceCount: 0,
    gazeDirection: "center",
    gazeScore: 1,
    phoneDetected: false,
    voiceLevel: 0,
    voiceSpeaking: false,
  });

  // Grab a small JPEG frame from the camera <video> as tamper-evident evidence.
  const captureEvidence = useCallback((): Blob | undefined => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return undefined;
    try {
      const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      const ctx = c.getContext("2d");
      if (!ctx) return undefined;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.55);
      return dataUrl.length > 0 ? dataUrlToBlob(dataUrl) : undefined;
    } catch {
      return undefined;
    }
  }, []);

  // Push the current risk state to React only when it actually changed
  // (keeps the parent from re-rendering on every tick).
  const syncRisk = useCallback(() => {
    const risk = riskRef.current;
    if (!risk) return;
    const s = risk.state;
    const key = `${s.score}:${s.level}`;
    if (key === riskShown.current) return;
    riskShown.current = key;
    proctorDiag.risk = s;
    setStatus((prev) => ({ ...prev, riskScore: s.score, riskLevel: s.level }));
  }, []);

  // Violation emitter: cooldown gate (dedupe) / risk / evidence frame / parent.
  const emit = useCallback(
    (category: ProctorCategory, label: string, confidence: number) => {
      const now = Date.now();
      const gate = gateRef.current;
      const risk = riskRef.current;
      if (!gate || !risk) return;
      if (!gate.allows(category, now)) return;
      gate.markFired(category, now);
      risk.add(category, now);
      syncRisk();
      onViolation({ type: category, label, confidence, at: now, evidenceBlob: captureEvidence() });
    },
    [onViolation, captureEvidence, syncRisk]
  );

  // Reset identity tracking when the camera stream changes (new session /
  // resolution) so stale boxes never follow the wrong candidate.
  useEffect(() => {
    trackerRef.current?.reset();
  }, [cameraStream]);

  // Feed camera stream into hidden video element
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !cameraStream) return;
    v.srcObject = cameraStream;
    void v.play().catch(() => {});
    return () => { v.srcObject = null; };
  }, [cameraStream]);

  // Web Audio API & Speech Recognition for voice / noise detection
  useEffect(() => {
    if (!cameraStream || !active) return;
    if (!cameraStream.getAudioTracks().length) return;

    // Web Audio API
    const ctx      = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(cameraStream).connect(analyser);

    // Browsers start a fresh AudioContext SUSPENDED unless it was created in a
    // direct user-gesture call stack — and the exam flow creates this one from
    // an effect, so RMS read 0 forever and voice was never detected. resume()
    // flips it to running; if the browser still blocks it, retry once on the
    // next user interaction.
    if (ctx.state !== "running") {
      void ctx.resume().then(() => {
        if (ctx.state !== "running") {
          console.warn("[ProctorAI] AudioContext suspended — voice detection idle until first user interaction");
          const kick = () => {
            void ctx.resume();
            window.removeEventListener("pointerdown", kick);
            window.removeEventListener("keydown", kick);
          };
          window.addEventListener("pointerdown", kick, { once: true });
          window.addEventListener("keydown", kick, { once: true });
        }
      }).catch(() => {});
    }

    audioCtxRef.current = ctx;
    analyserRef.current = analyser;
    audioBufRef.current = new Float32Array(new ArrayBuffer(analyser.frequencyBinCount * 4));

    // Web Speech API for lightweight STT
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    let recognition: any = null;
    let sttAlive = false;
    if (SpeechRecognition) {
      sttAlive = true;
      recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = false;

      const stopwords = new Set(["the", "is", "at", "which", "on", "a", "an", "and", "in", "it"]);

      recognition.onresult = (event: any) => {
        const transcript = event.results[event.results.length - 1][0].transcript.toLowerCase();
        const words = transcript.split(/\s+/).filter((w: string) => !stopwords.has(w) && w.length > 2);
        if (words.length > 0) {
          emit("audio_detected", `Speech detected: "${words.join(" ")}"`, 0.95);
        }
      };

      // Chrome ENDS the recognition stream after each utterance (and after
      // ~60 s even with continuous=true). Without an onend restart the STT
      // went silent one minute into every exam. Restart with a small backoff
      // until the effect tears down; 'not-allowed' means the mic was revoked.
      recognition.onend = () => {
        if (!sttAlive) return;
        window.setTimeout(() => {
          if (!sttAlive) return;
          try { recognition.start(); } catch { /* already started */ }
        }, 250);
      };
      recognition.onerror = (e: any) => {
        if (e?.error === "not-allowed" || e?.error === "service-not-allowed") sttAlive = false;
      };

      try { recognition.start(); } catch { /* ignore */ }
    }

    return () => {
      sttAlive = false;
      void ctx.close();
      audioCtxRef.current = null;
      analyserRef.current = null;
      if (recognition) {
        try { recognition.stop(); } catch { /* ignore */ }
      }
    };
  }, [cameraStream, active, emit]);

  // Load MediaPipe models once; singletons survive unmount/remount.
  // Every model is created with the GPU delegate first, and automatically
  // falls back to CPU when the GPU is unsupported (iOS Safari / many phones
  // throw on WebGL GPU delegates — previously AI silently never started there).
  //
  // Each model also tries its SOURCE LIST (same-origin copy first, CDN mirror
  // second) with retry + backoff, so a flaky or blocked network can't leave
  // the AI engine half-loaded — the root cause of "proctoring never detects".
  useEffect(() => {
    if (!active) return;
    let alive = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createWithFallback = async (make: (delegate: "GPU" | "CPU") => Promise<any>, step: string) => {
      setStatus(s => ({ ...s, loadStep: step }));
      try {
        return await make("GPU");
      } catch {
        console.warn(`[ProctorAI] GPU delegate unavailable for ${step} — retrying on CPU`);
        return make("CPU");
      }
    };

    // Try each asset source (same-origin / CDN) with 2 retries + backoff so a
    // transient network failure on a big file doesn't kill the model.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withRetry = async (make: (source: string) => Promise<any>, sources: string[], step: string): Promise<any> => {
      let lastErr: unknown = null;
      for (const source of sources) {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            setStatus(s => ({ ...s, loadStep: `${step} — retry ${attempt}/2…` }));
            await new Promise(r => setTimeout(r, 800 * attempt));
          }
          try {
            return await make(source);
          } catch (err) {
            lastErr = err;
            console.warn(`[ProctorAI] ${step} failed (${source}, attempt ${attempt + 1}):`, err);
          }
        }
      }
      throw lastErr ?? new Error(`${step} failed`);
    };

    void (async () => {
      try {
        setStatus(s => ({ ...s, loadStep: "Loading AI engine (first run ~10 s)…" }));
        const vision = await getVision();
        if (!alive) return;

        const { FaceDetector, FaceLandmarker, ObjectDetector } = await import("@mediapipe/tasks-vision");

        if (!faceDetRef.current) {
          faceDetRef.current = await withRetry(
            (source) => createWithFallback(
              (delegate) =>
                FaceDetector.createFromOptions(vision, {
                  baseOptions: { modelAssetPath: source, delegate },
                  runningMode: "VIDEO",
                  minDetectionConfidence: 0.5,
                }),
              "Loading face detector…",
            ),
            MODEL_FACE_DET_SOURCES,
            "face detector",
          );
        }
        if (!alive) return;

        if (!landmarkRef.current) {
          landmarkRef.current = await withRetry(
            (source) => createWithFallback(
              (delegate) =>
                FaceLandmarker.createFromOptions(vision, {
                  baseOptions: { modelAssetPath: source, delegate },
                  runningMode: "VIDEO",
                  numFaces: 3,
                  outputFaceBlendshapes: true,
                  outputFacialTransformationMatrixes: true,
                }),
              "Loading gaze tracker…",
            ),
            MODEL_FACE_LM_SOURCES,
            "gaze tracker",
          );
        }
        if (!alive) return;

        if (!objDetRef.current) {
          objDetRef.current = await withRetry(
            (source) => createWithFallback(
              (delegate) =>
                ObjectDetector.createFromOptions(vision, {
                  baseOptions: { modelAssetPath: source, delegate },
                  runningMode: "VIDEO",
                  scoreThreshold: OBJECT.SCORE_THRESHOLD,
                  maxResults: OBJECT.MAX_RESULTS,
                }),
              "Loading object detector…",
            ),
            MODEL_OBJ_DET_SOURCES,
            "object detector",
          );
        }
        if (!alive) return;

        // IMAGE-mode detector for the desk-ROI second pass (can't reuse VIDEO mode)
        if (!objDetRoiRef.current) {
          objDetRoiRef.current = await withRetry(
            (source) => createWithFallback(
              (delegate) =>
                ObjectDetector.createFromOptions(vision, {
                  baseOptions: { modelAssetPath: source, delegate },
                  runningMode: "IMAGE",
                  scoreThreshold: OBJECT.SCORE_THRESHOLD,
                  maxResults: OBJECT.MAX_RESULTS,
                }),
              "Loading desk-ROI object detector…",
            ),
            MODEL_OBJ_DET_SOURCES,
            "desk-ROI object detector",
          );
        }
        if (!alive) return;

        setStatus(s => ({ ...s, loading: false, loadStep: "AI proctor active" }));
      } catch (err) {
        console.error("[ProctorAI] model load error:", err);
        if (alive) {
          proctorDiag.engineError = err instanceof Error ? err.message : String(err);
          setStatus(s => ({ ...s, loading: false, error: true, loadStep: "AI unavailable — manual review only" }));
        }
      }
    })();

    return () => { alive = false; };
  }, [active]);

  // Main detection loop. Every decision is gated on a SUSTAINED condition (a
  // single jitter frame never flags) and — for gaze — on deviation from the
  // student's own calibrated neutral pose, which removes camera-angle bias.
  // Object events additionally require TEMPORAL CONFIRMATION (ObjectTracker)
  // and are fused with the head pose (fusion.ts).
  useEffect(() => {
    if (!active || status.loading) return;
    let running = true;
    const gaze = freshGaze();
    const absence = new AbsenceMonitor();
    const lips = new LipActivity();
    let lastLipEmit = 0;
    let multiFaceStreak = 0;
    let framingStreak = 0;
    let lastFraming: Framing = "ok";
    let audioStreak = 0;
    let earbudsStreak = 0;
    let landmarksVisible = false;

    // 1 Hz risk decay — clean behavior steadily lowers the score.
    const decayId = window.setInterval(() => {
      riskRef.current?.advance();
      syncRisk();
    }, 1_000);

    const tick = () => {
      if (!running) return;
      const now   = Date.now();
      const video = videoRef.current;

      // Diagnostics: fps (only needed for the dev overlay — cheap math).
      if (fpsAt.current === 0) fpsAt.current = now;
      fpsFrames.current += 1;
      if (now - fpsAt.current >= 1_000) {
        proctorDiag.fps = Math.round((fpsFrames.current * 1_000) / (now - fpsAt.current));
        fpsFrames.current = 0;
        fpsAt.current = now;
      }

      if (!video || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // ── Gaze / head pose (runs first — landmarks also veto no_face) ─────
      if (landmarkRef.current && now - tGaze.current > GAZE_MS) {
        tGaze.current = now;
        try {
          const lmResult = landmarkRef.current.detectForVideo(video, now) as {
            faceLandmarks: Array<Array<{ x: number; y: number; z: number }>>;
            faceBlendshapes?: Array<{ categories?: Array<{ categoryName?: string; score?: number }> }>;
            facialTransformationMatrixes?: Array<{ data?: number[] }>;
          };
          const { faceLandmarks } = lmResult;
          landmarksVisible = faceLandmarks.length > 0;
          faceGeoRef.current = landmarksVisible ? faceGeometryFromLandmarks(faceLandmarks[0], now) : null;
          earPatchRef.current = landmarksVisible ? { at: now, patches: earPatches(faceLandmarks[0]) } : null;
          if (!landmarksVisible) lips.reset();
          if (landmarksVisible) {
            const lms = faceLandmarks[0];
            const pose = poseFromMatrix(lmResult.facialTransformationMatrixes?.[0]?.data);
            const blend = blendshapeScores(lmResult.faceBlendshapes?.[0]?.categories);

            // Seating check: ~1 s of bad framing shows the student a hint; it is
            // logged once per ~6 s while it lasts.
            const framing = classifyFraming(lms);
            framingStreak = framing === "ok" ? 0 : framingStreak + 1;
            const shown: Framing = framingStreak >= FRAMING_SUSTAIN ? framing : "ok";
            if (shown !== lastFraming) {
              lastFraming = shown;
              setStatus(s => ({ ...s, framing: shown }));
            }
            if (shown !== "ok" && (framingStreak === FRAMING_SUSTAIN || framingStreak % 40 === 0)) {
              emit("partial_face", FRAMING_HINT[shown], 0.8);
            }

            const g = estimateGaze(lms);
            const pitchDelta = g.pitch - gaze.pitch; // + = looking down (nose lower)
            const devPitch = Math.abs(pitchDelta);
            // Absolute pose when the landmarker provides it: the ratio yaw
            // reads a rolled, tilted-down head as a turn.
            const usePose = pose !== null && gaze.poseSamples > 0;
            const posePitchRel = usePose ? pose.pitch - gaze.posePitch : 0;
            const downScore = usePose ? lookDownScore(blend, posePitchRel) : 0;
            // Turn strength in "threshold units": >= 1 means turned away.
            const yawUnits = usePose
              ? (pose.yaw - gaze.poseYaw) / HEAD_POSE.TURN_DEG
              : (g.yaw - gaze.yaw) / GAZE.DEVIATION;
            // With the pose model, the nose/eye ratio is not used for "down": on a
            // low camera it moved more with posture than with real look-downs
            // (0/14 caught, every false "head tilted down" flag in that session).
            const lookingDown = usePose
              ? isLookingDown(blend, posePitchRel) || posePitchRel >= HEAD_POSE.DOWN_DEG
              : pitchDelta >= GAZE.PITCH_DOWN;
            const lookingAwayYaw = Math.abs(yawUnits) >= 1;
            const lookingUp = usePose ? posePitchRel <= -HEAD_POSE.UP_DEG : pitchDelta <= -GAZE.DEVIATION;
            const dev = Math.max(devPitch, Math.abs(yawUnits) * GAZE.DEVIATION);
            updateGazeBaseline(gaze, g, lookingDown ? Math.max(dev, GAZE.DEVIATION) : dev, pose);

            // Talking: repeated lip open/close while roughly facing the camera.
            if (Math.abs(yawUnits) < 1.5) {
              const cycles = lips.update(mouthOpenRatio(lms), now);
              if (cycles >= LIPS.MIN_CYCLES && now - lastLipEmit >= LIPS.REPEAT_MS) {
                lastLipEmit = now;
                emit("audio_detected", "Lip movement — student appears to be talking", 0.75);
              }
            }

            if (gaze.calibrated) {
              const neutral = !lookingAwayYaw && !lookingDown && !lookingUp;
              if (neutral) {
                gaze.awayStreak = Math.max(0, gaze.awayStreak - 1);
                gaze.clearStreak += 1;
                if (gaze.clearStreak >= GAZE.CLEAR_SAMPLES) gaze.awayStreak = 0;
              } else {
                gaze.clearStreak = 0;
                gaze.awayStreak += 1;
              }

              let dir: AIStatus["gazeDirection"] = "center";
              if (gaze.awayStreak >= GAZE.SUSTAIN_SAMPLES && !neutral) {
                // Prefer pitch-down when the head tilts toward the desk/phone —
                // that is the signal students report as "not detecting look down".
                if (lookingDown) {
                  dir = "down";
                } else if (lookingAwayYaw) {
                  dir = yawUnits < 0 ? "left" : "right";
                } else {
                  dir = "up";
                }
                const conf = lookingDown
                  ? usePose
                    ? Math.min(1, Math.max(downScore / (LOOK_DOWN.MIN * 1.3), posePitchRel / (HEAD_POSE.DOWN_DEG * 1.5)))
                    : Math.min(1, Math.max(devPitch, GAZE.PITCH_DOWN) / (GAZE.DEVIATION * 3))
                  : Math.min(1, dev / (GAZE.DEVIATION * 3));
                // Re-emit whenever the short gate allows — continuous look-down /
                // look-away logging, not one flag then a long silent window.
                if (gaze.awayStreak === GAZE.SUSTAIN_SAMPLES || gaze.awayStreak % 2 === 0) {
                  emit("gaze_away", gazeLabel(dir), conf);
                }
              }

              // Feed the fusion layer: sustained head-down state + direction.
              const wasDown = gazeFusion.current.headDown;
              gazeFusion.current.direction = dir;
              if (dir === "down" && gaze.awayStreak >= GAZE.SUSTAIN_SAMPLES) {
                if (!wasDown) gazeFusion.current.headDownSince = now;
                gazeFusion.current.headDown = true;
              } else {
                gazeFusion.current.headDown = false;
                gazeFusion.current.headDownSince = null;
              }

              setStatus(s => ({ ...s, gazeDirection: dir, gazeScore: Math.max(0, Math.min(1, 1 - dev / (GAZE.DEVIATION * 3))) }));

              // ── Behavioral pattern detection for mobile phone use ──────
              // Detect sustained head-down + frame movement that suggests
              // the candidate is looking at something below the screen (phone)
              if (dir === "down" && gaze.awayStreak >= GAZE.SUSTAIN_SAMPLES) {
                if (!behavioralRef.current.headDownStartTime) {
                  behavioralRef.current.headDownStartTime = now;
                }
                const headDownDuration = now - behavioralRef.current.headDownStartTime;

                // Analyze frame for hand movement (suggesting holding a phone)
                if (videoRef.current && now - behavioralRef.current.lastAnalysisTime > 500) {
                  behavioralRef.current.lastAnalysisTime = now;
                  try {
                    const canvas = document.createElement("canvas");
                    canvas.width = 64;
                    canvas.height = 48;
                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                      // Capture lower portion of frame (where hands/phone would be)
                      ctx.drawImage(
                        videoRef.current,
                        0, videoRef.current.videoHeight * 0.5,
                        videoRef.current.videoWidth, videoRef.current.videoHeight * 0.5,
                        0, 0, 64, 48
                      );
                      const frameData = ctx.getImageData(0, 0, 64, 48).data;

                      // Calculate frame difference to detect movement
                      if (behavioralRef.current.frameDiffHistory.length > 0) {
                        const lastFrame = behavioralRef.current.frameDiffHistory[behavioralRef.current.frameDiffHistory.length - 1];
                        if (lastFrame) {
                          let diff = 0;
                          for (let i = 0; i < frameData.length; i += 4) {
                            diff += Math.abs(frameData[i]! - lastFrame[i]!);
                          }
                          diff /= (frameData.length / 4);

                          // Significant movement while head is down = suspicious
                          if (diff > 15 && headDownDuration > 3000) {
                            behavioralRef.current.suspiciousBehaviorStreak++;
                            if (behavioralRef.current.suspiciousBehaviorStreak >= 3) {
                              emit("possible_phone_use", "Suspicious behavior detected — possible mobile device use below camera view", 0.7);
                              behavioralRef.current.suspiciousBehaviorStreak = 0;
                            }
                          } else if (diff < 5) {
                            behavioralRef.current.suspiciousBehaviorStreak = Math.max(0, behavioralRef.current.suspiciousBehaviorStreak - 1);
                          }
                        }
                      }

                      // Store frame data for comparison (copy the array)
                      const frameCopy = new Uint8ClampedArray(frameData.length);
                      frameCopy.set(frameData);
                      behavioralRef.current.frameDiffHistory.push(frameCopy);
                      if (behavioralRef.current.frameDiffHistory.length > 5) {
                        behavioralRef.current.frameDiffHistory.shift();
                      }
                    }
                  } catch { /* ignore frame analysis errors */ }
                }
              } else {
                behavioralRef.current.headDownStartTime = null;
                behavioralRef.current.suspiciousBehaviorStreak = 0;
                behavioralRef.current.frameDiffHistory = [];
              }
            }
          } else {
            // No landmarks — head state is unknown, so fusion must not treat
            // stale "head down" as ongoing.
            gazeFusion.current.headDown = false;
            gazeFusion.current.headDownSince = null;
            gazeFusion.current.direction = "center";
            framingStreak = 0;
            if (lastFraming !== "ok") {
              lastFraming = "ok";
              setStatus(s => ({ ...s, framing: "ok" }));
            }
            behavioralRef.current.headDownStartTime = null;
            behavioralRef.current.suspiciousBehaviorStreak = 0;
            behavioralRef.current.frameDiffHistory = [];
          }
        } catch { /* model busy */ }
      }

      // ── Face count (landmarks veto the "no face" false positive) ────────
      if (faceDetRef.current && now - tFace.current > FACE_MS) {
        tFace.current = now;
        try {
          const { detections } = faceDetRef.current.detectForVideo(video, now) as { detections: Array<{ categories: Array<{ score: number }> }> };
          const confident = detections.filter(d => d.categories[0]?.score >= FACE.MIN_CONF).length;
          const absent = absence.update(confident === 0 && !landmarksVisible, now);
          if (confident > 1) multiFaceStreak += 1;
          else multiFaceStreak = 0;

          // A face hidden behind a phone is not an empty seat.
          const phoneCoveringFace = trackerRef.current?.live.some(
            (t) => t.kind === "phone" && now - t.lastSeen <= 1_500 && t.bbox.width * t.bbox.height >= 0.05,
          );
          if (absent) {
            if (phoneCoveringFace) {
              emit("possible_phone_use", "Face hidden behind a phone held up to the camera", 0.9);
            } else {
              const px = sampleVideo(video, FULL_FRAME, 32, 24);
              const personSeen = now - personSeenAt.current <= ABSENCE.PERSON_RECENT_MS;
              const kind = px ? classifyAbsence(frameStats(px), personSeen) : "out_of_frame";
              emit(kind === "object" ? "possible_phone_use" : "no_face", ABSENCE_LABEL[kind][absent], 0.9);
            }
          }
          if (multiFaceStreak === FACE.SUSTAIN) {
            emit("multiple_faces", `${confident} people detected — only one person is allowed`, 0.9);
          } else if (multiFaceStreak > FACE.SUSTAIN && multiFaceStreak % 6 === 0) {
            emit("multiple_faces", `${confident} people still in frame`, 0.9);
          }
          setStatus(s => ({ ...s, faceCount: landmarksVisible ? Math.max(confident, 1) : confident }));
        } catch { /* model busy */ }
      }

      // ── Object detection: track + confirm, then fuse with head pose ─────
      // (moderate cadence — the heaviest model; raw frames never become events)
      if (objDetRef.current && now - tPhone.current > OBJECT_MS) {
        tPhone.current = now;
        try {
          // TWo-PASS DETECTION for maximum phone sensitivity:
          //   1. the full frame,
          //   2. a zoomed crop of the lower desk/hands region (where phones are
          //      held) — small phones the model misses at full-frame size are
          //      caught on the upsized crop, then the boxes are mapped back to
          //      full-frame normalized coordinates before tracking.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result: any = objDetRef.current.detectForVideo(video, now);
          let dets: Detection[] = toDetections(result, video);

          if (OBJECT.USE_PHONE_ROI && video.videoWidth > 0 && video.videoHeight > 0) {
            // One zoomed crop per tick keeps the loop fast; each region is
            // revisited every ~0.5 s.
            const face = faceGeoRef.current && now - faceGeoRef.current.at <= 700 ? faceGeoRef.current : null;
            // Ears every other tick (earbuds are tiny); desk and edges share the rest.
            const turn = cropTurn.current++ % 6;
            const shownEars = face ? face.ears.filter((_, i) => (face.earVisible[i] ?? 0) >= REFINE.EAR_MIN_VISIBLE) : [];
            if ((turn === 1 || turn === 3 || turn === 5) && face) {
              for (const ear of shownEars) {
                dets.push(...detectRegion(ear, video, objDetRoiRef.current, true));
              }
            } else if (turn === 2) dets.push(...detectRegion(EDGE_LEFT, video, objDetRoiRef.current));
            else if (turn === 4) dets.push(...detectRegion(EDGE_RIGHT, video, objDetRoiRef.current));
            else dets.push(...detectRegion(lowerRegion(OBJECT.PHONE_ROI_FRACTION), video, objDetRoiRef.current));
            if (face) {
              for (const ear of shownEars) {
                const white = whiteEarbudAt(video, ear, face.face);
                if (white) dets.push(white);
              }
            }
            const ears = earPatchRef.current && now - earPatchRef.current.at <= 700 ? earPatchRef.current.patches : [];
            for (const ear of ears) {
              if (ear.visible < DARK_BUD.MIN_VISIBLE) continue;
              const dark = darkEarbudAt(video, ear);
              if (dark) dets.push(dark);
            }
            dets = refineDetections(dets, face, now);
          }
          dets = verifyPhones(dets, video, faceGeoRef.current && now - faceGeoRef.current.at <= 700 ? faceGeoRef.current.face : null);

          // Diagnostics: log EVERY raw detection the model returns — benign
          // objects, sub-threshold phones, low scores included — plus the
          // frame size once, so a missing phone can be traced to the model
          // output (label / index / confidence / box), never guessed at.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = (result?.detections ?? []) as Array<{
            categories?: Array<{ categoryName?: string; score?: number; index?: number }>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            boundingBox?: any;
          }>;
          const vw = video.videoWidth || 0;
          const vh = video.videoHeight || 0;
          if (frameDims.current !== `${vw}x${vh}`) {
            frameDims.current = `${vw}x${vh}`;
            pushObjectSample(`frame ${vw}x${vh}`);
          }
          if (raw.length === 0) pushObjectSample("(no objects)");
          for (const d of raw) {
            const c = d.categories?.[0];
            if (!c) continue;
            if (c.categoryName === "person" && (c.score ?? 0) >= 0.3) personSeenAt.current = now;
            const b = d.boundingBox ?? {};
            const box = [Number(b.originX ?? 0).toFixed(2), Number(b.originY ?? 0).toFixed(2), Number(b.width ?? 0).toFixed(2), Number(b.height ?? 0).toFixed(2)].join(",");
            pushObjectSample(`${c.categoryName ?? "?"} ${Math.round((c.score ?? 0) * 100)}% idx=${c.index ?? "?"} box=(${box})`);
          }

          const tracker = trackerRef.current;
          if (tracker) {
            const fresh = tracker.update(dets, now);
            for (const track of fresh) {
              const outcome = decideObjectEvent(track, gazeFusion.current, now);
              if (outcome.fired) emit(outcome.category, outcome.label, outcome.confidence);
              if (track.kind === "phone") lastAck.current = now; // fresh confirm — reset the heartbeat
              if (track.kind === "earbuds") lastEarbudsVisualAck.current = now;
            }
          }

          const earbudsTrack = tracker?.live.find(
            (t) => t.kind === "earbuds" && t.confirmed && now - t.lastSeen <= 3_000
          );
          if (earbudsTrack && now - lastEarbudsVisualAck.current >= EARBUDS_VISUAL_ACK_MS) {
            lastEarbudsVisualAck.current = now;
            emit("earbuds_detected", `Earbuds still visible at the ear (${Math.round(earbudsTrack.peak * 100)}% conf)`, earbudsTrack.peak);
          }

          // Slow re-acknowledgement while a CONFIRMED phone stays in view.
          const liveConfirmed = tracker?.live.some(
            (t) => t.kind === "phone" && t.confirmed && now - t.lastSeen <= 4_000
          );
          if (liveConfirmed && now - lastAck.current >= PHONE_ACK_MS) {
            lastAck.current = now;
            const track = tracker?.live.find(
              (t) => t.kind === "phone" && t.confirmed && now - t.lastSeen <= 4_000
            );
            if (track) {
              const outcome = decideObjectEvent(track, gazeFusion.current, now);
              if (outcome.fired) emit(outcome.category, outcome.label, outcome.confidence);
            }
          }

          setStatus(s => ({ ...s, phoneDetected: liveConfirmed === true }));
        } catch { /* skip */ }
      }

      // ── Audio / voice (sustained before flagging) ──────
      if (analyserRef.current && audioBufRef.current && now - tAudio.current > AUDIO_MS) {
        tAudio.current = now;
        analyserRef.current.getFloatTimeDomainData(audioBufRef.current);
        const rms = Math.sqrt(
          audioBufRef.current.reduce((acc, v) => acc + v * v, 0) / audioBufRef.current.length
        );
        // Adaptive gate: track the AMBIENT noise floor (rolling min ≈ the
        // quietest 5 s window) and require speech to clear a multiple of it —
        // quiet laptop mics peaked at 0.02 RMS, far under the old fixed 0.04.
        const floor = noiseFloorRef.current;
        if (rms < floor) {
          noiseFloorRef.current = floor + (rms - floor) * 0.05; // fast fall
        } else if (now - noiseFloorAtRef.current > 5_000) {
          noiseFloorRef.current = floor + (rms - floor) * 0.02; // slow rise
          noiseFloorAtRef.current = now;
        }
        const voiceGate = Math.max(AUDIO.VOICE_RMS_MIN, noiseFloorRef.current * AUDIO.VOICE_NOISE_FACTOR);
        const voiceLevel    = Math.min(1, rms / Math.max(0.06, voiceGate * 2));
        const voiceSpeaking = rms > voiceGate;
        if (voiceSpeaking) audioStreak += 1;
        else audioStreak = Math.max(0, audioStreak - 1);
        if (audioStreak === AUDIO.SUSTAIN) {
          emit("audio_detected", "Sustained voice or unexpected audio detected", voiceLevel);
        } else if (audioStreak > AUDIO.SUSTAIN && audioStreak % 12 === 0) {
          emit("audio_detected", "Voice/audio still detected", voiceLevel);
        }

        // ── Earbud/headphone leak detection ─────────────────────────────────
        // A faint PERSISTENT BROADBAND signal is the earbud-leak signature:
        // music/lecture audio spreads energy across many bins between 250 Hz
        // and 8 kHz, while silence has none and mechanical noise (fan, AC)
        // concentrates in a handful of low bins. Speech is EXCLUDED here —
        // direct speech is loud (rms above the leak window) and intermittent.
        //
        // The old heuristic never fired in the field: it demanded the RMS sit
        // in a razor-thin window AND two per-band averages exceed floors no
        // real leak reaches (byte spectrum values are tiny when energy is
        // spread thin). The new rule counts ACTIVE BINS, not average energy.
        if (
          analyserRef.current &&
          rms >= AUDIO.EARBUDS_RMS_MIN &&
          rms <= AUDIO.EARBUDS_RMS_MAX &&
          !voiceSpeaking
        ) {
          const freqData = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(freqData);

          const binHz = analyserRef.current.context.sampleRate / 2 / freqData.length;
          const lowIdx  = Math.max(1, Math.ceil(AUDIO.EARBUDS_FREQ_LOW / binHz));
          const highIdx = Math.min(freqData.length - 1, Math.floor(AUDIO.EARBUDS_FREQ_HIGH / binHz));

          // Count bins with meaningful energy — broadband content keeps many
          // bins above the floor; tonal/mechanical noise keeps only a few.
          let activeBins = 0;
          for (let i = lowIdx; i <= highIdx; i++) {
            if (freqData[i] >= AUDIO.EARBUDS_ACTIVE_BIN_FLOOR) activeBins += 1;
          }

          if (activeBins >= AUDIO.EARBUDS_MIN_ACTIVE_BINS) {
            earbudsStreak += 1;
            if (earbudsStreak === AUDIO.EARBUDS_SUSTAIN) {
              lastEarbudsAck.current = now;
              emit(
                "earbuds_detected",
                `Audio leak consistent with earbuds/headphones (${activeBins} active frequency bands, sustained)`,
                Math.min(0.9, 0.4 + activeBins / 64),
              );
            } else if (
              earbudsStreak > AUDIO.EARBUDS_SUSTAIN &&
              now - lastEarbudsAck.current >= AUDIO.EARBUDS_ACK_MS
            ) {
              // Still leaking — re-notify so the log shows ongoing presence.
              lastEarbudsAck.current = now;
              emit(
                "earbuds_detected",
                "Audio leak still present — earbuds/headphones likely in use",
                Math.min(0.9, 0.4 + activeBins / 64),
              );
            }
          } else {
            earbudsStreak = Math.max(0, earbudsStreak - 1);
          }
        } else {
          earbudsStreak = Math.max(0, earbudsStreak - 1);
        }

        setStatus(s => ({ ...s, voiceLevel, voiceSpeaking: voiceSpeaking && audioStreak >= 2 }));
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      window.clearInterval(decayId);
      cancelAnimationFrame(rafRef.current);
    };
  }, [active, status.loading, emit, syncRisk]);

  // Propagate status to parent
  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  // Mirror live status + tracks into the diag sink for the dev overlay. The
  // sink lives outside React so the AI loop itself never triggers renders.
  useEffect(() => {
    proctorDiag.loadStep = status.loadStep;
    proctorDiag.faceCount = status.faceCount;
    proctorDiag.gazeDirection = status.gazeDirection;
    proctorDiag.gazeScore = status.gazeScore;
    proctorDiag.phoneDetected = status.phoneDetected;
    proctorDiag.voiceLevel = status.voiceLevel;
    proctorDiag.voiceSpeaking = status.voiceSpeaking;
    proctorDiag.tracks = trackerRef.current?.live ?? [];
  }, [status]);

  // The analysis <video> must stay in the document at a REAL (painted) size:
  // iOS Safari stops decoding frames for 0x0 / display:none video elements, so
  // detection silently never fires on phones. It renders transparent at the
  // bottom corner — invisible to the student, but WebKit keeps advancing frames.
  return (
    <>
      <div className="pointer-events-none fixed bottom-1 left-1 z-[-1] h-[180px] w-[240px] opacity-0">
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full" />
      </div>
      <ProctorDebugOverlay enabled={env.proctorDebug} />
    </>
  );
}
