// Admin console API. Admins only (a teacher listed in staff_admins).
//
// POST { op: "overview" }                       live, upcoming, marking, Moodle, accounts…
// POST { op: "system" }                         health checks, latest exam browser, jobs, backups
// POST { op: "storage" }                        storage per exam folder from stored counts, buckets
// POST { op: "recount_storage", folder, scanId?, token? }
//                                               count one exam folder in R2, a few pages per call;
//                                               repeat with the returned scanId and token until done
// POST { op: "uploads", examId? }               kiosk sittings missing evidence for one exam, unfinished phone uploads
// POST { op: "audit", actorId?, examId?, action?, limit? }
// POST { op: "resend_moodle", examId? }         queue failed Moodle grades for the next retry run
// POST { op: "review_flag", violationId, note? }
// POST { op: "photos" }                         registration photos taken, with short-lived view links
// POST { op: "reset_photo", studentId }         clear a registration photo so the student retakes it
// POST { op: "retention" }                      retention period, due this week (holds excluded), runs, legal holds
// POST { op: "set_retention", days }            change the site retention period (audited in SQL)
// POST { op: "legal_hold", targetType: "exam"|"student", targetId? | roll?, on, reason? }
//                                               place or lift a legal hold (audited in SQL); a roll
//                                               shared by several students returns them to choose from
// POST { op: "retention_run", dryRun: true }    count what would be deleted now
// POST { op: "retention_run", dryRun: false, confirmRunId }
//                                               delete, confirming the caller's own dry run from the last 30 minutes
import { conflictingRules, type Lifecycle } from "../retention/stores.ts";
import { DB_KINDS, MAX_DAYS, MIN_DAYS, runRetention, type EvidenceStore } from "../retention/job.ts";
import type { RetentionAdminDb, RunRow } from "../retention/supabaseDb.ts";
import {
  connectionOf, countObjects, examFolders, flagsAwaitingReview, gradePostState, isKioskSitting, kioskUploads, liveCounts, phaseOf, readiness,
  storageFromCounts, unreleased, versionsInUse,
  type AdminAttempt, type AdminExam, type Flag, type FolderCount, type FolderUsage, type GradeTarget, type SittingFiles, type StorageObject,
} from "./model.ts";
import { releaseTiming, type ReleaseSettings } from "../exam/release.ts";

export type Actor = { authId: string };
export type StudentRef = { id: string; roll: string; full_name: string | null };
export type StaffRef = { auth_id: string; name: string; email: string | null; role: string; admin: boolean };
export type AuditRow = { id: string; actor_id: string | null; actor_role: string | null; action: string; target_type: string | null; target_id: string | null; meta: Record<string, unknown> | null; created_at: string };
export type PendingMoodleUser = { id: string; name: string | null; email: string | null; username: string | null; sourced_id: string | null; context_title: string | null; first_seen_at: string | null; last_launch_at: string | null };
export type PhoneUpload = { id: string; exam_id: string | null; student_id: string | null; question_id: string | null; question_index: number | null; status: string | null; created_at: string; expires_at: string | null };
export type Hold = { attempt_id: string; exam_id: string; student_id: string; reason: string | null; held_by: string; held_at: string };
export type SystemStatus = {
  jobs: { name: string; schedule: string; active: boolean; last_run: { status: string; started_at: string; ended_at: string | null; message: string | null } | null; failures_24h: number }[];
  buckets: { bucket: string; objects: number; bytes: number }[];
  database_bytes: number;
  unlinked_accounts: { id: string; email: string | null; created_at: string; last_sign_in_at: string | null }[];
  missing_app_role: { id: string; email: string | null; kind: "staff" | "student" | "unlinked" }[];
  cron_installed?: boolean;
  backups?: Backups;
};

export interface AdminStore {
  isAdmin(authId: string): Promise<boolean>;
  /** The site retention period (retention_settings). */
  retentionDays(): Promise<number>;
  exams(): Promise<AdminExam[]>;
  enrollments(examIds: string[]): Promise<{ exam_id: string; student_id: string }[]>;
  /** Attempts started since `sinceIso`, plus any still being written or awaiting marks. */
  attempts(sinceIso: string): Promise<AdminAttempt[]>;
  questionCounts(examIds: string[]): Promise<Map<string, number>>;
  moodleLinks(examIds: string[]): Promise<{ exam_id: string; title: string }[]>;
  proctorAssignments(examIds: string[]): Promise<{ exam_id: string; name: string; role: string; email: string | null }[]>;
  students(ids: string[]): Promise<Map<string, StudentRef>>;
  /** Student names keyed by sign-in account, for audit entries students made. */
  studentNamesByAuth(authIds: string[]): Promise<Map<string, string>>;
  studentCounts(): Promise<{ total: number; withoutLogin: number }>;
  staff(): Promise<StaffRef[]>;
  /** Violation flags since `sinceIso`, optionally only these severities. */
  flags(sinceIso: string, severities?: string[]): Promise<Flag[]>;
  reviewedFlags(ids: string[]): Promise<Set<string>>;
  gradeTargets(): Promise<GradeTarget[]>;
  pendingMoodleUsers(): Promise<PendingMoodleUser[]>;
  holds(): Promise<Hold[]>;
  /** Phone (QR) answer uploads since `sinceIso`: the unfinished ones, and how many finished. */
  phoneUploads(sinceIso: string): Promise<{ pending: PhoneUpload[]; completed: number }>;
  auditLogs(filter: { actorId?: string; examId?: string; action?: string; limit: number }): Promise<AuditRow[]>;
  systemStatus(): Promise<SystemStatus>;
  resendGrades(examId: string | null, nowIso: string): Promise<number>;
  reviewFlag(violationId: string, by: string, note: string | null): Promise<{ exam_id: string | null } | null>;
  writeAudit(entry: { actorId: string; action: string; targetType: string; targetId: string; meta: Record<string, unknown> }): Promise<void>;
  allStudents(): Promise<StudentRef[]>;
  registrationPhotos(): Promise<RegistrationPhoto[]>;
  photoUrls(paths: string[]): Promise<Map<string, string>>;
  /** Deletes the row and file; false when the student had no photo. */
  resetPhoto(studentId: string): Promise<boolean>;
  /** Stored evidence counts, one row per R2 exam folder. */
  evidenceUsage(): Promise<FolderUsage[]>;
  /** Counted student folders inside these exam folders. */
  evidenceSittings(folders: string[]): Promise<(SittingFiles & { folder: string })[]>;
  /** Starts a count of one folder; a newer start makes the older one stop. */
  scanBegin(folder: string, scanId: string): Promise<void>;
  /** Adds a batch to the count; `done` stores it. False when a newer count took over. */
  scanAdd(folder: string, scanId: string, part: FolderCount, done: boolean, retentionDays: number): Promise<boolean>;
}

export type RegistrationPhoto = { student_id: string; storage_path: string; captured_at: string };

export type HealthCheck = { key: string; label: string; ok: boolean; detail: string; ms: number | null };
export type Release = { tag: string; version: string | null; publishedAt: string | null; url: string | null };
export type BackupRun = {
  id: number; status: "running" | "succeeded" | "failed"; kind: string; started_at: string; finished_at: string | null;
  location: string | null; size_bytes: number | null; message: string | null;
};
/** From backup_runs, which the backup job writes to (see README, "Backups"). */
export type Backups = { latest: BackupRun | null; last_success: BackupRun | null; failures_7d: number };

export interface AdminProbes {
  health(): Promise<HealthCheck[]>;
  latestRelease(): Promise<Release | null>;
  storageConfigured(): boolean;
  /** Top-level folders in the evidence bucket (one per exam), every page. */
  storageFolders(): Promise<{ configured: boolean; folders: string[]; error?: string }>;
  /** Up to `maxPages` listing pages under "<folder>/", from `token`; `next` is null at the end. */
  listFolder(folder: string, token: string | null, maxPages: number): Promise<{ objects: StorageObject[]; next: string | null; error?: string }>;
}

export type RetentionDeps = { db: RetentionAdminDb; stores: () => EvidenceStore[]; lifecycle: () => Promise<Lifecycle> };

/** Listing pages (1,000 keys each) counted per recount request. */
export const RECOUNT_PAGES = 10;
/** A real retention run must confirm the caller's own dry run from this recently. */
export const CONFIRM_WITHIN_MS = 30 * 60_000;
/** A run still marked running after this long was cut off (function timeout). */
const RUN_STALE_MS = 15 * 60_000;
const ADMIN_RUN_BUDGET_MS = 60_000;
const NO_BACKUPS: Backups = { latest: null, last_success: null, failures_7d: 0 };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const SAFE_ID = /^[A-Za-z0-9_.:|-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

export type ExamRef = {
  id: string; name: string; batch: string | null; owner: string | null;
  academic_type: string | null; subject_code: string | null; subject_name: string | null;
  semester: number | null; academic_year: string | null; attempt_label: string | null;
};
const examRef = (e: AdminExam, owner: string | null): ExamRef => ({
  id: e.id, name: e.name, batch: e.batch, owner,
  academic_type: e.academic_type ?? null, subject_code: e.subject_code ?? null, subject_name: e.subject_name ?? null,
  semester: e.semester ?? null, academic_year: e.academic_year ?? null, attempt_label: e.attempt_label ?? null,
});

export function createAdminHandler(deps: {
  store: AdminStore; probes: AdminProbes; actor: (req: Request) => Promise<Actor | null>; now: () => number; retention?: RetentionDeps;
}) {
  const { store, probes } = deps;

  async function overview(now: number) {
    const [exams, staff, attempts, studentCounts, status, everyone, photos] = await Promise.all([
      store.exams(), store.staff(), store.attempts(new Date(now - 30 * DAY).toISOString()), store.studentCounts(), store.systemStatus(),
      store.allStudents(), store.registrationPhotos(),
    ]);
    const withPhoto = new Set(photos.map((p) => p.student_id));
    const noPhoto = everyone.filter((s) => !withPhoto.has(s.id)).sort((a, b) => a.roll.localeCompare(b.roll));
    const ownerName = new Map(staff.map((s) => [s.auth_id, s.name]));
    const ref = (e: AdminExam): ExamRef => examRef(e, e.created_by ? ownerName.get(e.created_by) ?? null : null);
    const byId = new Map(exams.map((e) => [e.id, e]));
    const phase = new Map(exams.map((e) => [e.id, phaseOf(e, now)]));
    const liveIds = exams.filter((e) => phase.get(e.id) === "live").map((e) => e.id);
    const upcomingIds = exams.filter((e) => phase.get(e.id) === "upcoming").map((e) => e.id);
    const watched = [...liveIds, ...upcomingIds];

    const [enrolments, questions, moodle, proctors, serious30, flags24, targets, pendingUsers, holds, erpLog] = await Promise.all([
      store.enrollments(watched), store.questionCounts(upcomingIds), store.moodleLinks(upcomingIds), store.proctorAssignments(watched),
      store.flags(new Date(now - 30 * DAY).toISOString(), ["high", "critical"]), store.flags(new Date(now - DAY).toISOString()),
      store.gradeTargets(), store.pendingMoodleUsers(), store.holds(),
      store.auditLogs({ action: "results.exported", limit: 50 }),
    ]);
    const release = await probes.latestRelease().catch(() => null);
    const flags30 = [...new Map([...serious30, ...flags24].map((f) => [f.id, f])).values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    const attemptsByExam = new Map<string, AdminAttempt[]>();
    for (const a of attempts) attemptsByExam.set(a.exam_id, [...(attemptsByExam.get(a.exam_id) ?? []), a]);
    const enrolledByExam = new Map<string, string[]>();
    for (const r of enrolments) enrolledByExam.set(r.exam_id, [...(enrolledByExam.get(r.exam_id) ?? []), r.student_id]);
    const proctorsByExam = new Map<string, { name: string; role: string; email: string | null }[]>();
    for (const p of proctors) proctorsByExam.set(p.exam_id, [...(proctorsByExam.get(p.exam_id) ?? []), { name: p.name, role: p.role, email: p.email }]);
    const moodleByExam = new Map<string, string[]>();
    for (const m of moodle) moodleByExam.set(m.exam_id, [...(moodleByExam.get(m.exam_id) ?? []), m.title]);

    const reviewed = await store.reviewedFlags(flags30.map((f) => f.id));
    const waiting = flagsAwaitingReview(flags30, reviewed);
    const recent = flags30.filter((f) => Date.parse(f.created_at) >= now - DAY && f.severity !== "info");
    const failed = targets.map((t) => ({ t, state: gradePostState(t) })).filter((x) => x.state === "retrying" || x.state === "gave_up" || x.state === "no_gradebook");

    const connections = liveIds.flatMap((id) =>
      (attemptsByExam.get(id) ?? []).map((a) => ({ a, c: connectionOf(a, now) })).filter((x) => x.c && x.c.state !== "good"));

    const ungraded = attempts.filter((a) => a.state === "submitted" && (a.score === null || a.score === undefined));
    const submittedByExam = new Map<string, { submitted: number; graded: number }>();
    for (const a of attempts) {
      if (a.state !== "submitted") continue;
      const s = submittedByExam.get(a.exam_id) ?? { submitted: 0, graded: 0 };
      s.submitted += 1;
      if (a.score !== null && a.score !== undefined) s.graded += 1;
      submittedByExam.set(a.exam_id, s);
    }

    const studentIds = new Set<string>();
    for (const x of connections) studentIds.add(x.a.student_id);
    for (const f of [...recent, ...waiting]) if (f.student_id) studentIds.add(f.student_id);
    for (const x of failed) studentIds.add(x.t.student_id);
    for (const h of holds) studentIds.add(h.student_id);
    const students = await store.students([...studentIds]);
    const who = (id: string | null) => (id ? students.get(id) ?? { id, roll: "", full_name: null } : null);
    const examOf = (id: string | null) => (id && byId.get(id) ? ref(byId.get(id)!) : null);
    const flagView = (f: Flag) => ({ ...f, exam: examOf(f.exam_id), student: who(f.student_id), reviewed: reviewed.has(f.id) });

    const marking = new Map<string, { waiting: number; oldest: string | null }>();
    for (const a of ungraded) {
      const m = marking.get(a.exam_id) ?? { waiting: 0, oldest: null };
      m.waiting += 1;
      if (a.submitted_at && (!m.oldest || a.submitted_at < m.oldest)) m.oldest = a.submitted_at;
      marking.set(a.exam_id, m);
    }

    return {
      generatedAt: new Date(now).toISOString(),
      totals: {
        exams: exams.filter((e) => e.status !== "draft").length,
        drafts: exams.filter((e) => e.status === "draft").length,
        live: liveIds.length,
        upcoming: upcomingIds.length,
        students: studentCounts.total,
        staff: staff.length,
      },
      live: liveIds.map((id) => ({ exam: ref(byId.get(id)!), counts: liveCounts(enrolledByExam.get(id) ?? [], attemptsByExam.get(id) ?? [], now) })),
      upcoming: upcomingIds
        .map((id) => byId.get(id)!)
        .sort((a, b) => (a.scheduled_at ?? "9").localeCompare(b.scheduled_at ?? "9"))
        .map((e) => ({
          exam: ref(e),
          startsAt: e.scheduled_at,
          durationMinutes: e.duration_minutes,
          ...readiness(e, {
            questions: questions.get(e.id) ?? 0,
            enrolled: (enrolledByExam.get(e.id) ?? []).length,
            proctors: (proctorsByExam.get(e.id) ?? []).length,
            moodleLinks: (moodleByExam.get(e.id) ?? []).length,
          }),
        })),
      connections: connections
        .sort((x, y) => (y.c!.silentFor === Infinity ? 1e15 : y.c!.silentFor) - (x.c!.silentFor === Infinity ? 1e15 : x.c!.silentFor))
        .map(({ a, c }) => ({ attemptId: a.id, exam: examOf(a.exam_id), student: who(a.student_id), state: c!.state, silentSeconds: c!.silentFor === Infinity ? null : Math.round(c!.silentFor / 1000) })),
      recentFlags: recent.slice(0, 50).map(flagView),
      flagsWaiting: waiting.slice(0, 100).map(flagView),
      flagsWaitingTotal: waiting.length,
      proctorAssignments: watched.map((id) => ({ exam: ref(byId.get(id)!), phase: phase.get(id), assignees: proctorsByExam.get(id) ?? [] })),
      marking: [...marking.entries()].map(([id, m]) => ({ exam: examOf(id) ?? { id, name: id, batch: null, owner: null, academic_type: null, subject_code: null, subject_name: null, semester: null, academic_year: null, attempt_label: null }, ...m })).sort((a, b) => b.waiting - a.waiting),
      unreleased: exams
        .filter((e) => unreleased(e, submittedByExam.get(e.id)?.submitted ?? 0, now))
        .map((e) => ({ exam: ref(e), phase: phase.get(e.id), timing: releaseTiming((e.settings ?? {}) as ReleaseSettings), ...(submittedByExam.get(e.id) ?? { submitted: 0, graded: 0 }) })),
      moodle: {
        failed: failed.map(({ t, state }) => ({
          linkId: t.link_id, exam: examOf(t.exam_id), student: who(t.student_id), state,
          pendingScore: t.pending_score, lastError: t.last_error, attempts: t.post_attempts ?? 0, nextAttemptAt: t.next_attempt_at, lastPostedAt: t.last_posted_at,
        })),
        queued: targets.filter((t) => gradePostState(t) === "queued").length,
        posted: targets.filter((t) => gradePostState(t) === "posted").length,
        pendingUsers,
        retryJob: status.jobs.find((j) => j.name === "lti-grade-retry") ?? null,
      },
      holds: holds.map((h) => ({ attemptId: h.attempt_id, exam: examOf(h.exam_id), student: who(h.student_id), reason: h.reason, heldAt: h.held_at, heldBy: ownerName.get(h.held_by) ?? null })),
      erpHistory: erpLog.map((r) => {
        const m = r.meta ?? {};
        const ids = Array.isArray(m.exam_ids) ? (m.exam_ids as string[]) : [];
        return {
          id: r.id, at: r.created_at, by: r.actor_id ? ownerName.get(r.actor_id) ?? null : null,
          format: m.format ?? null, rows: m.rows ?? null, scope: r.target_type, target: r.target_id,
          exams: ids.map((id) => byId.get(id)?.name ?? id),
        };
      }),
      accounts: {
        unlinked: status.unlinked_accounts,
        missingAppRole: status.missing_app_role,
        studentsWithoutLogin: studentCounts.withoutLogin,
        photos: { taken: everyone.length - noPhoto.length, missingTotal: noPhoto.length, missing: noPhoto.slice(0, 500) },
      },
      versions: { latest: release?.version ?? null, inUse: versionsInUse(attempts, release?.version ?? null) },
      exams: exams.map((e) => ({ ...ref(e), status: e.status, phase: phase.get(e.id), scheduled_at: e.scheduled_at, settings: e.settings ?? {} })),
      staff,
    };
  }

  async function system() {
    const [health, release, status] = await Promise.all([probes.health(), probes.latestRelease().catch(() => null), store.systemStatus()]);
    return { health, release, jobs: status.jobs, cronInstalled: status.cron_installed ?? true, backups: status.backups ?? NO_BACKUPS };
  }

  async function storage() {
    const [listing, exams, status, usage, days] = await Promise.all([
      probes.storageFolders(), store.exams(), store.systemStatus(), store.evidenceUsage(), store.retentionDays(),
    ]);
    return {
      r2: { configured: listing.configured, error: listing.error ?? null, retentionDays: days, ...storageFromCounts(listing.folders, usage, exams) },
      buckets: status.buckets,
      databaseBytes: status.database_bytes,
    };
  }

  async function recount(body: Record<string, unknown>, now: number): Promise<Response> {
    const folder = text(body.folder);
    if (!folder || folder.includes("/") || folder.length > 300) return json({ error: "bad_folder" }, 400);
    let scanId = text(body.scanId);
    const token = text(body.token);
    if (scanId && !UUID.test(scanId)) return json({ error: "bad_scan" }, 400);
    if (token && !scanId) return json({ error: "bad_scan" }, 400);
    if (!probes.storageConfigured()) return json({ error: "storage_not_configured" }, 503);
    if (!scanId) {
      scanId = crypto.randomUUID();
      await store.scanBegin(folder, scanId);
    }
    const page = await probes.listFolder(folder, token, RECOUNT_PAGES);
    if (page.error) return json({ error: "storage_unreachable", detail: page.error }, 502);
    const days = await store.retentionDays();
    const done = !page.next;
    if (!(await store.scanAdd(folder, scanId, countObjects(page.objects, days, now), done, days))) return json({ error: "count_superseded" }, 409);
    return json({ done, scanId, token: page.next, listed: page.objects.length });
  }

  async function uploads(now: number, examId: string | null) {
    const sinceMs = now - 30 * DAY;
    const since = new Date(sinceMs).toISOString();
    const [exams, staff, attempts, phone, usage] = await Promise.all([
      store.exams(), store.staff(), store.attempts(since), store.phoneUploads(since), store.evidenceUsage(),
    ]);
    const ownerName = new Map(staff.map((s) => [s.auth_id, s.name]));
    const byId = new Map(exams.map((e) => [e.id, e]));
    const examOf = (id: string | null): ExamRef | null => {
      const e = id ? byId.get(id) : undefined;
      return e ? examRef(e, e.created_by ? ownerName.get(e.created_by) ?? null : null) : null;
    };
    const usageOf = new Map(usage.map((u) => [u.folder, u]));
    const countedAt = (e: AdminExam) => {
      const times = examFolders(e).map((f) => usageOf.get(f)?.counted_at).filter((t): t is string => !!t);
      return times.length ? times.sort()[0] : null;
    };

    const kioskSittings = attempts.filter((a) => isKioskSitting(a) && Date.parse(a.started_at ?? a.submitted_at ?? "") >= sinceMs);
    const perExam = new Map<string, AdminAttempt[]>();
    for (const a of kioskSittings) perExam.set(a.exam_id, [...(perExam.get(a.exam_id) ?? []), a]);
    const examList = [...perExam.entries()]
      .filter(([id]) => byId.has(id))
      .map(([id, list]) => ({
        exam: examOf(id)!, sittings: list.length, countedAt: countedAt(byId.get(id)!),
        lastSubmitted: list.reduce<string | null>((m, a) => (a.submitted_at && (!m || a.submitted_at > m) ? a.submitted_at : m), null),
      }))
      .sort((a, b) => (b.lastSubmitted ?? "").localeCompare(a.lastSubmitted ?? ""));

    const chosen = examId ? byId.get(examId) ?? null : null;
    const examAttempts = chosen ? perExam.get(chosen.id) ?? [] : [];
    const folders = chosen ? examFolders(chosen) : [];
    const counted = chosen ? countedAt(chosen) : null;
    const sittingRows = counted ? await store.evidenceSittings(folders) : [];
    const students = await store.students([...new Set([
      ...examAttempts.map((a) => a.student_id), ...phone.pending.map((p) => p.student_id).filter((id): id is string => !!id),
    ])]);
    const who = (id: string | null) => (id ? students.get(id) ?? { id, roll: "", full_name: null } : null);
    const rolls = new Map([...students].map(([id, s]) => [id, s.roll]));
    const kiosk = counted
      ? kioskUploads(examAttempts, exams, rolls, new Map(sittingRows.map((s) => [`${s.folder}/${s.student_folder}`, s])), now)
      : [];
    const count = (s: string) => kiosk.filter((k) => k.state === s).length;
    const pending = phone.pending.map((p) => ({ ...p, open: !!p.expires_at && Date.parse(p.expires_at) > now }));
    return {
      kiosk: {
        configured: probes.storageConfigured(),
        exams: examList,
        detail: chosen ? {
          exam: examOf(chosen.id)!,
          folders: folders.map((f) => ({ folder: f, countedAt: usageOf.get(f)?.counted_at ?? null })),
          countedAt: counted,
          sittings: examAttempts.length,
          checked: kiosk.length, complete: count("complete"), uploading: count("uploading"), partial: count("partial"), missing: count("missing"),
          items: kiosk
            .filter((k) => k.state !== "complete")
            .sort((a, b) => (b.attempt.submitted_at ?? "").localeCompare(a.attempt.submitted_at ?? ""))
            .map((k) => ({ attemptId: k.attempt.id, exam: examOf(k.attempt.exam_id), student: who(k.attempt.student_id), submittedAt: k.attempt.submitted_at, version: k.version, kinds: k.kinds, files: k.files, lastUpload: k.lastUpload, state: k.state })),
        } : null,
      },
      phone: {
        completed: phone.completed,
        open: pending.filter((p) => p.open).length,
        abandoned: pending.filter((p) => !p.open).length,
        items: pending.slice(0, 300).map((p) => ({ id: p.id, exam: examOf(p.exam_id), student: who(p.student_id), question: p.question_index === null ? p.question_id : `Q${p.question_index + 1}`, status: p.status, createdAt: p.created_at, expiresAt: p.expires_at, open: p.open })),
      },
    };
  }

  const runView = (r: RunRow, names: Map<string, string>, now: number) => ({
    id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, dryRun: r.dry_run, trigger: r.trigger,
    by: r.requested_by ? names.get(r.requested_by) ?? null : null,
    retentionDays: r.retention_days, cutoff: r.cutoff,
    status: r.status === "running" && now - Date.parse(r.started_at) > RUN_STALE_MS ? "interrupted" : r.status,
    complete: r.complete, deleted: r.deleted, skipped: r.skipped, failed: r.failed, dueWeek: r.due_week,
    database: r.detail?.db ?? {}, files: r.detail?.storage ?? {}, errors: (r.detail?.errors ?? []).slice(0, 10),
  });

  async function retentionStatus(r: RetentionDeps, now: number) {
    const [settings, runs, holds, status, lifecycle, exams, staff] = await Promise.all([
      r.db.settings(), r.db.runs(10), r.db.legalHolds(), store.systemStatus(), r.lifecycle(), store.exams(), store.staff(),
    ]);
    const days = settings.retention_days;
    const weekIso = new Date(now - days * DAY + 7 * DAY).toISOString();
    const database: Record<string, number> = {};
    for (const kind of DB_KINDS) database[kind] = (await r.db.dbBatch(kind, weekIso, 0, true)).due;
    const scan = runs.find((x) => x.complete && x.status !== "running" && x.status !== "failed" && Object.keys(x.detail?.storage ?? {}).length);
    const files = scan ? Object.values(scan.detail!.storage).reduce((n, s) => n + s.due_week, 0) : null;

    const names = new Map(staff.map((s) => [s.auth_id, s.name]));
    const byId = new Map(exams.map((e) => [e.id, e]));
    const students = await store.students(holds.filter((h) => h.target_type === "student").map((h) => h.target_id));
    return {
      days, min: MIN_DAYS, max: MAX_DAYS, updatedAt: settings.updated_at, updatedBy: settings.updated_by ? names.get(settings.updated_by) ?? null : null,
      dueWeek: { database, files, filesCountedAt: scan?.finished_at ?? null, filesRunId: scan?.id ?? null },
      unmatched: scan ? {
        runId: scan.id, countedAt: scan.finished_at,
        total: Object.values(scan.detail!.storage).reduce((t, s) => t + (s.unmatched_total ?? 0), 0),
        folders: Object.entries(scan.detail!.storage).flatMap(([name, s]) => (s.unmatched ?? []).map((folder) => ({ store: name, folder }))),
      } : null,
      runs: runs.map((x) => runView(x, names, now)),
      holds: holds.map((h) => ({
        id: h.id, targetType: h.target_type, targetId: h.target_id, reason: h.reason, placedAt: h.placed_at,
        placedBy: h.placed_by ? names.get(h.placed_by) ?? null : null,
        exam: h.target_type === "exam" && byId.get(h.target_id) ? examRef(byId.get(h.target_id)!, null) : null,
        student: h.target_type === "student" ? students.get(h.target_id) ?? { id: h.target_id, roll: "", full_name: null } : null,
      })),
      job: status.jobs.find((j) => j.name === "evidence-retention") ?? null,
      cronInstalled: status.cron_installed ?? true,
      lifecycle: { ...lifecycle, conflicts: conflictingRules(lifecycle.rules, days) },
    };
  }

  async function retentionOp(op: string, body: Record<string, unknown>, actor: Actor, now: number): Promise<Response> {
    const r = deps.retention;
    if (!r) return json({ error: "retention_not_configured" }, 503);
    if (op === "retention") return json(await retentionStatus(r, now));

    if (op === "set_retention") {
      const days = Number(body.days);
      if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) return json({ error: "bad_retention_days", min: MIN_DAYS, max: MAX_DAYS }, 400);
      await r.db.setRetentionDays(days, actor.authId);
      return json({ ok: true, days });
    }

    if (op === "legal_hold") {
      const type = body.targetType;
      if (type !== "exam" && type !== "student") return json({ error: "bad_target" }, 400);
      if (typeof body.on !== "boolean") return json({ error: "bad_hold" }, 400);
      let target = text(body.targetId);
      const roll = text(body.roll);
      if (type === "student" && !target && roll) {
        const hits = (await store.allStudents()).filter((s) => s.roll.toUpperCase() === roll.toUpperCase());
        if (!hits.length) return json({ error: "target_not_found" }, 404);
        if (hits.length > 1) return json({ error: "roll_ambiguous", students: hits.map((s) => ({ id: s.id, roll: s.roll, full_name: s.full_name })) }, 409);
        target = hits[0].id;
      }
      if (!target || !SAFE_ID.test(target) || (type === "student" && !UUID.test(target))) return json({ error: "bad_target" }, 400);
      const reason = text(body.reason)?.slice(0, 500) ?? null;
      if (body.on && !reason) return json({ error: "reason_required" }, 400);
      try {
        const changed = await r.db.setLegalHold(type, target, body.on, reason, actor.authId);
        return json({ ok: true, changed });
      } catch (e) {
        if ((e as { code?: string }).code === "P0002") return json({ error: "target_not_found" }, 404);
        throw e;
      }
    }

    if (op === "retention_run") {
      const dryRun = body.dryRun !== false;
      const confirmRunId = Number(body.confirmRunId);
      if (!dryRun) {
        const [dry, days] = await Promise.all([Number.isInteger(confirmRunId) && confirmRunId > 0 ? r.db.run(confirmRunId) : null, r.db.retentionDays()]);
        const fresh = !!dry?.finished_at && now - Date.parse(dry.finished_at) <= CONFIRM_WITHIN_MS;
        if (!dry || !dry.dry_run || dry.requested_by !== actor.authId || dry.status === "running" || !fresh || dry.retention_days !== days) {
          return json({ error: "dry_run_required" }, 409);
        }
      }
      if ((await r.db.runs(5)).some((x) => x.status === "running" && now - Date.parse(x.started_at) <= RUN_STALE_MS)) {
        return json({ error: "run_in_progress" }, 409);
      }
      const s = await runRetention({ stores: r.stores(), db: r.db, now: deps.now }, { dryRun, trigger: "admin", requestedBy: actor.authId, budgetMs: ADMIN_RUN_BUDGET_MS });
      if (!dryRun) {
        await store.writeAudit({
          actorId: actor.authId, action: "admin.retention_run", targetType: "retention", targetId: String(s.id),
          meta: { confirmed_dry_run: confirmRunId, status: s.status, complete: s.complete, deleted: s.deleted, skipped: s.skipped, failed: s.failed },
        });
      }
      return json({
        run: {
          id: s.id, dryRun: s.dryRun, status: s.status, complete: s.complete, retentionDays: s.retentionDays, cutoff: s.cutoff,
          deleted: s.deleted, skipped: s.skipped, failed: s.failed, dueWeek: s.due_week,
          database: s.detail.db, files: s.detail.storage, errors: s.detail.errors.slice(0, 10),
        },
      });
    }
    return json({ error: "unknown_op" }, 400);
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    try {
      const actor = await deps.actor(req);
      if (!actor) return json({ error: "sign_in_required" }, 401);
      if (!(await store.isAdmin(actor.authId))) return json({ error: "admins_only" }, 403);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const op = text(body.op) ?? "overview";
      const now = deps.now();

      if (op === "overview") return json(await overview(now));
      if (op === "system") return json(await system());
      if (op === "storage") return json(await storage());
      if (op === "recount_storage") return await recount(body, now);
      if (op === "retention" || op === "set_retention" || op === "legal_hold" || op === "retention_run") return await retentionOp(op, body, actor, now);
      if (op === "uploads") {
        const examId = text(body.examId);
        if (examId && !SAFE_ID.test(examId)) return json({ error: "bad_exam" }, 400);
        return json(await uploads(now, examId));
      }

      if (op === "audit") {
        const actorId = text(body.actorId);
        const examId = text(body.examId);
        const action = text(body.action);
        if (actorId && !UUID.test(actorId)) return json({ error: "bad_actor" }, 400);
        if (examId && !SAFE_ID.test(examId)) return json({ error: "bad_exam" }, 400);
        if (action && !/^[a-z_.]{1,60}$/.test(action)) return json({ error: "bad_action" }, 400);
        const limit = Math.max(1, Math.min(500, Number(body.limit) || 200));
        const [rows, staff] = await Promise.all([
          store.auditLogs({ actorId: actorId ?? undefined, examId: examId ?? undefined, action: action ?? undefined, limit }),
          store.staff(),
        ]);
        const names = new Map(staff.map((s) => [s.auth_id, s.name]));
        const others = [...new Set(rows.map((r) => r.actor_id).filter((id): id is string => !!id && !names.has(id)))];
        if (others.length) for (const [id, name] of await store.studentNamesByAuth(others)) names.set(id, name);
        return json({ entries: rows.map((r) => ({ ...r, actor_name: r.actor_id ? names.get(r.actor_id) ?? null : null })) });
      }

      if (op === "resend_moodle") {
        const examId = text(body.examId);
        if (examId && !SAFE_ID.test(examId)) return json({ error: "bad_exam" }, 400);
        const queued = await store.resendGrades(examId, new Date(now).toISOString());
        await store.writeAudit({ actorId: actor.authId, action: "admin.moodle_resend", targetType: examId ? "exam" : "all", targetId: examId ?? "all", meta: { queued } });
        return json({ ok: true, queued });
      }

      if (op === "review_flag") {
        const id = text(body.violationId);
        if (!id || !UUID.test(id)) return json({ error: "bad_flag" }, 400);
        const note = text(body.note)?.slice(0, 500) ?? null;
        const flag = await store.reviewFlag(id, actor.authId, note);
        if (!flag) return json({ error: "flag_not_found" }, 404);
        await store.writeAudit({ actorId: actor.authId, action: "admin.flag_reviewed", targetType: "violation", targetId: id, meta: { exam_id: flag.exam_id, note } });
        return json({ ok: true });
      }

      if (op === "photos") {
        const photos = (await store.registrationPhotos()).sort((a, b) => b.captured_at.localeCompare(a.captured_at)).slice(0, 500);
        const [students, urls] = await Promise.all([store.students(photos.map((p) => p.student_id)), store.photoUrls(photos.map((p) => p.storage_path))]);
        return json({
          photos: photos.map((p) => ({ student: students.get(p.student_id) ?? { id: p.student_id, roll: "", full_name: null }, capturedAt: p.captured_at, url: urls.get(p.storage_path) ?? null })),
        });
      }

      if (op === "reset_photo") {
        const id = text(body.studentId);
        if (!id || !UUID.test(id)) return json({ error: "bad_student" }, 400);
        if (!(await store.resetPhoto(id))) return json({ error: "photo_not_found" }, 404);
        await store.writeAudit({ actorId: actor.authId, action: "admin.photo_reset", targetType: "student", targetId: id, meta: {} });
        return json({ ok: true });
      }

      return json({ error: "unknown_op" }, 400);
    } catch (err) {
      console.error("[admin-dashboard]", err);
      return json({ error: "server_error" }, 500);
    }
  };
}
