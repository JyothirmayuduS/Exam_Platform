// ────────────────────────────────────────────────────────────────────────────
// Central tuning for the Proctor AI engine. Every magic number used to be
// spread across ProctorAI.tsx; it now lives in ONE place so thresholds,
// cadence and confirmation rules are auditable and adjustable without
// touching the detection loop.
// ────────────────────────────────────────────────────────────────────────────

import type { ProctorCategory } from "./types";

// ── Detection cadence ────────────────────────────────────────────────────────
// The heavy models NEVER run at camera fps. Cadence:
//   camera frames      → rAF (gaze/face read the same <video>)
//   face landmark/gaze → GAZE_MS
//   face detector      → FACE_MS
//   object detector    → OBJECT_MS (heaviest model — slowest cadence)
//   audio RMS          → AUDIO_MS
export const CADENCE = {
  GAZE_MS: 250,     // head-pose / gaze estimation
  FACE_MS: 500,     // face count
  OBJECT_MS: 500,   // object detection (phone / laptop / …) — fast enough that
                    // 3 hits can confirm a phone within ~2–3 s of visibility
  AUDIO_MS: 400,    // voice RMS
} as const;

// While a CONFIRMED phone stays in view we re-notify at this cadence (well
// past the per-category cooldown) so the log shows ongoing presence without
// spamming.
export const PHONE_ACK_MS = 25_000;

// ── Gaze / head pose ─────────────────────────────────────────────────────────
export const GAZE = {
  // Deviation (nose/eye-ratio units) from the student's OWN calibrated neutral
  // that counts as "looking away". 0.14 ≈ a clear head turn — 0.10 flagged
  // students who merely read the top of a tall monitor or shifted in their
  // seat (the classic "[AI] Looking up" false positive on a webcam mounted
  // below eye level).
  DEVIATION: 0.14,
  // A condition must persist this many consecutive samples before it is
  // reported (one jitter frame never fires). 6 samples @250 ms ≈ 1.5 s.
  SUSTAIN_SAMPLES: 6,
  // Samples back inside neutral before a flag can re-arm.
  CLEAR_SAMPLES: 6,
  // Head-down must persist at least this long to count as "sustained down"
  // for phone/gaze fusion.
  HEAD_DOWN_MS: 1_200,
} as const;

// ── Face count ───────────────────────────────────────────────────────────────
export const FACE = {
  MIN_CONF: 0.6,     // face-detector confidence gate
  LANDMARK_MIN_CONF: 0.45, // landmark presence gate
  SUSTAIN: 6,        // ~3 s of no-face at FACE_MS=500 before flagging
} as const;

// ── Object detection thresholds ──────────────────────────────────────────────
export const OBJECT = {
  SCORE_THRESHOLD: 0.15, // passed to the model (keep low — gating happens here)
  MAX_RESULTS: 6,
  PHONE_MIN_CONF: 0.28,
  LAPTOP_MIN_CONF: 0.40,
  // MediaPipe object detector only sees a phone when it's big enough in the
  // frame. Small phones slip through — candidates keep track of the lower
  // frame region for phones (see geometry.ts). Toggling the ROI means the
  // detector runs an additional pass on the desk area.
  USE_PHONE_ROI: true,
  PHONE_ROI_FRACTION: 0.60, // bottom 60% of the frame = typical desk / hands zone
} as const;

// ── Temporal confirmation (object tracking) ─────────────────────────────────
// A phone must be seen MIN_HITS times within CONFIRM_WINDOW_MS before it is
// "confirmed" — a single 0.46-confidence flash never becomes a violation.
export const TRACKING = {
  // IoU above which two boxes are the same object. Lowered for small/moving
  // objects; tracker also uses center-distance fallback for robustness.
  IOU_THRESHOLD: 0.15,
  // Confirmation = MIN_HITS positive samples seen inside CONFIRM_WINDOW_MS.
  // With the 500 ms detector cadence that means a phone is confirmed only
  // after it has been visibly present for roughly 1–2 s.
  MIN_HITS: 2,
  // Consecutive samples an object may be invisible before its identity is
  // dropped (~1.5 s of short-term persistence at 500 ms cadence). One missed
  // frame must not kill the track; three in a row means it left the frame.
  MAX_MISSES: 3,
  CONFIRM_WINDOW_MS: 4_500,
  // Keep recent scores per track for smoothing + diagnostics.
  MAX_HISTORY: 12,
} as const;

// ── Audio ────────────────────────────────────────────────────────────────────
export const AUDIO = {
  VOICE_RMS: 0.05,  // RMS amplitude above which we treat sound as voice
  SUSTAIN: 4,       // ~1.6 s of sustained sound before flagging
} as const;

// ── Cooldowns (per category) ─────────────────────────────────────────────────
// Minimum ms between two back-to-back violations of the SAME category. This is
// the dedupe layer — a genuine incident is logged once and repeated only after
// the cooldown elapses, never spammed every frame.
export const COOLDOWN_MS: Record<ProctorCategory, number> = {
  no_face:         8_000,
  multiple_faces:  8_000,
  partial_face:    8_000,
  gaze_away:      10_000,
  possible_phone_use: 12_000,
  phone_detected: 10_000,
  laptop_detected: 10_000,
  audio_detected:  8_000,
};

// ── Risk engine ──────────────────────────────────────────────────────────────
export const RISK = {
  // Points added the first time a category is confirmed. Confirmations matter
  // far more than raw observations.
  WEIGHTS: {
    no_face:          20,
    multiple_faces:   50,
    partial_face:     10,
    gaze_away:         8,
    possible_phone_use: 55,
    phone_detected:   35,
    laptop_detected:  15,
    audio_detected:   12,
  } as Record<ProctorCategory, number>,
  // Each category can only contribute its weight once per incident; a second
  // violation of the same type while the first is still "fresh" adds nothing.
  INCIDENT_WINDOW_MS: 60_000,
  // Exponential decay — risk fades back to 0 over ~2 minutes of clean behavior
  // (decay per ms of clean time).
  DECAY_PER_MS: 1 / 180_000,
  MAX: 100,
  LEVELS: {
    normal: [0, 29],
    low: [30, 59],
    high: [60, 79],
    critical: [80, 100],
  } as Record<"normal" | "low" | "high" | "critical", [number, number]>,
};

// ── Evidence capture ─────────────────────────────────────────────────────────
export const EVIDENCE = {
  MAX_CAPTURE_WIDTH: 480,
  JPEG_QUALITY: 0.55,
} as const;
