// Domain module: how exams are named. A teacher picks the academic type
// (Sem Exam, Mid Term…), the semester, the academic year and whether it is the
// regular or a supplementary attempt, then the subject code and subject name.
// The database refuses a code or subject name already used for the same type,
// semester, year and attempt, and names the exam
// "Type · CODE · Subject · Sem N · YYYY-YY" (plus "· Supplementary").

import { getSupabase } from "@/shared/data/supabase";

export type AcademicType = { name: string; sort_order: number; active: boolean };
export type AttemptLabel = "Regular" | "Supplementary";
export type ExamNaming = {
  academic_type: string;
  /** "1"–"12"; a string so the form can start empty. */
  semester: string;
  academic_year: string;
  attempt_label: AttemptLabel;
  subject_code: string;
  subject_name: string;
};
export type NamingField = "subject_code" | "subject_name";

export const SUBJECT_CODE_MAX = 30;
export const SUBJECT_NAME_MAX = 120;
export const SEMESTERS = Array.from({ length: 12 }, (_, i) => String(i + 1));
export const ATTEMPT_LABELS: AttemptLabel[] = ["Regular", "Supplementary"];

export const normalizeSubjectCode = (s: string) => s.replace(/\s+/g, "").toUpperCase();
export const normalizeSubjectName = (s: string) => s.trim().replace(/\s+/g, " ");

const yearLabel = (start: number) => `${start}-${String((start + 1) % 100).padStart(2, "0")}`;

/** The academic year a date falls in; a new year starts in June. */
export function currentAcademicYear(d = new Date()): string {
  return yearLabel(d.getMonth() >= 5 ? d.getFullYear() : d.getFullYear() - 1);
}

/** Last year, this year and the next two, for the form's list. */
export function academicYearOptions(d = new Date()): string[] {
  const start = Number(currentAcademicYear(d).slice(0, 4));
  return [start - 1, start, start + 1, start + 2].map(yearLabel);
}

export function isAcademicYear(s: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  return !!m && Number(m[2]) === (Number(m[1]) + 1) % 100;
}

export function emptyNaming(d = new Date()): ExamNaming {
  return { academic_type: "", semester: "", academic_year: currentAcademicYear(d), attempt_label: "Regular", subject_code: "", subject_name: "" };
}

export function normalizeNaming(n: ExamNaming): ExamNaming {
  return {
    academic_type: n.academic_type.trim(),
    semester: String(n.semester ?? "").trim(),
    academic_year: n.academic_year.trim(),
    attempt_label: n.attempt_label === "Supplementary" ? "Supplementary" : "Regular",
    subject_code: normalizeSubjectCode(n.subject_code),
    subject_name: normalizeSubjectName(n.subject_name),
  };
}

export function composeExamName(n: ExamNaming): string {
  const v = normalizeNaming(n);
  return `${v.academic_type} · ${v.subject_code} · ${v.subject_name} · Sem ${v.semester} · ${v.academic_year}${v.attempt_label === "Supplementary" ? " · Supplementary" : ""}`;
}

type Named = {
  name: string;
  academic_type?: string | null; subject_code?: string | null; subject_name?: string | null;
  semester?: number | string | null; academic_year?: string | null; attempt_label?: string | null;
};

export const hasNaming = (e: Omit<Named, "name">) =>
  !!(e.academic_type && e.subject_code && e.subject_name && e.semester && e.academic_year);

/** The form's values for an exam row; empty where the exam has none yet. */
export function namingOf(e: Omit<Named, "name">): ExamNaming {
  return {
    academic_type: e.academic_type ?? "",
    semester: e.semester ? String(e.semester) : "",
    academic_year: e.academic_year ?? "",
    attempt_label: e.attempt_label === "Supplementary" ? "Supplementary" : "Regular",
    subject_code: e.subject_code ?? "",
    subject_name: e.subject_name ?? "",
  };
}

/** The exam row's naming columns, with the name the database will give it. */
export function namingRecord(n: ExamNaming) {
  const v = normalizeNaming(n);
  return {
    academic_type: v.academic_type, semester: Number(v.semester), academic_year: v.academic_year, attempt_label: v.attempt_label,
    subject_code: v.subject_code, subject_name: v.subject_name, name: composeExamName(v),
  };
}

/** The exam's display name: built from its fields when they are all set. */
export function examTitle(e: Named): string {
  return hasNaming(e) ? composeExamName(namingOf(e)) : e.name;
}

/** What still blocks saving, in the order the form asks for it. */
export function namingProblem(n: ExamNaming): string | null {
  const v = normalizeNaming(n);
  if (!v.academic_type) return "Choose the academic type.";
  if (!SEMESTERS.includes(v.semester)) return "Choose the semester.";
  if (!isAcademicYear(v.academic_year)) return "Choose the academic year.";
  if (!v.subject_code) return "Enter the subject code.";
  if (!v.subject_name) return "Enter the subject name.";
  if (v.subject_code.length > SUBJECT_CODE_MAX) return `Keep the subject code to ${SUBJECT_CODE_MAX} characters.`;
  if (v.subject_name.length > SUBJECT_NAME_MAX) return `Keep the subject name to ${SUBJECT_NAME_MAX} characters.`;
  return null;
}

/** "Sem 3, 2026-27" or "Sem 3, 2026-27, supplementary". */
export function termLabel(n: ExamNaming): string {
  const v = normalizeNaming(n);
  return `Sem ${v.semester}, ${v.academic_year}${v.attempt_label === "Supplementary" ? ", supplementary" : ""}`;
}

export function conflictMessage(field: NamingField, n: ExamNaming): string {
  const v = normalizeNaming(n);
  const what = field === "subject_code" ? `subject code ${v.subject_code}` : `the subject name "${v.subject_name}"`;
  return `Another ${v.academic_type} exam for ${termLabel(v)} already uses ${what}. Change it, or change the academic type, semester, year or attempt.`;
}

/** Turns a refused exam save into a sentence for the form. */
export function examSaveError(error: { code?: string; message?: string } | null | undefined, n?: Omit<Named, "name">): string {
  const msg = String(error?.message ?? error ?? "");
  const naming = n && hasNaming(n) ? namingOf(n) : null;
  if (error?.code === "23505" && /exams_type_code_unique/.test(msg)) {
    return naming ? conflictMessage("subject_code", naming) : "Another exam of this academic type, semester, year and attempt already uses this subject code.";
  }
  if (error?.code === "23505" && /exams_type_subject_unique/.test(msg)) {
    return naming ? conflictMessage("subject_name", naming) : "Another exam of this academic type, semester, year and attempt already uses this subject name.";
  }
  if (/exam_naming_required/.test(msg)) return "Choose the academic type, semester and academic year, then enter the subject code and the subject name.";
  if (/exam_term_invalid/.test(msg)) return "Choose a semester from 1 to 12 and an academic year like 2026-27.";
  if (/exam_naming_too_long/.test(msg)) return `Keep the subject code to ${SUBJECT_CODE_MAX} characters and the subject name to ${SUBJECT_NAME_MAX}.`;
  if (/exam_type_inactive/.test(msg)) return "That academic type is no longer offered. Choose another one.";
  return msg;
}

export async function listAcademicTypes(opts?: { includeRetired?: boolean }): Promise<AcademicType[]> {
  const db = getSupabase();
  if (!db) return [];
  let q = db.from("academic_types").select("name, sort_order, active").order("sort_order").order("name");
  if (!opts?.includeRetired) q = q.eq("active", true);
  const { data } = await q;
  return (data ?? []) as AcademicType[];
}

/** Which field, if any, another exam of the same type, semester, year and attempt already uses. */
export async function findExamNamingConflict(n: ExamNaming, excludeExamId?: string): Promise<NamingField | null> {
  const db = getSupabase();
  const v = normalizeNaming(n);
  if (!db || !v.academic_type || !v.semester || !v.academic_year || (!v.subject_code && !v.subject_name)) return null;
  const { data, error } = await db.rpc("exam_naming_conflict", {
    p_type: v.academic_type, p_semester: Number(v.semester), p_year: v.academic_year, p_attempt: v.attempt_label,
    p_code: v.subject_code, p_name: v.subject_name, p_exclude: excludeExamId ?? null,
  });
  if (error) return null;
  return data === "subject_code" || data === "subject_name" ? data : null;
}

// ── Admin: the list of academic types ──────────────────────────────────────

type Done = { ok: true } | { ok: false; error: string };

function typeError(error: { code?: string; message?: string }): string {
  if (error.code === "23505") return "That academic type already exists.";
  if (error.code === "23503") return "Exams still use this type. Retire it instead, so it can't be picked for new exams.";
  if (error.code === "23514") return "Use a name of 1 to 60 characters, without spaces at either end.";
  if (error.code === "42501") return "Only admins can change the academic types.";
  return String(error.message ?? error);
}

async function write(run: (db: NonNullable<ReturnType<typeof getSupabase>>) => PromiseLike<{ error: { code?: string; message?: string } | null; data?: unknown[] | null }>): Promise<Done> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "Database not connected." };
  const { error, data } = await run(db);
  if (error) return { ok: false, error: typeError(error) };
  if (Array.isArray(data) && data.length === 0) return { ok: false, error: "Only admins can change the academic types." };
  return { ok: true };
}

export function addAcademicType(name: string, sortOrder: number): Promise<Done> {
  const v = name.trim().replace(/\s+/g, " ");
  if (!v) return Promise.resolve({ ok: false, error: "Enter a name for the academic type." });
  return write((db) => db.from("academic_types").insert({ name: v, sort_order: sortOrder }).select("name"));
}

export function renameAcademicType(from: string, to: string): Promise<Done> {
  const v = to.trim().replace(/\s+/g, " ");
  if (!v) return Promise.resolve({ ok: false, error: "Enter a name for the academic type." });
  return write((db) => db.from("academic_types").update({ name: v }).eq("name", from).select("name"));
}

export function setAcademicTypeActive(name: string, active: boolean): Promise<Done> {
  return write((db) => db.from("academic_types").update({ active }).eq("name", name).select("name"));
}

export function deleteAcademicType(name: string): Promise<Done> {
  return write((db) => db.from("academic_types").delete().eq("name", name).select("name"));
}
