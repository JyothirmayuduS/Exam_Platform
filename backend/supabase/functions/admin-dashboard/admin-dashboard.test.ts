// @vitest-environment node
// Admin console: connection state, live counts, readiness, exam browser
// versions, Moodle grade posts, storage per exam, flags, and who may call it.
import { describe, expect, it } from "vitest";
import { createAdminHandler, RECOUNT_PAGES, type AdminProbes, type AdminStore, type AuditRow, type SystemStatus } from "../_shared/admin/handler.ts";
import {
  compareVersions, connectionOf, countObjects, flagsAwaitingReview, gradePostState, kioskUploads, kioskVersion, liveCounts, readiness, releaseVersion,
  storageFromCounts, unreleased, versionsInUse, type AdminAttempt, type AdminExam, type Flag, type FolderUsage, type GradeTarget, type SittingFiles,
  type StorageObject,
} from "../_shared/admin/model.ts";
import { listQuery, parseListPage } from "../_shared/admin/r2List.ts";
import type { RetentionDeps } from "../_shared/admin/handler.ts";
import type { EvidenceStore } from "../_shared/retention/job.ts";
import type { LegalHold, RetentionAdminDb, RunRow } from "../_shared/retention/supabaseDb.ts";

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

const usageRow = (folder: string, over: Partial<FolderUsage> = {}): FolderUsage => ({
  folder, bytes: 0, objects: 0, oldest: null, due_soon_bytes: 0, due_soon_objects: 0, next_deletion: null,
  counted_at: ago(600), scan_started_at: null, ...over,
});

describe("counting one exam folder", () => {
  it("adds up bytes and objects and what each student folder holds", () => {
    const c = countObjects([
      { key: "Test-3/21BQ1/screenshots/1.jpg", size: 100, lastModified: ago(86400 * 10) },
      { key: "Test-3/21BQ1/recordings/parts/1.webm", size: 900, lastModified: ago(86400 * 9) },
      { key: "Test-3/21BQ2/report/r.pdf", size: 400, lastModified: ago(86400 * 2) },
      { key: "Test-3/stray.txt", size: 5, lastModified: ago(60) },
    ], 90, NOW);
    expect(c).toMatchObject({ bytes: 1405, objects: 4, oldest: ago(86400 * 10) });
    expect(c.sittings).toEqual([
      { student_folder: "21BQ1", kinds: ["recordings", "screenshots"], files: 2, last_upload: ago(86400 * 9) },
      { student_folder: "21BQ2", kinds: ["report"], files: 1, last_upload: ago(86400 * 2) },
    ]);
  });

  it("counts what the retention rule deletes within a week", () => {
    const c = countObjects([
      { key: "Test-3/a/x/1", size: 10, lastModified: ago(86400 * 85) },
      { key: "Test-3/a/x/2", size: 20, lastModified: ago(86400 * 80) },
    ], 90, NOW);
    expect(c).toMatchObject({ due_soon_objects: 1, due_soon_bytes: 10, next_deletion: new Date(NOW + 5 * 86400_000).toISOString() });
  });
});

describe("storage per exam from stored counts", () => {
  const exams = [{ id: "EXAM-2026-AAA", name: "Test 3" }, { id: "EXAM-2026-BBB", name: "DS Mid (Sem 3)" }];
  it("names folders by exam (kiosk by name, phone by id) and totals only what was counted", () => {
    const s = storageFromCounts(["Test-3", "EXAM-2026-AAA", "DS-Mid-Sem-3", "Old-Exam"], [
      usageRow("Test-3", { bytes: 100, objects: 1 }),
      usageRow("EXAM-2026-AAA", { bytes: 50, objects: 1 }),
      usageRow("Old-Exam", { bytes: 1000, objects: 1, due_soon_bytes: 1000, due_soon_objects: 1, counted_at: ago(86400) }),
      usageRow("Deleted-Exam", { bytes: 9999, objects: 9 }),
      usageRow("DS-Mid-Sem-3", { counted_at: null, scan_started_at: ago(5) }),
    ], exams);
    expect(s).toMatchObject({ totalBytes: 1150, totalObjects: 3, dueSoonBytes: 1000, folders: 4, countedFolders: 3, uncounted: ["DS-Mid-Sem-3"], oldestCount: ago(86400) });
    const byFolder = Object.fromEntries(s.exams.map((g) => [g.folder, g]));
    expect(byFolder["Test-3"].examIds).toEqual(["EXAM-2026-AAA"]);
    expect(byFolder["EXAM-2026-AAA"].examIds).toEqual(["EXAM-2026-AAA"]);
    expect(byFolder["DS-Mid-Sem-3"]).toMatchObject({ examName: "DS Mid (Sem 3)", countedAt: null, bytes: 0 });
    expect(byFolder["Old-Exam"].examIds).toEqual([]);
    expect(s.exams[0].folder).toBe("Old-Exam");
  });
});

describe("R2 listing pages", () => {
  it("reads objects, folders and the next page token, unescaping XML", () => {
    const page = parseListPage(`<ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>A&amp;B/r1/report/x.pdf</Key><Size>12</Size><LastModified>2026-10-01T00:00:00.000Z</LastModified></Contents>
      <CommonPrefixes><Prefix>Test-3/</Prefix></CommonPrefixes><NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`);
    expect(page).toEqual({ objects: [{ key: "A&B/r1/report/x.pdf", size: 12, lastModified: "2026-10-01T00:00:00.000Z" }], prefixes: ["Test-3/"], next: "tok&1" });
    expect(parseListPage("<IsTruncated>false</IsTruncated>").next).toBeNull();
  });

  it("lists one exam folder by prefix, never the whole bucket", () => {
    expect(new URLSearchParams(listQuery({ prefix: "Test 3/", token: "t" })).get("prefix")).toBe("Test 3/");
    expect(new URLSearchParams(listQuery({ delimiter: "/" })).get("delimiter")).toBe("/");
  });
});

describe("kiosk uploads", () => {
  const exams = [{ id: "EXAM-2026-AAA", name: "Test 3" }];
  const kiosk = "Mozilla VignanExam/0.2.60";
  const sub = (id: string, student: string, submittedSecondsAgo: number, ua: string | null = kiosk) =>
    att({ id, exam_id: "EXAM-2026-AAA", student_id: student, state: "submitted", submitted_at: ago(submittedSecondsAgo), user_agent: ua });
  const rolls = new Map([["s1", "21BQ1"], ["s2", "21BQ2"], ["s3", "21BQ3"], ["s4", "21BQ4"]]);
  const index = (folder: string, objects: StorageObject[]) => countObjects(objects, 90, NOW).sittings.map((s) => [`${folder}/${s.student_folder}`, s] as const);
  const objects = new Map([
    ...index("Test-3", [
      { key: "Test-3/21BQ1/recordings/parts/1.webm", size: 10, lastModified: ago(3000) },
      { key: "Test-3/21BQ1/screenshots/1.jpg", size: 10, lastModified: ago(3000) },
      { key: "Test-3/21BQ2/screenshots/1.jpg", size: 10, lastModified: ago(3000) },
    ]),
    ...index("EXAM-2026-AAA", [{ key: "EXAM-2026-AAA/s4/recordings/a.webm", size: 10, lastModified: ago(100) }]),
  ]);

  it("marks a sitting complete once a recording arrives, partial or missing otherwise", () => {
    const out = kioskUploads([sub("a1", "s1", 3600), sub("a2", "s2", 3600), sub("a3", "s3", 3600), sub("a4", "s4", 3600)], exams, rolls, objects, NOW);
    const by = Object.fromEntries(out.map((u) => [u.attempt.id, u]));
    expect(by.a1).toMatchObject({ state: "complete", kinds: ["recordings", "screenshots"], files: 2 });
    expect(by.a2).toMatchObject({ state: "partial", kinds: ["screenshots"] });
    expect(by.a3).toMatchObject({ state: "missing", files: 0, lastUpload: null });
    expect(by.a4.state).toBe("complete");
  });

  it("gives a fresh submission time to finish uploading, and skips browser and unknown sittings", () => {
    const out = kioskUploads([sub("a3", "s3", 600), sub("w", "s3", 3600, "x VignanExam/web"), sub("o", "s3", 3600, null), att({ id: "live", user_agent: kiosk })], exams, rolls, objects, NOW);
    expect(out.map((u) => [u.attempt.id, u.state])).toEqual([["a3", "uploading"]]);
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

type Scan = { id: string; bytes: number; objects: number; sittings: Map<string, SittingFiles> };

function makeStore(over: Partial<AdminStore> = {}) {
  const audits: { action: string; targetId: string; meta: Record<string, unknown> }[] = [];
  const resends: (string | null)[] = [];
  const reviews: string[] = [];
  const photoResets: string[] = [];
  // evidence_usage / evidence_sittings, as the SQL functions keep them
  const usage = new Map<string, FolderUsage>();
  const sittings = new Map<string, SittingFiles & { folder: string }>();
  const scans = new Map<string, Scan>();
  const live = exam({ id: "EX-LIVE", name: "Live exam", scheduled_at: ago(1800), duration_minutes: 120 });
  const soon = exam({ id: "EX-SOON", name: "Tomorrow", scheduled_at: ago(-86400) });
  const done = exam({ id: "EX-DONE", name: "Finished", scheduled_at: ago(86400), duration_minutes: 60 });
  const store: AdminStore = {
    isAdmin: async (id) => id === "admin-1",
    retentionDays: async () => 1825,
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
    flags: async (since, severities) => ([
      { id: "f1", exam_id: "EX-LIVE", attempt_id: "w1", student_id: "s1", violation_type: "Face not visible", severity: "critical", source: "ai", created_at: ago(300) },
      { id: "f2", exam_id: "EX-LIVE", attempt_id: "w1", student_id: "s1", violation_type: "Tab switch", severity: "warning", source: "system", created_at: ago(200) },
      { id: "f3", exam_id: "EX-DONE", attempt_id: "d1", student_id: "s2", violation_type: "Phone", severity: "high", source: "ai", created_at: ago(86400 * 3) },
    ] as Flag[]).filter((f) => f.created_at >= since && (!severities || severities.includes(f.severity))),
    reviewedFlags: async () => new Set(),
    gradeTargets: async () => [{ link_id: "L1", student_id: "s2", exam_id: "EX-DONE", lineitem: "https://m/li", last_score: null, last_posted_at: null, last_error: "HTTP 503", pending_score: 7, post_attempts: 12, next_attempt_at: null }],
    pendingMoodleUsers: async () => [],
    holds: async () => [],
    phoneUploads: async () => ({
      pending: [
        { id: "m1", exam_id: "EX-DONE", student_id: "s2", question_id: "Q-1", question_index: 2, status: "WAITING", created_at: ago(7200), expires_at: ago(6000) },
        { id: "m2", exam_id: "EX-LIVE", student_id: "s1", question_id: "Q-7582", question_index: null, status: "WAITING", created_at: ago(60), expires_at: ago(-540) },
      ],
      completed: 4,
    }),
    auditLogs: async (f): Promise<AuditRow[]> => (f.action === "results.exported"
      ? [{ id: "x1", actor_id: "teacher-A", actor_role: "teacher", action: "results.exported", target_type: "exam", target_id: "EX-DONE", meta: { format: "csv", rows: 30, exam_ids: ["EX-DONE"] }, created_at: ago(500) }]
      : [{ id: "x2", actor_id: "admin-1", actor_role: "staff", action: "admin.moodle_resend", target_type: "all", target_id: "all", meta: {}, created_at: ago(10) }]),
    systemStatus: async () => STATUS,
    resendGrades: async (examId) => { resends.push(examId); return 3; },
    reviewFlag: async (id) => { reviews.push(id); return id === "00000000-0000-4000-8000-000000000001" ? { exam_id: "EX-LIVE" } : null; },
    writeAudit: async (e) => { audits.push(e); },
    allStudents: async () => [{ id: "s2", roll: "21BQ2", full_name: "B" }, { id: "s1", roll: "21BQ1", full_name: "A" }, { id: "s3", roll: "21BQ3", full_name: "C" }],
    registrationPhotos: async () => [{ student_id: "s3", storage_path: "s3/p.jpg", captured_at: ago(100) }],
    photoUrls: async (paths) => new Map(paths.map((p) => [p, `https://signed/${p}`])),
    resetPhoto: async (id) => { photoResets.push(id); return id === "00000000-0000-4000-8000-000000000003"; },
    evidenceUsage: async () => [...usage.values()],
    evidenceSittings: async (folders) => [...sittings.values()].filter((s) => folders.includes(s.folder)),
    scanBegin: async (folder, id) => {
      usage.set(folder, usage.get(folder) ?? usageRow(folder, { counted_at: null }));
      scans.set(folder, { id, bytes: 0, objects: 0, sittings: new Map() });
    },
    scanAdd: async (folder, id, part, done) => {
      const scan = scans.get(folder);
      if (scan?.id !== id) return false;
      scan.bytes += part.bytes;
      scan.objects += part.objects;
      for (const s of part.sittings) {
        const prev = scan.sittings.get(s.student_folder);
        scan.sittings.set(s.student_folder, prev
          ? { ...prev, kinds: [...new Set([...prev.kinds, ...s.kinds])].sort(), files: prev.files + s.files }
          : s);
      }
      if (done) {
        usage.set(folder, usageRow(folder, { bytes: scan.bytes, objects: scan.objects, counted_at: new Date(NOW).toISOString() }));
        for (const [k, s] of sittings) if (s.folder === folder) sittings.delete(k);
        for (const s of scan.sittings.values()) sittings.set(`${folder}/${s.student_folder}`, { ...s, folder });
        scans.delete(folder);
      }
      return true;
    },
    ...over,
  };
  return { store, audits, resends, reviews, photoResets, usage, sittings, scans };
}

/** R2 holding `objects`; listFolder serves 1,000-key pages and records every prefix asked for. */
function makeProbes(objects: StorageObject[] = [{ key: "Live-exam/R-s1/screenshots/1.jpg", size: 500, lastModified: ago(60) }], over: Partial<AdminProbes> = {}) {
  const listed: { folder: string; pages: number }[] = [];
  const probes: AdminProbes = {
    health: async () => [{ key: "database", label: "Database", ok: true, detail: "ok", ms: 4 }],
    latestRelease: async () => ({ tag: "lockdown-v0.2.60", version: "0.2.60", publishedAt: ago(3600), url: "https://gh/rel" }),
    storageConfigured: () => true,
    storageFolders: async () => ({ configured: true, folders: [...new Set(objects.map((o) => o.key.split("/")[0]))].sort() }),
    listFolder: async (folder, token, maxPages) => {
      const mine = objects.filter((o) => o.key.startsWith(`${folder}/`));
      let from = token ? Number(token) : 0;
      const out: StorageObject[] = [];
      let pages = 0;
      while (pages < maxPages && from < mine.length) {
        out.push(...mine.slice(from, from + 1000));
        from += 1000;
        pages += 1;
      }
      listed.push({ folder, pages });
      return { objects: out, next: from < mine.length ? String(from) : null };
    },
    ...over,
  };
  return { probes, listed };
}
const { probes } = makeProbes();

const call = async (store: AdminStore, body: unknown, who: string | null = "admin-1", withProbes: AdminProbes = probes) => {
  const handler = createAdminHandler({ store, probes: withProbes, actor: async () => (who ? { authId: who } : null), now: () => NOW });
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

  it("waits on serious flags from the last 30 days and lists the last day's warnings", async () => {
    const { store } = makeStore();
    const { body } = await call(store, { op: "overview" });
    expect(body.flagsWaiting.map((f: Flag) => f.id)).toEqual(["f1", "f3"]);
    expect(body.recentFlags.map((f: Flag) => f.id)).toEqual(["f2", "f1"]);
  });

  it("reports storage per exam from the stored counts and says which folders are not counted", async () => {
    const { store, usage } = makeStore();
    usage.set("Live-exam", usageRow("Live-exam", { bytes: 500, objects: 1 }));
    const { probes } = makeProbes([
      { key: "Live-exam/R-s1/screenshots/1.jpg", size: 500, lastModified: ago(60) },
      { key: "Finished/R-s2/report/r.pdf", size: 70, lastModified: ago(60) },
    ]);
    const { body } = await call(store, { op: "storage" }, "admin-1", probes);
    expect(body.r2).toMatchObject({ configured: true, totalBytes: 500, totalObjects: 1, retentionDays: 1825, folders: 2, countedFolders: 1, uncounted: ["Finished"] });
    expect(body.r2.exams.find((e: { folder: string }) => e.folder === "Live-exam")).toMatchObject({ examIds: ["EX-LIVE"], countedAt: ago(600) });
    expect(body.buckets[0].bucket).toBe("exam-records");
  });

  it("counts a folder of 25,500 files in batches, listing only that folder, with nothing cut off", async () => {
    const big: StorageObject[] = Array.from({ length: 25_500 }, (_, i) => ({ key: `Live-exam/R-s${i % 600}/screenshots/${i}.jpg`, size: 2, lastModified: ago(3600) }));
    const { store } = makeStore();
    const { probes, listed } = makeProbes([...big, { key: "Other/R-x/report/r.pdf", size: 9, lastModified: ago(60) }]);
    let res = await call(store, { op: "recount_storage", folder: "Live-exam" }, "admin-1", probes);
    let calls = 1;
    while (!res.body.done) {
      expect(res.status).toBe(200);
      res = await call(store, { op: "recount_storage", folder: "Live-exam", scanId: res.body.scanId, token: res.body.token }, "admin-1", probes);
      calls += 1;
    }
    expect(calls).toBe(Math.ceil(25_500 / (1000 * RECOUNT_PAGES)));
    expect(listed.every((l) => l.folder === "Live-exam" && l.pages <= RECOUNT_PAGES)).toBe(true);
    const { body } = await call(store, { op: "storage" }, "admin-1", probes);
    expect(body.r2.exams.find((e: { folder: string }) => e.folder === "Live-exam")).toMatchObject({ objects: 25_500, bytes: 51_000 });
    expect(body.r2.uncounted).toEqual(["Other"]);
  });

  it("stops a count that a newer one replaced, and rejects bad folders", async () => {
    const { store } = makeStore();
    const { probes } = makeProbes(Array.from({ length: 12_000 }, (_, i) => ({ key: `Live-exam/R/x/${i}`, size: 1, lastModified: ago(60) })));
    const first = await call(store, { op: "recount_storage", folder: "Live-exam" }, "admin-1", probes);
    await call(store, { op: "recount_storage", folder: "Live-exam" }, "admin-1", probes);
    const stale = await call(store, { op: "recount_storage", folder: "Live-exam", scanId: first.body.scanId, token: first.body.token }, "admin-1", probes);
    expect(stale).toMatchObject({ status: 409, body: { error: "count_superseded" } });
    expect((await call(store, { op: "recount_storage", folder: "a/b" })).status).toBe(400);
    expect((await call(store, { op: "recount_storage", folder: "x", token: "t" })).status).toBe(400);
    expect((await call(store, { op: "recount_storage", folder: "x" }, "teacher-A")).status).toBe(403);
  });

  const kioskAttempts = async () => [
    att({ id: "k1", exam_id: "EX-LIVE", student_id: "s1", state: "submitted", submitted_at: ago(3600), user_agent: "VignanExam/0.2.60" }),
    att({ id: "k2", exam_id: "EX-LIVE", student_id: "s2", state: "submitted", submitted_at: ago(7200), user_agent: "VignanExam/0.2.60" }),
    att({ id: "old", exam_id: "EX-LIVE", student_id: "s2", state: "submitted", started_at: ago(86400 * 40), submitted_at: ago(86400 * 40), user_agent: "VignanExam/0.2.60" }),
  ];

  it("lists exams with kiosk sittings, and checks one exam against its counted files", async () => {
    const { store, usage, sittings } = makeStore({ attempts: kioskAttempts });
    usage.set("Live-exam", usageRow("Live-exam", { bytes: 500, objects: 1 }));
    sittings.set("Live-exam/R-s1", { folder: "Live-exam", student_folder: "R-s1", kinds: ["screenshots"], files: 1, last_upload: ago(3000) });

    const list = await call(store, { op: "uploads" });
    expect(list.body.kiosk.exams).toEqual([expect.objectContaining({ exam: expect.objectContaining({ id: "EX-LIVE" }), sittings: 2, countedAt: ago(600) })]);
    expect(list.body.kiosk.detail).toBeNull();

    const { body } = await call(store, { op: "uploads", examId: "EX-LIVE" });
    expect(body.kiosk.detail).toMatchObject({ countedAt: ago(600), sittings: 2, checked: 2, complete: 0, partial: 1, missing: 1 });
    expect(body.kiosk.detail.items.map((i: { attemptId: string; state: string }) => [i.attemptId, i.state])).toEqual([["k1", "partial"], ["k2", "missing"]]);
    expect(body.kiosk.detail.items[0]).toMatchObject({ student: { roll: "R-s1" }, exam: { name: "Live exam", owner: "Teacher A" }, kinds: ["screenshots"] });
    expect(body.phone).toMatchObject({ completed: 4, open: 1, abandoned: 1 });
    expect(body.phone.items[0]).toMatchObject({ id: "m1", open: false, question: "Q3", student: { roll: "R-s2" }, exam: { id: "EX-DONE" } });
    expect(body.phone.items[1]).toMatchObject({ id: "m2", open: true, question: "Q-7582" });
  });

  it("says when an exam's files have not been counted yet instead of calling sittings missing", async () => {
    const { store } = makeStore({ attempts: kioskAttempts });
    const { body } = await call(store, { op: "uploads", examId: "EX-LIVE" });
    expect(body.kiosk.detail).toMatchObject({ countedAt: null, sittings: 2, checked: 0, items: [] });
    expect(body.kiosk.detail.folders).toEqual([{ folder: "Live-exam", countedAt: null }, { folder: "EX-LIVE", countedAt: null }]);
    expect((await call(store, { op: "uploads", examId: "x),or(" })).status).toBe(400);
  });

  it("reads backup status from backup_runs and works without pg_cron", async () => {
    const run = { id: 7, status: "succeeded" as const, kind: "database", started_at: ago(7200), finished_at: ago(7000), location: "s3://bk/x", size_bytes: 1234, message: null };
    const { store } = makeStore({ systemStatus: async () => ({ ...STATUS, jobs: [], cron_installed: false, backups: { latest: run, last_success: run, failures_7d: 0 } }) });
    const { body } = await call(store, { op: "system" });
    expect(body).toMatchObject({ cronInstalled: false, jobs: [], backups: { latest: { id: 7, status: "succeeded" }, failures_7d: 0 } });
    const none = await call(makeStore().store, { op: "system" });
    expect(none.body.backups).toEqual({ latest: null, last_success: null, failures_7d: 0 });
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

  it("lists students without a registration photo, by roll", async () => {
    const { store } = makeStore();
    const { body } = await call(store, { op: "overview" });
    expect(body.accounts.photos).toEqual({ taken: 1, missingTotal: 2, missing: [{ id: "s1", roll: "21BQ1", full_name: "A" }, { id: "s2", roll: "21BQ2", full_name: "B" }] });
  });

  it("lists taken photos with view links", async () => {
    const { store } = makeStore();
    const { body } = await call(store, { op: "photos" });
    expect(body.photos).toEqual([{ student: { id: "s3", roll: "R-s3", full_name: "Name s3" }, capturedAt: ago(100), url: "https://signed/s3/p.jpg" }]);
  });

  it("clears a registration photo for a retake and logs it", async () => {
    const { store, audits, photoResets } = makeStore();
    expect((await call(store, { op: "reset_photo", studentId: "00000000-0000-4000-8000-000000000003" })).body).toEqual({ ok: true });
    expect(audits[0]).toMatchObject({ action: "admin.photo_reset", targetId: "00000000-0000-4000-8000-000000000003" });
    expect((await call(store, { op: "reset_photo", studentId: "00000000-0000-4000-8000-000000000004" })).status).toBe(404);
    expect((await call(store, { op: "reset_photo", studentId: "s1" })).status).toBe(400);
    expect(photoResets).toEqual(["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"]);
    expect((await call(store, { op: "reset_photo", studentId: "00000000-0000-4000-8000-000000000003" }, "teacher-A")).status).toBe(403);
    expect(audits).toHaveLength(1);
  });

  it("does not record an action whose change failed", async () => {
    const { store, audits } = makeStore({ resendGrades: async () => { throw new Error("db down"); } });
    expect((await call(store, { op: "resend_moodle" })).status).toBe(500);
    expect(audits).toHaveLength(0);
  });
});

/** retention_settings, legal_holds and retention_runs in memory; one old evidence file in R2. */
function makeRetention(opts: { lifecycleDays?: number | null } = {}) {
  const state = { days: 1825, cursor: null as string | null };
  const runs: RunRow[] = [];
  const holds: (LegalHold & { lifted: boolean })[] = [];
  const calls = { setDays: [] as number[], holds: [] as unknown[], batches: [] as { kind: string; dry: boolean }[] };
  const files = new Map([["Finished/R-s2/screenshots/1.jpg", new Date(NOW - 2000 * 86_400_000).toISOString()]]);
  const store: EvidenceStore = {
    name: "r2",
    folders: async (prefix) => ({ items: prefix ? ["R-s2"] : files.size ? ["Finished"] : [], next: null }),
    objects: async () => ({ items: [...files].map(([key, uploadedAt]) => ({ key, uploadedAt })), next: null }),
    remove: async (keys) => { for (const k of keys) files.delete(k); return { failed: [] }; },
  };
  const db: RetentionAdminDb = {
    retentionDays: async () => state.days,
    cursor: async () => state.cursor,
    setCursor: async (c) => { state.cursor = c; },
    folderStatus: async (_f, students) => new Map(students.map((s) => [s, null])),
    dbBatch: async (kind, _c, _l, dry) => { calls.batches.push({ kind, dry }); return { due: kind === "attempts" ? 2 : 0, skipped: 1, deleted: dry ? 0 : kind === "attempts" ? 2 : 0, more: false }; },
    startRun: async (r) => {
      runs.unshift({ ...r, id: runs.length + 1, started_at: new Date(NOW).toISOString(), finished_at: null, status: "running", complete: false, deleted: 0, skipped: 0, failed: 0, due_week: null, detail: null });
      return runs.length;
    },
    finishRun: async (id, patch) => { Object.assign(runs.find((r) => r.id === id)!, patch); },
    settings: async () => ({ retention_days: state.days, updated_at: null, updated_by: "admin-1" }),
    setRetentionDays: async (days) => { calls.setDays.push(days); state.days = days; },
    setLegalHold: async (type, target, on, reason, actor) => {
      calls.holds.push({ type, target, on, reason, actor });
      if (target === "EX-NOPE") throw Object.assign(new Error("target_not_found"), { code: "P0002" });
      const open = holds.find((h) => h.target_type === type && h.target_id === target && !h.lifted);
      if (on && !open) holds.push({ id: `h${holds.length + 1}`, target_type: type, target_id: target, reason, placed_by: actor, placed_at: new Date(NOW).toISOString(), lifted: false });
      if (!on && open) open.lifted = true;
      return on ? !open : !!open;
    },
    legalHolds: async () => holds.filter((h) => !h.lifted).map(({ lifted: _l, ...h }) => h),
    runs: async (limit) => runs.slice(0, limit),
    run: async (id) => runs.find((r) => r.id === id) ?? null,
  };
  const days = opts.lifecycleDays === undefined ? 90 : opts.lifecycleDays;
  const retention: RetentionDeps = {
    db, stores: () => [store],
    lifecycle: async () => ({ configured: true, error: null, rules: days === null ? [] : [{ id: "exam-artifacts-retention", enabled: true, prefix: "", days }] }),
  };
  return { retention, state, runs, holds, calls, files };
}

const callR = async (store: AdminStore, retention: RetentionDeps, body: unknown, who: string | null = "admin-1", now = NOW) => {
  const handler = createAdminHandler({ store, probes, actor: async () => (who ? { authId: who } : null), now: () => now, retention });
  const res = await handler(new Request("https://x/admin-dashboard", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

describe("admin-dashboard retention", () => {
  it("only admins can see retention, change the period, hold, or run the job", async () => {
    const { store, audits } = makeStore();
    const r = makeRetention();
    for (const body of [
      { op: "retention" }, { op: "set_retention", days: 400 }, { op: "legal_hold", targetType: "exam", targetId: "EX-DONE", on: true, reason: "x" },
      { op: "retention_run", dryRun: true }, { op: "retention_run", dryRun: false, confirmRunId: 1 },
    ]) {
      expect((await callR(store, r.retention, body, "teacher-A")).status).toBe(403);
      expect((await callR(store, r.retention, body, null)).status).toBe(401);
    }
    expect(r.calls).toEqual({ setDays: [], holds: [], batches: [] });
    expect(r.runs).toEqual([]);
    expect(r.files.size).toBe(1);
    expect(audits).toEqual([]);
  });

  it("shows the period, what is due this week, runs, holds and an R2 rule that would delete first", async () => {
    const S3 = "00000000-0000-4000-8000-000000000003";
    const { store } = makeStore({ allStudents: async () => [{ id: S3, roll: "21BQ3", full_name: "C" }] });
    const r = makeRetention();
    await callR(store, r.retention, { op: "legal_hold", targetType: "exam", targetId: "EX-DONE", on: true, reason: "Court order" });
    await callR(store, r.retention, { op: "legal_hold", targetType: "student", roll: "21bq3", on: true, reason: "Inquiry" });
    await callR(store, r.retention, { op: "retention_run", dryRun: true });
    const { status, body } = await callR(store, r.retention, { op: "retention" });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      days: 1825, min: 30, max: 3650, updatedBy: "Admin",
      dueWeek: { database: { violation_events: 0, attempts: 2, audit_logs: 0 }, files: 1, filesRunId: 1 },
      lifecycle: { configured: true, conflicts: [{ id: "exam-artifacts-retention", days: 90 }] },
    });
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ id: 1, dryRun: true, trigger: "admin", by: "Admin", status: "succeeded", deleted: 3, skipped: 3 });
    expect(body.holds.map((h: { targetType: string; exam: { name: string } | null; student: { roll: string } | null; reason: string }) =>
      [h.targetType, h.exam?.name ?? h.student?.roll, h.reason])).toEqual([["exam", "Finished", "Court order"], ["student", `R-${S3}`, "Inquiry"]]);
    expect((await callR(store, makeRetention({ lifecycleDays: null }).retention, { op: "retention" })).body.lifecycle.conflicts).toEqual([]);
    expect((await callR(store, makeRetention({ lifecycleDays: 2000 }).retention, { op: "retention" })).body.lifecycle.conflicts).toEqual([]);
  });

  it("changes the period only within 30 to 3650 whole days", async () => {
    const { store } = makeStore();
    const r = makeRetention();
    for (const days of [29, 3651, 365.5, "x", null]) {
      expect((await callR(store, r.retention, { op: "set_retention", days })).body).toMatchObject({ error: "bad_retention_days" });
    }
    expect((await callR(store, r.retention, { op: "set_retention", days: 2555 })).body).toEqual({ ok: true, days: 2555 });
    expect(r.calls.setDays).toEqual([2555]);
  });

  it("places and lifts legal holds, with a reason to place one", async () => {
    const { store } = makeStore();
    const r = makeRetention();
    expect((await callR(store, r.retention, { op: "legal_hold", targetType: "exam", targetId: "EX-DONE", on: true })).body.error).toBe("reason_required");
    expect((await callR(store, r.retention, { op: "legal_hold", targetType: "course", targetId: "EX-DONE", on: true, reason: "x" })).status).toBe(400);
    expect((await callR(store, r.retention, { op: "legal_hold", targetType: "student", targetId: "21BQ1", on: true, reason: "x" })).status).toBe(400);
    expect((await callR(store, r.retention, { op: "legal_hold", targetType: "student", roll: "NOBODY", on: true, reason: "x" })).status).toBe(404);
    expect((await callR(store, r.retention, { op: "legal_hold", targetType: "exam", targetId: "EX-NOPE", on: true, reason: "x" })).status).toBe(404);
    expect((await callR(store, r.retention, { op: "legal_hold", targetType: "exam", targetId: "EX-DONE", on: true, reason: "x" })).body).toEqual({ ok: true, changed: true });
    expect((await callR(store, r.retention, { op: "legal_hold", targetType: "exam", targetId: "EX-DONE", on: false })).body).toEqual({ ok: true, changed: true });
    expect((await callR(store, r.retention, { op: "legal_hold", targetType: "exam", targetId: "EX-DONE", on: false })).body).toEqual({ ok: true, changed: false });
    expect(r.calls.holds.at(-1)).toEqual({ type: "exam", target: "EX-DONE", on: false, reason: null, actor: "admin-1" });
  });

  it("a dry run deletes nothing; a real run needs the caller's own recent dry run, and is audited", async () => {
    const { store, audits } = makeStore({ isAdmin: async (id) => id === "admin-1" || id === "admin-2" });
    const r = makeRetention();
    expect((await callR(store, r.retention, { op: "retention_run", dryRun: false })).body.error).toBe("dry_run_required");

    const dry = await callR(store, r.retention, { op: "retention_run", dryRun: true });
    expect(dry.body.run).toMatchObject({ id: 1, dryRun: true, status: "succeeded", deleted: 3, skipped: 3 });
    expect(r.files.size).toBe(1);
    expect(r.calls.batches.every((b) => b.dry)).toBe(true);
    expect(audits).toEqual([]);

    expect((await callR(store, r.retention, { op: "retention_run", dryRun: false, confirmRunId: 1 }, "admin-2")).body.error).toBe("dry_run_required");
    expect((await callR(store, r.retention, { op: "retention_run", dryRun: false, confirmRunId: 1 }, "admin-1", NOW + 31 * 60_000)).body.error).toBe("dry_run_required");
    r.state.days = 2000;
    expect((await callR(store, r.retention, { op: "retention_run", dryRun: false, confirmRunId: 1 })).body.error).toBe("dry_run_required");
    r.state.days = 1825;
    expect(r.files.size).toBe(1);

    const real = await callR(store, r.retention, { op: "retention_run", dryRun: false, confirmRunId: 1 });
    expect(real.body.run).toMatchObject({ id: 2, dryRun: false, status: "succeeded", deleted: 3 });
    expect(r.files.size).toBe(0);
    expect(audits).toEqual([{ actorId: "admin-1", action: "admin.retention_run", targetType: "retention", targetId: "2",
      meta: { confirmed_dry_run: 1, status: "succeeded", complete: true, deleted: 3, skipped: 3, failed: 0 } }]);
    expect((await callR(store, r.retention, { op: "retention_run", dryRun: false, confirmRunId: 2 })).body.error).toBe("dry_run_required");
  });

  it("does not start a run while another is running", async () => {
    const { store } = makeStore();
    const r = makeRetention();
    await r.retention.db.startRun({ dry_run: false, trigger: "schedule", requested_by: null, retention_days: 1825, cutoff: "" });
    expect((await callR(store, r.retention, { op: "retention_run", dryRun: true })).body.error).toBe("run_in_progress");
    expect((await callR(store, r.retention, { op: "retention" }, "admin-1", NOW + 20 * 60_000)).body.runs[0].status).toBe("interrupted");
    expect((await callR(store, r.retention, { op: "retention_run", dryRun: true }, "admin-1", NOW + 20 * 60_000)).status).toBe(200);
  });
});
