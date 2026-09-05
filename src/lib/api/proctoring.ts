// ──────────────────────────────────────────────────────────────────────────
// Domain module: proctoring — extracted from src/lib/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "../supabase";
import type { ViolationSeverity, ViolationSource } from "./types";
import { severityForType, sourceForType, isRealUuid } from "./helpers";

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
  const db = getSupabase();
  if (!db) return false;

  // Offset = seconds since the attempt started (needed for the red seek-bar
  // markers). Best-effort: when the attempt row is missing, offset is null and
  // the marker is positioned by created_at instead.
  let offsetSeconds: number | null = null;
  let realAttemptId: string | null = isRealUuid(attemptId ?? "") ? attemptId : null;
  try {
    if (realAttemptId) {
      const { data: att } = await db
        .from("attempts")
        .select("started_at")
        .eq("id", realAttemptId)
        .maybeSingle();
      const started = att?.started_at ? new Date(att.started_at as string).getTime() : null;
      if (started) offsetSeconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
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
  return !error;
}

/** Grant extra minutes to a candidate (Extend +5m). The student's live timer
 *  picks up the delta via its realtime subscription — no countdown reset. */


/** Grant extra minutes to a candidate (Extend +5m). The student's live timer
 *  picks up the delta via its realtime subscription — no countdown reset. */
export async function extendAttemptTime(attemptId: string, minutes: number): Promise<boolean> {
  const db = getSupabase();
  if (!db || !isRealUuid(attemptId)) return false;
  const { data: att } = await db
    .from("attempts")
    .select("extra_minutes")
    .eq("id", attemptId)
    .maybeSingle();
  const cur = Number((att as { extra_minutes?: number } | null)?.extra_minutes ?? 0);
  const { error } = await db
    .from("attempts")
    .update({ extra_minutes: cur + Math.max(1, Math.round(minutes)) })
    .eq("id", attemptId);
  return !error;
}

// ── Proctor chat & broadcast messages ────────────────────────────────────────
