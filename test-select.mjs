import { createClient } from "@supabase/supabase-js";

async function main() {
  const db = createClient("https://xdwhftrierzxsppindfj.supabase.co", process.env.VITE_SUPABASE_ANON_KEY);
  
  const { data, error } = await db
    .from("attempts")
    .select("id, state")
    .eq("exam_id", "EXAM-2026-014")
    .eq("student_id", "175741ff-ad12-4c01-aea3-8df6b55d1e74")
    .maybeSingle();
    
  console.log("Data:", data);
  console.log("Error:", error);
}
main();
