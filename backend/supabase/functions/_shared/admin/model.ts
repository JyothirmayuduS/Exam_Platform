// Pure rules behind the admin console: connection state, live counts,
// readiness, exam browser versions, Moodle grade posts and storage per exam.
import { examPhase, type ExamPhase } from "../exam/phase.ts";
import { resultsReleased, type ExportExam } from "../results/rows.ts";

export type AdminExam = ExportExam & { created_at: string | null; legacy_name?: string | null };

export type AdminAttempt = {
  id: string;
  exam_id: string;
  student_id: string;
  state: string | null;
  score: number | null;
  started_at: string | null;
  submitted_at: string | null;
  auto_saved_at: string | null;
  session_seen_at: string | null;
  user_agent: string | null;
};

/** The exam page renews its session claim every 15 s; the server treats 45 s as still live. */
export const HEARTBEAT_LIVE_MS = 45_000;
/** No sign of the candidate for this long while writing: connection lost. */
export const LOST_AFTER_MS = 120_000;

export type Connection = "good" | "weak" | "lost";

const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** Last sign of life from a candidate who is writing; null when not writing. */
export function connectionOf(a: AdminAttempt, now: number): { state: Connection; silentFor: number } | null {
  if (a.state !== "in_progress") return null;
  const last = Math.max(ms(a.session_seen_at), ms(a.auto_saved_at), ms(a.started_at));
  const silentFor = last ? Math.max(0, now - last) : Infinity;
  const state: Connection = silentFor <= HEARTBEAT_LIVE_MS ? "good" : silentFor <= LOST_AFTER_MS ? "weak" : "lost";
  return { state, silentFor };
}

export type LiveCounts = { enrolled: number; writing: number; weak: number; disconnected: number; paused: number; submitted: number; notStarted: number };

/** One line per student: the most recent attempt decides where they are. */
export function liveCounts(enrolled: string[], attempts: AdminAttempt[], now: number): LiveCounts {
  const latest = new Map<string, AdminAttempt>();
  for (const a of attempts) {
    const prev = latest.get(a.student_id);
    if (!prev || ms(a.started_at) >= ms(prev.started_at)) latest.set(a.student_id, a);
  }
  const students = new Set([...enrolled, ...latest.keys()]);
  const c: LiveCounts = { enrolled: students.size, writing: 0, weak: 0, disconnected: 0, paused: 0, submitted: 0, notStarted: 0 };
  for (const sid of students) {
    const a = latest.get(sid);
    if (!a || !a.state || a.state === "not_started") { c.notStarted += 1; continue; }
    if (a.state === "submitted") { c.submitted += 1; continue; }
    if (a.state === "paused") { c.paused += 1; continue; }
    const conn = connectionOf(a, now);
    if (conn?.state === "lost") c.disconnected += 1;
    else { c.writing += 1; if (conn?.state === "weak") c.weak += 1; }
  }
  return c;
}

export type ReadinessCheck = { key: "schedule" | "paper" | "enrolment" | "proctors" | "moodle"; label: string; ok: boolean; required: boolean; detail: string };

/** What an upcoming sitting still needs. Proctors and Moodle are advised, not required. */
export function readiness(exam: AdminExam, info: { questions: number; enrolled: number; proctors: number; moodleLinks: number }): { ready: boolean; checks: ReadinessCheck[] } {
  const checks: ReadinessCheck[] = [
    {
      key: "schedule", label: "Date and duration", required: true,
      ok: !!exam.scheduled_at && (exam.duration_minutes ?? 0) > 0,
      detail: exam.scheduled_at ? `${exam.duration_minutes ?? 0} min` : "No start time set",
    },
    {
      key: "paper", label: "Question paper", required: true,
      ok: info.questions > 0,
      detail: info.questions > 0 ? `${info.questions} question${info.questions === 1 ? "" : "s"}` : "No questions attached",
    },
    { key: "enrolment", label: "Students enrolled", required: true, ok: info.enrolled > 0, detail: `${info.enrolled} enrolled` },
    { key: "proctors", label: "Proctors assigned", required: false, ok: info.proctors > 0, detail: info.proctors > 0 ? `${info.proctors} assigned` : "Nobody assigned" },
    { key: "moodle", label: "Moodle link", required: false, ok: info.moodleLinks > 0, detail: info.moodleLinks > 0 ? `${info.moodleLinks} Moodle activit${info.moodleLinks === 1 ? "y" : "ies"}` : "Not linked to Moodle" },
  ];
  return { ready: checks.every((c) => !c.required || c.ok), checks };
}

export function phaseOf(exam: AdminExam, now: number): ExamPhase {
  return examPhase(exam, now);
}

/** Exams with submissions (or already over) whose scores students can't see yet. */
export function unreleased(exam: AdminExam, submitted: number, now: number): boolean {
  if ((exam.status ?? "") === "draft") return false;
  if (submitted === 0 && phaseOf(exam, now) !== "completed") return false;
  return !resultsReleased(exam, now);
}

/** "0.2.32" from the kiosk's user agent, "web" for a browser sitting, null when unknown. */
export function kioskVersion(ua: string | null | undefined): string | null {
  const m = (ua ?? "").match(/VignanExam\/([\w.]+)/);
  if (!m) return null;
  return m[1] === "unknown" ? null : m[1];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type VersionUse = { version: string; attempts: number; students: number; lastSeen: string | null; outdated: boolean };

/** Exam browser versions candidates used, newest first; "web" is a browser sitting. */
export function versionsInUse(attempts: Pick<AdminAttempt, "student_id" | "user_agent" | "started_at">[], latest: string | null): VersionUse[] {
  const by = new Map<string, { attempts: number; students: Set<string>; last: number }>();
  for (const a of attempts) {
    const v = kioskVersion(a.user_agent);
    if (!v) continue;
    const g = by.get(v) ?? { attempts: 0, students: new Set<string>(), last: 0 };
    g.attempts += 1;
    g.students.add(a.student_id);
    g.last = Math.max(g.last, ms(a.started_at));
    by.set(v, g);
  }
  return [...by.entries()]
    .map(([version, g]) => ({
      version,
      attempts: g.attempts,
      students: g.students.size,
      lastSeen: g.last ? new Date(g.last).toISOString() : null,
      outdated: version !== "web" && !!latest && compareVersions(version, latest) < 0,
    }))
    .sort((a, b) => (a.version === "web" ? 1 : b.version === "web" ? -1 : compareVersions(b.version, a.version)));
}

/** "lockdown-v0.2.60" → "0.2.60". */
export function releaseVersion(tag: string): string | null {
  const m = tag.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export type GradeTarget = {
  link_id: string;
  student_id: string;
  exam_id: string | null;
  lineitem: string | null;
  last_score: number | null;
  last_posted_at: string | null;
  last_error: string | null;
  pending_score: number | null;
  post_attempts: number | null;
  next_attempt_at: string | null;
};

export type GradePostState = "posted" | "queued" | "retrying" | "gave_up" | "no_gradebook";

/** Where a Moodle grade stands. Only a score still waiting to post can fail. */
export function gradePostState(t: GradeTarget): GradePostState {
  if (t.pending_score === null || t.pending_score === undefined) return "posted";
  if (!t.lineitem) return "no_gradebook";
  if (!t.next_attempt_at) return "gave_up";
  return t.last_error ? "retrying" : "queued";
}

export type StorageObject = { key: string; size: number; lastModified: string | null };

/** The kiosk names an exam's folder after the exam name; phone uploads use the exam id. */
export function slugifyFolderSegment(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** The R2 folders an exam's evidence can sit in. */
export function examFolders(exam: Pick<AdminExam, "id" | "name"> & { legacy_name?: string | null }): string[] {
  return [...new Set([slugifyFolderSegment(exam.name ?? ""), slugifyFolderSegment(exam.legacy_name ?? ""), exam.id].filter(Boolean))];
}

export type SittingFiles = { student_folder: string; kinds: string[]; files: number; last_upload: string | null };
export type FolderCount = {
  bytes: number; objects: number; oldest: string | null;
  due_soon_bytes: number; due_soon_objects: number; next_deletion: string | null;
  sittings: SittingFiles[];
};

/** Adds up one batch of objects listed under a single exam folder. Keys are
 *  <folder>/<student folder>/<kind>/<file>; R2 deletes each `retentionDays` after upload. */
export function countObjects(objects: StorageObject[], retentionDays: number, now: number, soonDays = 7): FolderCount {
  const retentionMs = retentionDays * 86_400_000;
  const soon = now + soonDays * 86_400_000;
  const c: FolderCount = { bytes: 0, objects: 0, oldest: null, due_soon_bytes: 0, due_soon_objects: 0, next_deletion: null, sittings: [] };
  const sittings = new Map<string, { kinds: Set<string>; files: number; last: number }>();
  let oldest = 0, next = 0;
  for (const o of objects) {
    c.bytes += o.size;
    c.objects += 1;
    const modified = ms(o.lastModified);
    if (modified) {
      if (!oldest || modified < oldest) oldest = modified;
      const deleteAt = modified + retentionMs;
      if (deleteAt <= soon) { c.due_soon_objects += 1; c.due_soon_bytes += o.size; }
      if (!next || deleteAt < next) next = deleteAt;
    }
    const p = o.key.split("/");
    if (p.length < 4 || !p[1]) continue;
    const g = sittings.get(p[1]) ?? { kinds: new Set<string>(), files: 0, last: 0 };
    g.kinds.add(p[2]);
    g.files += 1;
    g.last = Math.max(g.last, modified);
    sittings.set(p[1], g);
  }
  c.oldest = oldest ? new Date(oldest).toISOString() : null;
  c.next_deletion = next ? new Date(next).toISOString() : null;
  c.sittings = [...sittings].map(([student_folder, g]) => ({
    student_folder, kinds: [...g.kinds].sort(), files: g.files, last_upload: g.last ? new Date(g.last).toISOString() : null,
  }));
  return c;
}

export type FolderUsage = {
  folder: string; bytes: number; objects: number; oldest: string | null;
  due_soon_bytes: number; due_soon_objects: number; next_deletion: string | null;
  counted_at: string | null; scan_started_at: string | null;
};
export type ExamStorage = {
  folder: string;
  examIds: string[];
  examName: string | null;
  /** When the folder was last counted; null means it hasn't been yet and has no figures. */
  countedAt: string | null;
  bytes: number;
  objects: number;
  oldest: string | null;
  /** Objects R2 deletes within a week, from the bucket's retention rule, as of the count. */
  dueSoonObjects: number;
  dueSoonBytes: number;
  nextDeletion: string | null;
};

/** Storage per exam folder from the stored counts. `folders` is what R2 holds now; a
 *  folder never counted is listed with no figures, so the totals say how much they cover. */
export function storageFromCounts(folders: string[], usage: FolderUsage[], exams: Pick<AdminExam, "id" | "name">[]) {
  const owners = new Map<string, Pick<AdminExam, "id" | "name">[]>();
  for (const e of exams) for (const f of examFolders(e)) owners.set(f, [...(owners.get(f) ?? []), e]);
  const byFolder = new Map(usage.map((u) => [u.folder, u]));
  const list: ExamStorage[] = folders.map((folder) => {
    const owner = owners.get(folder) ?? [];
    const u = byFolder.get(folder);
    const counted = !!u?.counted_at;
    return {
      folder, examIds: owner.map((e) => e.id), examName: owner[0]?.name ?? null,
      countedAt: counted ? u!.counted_at : null,
      bytes: counted ? Number(u!.bytes) : 0, objects: counted ? Number(u!.objects) : 0, oldest: counted ? u!.oldest : null,
      dueSoonObjects: counted ? Number(u!.due_soon_objects) : 0, dueSoonBytes: counted ? Number(u!.due_soon_bytes) : 0,
      nextDeletion: counted ? u!.next_deletion : null,
    };
  });
  const counted = list.filter((e) => e.countedAt);
  const sum = (k: "bytes" | "objects" | "dueSoonBytes" | "dueSoonObjects") => counted.reduce((s, e) => s + e[k], 0);
  return {
    exams: list.sort((a, b) => b.bytes - a.bytes || a.folder.localeCompare(b.folder)),
    folders: list.length,
    countedFolders: counted.length,
    uncounted: list.filter((e) => !e.countedAt).map((e) => e.folder),
    oldestCount: counted.reduce<string | null>((o, e) => (!o || e.countedAt! < o ? e.countedAt : o), null),
    totalBytes: sum("bytes"), totalObjects: sum("objects"), dueSoonBytes: sum("dueSoonBytes"), dueSoonObjects: sum("dueSoonObjects"),
  };
}

export type UploadState = "complete" | "uploading" | "partial" | "missing";
/** The kiosk keeps uploading recording parts for a while after submit. */
export const UPLOAD_GRACE_MS = 30 * 60_000;

export type KioskUpload = { attempt: AdminAttempt; version: string; kinds: string[]; files: number; lastUpload: string | null; state: UploadState };

/** A sitting with kiosk evidence: it was taken in the exam browser and submitted. */
export function isKioskSitting(a: AdminAttempt): boolean {
  const v = kioskVersion(a.user_agent);
  return a.state === "submitted" && !!v && v !== "web";
}

/** What each submitted kiosk sitting has in R2, from the counted student folders
 *  (`sittings`, keyed "<exam folder>/<student folder>"). The exam folder is the
 *  slugged exam name (or the exam id); the student folder is the roll (or the
 *  student id). A sitting is complete once a recording has arrived. */
export function kioskUploads(
  attempts: AdminAttempt[],
  exams: Pick<AdminExam, "id" | "name">[],
  rolls: Map<string, string>,
  sittings: Map<string, { kinds: string[]; files: number; last_upload: string | null }>,
  now: number,
): KioskUpload[] {
  const index = new Map([...sittings].map(([k, s]) => [k, { kinds: new Set(s.kinds), files: Number(s.files), last: ms(s.last_upload) }]));
  const nameOf = new Map(exams.map((e) => [e.id, e.name]));
  const out: KioskUpload[] = [];
  for (const a of attempts) {
    if (a.state !== "submitted") continue;
    const version = kioskVersion(a.user_agent);
    if (!version || version === "web") continue;
    const examFolders = new Set([slugifyFolderSegment(nameOf.get(a.exam_id) ?? ""), a.exam_id].filter(Boolean));
    const studentFolders = new Set([rolls.get(a.student_id) ?? "", a.student_id].filter(Boolean));
    const kinds = new Set<string>();
    let files = 0, last = 0;
    for (const ef of examFolders) for (const sf of studentFolders) {
      const g = index.get(`${ef}/${sf}`);
      if (!g) continue;
      g.kinds.forEach((k) => kinds.add(k));
      files += g.files;
      last = Math.max(last, g.last);
    }
    const recent = now - ms(a.submitted_at) < UPLOAD_GRACE_MS;
    const state: UploadState = kinds.has("recordings") ? "complete" : recent ? "uploading" : files ? "partial" : "missing";
    out.push({ attempt: a, version, kinds: [...kinds].sort(), files, lastUpload: last ? new Date(last).toISOString() : null, state });
  }
  return out;
}

export type Flag = { id: string; exam_id: string | null; attempt_id: string | null; student_id: string | null; violation_type: string; severity: string; source: string | null; created_at: string };

/** Serious flags nobody has reviewed yet. */
export function flagsAwaitingReview(flags: Flag[], reviewed: Set<string>): Flag[] {
  return flags.filter((f) => (f.severity === "high" || f.severity === "critical") && !reviewed.has(f.id));
}
