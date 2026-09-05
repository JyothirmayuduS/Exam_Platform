// Supabase Edge Function: proctor-ai-report
// ─────────────────────────────────────────────────────────────────────────────
// Produces the per-attempt AI proctoring integrity report. It pulls the real
// violation timeline for an attempt and asks an LLM (OpenAI-compatible) to
// summarise it into a structured verdict: risk score 0-100, verdict, summary,
// and the key incidents with evidence links. Result is upserted to ai_reports.
//
// Secrets (server-side only):
//   supabase secrets set LLM_API_KEY=sk-...          (required)
//   supabase secrets set LLM_BASE_URL=https://api.openai.com/v1   (default)
//   supabase secrets set LLM_MODEL=gpt-4o-mini       (default)
//
// Request: { attemptId }
// Response: { report: { riskScore, verdict, summary, incidents: [...] } }
// When the LLM key is not configured the function returns 503 with a clear
// message — the app should degrade gracefully to "report unavailable".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const LLM_KEY = Deno.env.get("LLM_API_KEY") ?? "";
const LLM_BASE = (Deno.env.get("LLM_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const LLM_MODEL = Deno.env.get("LLM_MODEL") ?? "gpt-4o-mini";

async function askLlm(system: string, user: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  try {
    return JSON.parse(text);
  } catch {
    // Strip code fences if the provider ignored response_format.
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    return JSON.parse(cleaned);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceRole) return json({ error: "service role not configured" }, 500);

  let body: { attemptId?: string; regenerate?: boolean };
  try { body = await req.json(); } catch { return json({ error: "invalid body" }, 400); }
  const attemptId = String(body.attemptId ?? "").trim();
  if (!attemptId) return json({ error: "attemptId required" }, 400);

  // Authorize: signed-in caller, and the attempt belongs to them (or staff).
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = authHeader
    ? createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    : null;
  const { data: authUser } = userClient ? await userClient.auth.getUser() : { data: null };
  if (!authUser?.user) return json({ error: "invalid session" }, 401);
  const { data: staff } = await userClient!.from("teachers").select("id").eq("auth_id", authUser.user.id).maybeSingle();

  const admin = createClient(supabaseUrl, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });

  // Pull the existing report (unless regenerating) so repeated opens are cheap.
  if (!body.regenerate) {
    const { data: existing } = await admin.from("ai_reports").select("*").eq("attempt_id", attemptId).maybeSingle();
    if (existing) {
      const ownerOk = staff || (existing as { student_id: string }).student_id === await studentIdFor(admin, authUser.user.id);
      if (!ownerOk) return json({ error: "not your attempt" }, 403);
      return json({ report: existing, cached: true });
    }
  }

  const { data: attempt } = await admin
    .from("attempts")
    .select("id, exam_id, student_id, state, started_at, submitted_at, score, answers, attempts:students(roll, full_name), exams:exams(name)")
    .eq("id", attemptId)
    .maybeSingle();
  if (!attempt) return json({ error: "attempt not found" }, 404);

  const a = attempt as Record<string, unknown>;
  const stRel = (a.attempts as unknown[] | undefined) ?? [];
  const st = (Array.isArray(stRel) ? stRel[0] : a.attempts) as Record<string, unknown> | undefined;
  const exRel = (a.exams as unknown[] | undefined) ?? [];
  const ex = (Array.isArray(exRel) ? exRel[0] : a.exams) as Record<string, unknown> | undefined;

  if (!staff && String(a.student_id) !== await studentIdFor(admin, authUser.user.id)) {
    return json({ error: "not your attempt" }, 403);
  }

  const { data: violations } = await admin
    .from("violation_events")
    .select("violation_type, severity, description, timestamp, source, resolved_at")
    .eq("attempt_id", attemptId)
    .order("timestamp", { ascending: true });

  const timeline = (violations ?? []).map((v) => ({
    type: (v as Record<string, unknown>).violation_type,
    severity: (v as Record<string, unknown>).severity,
    description: (v as Record<string, unknown>).description,
    source: (v as Record<string, unknown>).source,
    at: (v as Record<string, unknown>).timestamp,
    resolved: (v as Record<string, unknown>).resolved_at != null,
  }));

  if (!LLM_KEY) {
    return json({ error: "AI report not configured (set LLM_API_KEY secret)" }, 503);
  }

  const system =
    "You are a proctoring integrity analyst for an online examination platform. " +
    "Given an attempt's violation timeline, return STRICT JSON only: " +
    '{"risk_score": 0-100 integer, "verdict": "clean"|"review"|"flagged", "summary": 2-3 sentence plain-text summary, ' +
    '"incidents": [{"type": string, "severity": string, "at": string, "note": string}]} ' +
    "Risk guidance: multiple critical second-face/phone flags → flagged (>=75); isolated tab-switch or gaze events → review (30-74); " +
    "few low-severity events with a clean recording → clean (<30). Never invent events not present in the timeline.";

  const userMsg = JSON.stringify({
    exam: ex?.name ?? a.exam_id,
    student: st ? `${st.full_name ?? ""} (${st.roll ?? a.student_id})` : String(a.student_id),
    state: a.state,
    durationSec: a.started_at && a.submitted_at
      ? Math.max(0, Math.round((new Date(String(a.submitted_at)).getTime() - new Date(String(a.started_at)).getTime()) / 1000))
      : null,
    violationCount: timeline.length,
    timeline,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = await askLlm(system, userMsg);
  } catch (err) {
    console.error("[proctor-ai-report] LLM error:", err);
    return json({ error: "AI report generation failed" }, 502);
  }

  const riskScore = Math.max(0, Math.min(100, Math.round(Number(parsed.risk_score ?? 0))));
  const verdictRaw = String(parsed.verdict ?? "review").toLowerCase();
  const verdict = ["clean", "review", "flagged"].includes(verdictRaw) ? verdictRaw : "review";
  const report = {
    attempt_id: attemptId,
    exam_id: String(a.exam_id ?? ""),
    student_id: String(a.student_id ?? ""),
    risk_score: riskScore,
    verdict,
    summary: {
      summary: String(parsed.summary ?? ""),
      incidents: Array.isArray(parsed.incidents) ? parsed.incidents : [],
    },
    updated_at: new Date().toISOString(),
  };

  const { error: upsertError } = await admin.from("ai_reports").upsert(report, { onConflict: "attempt_id" });
  if (upsertError) console.error("[proctor-ai-report] upsert failed:", upsertError.message);

  return json({ report: { ...report, id: attemptId }, cached: false });
});

async function studentIdFor(admin: ReturnType<typeof createClient>, uid: string): Promise<string | null> {
  const { data } = await admin.from("students").select("id").eq("auth_id", uid).maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
}
