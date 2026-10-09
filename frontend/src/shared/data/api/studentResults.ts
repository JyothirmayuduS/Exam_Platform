// Domain module: where the signed-in student's results stand. The server only
// returns a score that is released and not on malpractice hold.

import { getSupabase } from "@/shared/data/supabase";

export type ResultState = { examId: string; graded: boolean; held: boolean; score: number | null };

export async function loadResultStates(): Promise<Map<string, ResultState>> {
  const db = getSupabase();
  if (!db) return new Map();
  const { data, error } = await db.rpc("student_result_states");
  if (error || !Array.isArray(data)) return new Map();
  return new Map(
    (data as { exam_id: string; graded: boolean; held: boolean; score: number | string | null }[]).map((r) => [
      String(r.exam_id),
      { examId: String(r.exam_id), graded: !!r.graded, held: !!r.held, score: r.score === null || r.score === undefined ? null : Number(r.score) },
    ]),
  );
}
