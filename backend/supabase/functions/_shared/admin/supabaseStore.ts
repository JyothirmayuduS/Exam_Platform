// Postgres implementation of AdminStore. Needs a service-role client.
// deno-lint-ignore-file no-explicit-any
import type { AdminStore, StaffRef, StudentRef } from "./handler.ts";
import type { AdminAttempt, AdminExam, Flag, GradeTarget } from "./model.ts";

type Db = any;

const EXAM_COLS = "id, name, batch, status, scheduled_at, duration_minutes, total_marks, passing_marks, created_by, settings, created_at";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTEMPT_COLS = "id, exam_id, student_id, state, score, started_at, submitted_at, auto_saved_at, session_seen_at, user_agent";

async function inChunks<T>(ids: string[], fetch: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 200) out.push(...(await fetch(ids.slice(i, i + 200))));
  return out;
}

export function supabaseAdminStore(db: Db): AdminStore {
  const must = <T>({ data, error }: { data: T; error: { message: string } | null }): T => {
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    async isAdmin(authId) {
      const t = must(await db.from("teachers").select("role").eq("auth_id", authId).maybeSingle()) as any;
      if (t?.role !== "teacher") return false;
      const a = must(await db.from("staff_admins").select("auth_id").eq("auth_id", authId).maybeSingle());
      return !!a;
    },

    async exams() {
      const rows = must(await db.from("exams").select(EXAM_COLS).order("scheduled_at", { ascending: false, nullsFirst: false })) as any[];
      return (rows ?? []).map((r): AdminExam => ({
        id: String(r.id), name: String(r.name ?? r.id), batch: r.batch ?? null, status: r.status ?? null,
        scheduled_at: r.scheduled_at ?? null, duration_minutes: r.duration_minutes ?? null,
        total_marks: r.total_marks ?? null, passing_marks: r.passing_marks ?? null,
        created_by: r.created_by ? String(r.created_by) : null,
        settings: r.settings && typeof r.settings === "object" ? r.settings : {},
        created_at: r.created_at ?? null,
      }));
    },

    async enrollments(examIds) {
      return inChunks(examIds, async (c) => must(await db.from("enrollments").select("exam_id, student_id").in("exam_id", c)) as any[]);
    },

    async attempts(sinceIso) {
      const rows = must(await db.from("attempts").select(ATTEMPT_COLS)
        .or(`started_at.gte.${sinceIso},state.eq.in_progress,state.eq.paused,and(state.eq.submitted,score.is.null)`)
        .limit(20000)) as any[];
      return (rows ?? []) as AdminAttempt[];
    },

    async questionCounts(examIds) {
      const counts = new Map<string, Set<string>>();
      const add = (r: any) => {
        const s = counts.get(r.exam_id) ?? new Set<string>();
        s.add(String(r.question_id ?? r.id));
        counts.set(r.exam_id, s);
      };
      (await inChunks(examIds, async (c) => must(await db.from("exam_questions").select("exam_id, question_id").in("exam_id", c)) as any[])).forEach(add);
      (await inChunks(examIds, async (c) => must(await db.from("questions").select("id, exam_id").in("exam_id", c)) as any[])).forEach(add);
      return new Map([...counts].map(([k, v]) => [k, v.size]));
    },

    async moodleLinks(examIds) {
      const rows = await inChunks(examIds, async (c) => must(await db.from("lti_links").select("exam_id, resource_title, context_title").in("exam_id", c)) as any[]);
      return rows.map((r) => ({ exam_id: r.exam_id, title: [r.context_title, r.resource_title].filter(Boolean).join(" · ") || "Moodle activity" }));
    },

    async proctorAssignments(examIds) {
      const rows = await inChunks(examIds, async (c) => must(await db.from("proctor_assignments").select("exam_id, assignee_name, assignee_role, email").in("exam_id", c)) as any[]);
      return rows.map((r) => ({ exam_id: r.exam_id, name: r.assignee_name ?? "", role: r.assignee_role ?? "proctor", email: r.email ?? null }));
    },

    async students(ids) {
      const rows = await inChunks(ids, async (c) => must(await db.from("students").select("id, roll, full_name").in("id", c)) as any[]);
      return new Map(rows.map((r): [string, StudentRef] => [String(r.id), { id: String(r.id), roll: r.roll ?? "", full_name: r.full_name ?? null }]));
    },

    async studentNamesByAuth(authIds) {
      const rows = await inChunks(authIds, async (c) => must(await db.from("students").select("auth_id, roll, full_name").in("auth_id", c)) as any[]);
      return new Map(rows.map((r): [string, string] => [String(r.auth_id), [r.roll, r.full_name].filter(Boolean).join(" · ") || "Student"]));
    },

    async studentCounts() {
      const all = await db.from("students").select("id", { count: "exact", head: true });
      const noLogin = await db.from("students").select("id", { count: "exact", head: true }).is("auth_id", null);
      if (all.error) throw new Error(all.error.message);
      if (noLogin.error) throw new Error(noLogin.error.message);
      return { total: all.count ?? 0, withoutLogin: noLogin.count ?? 0 };
    },

    async staff() {
      const rows = must(await db.from("teachers").select("auth_id, full_name, name, email, role")) as any[];
      const admins = new Set((must(await db.from("staff_admins").select("auth_id")) as any[]).map((r) => String(r.auth_id)));
      return (rows ?? []).filter((r) => r.auth_id).map((r): StaffRef => ({
        auth_id: String(r.auth_id), name: r.full_name || r.name || r.email || "Staff", email: r.email ?? null,
        role: r.role ?? "teacher", admin: admins.has(String(r.auth_id)),
      }));
    },

    async flags(sinceIso) {
      const rows = must(await db.from("violation_events").select("id, exam_id, attempt_id, student_id, violation_type, severity, source, created_at")
        .gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(2000)) as any[];
      return (rows ?? []) as Flag[];
    },

    async reviewedFlags(ids) {
      const rows = await inChunks(ids, async (c) => must(await db.from("flag_reviews").select("violation_id").in("violation_id", c)) as any[]);
      return new Set(rows.map((r) => String(r.violation_id)));
    },

    async gradeTargets() {
      const rows = must(await db.from("lti_grade_targets")
        .select("link_id, student_id, exam_id, lineitem, last_score, last_posted_at, last_error, pending_score, post_attempts, next_attempt_at")
        .limit(20000)) as any[];
      return (rows ?? []) as GradeTarget[];
    },

    async pendingMoodleUsers() {
      return must(await db.from("lti_pending_users")
        .select("id, name, email, username, sourced_id, context_title, first_seen_at, last_launch_at")
        .order("last_launch_at", { ascending: false }).limit(200)) as any[];
    },

    async holds() {
      return must(await db.from("result_holds").select("attempt_id, exam_id, student_id, reason, held_by, held_at").order("held_at", { ascending: false })) as any[];
    },

    async phoneUploads(sinceIso) {
      const rows = (must(await db.from("mobile_upload_sessions")
        .select("id, exam_id, attempt_id, student_id, question_id, question_index, status, created_at, expires_at")
        .gte("created_at", sinceIso).neq("status", "COMPLETED")
        .order("created_at", { ascending: false }).limit(500)) as any[]) ?? [];
      // Older sessions carry only the attempt; its exam is the session's exam.
      const attemptIds = [...new Set(rows.filter((r) => !r.exam_id && UUID_RE.test(r.attempt_id ?? "")).map((r) => String(r.attempt_id)))];
      const examOfAttempt = new Map((await inChunks(attemptIds, async (c) => must(await db.from("attempts").select("id, exam_id").in("id", c)) as any[]))
        .map((a) => [String(a.id), String(a.exam_id)]));
      const pending = rows.map((r) => ({
        id: String(r.id), exam_id: r.exam_id ?? examOfAttempt.get(String(r.attempt_id)) ?? null, student_id: r.student_id ?? null,
        question_id: r.question_id ?? null, question_index: r.question_index ?? null, status: r.status ?? null,
        created_at: r.created_at, expires_at: r.expires_at ?? null,
      }));
      const done = await db.from("mobile_upload_sessions").select("id", { count: "exact", head: true })
        .gte("created_at", sinceIso).eq("status", "COMPLETED");
      if (done.error) throw new Error(done.error.message);
      return { pending, completed: done.count ?? 0 };
    },

    async auditLogs({ actorId, examId, action, limit }) {
      let q = db.from("audit_logs").select("id, actor_id, actor_role, action, target_type, target_id, meta, created_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (actorId) q = q.eq("actor_id", actorId);
      if (action) q = q.like("action", `${action}%`);
      if (examId) q = q.or(`target_id.eq.${examId},meta->>exam_id.eq.${examId},meta->exam_ids.cs.["${examId}"]`);
      return must(await q) as any[];
    },

    async systemStatus() {
      return must(await db.rpc("admin_system_status")) as any;
    },

    async resendGrades(examId, nowIso) {
      let q = db.from("lti_grade_targets")
        .update({ next_attempt_at: nowIso, post_attempts: 0 })
        .not("pending_score", "is", null)
        .not("lineitem", "is", null);
      if (examId) q = q.eq("exam_id", examId);
      const rows = must(await q.select("link_id")) as any[];
      return (rows ?? []).length;
    },

    async reviewFlag(violationId, by, note) {
      const v = must(await db.from("violation_events").select("id, exam_id").eq("id", violationId).maybeSingle()) as any;
      if (!v) return null;
      must(await db.from("flag_reviews").upsert({ violation_id: v.id, exam_id: v.exam_id ?? null, reviewed_by: by, reviewed_at: new Date().toISOString(), note }));
      return { exam_id: v.exam_id ?? null };
    },

    async writeAudit({ actorId, action, targetType, targetId, meta }) {
      must(await db.from("audit_logs").insert({ actor_id: actorId, actor_role: "staff", action, target_type: targetType, target_id: targetId, meta }));
    },
  };
}
