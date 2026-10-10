// ──────────────────────────────────────────────────────────────────────────
// Domain module: students — extracted from src/shared/data/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "@/shared/data/supabase";
import type { DirectoryStudent, StudentRosterRecord } from "@/shared/data/api/types";
import { logAudit } from "@/shared/data/api/audit";

/** Resolve a student row id from their roll number (needed for attempt rows). */
/** Full student profile — requires an authenticated student session.
 *  Rejects unauthenticated and cross-student lookups (IDOR fix). */
export async function getStudentProfile(roll: string): Promise<{ id: string; full_name: string | null; email: string | null } | null> {
  const db = getSupabase();
  if (!db || !roll) return null;

  // Caller must be an authenticated student.
  const { data: userData } = await db.auth.getUser();
  const user = userData?.user;
  if (!user) return null;

  // Resolve the caller's student row — reject if unlinked.
  const { data: me } = await db.from("students").select("id").eq("auth_id", user.id).maybeSingle();
  if (!me) return null;

  // Only the matched student may read their own profile.
  const { data } = await db.from("students").select("id, full_name, email").eq("id", me.id).maybeSingle();
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
// Attempt lifecycle: start / autosave / submit
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


export type Accommodation = { studentId: string; roll: string; name: string; extraMinutes: number };

/** Enrolled students with their accommodation minutes for one exam. */
export async function listExamAccommodations(examId: string): Promise<Accommodation[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("enrollments")
    .select("student_id, extra_minutes, student:students(roll, full_name)")
    .eq("exam_id", examId);
  if (error || !data) return [];
  return (data as unknown as { student_id: string; extra_minutes: number | null; student: { roll?: string; full_name?: string } | { roll?: string; full_name?: string }[] | null }[])
    .map((r) => {
      const s = Array.isArray(r.student) ? r.student[0] : r.student;
      return { studentId: String(r.student_id), roll: String(s?.roll ?? ""), name: String(s?.full_name ?? ""), extraMinutes: Number(r.extra_minutes ?? 0) };
    })
    .sort((a, b) => a.roll.localeCompare(b.roll));
}

/** Per-student extra time (e.g. a scribe or medical accommodation). The
 *  server adds it to that student's deadline; proctor extensions stack on top. */
export async function setExtraMinutes(examId: string, studentId: string, minutes: number): Promise<{ error?: string }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection" };
  const extra = Math.max(0, Math.min(600, Math.round(minutes)));
  const { data, error } = await db
    .from("enrollments")
    .update({ extra_minutes: extra })
    .eq("exam_id", examId)
    .eq("student_id", studentId)
    .select("student_id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "Only the teacher who owns this exam can change accommodations." };
  void logAudit({ action: "enrollment.extra_minutes_changed", targetType: "enrollment", targetId: `${examId}:${studentId}`, meta: { exam_id: examId, student_id: studentId, extra_minutes: extra } });
  return {};
}

export type StudentImportRow = { roll: string; name: string; email: string; branch: string; section: string; phone?: string };

/** Adds new students and enrolls every row into the exam. Existing students
 *  are only updated when the caller owns an exam they are in, or is an admin. */
export async function importStudents(
  examId: string | null,
  students: StudentImportRow[],
): Promise<{ error?: string; count: number; created: number; updated: number }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection", count: 0, created: 0, updated: 0 };
  if (students.length === 0) return { count: 0, created: 0, updated: 0 };
  const { data, error } = await db.rpc("import_students", {
    p_exam: examId,
    p_rows: students.map((s) => ({ roll: s.roll, full_name: s.name, email: s.email, branch: s.branch, section: s.section, phone: s.phone || null })),
  });
  if (error) return { error: error.code === "42501" ? error.message.replace(/^forbidden:\s*/, "") : error.message, count: 0, created: 0, updated: 0 };
  const rows = (data ?? []) as { created: boolean; updated: boolean }[];
  return { count: rows.length, created: rows.filter((r) => r.created).length, updated: rows.filter((r) => r.updated).length };
}

export async function enrollStudent(examId: string, student: StudentImportRow): Promise<{ error?: string }> {
  const { error } = await importStudents(examId, [student]);
  return error ? { error } : {};
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

/** The enrolment directory, filtered by batch (e.g. 'CSE · Sem III'), branch or section. */
export async function searchStudentDirectory(f: { batch?: string; branch?: string; section?: string } = {}): Promise<DirectoryStudent[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db.rpc("search_student_directory", {
    p_batch: f.batch || null, p_branch: f.branch || null, p_section: f.section || null,
  });
  if (error) return [];
  return (data ?? []) as DirectoryStudent[];
}

export const listStudentsByBatch = (batch?: string) => searchStudentDirectory({ batch });
export const getStudentsByBranchAndSection = (branch?: string, section?: string) => searchStudentDirectory({ branch, section });

/** Distinct branch, section and batch values from the directory. */
export async function listStudentDirectoryFilters(): Promise<{ branches: string[]; sections: string[]; batches: { name: string; students: number }[] }> {
  const db = getSupabase();
  if (!db) return { branches: [], sections: [], batches: [] };
  const { data } = await db.rpc("student_directory_filters");
  const rows = (data ?? []) as { kind: string; value: string; students: number }[];
  const of = (kind: string) => rows.filter((r) => r.kind === kind).sort((a, b) => a.value.localeCompare(b.value));
  return {
    branches: of("branch").map((r) => r.value),
    sections: of("section").map((r) => r.value),
    batches: of("batch").map((r) => ({ name: r.value, students: Number(r.students) })),
  };
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
