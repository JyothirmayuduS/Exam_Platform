// Supabase Edge Function: mint short-lived LiveKit access tokens.
//
// Runtime: Deno (Supabase Edge Functions). Deploy WITH JWT verification so only
// authenticated users can request a token:
//   supabase functions deploy livekit-token
// Set secrets (NEVER in the frontend):
//   supabase secrets set LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... LIVEKIT_URL=wss://...
//   supabase secrets set ALLOWED_ORIGIN=https://your-app-origin   # optional CORS lock
//
// Security model:
//   • The caller MUST present a valid Supabase auth JWT (Authorization: Bearer).
//     We verify it against the project and reject anonymous callers — otherwise
//     anyone could mint a token and subscribe to another student's camera feed.
//   • A student's LiveKit identity is derived from their authenticated user id;
//     they cannot impersonate someone else.
//   • canSubscribe (watch other participants) is only granted to teacher/proctor
//     roles, never to a student publishing their own feed.

import { AccessToken } from "https://esm.sh/livekit-server-sdk@2.7.2";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const apiKey = Deno.env.get("LIVEKIT_API_KEY");
  const apiSecret = Deno.env.get("LIVEKIT_API_SECRET");
  const url = Deno.env.get("LIVEKIT_URL") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!apiKey || !apiSecret) return json({ error: "LiveKit secrets not configured" }, 500);
  if (!supabaseUrl || !anonKey) return json({ error: "Supabase env not configured" }, 500);

  // ── Authenticate the caller ────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "missing bearer token" }, 401);

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: authError } = await supabase.auth.getUser(jwt);
  const user = userData?.user;
  if (authError || !user) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const room = String(body.room ?? "").trim();
  if (!room) return json({ error: "room is required" }, 400);

  // Role decides subscribe rights. A proctor/teacher (from app_metadata.role)
  // may subscribe to watch feeds; everyone else can only publish their own.
  const role = String((user.app_metadata as Record<string, unknown> | undefined)?.role ?? "student");
  const isProctor = role === "proctor" || role === "teacher" || role === "admin";

  // Identity is bound to the authenticated user — no client-supplied spoofing.
  const identity = isProctor ? `proctor:${user.id}` : `student:${user.id}`;
  const canPublish = !isProctor;   // students publish their camera/mic
  const canSubscribe = isProctor;  // only proctors watch others

  const at = new AccessToken(apiKey, apiSecret, { identity, ttl: "2h" });
  at.addGrant({ roomJoin: true, room, canPublish, canSubscribe, canPublishData: true });

  const token = await at.toJwt();
  return json({ token, url, identity });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
