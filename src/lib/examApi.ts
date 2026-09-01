// Exam data access — the bridge between the teacher's publish action and what
// students see. Every function is a no-op-friendly wrapper: if Supabase is not
// configured it resolves to a safe empty/echo value so the UI never crashes.

import { getSupabase } from "./supabase";

export type ExamStatus = "draft" | "published" | "scheduled" | "completed";
export type ExamMode = "practice" | "lockdown";

export type ExamRecord = {
  id: string;
  name: string;
  batch: string;
  mode: ExamMode;
  status: ExamStatus;
  duration_minutes: number;
  per_student: number;
  pool_count: number;
  total_marks: number;
  scheduled_at: string | null;
  join_link: string;
  settings: Record<string, unknown>;
  description?: string | null;
  instructions?: string | null;
  resources_url?: string | null;
  faq?: { question: string; answer: string }[] | null;
  created_at?: string;
};

/** Teacher publishes/schedules an exam. Upserts the row so students see it. */
export async function publishExam(
  record: Omit<ExamRecord, "created_at">,
): Promise<{ ok: boolean; error?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const { error } = await db.from("exams").upsert(record, { onConflict: "id" });
  return error ? { ok: false, error: String(error.message ?? error) } : { ok: true };
}

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

  const { data: student } = await db
    .from("students")
    .select("id,batch")
    .eq("auth_id", authUserId)
    .maybeSingle();

  if (!student?.id) return null;

  const { data, error } = await db
    .from("enrollments")
    .select("exam:exams(*)")
    .eq("student_id", student.id);

  if (!error && data) {
    const exams = (data as { exam: ExamRecord | null }[])
      .map((row) => row.exam)
      .filter((exam): exam is ExamRecord => !!exam && exam.status !== "draft")
      .map(normalizeExamRecord)
      .sort((a, b) => {
        const left = a.scheduled_at ? new Date(a.scheduled_at).getTime() : 0;
        const right = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
        return left - right;
      });
    return exams;
  }

  return listExamsForStudent(String(student.batch));
}

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

export type DBQuestion = {
  id: string;
  exam_id: string;
  title: string;
  type: string;
  unit: string | null;
  difficulty: string | null;
  marks: number;
  options: string[] | null;
  answer: string | null;
};

export type ExamBundle = { exam: ExamRecord | null; questions: DBQuestion[] };

/**
 * Load one exam and its question set for a student sitting it. Returns
 * `{ exam: null, questions: [] }` when Supabase isn't configured so callers can
 * fall back to their built-in demo questions.
 */
export async function loadExamBundle(examId: string): Promise<ExamBundle> {
  const db = getSupabase();
  if (!db) return { exam: null, questions: [] };
  const [examRes, qRes] = await Promise.all([
    db.from("exams").select("*").eq("id", examId).maybeSingle(),
    db.from("questions").select("*").eq("exam_id", examId).order("id", { ascending: true }),
  ]);
  const exam = examRes.data ? normalizeExamRecord(examRes.data as ExamRecord) : null;
  const questions = ((qRes.data as DBQuestion[] | null) ?? []).map((row) => ({
    ...row,
    options: normalizeOptions(row.options),
  }));
  return { exam, questions };
}

export async function loadExamForStudent(examId: string): Promise<{
  exam: ExamRecord | null;
  questionCount: number;
}> {
  const db = getSupabase();
  if (!db) return { exam: null, questionCount: 0 };
  const [{ data: exam }, { count }] = await Promise.all([
    db.from("exams").select("*").eq("id", examId).maybeSingle(),
    db.from("questions").select("id", { count: "exact", head: true }).eq("exam_id", examId),
  ]);
  return {
    exam: exam ? normalizeExamRecord(exam as ExamRecord) : null,
    questionCount: count ?? 0,
  };
}

/** Options come back as jsonb (array) — guard against string/null shapes. */
function normalizeOptions(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return raw.map((o) => String(o));
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((o) => String(o)) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolve a student row id from their roll number (needed for attempt rows). */
export async function getStudentIdByRoll(roll: string): Promise<string | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.from("students").select("id").eq("roll", roll).maybeSingle();
  return (data?.id as string) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attempt lifecycle: start → autosave → submit
// ─────────────────────────────────────────────────────────────────────────────

export type AttemptState = "not_started" | "in_progress" | "submitted";

export type AttemptRecord = {
  id: string;
  exam_id: string;
  student_id: string;
  state: AttemptState;
  answered: number;
  total: number;
  minutes_used: number;
  score: number | null;
  started_at: string | null;
  submitted_at: string | null;
  auto_saved_at: string | null;
  answers: Record<string, unknown>;
};

/**
 * Create (or resume) the student's attempt when they begin the exam. Upserts on
 * the (exam_id, student_id) unique key so a reload resumes the same row.
 * Returns the attempt id, or null when offline.
 */
export async function startAttempt(opts: {
  examId: string;
  studentId: string;
  total: number;
}): Promise<string | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data, error } = await db
    .from("attempts")
    .upsert(
      {
        exam_id: opts.examId,
        student_id: opts.studentId,
        state: "in_progress",
        total: opts.total,
        started_at: new Date().toISOString(),
      },
      { onConflict: "exam_id,student_id" },
    )
    .select("id")
    .maybeSingle();
  if (error) return null;
  return (data?.id as string) ?? null;
}

/** Autosave the student's answers + progress. No-op-safe when offline. */
export async function saveAnswers(opts: {
  examId: string;
  studentId: string;
  answers: Record<string, unknown>;
  answered: number;
  minutesUsed: number;
}): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { error } = await db
    .from("attempts")
    .update({
      answers: opts.answers,
      answered: opts.answered,
      minutes_used: opts.minutesUsed,
      auto_saved_at: new Date().toISOString(),
    })
    .eq("exam_id", opts.examId)
    .eq("student_id", opts.studentId);
  return !error;
}

/** Final submit — marks the attempt submitted and records the answers. */
export async function submitAttempt(opts: {
  examId: string;
  studentId: string;
  answers: Record<string, unknown>;
  answered: number;
  minutesUsed: number;
  score?: number | null;
}): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { error } = await db
    .from("attempts")
    .update({
      state: "submitted",
      answers: opts.answers,
      answered: opts.answered,
      minutes_used: opts.minutesUsed,
      score: opts.score ?? null,
      submitted_at: new Date().toISOString(),
    })
    .eq("exam_id", opts.examId)
    .eq("student_id", opts.studentId);
  return !error;
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

function normalizeExamRecord(record: ExamRecord): ExamRecord {
  return {
    ...record,
    faq: normalizeFaq(record.faq),
  };
}

function normalizeFaq(
  raw: unknown,
): { question: string; answer: string }[] | null {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        const q = String((item as { question?: unknown }).question ?? "").trim();
        const a = String((item as { answer?: unknown }).answer ?? "").trim();
        return q && a ? { question: q, answer: a } : null;
      })
      .filter((item): item is { question: string; answer: string } => !!item);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proctor / teacher side: live attempts for an exam
// ─────────────────────────────────────────────────────────────────────────────

export type LiveAttempt = {
  id: string;
  exam_id: string;
  state: AttemptState;
  answered: number;
  total: number;
  minutes_used: number;
  submitted_at: string | null;
  auto_saved_at: string | null;
  student: { id: string; roll: string; full_name: string } | null;
};

/** All attempts for an exam, joined with the student, newest activity first. */
export async function listLiveAttempts(examId: string): Promise<LiveAttempt[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("attempts")
    .select("id,exam_id,state,answered,total,minutes_used,submitted_at,auto_saved_at,student:students(id,roll,full_name)")
    .eq("exam_id", examId)
    .order("auto_saved_at", { ascending: false });
  if (error) return [];
  return ((data ?? []) as unknown[]).map((row) => {
    const r = row as Record<string, unknown>;
    const s = r.student as Record<string, unknown> | Record<string, unknown>[] | null;
    const student = Array.isArray(s) ? (s[0] ?? null) : s;
    return {
      id: String(r.id),
      exam_id: String(r.exam_id),
      state: r.state as AttemptState,
      answered: Number(r.answered ?? 0),
      total: Number(r.total ?? 0),
      minutes_used: Number(r.minutes_used ?? 0),
      submitted_at: (r.submitted_at as string) ?? null,
      auto_saved_at: (r.auto_saved_at as string) ?? null,
      student: student
        ? {
            id: String((student as Record<string, unknown>).id),
            roll: String((student as Record<string, unknown>).roll),
            full_name: String((student as Record<string, unknown>).full_name),
          }
        : null,
    } as LiveAttempt;
  });
}

/** Realtime: fire `onChange` when any attempt for this exam changes. */
export function subscribeToAttempts(examId: string, onChange: () => void): () => void {
  const db = getSupabase();
  if (!db) return () => undefined;
  const channel = db
    .channel(`attempts-${examId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "attempts", filter: `exam_id=eq.${examId}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    db.removeChannel(channel);
  };
}
