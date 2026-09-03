import { createClient } from "@supabase/supabase-js";
import 'dotenv/config';

async function main() {
  const db = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);
  
  // Login as student
  const { error: loginError } = await db.auth.signInWithPassword({
    email: "student@example.com", // wait, what is the student's email?
    password: "password123"
  });
  
  if (loginError) console.error("Login failed:", loginError);

  const token = `token_${Date.now()}_test`;
  
  const { data, error } = await db.from("mobile_upload_sessions").upsert({
    attempt_id: "05a99519-929d-432b-bd4d-ab0d653cbae1",
    question_id: "P1",
    student_id: "11111111-1111-1111-1111-111111111111", // Need the real UUID matching the authenticated user
    token_hash: token,
    expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
  }, { onConflict: "token_hash" });

  console.log("Upsert Error:", error);
}

main();
