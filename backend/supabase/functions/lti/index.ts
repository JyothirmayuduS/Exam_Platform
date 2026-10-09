// Moodle LTI 1.3 tool endpoints. Moodle calls /login, /launch and /jwks
// without a Supabase JWT, so deploy with --no-verify-jwt:
//   supabase functions deploy lti --no-verify-jwt
//
// Secrets: LTI_PRIVATE_KEY (PKCS#8 PEM or private JWK), LTI_KEY_ID (optional),
// APP_BASE_URL (web app origin), LTI_CRON_SECRET (enables POST /retry),
// LTI_TOOL_URL (optional; defaults to <SUPABASE_URL>/functions/v1/lti).
// Routes and setup: _shared/lti/handler.ts and docs/moodle-lti.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLtiHandler } from "../_shared/lti/handler.ts";
import { loadToolKey, type ToolKey } from "../_shared/lti/jwt.ts";
import { DEFAULT_KEY_ID } from "../_shared/lti/passback.ts";
import { supabaseLtiStore } from "../_shared/lti/supabaseStore.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { autoRefreshToken: false, persistSession: false },
});

let keyPromise: Promise<ToolKey> | null = null;
const key = () => {
  const secret = Deno.env.get("LTI_PRIVATE_KEY");
  if (!secret) return Promise.reject(new Error("LTI_PRIVATE_KEY is not set"));
  keyPromise ??= loadToolKey(secret, Deno.env.get("LTI_KEY_ID") || DEFAULT_KEY_ID);
  return keyPromise;
};

/** The caller's auth id when they are a platform teacher (not a proctor). */
async function teacher(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  const id = data?.user?.id;
  if (!id) return null;
  const { data: t } = await admin.from("teachers").select("role").eq("auth_id", id).maybeSingle();
  return t?.role === "teacher" ? String(id) : null;
}

Deno.serve(createLtiHandler({
  store: supabaseLtiStore(admin),
  key,
  toolUrl: Deno.env.get("LTI_TOOL_URL") || `${supabaseUrl}/functions/v1/lti`,
  appUrl: Deno.env.get("APP_BASE_URL") ?? "",
  fetch,
  now: Date.now,
  teacher,
  cronSecret: Deno.env.get("LTI_CRON_SECRET") ?? "",
}));
