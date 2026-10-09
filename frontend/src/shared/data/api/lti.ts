// ──────────────────────────────────────────────────────────────────────────
// Domain module: Moodle LTI 1.3. Everything goes through the `lti` Edge
// Function, which only shows a teacher the Moodle courses they launched as an
// instructor and only maps activities to exams they own.
// ──────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "@/shared/data/supabase";
import { logAudit } from "@/shared/data/api/audit";

export type MoodleLink = {
  id: string;
  course: string;
  activity: string;
  examId: string | null;
  lastLaunchAt: string | null;
};

export type MoodleWaitingStudent = {
  id: string;
  name: string;
  email: string;
  username: string;
  idNumber: string;
  course: string;
};

export type MoodleOverview = { connected: boolean; links: MoodleLink[]; waiting: MoodleWaitingStudent[] };

const ERRORS: Record<string, string> = {
  teachers_only: "Only teachers can manage Moodle links.",
  not_your_course: "You can only manage activities from Moodle courses you teach. Open the activity in Moodle once as its teacher.",
  not_your_exam: "You can only link Moodle activities to exams you own.",
  expired_claim: "That Moodle sign-in expired. Open the activity in Moodle again.",
  claimed_by_other: "That Moodle teacher account is already linked to another platform teacher.",
  no_student: "No student has that roll number.",
  student_taken: "That student is already linked to a different Moodle account.",
  roll_exists: "A student with this Moodle ID number already exists. Link to them by roll number instead.",
};

type CallResult<T> = { data?: T; error?: string };

async function call<T>(route: string, body: Record<string, unknown>): Promise<CallResult<T>> {
  const db = getSupabase();
  if (!db) return { error: "No DB connection" };
  const { data, error } = await db.functions.invoke(`lti/${route}`, { body });
  if (error) {
    let code = "";
    try {
      const res = (error as { context?: Response }).context;
      if (res && typeof res.json === "function") code = String(((await res.clone().json()) as { error?: string }).error ?? "");
    } catch {
      // Non-JSON error body.
    }
    return { error: ERRORS[code] ?? "Moodle request failed. Try again." };
  }
  return { data: data as T };
}

/** Activities and waiting students from the Moodle courses this teacher teaches. */
export async function getMoodleOverview(): Promise<MoodleOverview> {
  const res = await call<{ connected?: boolean; links?: Record<string, unknown>[]; pending?: Record<string, unknown>[] }>("links", {});
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    connected: res.data?.connected === true,
    links: (res.data?.links ?? []).map((l) => ({
      id: str(l.id),
      course: str(l.contextTitle),
      activity: str(l.resourceTitle),
      examId: typeof l.examId === "string" ? l.examId : null,
      lastLaunchAt: typeof l.lastLaunchAt === "string" ? l.lastLaunchAt : null,
    })),
    waiting: (res.data?.pending ?? []).map((p) => ({
      id: str(p.id),
      name: str(p.name),
      email: str(p.email),
      username: str(p.username),
      idNumber: str(p.sourcedId),
      course: str(p.contextTitle),
    })),
  };
}

/** Point a Moodle activity at an exam the teacher owns, or unlink it (null). */
export async function mapMoodleLink(linkId: string, examId: string | null): Promise<{ error?: string }> {
  const res = await call("map", { linkId, examId });
  if (!res.error) void logAudit({ action: examId ? "lti.link_mapped" : "lti.link_unmapped", targetType: "lti_link", targetId: linkId, meta: { exam_id: examId } });
  return { error: res.error };
}

/** Confirm a waiting Moodle student: link to an existing roll, or create a new student (roll null). */
export async function confirmMoodleStudent(pendingId: string, roll: string | null): Promise<{ error?: string }> {
  const res = await call("link-student", { pendingId, roll });
  if (!res.error) void logAudit({ action: "lti.student_linked", targetType: "lti_pending_user", targetId: pendingId, meta: { roll } });
  return { error: res.error };
}

/** Send every graded score of this exam to Moodle again. */
export async function resendMoodleGrades(examId: string): Promise<{ posted: number; queued: number; error?: string }> {
  const res = await call<{ posted?: number; queued?: number }>("resend", { examId });
  return { posted: Number(res.data?.posted ?? 0), queued: Number(res.data?.queued ?? 0), error: res.error };
}

/** Tie the Moodle instructor account from a launch to the signed-in teacher. */
export async function claimMoodleInstructor(claim: string): Promise<{ error?: string }> {
  return { error: (await call("claim", { claim })).error };
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
