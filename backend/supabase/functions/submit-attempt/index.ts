// Final exam submission. The candidate's browser never decides its own score:
// this function checks the clock, stores the answers and grades the objective
// questions against the answer key with the service role.
//
// POST { examId, answers, answered, minutesUsed, sessionId }
//   200 { ok, late, submitted, grade|null }   grade only when results are released
//   409 { error: "busy" }                     exam open on another active device
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { autoGradeAttempt } from "../_shared/exam/autoGrade.ts";
import { examClosed, visibilityFor, type ReleaseSettings } from "../_shared/exam/release.ts";
import type { DBQuestion } from "../_shared/exam/types.ts";
import type { NegativeSettings } from "../_shared/exam/scoring.ts";
import { passbackScore } from "../_shared/lti/passback.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GRACE_MS = 2 * 60_000;
const SESSION_LIVE_MS = 45_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function normalizeOptions(raw: unknown): string[] | null {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(v) ? v.map((o) => String(o)) : null;
}

function countAnswered(answers: Record<string, unknown>): number {
  return Object.values(answers).filter((v) =>
    v !== null && v !== undefined && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && v.length === 0)
  ).length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: authData } = await userClient.auth.getUser();
  const authUser = authData?.user;
  if (!authUser) return json({ error: "unauthorized" }, 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  let body: { examId?: string; answers?: unknown; answered?: number; minutesUsed?: number; sessionId?: string };
  try { body = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400); }
  const examId = String(body.examId ?? "").trim();
  if (!examId) return json({ error: "missing_exam" }, 400);
  const incoming = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
    ? (body.answers as Record<string, unknown>)
    : null;

  const admin = createClient(supabaseUrl, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: student } = await admin.from("students").select("id").eq("auth_id", authUser.id).maybeSingle();
  if (!student?.id) return json({ error: "not_a_student" }, 403);
  const studentId = String(student.id);

  const { data: exam } = await admin
    .from("exams")
    .select("id, status, settings, scheduled_at, duration_minutes")
    .eq("id", examId)
    .maybeSingle();
  if (!exam || exam.status === "draft") return json({ error: "exam_not_found" }, 404);
  const { data: enrollment } = await admin
    .from("enrollments")
    .select("exam_id")
    .eq("exam_id", examId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (!enrollment) return json({ error: "not_enrolled" }, 403);

  let { data: attempt } = await admin
    .from("attempts")
    .select("id, state, answers, answered, paper, score, started_at, session_id, session_seen_at")
    .eq("exam_id", examId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (!attempt) {
    const now = new Date().toISOString();
    const { data: created, error } = await admin
      .from("attempts")
      .insert({ exam_id: examId, student_id: studentId, state: "in_progress", started_at: now, answers: {}, answered: 0 })
      .select("id, state, answers, answered, paper, score, started_at, session_id, session_seen_at")
      .single();
    if (error || !created) return json({ error: "attempt_create_failed" }, 500);
    attempt = created;
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (
    attempt.state !== "submitted" &&
    attempt.session_id && sessionId && attempt.session_id !== sessionId &&
    attempt.session_seen_at && Date.now() - Date.parse(attempt.session_seen_at) < SESSION_LIVE_MS
  ) {
    return json({ error: "busy" }, 409);
  }

  const { data: deadlineRaw } = await admin.rpc("attempt_deadline", { p_attempt: attempt.id });
  const deadline = deadlineRaw ? Date.parse(String(deadlineRaw)) : NaN;
  const late = attempt.state !== "submitted" && Number.isFinite(deadline) && Date.now() > deadline + GRACE_MS;

  const alreadySubmitted = attempt.state === "submitted";
  const stored = (attempt.answers && typeof attempt.answers === "object" ? attempt.answers : {}) as Record<string, unknown>;
  const finalAnswers = alreadySubmitted || late || !incoming ? stored : incoming;

  // Pool = exam_questions membership plus legacy questions.exam_id rows.
  const { data: links } = await admin.from("exam_questions").select("question_id").eq("exam_id", examId);
  const { data: owned } = await admin.from("questions").select("id").eq("exam_id", examId);
  const ids = Array.from(new Set([
    ...(links ?? []).map((r: { question_id: string }) => String(r.question_id)),
    ...(owned ?? []).map((r: { id: string }) => String(r.id)),
  ]));
  const { data: rows } = ids.length
    ? await admin.from("questions").select("id, exam_id, title, type, unit, difficulty, marks, options, answer, subjective_mode").in("id", ids)
    : { data: [] };
  const pool: DBQuestion[] = (rows ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    exam_id: r.exam_id ? String(r.exam_id) : null,
    title: String(r.title ?? ""),
    type: String(r.type ?? "MCQ"),
    unit: r.unit ? String(r.unit) : null,
    difficulty: r.difficulty ? String(r.difficulty) : null,
    marks: Number(r.marks ?? 1),
    options: normalizeOptions(r.options),
    answer: r.answer === null || r.answer === undefined ? null : String(r.answer),
    subjective_mode: (r.subjective_mode as DBQuestion["subjective_mode"]) ?? null,
  }));
  const settings = (exam.settings ?? {}) as Record<string, unknown>;
  const grade = autoGradeAttempt(pool, attempt.paper, finalAnswers, settings as NegativeSettings);

  const nowIso = new Date().toISOString();
  const newlyGraded = !alreadySubmitted || (attempt.score === null && grade.score !== null);
  if (alreadySubmitted) {
    if (attempt.score === null && grade.score !== null) {
      await admin.from("attempts").update({ score: grade.score }).eq("id", attempt.id).is("score", null);
    }
  } else {
    const startedMs = attempt.started_at ? Date.parse(attempt.started_at) : Date.now();
    const elapsedMin = Math.max(0, Math.round((Date.now() - startedMs) / 60_000));
    const clientMin = Number(body.minutesUsed);
    const minutesUsed = Number.isFinite(clientMin) && clientMin >= 0 ? Math.min(Math.round(clientMin), elapsedMin) : elapsedMin;
    const { error } = await admin
      .from("attempts")
      .update({
        state: "submitted",
        answers: finalAnswers,
        answered: finalAnswers === incoming && Number.isFinite(Number(body.answered)) ? Number(body.answered) : countAnswered(finalAnswers),
        minutes_used: minutesUsed,
        score: grade.score,
        submitted_at: nowIso,
        auto_saved_at: nowIso,
        auto_submitted: late,
      })
      .eq("id", attempt.id)
      .neq("state", "submitted");
    if (error) return json({ error: "submit_failed", detail: error.message }, 500);
    await admin.from("audit_logs").insert({
      actor_id: authUser.id,
      actor_role: "system",
      action: late ? "attempt.submitted_late" : "attempt.submitted",
      target_type: "attempt",
      target_id: String(attempt.id),
      meta: { exam_id: examId, score: grade.score, late },
    });
  }

  if (newlyGraded) {
    const passback = passbackScore(admin, { examId, studentId, score: grade.score, max: grade.max })
      .catch((err) => console.error("lti passback", err));
    const edge = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
    if (edge) edge.waitUntil(passback);
    else await passback;
  }

  const visibility = visibilityFor(settings as ReleaseSettings, {
    examClosed: examClosed(exam),
    graded: grade.score !== null,
  });
  return json({ ok: true, submitted: true, late, grade: visibility.score ? grade : null });
});
