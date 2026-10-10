// Domain module: how exams are named. A teacher picks the academic type
// (Sem Exam, Mid Term…), then the subject code, then the subject name. The
// database keeps the three fields, refuses a code or subject name already used
// under the same type, and names the exam "Type · CODE · Subject".

import { getSupabase } from "@/shared/data/supabase";

export type AcademicType = { name: string; sort_order: number; active: boolean };
export type ExamNaming = { academic_type: string; subject_code: string; subject_name: string };
export type NamingField = "subject_code" | "subject_name";

export const SUBJECT_CODE_MAX = 30;
export const SUBJECT_NAME_MAX = 120;

export const normalizeSubjectCode = (s: string) => s.replace(/\s+/g, "").toUpperCase();
export const normalizeSubjectName = (s: string) => s.trim().replace(/\s+/g, " ");

export function normalizeNaming(n: ExamNaming): ExamNaming {
  return { academic_type: n.academic_type.trim(), subject_code: normalizeSubjectCode(n.subject_code), subject_name: normalizeSubjectName(n.subject_name) };
}

export function composeExamName(n: ExamNaming): string {
  const v = normalizeNaming(n);
  return `${v.academic_type} · ${v.subject_code} · ${v.subject_name}`;
}

type Named = { name: string; academic_type?: string | null; subject_code?: string | null; subject_name?: string | null };

export const hasNaming = (e: Named) => !!(e.academic_type && e.subject_code && e.subject_name);

/** The exam's display name: built from its fields when all three are set. */
export function examTitle(e: Named): string {
  return hasNaming(e) ? composeExamName(e as ExamNaming) : e.name;
}

/** What still blocks saving, in the order the form asks for it. */
export function namingProblem(n: ExamNaming): string | null {
  const v = normalizeNaming(n);
  if (!v.academic_type) return "Choose the academic type.";
  if (!v.subject_code) return "Enter the subject code.";
  if (!v.subject_name) return "Enter the subject name.";
  if (v.subject_code.length > SUBJECT_CODE_MAX) return `Keep the subject code to ${SUBJECT_CODE_MAX} characters.`;
  if (v.subject_name.length > SUBJECT_NAME_MAX) return `Keep the subject name to ${SUBJECT_NAME_MAX} characters.`;
  return null;
}

export function conflictMessage(field: NamingField, n: ExamNaming): string {
  const v = normalizeNaming(n);
  return field === "subject_code"
    ? `Another ${v.academic_type} exam already uses subject code ${v.subject_code}. Use a different code, or choose another academic type.`
    : `Another ${v.academic_type} exam already uses the subject name "${v.subject_name}". Use a different name, or choose another academic type.`;
}

/** Turns a refused exam save into a sentence for the form. */
export function examSaveError(error: { code?: string; message?: string } | null | undefined, n?: Partial<Record<keyof ExamNaming, string | null>>): string {
  const msg = String(error?.message ?? error ?? "");
  const naming = n?.academic_type && n.subject_code && n.subject_name ? (n as ExamNaming) : null;
  if (error?.code === "23505" && /exams_type_code_unique/.test(msg)) {
    return naming ? conflictMessage("subject_code", naming) : "Another exam of this academic type already uses this subject code.";
  }
  if (error?.code === "23505" && /exams_type_subject_unique/.test(msg)) {
    return naming ? conflictMessage("subject_name", naming) : "Another exam of this academic type already uses this subject name.";
  }
  if (/exam_naming_required/.test(msg)) return "Choose the academic type, then enter the subject code and the subject name.";
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

/** Which field, if any, another exam of the same type already uses. */
export async function findExamNamingConflict(n: ExamNaming, excludeExamId?: string): Promise<NamingField | null> {
  const db = getSupabase();
  const v = normalizeNaming(n);
  if (!db || !v.academic_type || (!v.subject_code && !v.subject_name)) return null;
  const { data, error } = await db.rpc("exam_naming_conflict", {
    p_type: v.academic_type, p_code: v.subject_code, p_name: v.subject_name, p_exclude: excludeExamId ?? null,
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
