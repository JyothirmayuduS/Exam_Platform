import * as fs from 'fs';

const apiPath = 'src/lib/examApi.ts';
let content = fs.readFileSync(apiPath, 'utf8');

const newCode = `

// --- Student Enrollment Management ---

export type StudentRosterRecord = {
  id: string;
  roll: string;
  full_name: string;
  email: string;
  batch: string;
};

export async function getExamRoster(examId: string): Promise<StudentRosterRecord[]> {
  const db = getSupabase();
  if (!db) return [];
  
  const { data, error } = await db
    .from("enrollments")
    .select("student:students(id, roll, full_name, email, batch)")
    .eq("exam_id", examId);
    
  if (error || !data) return [];
  
  return data
    .map((row: any) => row.student)
    .filter(Boolean) as StudentRosterRecord[];
}

export async function enrollStudent(examId: string, student: { roll: string; name: string; email: string; batch: string }): Promise<{ error?: string }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection" };

  // 1. Upsert student
  const { data: sData, error: sErr } = await db
    .from("students")
    .upsert(
      { roll: student.roll, full_name: student.name, email: student.email, batch: student.batch },
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

export async function bulkEnrollStudents(examId: string, batch: string, students: { roll: string; name: string; email: string }[]): Promise<{ error?: string; count: number }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection", count: 0 };
  if (students.length === 0) return { count: 0 };

  // 1. Upsert all students
  const { data: sData, error: sErr } = await db
    .from("students")
    .upsert(
      students.map(s => ({ roll: s.roll, full_name: s.name, email: s.email, batch })),
      { onConflict: "roll" }
    )
    .select("id");

  if (sErr || !sData) return { error: sErr?.message || "Failed to bulk upsert students", count: 0 };

  // 2. Insert enrollments
  const { error: eErr } = await db
    .from("enrollments")
    .upsert(
      sData.map(s => ({ exam_id: examId, student_id: s.id })),
      { onConflict: "exam_id, student_id" }
    );

  if (eErr) return { error: eErr.message, count: 0 };
  return { count: sData.length };
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
`;

content += newCode;
fs.writeFileSync(apiPath, content);
console.log('API methods added.');
