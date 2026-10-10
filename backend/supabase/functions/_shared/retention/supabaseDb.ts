// RetentionDb over the service-role Supabase client (SQL in
// migrations/20261011000000_evidence_retention.sql).
import type { DbBatch, DbKind, RetentionDb, RunDetail, RunStatus, RunTotals } from "./job.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export type RunRow = Omit<RunTotals, "due_week"> & {
  due_week: number | null; id: number; started_at: string; finished_at: string | null; dry_run: boolean; trigger: "schedule" | "admin";
  requested_by: string | null; retention_days: number; cutoff: string; status: RunStatus; complete: boolean; detail: RunDetail | null;
};
export type LegalHold = { id: string; target_type: "exam" | "student"; target_id: string; reason: string | null; placed_by: string | null; placed_at: string };
export type RetentionSettings = { retention_days: number; updated_at: string | null; updated_by: string | null };

export interface RetentionAdminDb extends RetentionDb {
  settings(): Promise<RetentionSettings>;
  /** Raises admins_only / out of range errors from SQL. */
  setRetentionDays(days: number, actor: string): Promise<void>;
  /** False when the hold was already in that state. Throws target_not_found. */
  setLegalHold(type: "exam" | "student", target: string, on: boolean, reason: string | null, actor: string): Promise<boolean>;
  legalHolds(): Promise<LegalHold[]>;
  runs(limit: number): Promise<RunRow[]>;
  run(id: number): Promise<RunRow | null>;
}

const RUN_COLS = "id, started_at, finished_at, dry_run, trigger, requested_by, retention_days, cutoff, status, complete, deleted, skipped, failed, due_week, detail";

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    const err = new Error(res.error.message) as Error & { code?: string };
    err.code = res.error.code;
    throw err;
  }
  return res.data;
}

export function supabaseRetentionDb(db: Db): RetentionAdminDb {
  return {
    async retentionDays() {
      return Number(check(await db.rpc("retention_days")));
    },
    async cursor() {
      const row = check(await db.from("retention_settings").select("storage_cursor").eq("id", true).maybeSingle()) as { storage_cursor: string | null } | null;
      return row?.storage_cursor ?? null;
    },
    async setCursor(cursor) {
      check(await db.from("retention_settings").update({ storage_cursor: cursor }).eq("id", true));
    },
    async folderStatus(folder, students) {
      const rows = check(await db.rpc("retention_folder_status", { p_folder: folder, p_students: students })) as { student_folder: string; hold: string | null }[];
      return new Map((rows ?? []).map((r) => [r.student_folder, r.hold]));
    },
    async dbBatch(kind: DbKind, cutoffIso: string, limit: number, dryRun: boolean): Promise<DbBatch> {
      const r = check(await db.rpc("retention_db_batch", { p_kind: kind, p_cutoff: cutoffIso, p_limit: limit, p_dry_run: dryRun })) as DbBatch;
      return { due: Number(r.due ?? 0), skipped: Number(r.skipped ?? 0), deleted: Number(r.deleted ?? 0), more: !!r.more };
    },
    async startRun(run) {
      const row = check(await db.from("retention_runs").insert(run).select("id").single()) as { id: number };
      return row.id;
    },
    async finishRun(id, patch) {
      check(await db.from("retention_runs").update(patch).eq("id", id));
    },
    async settings() {
      const row = check(await db.from("retention_settings").select("retention_days, updated_at, updated_by").eq("id", true).maybeSingle()) as RetentionSettings | null;
      return row ?? { retention_days: 1825, updated_at: null, updated_by: null };
    },
    async setRetentionDays(days, actor) {
      check(await db.rpc("set_retention_days", { p_days: days, p_actor: actor }));
    },
    async setLegalHold(type, target, on, reason, actor) {
      return !!check(await db.rpc("set_legal_hold", { p_type: type, p_target: target, p_on: on, p_reason: reason, p_actor: actor }));
    },
    async legalHolds() {
      return (check(await db.from("legal_holds").select("id, target_type, target_id, reason, placed_by, placed_at").is("lifted_at", null).order("placed_at", { ascending: false })) ?? []) as LegalHold[];
    },
    async runs(limit) {
      return (check(await db.from("retention_runs").select(RUN_COLS).order("started_at", { ascending: false }).limit(limit)) ?? []) as RunRow[];
    },
    async run(id) {
      return (check(await db.from("retention_runs").select(RUN_COLS).eq("id", id).maybeSingle()) ?? null) as RunRow | null;
    },
  };
}
