// Moodle LTI 1.3 tool endpoints. Moodle calls /login, /launch and /jwks
// without a Supabase JWT, so deploy with --no-verify-jwt:
//   supabase functions deploy lti --no-verify-jwt
//
// Secrets: LTI_PRIVATE_KEY (PKCS#8 PEM or private JWK), LTI_KEY_ID (optional),
// APP_BASE_URL (web app origin), LTI_TOOL_URL (optional; defaults to
// <SUPABASE_URL>/functions/v1/lti). Setup: docs/moodle-lti.md.
//
// POST /score { attemptId } (staff, Bearer JWT) re-sends a teacher's grade.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLtiHandler } from "../_shared/lti/handler.ts";
import { loadToolKey, type ToolKey } from "../_shared/lti/jwt.ts";
import { DEFAULT_KEY_ID, passbackScore } from "../_shared/lti/passback.ts";
import { supabaseLtiStore } from "../_shared/lti/supabaseStore.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
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

const handle = createLtiHandler({
  store: supabaseLtiStore(admin),
  key,
  toolUrl: Deno.env.get("LTI_TOOL_URL") || `${supabaseUrl}/functions/v1/lti`,
  appUrl: Deno.env.get("APP_BASE_URL") ?? "",
  fetch,
  now: Date.now,
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function score(req: Request): Promise<Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) return json({ error: "unauthorized" }, 401);
  let body: { attemptId?: string };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { data: attempt } = await admin
    .from("attempts")
    .select("exam_id, student_id, score, state")
    .eq("id", String(body.attemptId ?? ""))
    .maybeSingle();
  if (!attempt) return json({ error: "attempt_not_found" }, 404);
  const { data: owns } = await userClient.rpc("owns_exam", { p_exam: attempt.exam_id });
  if (owns !== true) return json({ error: "forbidden" }, 403);
  if (attempt.state !== "submitted" || attempt.score === null) return json({ posted: 0, failed: 0 });
  const result = await passbackScore(admin, { examId: attempt.exam_id, studentId: attempt.student_id, score: Number(attempt.score), max: null });
  return json(result);
}

Deno.serve((req) => {
  if (req.method === "POST" && new URL(req.url).pathname.split("/").filter(Boolean).pop() === "score") {
    return score(req).catch((err) => {
      console.error("lti score", err);
      return json({ error: "server_error" }, 500);
    });
  }
  return handle(req);
});
