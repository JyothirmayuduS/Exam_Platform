import { getSupabase } from "./supabase";

export type ExamStatus = "draft" | "published" | "scheduled";
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
  created_by?: string | null;
  created_at?: string;
};

export type StudentIdentity = {
  id: string;
  roll: string;
  full_name: string;
  batch: string;
};

async function getCurrentUserId(): Promise<string | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.auth.getUser();
  return data.user?.id ?? null;
}

export async function getCurrentStudentIdentity(): Promise<StudentIdentity | null> {
  const db = getSupabase();
  if (!db) return null;
  const userId = await getCurrentUserId();
  if (!userId) return null;
  const { data } = await db
    .from("students")
    .select("id,roll,full_name,batch")
    .eq("auth_id", userId)
    .maybeSingle();

  if (!data) return null;
  return {
    id: String(data.id),
    roll: String(data.roll),
    full_name: String(data.full_name),
    batch: String(data.batch),
  };
}

/** Teacher publishes/schedules an exam. Upserts the row so students see it. */
export async function publishExam(
  record: Omit<ExamRecord, "created_at">,
): Promise<{ ok: boolean; error?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };

  const userId = await getCurrentUserId();
  const payload: Omit<ExamRecord, "created_at"> = {
    ...record,
    created_by: record.created_by ?? userId,
  };

  const { error } = await db.from("exams").upsert(payload, { onConflict: "id" });
  return error ? { ok: false, error: String(error.message ?? error) } : { ok: true };
}

/**
 * Student-facing: fetch the exams currently visible to this authenticated student.
 * Returns `null` when the query fails so callers can keep last-known data.
 */
export async function listExamsForStudent(): Promise<ExamRecord[] | null> {
  const db = getSupabase();
  if (!db) return null;

  const student = await getCurrentStudentIdentity();
  if (!student) return [];

  const { data, error } = await db
    .from("exam_enrollments")
    .select("exam:exams(*)")
    .eq("student_id", student.id)
    .order("enrolled_at", { ascending: false });

  if (error) return null;

  return ((data ?? []) as Array<{ exam: ExamRecord | ExamRecord[] | null }>)
    .map((row) => (Array.isArray(row.exam) ? row.exam[0] : row.exam))
    .filter((exam): exam is ExamRecord => !!exam && exam.status !== "draft");
}

/** Realtime: fire `onChange` whenever a student-visible exam changes. */
export function subscribeToStudentExams(onChange: () => void): () => void {
  const db = getSupabase();
  if (!db) return () => undefined;
  const channel = db
    .channel("student-exams")
    .on("postgres_changes", { event: "*", schema: "public", table: "exam_enrollments" }, () => onChange())
    .on("postgres_changes", { event: "*", schema: "public", table: "exams" }, () => onChange())
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
 * Load one exam and its question set for the signed-in student.
 */
export async function loadExamBundle(examId: string): Promise<ExamBundle> {
  const db = getSupabase();
  if (!db) return { exam: null, questions: [] };

  const student = await getCurrentStudentIdentity();
  if (!student) return { exam: null, questions: [] };

  const { data: enrollment, error: enrollmentError } = await db
    .from("exam_enrollments")
    .select("exam:exams(*)")
    .eq("exam_id", examId)
    .eq("student_id", student.id)
    .maybeSingle();

  if (enrollmentError || !enrollment) return { exam: null, questions: [] };

  const exam = (Array.isArray(enrollment.exam) ? enrollment.exam[0] : enrollment.exam) as ExamRecord | null;
  if (!exam) return { exam: null, questions: [] };

  const { data: qData } = await db
    .from("questions")
    .select("*")
    .eq("exam_id", examId)
    .order("id", { ascending: true });

  const questions = ((qData as DBQuestion[] | null) ?? []).map((row) => ({
    ...row,
    options: normalizeOptions(row.options),
  }));

  return { exam, questions };
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
