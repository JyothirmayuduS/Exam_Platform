// Webcam snapshots wait on the device (the snapshot outbox) until they upload.
// Snapshots an earlier sitting left behind (the app closed after the
// 10-minute warning, a crash, a reload) upload only for the student they
// belong to, when that student is signed in; other students' snapshots stay
// on disk and are counted. A 403 stops the upload at once instead of retrying.
// A running exam capture owns its own folder: leftovers there are handed to it.
import { r2PutBlobResult } from "@/shared/services/r2Function";
import {
  createSnapshotOutbox,
  defaultSnapshotStore,
  isPermanentRefusal,
  type SnapshotOutbox,
  type SnapshotStore,
  type UploadResult,
} from "@/shared/services/snapshotOutbox";

const SNAPSHOT_KEY = /^(.+)\/([^/]+)\/screenshots\/(snap_\d+\.jpg)$/;
export const SNAPSHOT_RETRY_MS = 10_000;

export type SnapshotUpload = (key: string, blob: Blob) => Promise<UploadResult>;

/** Upload one stored snapshot; a permanent storage refusal is returned as such. */
export const uploadSnapshot: SnapshotUpload = async (key, blob) => {
  const m = key.match(SNAPSHOT_KEY);
  if (!m) return { refused: 400, reason: "invalid snapshot name", final: true };
  try {
    const res = await r2PutBlobResult({ examId: m[1], ownerSegment: m[2], kind: "screenshots", name: m[3], blob });
    if (res.key !== null) return true;
    return isPermanentRefusal(res.status) ? { refused: res.status!, reason: res.error } : false;
  } catch {
    return false;
  }
};

type Leftover = { outbox: SnapshotOutbox; timer: ReturnType<typeof setInterval> };

const leftovers = new Map<string, Leftover>();
const captures = new Set<string>();

function dropLeftover(prefix: string): Leftover | undefined {
  const l = leftovers.get(prefix);
  if (!l) return undefined;
  clearInterval(l.timer);
  leftovers.delete(prefix);
  return l;
}

/**
 * A live exam capture takes over its snapshot folder. Resolves with any
 * leftover snapshots held only in memory once the leftover uploader settles.
 */
export function claimSnapshotFolder(prefix: string): Promise<Map<string, Blob>> | undefined {
  captures.add(prefix);
  return dropLeftover(prefix)?.outbox.retire();
}

/** The capture finished draining its folder. */
export function releaseSnapshotFolder(prefix: string): void {
  captures.delete(prefix);
}

export type LeftoverSnapshotReport = {
  /** Snapshot folders now uploading (they belong to the signed-in student). */
  resumed: string[];
  /** Snapshots kept on this device for students who are not signed in. */
  waiting: number;
  waitingOwners: string[];
};

/**
 * Upload webcam snapshots left on this device, only those of the student
 * signed in now (`owners`: their roll number and student id).
 */
export async function resumeLeftoverSnapshots(opts: {
  owners: string[];
  store?: SnapshotStore;
  upload?: SnapshotUpload;
  log?: (message: string) => void;
}): Promise<LeftoverSnapshotReport> {
  const report: LeftoverSnapshotReport = { resumed: [], waiting: 0, waitingOwners: [] };
  const store = opts.store ?? defaultSnapshotStore();
  if (!store) return report;
  let keys: string[];
  try { keys = await store.keys(""); } catch { return report; }
  const mine = new Set(opts.owners.filter(Boolean));
  const folders = new Set<string>();
  const waitingOwners = new Set<string>();
  for (const key of keys) {
    const m = key.match(SNAPSHOT_KEY);
    if (!m) continue;
    if (!mine.has(m[2])) {
      report.waiting += 1;
      waitingOwners.add(m[2]);
      continue;
    }
    folders.add(`${m[1]}/${m[2]}/screenshots/`);
  }
  report.waitingOwners = [...waitingOwners];
  const log = opts.log ?? ((msg: string) => console.info(`[snapshots] ${msg}`));
  if (report.waiting > 0) {
    log(`${report.waiting} camera snapshot(s) from ${waitingOwners.size} other student(s) are waiting on this PC; they upload when that student signs in here.`);
  }
  for (const prefix of folders) {
    if (leftovers.has(prefix) || captures.has(prefix)) continue;
    const outbox = createSnapshotOutbox({
      prefix,
      store,
      upload: opts.upload ?? uploadSnapshot,
      pendingMessage: "Some camera snapshots from an earlier exam are waiting to upload.",
      haltOn: [403],
      onHalt: () => {
        dropLeftover(prefix);
        log(`Storage refused the leftover snapshots under ${prefix} (HTTP 403); they stay on this PC.`);
      },
      onIdle: () => { if (outbox.pendingCount() === 0) dropLeftover(prefix); },
    });
    leftovers.set(prefix, { outbox, timer: setInterval(() => outbox.retry(), SNAPSHOT_RETRY_MS) });
    report.resumed.push(prefix);
  }
  if (report.resumed.length > 0) log(`Uploading leftover camera snapshots: ${report.resumed.join(", ")}`);
  return report;
}

/** Signed out: stop uploading leftover snapshots (they stay on disk for next time). */
export function stopLeftoverSnapshots(): void {
  for (const prefix of [...leftovers.keys()]) void dropLeftover(prefix)?.outbox.retire();
}
