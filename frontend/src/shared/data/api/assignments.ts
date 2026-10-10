import { byNewest } from "@/shared/domain/exam/phase";
// ──────────────────────────────────────────────────────────────────────────
// Domain module: assignments — extracted from src/shared/data/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "@/shared/data/supabase";
import type { ProctorAssignment, FacultyMember } from "@/shared/data/api/types";
import { isRealUuid } from "@/shared/data/api/helpers";

export async function listProctorAssignments(examId: string): Promise<ProctorAssignment[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("proctor_assignments")
    .select("*")
    .eq("exam_id", examId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      exam_id: String(r.exam_id),
      assignee_name: String(r.assignee_name),
      assignee_role: (r.assignee_role as ProctorAssignment["assignee_role"]) ?? "proctor",
      assignee_id: r.assignee_id ? String(r.assignee_id) : null,
      email: r.email ? String(r.email) : null,
      created_at: String(r.created_at),
    };
  });
}

/** A teacher/proctor row: used by the Assign Proctors modal + delegate pickers. */


export async function listFaculty(): Promise<FacultyMember[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db.rpc("list_assignable_staff");
  if (error || !data) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: r.id ? String(r.id) : null,
      name: String(r.name ?? "Staff"),
      role: String(r.role ?? "teacher"),
    };
  });
}

/** Assign a delegate (colleague) to cross-check marks for candidate attempts. */


export async function assignGradingDelegates(attemptIds: string[], delegateName: string): Promise<number> {
  const db = getSupabase();
  if (!db || !delegateName.trim()) return 0;
  const rows = attemptIds
    .filter((id) => isRealUuid(id))
    .map((attempt_id) => ({ attempt_id, delegate_name: delegateName.trim(), assigned_by: "teacher" }));
  if (rows.length === 0) return 0;
  const { error } = await db.from("grading_delegations").upsert(rows, { onConflict: "attempt_id,delegate_name" });
  return error ? 0 : rows.length;
}


export async function saveProctorAssignments(
  examId: string,
  assignments: { name: string; role: "proctor" | "teacher" | "ta"; id?: string | null; email?: string | null }[],
): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const names = assignments.map((a) => a.name);
  // Remove rows the teacher unchecked (only when there is at least one kept row).
  if (names.length > 0) {
    const { error: delErr } = await db
      .from("proctor_assignments")
      .delete()
      .eq("exam_id", examId)
      .not("assignee_name", "in", `(${names.map((n) => `"${n}"`).join(",")})`);
    if (delErr) return false;
  }
  const { error: insErr } = await db
    .from("proctor_assignments")
    .upsert(
      assignments.map((a) => ({
        exam_id: examId,
        assignee_name: a.name,
        assignee_role: a.role,
        assignee_id: a.id ?? null,
        email: a.email ?? null,
      })),
      { onConflict: "exam_id,assignee_name" },
    );
  return !insErr;
}

/**
 * Exams the signed-in proctor/teacher has been assigned to monitor
 * (proctor_assignments.assignee_id = my teachers.id). Used by the proctor
 * console to replace its hard-coded exam id.
 */


/**
 * Exams the signed-in proctor/teacher has been assigned to monitor
 * (proctor_assignments.assignee_id = my teachers.id). Used by the proctor
 * console to replace its hard-coded exam id.
 */
export async function listAssignedExamsForAuthUser(): Promise<
  { id: string; name: string; batch: string; status: string; mode: string; assignee_role: string; created_at?: string }[]
> {
  const db = getSupabase();
  if (!db) return [];
  const { data: sessionData } = await db.auth.getUser();
  const authId = sessionData?.user?.id;
  if (!authId) return [];
  const { data: me } = await db
    .from("teachers")
    .select("id")
    .eq("auth_id", authId)
    .maybeSingle();
  if (!me?.id) return [];
  const { data, error } = await db
    .from("proctor_assignments")
    .select("exam_id, assignee_role, exam:exams(id, name, batch, status, mode, created_at)")
    .eq("assignee_id", me.id as string)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  const seen = new Set<string>();
  const out: { id: string; name: string; batch: string; status: string; mode: string; assignee_role: string; created_at?: string }[] = [];
  for (const raw of data as unknown[]) {
    const r = raw as { exam_id?: string; assignee_role?: string; exam?: unknown };
    const examRow = Array.isArray(r.exam) ? (r.exam as unknown[])[0] : r.exam;
    const e = (examRow ?? {}) as Record<string, unknown>;
    const id = String(e.id ?? r.exam_id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(e.name ?? id),
      batch: String(e.batch ?? ""),
      status: String(e.status ?? ""),
      mode: String(e.mode ?? "lockdown"),
      assignee_role: String(r.assignee_role ?? "proctor"),
      created_at: typeof e.created_at === "string" ? e.created_at : undefined,
    });
  }
  return out.sort(byNewest);
}

// ── Teacher grading comments (inline + voice) ────────────────────────────────
