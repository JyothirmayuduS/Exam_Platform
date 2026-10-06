// ────────────────────────────────────────────────────────────────────────────
// Central tuning for the Proctor AI engine. Every magic number used to be
// spread across ProctorAI.tsx; it now lives in ONE place so thresholds,
// cadence and confirmation rules are auditable and adjustable without
// touching the detection loop.
// ────────────────────────────────────────────────────────────────────────────

import type { ProctorCategory } from "@/features/proctoring/domain/types";

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
  OBJECT_MS: 120,   // object detection: full frame + ONE rotating zoomed crop
                    // (desk, left edge, right edge, ears) per tick; 2 hits
                    // confirm a phone in ~0.25 s of visibility
  AUDIO_MS: 80,     // voice RMS — faster for earbud audio detection
} as const;

// While a CONFIRMED phone stays in view we re-notify at this cadence (well
// past the per-category cooldown) so the log shows ongoing presence without
// spamming.
export const PHONE_ACK_MS = 3_000;
/** Same heartbeat for earbuds confirmed visually at the ear. */
export const EARBUDS_VISUAL_ACK_MS = 5_000;

// ── Gaze / head pose ─────────────────────────────────────────────────────────
export const GAZE = {
  // Deviation (nose/eye-ratio units) from the student's OWN calibrated neutral
  // that counts as "looking away". Pitch (look-down) uses a slightly lower
  // gate because desk/phone glances are smaller than left/right head turns.
  DEVIATION: 0.08,
  /** Pitch-only threshold — looking down at a desk/phone. */
  PITCH_DOWN: 0.055,
  // Samples of near-neutral pose required before the baseline is locked.
  // Instant first-frame calibration made "looking down" disappear when the
  // student started the exam already glancing at papers.
  CALIBRATE_SAMPLES: 12,
  // A condition must persist this many consecutive samples before it is
  // reported (one jitter frame never fires). ~0.6 s at GAZE_MS=150.
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
  SCORE_THRESHOLD: 0.08, // passed to the model (keep low — gating happens here)
  MAX_RESULTS: 10,
  // Dropped from 0.18 to 0.10: real-world tests (including the user's
  // recent test) showed phones held at arm's length or half-hidden behind
  // hands top out at very low confidence. The temporal confirmation (MIN_HITS
  // inside CONFIRM_WINDOW_MS) still filters one-frame flukes, so a lower
  // per-sample gate is safe and necessary for consistent detection.
  PHONE_MIN_CONF: 0.10,
  // 0.08 flagged 23/199 bud-free frames from ear-crop noise; 0.15 plus the
  // ear-visibility gate keeps the real bud hits.
  EARBUDS_MIN_CONF: 0.15,
  LAPTOP_MIN_CONF: 0.30,
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
  // after it has been visibly present for roughly 0.2 s.
  MIN_HITS: 2,
  // Consecutive samples an object may be invisible before its identity is
  // dropped (~1.5 s of short-term persistence at 300 ms cadence). One missed
  // frame must not kill the track; three in a row means it left the frame.
  // Zoomed crops rotate every 4 ticks, so an edge phone is only seen every
  // ~0.5 s; 8 misses (~1 s) keeps its identity between visits.
  MAX_MISSES: 8,
  CONFIRM_WINDOW_MS: 3_000,
  // Keep recent scores per track for smoothing + diagnostics.
  MAX_HISTORY: 12,
  // A track seen within this window adopts the nearest same-kind box even
  // with no overlap — a phone moved fast up/down jumps across the frame.
  FAST_MOTION_MS: 1_200,
  // One sighting this confident confirms at once (motion blur rarely gives
  // a second clean frame).
  INSTANT_CONFIRM_SCORE: 0.75,
} as const;

// ── Audio ────────────────────────────────────────────────────────────────────
export const AUDIO = {
  // Voice gate — ADAPTIVE, not fixed. A fixed 0.04 RMS missed quiet laptop
  // mics entirely (field test: speech peaked at 0.02 RMS). The gate is now
  // max(VOICE_RMS_MIN, ambient noise floor × VOICE_NOISE_FACTOR) where the
  // floor is a rolling estimate of the QUIETEST ambient RMS (~5 s window).
  // VOICE_RMS_MIN is the absolute floor so a silent room never makes rustle
  // paper count as speech.
  VOICE_RMS_MIN: 0.012,   // absolute floor — never flag below this
  VOICE_NOISE_FACTOR: 3,  // speech must exceed 3× the ambient noise floor
  SUSTAIN: 3,       // ~0.45 s of sustained sound before flagging — faster response
  // ── Earbud/headphone leak detection ────────────────────────────────────────
  // Earbuds leak only a FAINT signal into the mic (far quieter than direct
  // speech). Its signature: persistent (never pauses like speech), low-level,
  // and BROADBAND (music/content spreads energy across many frequency bins,
  // while silence has ~none and fan/hum noise concentrates in a few low bins).
  EARBUDS_RMS_MIN: 0.004,     // floor — below this the mic sees silence
  EARBUDS_RMS_MAX: 0.055,     // above the adaptive voice gate it is direct speech, not a leak
  EARBUDS_MIN_ACTIVE_BINS: 5, // broadband content gate (250 Hz – 8 kHz)
  EARBUDS_ACTIVE_BIN_FLOOR: 2,   // byte-spectrum value a bin must exceed to count as active
  EARBUDS_FREQ_LOW: 250,      // Hz — ignore sub-250 Hz rumble (AC, traffic)
  EARBUDS_FREQ_HIGH: 8000,    // Hz — cap (mic rolloff above this is noise)
  EARBUDS_SUSTAIN: 4,         // consecutive samples (~0.3 s at AUDIO_MS=80) before flagging
  EARBUDS_ACK_MS: 30_000,     // re-notify while the leak persists (cooldown still applies)
} as const;

// ── Cooldowns (per category) ─────────────────────────────────────────────────
// Minimum ms between two back-to-back violations of the SAME category. This is
// the dedupe layer — a genuine incident is logged once and repeated only after
// the cooldown elapses, never spammed every frame.
// Same-category anti-spam only. Kept short so a second look-down / phone /
// face event a few seconds later is still logged — the old 8–15s windows
// dropped everything that happened while the banner was up.
export const COOLDOWN_MS: Record<ProctorCategory, number> = {
  no_face:         800,
  multiple_faces:  800,
  partial_face:    800,
  gaze_away:       800,
  possible_phone_use: 800,
  phone_detected:  800,
  earbuds_detected: 800,
  laptop_detected: 800,
  audio_detected:  800,
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
