// @vitest-environment node
// The retention job: what it deletes, what it keeps, dry runs, failures,
// resuming after the time budget; the evidence stores; the cron entry point.
import { describe, expect, it } from "vitest";
import { DAY, runRetention, type DbBatch, type DbKind, type EvidenceStore, type RetentionDb, type RunStatus } from "./job.ts";
import { createRetentionCronHandler, sameSecret } from "./cronHandler.ts";
import { conflictingRules, parseLifecycle, r2Lifecycle, r2Store, supabaseStore } from "./stores.ts";

const NOW = Date.parse("2026-10-10T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

/** Keys page by "start after", like R2 continuation tokens, so deleting while listing is safe. */
function memoryStore(name: string, files: Record<string, string | null>, opts: {
  pageSize?: number; onRemove?: (keys: string[], call: number) => true | string[] | void; onObjects?: () => void; failFolders?: boolean;
} = {}) {
  const map = new Map(Object.entries(files));
  const removeCalls: string[][] = [];
  const size = opts.pageSize ?? 1000;
  function page<T>(list: { k: string; v: T }[], token: string | null) {
    const rest = list.filter((x) => !token || x.k > token);
    const items = rest.slice(0, size);
    return { items: items.map((x) => x.v), next: rest.length > size ? items[items.length - 1].k : null };
  }
  const store: EvidenceStore = {
    name,
    async folders(prefix, token) {
      if (opts.failFolders) throw new Error("Storage list failed: timeout");
      const names = [...new Set([...map.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/"))
        .filter((p) => p.length > 1).map((p) => p[0]))].sort();
      return page(names.map((n) => ({ k: n, v: n })), token);
    },
    async objects(prefix, token) {
      opts.onObjects?.();
      const list = [...map.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      return page(list.map(([key, uploadedAt]) => ({ k: key, v: { key, uploadedAt } })), token);
    },
    async remove(keys) {
      removeCalls.push([...keys]);
      const r = opts.onRemove?.(keys, removeCalls.length);
      if (r === true) throw new Error("R2 delete failed: HTTP 500");
      const failed = Array.isArray(r) ? r : [];
      for (const k of keys) if (!failed.includes(k)) map.delete(k);
      return { failed };
    },
  };
  return { store, files: map, removeCalls };
}

type Run = Record<string, unknown> & { id: number; status?: RunStatus; detail?: { errors: string[]; storage: Record<string, { held: Record<string, number> }> } };

function fakeDb(opts: { holds?: Record<string, string | null>; days?: number; batch?: (kind: DbKind, cutoff: string, limit: number, dry: boolean) => DbBatch; over?: Partial<RetentionDb> } = {}) {
  const runs: Run[] = [];
  const batches: { kind: DbKind; cutoff: string; limit: number; dry: boolean }[] = [];
  const state = { cursor: null as string | null };
  const db: RetentionDb = {
    retentionDays: async () => opts.days ?? 1825,
    cursor: async () => state.cursor,
    setCursor: async (c) => { state.cursor = c; },
    folderStatus: async (folder, students) => new Map(students.filter((s) => s !== "UNCHECKED").map((s) => [s, opts.holds?.[`${folder}/${s}`] ?? null])),
    dbBatch: async (kind, cutoff, limit, dry) => {
      batches.push({ kind, cutoff, limit, dry });
      return opts.batch?.(kind, cutoff, limit, dry) ?? { due: 0, skipped: 0, deleted: 0, more: false };
    },
    startRun: async (r) => { runs.push({ ...r, id: runs.length + 1 }); return runs.length; },
    finishRun: async (id, patch) => { Object.assign(runs[id - 1], patch); },
    ...opts.over,
  };
  return { db, runs, batches, state };
}

const run = (stores: EvidenceStore[], db: RetentionDb, over: Partial<Parameters<typeof runRetention>[1]> = {}, now: () => number = () => NOW) =>
  runRetention({ stores, db, now }, { dryRun: false, trigger: "schedule", requestedBy: null, budgetMs: 60_000, ...over });

const FILES = {
  "EX-1/R1/screenshots/old.jpg": daysAgo(2000),
  "EX-1/R1/recordings/young.webm": daysAgo(1000),
  "EX-1/R1/violations/just-expired.jpg": daysAgo(1826),
  "EX-1/R1/subjective/expires-in-3-days.pdf": daysAgo(1822),
  "EX-1/R2/screenshots/held.jpg": daysAgo(2000),
  "EX-2/R3/recordings/legal.webm": daysAgo(2000),
  "EX-1/R4/report/no-date.pdf": null,
  "EX-1/UNCHECKED/a.jpg": daysAgo(2000),
  "EX-1/loose.txt": daysAgo(2000),
};
const HOLDS = { "EX-1/R2": "malpractice_hold", "EX-2/R3": "legal_hold" };

describe("retention job: evidence files", () => {
  it("deletes only files older than the retention period, and nothing held", async () => {
    const r2 = memoryStore("r2", FILES);
    const { db, runs } = fakeDb({ holds: HOLDS });
    const s = await run([r2.store], db);
    expect([...r2.files.keys()].sort()).toEqual([
      "EX-1/R1/recordings/young.webm", "EX-1/R1/subjective/expires-in-3-days.pdf", "EX-1/R2/screenshots/held.jpg",
      "EX-1/R4/report/no-date.pdf", "EX-1/UNCHECKED/a.jpg", "EX-1/loose.txt", "EX-2/R3/recordings/legal.webm",
    ]);
    expect(s).toMatchObject({ status: "succeeded", complete: true, deleted: 2, skipped: 4, failed: 0, due_week: 1, retentionDays: 1825, cutoff: daysAgo(1825) });
    expect(s.detail.storage.r2.held).toEqual({ malpractice_hold: 1, legal_hold: 1, no_upload_date: 1, unchecked: 1 });
    expect(runs[0]).toMatchObject({ dry_run: false, trigger: "schedule", retention_days: 1825, status: "succeeded", deleted: 2, skipped: 4, failed: 0 });
  });

  it("uses the configured period", async () => {
    const r2 = memoryStore("r2", FILES);
    const s = await run([r2.store], fakeDb({ holds: HOLDS, days: 3650 }).db);
    expect(s.deleted).toBe(0);
    expect(r2.files.size).toBe(Object.keys(FILES).length);
  });

  it("a dry run deletes nothing and counts what a real run would delete", async () => {
    const r2 = memoryStore("r2", FILES);
    const { db, batches, state, runs } = fakeDb({ holds: HOLDS, batch: () => ({ due: 4, skipped: 1, deleted: 0, more: false }) });
    state.cursor = "r2\nEX-2";
    const s = await run([r2.store], db, { dryRun: true, trigger: "admin", requestedBy: "admin-1" });
    expect(r2.removeCalls).toEqual([]);
    expect(r2.files.size).toBe(Object.keys(FILES).length);
    expect(s).toMatchObject({ dryRun: true, status: "succeeded", due_week: 3 * 4 + 3 });
    expect(s.detail.storage.r2).toMatchObject({ deleted: 2, skipped: 4, due_week: 3 });
    expect(s.detail.db.attempts).toEqual({ deleted: 4, skipped: 1, failed: 0, due_week: 4 });
    expect(batches.every((b) => b.dry && b.limit === 0)).toBe(true);
    expect(state.cursor).toBe("r2\nEX-2");
    expect(runs[0]).toMatchObject({ dry_run: true, trigger: "admin", requested_by: "admin-1" });
  });

  it("pages through folders and deletes in batches", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++) files[`EX-1/R${String(i % 5)}/screenshots/${String(i).padStart(2, "0")}.jpg`] = daysAgo(1900);
    const r2 = memoryStore("r2", files, { pageSize: 3 });
    const s = await run([r2.store], fakeDb().db, { batchSize: 2, studentChunk: 2 });
    expect(r2.files.size).toBe(0);
    expect(s.deleted).toBe(25);
    expect(r2.removeCalls.every((b) => b.length <= 2)).toBe(true);
  });

  it("logs a failed batch and keeps going", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`EX-1/R1/s/${i}.jpg`] = daysAgo(1900);
    files["EX-2/R2/s/a.jpg"] = daysAgo(1900);
    files["EX-2/R2/s/b.jpg"] = daysAgo(1900);
    const r2 = memoryStore("r2", files, { onRemove: (keys, call) => (call === 1 ? true : call === 3 ? [keys[0]] : undefined) });
    const s = await run([r2.store], fakeDb().db, { batchSize: 2 });
    expect(s).toMatchObject({ status: "partial", complete: true, deleted: 5, failed: 3 });
    expect([...r2.files.keys()].sort()).toEqual(["EX-1/R1/s/0.jpg", "EX-1/R1/s/1.jpg", "EX-1/R1/s/4.jpg"]);
    expect(s.detail.errors).toEqual([
      "r2: deleting 2 files in EX-1/R1/: R2 delete failed: HTTP 500",
      "r2: EX-1/R1/: 1 of 2 files not deleted",
    ]);
  });

  it("never deletes files whose holds could not be checked, and carries on", async () => {
    const r2 = memoryStore("r2", { "EX-1/R1/a.jpg": daysAgo(1900), "EX-2/R2/a.jpg": daysAgo(1900) });
    const { db, runs } = fakeDb({ over: { folderStatus: async (folder, students) => {
      if (folder === "EX-1") throw new Error("statement timeout");
      return new Map(students.map((x) => [x, null]));
    } } });
    const s = await run([r2.store], db);
    expect([...r2.files.keys()]).toEqual(["EX-1/R1/a.jpg"]);
    expect(s).toMatchObject({ status: "partial", deleted: 1, failed: 1 });
    expect(runs[0].detail!.errors).toEqual(["r2: checking holds in EX-1: statement timeout"]);
  });

  it("sweeps every store even when one cannot be listed", async () => {
    const broken = memoryStore("storage:exam-records", {}, { failFolders: true });
    const r2 = memoryStore("r2", { "EX-1/R1/a.jpg": daysAgo(1900) });
    const s = await run([broken.store, r2.store], fakeDb().db);
    expect(r2.files.size).toBe(0);
    expect(s).toMatchObject({ status: "partial", deleted: 1, failed: 1 });
    expect(s.detail.errors[0]).toMatch(/^storage:exam-records: listing exam folders/);
  });

  it("stops at the time budget and the next run resumes where it stopped", async () => {
    let t = NOW;
    const files = { "A/R/1.jpg": daysAgo(1900), "B/R/1.jpg": daysAgo(1900), "C/R/1.jpg": daysAgo(1900) };
    const r2 = memoryStore("r2", files, { onObjects: () => { t += 40_000; } });
    const fake = fakeDb();
    const first = await run([r2.store], fake.db, {}, () => t);
    expect(first).toMatchObject({ status: "partial", complete: false, deleted: 2 });
    expect(fake.state.cursor).toBe("r2\nC");
    expect([...r2.files.keys()]).toEqual(["C/R/1.jpg"]);

    r2.files.set("A/R/2.jpg", daysAgo(1900));
    t = NOW;
    const second = await run([r2.store], fake.db, {}, () => t);
    expect(second).toMatchObject({ status: "succeeded", complete: true, deleted: 1 });
    expect([...r2.files.keys()]).toEqual(["A/R/2.jpg"]);
    expect(fake.state.cursor).toBeNull();
  });
});

describe("retention job: results, marks, violations and audit logs", () => {
  it("deletes each kind in batches until none remain, past the cutoff only", async () => {
    let left = 5;
    const { db, batches } = fakeDb({ batch: (kind, _c, limit, dry) => {
      if (kind !== "attempts" || dry) return { due: kind === "attempts" ? left : 0, skipped: 2, deleted: 0, more: false };
      const n = Math.min(limit, left);
      left -= n;
      return { due: left + n, skipped: 2, deleted: n, more: left > 0 };
    } });
    const s = await run([], db, { dbBatchSize: 2 });
    expect(s.detail.db.attempts).toEqual({ deleted: 5, skipped: 2, failed: 0, due_week: 0 });
    expect(batches.filter((b) => b.kind === "attempts" && !b.dry).map((b) => [b.cutoff, b.limit])).toEqual([
      [daysAgo(1825), 2], [daysAgo(1825), 2], [daysAgo(1825), 2],
    ]);
    expect(batches.filter((b) => b.dry).map((b) => [b.kind, b.cutoff])).toEqual([
      ["violation_events", daysAgo(1818)], ["attempts", daysAgo(1818)], ["audit_logs", daysAgo(1818)],
    ]);
  });

  it("logs a failed kind and carries on with the others and the files", async () => {
    const r2 = memoryStore("r2", { "EX-1/R1/a.jpg": daysAgo(1900) });
    const { db, batches } = fakeDb({ batch: (kind, _c, _l, dry) => {
      if (kind === "violation_events" && !dry) throw new Error("deadlock detected");
      return { due: 1, skipped: 0, deleted: dry ? 0 : 1, more: false };
    } });
    const s = await run([r2.store], db);
    expect(s.detail.db.violation_events.failed).toBe(1);
    expect(s.detail.db.attempts.deleted).toBe(1);
    expect(s.detail.db.audit_logs.deleted).toBe(1);
    expect(r2.files.size).toBe(0);
    expect(s.detail.errors).toEqual(["violation_events: deadlock detected"]);
    expect(s.status).toBe("partial");
    expect(batches.some((b) => b.kind === "audit_logs" && !b.dry)).toBe(true);
  });

  it("finishes and records the run when the resume point and a store cannot be read", async () => {
    const { db, runs } = fakeDb({ over: { cursor: async () => { throw new Error("x"); } } });
    const s = await run([{ ...memoryStore("r2", {}).store, folders: () => { throw new Error("boom"); } }], db);
    expect(s.status).toBe("partial");
    expect(runs[0].status).toBe("partial");
  });
});

describe("evidence stores", () => {
  const signer = { sign: async (r: Request) => r };
  const xml = (body: string) => new Response(`<?xml version="1.0"?><ListBucketResult>${body}</ListBucketResult>`);

  it("R2: lists exam and student folders, files with upload dates, and reports keys it could not delete", async () => {
    const seen: string[] = [];
    const fetcher = (async (req: Request) => {
      seen.push(`${req.method} ${req.url}`);
      const url = new URL(req.url);
      if (req.method === "DELETE") return new Response(null, { status: url.pathname.endsWith("bad.jpg") ? 500 : url.pathname.endsWith("gone.jpg") ? 404 : 204 });
      if (url.searchParams.get("delimiter")) return xml(`<CommonPrefixes><Prefix>EX-1/R1/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>EX-1/R&amp;2/</Prefix></CommonPrefixes><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken>`);
      return xml(`<Contents><Key>EX-1/R1/s/a.jpg</Key><Size>3</Size><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents><IsTruncated>false</IsTruncated>`);
    }) as typeof fetch;
    const store = r2Store({ aws: signer, endpoint: "https://r2", bucket: "b" }, fetcher);
    expect(await store.folders("EX-1/", null)).toEqual({ items: ["R1", "R&2"], next: "t1" });
    expect(await store.objects("EX-1/R1/", null)).toEqual({ items: [{ key: "EX-1/R1/s/a.jpg", uploadedAt: "2020-01-01T00:00:00.000Z" }], next: null });
    expect(await store.remove(["EX-1/R1/s/ok.jpg", "EX-1/R1/s/bad.jpg", "EX-1/R 1/gone.jpg"])).toEqual({ failed: ["EX-1/R1/s/bad.jpg"] });
    expect(seen).toContain("DELETE https://r2/b/EX-1/R%201/gone.jpg");
  });

  it("Supabase Storage: walks sub-folders and lists every file with its upload date", async () => {
    const tree: Record<string, { name: string; id: string | null; created_at?: string }[]> = {
      "EX-1": [{ name: "R1", id: null }],
      "EX-1/R1": [{ name: "screenshots", id: null }, { name: "recording.webm", id: "1", created_at: "2020-01-01T00:00:00Z" }],
      "EX-1/R1/screenshots": [{ name: "a.jpg", id: "2", created_at: "2020-02-01T00:00:00Z" }, { name: ".emptyFolderPlaceholder", id: "3" }],
    };
    const removed: string[][] = [];
    const store = supabaseStore("exam-records", {
      list: async (path) => ({ data: tree[path] ?? [], error: null }),
      remove: async (paths) => { removed.push(paths); return { data: null, error: null }; },
    });
    expect(store.name).toBe("storage:exam-records");
    expect(await store.folders("EX-1/", null)).toEqual({ items: ["R1"], next: null });
    expect((await store.objects("EX-1/R1/", null)).items).toEqual([
      { key: "EX-1/R1/recording.webm", uploadedAt: "2020-01-01T00:00:00Z" },
      { key: "EX-1/R1/screenshots/a.jpg", uploadedAt: "2020-02-01T00:00:00Z" },
    ]);
    await store.remove(["EX-1/R1/recording.webm"]);
    expect(removed).toEqual([["EX-1/R1/recording.webm"]]);
  });

  it("reads the R2 lifecycle rule and flags one that deletes before the app would", async () => {
    const rules = parseLifecycle(`<LifecycleConfiguration><Rule><ID>exam-artifacts-retention</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><Expiration><Days>90</Days></Expiration></Rule><Rule><ID>old</ID><Status>Disabled</Status><Expiration><Days>10</Days></Expiration></Rule></LifecycleConfiguration>`);
    expect(rules).toEqual([{ id: "exam-artifacts-retention", enabled: true, prefix: "", days: 90 }, { id: "old", enabled: false, prefix: "", days: 10 }]);
    expect(conflictingRules(rules, 1825).map((r) => r.id)).toEqual(["exam-artifacts-retention"]);
    expect(conflictingRules([{ id: "x", enabled: true, prefix: "", days: 2000 }], 1825)).toEqual([]);
    const none = await r2Lifecycle({ aws: signer, endpoint: "https://r2", bucket: "b" }, (async () => new Response("<Error><Code>NoSuchLifecycleConfiguration</Code></Error>", { status: 404 })) as typeof fetch);
    expect(none).toEqual({ configured: true, rules: [], error: null });
    expect((await r2Lifecycle(null)).configured).toBe(false);
  });
});

describe("evidence-retention cron endpoint", () => {
  const summary = { id: 7, status: "succeeded", complete: true, deleted: 3, skipped: 1, failed: 0 };
  const make = (secret = "s3cret-value") => {
    let runs = 0;
    const handler = createRetentionCronHandler({ secret, run: async () => { runs += 1; return { ...summary, due_week: 0, dryRun: false, retentionDays: 1825, cutoff: "", detail: { db: {}, storage: {}, errors: [], resume: null } } as never; } });
    return { handler, runs: () => runs };
  };
  const post = (headers: Record<string, string> = {}) => new Request("https://x/evidence-retention", { method: "POST", headers });

  it("runs only with the shared secret", async () => {
    const { handler, runs } = make();
    expect((await handler(post())).status).toBe(403);
    expect((await handler(post({ "x-retention-cron-secret": "s3cret-valuf" }))).status).toBe(403);
    expect((await handler(post({ "x-retention-cron-secret": "s3cret" }))).status).toBe(403);
    expect((await handler(post({ authorization: "Bearer s3cret-value" }))).status).toBe(403);
    expect((await handler(new Request("https://x", { method: "GET", headers: { "x-retention-cron-secret": "s3cret-value" } }))).status).toBe(405);
    expect(runs()).toBe(0);
    const ok = await handler(post({ "x-retention-cron-secret": "s3cret-value" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(summary);
    expect(runs()).toBe(1);
  });

  it("refuses to run when no secret is configured", async () => {
    const { handler, runs } = make("");
    expect((await handler(post({ "x-retention-cron-secret": "" }))).status).toBe(503);
    expect(runs()).toBe(0);
  });

  it("compares secrets in full", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abd", "abc")).toBe(false);
    expect(sameSecret("abcd", "abc")).toBe(false);
    expect(sameSecret("", "abc")).toBe(false);
  });
});
