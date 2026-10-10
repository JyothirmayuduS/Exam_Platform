// One ERP row per student per exam, built from released results only.
// Marks come from the stored score (what the teacher finalised); the MCQ part
// is recomputed from the paper with the same auto-grader submit uses, and the
// descriptive part is whatever the teacher added on top.
import { autoGradeAttempt } from "../exam/autoGrade.ts";
import { examClosed, visibilityFor, type ReleaseSettings } from "../exam/release.ts";
import { round2, type NegativeSettings } from "../exam/scoring.ts";
import type { DBQuestion } from "../exam/types.ts";
import type { ResultStatus } from "./columns.ts";

export type ExportExam = {
  id: string;
  name: string;
  batch: string | null;
  status: string | null;
  scheduled_at: string | null;
  duration_minutes: number | null;
  total_marks: number | null;
  passing_marks: number | null;
  created_by: string | null;
  settings: Record<string, unknown> | null;
  academic_type?: string | null;
  subject_code?: string | null;
  subject_name?: string | null;
};
export type ExportStudent = { id: string; roll: string; full_name: string | null };
export type ExportAttempt = {
  id: string;
  student_id: string;
  state: string | null;
  score: number | null;
  submitted_at: string | null;
  paper: unknown;
  answers: Record<string, unknown> | null;
};

export type ResultRow = {
  roll: string;
  name: string;
  programme: string;
  semester: string;
  course_code: string;
  academic_type: string;
  subject_name: string;
  exam_name: string;
  exam_id: string;
  batch: string;
  mcq_marks: number | null;
  descriptive_marks: number | null;
  total: number | null;
  maximum: number | null;
  percentage: number | null;
  result_status: ResultStatus;
  /** ISO timestamp of the submission; null when absent. */
  attempt_date: string | null;
};

export type ExamRows = {
  rows: ResultRow[];
  /** Students left out because their paper is not graded yet, or the exam is still open for them. */
  pending: number;
};

export type PassRule = { type: "percent" | "marks"; value: number };

const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** ERP details of the exam: the subject code is the course code; exams named
 *  before subject codes existed fall back to the course code set in Test options. */
export function examErpFields(exam: ExportExam): { programme: string; semester: string; course_code: string; academic_type: string; subject_name: string } {
  const s = exam.settings ?? {};
  return {
    programme: text(s.programme),
    semester: text(s.semester),
    course_code: text(exam.subject_code) || text(s.courseCode),
    academic_type: text(exam.academic_type),
    subject_name: text(exam.subject_name),
  };
}

/** Pass mark chosen on the exam: a percentage of the maximum, or plain marks. */
export function passRule(exam: ExportExam): PassRule {
  const s = exam.settings ?? {};
  const type = s.passMarkType === "marks" ? "marks" : "percent";
  const fromSettings = Number(s.passMark);
  const value = Number.isFinite(fromSettings) && s.passMark !== "" && s.passMark !== null && s.passMark !== undefined
    ? fromSettings
    : Number(exam.passing_marks ?? 40);
  return { type, value: Number.isFinite(value) ? Math.max(0, value) : 40 };
}

export function passed(total: number, max: number, rule: PassRule): boolean {
  const needed = rule.type === "percent" ? (max * rule.value) / 100 : rule.value;
  return total + 1e-9 >= needed;
}

/** Students may see scores: released by the teacher, or released automatically. */
export function resultsReleased(exam: ExportExam, now: number): boolean {
  return visibilityFor(exam.settings as ReleaseSettings, { examClosed: examClosed(exam, now), graded: true }).score;
}

/** Nobody can still sit the exam, so a missing submission means absent. */
export function examFinished(exam: ExportExam, now: number): boolean {
  const s = (exam.settings ?? {}) as ReleaseSettings;
  return examClosed(exam, now) || s.results_published === true || s.answer_key_published === true;
}

function mostCommon(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [v, n] of counts) if (n > bestCount) { best = v; bestCount = n; }
  return best;
}

export function buildExamRows(input: {
  exam: ExportExam;
  pool: DBQuestion[];
  enrolled: string[];
  students: Map<string, ExportStudent>;
  attempts: ExportAttempt[];
  heldAttemptIds: Set<string>;
  now: number;
}): ExamRows {
  const { exam, pool, students, attempts, heldAttemptIds, now } = input;
  const erp = examErpFields(exam);
  const rule = passRule(exam);
  const finished = examFinished(exam, now);
  const settings = (exam.settings ?? {}) as NegativeSettings;

  const byStudent = new Map<string, ExportAttempt[]>();
  for (const a of attempts) byStudent.set(a.student_id, [...(byStudent.get(a.student_id) ?? []), a]);
  const studentIds = Array.from(new Set([...input.enrolled, ...byStudent.keys()]));

  type Draft = Omit<ResultRow, "maximum" | "percentage"> & { maximum: number | null };
  const drafts: Draft[] = [];
  let pending = 0;

  for (const sid of studentIds) {
    const student = students.get(sid);
    if (!student) continue;
    const mine = byStudent.get(sid) ?? [];
    const submitted = mine
      .filter((a) => a.state === "submitted")
      .sort((a, b) => Date.parse(b.submitted_at ?? "") - Date.parse(a.submitted_at ?? ""));
    const latest = submitted[0];
    const base = {
      roll: student.roll,
      name: student.full_name ?? "",
      ...erp,
      exam_name: exam.name,
      exam_id: exam.id,
      batch: exam.batch ?? "",
    };
    const held = mine.some((a) => heldAttemptIds.has(a.id));

    if (held) {
      const grade = latest ? autoGradeAttempt(pool, latest.paper, latest.answers ?? {}, settings) : null;
      drafts.push({
        ...base, mcq_marks: null, descriptive_marks: null, total: null,
        maximum: grade && grade.max > 0 ? grade.max : null,
        result_status: "withheld", attempt_date: latest?.submitted_at ?? null,
      });
      continue;
    }
    if (!latest) {
      if (!finished) { pending += 1; continue; }
      drafts.push({ ...base, mcq_marks: null, descriptive_marks: null, total: null, maximum: null, result_status: "absent", attempt_date: null });
      continue;
    }
    if (latest.score === null || latest.score === undefined) { pending += 1; continue; }

    const grade = autoGradeAttempt(pool, latest.paper, latest.answers ?? {}, settings);
    const total = round2(Number(latest.score));
    const maximum = grade.max > 0 ? grade.max : Number(exam.total_marks ?? 0) || null;
    const mcq = grade.manual === 0 ? total : round2(grade.objectiveScore);
    const descriptive = grade.manual === 0 ? 0 : round2(total - mcq);
    drafts.push({
      ...base,
      mcq_marks: mcq,
      descriptive_marks: descriptive,
      total,
      maximum,
      result_status: maximum && passed(total, maximum, rule) ? "pass" : "fail",
      attempt_date: latest.submitted_at,
    });
  }

  // Absent students wrote no paper; show the maximum most candidates had.
  const typicalMax = mostCommon(drafts.filter((d) => d.total !== null && d.maximum).map((d) => d.maximum!)) ?? (Number(exam.total_marks ?? 0) || null);
  const rows: ResultRow[] = drafts.map((d) => {
    const maximum = d.maximum ?? typicalMax;
    return { ...d, maximum, percentage: d.total !== null && maximum ? round2((d.total / maximum) * 100) : null };
  });
  rows.sort((a, b) => a.roll.localeCompare(b.roll, "en", { numeric: true }));
  return { rows, pending };
}
