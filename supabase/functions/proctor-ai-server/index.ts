// Supabase Edge Function: proctor-ai-server
// ─────────────────────────────────────────────────────────────────────────────
// Server-side integrity watchdog for the proctored exam. The candidate's client
// downsamples its screen feed to an 8x8 luminance grid (tiny, ~200 bytes) and
// posts it here every few seconds. The server derives REAL signals — black
// screen, white-out, frozen frame (no inter-frame change), zero motion during
// an active exam — and persists a violation_events row (source 'ai') only when
// a threshold is breached. Client-side heuristics can be muted or bypassed by
// the candidate; this audit trail is server-authoritative and tamper-evident.
//
// Deploy:
//   supabase functions deploy proctor-ai-server --no-verify-jwt
//
// Request body (all optional except attemptId):
//   { attemptId, examId, mean, contrast, diff, frameNo, width, height, kind: "screen" }
//     mean      average luminance 0..255 of the downsampled frame
//     contrast  std-dev of the same grid
//     diff      fraction (0..1) of grid cells that changed vs previous frame
//     frameNo   monotonically increasing counter (for freeze detection)
// Response: { ok, signals: [...] } — signals that were persisted, if any.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const MIN_MEAN = 8;      // below: screen is effectively black
const MIN_CONTRAST = 3;  // below with low mean: solid black / dead feed
const FREEZE_DIFF = 0.02;  // less than 2% of cells changed while exam is active
const COOLDOWN_MS = 30_000; // don't spam the same violation type per attempt

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceRole) return json({ error: "service role not configured" }, 500);

  let body: {
    attemptId?: string; examId?: string; kind?: string;
    mean?: number; contrast?: number; diff?: number; frameNo?: number;
  };
  try { body = await req.json(); } catch { return json({ error: "invalid body" }, 400); }
  const attemptId = String(body.attemptId ?? "").trim();
  const examId = String(body.examId ?? "").trim();
  if (!attemptId) return json({ error: "attemptId required" }, 400);

  // Authorize: signed-in user, and the attempt must belong to them (or staff).
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = authHeader
    ? createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    : null;
  const { data: authUser } = userClient ? await userClient.auth.getUser() : { data: null };
  if (!authUser?.user) return json({ error: "invalid session" }, 401);
  const { data: staff } = await userClient!.from("teachers").select("id").eq("auth_id", authUser.user.id).maybeSingle();

  const admin = createClient(supabaseUrl, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: attempt } = await admin.from("attempts").select("id, exam_id, student_id, started_at, state").eq("id", attemptId).maybeSingle();
  if (!attempt) return json({ error: "attempt not found" }, 404);
  if (!staff) {
    const { data: student } = await userClient!.from("students").select("id").eq("auth_id", authUser.user.id).maybeSingle();
    if (!student || student.id !== attempt.student_id) return json({ error: "not your attempt" }, 403);
  }

  const exam = examId || attempt.exam_id || null;
  const mean = typeof body.mean === "number" ? body.mean : 0;
  const contrast = typeof body.contrast === "number" ? body.contrast : 0;
  const diff = typeof body.diff === "number" ? body.diff : 1;
  const signals: { type: string; severity: string; description: string }[] = [];

  if (mean < MIN_MEAN && contrast < MIN_CONTRAST) {
    signals.push({ type: "screen_black", severity: "high", description: "Screen feed went black — display may be off, covered, or tampered with" });
  } else if (mean > 248 && contrast < MIN_CONTRAST) {
    signals.push({ type: "screen_whiteout", severity: "warning", description: "Screen feed is uniformly white — possible display tampering" });
  } else if (typeof body.frameNo === "number" && body.frameNo > 30 && diff < FREEZE_DIFF) {
    signals.push({ type: "screen_frozen", severity: "warning", description: "Screen feed appears frozen — no activity detected during the exam" });
  }

  const persisted: string[] = [];
  for (const s of signals) {
    // Cooldown: skip if the same type was logged for this attempt recently.
    const { data: recent } = await admin
      .from("violation_events")
      .select("created_at")
      .eq("attempt_id", attemptId)
      .eq("violation_type", s.type)
      .order("created_at", { ascending: false })
      .limit(1);
    const last = recent?.[0]?.created_at ? new Date(recent[0].created_at).getTime() : 0;
    if (Date.now() - last < COOLDOWN_MS) continue;

    const { error: insError } = await admin.from("violation_events").insert({
      attempt_id: attemptId,
      exam_id: exam,
      student_id: attempt.student_id,
      violation_type: s.type,
      severity: s.severity,
      description: s.description,
      source: "ai",
      timestamp: new Date().toISOString(),
    });
    if (!insError) persisted.push(s.type);
  }

  return json({ ok: true, signals: persisted, kind: body.kind ?? "screen" });
});
