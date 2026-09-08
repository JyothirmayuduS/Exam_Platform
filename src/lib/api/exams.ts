// ──────────────────────────────────────────────────────────────────────────
// Domain module: exams — extracted from src/lib/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "../supabase";
import type { ExamStatus, ExamRecord, Student } from "./types";
import { normalizeExamRecord } from "./helpers";
import { logAudit } from "./audit";

/** Teacher publishes/schedules an exam. Upserts the row so students see it. */
export async function publishExam(
  record: Omit<ExamRecord, "created_at">,
): Promise<{ ok: boolean; error?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const { error } = await db.from("exams").upsert(record, { onConflict: "id" });
  if (!error && record.status === "published") {
    void logAudit({ action: "exam.published", targetType: "exam", targetId: record.id });
  }
  return error ? { ok: false, error: String(error.message ?? error) } : { ok: true };
}

/** Trigger the Supabase Edge Function to send emails to students */


export async function triggerExamEmail(examId: string): Promise<{ ok: boolean; error?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const appBaseUrl = typeof window !== "undefined" ? window.location.origin : undefined;
  const { error } = await db.functions.invoke("send-exam-email", {
    body: { examId, appBaseUrl }
  });
  
  return error ? { ok: false, error: String(error.message ?? error) } : { ok: true };
}

/**
 * Student-facing: fetch the exams a student is allowed to see right now.
 * Returns `null` when the query FAILS (network/RLS/offline) so callers can keep
 * the last-known-good list instead of blanking the screen. An empty array means
 * the query succeeded and there genuinely are no exams.
 */


/**
 * Student-facing: fetch the exams a student is allowed to see right now.
 * Returns `null` when the query FAILS (network/RLS/offline) so callers can keep
 * the last-known-good list instead of blanking the screen. An empty array means
 * the query succeeded and there genuinely are no exams.
 */
export async function listExamsForStudent(batch: string): Promise<ExamRecord[] | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("exams")
    .select("*")
    .neq("status", "draft")
    .eq("batch", batch)
    .order("created_at", { ascending: false });
  if (error) return null;
  return (data ?? []).map(normalizeExamRecord);
}


export async function listEnrolledExamsForAuthUser(
  authUserId: string,
): Promise<ExamRecord[] | null> {
  const db = getSupabase();
  if (!db) return null;

  // 1. Resolve student by auth_id or user email
  let student: { id: string; branch?: string | null; section?: string | null } | null = null;
  const { data: byAuth } = await db
    .from("students")
    .select("id, branch, section")
    .eq("auth_id", authUserId)
    .maybeSingle();

  if (byAuth) {
    student = byAuth;
  } else {
    const { data: authData } = await db.auth.getUser();
    if (authData?.user?.email) {
      const { data: byEmail } = await db
        .from("students")
        .select("id, branch, section")
        .eq("email", authData.user.email)
        .maybeSingle();
      if (byEmail) {
        student = byEmail;
        // Self-heal: link auth_id
        await db.from("students").update({ auth_id: authUserId }).eq("id", byEmail.id);
      }
    }
  }

  const examMap = new Map<string, ExamRecord>();

  // 2. Query explicitly enrolled exams
  if (student?.id) {
    const { data, error } = await db
      .from("enrollments")
      .select("exam:exams(*)")
      .eq("student_id", student.id);

    if (!error && data) {
      (data as { exam: ExamRecord | null }[]).forEach((row) => {
        if (row.exam && row.exam.status !== "draft") {
          examMap.set(row.exam.id, normalizeExamRecord(row.exam));
        }
      });
    }
  }

  // 3. Fallback: also include published exams matching batch/branch
  const { data: allPublished } = await db
    .from("exams")
    .select("*")
    .neq("status", "draft")
    .order("created_at", { ascending: false });

  if (allPublished) {
    for (const raw of allPublished) {
      const norm = normalizeExamRecord(raw);
      if (!examMap.has(norm.id)) {
        if (
          !student?.branch ||
          norm.batch.toLowerCase().includes(student.branch.toLowerCase()) ||
          norm.batch.toLowerCase().includes("all")
        ) {
          examMap.set(norm.id, norm);
        }
      }
    }
  }

  const exams = Array.from(examMap.values()).sort((a, b) => {
    const left = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0;
    const right = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
    return left - right;
  });

  return exams;
}

/**
 * Realtime: fire `onChange` whenever an exam for this batch is inserted or
 * updated (e.g. the moment the teacher clicks Publish). Returns an unsubscribe.
 */


/**
 * Realtime: fire `onChange` whenever an exam for this batch is inserted or
 * updated (e.g. the moment the teacher clicks Publish). Returns an unsubscribe.
 */
export function subscribeToStudentExams(
  batch: string,
  onChange: () => void,
): () => void {
  const db = getSupabase();
  if (!db) return () => undefined;
  const channel = db
    .channel(`exams-${batch}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "exams", filter: `batch=eq.${batch}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    db.removeChannel(channel);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Questions
// ─────────────────────────────────────────────────────────────────────────────



export async function listExamsForTeacher(): Promise<ExamRecord[]> { const db = getSupabase(); if (!db) return []; const { data } = await db.from('exams').select('*').order('created_at', { ascending: false }); return (data ?? []).map(normalizeExamRecord); }

export { listExamsForTeacher as listExams };

/**
 * Live per-exam proctoring stats for the assessment selector: one query for
 * attempts, one for violation events, grouped by exam_id client-side.
 */


// ── Exam row updates (status / settings / scheduling) ───────────────────────

/** Merge a settings/status/name patch into an exam row (teacher-owned). */
export async function updateExam(
  examId: string,
  patch: {
    settings?: Record<string, unknown>;
    status?: ExamStatus;
    name?: string;
    batch?: string;
    duration_minutes?: number;
  },
): Promise<boolean> {
  const db = getSupabase();
  if (!db || !examId) return false;
  const row: Record<string, unknown> = {};
  if (patch.status) row.status = patch.status;
  if (patch.name) row.name = patch.name;
  if (patch.batch) row.batch = patch.batch;
  if (patch.duration_minutes != null) row.duration_minutes = patch.duration_minutes;
  if (patch.settings) {
    const { data: cur } = await db
      .from("exams")
      .select("settings")
      .eq("id", examId)
      .maybeSingle();
    row.settings = {
      ...((cur as { settings?: Record<string, unknown> } | null)?.settings ?? {}),
      ...patch.settings,
    };
  }
  const { error } = await db.from("exams").update(row).eq("id", examId);
  return !error;
}

// ── Exam deletion (guarded) ─────────────────────────────────────────────────

export type ExamDeletionSafety = {
  /** Attempts currently being taken — deletion MUST be blocked. */
  inProgress: number;
  /** Finished attempts — permanent student records; deletion is blocked. */
  submitted: number;
  /** Not-started attempts (enrolled but never opened the paper). */
  notStarted: number;
  /** True when the database is unreachable (offline/demo mode). */
  unavailable: boolean;
};

/**
 * Check whether an exam is safe to delete. Conditions:
 *  - anyone currently taking the exam  / BLOCK (they'd be dumped mid-exam)
 *  - any submitted attempt             / BLOCK (permanent student records)
 *  - only not-started enrollments      / allowed (roster rows cascade away)
 */
export async function getExamDeletionSafety(examId: string): Promise<ExamDeletionSafety> {
  const db = getSupabase();
  if (!db || !examId) return { inProgress: 0, submitted: 0, notStarted: 0, unavailable: !db };
  const { data, error } = await db
    .from("attempts")
    .select("state")
    .eq("exam_id", examId);
  if (error) return { inProgress: 0, submitted: 0, notStarted: 0, unavailable: true };
  const counts = { inProgress: 0, submitted: 0, notStarted: 0 };
  for (const row of (data ?? []) as { state?: string }[]) {
    if (row.state === "in_progress" || row.state === "paused") counts.inProgress += 1;
    else if (row.state === "submitted") counts.submitted += 1;
    else counts.notStarted += 1;
  }
  return { ...counts, unavailable: false };
}

export type DeleteExamResult = { ok: true } | { ok: false; error: string; blocked?: boolean };

/**
 * Delete an exam permanently. Refuses (blocked: true) when any attempt exists
 * that is in progress or submitted — enrollments/question links cascade away
 * with the exam row; question-bank rows created outside this exam survive.
 */
export async function deleteExam(examId: string): Promise<DeleteExamResult> {
  const db = getSupabase();
  if (!db || !examId) return { ok: false, error: "Database not connected." };

  const safety = await getExamDeletionSafety(examId);
  if (safety.unavailable) return { ok: false, error: "Could not verify attempts for this exam — deletion aborted for safety." };
  if (safety.inProgress > 0) {
    return { ok: false, blocked: true, error: `${safety.inProgress} student(s) are taking this exam right now. The exam cannot be deleted while it is live.` };
  }
  if (safety.submitted > 0) {
    return { ok: false, blocked: true, error: `${safety.submitted} submission(s) are recorded for this exam. Delete would destroy student answer records — exams with submissions cannot be deleted.` };
  }

  const { error } = await db.from("exams").delete().eq("id", examId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
