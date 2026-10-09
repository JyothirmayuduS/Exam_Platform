// Domain module: audit — immutable record of privileged staff actions
// (score changes, force submits, publishes, delegations, time changes) plus
// server-side submissions. Append-only: staff insert their own rows, only
// teachers read, nobody updates or deletes (20261008193754_security_lockdown.sql).

import { getSupabase } from "@/shared/data/supabase";
import { supabaseConfigured } from "@/shared/data/env";

export type AuditAction =
  | "attempt.score_changed"
  | "attempt.force_submitted"
  | "exam.published"
  | "exam.email_sent"
  | "grading.delegated"
  | "student.provisioned"
  | "attempt.time_extended"
  | "attempt.paused"
  | "attempt.resumed"
  | "enrollment.extra_minutes_changed"
  | "lti.link_mapped"
  | "lti.link_unmapped"
  | "lti.student_linked"
  | "results.exported"
  | "result.withheld"
  | "result.released_from_hold"
  | "admin.moodle_resend"
  | "admin.flag_reviewed";

/** Record one staff action. Resolves the actor from the current session. */
export async function logAudit(opts: {
  action: AuditAction;
  targetType: string;
  targetId?: string;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  if (!supabaseConfigured) return false;
  const db = getSupabase();
  if (!db) return false;
  try {
    const { data: { user } } = await db.auth.getUser();
    if (!user) return false;
    const { data: me } = await db.from("teachers").select("role").eq("auth_id", user.id).maybeSingle();
    const role = (me as { role?: string } | null)?.role === "proctor" ? "proctor" : "teacher";
    const { error } = await db.from("audit_logs").insert({
      actor_id: user.id,
      actor_role: role,
      action: opts.action,
      target_type: opts.targetType,
      target_id: opts.targetId ?? null,
      meta: opts.meta ?? {},
    });
    if (error) {
      console.warn("[audit] insert failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[audit] error:", err);
    return false;
  }
}

export type AuditEntry = {
  id: number;
  actor_id: string | null;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

/** Read the most recent audit entries (teachers only via RLS). */
export async function listAuditLogs(limit = 100, action?: string): Promise<AuditEntry[]> {
  if (!supabaseConfigured) return [];
  const db = getSupabase();
  if (!db) return [];
  let query = db
    .from("audit_logs")
    .select("id, actor_id, actor_role, action, target_type, target_id, meta, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (action) query = query.like("action", `${action}%`);
  const { data, error } = await query;
  if (error || !data) return [];
  return (data as unknown[]).map((r) => {
    const raw = r as Record<string, unknown>;
    return {
      id: Number(raw.id),
      actor_id: raw.actor_id ? String(raw.actor_id) : null,
      actor_role: String(raw.actor_role),
      action: String(raw.action),
      target_type: String(raw.target_type),
      target_id: raw.target_id ? String(raw.target_id) : null,
      meta: (raw.meta as Record<string, unknown>) ?? {},
      created_at: String(raw.created_at),
    };
  });
}
