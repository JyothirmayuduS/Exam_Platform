// Evidence and results retention. The site keeps everything for the retention
// period (retention_settings, 1825 days by default) and this job is the only
// thing that deletes it afterwards:
//   • results, marks and violation rows, through retention_db_batch (SQL), and
//     audit log entries the same way;
//   • evidence files (recordings, snapshots, answer sheets, violation frames)
//     under "<exam folder>/<student folder>/…" in every evidence store.
// Held items are never deleted: an attempt on a malpractice hold, an exam or
// student on a legal hold, an open appeal, or a serious flag not yet reviewed.
// Nor is anything in a folder that matches no exam, or no single student with
// an attempt in that exam: those are kept and reported as unmatched.
// Age always counts from the original upload (or submission) time.

export const DAY = 86_400_000;
export const MIN_DAYS = 30;
export const MAX_DAYS = 3650;

export type StoredObject = { key: string; uploadedAt: string | null };
export type Page<T> = { items: T[]; next: string | null };

export interface EvidenceStore {
  name: string;
  /** Sub-folder names directly under `prefix` ("" for the top level), without slashes. */
  folders(prefix: string, token: string | null): Promise<Page<string>>;
  /** Every file under `prefix`, at any depth. */
  objects(prefix: string, token: string | null): Promise<Page<StoredObject>>;
  /** Deletes the keys; returns the ones that could not be deleted. */
  remove(keys: string[]): Promise<{ failed: string[] }>;
}

export type DbKind = "violation_events" | "attempts" | "audit_logs";
export const DB_KINDS: DbKind[] = ["violation_events", "attempts", "audit_logs"];
export type DbBatch = { due: number; skipped: number; deleted: number; more: boolean };

export type RunStatus = "running" | "succeeded" | "partial" | "failed";
export type RunTotals = { deleted: number; skipped: number; failed: number; due_week: number };
export type StoreDetail = RunTotals & {
  folders_total: number; folders_done: number; held: Record<string, number>;
  /** Folders matching no exam ("<exam folder>/") or no single student with an attempt ("<exam folder>/<student folder>/"); kept. */
  unmatched: string[]; unmatched_total: number;
};
export const UNMATCHED = ["unmatched_exam", "unmatched_student"];
export type RunDetail = {
  db: Record<string, RunTotals>;
  storage: Record<string, StoreDetail>;
  errors: string[];
  resume: string | null;
};

export interface RetentionDb {
  retentionDays(): Promise<number>;
  /** Where an unfinished run stopped ("<store>\n<exam folder>"), or null. */
  cursor(): Promise<string | null>;
  setCursor(cursor: string | null): Promise<void>;
  /** Hold reason per student folder of one exam folder; null when nothing is held. */
  folderStatus(folder: string, students: string[]): Promise<Map<string, string | null>>;
  /** A dry run or `limit` 0 counts every row past `cutoffIso` (due and held); otherwise deletes one batch and reports only it. */
  dbBatch(kind: DbKind, cutoffIso: string, limit: number, dryRun: boolean): Promise<DbBatch>;
  startRun(run: { dry_run: boolean; trigger: "schedule" | "admin"; requested_by: string | null; retention_days: number; cutoff: string }): Promise<number>;
  finishRun(id: number, patch: RunTotals & { status: RunStatus; complete: boolean; finished_at: string; detail: RunDetail }): Promise<void>;
}

export type RunOptions = {
  dryRun: boolean;
  trigger: "schedule" | "admin";
  requestedBy: string | null;
  /** Stop starting new work after this long; the next run resumes where this one stopped. */
  budgetMs: number;
  /** Files per delete batch. */
  batchSize?: number;
  /** Database rows per delete batch. */
  dbBatchSize?: number;
  /** Student folders checked for holds per query. */
  studentChunk?: number;
};

export type RunSummary = RunTotals & {
  id: number; dryRun: boolean; status: RunStatus; complete: boolean;
  retentionDays: number; cutoff: string; detail: RunDetail;
};

const MAX_ERRORS = 50;
const MAX_UNMATCHED = 200;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const totals = (): RunTotals => ({ deleted: 0, skipped: 0, failed: 0, due_week: 0 });

async function allPages<T>(read: (token: string | null) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let token: string | null = null;
  do {
    const page: Page<T> = await read(token);
    out.push(...page.items);
    token = page.next;
  } while (token);
  return out;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function runRetention(
  deps: { stores: EvidenceStore[]; db: RetentionDb; now: () => number },
  opts: RunOptions,
): Promise<RunSummary> {
  const { stores, db } = deps;
  const batchSize = opts.batchSize ?? 100;
  const dbBatchSize = opts.dbBatchSize ?? 500;
  const studentChunk = opts.studentChunk ?? 200;
  const dry = opts.dryRun;

  const start = deps.now();
  const days = await db.retentionDays();
  const cutoff = start - days * DAY;
  const weekCutoff = cutoff + 7 * DAY;
  const cutoffIso = new Date(cutoff).toISOString();
  const weekIso = new Date(weekCutoff).toISOString();
  const id = await db.startRun({ dry_run: dry, trigger: opts.trigger, requested_by: opts.requestedBy, retention_days: days, cutoff: cutoffIso });

  const detail: RunDetail = { db: {}, storage: {}, errors: [], resume: null };
  const note = (where: string, e: unknown) => {
    if (detail.errors.length < MAX_ERRORS) detail.errors.push(`${where}: ${message(e)}`);
  };
  const outOfTime = () => deps.now() - start >= opts.budgetMs;
  const unmatchedSeen = new Map<string, Set<string>>();
  let complete = true;
  let crashed = false;

  try {
    for (const kind of DB_KINDS) {
      const d = (detail.db[kind] = totals());
      try {
        d.due_week = (await db.dbBatch(kind, weekIso, 0, true)).due;
      } catch (e) {
        note(`${kind} (due this week)`, e);
      }
      try {
        const count = await db.dbBatch(kind, cutoffIso, 0, true);
        d.skipped = count.skipped;
        if (dry) {
          d.deleted = count.due;
          continue;
        }
        while (count.due > 0) {
          const r = await db.dbBatch(kind, cutoffIso, dbBatchSize, false);
          d.deleted += r.deleted;
          if (!r.more) break;
          if (outOfTime()) { complete = false; break; }
        }
      } catch (e) {
        d.failed += 1;
        note(kind, e);
      }
      d.due_week = Math.max(0, d.due_week - (dry ? 0 : d.deleted));
    }

    const cursor = dry ? null : await db.cursor().catch(() => null);
    const [cStore, cFolder] = cursor ? cursor.split("\n") : [null, null];
    const cIndex = cStore ? stores.findIndex((s) => s.name === cStore) : -1;

    stores: for (const [index, store] of stores.entries()) {
      const s: StoreDetail = (detail.storage[store.name] = { ...totals(), folders_total: 0, folders_done: 0, held: {}, unmatched: [], unmatched_total: 0 });
      if (index < cIndex) continue;
      let folders: string[];
      try {
        folders = (await allPages((t) => store.folders("", t))).sort();
      } catch (e) {
        s.failed += 1;
        note(`${store.name}: listing exam folders`, e);
        continue;
      }
      s.folders_total = folders.length;
      for (const folder of folders) {
        if (index === cIndex && cFolder && folder < cFolder) continue;
        if (outOfTime()) {
          complete = false;
          detail.resume = `${store.name}\n${folder}`;
          break stores;
        }
        await sweepFolder(store, folder, s);
        s.folders_done += 1;
      }
      s.due_week = Math.max(0, s.due_week - (dry ? 0 : s.deleted));
    }
  } catch (e) {
    crashed = true;
    note("run", e);
  }

  async function sweepFolder(store: EvidenceStore, folder: string, s: StoreDetail) {
    let token: string | null = null;
    do {
      let page: Page<string>;
      try {
        page = await store.folders(`${folder}/`, token);
      } catch (e) {
        s.failed += 1;
        note(`${store.name}: listing ${folder}`, e);
        return;
      }
      for (const group of chunks(page.items, studentChunk)) {
        let holds: Map<string, string | null>;
        try {
          holds = await db.folderStatus(folder, group);
        } catch (e) {
          s.failed += 1;
          note(`${store.name}: checking holds in ${folder}`, e);
          continue;
        }
        for (const student of group) {
          await sweepStudent(store, folder, student, holds.has(student) ? holds.get(student)! : "unchecked", s);
        }
      }
      token = page.next;
    } while (token);
  }

  async function sweepStudent(store: EvidenceStore, folder: string, student: string, hold: string | null, s: StoreDetail) {
    const prefix = `${folder}/${student}/`;
    if (hold && UNMATCHED.includes(hold)) {
      const path = hold === "unmatched_exam" ? `${folder}/` : prefix;
      const seen = unmatchedSeen.get(store.name) ?? new Set<string>();
      unmatchedSeen.set(store.name, seen);
      if (!seen.has(path)) {
        seen.add(path);
        s.unmatched_total += 1;
        if (s.unmatched.length < MAX_UNMATCHED) s.unmatched.push(path);
      }
    }
    const pending: string[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending.splice(0);
      if (dry) { s.deleted += batch.length; return; }
      try {
        const { failed } = await store.remove(batch);
        s.deleted += batch.length - failed.length;
        s.failed += failed.length;
        if (failed.length) note(`${store.name}: ${prefix}`, `${failed.length} of ${batch.length} files not deleted`);
      } catch (e) {
        s.failed += batch.length;
        note(`${store.name}: deleting ${batch.length} files in ${prefix}`, e);
      }
    };
    const skip = (reason: string) => {
      s.skipped += 1;
      s.held[reason] = (s.held[reason] ?? 0) + 1;
    };
    let token: string | null = null;
    do {
      let page: Page<StoredObject>;
      try {
        page = await store.objects(prefix, token);
      } catch (e) {
        s.failed += 1;
        note(`${store.name}: listing ${prefix}`, e);
        break;
      }
      for (const o of page.items) {
        const at = Date.parse(o.uploadedAt ?? "");
        if (!Number.isFinite(at)) { skip("no_upload_date"); continue; }
        if (at >= weekCutoff) continue;
        if (hold) { if (at < cutoff) skip(hold); continue; }
        s.due_week += 1;
        if (at < cutoff) {
          pending.push(o.key);
          if (pending.length >= batchSize) await flush();
        }
      }
      token = page.next;
    } while (token);
    await flush();
  }

  const sum = totals();
  for (const t of [...Object.values(detail.db), ...Object.values(detail.storage)]) {
    sum.deleted += t.deleted;
    sum.skipped += t.skipped;
    sum.failed += t.failed;
    sum.due_week += t.due_week;
  }
  const status: RunStatus = crashed ? "failed" : sum.failed > 0 || !complete ? "partial" : "succeeded";
  if (crashed) complete = false;

  if (!dry && !crashed) await db.setCursor(complete ? null : detail.resume).catch((e) => note("saving resume point", e));
  await db.finishRun(id, { ...sum, status, complete, finished_at: new Date(deps.now()).toISOString(), detail });
  return { id, dryRun: dry, status, complete, retentionDays: days, cutoff: cutoffIso, detail, ...sum };
}
