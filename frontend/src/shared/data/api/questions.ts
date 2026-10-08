// ──────────────────────────────────────────────────────────────────────────
// Domain module: questions — extracted from src/shared/data/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "@/shared/data/supabase";
import type { ExamRecord, PaperSlot, DBQuestion, ExamBundle, Student } from "@/shared/data/api/types";
import { normalizeOptions, normalizeExamRecord } from "@/shared/data/api/helpers";
import { buildPaper, questionsForPaper } from "@/shared/domain/exam/paperBuilder";

/** Readable question columns. `answer` is not granted to API roles: staff read
 *  it through `staff_question_answers`, students through `student_exam_questions`. */
export const QUESTION_COLUMNS = "id, exam_id, title, type, unit, difficulty, marks, options, subjective_mode, created_at";

/** Answer keys for the given questions (teachers only; empty for everyone else). */
export async function fetchAnswerKeys(ids: string[]): Promise<Map<string, string | null>> {
  const db = getSupabase();
  const out = new Map<string, string | null>();
  if (!db || ids.length === 0) return out;
  const { data } = await db.rpc("staff_question_answers", { p_ids: ids });
  for (const r of (data ?? []) as { id: string; answer: string | null }[]) out.set(String(r.id), r.answer ?? null);
  return out;
}

async function withAnswerKeys<T extends { id: string }>(rows: T[]): Promise<(T & { answer: string | null })[]> {
  const keys = await fetchAnswerKeys(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, answer: keys.get(r.id) ?? null }));
}

/** All questions across the teacher's exams (for the question-bank page). */
export async function listAllQuestions(): Promise<(DBQuestion & { exam_name: string | null })[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data: rows, error } = await db
    .from("questions")
    .select(`${QUESTION_COLUMNS}, exam:exams(name)`)
    .order("created_at", { ascending: false });
  if (error || !rows) return [];
  const data = await withAnswerKeys((rows as unknown as { id: string }[]).map((r) => ({ ...r, id: String(r.id) })));
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
    const { data, error } = await db.from("questions").update(question).eq("id", question.id).select(QUESTION_COLUMNS).single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: { ...(data as unknown as DBQuestion), answer: question.answer ?? null } };
  } else {
    // Generate a quick ID
    const newId = `Q-${Math.floor(1000 + Math.random() * 9000)}`;
    const { data, error } = await db.from("questions").insert({ ...question, id: newId }).select(QUESTION_COLUMNS).single();
    if (error) return { ok: false, error: error.message };
    const row = data as unknown as DBQuestion;
    // Mirror ownership into the M:N pool join so the pool reads stay consistent.
    if (question.exam_id && row?.id) void linkQuestionsToExam(String(question.exam_id), [String(row.id)]);
    return { ok: true, data: { ...row, answer: question.answer ?? null } };
  }
}

/**
 * Questions that belong to an exam's pool. Membership is many-to-many through
 * exam_questions (bank questions are reusable across exams); rows created
 * before the join migration also count via their legacy questions.exam_id.
 * Falls back to the legacy single-owner query when the join table is missing
 * (migration not yet applied), so this works either way.
 */


/**
 * Questions that belong to an exam's pool. Membership is many-to-many through
 * exam_questions (bank questions are reusable across exams); rows created
 * before the join migration also count via their legacy questions.exam_id.
 * Falls back to the legacy single-owner query when the join table is missing
 * (migration not yet applied), so this works either way.
 */
export async function listQuestionsForExam(examId: string, opts: { withAnswers?: boolean } = {}): Promise<DBQuestion[]> {
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
  const { data, error } = await db
    .from("questions")
    .select(QUESTION_COLUMNS)
    .in("id", ids)
    .order("id", { ascending: true });
  if (error || !data) return [];
  const rows = (data as unknown as DBQuestion[]).map((row) => ({ ...row, options: normalizeOptions(row.options), answer: null }));
  return opts.withAnswers ? withAnswerKeys(rows) : rows;
}

/** A student's view of an exam pool: enrolled, published exams only. The
 *  answer key is filled in only for practice exams or once it is released. */
export async function listStudentExamQuestions(examId: string): Promise<DBQuestion[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db.rpc("student_exam_questions", { p_exam: examId });
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


/**
 * Load one exam and its question set for a student sitting it. Returns
 * `{ exam: null, questions: [] }` when Supabase isn't configured so callers can
 * fall back to their built-in demo questions.
 */
export async function loadExamBundle(examId: string, opts: { withAnswers?: boolean } = {}): Promise<ExamBundle> {
  const db = getSupabase();
  if (!db) return { exam: null, questions: [] };
  const [examRes, questions] = await Promise.all([
    db.from("exams").select("*").eq("id", examId).maybeSingle(),
    listQuestionsForExam(examId, opts),
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
  const { exam, questions: pool } = await loadStudentExamBundle(examId);
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
        sections: settings.sections === true,
        fixedSectionOrder: settings.fixedSectionOrder === true,
      });
      if (att?.id) {
        await db.from("attempts").update({ paper }).eq("id", String(att.id));
      }
    }
  }

  const ordered = questionsForPaper(paper, pool);
  const slotById = new Map(paper.map((s) => [s.id, s]));
  const questions = ordered.map((q) => ({
    ...q,
    options: slotById.get(q.id)?.options ?? normalizeOptions(q.options),
  }));
  return { exam, questions, paper, attemptId };
}


export async function loadExamForStudent(examId: string): Promise<{
  exam: ExamRecord | null;
  questionCount: number;
}> {
  const { exam, questions } = await loadStudentExamBundle(examId);
  return { exam, questionCount: questions.length };
}

/** Student-side exam + pool (see listStudentExamQuestions). */
export async function loadStudentExamBundle(examId: string): Promise<ExamBundle> {
  const db = getSupabase();
  if (!db) return { exam: null, questions: [] };
  const [examRes, questions] = await Promise.all([
    db.from("exams").select("*").eq("id", examId).maybeSingle(),
    listStudentExamQuestions(examId),
  ]);
  const exam = examRes.data ? normalizeExamRecord(examRes.data as ExamRecord) : null;
  return { exam, questions };
}

/** Options come back as jsonb (array) — guard against string/null shapes. */
