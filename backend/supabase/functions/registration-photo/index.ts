// Registration photo: status and one-time upload for the signed-in student.
// Request and rules: _shared/photos/handler.ts. Deploy WITH JWT verification.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPhotoHandler } from "../_shared/photos/handler.ts";
import { supabasePhotoStore } from "../_shared/photos/supabaseStore.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function actor(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data?.user?.id ? { authId: String(data.user.id) } : null;
}

Deno.serve(createPhotoHandler({ store: supabasePhotoStore(db), actor, now: Date.now }));
