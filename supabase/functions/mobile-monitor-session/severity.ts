/**
 * Severity scoring for mobile monitor events — shared between the
 * mobile-monitor-session edge function and the test suite.
 *
 * Rules (spec):
 *   - Duration-aware: <5 s minor, 5–20 s moderate, >20 s major
 *   - Disconnect-class events (heartbeat missed, camera/feed killed) are
 *     major regardless of duration
 *   - Repeated events escalate: 3+ repeats minor→moderate, 6+ → major
 */

export const EVENT_TYPES = [
  "QR_SCANNED",
  "CAMERA_PERMISSION_GRANTED",
  "CAMERA_PERMISSION_DENIED",
  "CAMERA_STARTED",
  "CAMERA_STOPPED",
  "LIVEKIT_CONNECTED",
  "LIVEKIT_DISCONNECTED",
  "VISIBILITY_HIDDEN",
  "VISIBILITY_VISIBLE",
  "FOCUS_LOST",
  "FOCUS_REGAINED",
  "VIEWPORT_RESIZED",
  "NO_FACE_DETECTED",
  "FACE_REACQUIRED",
  "HEARTBEAT_MISSED",
  "SNAPSHOT_FALLBACK_ACTIVE",
  "SESSION_ENDED",
  "TERMINATED",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_SET = new Set<string>(EVENT_TYPES);

export function isKnownEventType(type: string): boolean {
  return EVENT_SET.has(type);
}

const DEFAULT_SEVERITY: Record<string, "minor" | "moderate" | "major"> = {
  QR_SCANNED: "minor",
  CAMERA_PERMISSION_GRANTED: "minor",
  CAMERA_PERMISSION_DENIED: "major",
  CAMERA_STARTED: "minor",
  CAMERA_STOPPED: "major",
  LIVEKIT_CONNECTED: "minor",
  LIVEKIT_DISCONNECTED: "major",
  VISIBILITY_HIDDEN: "minor",
  VISIBILITY_VISIBLE: "minor",
  FOCUS_LOST: "minor",
  FOCUS_REGAINED: "minor",
  VIEWPORT_RESIZED: "minor",
  NO_FACE_DETECTED: "minor",
  FACE_REACQUIRED: "minor",
  HEARTBEAT_MISSED: "major",
  SNAPSHOT_FALLBACK_ACTIVE: "minor",
  SESSION_ENDED: "minor",
  TERMINATED: "minor",
};

/**
 * Duration-aware severity: <5 s minor, 5–20 s moderate, >20 s (or a
 * disconnect-class event) major. Repeats escalate one level at 3 and 6.
 */
export function severityFor(
  type: string,
  durationMs?: number,
  repeatCount = 0,
): "minor" | "moderate" | "major" {
  if (durationMs != null && durationMs > 0) {
    if (durationMs > 20_000) return "major";
    if (durationMs >= 5_000) return "moderate";
  }
  let sev = DEFAULT_SEVERITY[type] ?? "minor";
  if (repeatCount >= 3 && sev === "minor") sev = "moderate";
  if (repeatCount >= 6 && sev !== "major") sev = "major";
  return sev;
}
