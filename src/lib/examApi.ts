// Exam data access — the bridge between the teacher's publish action and what
// students see. Every function is a no-op-friendly wrapper: if Supabase is not
// configured it resolves to a safe empty/echo value so the UI never crashes.

import { getSupabase } from "./supabase";
import { buildPaper, questionsForPaper, type PaperSlot } from "./paperBuilder";
export type { PaperSlot };

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
  exam_id: string | null;
  title: string;
  type: string;
  unit: string | null;
  difficulty: string | null;
  marks: number;
  options: string[] | null;
  answer: string | null;
  subjective_mode?: "both" | "qr" | "textbox" | null;
};

export type ExamBundle = { exam: ExamRecord | null; questions: DBQuestion[] };

/** All questions across the teacher's exams (for the question-bank page). */
export async function listAllQuestions(): Promise<(DBQuestion & { exam_name: string | null })[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("questions")
    .select("*, exam:exams(name)")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    const examRel = Array.isArray(r.exam) ? (r.exam as unknown[])[0] : r.exam;
    return {
      id: String(r.id ?? ""),
      exam_id: r.exam_id ? String(r.exam_id) : null,
      title: String(r.title ?? ""),
      type: String(r.type ?? "MCQ"),
      unit: r.unit ? String(r.unit) : null,
      difficulty: r.difficulty ? String(r.difficulty) : null,
      marks: Number(r.marks ?? 1),
      options: normalizeOptions(r.options),
      answer: r.answer ? String(r.answer) : null,
      subjective_mode: r.subjective_mode ? (String(r.subjective_mode) as DBQuestion["subjective_mode"]) : null,
      exam_name: examRel && typeof examRel === "object" ? String((examRel as Record<string, unknown>).name ?? null) : null,
    } as DBQuestion & { exam_name: string | null };
  });
}

export async function deleteQuestion(questionId: string): Promise<boolean> {
  const db = getSupabase();
  if (!db || !questionId) return false;
  const { error } = await db.from("questions").delete().eq("id", questionId);
  return !error;
}

export async function saveQuestion(question: Omit<DBQuestion, "id"> & { id?: string }): Promise<{ ok: boolean; data?: DBQuestion; error?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "Supabase not connected" };
  
  if (question.id) {
    const { data, error } = await db.from("questions").update(question).eq("id", question.id).select().single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: data as DBQuestion };
  } else {
    // Generate a quick ID
    const newId = `Q-${Math.floor(1000 + Math.random() * 9000)}`;
    const { data, error } = await db.from("questions").insert({ ...question, id: newId }).select().single();
    if (error) return { ok: false, error: error.message };
    // Mirror ownership into the M:N pool join so the pool reads stay consistent.
    if (question.exam_id && data?.id) void linkQuestionsToExam(String(question.exam_id), [String(data.id)]);
    return { ok: true, data: data as DBQuestion };
  }
}

/**
 * Questions that belong to an exam's pool. Membership is many-to-many through
 * exam_questions (bank questions are reusable across exams); rows created
 * before the join migration also count via their legacy questions.exam_id.
 * Falls back to the legacy single-owner query when the join table is missing
 * (migration not yet applied), so this works either way.
 */
export async function listQuestionsForExam(examId: string): Promise<DBQuestion[]> {
  const db = getSupabase();
  if (!db) return [];
  let ids: string[] = [];
  const { data: join, error: joinErr } = await db
    .from("exam_questions")
    .select("question_id")
    .eq("exam_id", examId);
  if (!joinErr && join) ids = join.map((r: { question_id?: string }) => String(r.question_id ?? ""));
  // Legacy owner rows (questions.exam_id) — kept so pools survive the backfill.
  const { data: owned, error: ownErr } = await db
    .from("questions")
    .select("id")
    .eq("exam_id", examId);
  if (!ownErr && owned) ids = ids.concat(owned.map((r: { id?: string }) => String(r.id ?? "")));
  ids = Array.from(new Set(ids.filter(Boolean)));
  if (ids.length === 0) return [];
  const { data, error } = await db.from("questions").select("*").in("id", ids).order("id", { ascending: true });
  if (error || !data) return [];
  return (data as DBQuestion[]).map((row) => ({ ...row, options: normalizeOptions(row.options) }));
}

/** Add existing bank questions to an exam's pool (idempotent). */
export async function linkQuestionsToExam(
  examId: string,
  questionIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const rows = questionIds.map((question_id) => ({ exam_id: examId, question_id }));
  const { error } = await db.from("exam_questions").upsert(rows, { onConflict: "exam_id,question_id" });
  if (error) return { ok: false, error: String(error.message ?? error) };
  return { ok: true };
}

/** Remove a question from an exam's pool (the question itself is untouched). */
export async function unlinkQuestionFromExam(examId: string, questionId: string): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { error } = await db
    .from("exam_questions")
    .delete()
    .eq("exam_id", examId)
    .eq("question_id", questionId);
  return !error;
}

/**
 * Load one exam and its question set for a student sitting it. Returns
 * `{ exam: null, questions: [] }` when Supabase isn't configured so callers can
 * fall back to their built-in demo questions.
 */
export async function loadExamBundle(examId: string): Promise<ExamBundle> {
  const db = getSupabase();
  if (!db) return { exam: null, questions: [] };
  const [examRes, questions] = await Promise.all([
    db.from("exams").select("*").eq("id", examId).maybeSingle(),
    listQuestionsForExam(examId),
  ]);
  const exam = examRes.data ? normalizeExamRecord(examRes.data as ExamRecord) : null;
  return { exam, questions };
}

/**
 * Student-facing paper delivery: loads the exam, builds/loads THIS student's
 * paper snapshot (deterministic per student, respecting the exam's
 * per_student / random-select / shuffle settings) and returns the questions in
 * paper order with the displayed option order applied. Answers are keyed by DB
 * question id. Returns `exam: null` when the exam is missing/offline.
 */
export async function loadPaperForStudent(
  examId: string,
  studentSeed: string,
): Promise<{ exam: ExamRecord | null; questions: DBQuestion[]; paper: PaperSlot[]; attemptId: string | null }> {
  const db = getSupabase();
  if (!db) return { exam: null, questions: [], paper: [], attemptId: null };
  const { exam, questions: pool } = await loadExamBundle(examId);
  if (!exam) return { exam: null, questions: [], paper: [], attemptId: null };

  // Prefer the persisted snapshot (survives mid-exam setting edits); build a
  // deterministic one for new attempts.
  let paper: PaperSlot[] = [];
  let attemptId: string | null = null;
  if (studentSeed) {
    const { data: att } = await db
      .from("attempts")
      .select("id, paper")
      .eq("exam_id", examId)
      .eq("student_id", studentSeed)
      .maybeSingle();
    if (att?.id) attemptId = String(att.id);
    const stored = att?.paper;
    if (Array.isArray(stored) && stored.length > 0) {
      paper = stored as PaperSlot[];
    } else {
      const settings = (exam.settings ?? {}) as Record<string, unknown>;
      paper = buildPaper(examId, studentSeed, pool, {
        perStudent: Number(settings.perStudent ?? exam.per_student ?? pool.length),
        randomSelect: settings.randomSelect !== false,
        shuffleOrder: settings.shuffleOrder !== false,
        shuffleOptions: settings.shuffleOptions === true,
      });
      if (att?.id) {
        await db.from("attempts").update({ paper }).eq("id", String(att.id));
      }
    }
  }

  const ordered = questionsForPaper(paper, pool);
  const questions = ordered.map((q, i) => ({
    ...q,
    options: paper[i]?.options ?? normalizeOptions(q.options),
  }));
  return { exam, questions, paper, attemptId };
}

export async function loadExamForStudent(examId: string): Promise<{
  exam: ExamRecord | null;
  questionCount: number;
}> {
  const db = getSupabase();
  if (!db) return { exam: null, questionCount: 0 };
  const [examRes, questions] = await Promise.all([
    db.from("exams").select("*").eq("id", examId).maybeSingle(),
    listQuestionsForExam(examId),
  ]);
  return {
    exam: examRes.data ? normalizeExamRecord(examRes.data as ExamRecord) : null,
    questionCount: questions.length,
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
/** Full student profile (for pre-filling the registration step). */
export async function getStudentProfile(roll: string): Promise<{ id: string; full_name: string | null; email: string | null } | null> {
  const db = getSupabase();
  if (!db || !roll) return null;
  const { data } = await db.from("students").select("id, full_name, email").eq("roll", roll).maybeSingle();
  if (!data) return null;
  const r = data as { id?: string; full_name?: string | null; email?: string | null };
  return { id: String(r.id ?? ""), full_name: r.full_name ?? null, email: r.email ?? null };
}

/** Resolve the exam a real attempt belongs to (for evaluation links). */
export async function getAttemptExamId(attemptId: string): Promise<string | null> {
  const db = getSupabase();
  if (!db || !attemptId || attemptId.startsWith("enrolled-")) return null;
  const { data } = await db.from("attempts").select("exam_id").eq("id", attemptId).maybeSingle();
  return ((data as { exam_id?: string } | null)?.exam_id as string | null) ?? null;
}

export async function getStudentIdByRoll(roll: string): Promise<string | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.from("students").select("id").eq("roll", roll).maybeSingle();
  return (data?.id as string) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attempt lifecycle: start → autosave → submit
// ─────────────────────────────────────────────────────────────────────────────

export type AttemptState = "not_started" | "in_progress" | "submitted" | "paused";

export type ViolationSeverity = "info" | "warning" | "high" | "critical";
export type ViolationSource = "ai" | "system" | "proctor" | "student" | "teacher";

/** One proctoring flag / proctor action row from violation_events. */
export type ViolationEvent = {
  id: string;
  exam_id: string;
  attempt_id: string | null;
  student_id: string;
  violation_type: string;
  severity: ViolationSeverity;
  description: string;
  source: ViolationSource;
  /** Seconds from the attempt start — used for red markers on the recording seek bar. */
  offset_seconds: number | null;
  snapshot_key: string | null;
  created_at: string;
};

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
  /** Per-student question snapshot (ordered DB question ids + shuffled options). */
  paper: unknown;
};

export async function startAttempt(opts: {
  examId: string;
  studentId: string;
  total: number;
  paper?: PaperSlot[];
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
    const patch: Record<string, unknown> = { state: "in_progress", started_at: new Date().toISOString(), total: opts.total };
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
    })
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
  score: number | null;
  answers: Record<string, unknown>;
  paper: unknown;
  started_at: string | null;
  submitted_at: string | null;
  auto_saved_at: string | null;
  student: { id: string; roll: string; full_name: string; email: string | null } | null;
  violations: ViolationEvent[];
};

/** All attempts for an exam, joined with the student, newest activity first. */
export async function listLiveAttempts(examId?: string | null): Promise<LiveAttempt[]> {
  const db = getSupabase();
  if (!db) return [];
  let query = db
    .from("attempts")
    .select("id,exam_id,state,answered,total,minutes_used,score,answers,paper,started_at,submitted_at,auto_saved_at,student:students(id,roll,full_name,email)")
    .order("auto_saved_at", { ascending: false });
  if (examId) query = query.eq("exam_id", examId);
  const { data, error } = await query;

  const attempts: LiveAttempt[] = error
    ? []
    : ((data ?? []) as unknown[]).map((row) => {
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
          score: typeof r.score === "number" ? r.score : null,
          answers: (r.answers as Record<string, unknown>) ?? {},
          paper: r.paper ?? [],
          started_at: (r.started_at as string) ?? null,
          submitted_at: (r.submitted_at as string) ?? null,
          auto_saved_at: (r.auto_saved_at as string) ?? null,
          student: student
            ? {
                id: String((student as Record<string, unknown>).id),
                roll: String((student as Record<string, unknown>).roll),
                full_name: String((student as Record<string, unknown>).full_name),
                email: ((student as Record<string, unknown>).email as string | null) ?? null,
              }
            : null,
          violations: [],
        } as LiveAttempt;
      });

  // Track enrolled students who already have an attempt
  const seenStudentIds = new Set<string>();
  for (const a of attempts) {
    if (a.student?.id) seenStudentIds.add(a.student.id);
  }

  // Also query enrolled students who haven't started an attempt yet
  try {
    if (!examId) return attempts; // all-exams mode: enrolled-but-idle rows are not synthesized per exam
    const { data: enrolledData } = await db
      .from("enrollments")
      .select("student_id, student:students(id, roll, full_name)")
      .eq("exam_id", examId);

    if (enrolledData) {
      for (const row of enrolledData) {
        const s = (row as Record<string, unknown>).student;
        const st = Array.isArray(s) ? s[0] : s;
        if (st && !seenStudentIds.has((st as Record<string, unknown>).id as string)) {
          seenStudentIds.add((st as Record<string, unknown>).id as string);
          attempts.push({
            id: `enrolled-${(st as Record<string, unknown>).id}`,
            exam_id: examId,
            state: "not_started" as AttemptState,
            answered: 0,
            total: 0,
            minutes_used: 0,
            score: null,
            answers: {},
            paper: [],
            started_at: null,
            submitted_at: null,
            auto_saved_at: null,
            student: {
              id: String((st as Record<string, unknown>).id),
              roll: String((st as Record<string, unknown>).roll),
              full_name: String((st as Record<string, unknown>).full_name),
              email: ((st as Record<string, unknown>).email as string | null) ?? null,
            },
            violations: [],
          });
        }
      }
    }
  } catch {
    // Non-blocking fallback
  }

  // Load real violation events for this exam (student AI flags + proctor
  // actions) and attach them to the right attempt. Events are matched by
  // attempt_id when the candidate has started, otherwise by student_id so
  // warnings sent before a candidate begins still surface on their tile.
  try {
    const { data: vioData, error: vioError } = await db
      .from("violation_events")
      .select("*")
      .eq("exam_id", examId)
      .order("created_at", { ascending: true });
    if (!vioError && vioData) {
      const byAttempt = new Map<string, ViolationEvent[]>();
      const byStudent = new Map<string, ViolationEvent[]>();
      for (const raw of vioData as unknown[]) {
        const r = raw as Record<string, unknown>;
        const v: ViolationEvent = {
          id: String(r.id),
          exam_id: String(r.exam_id),
          attempt_id: r.attempt_id ? String(r.attempt_id) : null,
          student_id: String(r.student_id),
          violation_type: String(r.violation_type ?? "unknown"),
          severity: (r.severity as ViolationSeverity) ?? "warning",
          description: String(r.description ?? ""),
          source: (r.source as ViolationSource) ?? "system",
          offset_seconds: typeof r.offset_seconds === "number" ? r.offset_seconds : null,
          snapshot_key: r.snapshot_key ? String(r.snapshot_key) : null,
          created_at: String(r.created_at),
        };
        if (v.attempt_id) {
          const list = byAttempt.get(v.attempt_id) ?? [];
          list.push(v);
          byAttempt.set(v.attempt_id, list);
        } else {
          const list = byStudent.get(v.student_id) ?? [];
          list.push(v);
          byStudent.set(v.student_id, list);
        }
      }
      for (const a of attempts) {
        const mine: ViolationEvent[] = [];
        if (byAttempt.has(a.id)) mine.push(...(byAttempt.get(a.id) ?? []));
        if (a.student && byStudent.has(a.student.id)) mine.push(...(byStudent.get(a.student.id) ?? []));
        a.violations = mine.sort(
          (x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime(),
        );
      }
    }
  } catch {
    // Violations are best-effort — roster still renders without them.
  }

  return attempts;
}

/** All violation events for a single attempt (used by the recording review). */
export async function listAttemptViolations(attemptId: string): Promise<ViolationEvent[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("violation_events")
    .select("*")
    .eq("attempt_id", attemptId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      exam_id: String(r.exam_id),
      attempt_id: r.attempt_id ? String(r.attempt_id) : null,
      student_id: String(r.student_id),
      violation_type: String(r.violation_type ?? "unknown"),
      severity: (r.severity as ViolationSeverity) ?? "warning",
      description: String(r.description ?? ""),
      source: (r.source as ViolationSource) ?? "system",
      offset_seconds: typeof r.offset_seconds === "number" ? r.offset_seconds : null,
      snapshot_key: r.snapshot_key ? String(r.snapshot_key) : null,
      created_at: String(r.created_at),
    };
  });
}

/** Realtime: fire `onChange` when any attempt for this exam changes. */
export function subscribeToAttempts(examId: string, onChange: () => void): () => void {
  const db = getSupabase();
  if (!db) return () => undefined;
  
  // Use a unique channel name to prevent "cannot add postgres_changes callbacks after subscribe()" 
  // when multiple components hook into the same exam.
  const channelId = `attempts-${examId}-${Math.random().toString(36).slice(2)}`;
  const channel = db
    .channel(channelId)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "attempts", filter: `exam_id=eq.${examId}` },
      () => onChange(),
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "enrollments", filter: `exam_id=eq.${examId}` },
      () => onChange(),
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "violation_events", filter: `exam_id=eq.${examId}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    db.removeChannel(channel);
  };
}
// --- Student Enrollment Management ---

export type Student = {
  id: string;
  roll: string;
  full_name: string;
  email: string;
  branch: string;
  section: string;
  phone?: string | null;
  created_at: string;
};

export type StudentRosterRecord = {
  id: string;
  roll: string;
  full_name: string;
  email: string;
  branch: string;
  section: string;
  phone?: string | null;
};

export async function getExamRoster(examId: string): Promise<StudentRosterRecord[]> {
  const db = getSupabase();
  if (!db) return [];
  
  const { data, error } = await db
    .from("enrollments")
    .select("student:students(id, roll, full_name, email, branch, section, phone)")
    .eq("exam_id", examId);
    
  if (error || !data) return [];
  
  return data
    .map((row: any) => row.student)
    .filter(Boolean) as StudentRosterRecord[];
}

export async function enrollStudent(examId: string, student: { roll: string; name: string; email: string; branch: string; section: string; phone?: string }): Promise<{ error?: string }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection" };

  // 1. Upsert student
  const { data: sData, error: sErr } = await db
    .from("students")
    .upsert(
      { roll: student.roll, full_name: student.name, email: student.email, branch: student.branch, section: student.section, phone: student.phone || null },
      { onConflict: "roll" }
    )
    .select("id")
    .single();

  if (sErr || !sData) return { error: sErr?.message || "Failed to upsert student" };

  // 2. Insert enrollment
  const { error: eErr } = await db
    .from("enrollments")
    .upsert({ exam_id: examId, student_id: sData.id }, { onConflict: "exam_id, student_id" });

  if (eErr) return { error: eErr.message };
  return {};
}

export async function bulkEnrollStudents(examId: string, students: { id: string }[]): Promise<{ error?: string; count: number }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection", count: 0 };
  if (students.length === 0) return { count: 0 };

  // Insert enrollments mapping the existing students to this exam
  const { error: eErr } = await db
    .from("enrollments")
    .upsert(
      students.map((s) => ({ exam_id: examId, student_id: s.id })),
      { onConflict: "exam_id, student_id" }
    );

  if (eErr) return { error: eErr.message, count: 0 };
  return { count: students.length };
}

/** Global student directory filtered by batch (e.g. 'CSE · Sem III'). */
export async function listStudentsByBatch(batch?: string): Promise<Student[]> {
  const db = getSupabase();
  if (!db) return [];
  let query = db.from("students").select("*");
  if (batch) query = query.eq("batch", batch);
  const { data } = await query;
  return (data as Student[]) || [];
}

export async function getStudentsByBranchAndSection(branch?: string, section?: string): Promise<Student[]> {
  const db = getSupabase();
  if (!db) return [];
  let query = db.from("students").select("*");
  if (branch) query = query.eq("branch", branch);
  if (section) query = query.eq("section", section);
  const { data } = await query;
  return data as Student[] || [];
}

export async function bulkImportGlobalStudents(students: { roll: string; name: string; email: string; branch: string; section: string; phone?: string }[]): Promise<{ error?: string; count: number }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection", count: 0 };
  if (students.length === 0) return { count: 0 };

  const { data, error } = await db
    .from("students")
    .upsert(
      students.map(s => ({ roll: s.roll, full_name: s.name, email: s.email, branch: s.branch, section: s.section, phone: s.phone || null })),
      { onConflict: "roll" }
    )
    .select("id");

  if (error || !data) return { error: error?.message || "Failed to bulk import students", count: 0 };
  return { count: data.length };
}

export async function removeStudentFromExam(examId: string, roll: string): Promise<{ error?: string }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection" };

  const { data: student } = await db.from("students").select("id").eq("roll", roll).maybeSingle();
  if (!student) return { error: "Student not found" };

  const { error } = await db
    .from("enrollments")
    .delete()
    .eq("exam_id", examId)
    .eq("student_id", student.id);

  if (error) return { error: error.message };
  return {};
}


export async function listExamsForTeacher(): Promise<ExamRecord[]> { const db = getSupabase(); if (!db) return []; const { data } = await db.from('exams').select('*').order('created_at', { ascending: false }); return (data ?? []).map(normalizeExamRecord); }
export { listExamsForTeacher as listExams };

/**
 * Live per-exam proctoring stats for the assessment selector: one query for
 * attempts, one for violation events, grouped by exam_id client-side.
 */
export async function listProctoringStats(): Promise<
  Record<string, { candidates: number; active: number; submitted: number; paused: number; flagged: number }>
> {
  const db = getSupabase();
  if (!db) return {};
  const out: Record<string, { candidates: number; active: number; submitted: number; paused: number; flagged: number }> = {};
  const bump = (examId: string, field: "candidates" | "active" | "submitted" | "paused" | "flagged") => {
    if (!examId) return;
    const row = (out[examId] ??= { candidates: 0, active: 0, submitted: 0, paused: 0, flagged: 0 });
    row[field] += 1;
  };
  const { data: attempts } = await db
    .from("attempts")
    .select("exam_id,state,student_id");
  if (attempts) {
    for (const r of attempts as { exam_id?: string; state?: string; student_id?: string }[]) {
      const examId = String(r.exam_id ?? "");
      bump(examId, "candidates");
      if (r.state === "in_progress" || r.state === "not_started") bump(examId, "active");
      else if (r.state === "submitted") bump(examId, "submitted");
      else if (r.state === "paused") bump(examId, "paused");
    }
  }
  const { data: violations } = await db
    .from("violation_events")
    .select("exam_id")
    .not("severity", "eq", "info");
  if (violations) {
    for (const r of violations as { exam_id?: string }[]) bump(String(r.exam_id ?? ""), "flagged");
  }
  return out;
}

export async function updateAttemptScore(attemptId: string, score: number): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { error } = await db
    .from("attempts")
    .update({ score })
    .eq("id", attemptId);
  return !error;
}

// Severity + source implied by the violation type, so proctor actions and AI
// flags don't all collapse into a generic "warning".
function severityForType(violationType: string): ViolationSeverity {
  const t = violationType.toLowerCase();
  if (t.includes("escalat") || t.includes("critical") || t.includes("second_face") || t.includes("prohibited") || t.includes("multiple_face")) return "critical";
  if (t.includes("pause") || t.includes("force_submit") || t.includes("phone") || t.includes("no_face") || t.includes("camera_lost") || t.includes("tab") || t.includes("audio")) return "high";
  return "warning";
}

function sourceForType(violationType: string): ViolationSource {
  const t = violationType.toLowerCase();
  if (t.startsWith("[ai]")) return "ai";
  if (t.startsWith("proctor_")) return "proctor";
  if (t.startsWith("[system]")) return "system";
  return "student";
}

function isRealUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

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

export type ProctorMessage = {
  id: string;
  exam_id: string;
  sender: string;
  sender_role: string;
  body: string;
  kind: "message" | "broadcast";
  created_at: string;
};

export async function listProctorMessages(examId: string): Promise<ProctorMessage[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("proctor_messages")
    .select("*")
    .eq("exam_id", examId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      exam_id: String(r.exam_id),
      sender: String(r.sender ?? "Proctor"),
      sender_role: String(r.sender_role ?? "proctor"),
      body: String(r.body ?? ""),
      kind: (r.kind as ProctorMessage["kind"]) ?? "message",
      created_at: String(r.created_at),
    };
  });
}

export async function sendProctorMessage(opts: {
  examId: string;
  sender: string;
  senderRole: string;
  body: string;
  kind?: "message" | "broadcast";
}): Promise<boolean> {
  const db = getSupabase();
  if (!db || !opts.body.trim()) return false;
  const { error } = await db.from("proctor_messages").insert({
    exam_id: opts.examId,
    sender: opts.sender.slice(0, 80),
    sender_role: opts.senderRole === "proctor" ? "proctor" : opts.senderRole === "teacher" ? "teacher" : "proctor",
    body: opts.body.trim().slice(0, 500),
    kind: opts.kind === "broadcast" ? "broadcast" : "message",
  });
  return !error;
}

/** Realtime: fire `onChange` whenever a new message/broadcast lands for an exam. */
export function subscribeToMessages(examId: string, onChange: () => void): () => void {
  const db = getSupabase();
  if (!db) return () => undefined;
  const channel = db
    .channel(`messages-${examId}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "proctor_messages", filter: `exam_id=eq.${examId}` },
      () => onChange(),
    )
    .subscribe();
  return () => { void db.removeChannel(channel); };
}

// ── Proctor assignments (Assign Proctors modal) ──────────────────────────────

export type ProctorAssignment = {
  id: string;
  exam_id: string;
  assignee_name: string;
  assignee_role: "proctor" | "teacher" | "ta";
  /** teachers.id when the assignee has a platform account (enables "my exams"). */
  assignee_id: string | null;
  email: string | null;
  created_at: string;
};

export async function listProctorAssignments(examId: string): Promise<ProctorAssignment[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("proctor_assignments")
    .select("*")
    .eq("exam_id", examId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      exam_id: String(r.exam_id),
      assignee_name: String(r.assignee_name),
      assignee_role: (r.assignee_role as ProctorAssignment["assignee_role"]) ?? "proctor",
      assignee_id: r.assignee_id ? String(r.assignee_id) : null,
      email: r.email ? String(r.email) : null,
      created_at: String(r.created_at),
    };
  });
}

/** A teacher/proctor row: used by the Assign Proctors modal + delegate pickers. */
export type FacultyMember = {
  id: string | null;
  name: string;
  role: string;
  department: string | null;
  email: string | null;
};

export async function listFaculty(): Promise<FacultyMember[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("teachers")
    .select("id, full_name, name, role, department, email")
    .order("full_name", { ascending: true });
  if (error || !data) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: r.id ? String(r.id) : null,
      name: String(r.full_name ?? r.name ?? "Faculty"),
      role: String(r.role ?? "teacher"),
      department: r.department ? String(r.department) : null,
      email: r.email ? String(r.email) : null,
    };
  });
}

/** Assign a delegate (colleague) to cross-check marks for candidate attempts. */
export async function assignGradingDelegates(attemptIds: string[], delegateName: string): Promise<number> {
  const db = getSupabase();
  if (!db || !delegateName.trim()) return 0;
  const rows = attemptIds
    .filter((id) => isRealUuid(id))
    .map((attempt_id) => ({ attempt_id, delegate_name: delegateName.trim(), assigned_by: "teacher" }));
  if (rows.length === 0) return 0;
  const { error } = await db.from("grading_delegations").upsert(rows, { onConflict: "attempt_id,delegate_name" });
  return error ? 0 : rows.length;
}

export async function saveProctorAssignments(
  examId: string,
  assignments: { name: string; role: "proctor" | "teacher" | "ta"; id?: string | null; email?: string | null }[],
): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const names = assignments.map((a) => a.name);
  // Remove rows the teacher unchecked (only when there is at least one kept row).
  if (names.length > 0) {
    const { error: delErr } = await db
      .from("proctor_assignments")
      .delete()
      .eq("exam_id", examId)
      .not("assignee_name", "in", `(${names.map((n) => `"${n}"`).join(",")})`);
    if (delErr) return false;
  }
  const { error: insErr } = await db
    .from("proctor_assignments")
    .upsert(
      assignments.map((a) => ({
        exam_id: examId,
        assignee_name: a.name,
        assignee_role: a.role,
        assignee_id: a.id ?? null,
        email: a.email ?? null,
      })),
      { onConflict: "exam_id,assignee_name" },
    );
  return !insErr;
}

/**
 * Exams the signed-in proctor/teacher has been assigned to monitor
 * (proctor_assignments.assignee_id = my teachers.id). Used by the proctor
 * console to replace its hard-coded exam id.
 */
export async function listAssignedExamsForAuthUser(): Promise<
  { id: string; name: string; batch: string; status: string; mode: string; assignee_role: string }[]
> {
  const db = getSupabase();
  if (!db) return [];
  const { data: sessionData } = await db.auth.getUser();
  const authId = sessionData?.user?.id;
  if (!authId) return [];
  const { data: me } = await db
    .from("teachers")
    .select("id")
    .eq("auth_id", authId)
    .maybeSingle();
  if (!me?.id) return [];
  const { data, error } = await db
    .from("proctor_assignments")
    .select("exam_id, assignee_role, exam:exams(id, name, batch, status, mode)")
    .eq("assignee_id", me.id as string)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  const seen = new Set<string>();
  const out: { id: string; name: string; batch: string; status: string; mode: string; assignee_role: string }[] = [];
  for (const raw of data as unknown[]) {
    const r = raw as { exam_id?: string; assignee_role?: string; exam?: unknown };
    const examRow = Array.isArray(r.exam) ? (r.exam as unknown[])[0] : r.exam;
    const e = (examRow ?? {}) as Record<string, unknown>;
    const id = String(e.id ?? r.exam_id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(e.name ?? id),
      batch: String(e.batch ?? ""),
      status: String(e.status ?? ""),
      mode: String(e.mode ?? "lockdown"),
      assignee_role: String(r.assignee_role ?? "proctor"),
    });
  }
  return out;
}

// ── Teacher grading comments (inline + voice) ────────────────────────────────

export type GradingComment = {
  id: string;
  attempt_id: string;
  question_id: string | null;
  comment: string;
  voice_key: string | null;
  created_by: string | null;
  created_at: string;
};

export async function addGradingComment(opts: {
  attemptId: string;
  questionId?: string | null;
  comment: string;
  voiceKey?: string | null;
  createdBy?: string | null;
}): Promise<boolean> {
  const db = getSupabase();
  if (!db || !isRealUuid(opts.attemptId) || !opts.comment.trim()) return false;
  const { error } = await db.from("grading_comments").insert({
    attempt_id: opts.attemptId,
    question_id: opts.questionId ?? null,
    comment: opts.comment.trim().slice(0, 2000),
    voice_key: opts.voiceKey ?? null,
    created_by: opts.createdBy ?? null,
  });
  return !error;
}

export async function listGradingComments(attemptId: string): Promise<GradingComment[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("grading_comments")
    .select("*")
    .eq("attempt_id", attemptId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      attempt_id: String(r.attempt_id),
      question_id: r.question_id ? String(r.question_id) : null,
      comment: String(r.comment ?? ""),
      voice_key: r.voice_key ? String(r.voice_key) : null,
      created_by: r.created_by ? String(r.created_by) : null,
      created_at: String(r.created_at),
    };
  });
}

// ── Exam settings & teacher profile ───────────────────────────────────────────

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

/** Persist a settings blob on the signed-in teacher's row (merged, not replaced). */
export async function saveTeacherSettings(patch: Record<string, unknown>): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return false;
  const { data: me } = await db
    .from("teachers")
    .select("id, settings")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!me) return false;
  const cur = (me as { settings?: Record<string, unknown> }).settings ?? {};
  const { error } = await db
    .from("teachers")
    .update({ settings: { ...cur, ...patch } })
    .eq("id", (me as { id: string }).id);
  return !error;
}

/** Read the signed-in teacher's settings blob. */
export async function getTeacherSettings(): Promise<Record<string, unknown>> {
  const db = getSupabase();
  if (!db) return {};
  const { data: { user } } = await db.auth.getUser();
  if (!user) return {};
  const { data: me } = await db
    .from("teachers")
    .select("settings")
    .eq("auth_id", user.id)
    .maybeSingle();
  return (me as { settings?: Record<string, unknown> } | null)?.settings ?? {};
}

/** Update the signed-in teacher's profile fields (full_name/department/etc). */
export async function updateTeacherProfile(fields: {
  full_name?: string;
  department?: string;
  designation?: string;
  email?: string;
}): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return false;
  const clean: Record<string, unknown> = {};
  if (fields.full_name !== undefined) clean.full_name = fields.full_name.trim();
  if (fields.department !== undefined) clean.department = fields.department.trim();
  if (fields.designation !== undefined) clean.designation = fields.designation.trim();
  if (fields.email !== undefined) clean.email = fields.email.trim();
  if (Object.keys(clean).length === 0) return false;
  const { error } = await db.from("teachers").update(clean).eq("auth_id", user.id);
  return !error;
}

// ── Evaluator allocation (Mettl-style examiner dashboard) ────────────────────

export type DelegationRow = {
  id: string;
  attempt_id: string | null;
  exam_id: string | null;
  delegate_id: string | null;
  delegate_name: string;
  due_date: string | null;
  report_count: number;
  created_at: string;
  student_roll: string | null;
  student_name: string | null;
};

export async function listGradingDelegations(): Promise<DelegationRow[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("grading_delegations")
    .select("id, attempt_id, exam_id, delegate_id, delegate_name, due_date, report_count, created_at, attempt:attempts(student:students(roll, full_name))")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    const attRel = Array.isArray(r.attempt) ? (r.attempt as unknown[])[0] : r.attempt;
    const att = (attRel ?? {}) as Record<string, unknown>;
    const stRel = Array.isArray(att.student) ? (att.student as unknown[])[0] : att.student;
    const st = (stRel ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      attempt_id: r.attempt_id ? String(r.attempt_id) : null,
      exam_id: r.exam_id ? String(r.exam_id) : null,
      delegate_id: r.delegate_id ? String(r.delegate_id) : null,
      delegate_name: String(r.delegate_name ?? ""),
      due_date: r.due_date ? String(r.due_date) : null,
      report_count: Number(r.report_count ?? 0),
      created_at: String(r.created_at ?? ""),
      student_roll: st.roll ? String(st.roll) : null,
      student_name: st.full_name ? String(st.full_name) : null,
    };
  });
}

/** Read the allocation metadata stored on the exam's settings jsonb. */
export async function getExamAllocation(examId: string): Promise<{
  status: "allocated" | "not_allocated";
  role?: string;
  due_date?: string | null;
  assigned?: number;
  total?: number;
  evaluators?: { id: string; name: string; email?: string | null; count: number }[];
} | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.from("exams").select("settings").eq("id", examId).maybeSingle();
  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  const alloc = settings.allocation as
    | { status?: string; role?: string; due_date?: string | null; assigned?: number; total?: number; evaluators?: unknown }
    | undefined;
  if (!alloc) return { status: "not_allocated" };
  return {
    status: alloc.status === "allocated" ? "allocated" : "not_allocated",
    role: alloc.role,
    due_date: alloc.due_date ?? null,
    assigned: Number(alloc.assigned ?? 0),
    total: Number(alloc.total ?? 0),
    evaluators: Array.isArray(alloc.evaluators)
      ? (alloc.evaluators as { id?: string; name?: string; email?: string | null; count?: number }[]).map((e) => ({
          id: String(e.id ?? ""),
          name: String(e.name ?? ""),
          email: e.email ?? null,
          count: Number(e.count ?? 0),
        }))
      : undefined,
  };
}

/**
 * Mettl-style "Auto-assign test reports": distribute the exam's submitted,
 * not-yet-delegated attempts across the chosen evaluators according to the
 * per-evaluator report counts, record a due date, and mark the exam allocated.
 * Returns { ok, error?, assigned }.
 */
export async function assignEvaluators(opts: {
  examId: string;
  role: string;
  dueDate: string | null;
  evaluators: { id: string; name: string; email?: string | null; count: number }[];
}): Promise<{ ok: boolean; error?: string; assigned?: number }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const { examId, role, dueDate, evaluators } = opts;
  const active = evaluators.filter((e) => e.count > 0 && e.id);
  if (active.length === 0) return { ok: false, error: "Select at least one evaluator with a report count" };

  // Submitted attempts for the exam that are not already delegated.
  const { data: attempts } = await db
    .from("attempts")
    .select("id")
    .eq("exam_id", examId)
    .eq("state", "submitted");
  if (!attempts) return { ok: false, error: "Could not load submitted attempts" };
  const { data: existing } = await db.from("grading_delegations").select("attempt_id").eq("exam_id", examId);
  const delegatedIds = new Set((existing ?? []).map((r: { attempt_id?: string | null }) => r.attempt_id));
  const unassigned = (attempts as { id: string }[])
    .map((a) => a.id)
    .filter((id) => !delegatedIds.has(id));

  const totalWanted = active.reduce((s, e) => s + e.count, 0);
  const total = unassigned.length;
  // If the requested counts exceed available reports, scale down proportionally.
  const scale = totalWanted > total && total > 0 ? total / totalWanted : 1;
  const counts = active.map((e) => ({
    ...e,
    count: Math.max(0, Math.floor(e.count * scale)),
  }));

  // Delete previous batch rows (attempt rows are upserted by attempt_id+name).
  await db.from("grading_delegations").delete().eq("exam_id", examId).is("attempt_id", null);

  // Distribute round-robin weighted by the (scaled) counts.
  const pool: string[] = [];
  for (const e of counts) for (let i = 0; i < e.count; i++) pool.push(e.id);
  const rows: { attempt_id: string; exam_id: string; delegate_id: string; delegate_name: string; due_date: string | null }[] = [];
  for (let i = 0; i < unassigned.length; i++) {
    const evaluator = counts[i % counts.length];
    rows.push({
      attempt_id: unassigned[i],
      exam_id: examId,
      delegate_id: evaluator.id,
      delegate_name: evaluator.name,
      due_date: dueDate,
    });
  }
  if (rows.length > 0) {
    const { error } = await db.from("grading_delegations").upsert(rows, { onConflict: "attempt_id,delegate_name" });
    if (error) return { ok: false, error: String(error.message ?? error) };
  }

  const assigned = rows.length;
  await updateExam(examId, {
    settings: {
      allocation: {
        status: "allocated",
        role,
        due_date: dueDate,
        assigned,
        total,
        evaluators: counts.map((e) => ({ id: e.id, name: e.name, email: e.email ?? null, count: e.count })),
      },
    },
  });
  return { ok: true, assigned };
}

export type ExaminerExamRow = {
  id: string;
  name: string;
  batch: string;
  status: string;
  mode: string;
  duration_minutes: number;
  pool_count: number;
  created_at: string | null;
  roster_count: number;
  submitted: number;
  auto_graded: number;
  unassigned: number;
  delegates: number;
  allocation: Awaited<ReturnType<typeof getExamAllocation>>;
};

/** Aggregated numbers for the Examiner dashboard (one DB pass + light grouping). */
export async function loadExaminerDashboard(): Promise<{
  exams: ExaminerExamRow[];
  totalTestTakers: number;
  totalEvaluators: number;
  daily: { day: string; label: string; submitted: number; graded: number }[];
}> {
  const db = getSupabase();
  const empty = { exams: [], totalTestTakers: 0, totalEvaluators: 0, daily: [] };
  if (!db) return empty;

  const [exams, attempts, enrollments, delegations] = await Promise.all([
    listExamsForTeacher(),
    db
      .from("attempts")
      .select("exam_id, state, score, submitted_at")
      .in("state", ["in_progress", "submitted", "paused"])
      .then((r: { data?: unknown[] | null }) => r.data ?? []),
    db
      .from("enrollments")
      .select("exam_id, student_id")
      .then((r: { data?: unknown[] | null }) => r.data ?? []),
    listGradingDelegations(),
  ]);

  const enrollmentCounts = new Map<string, number>();
  for (const e of enrollments as { exam_id?: string; student_id?: string }[]) {
    if (!e.exam_id) continue;
    enrollmentCounts.set(e.exam_id, (enrollmentCounts.get(e.exam_id) ?? 0) + 1);
  }

  const perExam: Record<string, { submitted: number; auto_graded: number; unassigned: number; delegates: Set<string> }> = {};
  for (const a of attempts as { exam_id?: string; state?: string; score?: number | null }[]) {
    if (!a.exam_id) continue;
    const bucket = (perExam[a.exam_id] ??= { submitted: 0, auto_graded: 0, unassigned: 0, delegates: new Set<string>() });
    if (a.state === "submitted") {
      bucket.submitted += 1;
      if (typeof a.score === "number") bucket.auto_graded += 1;
    }
  }
  const delegatedAttempts = new Set<string>();
  const delegateNames = new Set<string>();
  for (const d of delegations) {
    if (d.delegate_name) delegateNames.add(d.delegate_name.toLowerCase());
    if (d.exam_id && d.attempt_id) {
      delegatedAttempts.add(d.attempt_id);
      const bucket = (perExam[d.exam_id] ??= { submitted: 0, auto_graded: 0, unassigned: 0, delegates: new Set<string>() });
      bucket.delegates.add(d.delegate_name.toLowerCase());
    }
  }

  const rows: ExaminerExamRow[] = [];
  for (const exam of exams) {
    const bucket = (perExam[exam.id] ??= { submitted: 0, auto_graded: 0, unassigned: 0, delegates: new Set<string>() });
    const allocation = await getExamAllocation(exam.id);
    const submittedAttempts = bucket.submitted;
    rows.push({
      id: exam.id,
      name: exam.name,
      batch: exam.batch,
      status: exam.status,
      mode: exam.mode,
      duration_minutes: exam.duration_minutes,
      pool_count: exam.pool_count,
      created_at: exam.created_at ?? null,
      roster_count: enrollmentCounts.get(exam.id) ?? 0,
      submitted: submittedAttempts,
      auto_graded: bucket.auto_graded,
      unassigned: allocation?.status === "allocated"
        ? Math.max(0, submittedAttempts - (allocation.assigned ?? 0))
        : submittedAttempts,
      delegates: bucket.delegates.size,
      allocation,
    });
  }
  void delegatedAttempts;

  const totalTestTakers = rows.reduce((s, r) => s + r.roster_count, 0);
  const totalEvaluators = delegateNames.size;

  // Daily submissions over the last 14 days (submitted vs already graded).
  const dayBuckets = new Map<string, { day: string; label: string; submitted: number; graded: number }>();
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dayBuckets.set(d.toDateString(), { day: d.toDateString(), label: d.toLocaleDateString([], { day: "numeric", month: "short" }), submitted: 0, graded: 0 });
  }
  for (const a of attempts as { submitted_at?: string | null; score?: number | null }[]) {
    if (!a.submitted_at) continue;
    const d = new Date(a.submitted_at);
    const bucket = dayBuckets.get(d.toDateString());
    if (bucket) {
      bucket.submitted += 1;
      if (typeof a.score === "number") bucket.graded += 1;
    }
  }
  return { exams: rows, totalTestTakers, totalEvaluators, daily: Array.from(dayBuckets.values()) };
}
