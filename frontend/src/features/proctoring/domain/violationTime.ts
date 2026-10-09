// Where a violation sits on the recording, in seconds of exam time.
//
// offset_seconds is measured from the attempt's start by the device that
// flagged it (the student's clock for flags raised in the exam), which is the
// clock the recording timeline uses. Rows without it (server watchdog flags)
// are placed by created_at minus the attempt's start, both server times.
// Never compare a server insert time with the student PC's clock.

export function violationExamSeconds(
  v: { offset_seconds?: number | null; created_at?: string | null },
  attemptStartedAt?: string | null,
): number | null {
  if (v.offset_seconds != null && Number.isFinite(v.offset_seconds)) return Math.max(0, v.offset_seconds);
  if (attemptStartedAt && v.created_at) {
    const d = Date.parse(v.created_at) - Date.parse(attemptStartedAt);
    if (Number.isFinite(d)) return Math.max(0, d / 1000);
  }
  return null;
}
