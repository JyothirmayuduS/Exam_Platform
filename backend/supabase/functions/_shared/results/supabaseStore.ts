// Postgres implementation of ResultsStore. Needs a service-role client.
// deno-lint-ignore-file no-explicit-any
import { readAll, readAllIn } from "../db/paging.ts";
import type { DBQuestion } from "../exam/types.ts";
import type { ResultsStore } from "./handler.ts";
import type { ExportAttempt, ExportExam, ExportStudent } from "./rows.ts";

type Db = any;

const EXAM_COLS = "id, name, batch, status, scheduled_at, duration_minutes, total_marks, passing_marks, created_by, settings, academic_type, subject_code, subject_name";
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, "");

const toExam = (r: any): ExportExam => ({
  id: String(r.id),
  name: String(r.name ?? r.id),
  batch: r.batch ?? null,
  status: r.status ?? null,
  scheduled_at: r.scheduled_at ?? null,
  duration_minutes: r.duration_minutes ?? null,
  total_marks: r.total_marks ?? null,
  passing_marks: r.passing_marks ?? null,
  created_by: r.created_by ? String(r.created_by) : null,
  settings: r.settings && typeof r.settings === "object" ? r.settings : {},
  academic_type: r.academic_type ?? null,
  subject_code: r.subject_code ?? null,
  subject_name: r.subject_name ?? null,
});

function options(raw: unknown): string[] | null {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(v) ? v.map(String) : null;
}

export function supabaseResultsStore(db: Db): ResultsStore {
  const must = <T>({ data, error }: { data: T; error: { message: string } | null }): T => {
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    async examById(id) {
      if (!id) return null;
      const data = must(await db.from("exams").select(EXAM_COLS).eq("id", id).maybeSingle());
      return data ? toExam(data) : null;
    },

    async examsForProgramme(programme, semester) {
      const rows = await readAll(() =>
        db.from("exams").select(EXAM_COLS).neq("status", "draft").ilike("settings->>programme", escapeLike(programme.trim())).order("id"));
      return rows.map(toExam).filter((e) => norm(e.settings?.semester) === norm(semester));
    },

    async examData(examId) {
      const links = await readAll(() => db.from("exam_questions").select("question_id").eq("exam_id", examId).order("question_id"));
      const owned = await readAll(() => db.from("questions").select("id").eq("exam_id", examId).order("id"));
      const ids = Array.from(new Set([...links.map((r) => String(r.question_id)), ...owned.map((r) => String(r.id))]));
      const questions = await readAllIn(ids, (chunk) =>
        db.from("questions").select("id, exam_id, title, type, unit, difficulty, marks, options, answer, subjective_mode").in("id", chunk).order("id"));
      const pool: DBQuestion[] = questions.map((r) => ({
        id: String(r.id),
        exam_id: r.exam_id ? String(r.exam_id) : null,
        title: String(r.title ?? ""),
        type: String(r.type ?? "MCQ"),
        unit: r.unit ? String(r.unit) : null,
        difficulty: r.difficulty ? String(r.difficulty) : null,
        marks: Number(r.marks ?? 1),
        options: options(r.options),
        answer: r.answer === null || r.answer === undefined ? null : String(r.answer),
        subjective_mode: r.subjective_mode ?? null,
      }));
      const enrolled = (await readAll(() => db.from("enrollments").select("student_id").eq("exam_id", examId).order("student_id")))
        .map((r) => String(r.student_id));
      const attempts: ExportAttempt[] = (await readAll(() =>
        db.from("attempts").select("id, student_id, state, score, submitted_at, paper, answers").eq("exam_id", examId).order("id")))
        .filter((r) => r.student_id)
        .map((r) => ({
          id: String(r.id),
          student_id: String(r.student_id),
          state: r.state ?? null,
          score: r.score === null || r.score === undefined ? null : Number(r.score),
          submitted_at: r.submitted_at ?? null,
          paper: r.paper ?? null,
          answers: r.answers && typeof r.answers === "object" ? r.answers : {},
        }));
      const holds = await readAll(() => db.from("result_holds").select("attempt_id").eq("exam_id", examId).order("attempt_id"));
      return { pool, enrolled, attempts, heldAttemptIds: new Set(holds.map((r) => String(r.attempt_id))) };
    },

    async students(ids) {
      const rows = await readAllIn(ids, (chunk) => db.from("students").select("id, roll, full_name").in("id", chunk).order("id"));
      return new Map<string, ExportStudent>(rows.map((r) => [String(r.id), { id: String(r.id), roll: String(r.roll ?? ""), full_name: r.full_name ?? null }]));
    },

    async audit(e) {
      must(await db.from("audit_logs").insert({
        actor_id: e.actorId,
        actor_role: "teacher",
        action: e.action,
        target_type: e.targetType,
        target_id: e.targetId,
        meta: e.meta,
      }));
    },
  };
}
