// ────────────────────────────────────────────────────────────────────────────
// Core proctoring types — shared vocabulary for the whole Proctor AI engine.
// The engine is DOM-free (pure logic) so every module here is unit-testable.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Machine id of every violation the engine can raise. These are the STABLE
 * keys (used for cooldowns, risk weights, dedupe). The human-readable text a
 * teacher sees is derived separately — a category never embeds an accusation.
 */
export type ProctorCategory =
  // face
  | "no_face"          // camera shows nobody
  | "multiple_faces"   // more than one person in frame
  | "partial_face"     // face cut off / drifting out of frame
  // head pose / gaze
  | "gaze_away"        // sustained deviation from the calibrated neutral pose
  | "possible_phone_use" // phone CONFIRMED in view while head is tilted down
  // objects
  | "phone_detected"   // phone confirmed in view (head neutral)
  | "laptop_detected"  // laptop/tv/monitor confirmed in view
  // audio
  | "audio_detected";  // sustained voice / speech

/** Normalized [0..1] bounding box — fractions of the source frame. */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ObjectKind = "phone" | "laptop" | "tv" | "monitor";

/**
 * A classified object detection coming out of the raw model output.
 * `label` is the raw model label (COCO etc.) kept for diagnostics; `kind` is
 * the normalized category the engine reasons about.
 */
export interface Detection {
  kind: ObjectKind;
  label: string;
  score: number;
  bbox: BBox;
}

/**
 * A persistent, identity-tracked object. The tracker matches raw detections
 * frame-to-frame (IoU) so a phone that blinks out for one sample is NOT
 * forgotten and re-flagged — it keeps its id, history and streak.
 */
export interface TrackedObject {
  id: number;
  kind: ObjectKind;
  label: string;
  bbox: BBox;
  firstSeen: number;
  lastSeen: number;
  /** Consecutive positive samples (not reset by a single missed frame). */
  hits: number;
  /** Consecutive samples where the object was not detected. */
  misses: number;
  peak: number;
  lastScore: number;
  /** All recent scores, for smoothing / diagnostics. */
  confidenceHistory: number[];
  /** True once the object has satisfied the temporal confirmation rule. */
  confirmed: boolean;
  confirmedAt: number | null;
}

/** Severity bucket attached to stored violations. */
export type ProctorSeverity = "warning" | "high" | "critical";

/** One emitted, deduped violation the UI/backend consumes. */
export interface ProctorViolation {
  category: ProctorCategory;
  label: string;
  confidence: number;
  severity: ProctorSeverity;
  at: number;
  /** Object tracking info when the violation is object-backed. */
  track?: { id: number; kind: ObjectKind; hits: number; peak: number } | null;
}

export type RiskLevel = "normal" | "low" | "high" | "critical";

export interface RiskState {
  score: number; // 0..100
  level: RiskLevel;
}
