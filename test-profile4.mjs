import { createClient } from "@supabase/supabase-js";

async function main() {
  const db = createClient("https://xdwhftrierzxsppindfj.supabase.co", process.env.VITE_SUPABASE_ANON_KEY);
  
  const { data, error } = await db
    .from("students")
    .select("id, full_name, roll, branch, section, email")
    .eq("auth_id", "e2315585-df40-46f5-a117-6b85949a3134")
    .maybeSingle();

  console.log("Profile Data:", data);
  console.log("Profile Error:", error);
}
main();
