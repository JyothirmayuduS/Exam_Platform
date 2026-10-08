/**
 * Resume-after-disconnect: what to restore when the exam page opens on an
 * attempt that already exists, and the device-side copy of unsaved answers.
 *
 * The server attempt row is the source of truth. The `pending_sync_<examId>`
 * localStorage entry holds the newest answers that could not be saved; it is
 * merged in only when it is newer than the server copy and belongs to the
 * same student (a lab machine is shared between candidates).
 */

import type { AttemptSnapshot, ResumeState } from "@/shared/data/api/types";

export type { AttemptSnapshot, ResumeState };

export type PendingSync = {
  answers: Record<string, unknown>;
  answered: number;
  minutesUsed: number;
  sessionId?: string;
  isSubmit: boolean;
  /** Client clock (ms). Entries written before resume support have none. */
  savedAt?: number;
  studentId?: string;
  resume?: ResumeState;
};

export const PENDING_PREFIX = "pending_sync_";

export function readPending(examId: string): PendingSync | null {
  try {
    const raw = localStorage.getItem(PENDING_PREFIX + examId);
    if (!raw) return null;
    const data = JSON.parse(raw) as PendingSync;
    return data && typeof data === "object" && data.answers && typeof data.answers === "object" ? data : null;
  } catch {
    return null;
  }
}

export function writePending(examId: string, entry: PendingSync): void {
  try {
    localStorage.setItem(PENDING_PREFIX + examId, JSON.stringify({ ...entry, savedAt: entry.savedAt ?? Date.now() }));
  } catch {
    /* storage full or blocked: the server copy is all we have */
  }
}

/** Drop the device copy. A queued final submit survives an autosave success. */
export function clearPending(examId: string, opts: { keepSubmit?: boolean } = {}): void {
  try {
    if (opts.keepSubmit && readPending(examId)?.isSubmit) return;
    localStorage.removeItem(PENDING_PREFIX + examId);
  } catch {
    /* storage blocked */
  }
}

/**
 * One autosave: push to the server, otherwise keep the newest copy on this
 * device. A success clears the device copy so an older one is never replayed
 * over newer server answers (a queued final submit is kept).
 */
export async function saveOrQueue(
  examId: string,
  entry: PendingSync & { savedAt: number },
  save: (entry: PendingSync & { savedAt: number }) => Promise<boolean>,
): Promise<boolean> {
  let ok = false;
  try {
    ok = await save(entry);
  } catch {
    ok = false;
  }
  if (ok) clearPending(examId, { keepSubmit: true });
  else writePending(examId, entry);
  return ok;
}

export function listPending(): Array<[examId: string, entry: PendingSync]> {
  const out: Array<[string, PendingSync]> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PENDING_PREFIX)) continue;
      const examId = key.slice(PENDING_PREFIX.length);
      const entry = readPending(examId);
      if (entry) out.push([examId, entry]);
    }
  } catch {
    /* storage blocked */
  }
  return out;
}

/** Entries without a studentId predate resume support; they are only used to fill gaps. */
export function pendingBelongsTo(entry: PendingSync, studentId: string): boolean {
  return !entry.studentId || entry.studentId === studentId;
}

export type ResumePlan =
  | { kind: "fresh" }
  | { kind: "submitted" }
  /** Time is over, or the device holds a final submit that never landed. */
  | { kind: "submit"; answers: Record<string, unknown>; reason: "time_over" | "pending_submit" }
  | {
      kind: "resume";
      answers: Record<string, unknown>;
      resume: ResumeState | null;
      secondsLeft: number | null;
      /** True when the device copy was newer than the server's. */
      fromDevice: boolean;
    };

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

export function planResume(
  snap: AttemptSnapshot | null,
  pending: PendingSync | null,
  studentId: string,
): ResumePlan {
  const own = pending && pendingBelongsTo(pending, studentId) ? pending : null;
  const legacy = own ? !own.studentId || own.savedAt === undefined : false;

  if (!snap) {
    // The attempt row was never created (offline from the first click).
    if (own && !legacy) {
      return own.isSubmit
        ? { kind: "submit", answers: own.answers, reason: "pending_submit" }
        : { kind: "resume", answers: own.answers, resume: own.resume ?? null, secondsLeft: null, fromDevice: true };
    }
    return { kind: "fresh" };
  }
  if (snap.state === "submitted") return { kind: "submitted" };

  const newer = !!own && !legacy && (snap.autoSavedAt === null || (own.savedAt ?? 0) > snap.autoSavedAt);
  let answers: Record<string, unknown>;
  if (newer) {
    // The device copy is a full snapshot taken after the server's, so it
    // wins wholesale (keeps answers the student cleared, cleared).
    answers = { ...own!.answers };
  } else {
    answers = { ...snap.answers };
    if (own && legacy) {
      for (const [qid, v] of Object.entries(own.answers)) {
        if (isBlank(answers[qid]) && !isBlank(v)) answers[qid] = v;
      }
    }
  }
  const resume = (newer ? own!.resume : undefined) ?? snap.resume ?? null;

  if (newer && own!.isSubmit) return { kind: "submit", answers, reason: "pending_submit" };
  if (snap.secondsLeft !== null && snap.secondsLeft <= 0) return { kind: "submit", answers, reason: "time_over" };
  if (snap.state === "not_started" && !newer && Object.keys(answers).length === 0 && !resume) return { kind: "fresh" };
  return { kind: "resume", answers, resume, secondsLeft: snap.secondsLeft, fromDevice: newer };
}

/**
 * Timed sections keep running while the page is closed, like the overall
 * clock. Walk forward from the saved section by the time that passed.
 */
export function resumeSection(
  windows: ReadonlyArray<{ seconds: number }>,
  saved: Pick<ResumeState, "section" | "sectionSecondsLeft">,
  elapsedSec: number,
): { index: number; secondsLeft: number } {
  if (!windows.length) return { index: 0, secondsLeft: 0 };
  let index = Math.max(0, Math.min(windows.length - 1, Math.floor(saved.section)));
  let left = saved.sectionSecondsLeft ?? windows[index].seconds;
  let gone = Math.max(0, Math.floor(elapsedSec));
  while (gone >= left && index < windows.length - 1) {
    gone -= left;
    index += 1;
    left = windows[index].seconds;
  }
  return { index, secondsLeft: Math.max(0, left - gone) };
}
