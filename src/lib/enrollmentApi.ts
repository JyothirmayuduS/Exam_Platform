import { getSupabase } from "./supabase";

export type StudentRecord = {
  id: string;
  roll: string;
  full_name: string;
  email: string;
  batch: string;
};

export type EnrollmentRecord = {
  exam_id: string;
  student_id: string;
  access_status: "allowed" | "absent" | "deferred";
  student: StudentRecord | null;
};

async function currentUserId(): Promise<string | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.auth.getUser();
  return data.user?.id ?? null;
}

export async function listStudents(batch?: string | null): Promise<StudentRecord[]> {
  const db = getSupabase();
  if (!db) return [];

  let query = db
    .from("students")
    .select("id,roll,full_name,email,batch")
    .order("roll", { ascending: true });

  if (batch) query = query.eq("batch", batch);

  const { data, error } = await query;
  if (error) return [];
  return (data ?? []) as StudentRecord[];
}

export async function listExamEnrollments(examId: string): Promise<EnrollmentRecord[]> {
  const db = getSupabase();
  if (!db) return [];

  const { data, error } = await db
    .from("exam_enrollments")
    .select("exam_id,student_id,access_status,student:students(id,roll,full_name,email,batch)")
    .eq("exam_id", examId)
    .order("enrolled_at", { ascending: false });

  if (error) return [];

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const studentRaw = row.student as StudentRecord | StudentRecord[] | null;
    const student = Array.isArray(studentRaw) ? (studentRaw[0] ?? null) : studentRaw;
    return {
      exam_id: String(row.exam_id),
      student_id: String(row.student_id),
      access_status: String(row.access_status ?? "allowed") as EnrollmentRecord["access_status"],
      student,
    };
  });
}

export async function replaceExamEnrollments(examId: string, studentIds: string[]): Promise<{ ok: boolean; error?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };

  const teacherId = await currentUserId();

  const { error: delError } = await db
    .from("exam_enrollments")
    .delete()
    .eq("exam_id", examId)
    .not("student_id", "in", `(${studentIds.length ? studentIds.map((id) => `\"${id}\"`).join(",") : '\"\"'})`);

  if (delError) return { ok: false, error: delError.message };

  if (studentIds.length === 0) return { ok: true };

  const payload = studentIds.map((studentId) => ({
    exam_id: examId,
    student_id: studentId,
    invited_by: teacherId,
    access_status: "allowed",
  }));

  const { error } = await db
    .from("exam_enrollments")
    .upsert(payload, { onConflict: "exam_id,student_id", ignoreDuplicates: false });

  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function addExamEnrollment(examId: string, studentId: string, accessStatus: EnrollmentRecord["access_status"] = "allowed") {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const teacherId = await currentUserId();
  const { error } = await db.from("exam_enrollments").upsert(
    {
      exam_id: examId,
      student_id: studentId,
      invited_by: teacherId,
      access_status: accessStatus,
    },
    { onConflict: "exam_id,student_id" },
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function removeExamEnrollment(examId: string, studentId: string) {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const { error } = await db
    .from("exam_enrollments")
    .delete()
    .eq("exam_id", examId)
    .eq("student_id", studentId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function triggerExamEmails(payload: {
  examId: string;
  type: "exam_published" | "exam_reminder" | "results_released";
  scheduledAt?: string | null;
  examName?: string;
  joinLink?: string;
  studentIds?: string[];
}) {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };

  const { data, error } = await db.functions.invoke("send-exam-email", {
    body: payload,
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true, data };
}
