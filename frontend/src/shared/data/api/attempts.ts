// ──────────────────────────────────────────────────────────────────────────
// Domain module: attempts — extracted from src/shared/data/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "@/shared/data/supabase";
import type { AttemptSnapshot, PaperSlot, ResumeState } from "@/shared/data/api/types";
import { logAudit } from "@/shared/data/api/audit";
import type { AutoGradeResult } from "@/shared/domain/exam/autoGrade";

/** Resolve the exam a real attempt belongs to (for evaluation links). */
export async function getAttemptExamId(attemptId: string): Promise<string | null> {
  const db = getSupabase();
  if (!db || !attemptId || attemptId.startsWith("enrolled-")) return null;
  const { data } = await db.from("attempts").select("exam_id").eq("id", attemptId).maybeSingle();
  return ((data as { exam_id?: string } | null)?.exam_id as string | null) ?? null;
}


type StartAttemptOpts = {
  examId: string;
  studentId: string;
  total: number;
  paper?: PaperSlot[];
  /** Candidate browser User-Agent — device telemetry for the proctor roster. */
  userAgent?: string;
};

const startsInFlight = new Map<string, Promise<string | null>>();

/** Open (or re-open) the student's single attempt. Concurrent calls share one
 *  request, and an insert that loses the (exam_id, student_id) race reuses the
 *  winner's row, so a reload or double start never creates a second attempt. */
export function startAttempt(opts: StartAttemptOpts): Promise<string | null> {
  const key = `${opts.examId}\u0000${opts.studentId}`;
  const running = startsInFlight.get(key);
  if (running) return running;
  const p = startAttemptOnce(opts).finally(() => startsInFlight.delete(key));
  startsInFlight.set(key, p);
  return p;
}

async function startAttemptOnce(opts: StartAttemptOpts): Promise<string | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data: existing } = await db
    .from("attempts")
    .select("id, state, paper")
    .eq("exam_id", opts.examId)
    .eq("student_id", opts.studentId)
    .maybeSingle();

  if (existing) {
    if (existing.state === "submitted") {
      return existing.id;
    }
    // started_at is owned by the server (set once on insert) so a relaunch
    // never restarts the clock.
    const patch: Record<string, unknown> = {
      state: "in_progress",
      total: opts.total,
      user_agent: opts.userAgent ?? null,
    };
    // The stored paper is what the saved answers were given against; never
    // replace it (a re-randomised paper would put them on other questions).
    const stored = (existing as { paper?: unknown }).paper;
    const hasPaper = Array.isArray(stored) && stored.length > 0;
    if (!hasPaper && opts.paper && opts.paper.length > 0) patch.paper = opts.paper;
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
  if (error) {
    if ((error as { code?: string }).code !== "23505") return null;
    const { data: winner } = await db
      .from("attempts")
      .select("id")
      .eq("exam_id", opts.examId)
      .eq("student_id", opts.studentId)
      .maybeSingle();
    return (winner?.id as string) ?? null;
  }
  return (data?.id as string) ?? null;
}

/** Everything needed to resume an attempt after a reload or relaunch. */
export async function loadAttemptResume(examId: string, studentId: string): Promise<AttemptSnapshot | null> {
  const db = getSupabase();
  if (!db || !examId || !studentId) return null;
  const { data, error } = await db
    .from("attempts")
    .select("id, state, answers, auto_saved_at, resume_state")
    .eq("exam_id", examId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; state: string | null; answers: unknown; auto_saved_at: string | null; resume_state: unknown };
  const secondsLeft = row.state === "submitted" ? 0 : await fetchAttemptTimeLeft(examId);
  const saved = row.auto_saved_at ? Date.parse(row.auto_saved_at) : NaN;
  return {
    attemptId: String(row.id),
    state: row.state ?? "not_started",
    answers: row.answers && typeof row.answers === "object" ? (row.answers as Record<string, unknown>) : {},
    autoSavedAt: Number.isFinite(saved) ? saved : null,
    resume: parseResumeState(row.resume_state),
    secondsLeft,
  };
}

function parseResumeState(raw: unknown): ResumeState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ResumeState>;
  if (typeof r.index !== "number" || typeof r.savedAt !== "number") return null;
  return {
    index: r.index,
    section: typeof r.section === "number" ? r.section : 0,
    sectionSecondsLeft: typeof r.sectionSecondsLeft === "number" ? r.sectionSecondsLeft : null,
    savedAt: r.savedAt,
  };
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
 * Flow: update / verify a row matched (select id) / if zero rows, insert a
 * minimal in_progress row / re-apply the patch. A unique(exam_id, student_id)
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

export type AttemptClaim = "ok" | "busy" | "submitted" | "forbidden" | "not_found" | "invalid" | "error";

/**
 * Claim (or renew) this device's hold on an attempt. "busy" means the same
 * candidate has the exam open on another device that is still active.
 * "error" covers network/RPC failures and must not lock the candidate out.
 */
/** Stable id for this tab/app window's hold on an exam; survives reloads, not a second device or tab. */
const memoSessions = new Map<string, string>();
export function deviceSessionId(examId: string): string {
  const key = `vignan.deviceSession.${examId}`;
  let id = memoSessions.get(key);
  try { id ??= sessionStorage.getItem(key) ?? undefined; } catch { /* storage unavailable */ }
  id ??= crypto.randomUUID();
  memoSessions.set(key, id);
  try { sessionStorage.setItem(key, id); } catch { /* storage unavailable */ }
  return id;
}

export async function claimAttemptSession(attemptId: string, sessionId: string): Promise<AttemptClaim> {
  const db = getSupabase();
  if (!db || !attemptId) return "error";
  const { data, error } = await db.rpc("claim_attempt_session", { p_attempt: attemptId, p_session: sessionId });
  if (error) return "error";
  return (data as AttemptClaim) ?? "error";
}

/** Autosave the student's answers + progress. Self-heals a missing attempt row. */
export async function saveAnswers(opts: {
  examId: string;
  studentId: string;
  answers: Record<string, unknown>;
  answered: number;
  minutesUsed: number;
  total?: number;
  /** Device session holding the attempt; the DB rejects writes from any other device. */
  sessionId?: string;
  /** Where the student is, so a reload resumes on the same question and section. */
  resume?: ResumeState;
  /** When these answers were captured (ms); defaults to now. A queued copy keeps its own time. */
  savedAt?: number;
}): Promise<boolean> {
  return upsertAttemptPatch({
    examId: opts.examId,
    studentId: opts.studentId,
    total: opts.total,
    patch: {
      answers: opts.answers,
      answered: opts.answered,
      minutes_used: opts.minutesUsed,
      auto_saved_at: new Date(opts.savedAt ?? Date.now()).toISOString(),
      ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
      ...(opts.resume ? { resume_state: opts.resume } : {}),
    },
  });
}

export type SubmitResult = {
  ok: boolean;
  /** Answers arrived after the deadline; the last autosave was graded instead. */
  late: boolean;
  /** Server grade, present only when the exam releases results on submit. */
  grade: AutoGradeResult | null;
  /** Another device holds this attempt. */
  busy?: boolean;
};

/** Final submit through the `submit-attempt` Edge Function, which checks the
 *  deadline and grades against the answer key the browser never sees. */
export async function submitAttempt(opts: {
  examId: string;
  studentId: string;
  answers: Record<string, unknown>;
  answered: number;
  minutesUsed: number;
  total?: number;
  sessionId?: string;
}): Promise<SubmitResult> {
  const db = getSupabase();
  if (!db || !opts.examId || !opts.studentId) return { ok: false, late: false, grade: null };
  const { data, error } = await db.functions.invoke("submit-attempt", {
    body: {
      examId: opts.examId,
      answers: opts.answers,
      answered: opts.answered,
      minutesUsed: opts.minutesUsed,
      sessionId: opts.sessionId,
    },
  });
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === undefined || status >= 500) {
      // Grading service unreachable: submit directly so the student is never
      // stuck. The attempt guard trigger enforces the deadline and leaves the
      // score null; staff re-grade from the evaluation page.
      const { data: rows, error: dbErr } = await db
        .from("attempts")
        .update({
          answers: opts.answers,
          answered: opts.answered,
          minutes_used: opts.minutesUsed,
          state: "submitted",
          auto_saved_at: new Date().toISOString(),
        })
        .eq("exam_id", opts.examId)
        .eq("student_id", opts.studentId)
        .neq("state", "submitted")
        .select("id");
      if (!dbErr && rows && rows.length > 0) return { ok: true, late: false, grade: null };
    }
    return { ok: false, late: false, grade: null, busy: status === 409 };
  }
  const res = (data ?? {}) as { ok?: boolean; late?: boolean; grade?: AutoGradeResult | null };
  return { ok: res.ok === true, late: res.late === true, grade: res.grade ?? null };
}

/** Seconds left on the signed-in student's attempt by the server clock
 *  (start + duration + extensions + accommodation + paused time). */
export async function fetchAttemptTimeLeft(examId: string): Promise<number | null> {
  const db = getSupabase();
  if (!db || !examId) return null;
  const { data, error } = await db.rpc("attempt_time_left", { p_exam: examId });
  if (error || data === null || data === undefined) return null;
  const n = Number(data);
  return Number.isFinite(n) ? n : null;
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


export type ScoreSaveResult = { ok: true } | { ok: false; error: string };

/** Save a mark. A refusal (no access to this exam's marks) is an error, never
 *  a silent success: an update that matched no row did not save anything. */
export async function updateAttemptScore(attemptId: string, score: number): Promise<ScoreSaveResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "Not connected — the mark was not saved." };
  const { data, error } = await db
    .from("attempts")
    .update({ score })
    .eq("id", attemptId)
    .select("id");
  if (error) {
    return {
      ok: false,
      error: error.code === "42501"
        ? "Only the exam's owner, a delegated teacher or an admin can change marks."
        : `The mark was not saved: ${error.message}`,
    };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "The mark was not saved: you cannot change marks for this exam." };
  }
  void logAudit({ action: "attempt.score_changed", targetType: "attempt", targetId: attemptId, meta: { score } });
  // Resend to Moodle when the student launched from there; no-op otherwise.
  void Promise.resolve().then(() => db.functions.invoke("lti/score", { body: { attemptId } })).catch(() => {});
  return { ok: true };
}

// Severity + source implied by the violation type, so proctor actions and AI
// flags don't all collapse into a generic "warning".
