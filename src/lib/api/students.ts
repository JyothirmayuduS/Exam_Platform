// ──────────────────────────────────────────────────────────────────────────
// Domain module: students — extracted from src/lib/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "../supabase";
import type { Student, StudentRosterRecord } from "./types";

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


export async function getStudentIdByRoll(roll: string): Promise<string | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.from("students").select("id").eq("roll", roll).maybeSingle();
  return (data?.id as string) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Attempt lifecycle: start → autosave → submit
// ─────────────────────────────────────────────────────────────────────────────


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

/**
 * Provision real Supabase Auth logins for student rows (by roll) via the
 * provision-student-accounts edge function. Each account is
 * <roll>@student.vignan.ac.in with the configured default password.
 */


/**
 * Provision real Supabase Auth logins for student rows (by roll) via the
 * provision-student-accounts edge function. Each account is
 * <roll>@student.vignan.ac.in with the configured default password.
 */
export async function provisionStudentLoginAccounts(
  rolls: string[],
  opts?: { sendEmail?: boolean },
): Promise<{ ok: boolean; error?: string; created?: { roll: string; login: string }[]; already?: string[]; failed?: { roll: string; reason: string }[] }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "No DB connection" };
  if (rolls.length === 0) return { ok: false, error: "No rolls selected" };
  const { data, error } = await db.functions.invoke("provision-student-accounts", {
    body: { rolls, sendEmail: opts?.sendEmail !== false },
  });
  if (error) return { ok: false, error: error.message };
  const d = (data ?? {}) as {
    created?: { roll: string; login: string }[];
    alreadyProvisioned?: string[];
    failed?: { roll: string; reason: string }[];
  };
  return {
    ok: true,
    created: d.created ?? [],
    already: d.alreadyProvisioned ?? [],
    failed: d.failed ?? [],
  };
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
