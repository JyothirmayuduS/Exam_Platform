import { createClient } from "@supabase/supabase-js";

async function main() {
  const db = createClient("https://xdwhftrierzxsppindfj.supabase.co", process.env.VITE_SUPABASE_SERVICE_ROLE_KEY);
  
  const { data: { users }, error: authErr } = await db.auth.admin.listUsers();
  
  const { data: teachers } = await db.from("teachers").select("id, auth_id, full_name");
  console.log("Teachers:", teachers);
}
main();
