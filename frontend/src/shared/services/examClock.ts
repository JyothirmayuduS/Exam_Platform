// Exam time on the student's own clock.
//
// The recording timeline starts when the first recorder started on this
// device, measured by this device's clock. Violation markers line up with it
// only when their offset is measured by the same clock, so the device keeps
// the moment the attempt started here and offsets are taken from that. The
// mark survives a page reload; an attempt resumed on another device has no
// mark there, and offsets fall back to the attempt's server start time.

const key = (attemptId: string) => `vignan.examClock.${attemptId}`;

/** Remember when this attempt started on this device (kept if already set). */
export function markExamStart(attemptId: string, now = Date.now()): number {
  const existing = examStartOnThisDevice(attemptId);
  if (existing != null) return existing;
  try { localStorage.setItem(key(attemptId), String(now)); } catch { /* storage unavailable */ }
  return now;
}

export function examStartOnThisDevice(attemptId: string): number | null {
  try {
    const v = Number(localStorage.getItem(key(attemptId)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Whole seconds from the attempt's start on this device to `atMs`, or null. */
export function examOffsetSeconds(attemptId: string, atMs: number): number | null {
  const start = examStartOnThisDevice(attemptId);
  return start == null ? null : Math.max(0, Math.floor((atMs - start) / 1000));
}
