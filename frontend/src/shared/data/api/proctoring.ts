// ──────────────────────────────────────────────────────────────────────────
// Domain module: proctoring — extracted from src/shared/data/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "@/shared/data/supabase";
import type { ViolationSeverity, ViolationSource } from "@/shared/data/api/types";
import { severityForType, sourceForType, isRealUuid } from "@/shared/data/api/helpers";
import { logAudit } from "@/shared/data/api/audit";
import { examOffsetSeconds } from "@/shared/services/examClock";

/**
 * Record one proctoring flag or proctor action in violation_events.
 *
 * `attemptId` may be a placeholder like `enrolled-<uuid>` when the candidate
 * has not started yet — in that case the row is linked to the student only.
 * The event is timestamped relative to the attempt start (offset_seconds) so
 * the recording review can place red markers on the seek bar.
 */
export async function saveViolation(
  attemptId: string | null,
  examId: string,
  studentId: string,
  violationType: string,
  description: string,
  extra: { severity?: ViolationSeverity; source?: ViolationSource; snapshotKey?: string | null } = {},
): Promise<boolean> {
  // Preserve the detection moment BEFORE auth/database round trips. Otherwise
  // slow networking moves a voice warning underneath a later camera frame.
  const detectedAt = Date.now();
  const db = getSupabase();
  if (!db) return false;

  // Resolve the authenticated caller's student row — reject if the
  // caller cannot be matched to a student (no demo fallback in
  // production; staff bypass this check below).
  let callerStudentId: string | null = null;
  try {
    const { data: userData } = await db.auth.getUser();
    const user = userData?.user;
    if (user) {
      const { data: stu } = await db.from("students").select("id").eq("auth_id", user.id).maybeSingle();
      callerStudentId = stu?.id ?? null;
    }
  } catch { /* treated as non-student below */ }

  // Students may only log violations for themselves; staff may log for anyone.
  if (callerStudentId && callerStudentId !== studentId) {
    console.error("Violation write denied: caller student_id mismatch");
    return false;
  }

  // Offset = seconds since the attempt started (needed for the red seek-bar
  // markers). On the student's device it is measured by the same clock as the
  // recording (examClock); elsewhere from the attempt's server start time.
  let realAttemptId: string | null = isRealUuid(attemptId ?? "") ? attemptId : null;
  let offsetSeconds: number | null = realAttemptId ? examOffsetSeconds(realAttemptId, detectedAt) : null;
  try {
    if (realAttemptId && offsetSeconds == null) {
      const { data: att } = await db
        .from("attempts")
        .select("started_at")
        .eq("id", realAttemptId)
        .maybeSingle();
      const started = att?.started_at ? new Date(att.started_at as string).getTime() : null;
      if (started) offsetSeconds = Math.max(0, Math.floor((detectedAt - started) / 1000));
    }
  } catch { /* offset is best-effort */ }

  const { error } = await db.from("violation_events").insert({
    attempt_id: realAttemptId,
    exam_id: examId,
    student_id: studentId,
    violation_type: violationType,
    severity: extra.severity ?? severityForType(violationType),
    source: extra.source ?? sourceForType(violationType),
    description,
    created_at: new Date(detectedAt).toISOString(),
    offset_seconds: offsetSeconds,
    snapshot_key: extra.snapshotKey ?? null,
  });

  if (error) {
    console.error("Failed to save violation:", error);
    return false;
  }
  return true;
}


export async function forceSubmitAttempt(attemptId: string): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { error } = await db
    .from("attempts")
    .update({ state: "submitted", submitted_at: new Date().toISOString() })
    .eq("id", attemptId);
  if (!error) {
    void logAudit({ action: "attempt.force_submitted", targetType: "attempt", targetId: attemptId });
  }
  return !error;
}

/** Pause or resume a candidate's attempt (proctor control). */


export async function setAttemptPaused(
  attemptId: string,
  paused: boolean,
): Promise<boolean> {
  const db = getSupabase();
  if (!db || !isRealUuid(attemptId)) return false;
  const { error } = await db
    .from("attempts")
    .update({ state: paused ? "paused" : "in_progress" })
    .eq("id", attemptId);
  if (!error) void logAudit({ action: paused ? "attempt.paused" : "attempt.resumed", targetType: "attempt", targetId: attemptId });
  return !error;
}

export const MAX_LIVE_EXTRA_MINUTES = 120;

export type ExtendTimeResult =
  | { ok: true; extraMinutes: number; secondsLeft: number | null }
  | { ok: false; reason: "forbidden" | "not_live" | "invalid" | "unavailable"; message: string };

/** Add minutes to a live attempt. Only the teacher who owns the exam may do
 *  this; the database checks ownership, moves the deadline and writes the
 *  audit row (who, how many, when) in one transaction. The student's
 *  countdown picks the change up over realtime. */
export async function extendAttemptTime(attemptId: string, minutes: number): Promise<ExtendTimeResult> {
  const db = getSupabase();
  if (!db || !isRealUuid(attemptId)) return { ok: false, reason: "unavailable", message: "This candidate has no live attempt." };
  const m = Math.round(minutes);
  if (!Number.isFinite(m) || m < 1 || m > MAX_LIVE_EXTRA_MINUTES) {
    return { ok: false, reason: "invalid", message: `Enter between 1 and ${MAX_LIVE_EXTRA_MINUTES} minutes.` };
  }
  const { data, error } = await db.rpc("add_attempt_extra_minutes", { p_attempt: attemptId, p_minutes: m });
  if (error) {
    if (error.code === "42501") return { ok: false, reason: "forbidden", message: "Only the teacher who owns this exam can add time." };
    if (error.code === "P0001") return { ok: false, reason: "not_live", message: "This attempt is no longer in progress." };
    if (error.code === "22023") return { ok: false, reason: "invalid", message: `Enter between 1 and ${MAX_LIVE_EXTRA_MINUTES} minutes.` };
    return { ok: false, reason: "unavailable", message: "Could not add time — try again." };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { extra_minutes?: number; seconds_left?: number | null } | null;
  return {
    ok: true,
    extraMinutes: Number(row?.extra_minutes ?? 0),
    secondsLeft: typeof row?.seconds_left === "number" ? row.seconds_left : null,
  };
}

/** True when the signed-in user is the teacher who owns this exam. */
export async function ownsExam(examId: string): Promise<boolean> {
  const db = getSupabase();
  if (!db || !examId) return false;
  const { data, error } = await db.rpc("owns_exam", { p_exam: examId });
  return !error && data === true;
}

// ── Proctor chat & broadcast messages ────────────────────────────────────────
