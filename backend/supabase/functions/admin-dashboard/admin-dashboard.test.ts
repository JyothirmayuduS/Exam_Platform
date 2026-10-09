// @vitest-environment node
// Admin console: connection state, live counts, readiness, exam browser
// versions, Moodle grade posts, storage per exam, flags, and who may call it.
import { describe, expect, it } from "vitest";
import { createAdminHandler, type AdminProbes, type AdminStore, type AuditRow, type SystemStatus } from "../_shared/admin/handler.ts";
import {
  compareVersions, connectionOf, flagsAwaitingReview, gradePostState, kioskVersion, liveCounts, readiness, releaseVersion,
  storageByExam, unreleased, versionsInUse, type AdminAttempt, type AdminExam, type Flag, type GradeTarget,
} from "../_shared/admin/model.ts";

const NOW = Date.parse("2026-10-10T06:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const att = (over: Partial<AdminAttempt>): AdminAttempt => ({
  id: "a", exam_id: "EX-LIVE", student_id: "s1", state: "in_progress", score: null,
  started_at: ago(1200), submitted_at: null, auto_saved_at: null, session_seen_at: ago(10), user_agent: null, ...over,
});

const exam = (over: Partial<AdminExam> = {}): AdminExam => ({
  id: "EX-1", name: "Data Structures", batch: "CSE", status: "published", scheduled_at: ago(-3600), duration_minutes: 60,
  total_marks: 10, passing_marks: 40, created_by: "teacher-A", settings: {}, created_at: ago(86400), ...over,
});

describe("connection state", () => {
  it("uses the freshest of the session heartbeat, autosave and start", () => {
    expect(connectionOf(att({ session_seen_at: ago(20) }), NOW)?.state).toBe("good");
    expect(connectionOf(att({ session_seen_at: ago(90) }), NOW)?.state).toBe("weak");
    expect(connectionOf(att({ session_seen_at: ago(600) }), NOW)?.state).toBe("lost");
    expect(connectionOf(att({ session_seen_at: ago(600), auto_saved_at: ago(5) }), NOW)?.state).toBe("good");
  });

  it("only applies to candidates who are writing", () => {
    expect(connectionOf(att({ state: "submitted" }), NOW)).toBeNull();
    expect(connectionOf(att({ state: "paused" }), NOW)).toBeNull();
  });
});

describe("live counts", () => {
  it("splits writing, weak, disconnected, paused, submitted and not started", () => {
    const counts = liveCounts(["s1", "s2", "s3", "s4", "s5", "s6"], [
      att({ id: "1", student_id: "s1", session_seen_at: ago(5) }),
      att({ id: "2", student_id: "s2", session_seen_at: ago(80) }),
      att({ id: "3", student_id: "s3", session_seen_at: ago(900) }),
      att({ id: "4", student_id: "s4", state: "paused" }),
      att({ id: "5", student_id: "s5", state: "submitted", submitted_at: ago(60) }),
    ], NOW);
    expect(counts).toEqual({ enrolled: 6, writing: 2, weak: 1, disconnected: 1, paused: 1, submitted: 1, notStarted: 1 });
  });

  it("counts a student once, by their latest attempt", () => {
    const counts = liveCounts(["s1"], [
      att({ id: "old", state: "submitted", started_at: ago(5000) }),
      att({ id: "new", state: "in_progress", started_at: ago(100) }),
    ], NOW);
    expect(counts.enrolled).toBe(1);
    expect(counts.writing).toBe(1);
    expect(counts.submitted).toBe(0);
  });
});

describe("readiness", () => {
  it("needs a schedule, a paper and enrolled students; proctors and Moodle are advised", () => {
    const ok = readiness(exam(), { questions: 20, enrolled: 60, proctors: 0, moodleLinks: 0 });
    expect(ok.ready).toBe(true);
    expect(ok.checks.find((c) => c.key === "proctors")).toMatchObject({ ok: false, required: false });

    expect(readiness(exam(), { questions: 0, enrolled: 60, proctors: 2, moodleLinks: 1 }).ready).toBe(false);
    expect(readiness(exam(), { questions: 5, enrolled: 0, proctors: 2, moodleLinks: 1 }).ready).toBe(false);
    expect(readiness(exam({ scheduled_at: null }), { questions: 5, enrolled: 5, proctors: 2, moodleLinks: 1 }).ready).toBe(false);
  });
});

describe("results not released", () => {
  it("lists finished or submitted exams whose scores students can't see", () => {
    const done = exam({ scheduled_at: ago(7200), duration_minutes: 60 });
    expect(unreleased(done, 0, NOW)).toBe(true);
    expect(unreleased({ ...done, settings: { results_published: true } }, 10, NOW)).toBe(false);
    expect(unreleased(exam({ scheduled_at: ago(-7200) }), 0, NOW)).toBe(false);
    expect(unreleased(exam({ status: "draft" }), 3, NOW)).toBe(false);
  });
});

describe("exam browser versions", () => {
  it("reads the version from the kiosk user agent", () => {
    expect(kioskVersion("Mozilla/5.0 (Windows NT 10.0) VignanExam/0.2.32")).toBe("0.2.32");
    expect(kioskVersion("Mozilla/5.0 VignanExam/web")).toBe("web");
    expect(kioskVersion("Mozilla/5.0 VignanExam/unknown")).toBeNull();
    expect(kioskVersion("Mozilla/5.0 Chrome/120")).toBeNull();
    expect(releaseVersion("lockdown-v0.2.60")).toBe("0.2.60");
  });

  it("compares versions numerically, not as text", () => {
    expect(compareVersions("0.2.9", "0.2.10")).toBe(-1);
    expect(compareVersions("0.2.60", "0.2.60")).toBe(0);
    expect(compareVersions("0.3.0", "0.2.99")).toBe(1);
  });

  it("marks versions older than the latest release as outdated", () => {
    const list = versionsInUse([
      { student_id: "s1", user_agent: "x VignanExam/0.2.32", started_at: ago(100) },
      { student_id: "s2", user_agent: "x VignanExam/0.2.32", started_at: ago(50) },
      { student_id: "s3", user_agent: "x VignanExam/0.2.60", started_at: ago(10) },
      { student_id: "s4", user_agent: "x VignanExam/web", started_at: ago(10) },
      { student_id: "s5", user_agent: null, started_at: ago(10) },
    ], "0.2.60");
    expect(list.map((v) => [v.version, v.students, v.outdated])).toEqual([["0.2.60", 1, false], ["0.2.32", 2, true], ["web", 1, false]]);
  });

  it("treats 0.2.9 as older than 0.2.10", () => {
    const list = versionsInUse([{ student_id: "s1", user_agent: "x VignanExam/0.2.9", started_at: ago(10) }], "0.2.10");
    expect(list[0]).toMatchObject({ version: "0.2.9", outdated: true });
  });
});

describe("Moodle grade posts", () => {
  const t = (over: Partial<GradeTarget>): GradeTarget => ({
    link_id: "L", student_id: "s1", exam_id: "EX-1", lineitem: "https://m/li/1", last_score: 7, last_posted_at: ago(60),
    last_error: null, pending_score: null, post_attempts: 0, next_attempt_at: null, ...over,
  });
  it("tells posted, queued, retrying, given up and no gradebook apart", () => {
    expect(gradePostState(t({}))).toBe("posted");
    expect(gradePostState(t({ pending_score: 8, next_attempt_at: ago(-60) }))).toBe("queued");
    expect(gradePostState(t({ pending_score: 8, next_attempt_at: ago(-60), last_error: "HTTP 500" }))).toBe("retrying");
    expect(gradePostState(t({ pending_score: 8, next_attempt_at: null, last_error: "HTTP 500" }))).toBe("gave_up");
    expect(gradePostState(t({ pending_score: 8, lineitem: null }))).toBe("no_gradebook");
  });
});

describe("storage per exam", () => {
  const exams = [{ id: "EXAM-2026-AAA", name: "Test 3" }, { id: "EXAM-2026-BBB", name: "DS Mid (Sem 3)" }];
  it("groups kiosk folders by exam name and phone folders by exam id", () => {
    const s = storageByExam([
      { key: "Test-3/21BQ1/screenshots/1.jpg", size: 100, lastModified: ago(86400 * 10) },
      { key: "EXAM-2026-AAA/uuid/subjective/q1.jpg", size: 50, lastModified: ago(86400) },
      { key: "DS-Mid-Sem-3/21BQ2/report/r.pdf", size: 400, lastModified: ago(86400 * 2) },
      { key: "Old-Exam/21BQ3/recordings/parts/exam_1.webm", size: 1000, lastModified: ago(86400 * 86) },
    ], exams, 90, NOW);
    expect(s.totalBytes).toBe(1550);
    expect(s.totalObjects).toBe(4);
    const byFolder = Object.fromEntries(s.exams.map((g) => [g.folder, g]));
    expect(byFolder["Test-3"].examIds).toEqual(["EXAM-2026-AAA"]);
    expect(byFolder["EXAM-2026-AAA"].examIds).toEqual(["EXAM-2026-AAA"]);
    expect(byFolder["DS-Mid-Sem-3"].examName).toBe("DS Mid (Sem 3)");
    expect(byFolder["Old-Exam"].examIds).toEqual([]);
    expect(s.exams[0].folder).toBe("Old-Exam");
  });

  it("counts what the retention rule deletes within a week", () => {
    const s = storageByExam([
      { key: "Test-3/a/x/1", size: 10, lastModified: ago(86400 * 85) },
      { key: "Test-3/a/x/2", size: 20, lastModified: ago(86400 * 80) },
    ], exams, 90, NOW);
    expect(s.dueSoonObjects).toBe(1);
    expect(s.dueSoonBytes).toBe(10);
    expect(s.exams[0].nextDeletion).toBe(new Date(NOW + 5 * 86400_000).toISOString());
  });
});

describe("flags awaiting review", () => {
  it("keeps serious flags nobody has reviewed", () => {
    const f = (id: string, severity: string): Flag => ({ id, exam_id: "EX-1", attempt_id: "a", student_id: "s1", violation_type: "Tab switch", severity, source: "system", created_at: ago(60) });
    const out = flagsAwaitingReview([f("1", "critical"), f("2", "high"), f("3", "warning"), f("4", "info")], new Set(["2"]));
    expect(out.map((x) => x.id)).toEqual(["1"]);
  });
});

// ── Endpoint ────────────────────────────────────────────────────────────────

const STATUS: SystemStatus = {
  jobs: [{ name: "lti-grade-retry", schedule: "*/5 * * * *", active: true, last_run: { status: "succeeded", started_at: ago(120), ended_at: ago(119), message: "1 row" }, failures_24h: 0 }],
  buckets: [{ bucket: "exam-records", objects: 3, bytes: 900 }],
  database_bytes: 1000,
  unlinked_accounts: [],
  missing_app_role: [{ id: "u9", email: "x@vignan.ac.in", kind: "student" }],
};

function makeStore(over: Partial<AdminStore> = {}) {
  const audits: { action: string; targetId: string; meta: Record<string, unknown> }[] = [];
  const resends: (string | null)[] = [];
  const reviews: string[] = [];
  const live = exam({ id: "EX-LIVE", name: "Live exam", scheduled_at: ago(1800), duration_minutes: 120 });
  const soon = exam({ id: "EX-SOON", name: "Tomorrow", scheduled_at: ago(-86400) });
  const done = exam({ id: "EX-DONE", name: "Finished", scheduled_at: ago(86400), duration_minutes: 60 });
  const store: AdminStore = {
    isAdmin: async (id) => id === "admin-1",
    exams: async () => [live, soon, done],
    enrollments: async () => [{ exam_id: "EX-LIVE", student_id: "s1" }, { exam_id: "EX-LIVE", student_id: "s2" }, { exam_id: "EX-SOON", student_id: "s1" }],
    attempts: async () => [
      att({ id: "w1", student_id: "s1", session_seen_at: ago(600), user_agent: "x VignanExam/0.2.32" }),
      att({ id: "d1", exam_id: "EX-DONE", student_id: "s2", state: "submitted", score: null, submitted_at: ago(80000) }),
    ],
    questionCounts: async () => new Map([["EX-SOON", 12]]),
    moodleLinks: async () => [],
    proctorAssignments: async () => [{ exam_id: "EX-LIVE", name: "Proctor P", role: "proctor", email: "p@v" }],
    students: async (ids) => new Map(ids.map((id) => [id, { id, roll: `R-${id}`, full_name: `Name ${id}` }])),
    studentNamesByAuth: async (ids) => new Map(ids.filter((id) => id.startsWith("stu-")).map((id) => [id, `21BQ · ${id}`])),
    studentCounts: async () => ({ total: 25, withoutLogin: 2 }),
    staff: async () => [{ auth_id: "teacher-A", name: "Teacher A", email: "t@v", role: "teacher", admin: false }, { auth_id: "admin-1", name: "Admin", email: "a@v", role: "teacher", admin: true }],
    flags: async () => [{ id: "f1", exam_id: "EX-LIVE", attempt_id: "w1", student_id: "s1", violation_type: "Face not visible", severity: "critical", source: "ai", created_at: ago(300) }],
    reviewedFlags: async () => new Set(),
    gradeTargets: async () => [{ link_id: "L1", student_id: "s2", exam_id: "EX-DONE", lineitem: "https://m/li", last_score: null, last_posted_at: null, last_error: "HTTP 503", pending_score: 7, post_attempts: 12, next_attempt_at: null }],
    pendingMoodleUsers: async () => [],
    holds: async () => [],
    auditLogs: async (f): Promise<AuditRow[]> => (f.action === "results.exported"
      ? [{ id: "x1", actor_id: "teacher-A", actor_role: "teacher", action: "results.exported", target_type: "exam", target_id: "EX-DONE", meta: { format: "csv", rows: 30, exam_ids: ["EX-DONE"] }, created_at: ago(500) }]
      : [{ id: "x2", actor_id: "admin-1", actor_role: "staff", action: "admin.moodle_resend", target_type: "all", target_id: "all", meta: {}, created_at: ago(10) }]),
    systemStatus: async () => STATUS,
    resendGrades: async (examId) => { resends.push(examId); return 3; },
    reviewFlag: async (id) => { reviews.push(id); return id === "00000000-0000-4000-8000-000000000001" ? { exam_id: "EX-LIVE" } : null; },
    writeAudit: async (e) => { audits.push(e); },
    ...over,
  };
  return { store, audits, resends, reviews };
}

const probes: AdminProbes = {
  health: async () => [{ key: "database", label: "Database", ok: true, detail: "ok", ms: 4 }],
  latestRelease: async () => ({ tag: "lockdown-v0.2.60", version: "0.2.60", publishedAt: ago(3600), url: "https://gh/rel" }),
  storageObjects: async () => ({ configured: true, truncated: false, objects: [{ key: "Live-exam/R/screenshots/1.jpg", size: 500, lastModified: ago(60) }] }),
  retentionDays: () => 90,
  backups: async () => ({ available: false, reason: "not_connected" }),
};

const call = async (store: AdminStore, body: unknown, who: string | null = "admin-1") => {
  const handler = createAdminHandler({ store, probes, actor: async () => (who ? { authId: who } : null), now: () => NOW });
  const res = await handler(new Request("https://x/admin-dashboard", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

describe("admin-dashboard endpoint", () => {
  it("is for admins only", async () => {
    const { store } = makeStore();
    expect((await call(store, { op: "overview" }, null)).status).toBe(401);
    expect((await call(store, { op: "overview" }, "teacher-A")).status).toBe(403);
    expect((await call(store, { op: "overview" })).status).toBe(200);
  });

  it("builds the overview from live, upcoming, marking, Moodle and accounts", async () => {
    const { store } = makeStore();
    const { body } = await call(store, { op: "overview" });
    expect(body.live).toHaveLength(1);
    expect(body.live[0].counts).toMatchObject({ enrolled: 2, disconnected: 1, notStarted: 1 });
    expect(body.connections[0]).toMatchObject({ state: "lost", student: { roll: "R-s1" } });
    expect(body.upcoming[0]).toMatchObject({ exam: { id: "EX-SOON", owner: "Teacher A" }, ready: true });
    expect(body.marking).toEqual([expect.objectContaining({ exam: expect.objectContaining({ id: "EX-DONE" }), waiting: 1 })]);
    expect(body.unreleased.map((u: { exam: { id: string } }) => u.exam.id)).toEqual(["EX-DONE"]);
    expect(body.flagsWaiting[0]).toMatchObject({ id: "f1", reviewed: false, student: { roll: "R-s1" } });
    expect(body.moodle.failed[0]).toMatchObject({ state: "gave_up", lastError: "HTTP 503" });
    expect(body.moodle.retryJob.name).toBe("lti-grade-retry");
    expect(body.versions).toMatchObject({ latest: "0.2.60", inUse: [{ version: "0.2.32", outdated: true }] });
    expect(body.erpHistory[0]).toMatchObject({ by: "Teacher A", format: "csv", rows: 30, exams: ["Finished"] });
    expect(body.accounts).toMatchObject({ studentsWithoutLogin: 2, missingAppRole: [{ kind: "student" }] });
    expect(body.proctorAssignments.find((p: { exam: { id: string } }) => p.exam.id === "EX-LIVE").assignees).toHaveLength(1);
  });

  it("reports storage per exam with the retention schedule", async () => {
    const { store } = makeStore();
    const { body } = await call(store, { op: "storage" });
    expect(body.r2).toMatchObject({ configured: true, totalBytes: 500, retentionDays: 90 });
    expect(body.r2.exams[0]).toMatchObject({ folder: "Live-exam", examIds: ["EX-LIVE"] });
    expect(body.buckets[0].bucket).toBe("exam-records");
  });

  it("queues failed Moodle grades for the retry job and logs it", async () => {
    const { store, audits, resends } = makeStore();
    const { body } = await call(store, { op: "resend_moodle", examId: "EX-DONE" });
    expect(body).toEqual({ ok: true, queued: 3 });
    expect(resends).toEqual(["EX-DONE"]);
    expect(audits[0]).toMatchObject({ action: "admin.moodle_resend", targetId: "EX-DONE", meta: { queued: 3 } });
    expect((await call(store, { op: "resend_moodle", examId: "bad id;" })).status).toBe(400);
  });

  it("marks a flag reviewed and logs it", async () => {
    const { store, audits } = makeStore();
    const ok = await call(store, { op: "review_flag", violationId: "00000000-0000-4000-8000-000000000001", note: "Checked the recording" });
    expect(ok.body).toEqual({ ok: true });
    expect(audits[0]).toMatchObject({ action: "admin.flag_reviewed", meta: { exam_id: "EX-LIVE", note: "Checked the recording" } });
    expect((await call(store, { op: "review_flag", violationId: "00000000-0000-4000-8000-000000000002" })).status).toBe(404);
    expect((await call(store, { op: "review_flag", violationId: "nope" })).status).toBe(400);
  });

  it("filters the audit log and names the person", async () => {
    let seen: unknown = null;
    const { store } = makeStore({ auditLogs: async (f) => { seen = f; return [
      { id: "x", actor_id: "admin-1", actor_role: "staff", action: "admin.moodle_resend", target_type: "all", target_id: "all", meta: {}, created_at: ago(1) },
      { id: "y", actor_id: "stu-9", actor_role: "system", action: "attempt.submitted", target_type: "attempt", target_id: "a9", meta: {}, created_at: ago(2) },
    ]; } });
    const { body } = await call(store, { op: "audit", actorId: "00000000-0000-4000-8000-0000000000aa", examId: "EX-DONE", action: "result" });
    expect(seen).toEqual({ actorId: "00000000-0000-4000-8000-0000000000aa", examId: "EX-DONE", action: "result", limit: 200 });
    expect(body.entries.map((e: { actor_name: string }) => e.actor_name)).toEqual(["Admin", "21BQ · stu-9"]);
    expect((await call(store, { op: "audit", examId: "x),or(1.eq.1" })).status).toBe(400);
  });

  it("does not record an action whose change failed", async () => {
    const { store, audits } = makeStore({ resendGrades: async () => { throw new Error("db down"); } });
    expect((await call(store, { op: "resend_moodle" })).status).toBe(500);
    expect(audits).toHaveLength(0);
  });
});
