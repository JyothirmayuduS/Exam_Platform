import * as fs from 'fs';

const apiPath = 'src/lib/examApi.ts';
let content = fs.readFileSync(apiPath, 'utf8');

const newCode = `

export async function enrollEntireBatch(examId: string, batch: string): Promise<{ error?: string, count: number }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection", count: 0 };

  const { data: students, error: sErr } = await db
    .from("students")
    .select("id")
    .eq("batch", batch);
    
  if (sErr) return { error: sErr.message, count: 0 };
  if (!students || students.length === 0) return { count: 0 };

  const { error: eErr } = await db
    .from("enrollments")
    .upsert(
      students.map(s => ({ exam_id: examId, student_id: s.id })),
      { onConflict: "exam_id, student_id" }
    );

  if (eErr) return { error: eErr.message, count: 0 };
  return { count: students.length };
}
`;

if (!content.includes('enrollEntireBatch')) {
  fs.appendFileSync(apiPath, newCode);
  console.log('enrollEntireBatch added');
} else {
  console.log('enrollEntireBatch already exists');
}
