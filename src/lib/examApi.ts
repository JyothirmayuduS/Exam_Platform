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
  exam_id: string;
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
    return { ok: true, data: data as DBQuestion };
  }
}

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

export async function startAttempt(opts: {
  examId: string;
  studentId: string;
  total: number;
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
    const { error } = await db
      .from("attempts")
      .update({ state: "in_progress", started_at: new Date().toISOString(), total: opts.total })
      .eq("id", existing.id);
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
  submitted_at: string | null;
  auto_saved_at: string | null;
  student: { id: string; roll: string; full_name: string } | null;
  violations?: { id: string; severity: string; description: string; created_at: string }[];
};

/** All attempts for an exam, joined with the student, newest activity first. */
export async function listLiveAttempts(examId: string): Promise<LiveAttempt[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("attempts")
    .select("id,exam_id,state,answered,total,minutes_used,score,answers,submitted_at,auto_saved_at,student:students(id,roll,full_name)")
    .eq("exam_id", examId)
    .order("auto_saved_at", { ascending: false });

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
          submitted_at: (r.submitted_at as string) ?? null,
          auto_saved_at: (r.auto_saved_at as string) ?? null,
          student: student
            ? {
                id: String((student as Record<string, unknown>).id),
                roll: String((student as Record<string, unknown>).roll),
                full_name: String((student as Record<string, unknown>).full_name),
              }
            : null,
          violations: Array.isArray(r.violations)
            ? r.violations.map((v) => ({
                id: String(v.id),
                severity: String(v.severity),
                description: String(v.description),
                created_at: String(v.created_at),
              }))
            : [],
        } as LiveAttempt;
      });

  // Track enrolled students who already have an attempt
  const seenStudentIds = new Set<string>();
  for (const a of attempts) {
    if (a.student?.id) seenStudentIds.add(a.student.id);
  }

  // Also query enrolled students who haven't started an attempt yet
  try {
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
            submitted_at: null,
            auto_saved_at: null,
            student: {
              id: String((st as Record<string, unknown>).id),
              roll: String((st as Record<string, unknown>).roll),
              full_name: String((st as Record<string, unknown>).full_name),
            },
            violations: [],
          });
        }
      }
    }
  } catch {
    // Non-blocking fallback
  }

  return attempts;
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

export async function updateAttemptScore(attemptId: string, score: number): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { error } = await db
    .from("attempts")
    .update({ score })
    .eq("id", attemptId);
  return !error;
}

export async function saveViolation(
  attemptId: string,
  examId: string,
  studentId: string,
  violationType: string,
  description: string
): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  
  const { error } = await db.from("violation_events").insert({
    attempt_id: attemptId,
    exam_id: examId,
    student_id: studentId,
    violation_type: violationType,
    severity: "warning",
    description,
    timestamp: new Date().toISOString()
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
