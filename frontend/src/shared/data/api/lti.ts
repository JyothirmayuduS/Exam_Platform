// ──────────────────────────────────────────────────────────────────────────
// Domain module: Moodle LTI 1.3 — course activities mapped to exams, and the
// one-time launch ticket a student's browser trades for a session.
// ──────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/shared/data/supabase";
import { logAudit } from "@/shared/data/api/audit";

export type MoodleLink = {
  id: string;
  course: string;
  activity: string;
  site: string;
  examId: string | null;
  lastLaunchAt: string | null;
};

/** Every Moodle activity launched at least once, newest first. An activity
 *  appears after its first launch from Moodle (a teacher's click is enough). */
export async function listMoodleLinks(): Promise<MoodleLink[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("lti_links")
    .select("id, context_title, resource_title, exam_id, last_launch_at, platform:lti_platforms(name)")
    .order("last_launch_at", { ascending: false });
  if (error || !data) return [];
  return (data as unknown as {
    id: string;
    context_title: string | null;
    resource_title: string | null;
    exam_id: string | null;
    last_launch_at: string | null;
    platform: { name?: string } | { name?: string }[] | null;
  }[]).map((r) => {
    const p = Array.isArray(r.platform) ? r.platform[0] : r.platform;
    return {
      id: String(r.id),
      course: r.context_title ?? "",
      activity: r.resource_title ?? "",
      site: p?.name ?? "Moodle",
      examId: r.exam_id ?? null,
      lastLaunchAt: r.last_launch_at ?? null,
    };
  });
}

/** Point a Moodle activity at an exam the teacher owns, or unmap it (null). */
export async function mapMoodleLink(linkId: string, examId: string | null): Promise<{ error?: string }> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection" };
  const { data: userData } = await db.auth.getUser();
  const { data, error } = await db
    .from("lti_links")
    .update({ exam_id: examId, mapped_by: examId ? userData?.user?.id ?? null : null, mapped_at: examId ? new Date().toISOString() : null })
    .eq("id", linkId)
    .select("id");
  if (error) return { error: error.message };
  if (!data?.length) return { error: "Only the teacher who owns the exam can change this Moodle link." };
  void logAudit({ action: examId ? "lti.link_mapped" : "lti.link_unmapped", targetType: "lti_link", targetId: linkId, meta: { exam_id: examId } });
  return {};
}

export type LtiSessionResult = { ok: true; examId: string } | { ok: false; error: string };

/** Trade the launch ticket for a Supabase session as the Moodle user. The
 *  exam comes back from the server: the browser URL cannot choose it. */
export async function completeLtiLaunch(
  db: SupabaseClient,
  ticket: string,
  examId: string | null,
): Promise<LtiSessionResult> {
  const { data, error } = await db.functions.invoke("lti/session", { body: { ticket, examId } });
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status;
    return { ok: false, error: status === 403 ? "wrong_exam" : status === 401 ? "expired_ticket" : "session_failed" };
  }
  const res = (data ?? {}) as { tokenHash?: string; examId?: string };
  if (!res.tokenHash || !res.examId) return { ok: false, error: "session_failed" };
  const { error: otpError } = await db.auth.verifyOtp({ token_hash: res.tokenHash, type: "magiclink" });
  if (otpError) return { ok: false, error: "session_failed" };
  return { ok: true, examId: res.examId };
}
