// Postgres implementation of AdminStore. Needs a service-role client.
// Every list is read page by page (see ../db/paging.ts): a university has
// far more than PostgREST's 1,000 rows per response.
// deno-lint-ignore-file no-explicit-any
import type { AdminStore, StaffRef, StudentRef } from "./handler.ts";
import type { AdminAttempt, AdminExam, Flag, FolderUsage, GradeTarget } from "./model.ts";
import { readAll, readAllIn } from "../db/paging.ts";
import { PHOTO_BUCKET } from "../photos/supabaseStore.ts";

type Db = any;

const EXAM_COLS = "id, name, batch, status, scheduled_at, duration_minutes, total_marks, passing_marks, created_by, settings, created_at, academic_type, subject_code, subject_name, legacy_name";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTEMPT_COLS = "id, exam_id, student_id, state, score, started_at, submitted_at, auto_saved_at, session_seen_at, user_agent";
const USAGE_COLS = "folder, bytes, objects, oldest, due_soon_bytes, due_soon_objects, next_deletion, counted_at, scan_started_at";

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
      const rows = await readAll(() => db.from("exams").select(EXAM_COLS)
        .order("scheduled_at", { ascending: false, nullsFirst: false }).order("id"));
      return rows.map((r): AdminExam => ({
        id: String(r.id), name: String(r.name ?? r.id), batch: r.batch ?? null, status: r.status ?? null,
        scheduled_at: r.scheduled_at ?? null, duration_minutes: r.duration_minutes ?? null,
        total_marks: r.total_marks ?? null, passing_marks: r.passing_marks ?? null,
        created_by: r.created_by ? String(r.created_by) : null,
        settings: r.settings && typeof r.settings === "object" ? r.settings : {},
        created_at: r.created_at ?? null,
        academic_type: r.academic_type ?? null, subject_code: r.subject_code ?? null, subject_name: r.subject_name ?? null,
        legacy_name: r.legacy_name ?? null,
      }));
    },

    async enrollments(examIds) {
      return readAllIn(examIds, (c) => db.from("enrollments").select("exam_id, student_id").in("exam_id", c).order("exam_id").order("student_id"));
    },

    async attempts(sinceIso) {
      return readAll<AdminAttempt>(() => db.from("attempts").select(ATTEMPT_COLS)
        .or(`started_at.gte.${sinceIso},state.eq.in_progress,state.eq.paused,and(state.eq.submitted,score.is.null)`)
        .order("id"));
    },

    async questionCounts(examIds) {
      const counts = new Map<string, Set<string>>();
      const add = (r: any) => {
        const s = counts.get(r.exam_id) ?? new Set<string>();
        s.add(String(r.question_id ?? r.id));
        counts.set(r.exam_id, s);
      };
      (await readAllIn(examIds, (c) => db.from("exam_questions").select("exam_id, question_id").in("exam_id", c).order("exam_id").order("question_id"))).forEach(add);
      (await readAllIn(examIds, (c) => db.from("questions").select("id, exam_id").in("exam_id", c).order("id"))).forEach(add);
      return new Map([...counts].map(([k, v]) => [k, v.size]));
    },

    async moodleLinks(examIds) {
      const rows = await readAllIn(examIds, (c) => db.from("lti_links").select("exam_id, resource_title, context_title").in("exam_id", c).order("id"));
      return rows.map((r) => ({ exam_id: r.exam_id, title: [r.context_title, r.resource_title].filter(Boolean).join(" · ") || "Moodle activity" }));
    },

    async proctorAssignments(examIds) {
      const rows = await readAllIn(examIds, (c) => db.from("proctor_assignments").select("exam_id, assignee_name, assignee_role, email").in("exam_id", c).order("id"));
      return rows.map((r) => ({ exam_id: r.exam_id, name: r.assignee_name ?? "", role: r.assignee_role ?? "proctor", email: r.email ?? null }));
    },

    async students(ids) {
      const rows = await readAllIn(ids, (c) => db.from("students").select("id, roll, full_name").in("id", c).order("id"));
      return new Map(rows.map((r): [string, StudentRef] => [String(r.id), { id: String(r.id), roll: r.roll ?? "", full_name: r.full_name ?? null }]));
    },

    async studentNamesByAuth(authIds) {
      const rows = await readAllIn(authIds, (c) => db.from("students").select("auth_id, roll, full_name").in("auth_id", c).order("id"));
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
      const rows = await readAll(() => db.from("teachers").select("auth_id, full_name, name, email, role").order("id"));
      const admins = new Set((await readAll(() => db.from("staff_admins").select("auth_id").order("auth_id"))).map((r) => String(r.auth_id)));
      return rows.filter((r) => r.auth_id).map((r): StaffRef => ({
        auth_id: String(r.auth_id), name: r.full_name || r.name || r.email || "Staff", email: r.email ?? null,
        role: r.role ?? "teacher", admin: admins.has(String(r.auth_id)),
      }));
    },

    async flags(sinceIso, severities) {
      return readAll<Flag>(() => {
        let q = db.from("violation_events").select("id, exam_id, attempt_id, student_id, violation_type, severity, source, created_at")
          .gte("created_at", sinceIso);
        if (severities?.length) q = q.in("severity", severities);
        return q.order("created_at", { ascending: false }).order("id");
      });
    },

    async reviewedFlags(ids) {
      const rows = await readAllIn(ids, (c) => db.from("flag_reviews").select("violation_id").in("violation_id", c).order("violation_id"));
      return new Set(rows.map((r) => String(r.violation_id)));
    },

    async gradeTargets() {
      return readAll<GradeTarget>(() => db.from("lti_grade_targets")
        .select("link_id, student_id, exam_id, lineitem, last_score, last_posted_at, last_error, pending_score, post_attempts, next_attempt_at")
        .order("link_id").order("student_id"));
    },

    async pendingMoodleUsers() {
      return readAll(() => db.from("lti_pending_users")
        .select("id, name, email, username, sourced_id, context_title, first_seen_at, last_launch_at")
        .order("last_launch_at", { ascending: false }).order("id"));
    },

    async holds() {
      return readAll(() => db.from("result_holds").select("attempt_id, exam_id, student_id, reason, held_by, held_at")
        .order("held_at", { ascending: false }).order("attempt_id"));
    },

    async phoneUploads(sinceIso) {
      const rows = await readAll(() => db.from("mobile_upload_sessions")
        .select("id, exam_id, attempt_id, student_id, question_id, question_index, status, created_at, expires_at")
        .gte("created_at", sinceIso).neq("status", "COMPLETED")
        .order("created_at", { ascending: false }).order("id"));
      // Older sessions carry only the attempt; its exam is the session's exam.
      const attemptIds = [...new Set(rows.filter((r) => !r.exam_id && UUID_RE.test(r.attempt_id ?? "")).map((r) => String(r.attempt_id)))];
      const examOfAttempt = new Map((await readAllIn(attemptIds, (c) => db.from("attempts").select("id, exam_id").in("id", c).order("id")))
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
        .update({ next_attempt_at: nowIso, post_attempts: 0 }, { count: "exact" })
        .not("pending_score", "is", null)
        .not("lineitem", "is", null);
      if (examId) q = q.eq("exam_id", examId);
      const { error, count } = await q;
      if (error) throw new Error(error.message);
      return count ?? 0;
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

    async allStudents() {
      const rows = await readAll(() => db.from("students").select("id, roll, full_name").order("id"));
      return rows.map((r): StudentRef => ({ id: String(r.id), roll: r.roll ?? "", full_name: r.full_name ?? null }));
    },

    async registrationPhotos() {
      return readAll(() => db.from("student_photos").select("student_id, storage_path, captured_at").order("student_id"));
    },

    async photoUrls(paths) {
      if (!paths.length) return new Map();
      const signed = must(await db.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 600)) as any[];
      return new Map((signed ?? []).filter((s) => s.signedUrl).map((s) => [String(s.path), String(s.signedUrl)]));
    },

    async resetPhoto(studentId) {
      const rows = must(await db.from("student_photos").delete().eq("student_id", studentId).select("storage_path")) as any[];
      if (!rows?.length) return false;
      await db.storage.from(PHOTO_BUCKET).remove(rows.map((r) => String(r.storage_path)));
      return true;
    },

    async evidenceUsage() {
      return readAll<FolderUsage>(() => db.from("evidence_usage").select(USAGE_COLS).order("folder"));
    },

    async evidenceSittings(folders) {
      return readAllIn(folders, (c) => db.from("evidence_sittings").select("folder, student_folder, kinds, files, last_upload")
        .in("folder", c).order("folder").order("student_folder"));
    },

    async scanBegin(folder, scanId) {
      must(await db.rpc("evidence_scan_begin", { p_folder: folder, p_scan: scanId }));
    },

    async scanAdd(folder, scanId, part, done, retentionDays) {
      const { sittings, ...totals } = part;
      return !!must(await db.rpc("evidence_scan_add", {
        p_folder: folder, p_scan: scanId, p_part: totals, p_sittings: sittings, p_done: done, p_retention_days: retentionDays,
      }));
    },
  };
}
