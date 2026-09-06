// ──────────────────────────────────────────────────────────────────────────
// Domain module: attempts — extracted from src/lib/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "../supabase";
import type { PaperSlot } from "./types";
import { logAudit } from "./audit";

/** Resolve the exam a real attempt belongs to (for evaluation links). */
export async function getAttemptExamId(attemptId: string): Promise<string | null> {
  const db = getSupabase();
  if (!db || !attemptId || attemptId.startsWith("enrolled-")) return null;
  const { data } = await db.from("attempts").select("exam_id").eq("id", attemptId).maybeSingle();
  return ((data as { exam_id?: string } | null)?.exam_id as string | null) ?? null;
}


export async function startAttempt(opts: {
  examId: string;
  studentId: string;
  total: number;
  paper?: PaperSlot[];
  /** Candidate browser User-Agent — device telemetry for the proctor roster. */
  userAgent?: string;
}): Promise<string | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data: existing } = await db
    .from("attempts")
    .select("id, state")
    .eq("exam_id", opts.examId)
    .eq("student_id", opts.studentId)
    .maybeSingle();

  if (existing) {
    if (existing.state === "submitted") {
      return existing.id;
    }
    const patch: Record<string, unknown> = {
      state: "in_progress",
      started_at: new Date().toISOString(),
      total: opts.total,
      user_agent: opts.userAgent ?? null,
    };
    if (opts.paper && opts.paper.length > 0) patch.paper = opts.paper;
    const { error } = await db.from("attempts").update(patch).eq("id", existing.id);
    if (error) return null;
    return existing.id;
  }

  const { data, error } = await db
    .from("attempts")
    .insert({
      exam_id: opts.examId,
      student_id: opts.studentId,
      state: "in_progress",
      total: opts.total,
      started_at: new Date().toISOString(),
      paper: opts.paper ?? [],
      user_agent: opts.userAgent ?? null,
    })
    .select("id")
    .maybeSingle();
  if (error) return null;
  return (data?.id as string) ?? null;
}

/** Records the candidate's consent to recording/proctoring on an attempt. */


export async function recordConsent(
  attemptId: string,
  consent: { text: string; version: string },
): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { error } = await db
    .from("attempts")
    .update({
      consent_at: new Date().toISOString(),
      consent_text: consent.text.slice(0, 4000),
    })
    .eq("id", attemptId);
  return !error;
}

/**
 * Apply a patch to the student's attempt row, CREATING the row when it doesn't
 * exist yet. This closes the silent-data-loss bug where autosave/submit ran a
 * blind UPDATE keyed by exam_id+student_id: PostgREST reports no error when the
 * filter matches zero rows, so if startAttempt hadn't created the row (network
 * hiccup, slow first query, RLS hiccup) every "saved" and even the final
 * submit wrote NOTHING while the UI cheerfully reported success.
 *
 * Flow: update → verify a row matched (select id) → if zero rows, insert a
 * minimal in_progress row → re-apply the patch. A unique(exam_id, student_id)
 * violation on the insert only means a concurrent writer created the row, so
 * we simply retry the update.
 */
async function upsertAttemptPatch(opts: {
  examId: string;
  studentId: string;
  total?: number;
  patch: Record<string, unknown>;
}): Promise<boolean> {
  const db = getSupabase();
  if (!db || !opts.examId || !opts.studentId) return false;

  // 1. Try the update first and VERIFY it actually matched a row.
  const { data: hit, error: upErr } = await db
    .from("attempts")
    .update(opts.patch)
    .eq("exam_id", opts.examId)
    .eq("student_id", opts.studentId)
    .select("id")
    .maybeSingle();
  if (!upErr && hit?.id) return true;

  // 2. No row matched (or the update failed) — try to create the row, then
  //    re-apply the patch so the answers/progress land in the same write.
  const now = new Date().toISOString();
  const { error: insErr } = await db.from("attempts").insert({
    exam_id: opts.examId,
    student_id: opts.studentId,
    state: "in_progress",
    total: opts.total ?? 0,
    started_at: now,
    auto_saved_at: now,
    answers: {},
    answered: 0,
    minutes_used: 0,
  });
  if (!insErr) {
    const { error: reErr } = await db
      .from("attempts")
      .update(opts.patch)
      .eq("exam_id", opts.examId)
      .eq("student_id", opts.studentId);
    return !reErr;
  }

  // 3. Insert raced (unique violation) or the row exists after all — retry the
  //    update once. If THIS fails too the write genuinely can't land (RLS/
  //    network) and the caller reports a failure instead of a silent "saved".
  const { error: retryErr } = await db
    .from("attempts")
    .update(opts.patch)
    .eq("exam_id", opts.examId)
    .eq("student_id", opts.studentId);
  return !retryErr;
}

/** Autosave the student's answers + progress. Self-heals a missing attempt row. */
export async function saveAnswers(opts: {
  examId: string;
  studentId: string;
  answers: Record<string, unknown>;
  answered: number;
  minutesUsed: number;
  total?: number;
}): Promise<boolean> {
  return upsertAttemptPatch({
    examId: opts.examId,
    studentId: opts.studentId,
    total: opts.total,
    patch: {
      answers: opts.answers,
      answered: opts.answered,
      minutes_used: opts.minutesUsed,
      auto_saved_at: new Date().toISOString(),
    },
  });
}

/** Final submit — marks the attempt submitted and records the answers. */
export async function submitAttempt(opts: {
  examId: string;
  studentId: string;
  answers: Record<string, unknown>;
  answered: number;
  minutesUsed: number;
  score?: number | null;
  total?: number;
}): Promise<boolean> {
  return upsertAttemptPatch({
    examId: opts.examId,
    studentId: opts.studentId,
    total: opts.total,
    patch: {
      state: "submitted",
      answers: opts.answers,
      answered: opts.answered,
      minutes_used: opts.minutesUsed,
      score: opts.score ?? null,
      submitted_at: new Date().toISOString(),
    },
  });
}

/** Register the LiveKit proctor session for an attempt (best-effort). */


export async function upsertProctorSession(opts: {
  attemptId: string;
  room: string;
  identity: string;
}): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  await db.from("proctor_sessions").insert({
    attempt_id: opts.attemptId,
    livekit_room: opts.room,
    livekit_identity: opts.identity,
  });
}


export async function updateAttemptScore(attemptId: string, score: number): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { error } = await db
    .from("attempts")
    .update({ score })
    .eq("id", attemptId);
  if (!error) {
    void logAudit({ action: "attempt.score_changed", targetType: "attempt", targetId: attemptId, meta: { score } });
  }
  return !error;
}

// Severity + source implied by the violation type, so proctor actions and AI
// flags don't all collapse into a generic "warning".
