// ────────────────────────────────────────────────────────────────────────────
// Signal fusion — the layer that decides WHAT a teacher should be told.
//
// The whole point of this module: a head-down pose and a phone in view are
// DIFFERENT events and must never be conflated.
//
//   • head tilted down, no phone visible  / gaze_away ("looking away")
//   • phone confirmed, head neutral       / phone_detected
//   • phone confirmed WHILE head is down  / possible_phone_use (escalated)
//
// Only the last one claims the candidate may be using the phone — and it
// requires two independent signals, each confirmed on its own.
// ────────────────────────────────────────────────────────────────────────────

import type { ProctorCategory, TrackedObject } from "./types";
import { kindName } from "./labels";

export interface GazeFusionState {
  /** Sustained head-down (past the confirmation window), false otherwise. */
  headDown: boolean;
  /** ms since the head-down streak started (0 when not head-down). */
  headDownSince: number | null;
  /** Active sustained direction, when any. */
  direction: "center" | "left" | "right" | "up" | "down";
}

export type FusionOutcome =
  | { fired: false }
  | { fired: true; category: ProctorCategory; label: string; confidence: number };

/**
 * Decide what an object confirmation means given the current head pose.
 * `track` is a freshly CONFIRMED tracked object (never a raw single frame).
 */
export function decideObjectEvent(track: TrackedObject, gaze: GazeFusionState, now: number): FusionOutcome {
  if (track.kind === "earbuds") {
    const pct = Math.round(track.peak * 100);
    return {
      fired: true,
      category: "earbuds_detected",
      label: `Earbuds/headphones detected in view (${pct}% conf · ${track.hits} confirmed samples)`,
      confidence: track.peak,
    };
  }
  if (track.kind === "phone") {
    const pct = Math.round(track.peak * 100);
    const hits = track.hits;

    // Head down within the last ~1.5 s while the phone is confirmed / the one
    // escalation that actually implicates the candidate.
    const headDownNow =
      gaze.headDown && gaze.headDownSince !== null && now - gaze.headDownSince <= 2_000;

    if (headDownNow) {
      return {
        fired: true,
        category: "possible_phone_use",
        label: `Possible phone use — phone in view (${pct}% conf) while head tilted down`,
        confidence: track.peak,
      };
    }
    return {
      fired: true,
      category: "phone_detected",
      label: `Mobile phone detected in view (${pct}% conf · ${hits} confirmed samples)`,
      confidence: track.peak,
    };
  }

  // Other electronics — laptop / tv / monitor at high confidence only.
  return {
    fired: true,
    category: "laptop_detected",
    label: `Electronic device visible: ${kindName(track.kind)} (${Math.round(track.peak * 100)}% conf)`,
    confidence: track.peak,
  };
}

/**
 * Human label for a sustained gaze direction. NOTE the down case: it says the
 * student is looking away — it never claims a phone is involved. Phones are
 * only mentioned by decideObjectEvent, and only after confirmation.
 */
export function gazeLabel(direction: GazeFusionState["direction"]): string {
  switch (direction) {
    case "left":  return "Head turned left / looking away from the screen";
    case "right": return "Head turned right / looking away from the screen";
    case "up":    return "Looking up — away from the screen";
    case "down":  return "Head tilted down — looking away from the screen";
    default:      return "Looking away from the screen";
  }
}

/** Reference labels for tests + docs (kept in sync by the fusion module). */
export const FUSION_LABELS = {
  gazeDown: gazeLabel("down"),
} as const;
