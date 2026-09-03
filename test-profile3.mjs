import { createClient } from "@supabase/supabase-js";

async function main() {
  const db = createClient("https://xdwhftrierzxsppindfj.supabase.co", process.env.VITE_SUPABASE_ANON_KEY);
  
  const { data: authUsers, error: authErr } = await db.from("students").select("id, auth_id, full_name");
  console.log("Students:", authUsers);
}
main();
