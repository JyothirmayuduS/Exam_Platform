// ────────────────────────────────────────────────────────────────────────────
// ViolationEngine — dedupe / cooldown gate + severity mapping.
//
// Every confirmed condition passes through here BEFORE it reaches the UI and
// the backend. The gate guarantees one category can never spam: after a
// gaze_away fires, another gaze_away is suppressed for COOLDOWN_MS, so a
// student glancing away once is logged once — not 40 times.
// ────────────────────────────────────────────────────────────────────────────

import type { ProctorCategory, ProctorSeverity } from "./types";
import { COOLDOWN_MS } from "./config";

/** Severity implied by a category (mirrors lib/api/helpers.ts by keyword). */
export function severityFor(category: ProctorCategory): ProctorSeverity {
  switch (category) {
    case "multiple_faces": return "critical";
    case "possible_phone_use":
    case "phone_detected":
    case "earbuds_detected":
    case "no_face":
    case "audio_detected":
      return "high";
    default:
      return "warning";
  }
}

export class ViolationGate {
  private lastFired = new Map<ProctorCategory, number>();

  /**
   * True when a violation of this category is currently allowed to fire
   * (cooldown elapsed since the previous one of the same category).
   */
  allows(category: ProctorCategory, now = Date.now()): boolean {
    const last = this.lastFired.get(category);
    return last === undefined || now - last >= (COOLDOWN_MS[category] ?? 8_000);
  }

  /** Record that a violation fired (call after allows() returned true). */
  markFired(category: ProctorCategory, now = Date.now()): void {
    this.lastFired.set(category, now);
  }

  reset(): void {
    this.lastFired.clear();
  }
}
