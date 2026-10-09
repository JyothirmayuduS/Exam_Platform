// ERP results export (CSV / Excel) for one exam or a programme + semester.
// Columns and their order: _shared/results/erp-columns.json.
// Request and rules: _shared/results/handler.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createResultsExportHandler, type Actor } from "../_shared/results/handler.ts";
import { supabaseResultsStore } from "../_shared/results/supabaseStore.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** A platform teacher (not a proctor); admins are listed in staff_admins. */
async function actor(req: Request): Promise<Actor | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  const id = data?.user?.id;
  if (!id) return null;
  const { data: t } = await admin.from("teachers").select("role").eq("auth_id", id).maybeSingle();
  if (t?.role !== "teacher") return null;
  const { data: a } = await admin.from("staff_admins").select("auth_id").eq("auth_id", id).maybeSingle();
  return { authId: String(id), isAdmin: !!a };
}

Deno.serve(createResultsExportHandler({ store: supabaseResultsStore(admin), actor, now: Date.now }));
