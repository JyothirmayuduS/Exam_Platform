import { createClient } from "@supabase/supabase-js";

async function main() {
  const db = createClient("https://xdwhftrierzxsppindfj.supabase.co", process.env.VITE_SUPABASE_ANON_KEY);
  
  const { error: loginError, data: authData } = await db.auth.signInWithPassword({
    email: "priya.nikitha@example.com", 
    password: "password123"
  });
  if (loginError) console.error("Login failed:", loginError);

  const { data, error } = await db
    .from("students")
    .select("id, full_name, roll, branch, section, email")
    .eq("auth_id", authData.user.id)
    .maybeSingle();

  console.log("Profile Data:", data);
  console.log("Profile Error:", error);
}
main();
