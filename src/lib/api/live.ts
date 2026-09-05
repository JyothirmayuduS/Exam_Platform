// ──────────────────────────────────────────────────────────────────────────
// Domain module: live — extracted from src/lib/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "../supabase";
import type { AttemptState, ViolationSeverity, ViolationSource, ViolationEvent, LiveAttempt, Student } from "./types";

/** All attempts for an exam, joined with the student, newest activity first. */
export async function listLiveAttempts(examId?: string | null): Promise<LiveAttempt[]> {
  const db = getSupabase();
  if (!db) return [];
  let query = db
    .from("attempts")
    .select("id,exam_id,state,answered,total,minutes_used,score,answers,paper,started_at,submitted_at,auto_saved_at,consent_at,user_agent,student:students(id,roll,full_name,email)")
    .order("auto_saved_at", { ascending: false });
  if (examId) query = query.eq("exam_id", examId);
  const { data, error } = await query;

  const attempts: LiveAttempt[] = error
    ? []
    : ((data ?? []) as unknown[]).map((row) => {
        const r = row as Record<string, unknown>;
        const s = r.student as Record<string, unknown> | Record<string, unknown>[] | null;
        const student = Array.isArray(s) ? (s[0] ?? null) : s;
        return {
          id: String(r.id),
          exam_id: String(r.exam_id),
          state: r.state as AttemptState,
          answered: Number(r.answered ?? 0),
          total: Number(r.total ?? 0),
          minutes_used: Number(r.minutes_used ?? 0),
          score: typeof r.score === "number" ? r.score : null,
          answers: (r.answers as Record<string, unknown>) ?? {},
          paper: r.paper ?? [],
          started_at: (r.started_at as string) ?? null,
          submitted_at: (r.submitted_at as string) ?? null,
          auto_saved_at: (r.auto_saved_at as string) ?? null,
          consent_at: (r.consent_at as string | null) ?? null,
          user_agent: (r.user_agent as string | null) ?? null,
          student: student
            ? {
                id: String((student as Record<string, unknown>).id),
                roll: String((student as Record<string, unknown>).roll),
                full_name: String((student as Record<string, unknown>).full_name),
                email: ((student as Record<string, unknown>).email as string | null) ?? null,
              }
            : null,
          violations: [],
        } as LiveAttempt;
      });

  // Track enrolled students who already have an attempt
  const seenStudentIds = new Set<string>();
  for (const a of attempts) {
    if (a.student?.id) seenStudentIds.add(a.student.id);
  }

  // Also query enrolled students who haven't started an attempt yet
  try {
    if (!examId) return attempts; // all-exams mode: enrolled-but-idle rows are not synthesized per exam
    const { data: enrolledData } = await db
      .from("enrollments")
      .select("student_id, student:students(id, roll, full_name)")
      .eq("exam_id", examId);

    if (enrolledData) {
      for (const row of enrolledData) {
        const s = (row as Record<string, unknown>).student;
        const st = Array.isArray(s) ? s[0] : s;
        if (st && !seenStudentIds.has((st as Record<string, unknown>).id as string)) {
          seenStudentIds.add((st as Record<string, unknown>).id as string);
          attempts.push({
            id: `enrolled-${(st as Record<string, unknown>).id}`,
            exam_id: examId,
            state: "not_started" as AttemptState,
            answered: 0,
            total: 0,
            minutes_used: 0,
            score: null,
            answers: {},
            paper: [],
            started_at: null,
            submitted_at: null,
            auto_saved_at: null,
            consent_at: null,
            user_agent: null,
            student: {
              id: String((st as Record<string, unknown>).id),
              roll: String((st as Record<string, unknown>).roll),
              full_name: String((st as Record<string, unknown>).full_name),
              email: ((st as Record<string, unknown>).email as string | null) ?? null,
            },
            violations: [],
          });
        }
      }
    }
  } catch {
    // Non-blocking fallback
  }

  // Load real violation events for this exam (student AI flags + proctor
  // actions) and attach them to the right attempt. Events are matched by
  // attempt_id when the candidate has started, otherwise by student_id so
  // warnings sent before a candidate begins still surface on their tile.
  try {
    const { data: vioData, error: vioError } = await db
      .from("violation_events")
      .select("*")
      .eq("exam_id", examId)
      .order("created_at", { ascending: true });
    if (!vioError && vioData) {
      const byAttempt = new Map<string, ViolationEvent[]>();
      const byStudent = new Map<string, ViolationEvent[]>();
      for (const raw of vioData as unknown[]) {
        const r = raw as Record<string, unknown>;
        const v: ViolationEvent = {
          id: String(r.id),
          exam_id: String(r.exam_id),
          attempt_id: r.attempt_id ? String(r.attempt_id) : null,
          student_id: String(r.student_id),
          violation_type: String(r.violation_type ?? "unknown"),
          severity: (r.severity as ViolationSeverity) ?? "warning",
          description: String(r.description ?? ""),
          source: (r.source as ViolationSource) ?? "system",
          offset_seconds: typeof r.offset_seconds === "number" ? r.offset_seconds : null,
          snapshot_key: r.snapshot_key ? String(r.snapshot_key) : null,
          created_at: String(r.created_at),
        };
        if (v.attempt_id) {
          const list = byAttempt.get(v.attempt_id) ?? [];
          list.push(v);
          byAttempt.set(v.attempt_id, list);
        } else {
          const list = byStudent.get(v.student_id) ?? [];
          list.push(v);
          byStudent.set(v.student_id, list);
        }
      }
      for (const a of attempts) {
        const mine: ViolationEvent[] = [];
        if (byAttempt.has(a.id)) mine.push(...(byAttempt.get(a.id) ?? []));
        if (a.student && byStudent.has(a.student.id)) mine.push(...(byStudent.get(a.student.id) ?? []));
        a.violations = mine.sort(
          (x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime(),
        );
      }
    }
  } catch {
    // Violations are best-effort — roster still renders without them.
  }

  return attempts;
}

/** All violation events for a single attempt (used by the recording review). */


export async function listAttemptViolations(attemptId: string): Promise<ViolationEvent[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("violation_events")
    .select("*")
    .eq("attempt_id", attemptId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      exam_id: String(r.exam_id),
      attempt_id: r.attempt_id ? String(r.attempt_id) : null,
      student_id: String(r.student_id),
      violation_type: String(r.violation_type ?? "unknown"),
      severity: (r.severity as ViolationSeverity) ?? "warning",
      description: String(r.description ?? ""),
      source: (r.source as ViolationSource) ?? "system",
      offset_seconds: typeof r.offset_seconds === "number" ? r.offset_seconds : null,
      snapshot_key: r.snapshot_key ? String(r.snapshot_key) : null,
      created_at: String(r.created_at),
    };
  });
}

/** Realtime: fire `onChange` when any attempt for this exam changes. */


export function subscribeToAttempts(examId: string, onChange: () => void): () => void {
  const db = getSupabase();
  if (!db) return () => undefined;
  
  // Use a unique channel name to prevent "cannot add postgres_changes callbacks after subscribe()" 
  // when multiple components hook into the same exam.
  const channelId = `attempts-${examId}-${Math.random().toString(36).slice(2)}`;
  const channel = db
    .channel(channelId)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "attempts", filter: `exam_id=eq.${examId}` },
      () => onChange(),
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "enrollments", filter: `exam_id=eq.${examId}` },
      () => onChange(),
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "violation_events", filter: `exam_id=eq.${examId}` },
      () => onChange(),
    )
    .subscribe();
  return () => {
    db.removeChannel(channel);
  };
}
// --- Student Enrollment Management ---


/**
 * Live per-exam proctoring stats for the assessment selector: one query for
 * attempts, one for violation events, grouped by exam_id client-side.
 */
export async function listProctoringStats(): Promise<
  Record<string, { candidates: number; active: number; submitted: number; paused: number; flagged: number }>
> {
  const db = getSupabase();
  if (!db) return {};
  const out: Record<string, { candidates: number; active: number; submitted: number; paused: number; flagged: number }> = {};
  const bump = (examId: string, field: "candidates" | "active" | "submitted" | "paused" | "flagged") => {
    if (!examId) return;
    const row = (out[examId] ??= { candidates: 0, active: 0, submitted: 0, paused: 0, flagged: 0 });
    row[field] += 1;
  };
  const { data: attempts } = await db
    .from("attempts")
    .select("exam_id,state,student_id");
  if (attempts) {
    for (const r of attempts as { exam_id?: string; state?: string; student_id?: string }[]) {
      const examId = String(r.exam_id ?? "");
      bump(examId, "candidates");
      if (r.state === "in_progress" || r.state === "not_started") bump(examId, "active");
      else if (r.state === "submitted") bump(examId, "submitted");
      else if (r.state === "paused") bump(examId, "paused");
    }
  }
  const { data: violations } = await db
    .from("violation_events")
    .select("exam_id")
    .not("severity", "eq", "info");
  if (violations) {
    for (const r of violations as { exam_id?: string }[]) bump(String(r.exam_id ?? ""), "flagged");
  }
  return out;
}
