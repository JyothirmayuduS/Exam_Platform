// ──────────────────────────────────────────────────────────────────────────
// Domain module: grading — extracted from src/lib/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "../supabase";
import type { GradingComment, DelegationRow, ExaminerExamRow } from "./types";
import { isRealUuid } from "./helpers";
import { listExamsForTeacher, updateExam } from "./exams";

export async function addGradingComment(opts: {
  attemptId: string;
  questionId?: string | null;
  comment: string;
  voiceKey?: string | null;
  createdBy?: string | null;
}): Promise<boolean> {
  const db = getSupabase();
  if (!db || !isRealUuid(opts.attemptId) || !opts.comment.trim()) return false;
  const { error } = await db.from("grading_comments").insert({
    attempt_id: opts.attemptId,
    question_id: opts.questionId ?? null,
    comment: opts.comment.trim().slice(0, 2000),
    voice_key: opts.voiceKey ?? null,
    created_by: opts.createdBy ?? null,
  });
  return !error;
}


export async function listGradingComments(attemptId: string): Promise<GradingComment[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("grading_comments")
    .select("*")
    .eq("attempt_id", attemptId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      attempt_id: String(r.attempt_id),
      question_id: r.question_id ? String(r.question_id) : null,
      comment: String(r.comment ?? ""),
      voice_key: r.voice_key ? String(r.voice_key) : null,
      created_by: r.created_by ? String(r.created_by) : null,
      created_at: String(r.created_at),
    };
  });
}

// ── Evaluator allocation (Mettl-style examiner dashboard) ────────────────────


export async function listGradingDelegations(): Promise<DelegationRow[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("grading_delegations")
    .select("id, attempt_id, exam_id, delegate_id, delegate_name, due_date, report_count, created_at, attempt:attempts(student:students(roll, full_name))")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    const attRel = Array.isArray(r.attempt) ? (r.attempt as unknown[])[0] : r.attempt;
    const att = (attRel ?? {}) as Record<string, unknown>;
    const stRel = Array.isArray(att.student) ? (att.student as unknown[])[0] : att.student;
    const st = (stRel ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      attempt_id: r.attempt_id ? String(r.attempt_id) : null,
      exam_id: r.exam_id ? String(r.exam_id) : null,
      delegate_id: r.delegate_id ? String(r.delegate_id) : null,
      delegate_name: String(r.delegate_name ?? ""),
      due_date: r.due_date ? String(r.due_date) : null,
      report_count: Number(r.report_count ?? 0),
      created_at: String(r.created_at ?? ""),
      student_roll: st.roll ? String(st.roll) : null,
      student_name: st.full_name ? String(st.full_name) : null,
    };
  });
}

/** Read the allocation metadata stored on the exam's settings jsonb. */


export async function getExamAllocation(examId: string): Promise<{
  status: "allocated" | "not_allocated";
  role?: string;
  due_date?: string | null;
  assigned?: number;
  total?: number;
  evaluators?: { id: string; name: string; email?: string | null; count: number }[];
} | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.from("exams").select("settings").eq("id", examId).maybeSingle();
  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  const alloc = settings.allocation as
    | { status?: string; role?: string; due_date?: string | null; assigned?: number; total?: number; evaluators?: unknown }
    | undefined;
  if (!alloc) return { status: "not_allocated" };
  return {
    status: alloc.status === "allocated" ? "allocated" : "not_allocated",
    role: alloc.role,
    due_date: alloc.due_date ?? null,
    assigned: Number(alloc.assigned ?? 0),
    total: Number(alloc.total ?? 0),
    evaluators: Array.isArray(alloc.evaluators)
      ? (alloc.evaluators as { id?: string; name?: string; email?: string | null; count?: number }[]).map((e) => ({
          id: String(e.id ?? ""),
          name: String(e.name ?? ""),
          email: e.email ?? null,
          count: Number(e.count ?? 0),
        }))
      : undefined,
  };
}

/**
 * Mettl-style "Auto-assign test reports": distribute the exam's submitted,
 * not-yet-delegated attempts across the chosen evaluators according to the
 * per-evaluator report counts, record a due date, and mark the exam allocated.
 * Returns { ok, error?, assigned }.
 */


/**
 * Mettl-style "Auto-assign test reports": distribute the exam's submitted,
 * not-yet-delegated attempts across the chosen evaluators according to the
 * per-evaluator report counts, record a due date, and mark the exam allocated.
 * Returns { ok, error?, assigned }.
 */
export async function assignEvaluators(opts: {
  examId: string;
  role: string;
  dueDate: string | null;
  evaluators: { id: string; name: string; email?: string | null; count: number }[];
}): Promise<{ ok: boolean; error?: string; assigned?: number }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const { examId, role, dueDate, evaluators } = opts;
  const active = evaluators.filter((e) => e.count > 0 && e.id);
  if (active.length === 0) return { ok: false, error: "Select at least one evaluator with a report count" };

  // Submitted attempts for the exam that are not already delegated.
  const { data: attempts } = await db
    .from("attempts")
    .select("id")
    .eq("exam_id", examId)
    .eq("state", "submitted");
  if (!attempts) return { ok: false, error: "Could not load submitted attempts" };
  const { data: existing } = await db.from("grading_delegations").select("attempt_id").eq("exam_id", examId);
  const delegatedIds = new Set((existing ?? []).map((r: { attempt_id?: string | null }) => r.attempt_id));
  const unassigned = (attempts as { id: string }[])
    .map((a) => a.id)
    .filter((id) => !delegatedIds.has(id));

  const totalWanted = active.reduce((s, e) => s + e.count, 0);
  const total = unassigned.length;
  // If the requested counts exceed available reports, scale down proportionally.
  const scale = totalWanted > total && total > 0 ? total / totalWanted : 1;
  const counts = active.map((e) => ({
    ...e,
    count: Math.max(0, Math.floor(e.count * scale)),
  }));

  // Delete previous batch rows (attempt rows are upserted by attempt_id+name).
  await db.from("grading_delegations").delete().eq("exam_id", examId).is("attempt_id", null);

  // Distribute round-robin weighted by the (scaled) counts.
  const pool: string[] = [];
  for (const e of counts) for (let i = 0; i < e.count; i++) pool.push(e.id);
  const rows: { attempt_id: string; exam_id: string; delegate_id: string; delegate_name: string; due_date: string | null }[] = [];
  for (let i = 0; i < unassigned.length; i++) {
    const evaluator = counts[i % counts.length];
    rows.push({
      attempt_id: unassigned[i],
      exam_id: examId,
      delegate_id: evaluator.id,
      delegate_name: evaluator.name,
      due_date: dueDate,
    });
  }
  if (rows.length > 0) {
    const { error } = await db.from("grading_delegations").upsert(rows, { onConflict: "attempt_id,delegate_name" });
    if (error) return { ok: false, error: String(error.message ?? error) };
  }

  const assigned = rows.length;
  await updateExam(examId, {
    settings: {
      allocation: {
        status: "allocated",
        role,
        due_date: dueDate,
        assigned,
        total,
        evaluators: counts.map((e) => ({ id: e.id, name: e.name, email: e.email ?? null, count: e.count })),
      },
    },
  });
  return { ok: true, assigned };
}


/** Aggregated numbers for the Examiner dashboard (one DB pass + light grouping). */
export async function loadExaminerDashboard(): Promise<{
  exams: ExaminerExamRow[];
  totalTestTakers: number;
  totalEvaluators: number;
  daily: { day: string; label: string; submitted: number; graded: number }[];
}> {
  const db = getSupabase();
  const empty = { exams: [], totalTestTakers: 0, totalEvaluators: 0, daily: [] };
  if (!db) return empty;

  const [exams, attempts, enrollments, delegations] = await Promise.all([
    listExamsForTeacher(),
    db
      .from("attempts")
      .select("exam_id, state, score, submitted_at")
      .in("state", ["in_progress", "submitted", "paused"])
      .then((r: { data?: unknown[] | null }) => r.data ?? []),
    db
      .from("enrollments")
      .select("exam_id, student_id")
      .then((r: { data?: unknown[] | null }) => r.data ?? []),
    listGradingDelegations(),
  ]);

  const enrollmentCounts = new Map<string, number>();
  for (const e of enrollments as { exam_id?: string; student_id?: string }[]) {
    if (!e.exam_id) continue;
    enrollmentCounts.set(e.exam_id, (enrollmentCounts.get(e.exam_id) ?? 0) + 1);
  }

  const perExam: Record<string, { submitted: number; auto_graded: number; unassigned: number; delegates: Set<string> }> = {};
  for (const a of attempts as { exam_id?: string; state?: string; score?: number | null }[]) {
    if (!a.exam_id) continue;
    const bucket = (perExam[a.exam_id] ??= { submitted: 0, auto_graded: 0, unassigned: 0, delegates: new Set<string>() });
    if (a.state === "submitted") {
      bucket.submitted += 1;
      if (typeof a.score === "number") bucket.auto_graded += 1;
    }
  }
  const delegatedAttempts = new Set<string>();
  const delegateNames = new Set<string>();
  for (const d of delegations) {
    if (d.delegate_name) delegateNames.add(d.delegate_name.toLowerCase());
    if (d.exam_id && d.attempt_id) {
      delegatedAttempts.add(d.attempt_id);
      const bucket = (perExam[d.exam_id] ??= { submitted: 0, auto_graded: 0, unassigned: 0, delegates: new Set<string>() });
      bucket.delegates.add(d.delegate_name.toLowerCase());
    }
  }

  const rows: ExaminerExamRow[] = [];
  for (const exam of exams) {
    const bucket = (perExam[exam.id] ??= { submitted: 0, auto_graded: 0, unassigned: 0, delegates: new Set<string>() });
    const allocation = await getExamAllocation(exam.id);
    const submittedAttempts = bucket.submitted;
    rows.push({
      id: exam.id,
      name: exam.name,
      batch: exam.batch,
      status: exam.status,
      mode: exam.mode,
      duration_minutes: exam.duration_minutes,
      pool_count: exam.pool_count,
      created_at: exam.created_at ?? null,
      roster_count: enrollmentCounts.get(exam.id) ?? 0,
      submitted: submittedAttempts,
      auto_graded: bucket.auto_graded,
      unassigned: allocation?.status === "allocated"
        ? Math.max(0, submittedAttempts - (allocation.assigned ?? 0))
        : submittedAttempts,
      delegates: bucket.delegates.size,
      allocation,
    });
  }
  void delegatedAttempts;

  const totalTestTakers = rows.reduce((s, r) => s + r.roster_count, 0);
  const totalEvaluators = delegateNames.size;

  // Daily submissions over the last 14 days (submitted vs already graded).
  const dayBuckets = new Map<string, { day: string; label: string; submitted: number; graded: number }>();
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dayBuckets.set(d.toDateString(), { day: d.toDateString(), label: d.toLocaleDateString([], { day: "numeric", month: "short" }), submitted: 0, graded: 0 });
  }
  for (const a of attempts as { submitted_at?: string | null; score?: number | null }[]) {
    if (!a.submitted_at) continue;
    const d = new Date(a.submitted_at);
    const bucket = dayBuckets.get(d.toDateString());
    if (bucket) {
      bucket.submitted += 1;
      if (typeof a.score === "number") bucket.graded += 1;
    }
  }
  return { exams: rows, totalTestTakers, totalEvaluators, daily: Array.from(dayBuckets.values()) };
}
