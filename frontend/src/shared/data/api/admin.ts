// Domain module: the admin console. Everything comes from the admin-dashboard
// edge function, which checks the caller is an admin and reads across every
// teacher's exams (including Moodle and account data browsers can't see).

import { getSupabase } from "@/shared/data/supabase";

export type ExamRef = {
  id: string; name: string; batch: string | null; owner: string | null;
  academic_type: string | null; subject_code: string | null; subject_name: string | null;
  semester: number | null; academic_year: string | null; attempt_label: string | null;
};
export type StudentRef = { id: string; roll: string; full_name: string | null };
export type Phase = "live" | "upcoming" | "draft" | "completed";

export type LiveCounts = { enrolled: number; writing: number; weak: number; disconnected: number; paused: number; submitted: number; notStarted: number };
export type ReadinessCheck = { key: string; label: string; ok: boolean; required: boolean; detail: string };
export type FlagView = {
  id: string; exam_id: string | null; attempt_id: string | null; student_id: string | null;
  violation_type: string; severity: string; source: string | null; created_at: string;
  exam: ExamRef | null; student: StudentRef | null; reviewed: boolean;
};
export type CronJob = { name: string; schedule: string; active: boolean; last_run: { status: string; started_at: string; ended_at: string | null; message: string | null } | null; failures_24h: number };
export type GradePostState = "posted" | "queued" | "retrying" | "gave_up" | "no_gradebook";

export type AdminOverview = {
  generatedAt: string;
  totals: { exams: number; drafts: number; live: number; upcoming: number; students: number; staff: number };
  live: { exam: ExamRef; counts: LiveCounts }[];
  upcoming: { exam: ExamRef; startsAt: string | null; durationMinutes: number | null; ready: boolean; checks: ReadinessCheck[] }[];
  connections: { attemptId: string; exam: ExamRef | null; student: StudentRef | null; state: "weak" | "lost"; silentSeconds: number | null }[];
  recentFlags: FlagView[];
  flagsWaiting: FlagView[];
  flagsWaitingTotal: number;
  proctorAssignments: { exam: ExamRef; phase: Phase; assignees: { name: string; role: string; email: string | null }[] }[];
  marking: { exam: ExamRef; waiting: number; oldest: string | null }[];
  unreleased: { exam: ExamRef; phase: Phase; timing: string; submitted: number; graded: number }[];
  moodle: {
    failed: { linkId: string; exam: ExamRef | null; student: StudentRef | null; state: GradePostState; pendingScore: number | null; lastError: string | null; attempts: number; nextAttemptAt: string | null; lastPostedAt: string | null }[];
    queued: number;
    posted: number;
    pendingUsers: { id: string; name: string | null; email: string | null; username: string | null; sourced_id: string | null; context_title: string | null; first_seen_at: string | null; last_launch_at: string | null }[];
    retryJob: CronJob | null;
  };
  holds: { attemptId: string; exam: ExamRef | null; student: StudentRef | null; reason: string | null; heldAt: string; heldBy: string | null }[];
  erpHistory: { id: string; at: string; by: string | null; format: string | null; rows: number | null; scope: string | null; target: string | null; exams: string[] }[];
  accounts: {
    unlinked: { id: string; email: string | null; created_at: string; last_sign_in_at: string | null }[];
    missingAppRole: { id: string; email: string | null; kind: "staff" | "student" | "unlinked" }[];
    studentsWithoutLogin: number;
    photos: { taken: number; missingTotal: number; missing: StudentRef[] };
  };
  versions: { latest: string | null; inUse: { version: string; attempts: number; students: number; lastSeen: string | null; outdated: boolean }[] };
  exams: (ExamRef & { status: string | null; phase: Phase; scheduled_at: string | null; settings: Record<string, unknown> })[];
  staff: { auth_id: string; name: string; email: string | null; role: string; admin: boolean }[];
};

export type HealthCheck = { key: string; label: string; ok: boolean; detail: string; ms: number | null };
export type AdminSystem = {
  health: HealthCheck[];
  release: { tag: string; version: string | null; publishedAt: string | null; url: string | null } | null;
  jobs: CronJob[];
  /** False when the database has no pg_cron, so there are no scheduled jobs to list. */
  cronInstalled: boolean;
  backups: Backups;
};

/** One run of the backup job, as it reported itself in backup_runs. */
export type BackupRun = {
  id: number; status: "running" | "succeeded" | "failed"; kind: string; started_at: string; finished_at: string | null;
  location: string | null; size_bytes: number | null; message: string | null;
};
export type Backups = { latest: BackupRun | null; last_success: BackupRun | null; failures_7d: number };

export type ExamStorage = {
  folder: string; examIds: string[]; examName: string | null;
  /** Null until the folder has been counted; its figures are then zero. */
  countedAt: string | null;
  bytes: number; objects: number; oldest: string | null; dueSoonObjects: number; dueSoonBytes: number; nextDeletion: string | null;
};
export type AdminStorage = {
  r2: {
    configured: boolean; error: string | null; retentionDays: number; exams: ExamStorage[];
    folders: number; countedFolders: number; uncounted: string[]; oldestCount: string | null;
    totalBytes: number; totalObjects: number; dueSoonBytes: number; dueSoonObjects: number;
  };
  buckets: { bucket: string; objects: number; bytes: number }[];
  databaseBytes: number;
};

export type UploadState = "complete" | "uploading" | "partial" | "missing";
export type KioskUploadItem = { attemptId: string; exam: ExamRef | null; student: StudentRef | null; submittedAt: string | null; version: string; kinds: string[]; files: number; lastUpload: string | null; state: UploadState };
export type AdminUploads = {
  kiosk: {
    configured: boolean;
    /** Exams with exam-browser sittings in the last 30 days, newest first. */
    exams: { exam: ExamRef; sittings: number; countedAt: string | null; lastSubmitted: string | null }[];
    detail: null | {
      exam: ExamRef;
      folders: { folder: string; countedAt: string | null }[];
      countedAt: string | null;
      sittings: number;
      checked: number; complete: number; uploading: number; partial: number; missing: number;
      items: KioskUploadItem[];
    };
  };
  phone: {
    completed: number; open: number; abandoned: number;
    items: { id: string; exam: ExamRef | null; student: StudentRef | null; question: string | null; status: string | null; createdAt: string; expiresAt: string | null; open: boolean }[];
  };
};

export type AdminAuditEntry = { id: string; actor_id: string | null; actor_name: string | null; actor_role: string | null; action: string; target_type: string | null; target_id: string | null; meta: Record<string, unknown> | null; created_at: string };

const ERRORS: Record<string, string> = {
  sign_in_required: "Sign in again to use the admin console.",
  admins_only: "This account is not an admin.",
  flag_not_found: "That flag no longer exists.",
  photo_not_found: "That student has no registration photo.",
  count_superseded: "Someone else started counting this folder. Their count will finish it.",
  storage_not_configured: "R2 isn't configured for the server functions.",
  storage_unreachable: "Evidence storage (R2) didn't answer. Try again.",
  server_error: "The admin service failed. Try again.",
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(body: Record<string, unknown>): Promise<Result<T>> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "Offline: connect to the database to use the admin console." };
  const { data, error } = await db.functions.invoke("admin-dashboard", { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const payload = ctx && typeof ctx.json === "function" ? ((await ctx.json().catch(() => null)) as { error?: string } | null) : null;
    return { ok: false, error: payload?.error ? ERRORS[payload.error] ?? payload.error : "Could not reach the admin service." };
  }
  return { ok: true, data: data as T };
}

export const loadAdminOverview = () => call<AdminOverview>({ op: "overview" });
export const loadAdminSystem = () => call<AdminSystem>({ op: "system" });
export const loadAdminStorage = () => call<AdminStorage>({ op: "storage" });
export const loadAdminUploads = (examId?: string) => call<AdminUploads>({ op: "uploads", examId });

/** Counts one R2 exam folder, a batch per request, until the whole folder is counted. */
export async function recountStorageFolder(folder: string, onProgress?: (listed: number) => void): Promise<Result<{ listed: number }>> {
  let scanId: string | undefined;
  let token: string | null = null;
  let listed = 0;
  for (;;) {
    const res: Result<{ done: boolean; scanId: string; token: string | null; listed: number }> =
      await call({ op: "recount_storage", folder, scanId, token: token ?? undefined });
    if (!res.ok) return res;
    listed += res.data.listed;
    onProgress?.(listed);
    if (res.data.done) return { ok: true, data: { listed } };
    scanId = res.data.scanId;
    token = res.data.token;
  }
}
export const loadAdminAudit = (f: { actorId?: string; examId?: string; action?: string; limit?: number }) =>
  call<{ entries: AdminAuditEntry[] }>({ op: "audit", ...f });
export const resendMoodleGrades = (examId?: string) => call<{ ok: true; queued: number }>({ op: "resend_moodle", examId });
export const loadRegistrationPhotos = () => call<{ photos: { student: StudentRef; capturedAt: string; url: string | null }[] }>({ op: "photos" });
export const resetRegistrationPhoto = (studentId: string) => call<{ ok: true }>({ op: "reset_photo", studentId });
export const reviewFlag = (violationId: string, note?: string) => call<{ ok: true }>({ op: "review_flag", violationId, note });
