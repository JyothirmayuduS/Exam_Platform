// ────────────────────────────────────────────────────────────────────────────
// Central tuning for the Proctor AI engine. Every magic number used to be
// spread across ProctorAI.tsx; it now lives in ONE place so thresholds,
// cadence and confirmation rules are auditable and adjustable without
// touching the detection loop.
// ────────────────────────────────────────────────────────────────────────────

import type { ProctorCategory } from "./types";

// ── Detection cadence ────────────────────────────────────────────────────────
// The heavy models NEVER run at camera fps. Cadence:
//   camera frames      / rAF (gaze/face read the same <video>)
//   face landmark/gaze / GAZE_MS
//   face detector      / FACE_MS
//   object detector    / OBJECT_MS (heaviest model — slowest cadence)
//   audio RMS          / AUDIO_MS
export const CADENCE = {
  GAZE_MS: 150,     // head-pose / gaze estimation — faster for quicker detection
  FACE_MS: 200,     // face count — reduced for faster no-face detection
  OBJECT_MS: 250,   // object detection (phone / laptop) — 2 hits confirm a
                    // phone in ~0.5 s of visibility
  AUDIO_MS: 150,    // voice RMS — faster for earbud audio detection
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
  SUSTAIN_SAMPLES: 4,
  // Samples back inside neutral before a flag can re-arm.
  CLEAR_SAMPLES: 4,
  // Head-down must persist at least this long to count as "sustained down"
  // for phone/gaze fusion.
  HEAD_DOWN_MS: 1_200,
} as const;

// ── Face count ───────────────────────────────────────────────────────────────
export const FACE = {
  MIN_CONF: 0.5,     // face-detector confidence gate — lowered for better detection
  LANDMARK_MIN_CONF: 0.4, // landmark presence gate
  // ~0.6 s of no-face at FACE_MS=200 before flagging — the candidate must be
  // gone ~1.5 s total (first missed sample + streak) before the flag fires.
  SUSTAIN: 3,
} as const;

// ── Object detection thresholds ──────────────────────────────────────────────
export const OBJECT = {
  SCORE_THRESHOLD: 0.15, // passed to the model (keep low — gating happens here)
  MAX_RESULTS: 10,
  // Dropped from 0.28 / 0.22: real-world tests showed phones held at arm's
  // length or half-hidden behind a hand top out at 22–30% confidence, which
  // the old gate silently discarded. The temporal confirmation (MIN_HITS
  // inside CONFIRM_WINDOW_MS) still filters one-frame flukes, so a lower
  // per-sample gate is safe.
  PHONE_MIN_CONF: 0.22,
  EARBUDS_MIN_CONF: 0.25,
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
  // With the 250 ms detector cadence that means a phone is confirmed only
  // after it has been visibly present for roughly 0.5 s.
  MIN_HITS: 2,
  // Consecutive samples an object may be invisible before its identity is
  // dropped (~1.5 s of short-term persistence at 300 ms cadence). One missed
  // frame must not kill the track; three in a row means it left the frame.
  MAX_MISSES: 4,
  CONFIRM_WINDOW_MS: 3_000,
  // Keep recent scores per track for smoothing + diagnostics.
  MAX_HISTORY: 12,
} as const;

// ── Audio ────────────────────────────────────────────────────────────────────
export const AUDIO = {
  VOICE_RMS: 0.04,  // RMS amplitude above which we treat sound as voice — lowered for better detection
  SUSTAIN: 3,       // ~0.45 s of sustained sound before flagging — faster response
  // ── Earbud/headphone leak detection ────────────────────────────────────────
  // Earbuds leak only a FAINT signal into the mic (far quieter than direct
  // speech). Its signature: persistent (never pauses like speech), low-level,
  // and BROADBAND (music/content spreads energy across many frequency bins,
  // while silence has ~none and fan/hum noise concentrates in a few low bins).
  EARBUDS_RMS_MIN: 0.008,     // floor — below this the mic sees silence
  EARBUDS_RMS_MAX: 0.045,     // above VOICE_RMS it is direct speech, not a leak
  EARBUDS_MIN_ACTIVE_BINS: 8, // broadband content gate (250 Hz – 8 kHz)
  EARBUDS_ACTIVE_BIN_FLOOR: 4,   // byte-spectrum value a bin must exceed to count as active
  EARBUDS_FREQ_LOW: 250,      // Hz — ignore sub-250 Hz rumble (AC, traffic)
  EARBUDS_FREQ_HIGH: 8000,    // Hz — cap (mic rolloff above this is noise)
  EARBUDS_SUSTAIN: 8,         // consecutive samples (~1.2 s at AUDIO_MS=150) before flagging
  EARBUDS_ACK_MS: 30_000,     // re-notify while the leak persists (cooldown still applies)
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
  earbuds_detected: 15_000,
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
    earbuds_detected: 40,
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
