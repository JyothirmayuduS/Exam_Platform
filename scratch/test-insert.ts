import { getSupabase } from "./src/lib/supabase";

async function main() {
  const db = getSupabase();
  const token = `token_${Date.now()}_test`;
  
  // Try inserting with a fake student ID to see if it's RLS
  const { data, error } = await db.from("mobile_upload_sessions").upsert({
    attempt_id: "c6eb8cf4-0d85-4293-80f0-c1e138a49ba3", // a real attempt? wait, I need a real attempt id
    question_id: "P1",
    student_id: "70a6c6d2-3324-42b7-a36f-ef07914041b6", // need a real student id
    token_hash: token,
    expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
  }, { onConflict: "token_hash" });

  console.log("Error:", error);
}

main();
