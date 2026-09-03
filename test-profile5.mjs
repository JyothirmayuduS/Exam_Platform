import { createClient } from "@supabase/supabase-js";

async function main() {
  const db = createClient("https://xdwhftrierzxsppindfj.supabase.co", process.env.VITE_SUPABASE_SERVICE_ROLE_KEY);
  
  const { data: { users }, error: authErr } = await db.auth.admin.listUsers();
  
  console.log("Auth Users:", users?.map(u => ({ id: u.id, email: u.email })));
}
main();
