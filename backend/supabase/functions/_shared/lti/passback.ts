// Send a graded attempt's score back to Moodle. No-op when LTI is not
// configured or the student never launched this exam from Moodle.
// deno-lint-ignore-file no-explicit-any
import { loadToolKey } from "./jwt.ts";
import { postAttemptScore } from "./scores.ts";
import { supabaseLtiStore } from "./supabaseStore.ts";

export const DEFAULT_KEY_ID = "vignan-lti-1";

export async function passbackScore(
  db: any,
  input: { examId: string; studentId: string; score: number | null; max: number | null },
): Promise<{ posted: number; failed: number }> {
  const secret = Deno.env.get("LTI_PRIVATE_KEY");
  if (!secret) return { posted: 0, failed: 0 };
  const store = supabaseLtiStore(db);
  if (input.max && input.max > 0) await store.setScoreMaximum(input.examId, input.studentId, input.max);
  if (input.score === null) return { posted: 0, failed: 0 };
  const key = await loadToolKey(secret, Deno.env.get("LTI_KEY_ID") || DEFAULT_KEY_ID);
  return postAttemptScore({ store, key, fetch, now: Date.now }, { examId: input.examId, studentId: input.studentId, score: input.score, max: input.max });
}
