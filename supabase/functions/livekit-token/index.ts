// Supabase Edge Function: mint short-lived LiveKit access tokens.
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
  try { body = await req.json(); } catch { /* empty */ }

  const room = String(body.room ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  if (!room) return json({ error: "room is required" }, 400);

  // Role resolution order:
  //   1. app_metadata.role (set directly on auth.users)
  //   2. teachers table by auth_id
  //   3. teachers table by email (fallback for unlinked accounts)
  //   4. Email pattern heuristic (catches demo accounts not yet in teachers table)
  //   5. Default to "student"
  let role = String((user.app_metadata as Record<string, unknown> | undefined)?.role ?? "");

  if (!role) {
    const { data: teacherRow } = await supabase
      .from("teachers")
      .select("role")
      .eq("auth_id", user.id)
      .maybeSingle();
    if (teacherRow?.role) role = String(teacherRow.role);
  }

  if (!role && user.email) {
    const { data: teacherByEmail } = await supabase
      .from("teachers")
      .select("role")
      .eq("email", user.email.toLowerCase())
      .maybeSingle();
    if (teacherByEmail?.role) role = String(teacherByEmail.role);
  }

  if (!role && user.email) {
    const email = user.email.toLowerCase();
    if (email.includes("teacher") || email.includes("faculty") || email.includes("proctor") || email.includes("admin")) {
      role = "teacher";
    }
  }

  if (!role) role = "student";

  const isProctor = role === "proctor" || role === "teacher" || role === "admin";

  // Voice announcement rooms (voice-<exam>-<roll>) carry the proctor→student
  // live-audio channel. Only staff may publish their microphone there; students
  // may subscribe so they can hear a warning aimed at their own channel — they
  // can never publish, so students can't talk over the room.
  const isVoiceRoom = room.startsWith("voice-");
  let canPublish: boolean;
  let canSubscribe: boolean;
  if (isVoiceRoom) {
    canPublish = isProctor;
    canSubscribe = true; // staff may listen back; students listen to their own channel
  } else {
    canPublish = !isProctor;
    canSubscribe = isProctor;
  }

  console.log("[livekit-token] role:", { email: user.email, role, isProctor, room, isVoiceRoom, canPublish, canSubscribe });

  let identity: string;
  if (isProctor) {
    identity = `proctor:${user.id}`;
  } else {
    const { data: studentRow } = await supabase
      .from("students")
      .select("roll")
      .eq("auth_id", user.id)
      .maybeSingle();
    const roll = studentRow?.roll as string | undefined;
    identity = roll ? `student:${roll}` : `student:${user.id}`;
  }

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
