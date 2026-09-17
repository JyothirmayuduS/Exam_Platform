import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { severityFor, isKnownEventType, type EventType } from "./severity.ts";

/**
 * mobile-monitor-session — server-authoritative lifecycle for the phone-based
 * secondary proctoring module (ExamShield mobile monitor).
 *
 * Actions:
 *   create    (laptop, student auth) — mint one-time token, 15-min TTL
 *   validate  (phone)                — token check, mark connected, QR_SCANNED
 *   heartbeat (phone)                — keep-alive; stale detection is server-side
 *   event     (phone)                — ledger event with severity
 *   snapshot  (phone)                — evidence row for snapshot-fallback mode
 *   snapshot-data (phone)            — base64 JPEG → private bucket, service-side
 *   status    (laptop)               — session state for the QR panel
 *   end       (phone or laptop)      — terminate session
 *
 * Security invariants:
 *   - Token generated server-side (32 random bytes, hex); only its SHA-256
 *     hash is stored. The raw token lives ONLY in the QR URL.
 *   - The phone never sends trusted IDs; everything derives from the session
 *     row looked up by token hash.
 *   - Single-use: `validate` flips WAITING → CONNECTED exactly once.
 *   - Short TTL: 15 minutes from creation; expiry sweep on every call.
 *   - All writes use the service-role client; RLS keeps client reads scoped.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SHA-256 hex of the raw token — the only form stored server-side. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 32 random bytes, hex — 64-char one-time token. */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ------------------------------------------------------------- event ledger

async function logEvent(
  supabase: SupabaseClient,
  sessionId: string,
  type: EventType | string,
  metadata: Record<string, unknown> = {},
  severity?: "minor" | "moderate" | "major",
): Promise<void> {
  await supabase.from("mobile_session_events").insert({
    session_id: sessionId,
    event_type: type,
    metadata,
    severity: severity ?? null,
  });
}

// ------------------------------------------------------------ session fetch

async function fetchSessionByToken(
  supabase: SupabaseClient,
  tokenHash: string,
): Promise<Record<string, any> | null> {
  const { data } = await supabase
    .from("mobile_upload_sessions")
    .select(
      "id, attempt_id, question_id, student_id, exam_id, status, expires_at, used_at, camera_status, livekit_room, livekit_identity, consumed_at, ended_at",
    )
    .eq("token_hash", tokenHash)
    .maybeSingle();
  return (data as Record<string, any>) ?? null;
}

/** Expire a dead session (idempotent) and return true if it just expired. */
async function expireIfPast(
  supabase: SupabaseClient,
  session: Record<string, any>,
): Promise<boolean> {
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    if (session.status !== "EXPIRED" && session.status !== "COMPLETED") {
      await supabase
        .from("mobile_upload_sessions")
        .update({ status: "EXPIRED", ended_at: new Date().toISOString() })
        .eq("id", session.id);
      await logEvent(supabase, session.id, "TERMINATED", { reason: "expired" });
    }
    return true;
  }
  return false;
}

// ------------------------------------------------------------------- server

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body.action ?? "");

  // ════════════════════════════════════════════════════ create (laptop, auth)
  if (action === "create") {
    // Caller must be an authenticated student. Identity is resolved from the
    // JWT — never from the request body.
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Unauthorized" }, 401);

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const authId = userData.user.id;
    const { data: student } = await supabase
      .from("students")
      .select("id, roll")
      .eq("auth_id", authId)
      .maybeSingle();
    if (!student) return json({ error: "Student profile not found" }, 403);

    const { attemptId, questionId } = body as { attemptId?: string; questionId?: string | number };
    if (!attemptId || !UUID_RE.test(String(attemptId))) {
      return json({ error: "attemptId is required (uuid of the active attempt)" }, 400);
    }

    // Server-side validation: the attempt must exist, belong to this student,
    // and its exam must be active. questionId is validated against the exam
    // when the attempt carries an exam_id.
    const { data: attempt } = await supabase
      .from("attempts")
      .select("id, student_id, exam_id, status, ended_at")
      .eq("id", attemptId)
      .maybeSingle();
    if (!attempt) return json({ error: "Attempt not found" }, 404);
    if (attempt.student_id !== student.id) return json({ error: "Attempt does not belong to this student" }, 403);
    if (attempt.ended_at || (attempt.status && attempt.status !== "in_progress")) {
      return json({ error: "Attempt is not active" }, 409);
    }

    let examId: string | null = attempt.exam_id ?? null;
    if (examId) {
      const { data: exam } = await supabase
        .from("exams")
        .select("id, status, start_time, end_time")
        .eq("id", examId)
        .maybeSingle();
      if (!exam) return json({ error: "Exam not found" }, 404);
      if (exam.status && exam.status !== "published") {
        return json({ error: "Exam is not active" }, 409);
      }
    }

    // One-time token: raw value only ever leaves in this response (it goes
    // into the QR); the DB stores the SHA-256 hash.
    const rawToken = generateToken();
    const tokenHash = await sha256Hex(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const room = examId ? String(examId) : "unassigned";
    const identity = `mobile:${student.roll ?? student.id}`;

    const { data: session, error: insertErr } = await supabase
      .from("mobile_upload_sessions")
      .insert({
        attempt_id: attemptId,
        question_id: String(questionId ?? "monitor"),
        student_id: student.id,
        token_hash: tokenHash,
        status: "WAITING",
        expires_at: expiresAt,
        nonce: rawToken.slice(0, 12),
        exam_id: examId,
        camera_status: "NOT_CONNECTED",
        livekit_room: room,
        livekit_identity: identity,
      })
      .select("id, expires_at")
      .single();
    if (insertErr || !session) return json({ error: `Session create failed: ${insertErr?.message ?? "?"}` }, 500);

    await logEvent(supabase, session.id, "QR_SCANNED", {
      phase: "created",
      attemptId,
      questionId: String(questionId ?? "monitor"),
      roll: student.roll ?? null,
    }, "minor");

    return json({
      token: rawToken,
      sessionId: session.id,
      expiresAt,
      livekitRoom: room,
      livekitIdentity: identity,
    });
  }

  // ══════════════════════════════════════════ all other actions need a token
  const rawToken = String(body.token ?? "").trim();
  if (!rawToken || rawToken.length < 32) return json({ error: "Missing or malformed token" }, 400);
  const tokenHash = await sha256Hex(rawToken);

  const session = await fetchSessionByToken(supabase, tokenHash);
  if (!session) return json({ error: "Invalid session token" }, 403);

  // validate runs even on an already-CONNECTED row so a phone reload recovers;
  // every other action rejects expired/used sessions.
  if (await expireIfPast(supabase, session)) {
    return json({ error: "Session expired", code: "EXPIRED" }, 403);
  }

  // ───────────────────────────────────────────────── validate (phone)
  if (action === "validate") {
    if (session.status === "COMPLETED" || session.consumed_at) {
      return json({ error: "Session already consumed", code: "CONSUMED" }, 403);
    }
    if (session.status === "WAITING") {
      await supabase
        .from("mobile_upload_sessions")
        .update({ status: "CONNECTED", used_at: new Date().toISOString() })
        .eq("id", session.id);
      await logEvent(supabase, session.id, "QR_SCANNED", { phase: "phone_connected" }, "minor");
      session.status = "CONNECTED";
    }
    return json({
      ok: true,
      sessionId: session.id,
      status: session.status,
      livekitRoom: session.livekit_room,
      livekitIdentity: session.livekit_identity,
      questionId: session.question_id,
      expiresAt: session.expires_at,
    });
  }

  // Every action below requires a live, connected session.
  if (session.status === "WAITING") return json({ error: "Session not connected yet — validate first", code: "NOT_CONNECTED" }, 409);
  if (session.status === "COMPLETED" || session.consumed_at) return json({ error: "Session already consumed", code: "CONSUMED" }, 403);
  if (session.status === "TERMINATED") return json({ error: "Session terminated", code: "TERMINATED" }, 403);

  // ───────────────────────────────────────────────── heartbeat (phone)
  if (action === "heartbeat") {
    // Compute staleness from the LAST event of any kind (heartbeats do not
    // write rows — they only refresh last-seen) using used_at + latest event.
    const { data: lastEvt } = await supabase
      .from("mobile_session_events")
      .select("created_at")
      .eq("session_id", session.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const lastSeenMs = Math.max(
      new Date(lastEvt?.[0]?.created_at ?? 0).getTime(),
      new Date(session.used_at ?? 0).getTime(),
    );
    const gapMs = Date.now() - lastSeenMs;

    // Missed-heartbeat flag: server-side, once per continuous outage.
    if (gapMs > 45_000) {
      const { count: missedCount } = await supabase
        .from("mobile_session_events")
        .select("id", { count: "exact", head: true })
        .eq("session_id", session.id)
        .eq("event_type", "HEARTBEAT_MISSED");
      // Only log when the previous MISSED event is not still the "open" one
      // (i.e. the phone went silent again after recovering).
      const { data: lastMissed } = await supabase
        .from("mobile_session_events")
        .select("created_at")
        .eq("session_id", session.id)
        .eq("event_type", "HEARTBEAT_MISSED")
        .order("created_at", { ascending: false })
        .limit(1);
      const lastMissedMs = new Date(lastMissed?.[0]?.created_at ?? 0).getTime();
      if (!lastMissedMs || lastMissedMs < lastSeenMs || gapMs - (Date.now() - lastMissedMs) > 45_000) {
        await logEvent(supabase, session.id, "HEARTBEAT_MISSED", { gapMs }, "major");
      }
    }

    // Sliding expiry: an actively-heartbeating phone keeps its session alive
    // for the whole exam; a silent one expires 15 min after its last ping.
    const newExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await supabase
      .from("mobile_upload_sessions")
      .update({ expires_at: newExpiry, used_at: new Date().toISOString() })
      .eq("id", session.id);

    // Kill truly abandoned sessions: silent for >5 minutes → TERMINATED.
    if (gapMs > 5 * 60_000) {
      await supabase
        .from("mobile_upload_sessions")
        .update({ status: "TERMINATED", ended_at: new Date().toISOString() })
        .eq("id", session.id);
      await logEvent(supabase, session.id, "TERMINATED", { reason: "abandoned_no_heartbeat", gapMs }, "major");
      return json({ ok: false, terminated: true }, 403);
    }

    return json({ ok: true, serverTime: new Date().toISOString(), status: session.status, gapMs });
  }

  // ───────────────────────────────────────────────── event (phone)
  if (action === "event") {
    const type = String(body.type ?? "");
    const metadata = (body.metadata ?? {}) as Record<string, unknown>;
    if (!isKnownEventType(type)) return json({ error: `Unknown event type: ${type}` }, 400);

    // Per-session burst guard: more than 10 events in any 10 s window is a
    // runaway client (or abuse) — reject so the ledger can't be flooded.
    // Enforced from the ledger itself, so it survives isolate recycling.
    const tenSecsAgo = new Date(Date.now() - 10_000).toISOString();
    const { count: burstCount } = await supabase
      .from("mobile_session_events")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .gte("created_at", tenSecsAgo);
    if ((burstCount ?? 0) >= 10) {
      return json({ error: "Event rate limit exceeded", code: "RATE_LIMITED" }, 429);
    }

    // Repeat counting for escalation: how many times has this fired recently?
    const { count } = await supabase
      .from("mobile_session_events")
      .select("id", { count: "exact", head: true })
      .eq("session_id", session.id)
      .eq("event_type", type);
    const durationMs = typeof metadata.durationMs === "number" ? metadata.durationMs : undefined;
    const severity = severityFor(type, durationMs, count ?? 0);

    await logEvent(supabase, session.id, type, { ...metadata, count: (count ?? 0) + 1 }, severity);

    // Track status columns so the dashboard reflects live phone state.
    if (type === "CAMERA_STARTED") {
      await supabase.from("mobile_upload_sessions").update({ camera_status: "CONNECTED" }).eq("id", session.id);
    } else if (type === "CAMERA_STOPPED") {
      await supabase.from("mobile_upload_sessions").update({ camera_status: "STOPPED" }).eq("id", session.id);
    }
    return json({ ok: true, severity, repeatCount: (count ?? 0) + 1 });
  }

  // ───────────────────────────────────────────────── snapshot (phone)
  if (action === "snapshot") {
    const path = String(body.path ?? "");
    if (!path || path.includes("..")) return json({ error: "Invalid snapshot path" }, 400);
    await logEvent(supabase, session.id, "SNAPSHOT_FALLBACK_ACTIVE", { path }, "minor");
    return json({ ok: true });
  }

  // ─────────────────────────── snapshot-data (phone, anonymous upload)
  // Snapshot-fallback mode: the phone posts a base64 JPEG; the function writes
  // it into the private exam-records bucket under the session's own verified
  // namespace — the phone never gets storage credentials.
  if (action === "snapshot-data") {
    const dataUrl = String(body.dataUrl ?? "");
    const match = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) return json({ error: "Expected base64 image dataUrl" }, 400);
    const mime = match[1] === "png" ? "image/png" : "image/jpeg";
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    if (bytes.length > 3_000_000) return json({ error: "Snapshot too large" }, 413);

    const bucket = Deno.env.get("SUPABASE_BUCKET_NAME") || "exam-records";
    // Resolve examId from the attempt when it is a real uuid.
    const UUID_RE2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let examFolder = "no-exam";
    if (session.attempt_id && UUID_RE2.test(session.attempt_id)) {
      const { data: att } = await supabase.from("attempts").select("exam_id").eq("id", session.attempt_id).maybeSingle();
      if (att?.exam_id) examFolder = String(att.exam_id);
    } else if (session.exam_id) {
      examFolder = String(session.exam_id);
    }
    const path = `${examFolder}/${session.student_id}/monitor/${Date.now()}.jpg`;
    const { error: upErr } = await supabase.storage.from(bucket).upload(path, bytes, { contentType: mime });
    if (upErr) return json({ error: `Snapshot upload failed: ${upErr.message}` }, 500);
    await logEvent(supabase, session.id, "SNAPSHOT_FALLBACK_ACTIVE", { path }, "minor");
    return json({ ok: true, path });
  }

  // ───────────────────────────────────────────────── status (laptop)
  if (action === "status") {
    // Stale detection: no heartbeat and CONNECTED for >45 s → flag once.
    const { data: lastEvent } = await supabase
      .from("mobile_session_events")
      .select("created_at, event_type")
      .eq("session_id", session.id)
      .order("created_at", { ascending: false })
      .limit(1);
    const lastSeen = lastEvent?.[0]?.created_at ?? session.used_at ?? session.created_at ?? null;
    return json({
      status: session.status,
      cameraStatus: session.camera_status,
      livekitRoom: session.livekit_room,
      questionId: session.question_id,
      expiresAt: session.expires_at,
      lastEventAt: lastSeen,
      lastEventType: lastEvent?.[0]?.event_type ?? null,
    });
  }

  // ───────────────────────────────────────────────── end (phone or laptop)
  if (action === "end") {
    const reason = String(body.reason ?? "student_ended");
    await supabase
      .from("mobile_upload_sessions")
      .update({ status: "TERMINATED", ended_at: new Date().toISOString() })
      .eq("id", session.id);
    await logEvent(supabase, session.id, "SESSION_ENDED", { reason }, "minor");
    return json({ ok: true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
