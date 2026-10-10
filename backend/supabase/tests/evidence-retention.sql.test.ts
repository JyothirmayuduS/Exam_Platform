// @vitest-environment node
// Evidence and results retention: the period, legal holds, and what the
// deletion job may delete (retention_folder_status, retention_db_batch).
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, BASE, EXAM_ROLES_SCHEMA, migration } from "./pgliteBase";

const ADMIN = "00000000-0000-0000-0000-00000000000d";
const TEACHER = "00000000-0000-0000-0000-00000000000a";
const S1 = "10000000-0000-0000-0000-000000000001";
const S2 = "10000000-0000-0000-0000-000000000002";
const A = (n: number) => `20000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const V = (n: number) => `30000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const OLD = "now() - interval '2000 days'";
const YOUNG = "now() - interval '1000 days'";
const CUTOFF = "now() - interval '1825 days'";

const SCHEMA = `
alter table public.exams add column legacy_name text;
alter table public.violation_events add column created_at timestamptz not null default now();
alter table public.mobile_upload_sessions add column created_at timestamptz not null default now();
create table public.appeal_requests (id uuid primary key default gen_random_uuid(), attempt_id uuid, status text);
create function public.exam_folder_slug(p_name text) returns text language sql immutable set search_path = '' as
  $$ select left(regexp_replace(regexp_replace(btrim(coalesce(p_name, '')), '[^A-Za-z0-9._-]+', '-', 'g'), '^-+|-+$', '', 'g'), 60) $$;
`;

let db: PGlite;
let as: ReturnType<typeof actAs>;
const rows = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;
const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await rows<R>(sql, params))[0];
const batch = async (kind: string, dryRun = false, limit = 100) =>
  (await one<{ r: { due: number; skipped: number; deleted: number; more: boolean } }>(
    `select public.retention_db_batch($1, ${CUTOFF}, $2, $3) r`, [kind, limit, dryRun])).r;
const ids = async (table: string) => (await rows<{ id: string }>(`select id::text from public.${table} order by id`)).map((r) => r.id);

beforeAll(async () => {
  db = new PGlite();
  as = actAs(db);
  await db.exec(BASE);
  await db.exec(EXAM_ROLES_SCHEMA);
  await db.exec(SCHEMA);
  await db.exec(migration("20261011000000_evidence_retention.sql"));
  await db.exec(migration("20261011010000_retention_unmatched_and_names.sql"));
}, 60_000);

beforeEach(async () => {
  await db.exec(`
    truncate public.teachers, public.staff_admins, public.students, public.exams, public.attempts, public.result_holds,
      public.violation_events, public.flag_reviews, public.audit_logs, public.appeal_requests, public.student_appeals,
      public.legal_holds, public.retention_runs, public.exam_former_names, public.mobile_upload_sessions restart identity cascade;
    update public.retention_settings set retention_days = 1825, storage_cursor = null;
    insert into public.teachers (auth_id, role) values ('${ADMIN}', 'teacher'), ('${TEACHER}', 'teacher');
    insert into public.staff_admins (auth_id) values ('${ADMIN}');
    insert into public.students (id, roll, full_name) values ('${S1}', '21BQ1A0501', 'One'), ('${S2}', '21BQ1A0502', 'Two');
    insert into public.exams (id, name, legacy_name) values ('EX-1', 'Sem Exam CS101', 'Mid term'), ('EX-2', 'Other', null);
  `);
});

describe("retention period", () => {
  it("defaults to 1825 days (5 years)", async () => {
    expect((await one<{ d: number }>("select public.retention_days() d")).d).toBe(1825);
  });

  it("only an admin can change it, within 30 to 3650 days, and every change is audited", async () => {
    await expect(db.query(`select public.set_retention_days(400, '${TEACHER}')`)).rejects.toThrow(/admins_only/);
    await expect(db.query(`select public.set_retention_days(400, null)`)).rejects.toThrow(/admins_only/);
    await expect(db.query(`select public.set_retention_days(29, '${ADMIN}')`)).rejects.toThrow(/out_of_range/);
    await expect(db.query(`select public.set_retention_days(3651, '${ADMIN}')`)).rejects.toThrow(/out_of_range/);
    expect((await one<{ d: number }>("select public.retention_days() d")).d).toBe(1825);

    await db.query(`select public.set_retention_days(2555, '${ADMIN}')`);
    await db.query(`select public.set_retention_days(2555, '${ADMIN}')`);
    expect((await one<{ d: number }>("select public.retention_days() d")).d).toBe(2555);
    const audit = await rows("select actor_id, action, target_type, target_id, meta from public.audit_logs");
    expect(audit).toEqual([{ actor_id: ADMIN, action: "admin.retention_changed", target_type: "retention", target_id: "site", meta: { from: 1825, to: 2555 } }]);
  });

  it("signed-in users cannot run any retention function or read its tables", async () => {
    for (const sql of [
      "select public.retention_days()",
      `select public.set_retention_days(400, '${ADMIN}')`,
      `select public.set_legal_hold('exam', 'EX-1', true, 'x', '${ADMIN}')`,
      `select * from public.retention_folder_status('EX-1', array['21BQ1A0501'])`,
      `select public.retention_db_batch('attempts', now(), 10, false)`,
      "select * from public.retention_settings",
      "select * from public.legal_holds",
      "select * from public.retention_runs",
    ]) {
      await expect(as(ADMIN, () => db.query(sql))).rejects.toThrow(/permission denied/);
      await expect(as(null, () => db.query(sql))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("legal holds", () => {
  it("only admins place and lift them, on existing targets, and both are audited", async () => {
    await expect(db.query(`select public.set_legal_hold('exam', 'EX-1', true, 'x', '${TEACHER}')`)).rejects.toThrow(/admins_only/);
    await expect(db.query(`select public.set_legal_hold('exam', 'NOPE', true, 'x', '${ADMIN}')`)).rejects.toThrow(/target_not_found/);
    await expect(db.query(`select public.set_legal_hold('student', 'not-a-uuid', true, 'x', '${ADMIN}')`)).rejects.toThrow(/target_not_found/);

    expect((await one<{ c: boolean }>(`select public.set_legal_hold('exam', 'EX-1', true, ' Court order ', '${ADMIN}') c`)).c).toBe(true);
    expect((await one<{ c: boolean }>(`select public.set_legal_hold('exam', 'EX-1', true, 'again', '${ADMIN}') c`)).c).toBe(false);
    expect((await one<{ c: boolean }>(`select public.set_legal_hold('student', upper('${S1}'), true, null, '${ADMIN}') c`)).c).toBe(true);
    expect(await rows("select target_type, target_id, reason from public.legal_holds where lifted_at is null order by target_type"))
      .toEqual([{ target_type: "exam", target_id: "EX-1", reason: "Court order" }, { target_type: "student", target_id: S1, reason: null }]);

    expect((await one<{ c: boolean }>(`select public.set_legal_hold('exam', 'EX-1', false, null, '${ADMIN}') c`)).c).toBe(true);
    expect((await one<{ c: boolean }>(`select public.set_legal_hold('exam', 'EX-1', false, null, '${ADMIN}') c`)).c).toBe(false);
    expect(await rows("select action, target_type, target_id from public.audit_logs order by id")).toEqual([
      { action: "admin.legal_hold_placed", target_type: "exam", target_id: "EX-1" },
      { action: "admin.legal_hold_placed", target_type: "student", target_id: S1 },
      { action: "admin.legal_hold_lifted", target_type: "exam", target_id: "EX-1" },
    ]);
    // Placing it again after lifting starts a new hold.
    expect((await one<{ c: boolean }>(`select public.set_legal_hold('exam', 'EX-1', true, null, '${ADMIN}') c`)).c).toBe(true);
  });
});

describe("results and marks (attempts)", () => {
  beforeEach(async () => {
    await db.exec(`
      insert into public.attempts (id, exam_id, student_id, state, submitted_at, started_at) values
        ('${A(1)}', 'EX-2', '${S2}', 'submitted', ${OLD}, ${OLD}),
        ('${A(2)}', 'EX-2', '${S2}', 'submitted', ${YOUNG}, ${YOUNG}),
        ('${A(3)}', 'EX-2', '${S2}', 'in_progress', null, ${OLD});
    `);
  });

  it("deletes only what is older than the retention period", async () => {
    expect(await batch("attempts")).toEqual({ due: 2, skipped: 0, deleted: 2, more: false });
    expect(await ids("attempts")).toEqual([A(2)]);
  });

  it("a dry run counts and deletes nothing", async () => {
    expect(await batch("attempts", true)).toEqual({ due: 2, skipped: 0, deleted: 0, more: false });
    expect(await ids("attempts")).toEqual([A(1), A(2), A(3)]);
  });

  it("deletes in batches, reporting only the batch, until a batch comes up short", async () => {
    expect(await batch("attempts", false, 1)).toEqual({ due: 1, skipped: 0, deleted: 1, more: true });
    expect(await batch("attempts", false, 1)).toEqual({ due: 1, skipped: 0, deleted: 1, more: true });
    expect(await batch("attempts", false, 1)).toEqual({ due: 0, skipped: 0, deleted: 0, more: false });
    expect(await ids("attempts")).toEqual([A(2)]);
  });

  it("follows a changed retention period", async () => {
    await db.query(`select public.set_retention_days(3650, '${ADMIN}')`);
    const r = (await one<{ r: { due: number } }>(`select public.retention_db_batch('attempts', now() - make_interval(days => public.retention_days()), 10, true) r`)).r;
    expect(r.due).toBe(0);
  });

  it("skips malpractice holds, legal holds, open appeals and unreviewed serious flags", async () => {
    await db.exec(`
      insert into public.attempts (id, exam_id, student_id, state, submitted_at) values
        ('${A(10)}', 'EX-1', '${S1}', 'submitted', ${OLD}),
        ('${A(11)}', 'EX-2', '${S1}', 'submitted', ${OLD}),
        ('${A(12)}', 'EX-2', '${S2}', 'submitted', ${OLD}),
        ('${A(13)}', 'EX-2', '${S2}', 'submitted', ${OLD}),
        ('${A(14)}', 'EX-2', '${S2}', 'submitted', ${OLD}),
        ('${A(15)}', 'EX-2', '${S2}', 'submitted', ${OLD}),
        ('${A(16)}', 'EX-2', '${S2}', 'submitted', ${OLD});
      insert into public.result_holds (attempt_id, exam_id, student_id) values ('${A(12)}', 'EX-2', '${S2}');
      insert into public.appeal_requests (attempt_id, status) values ('${A(13)}', 'pending'), ('${A(16)}', 'resolved');
      insert into public.student_appeals (attempt_id, student_id, status) values ('${A(14)}', '${S2}', 'under_review');
      insert into public.violation_events (id, exam_id, student_id, attempt_id, severity, violation_type) values
        ('${V(1)}', 'EX-2', '${S2}', '${A(15)}', 'critical', 'phone'),
        ('${V(2)}', 'EX-2', '${S2}', '${A(16)}', 'high', 'phone');
      insert into public.flag_reviews (violation_id) values ('${V(2)}');
    `);
    await db.query(`select public.set_legal_hold('exam', 'EX-1', true, null, '${ADMIN}')`);
    await db.query(`select public.set_legal_hold('student', '${S1}', true, null, '${ADMIN}')`);
    const holds = await rows<{ id: string; h: string | null }>(
      "select a.id::text id, public.retention_attempt_hold(a.id, a.exam_id, a.student_id) h from public.attempts a where a.id::text like '2%00001_' order by a.id");
    expect(Object.fromEntries(holds.map((r) => [r.id, r.h]))).toEqual({
      [A(10)]: "legal_hold", [A(11)]: "legal_hold", [A(12)]: "malpractice_hold", [A(13)]: "appeal",
      [A(14)]: "appeal", [A(15)]: "under_review", [A(16)]: null,
    });

    expect(await batch("attempts", true)).toEqual({ due: 3, skipped: 6, deleted: 0, more: false });
    expect(await batch("attempts")).toEqual({ due: 3, skipped: 0, deleted: 3, more: false });
    expect(await ids("attempts")).toEqual([A(2), A(10), A(11), A(12), A(13), A(14), A(15)]);
  });

  it("after a hold is lifted the next run deletes it, counting from the original date", async () => {
    await db.exec(`insert into public.result_holds (attempt_id, exam_id, student_id) values ('${A(1)}', 'EX-2', '${S2}')`);
    await db.query(`select public.set_legal_hold('student', '${S2}', true, null, '${ADMIN}')`);
    expect((await batch("attempts")).deleted).toBe(0);
    await db.query(`select public.set_legal_hold('student', '${S2}', false, null, '${ADMIN}')`);
    expect((await batch("attempts")).deleted).toBe(1);
    expect(await ids("attempts")).toEqual([A(1), A(2)]);
    await db.exec(`delete from public.result_holds`);
    expect(await batch("attempts")).toEqual({ due: 1, skipped: 0, deleted: 1, more: false });
    expect(await ids("attempts")).toEqual([A(2)]);
  });
});

describe("violation rows and audit logs", () => {
  it("deletes old violation rows except held or unreviewed serious ones", async () => {
    await db.exec(`
      insert into public.attempts (id, exam_id, student_id, state, submitted_at) values ('${A(20)}', 'EX-2', '${S2}', 'submitted', ${OLD});
      insert into public.result_holds (attempt_id, exam_id, student_id) values ('${A(20)}', 'EX-2', '${S2}');
      insert into public.violation_events (id, exam_id, student_id, attempt_id, severity, violation_type, created_at) values
        ('${V(1)}', 'EX-2', '${S2}', null, 'warning', 'tab', ${OLD}),
        ('${V(2)}', 'EX-2', '${S2}', null, 'warning', 'tab', ${YOUNG}),
        ('${V(3)}', 'EX-2', '${S2}', null, 'high', 'phone', ${OLD}),
        ('${V(4)}', 'EX-2', '${S2}', '${A(20)}', 'info', 'tab', ${OLD}),
        ('${V(5)}', 'EX-1', '${S1}', null, 'info', 'tab', ${OLD});
    `);
    await db.query(`select public.set_legal_hold('exam', 'EX-1', true, null, '${ADMIN}')`);
    expect(await batch("violation_events", true)).toEqual({ due: 1, skipped: 3, deleted: 0, more: false });
    expect(await batch("violation_events")).toEqual({ due: 1, skipped: 0, deleted: 1, more: false });
    expect(await ids("violation_events")).toEqual([V(2), V(3), V(4), V(5)]);
  });

  it("deletes old audit entries except ones about held exams, students or attempts", async () => {
    await db.exec(`
      insert into public.attempts (id, exam_id, student_id, state, submitted_at) values ('${A(30)}', 'EX-2', '${S2}', 'submitted', ${OLD});
      insert into public.result_holds (attempt_id, exam_id, student_id) values ('${A(30)}', 'EX-2', '${S2}');
      insert into public.audit_logs (action, target_type, target_id, meta, created_at) values
        ('a', 'exam', 'EX-2', '{}', ${OLD}),
        ('b', 'exam', 'EX-1', '{}', ${OLD}),
        ('c', 'results', 'x', '{"exam_id":"EX-1"}', ${OLD}),
        ('d', 'student', upper('${S1}'), '{}', ${OLD}),
        ('e', 'attempt', '${A(30)}', '{}', ${OLD}),
        ('f', 'exam', 'EX-2', '{}', ${YOUNG});
    `);
    await db.query(`select public.set_legal_hold('exam', 'EX-1', true, null, '${ADMIN}')`);
    await db.query(`select public.set_legal_hold('student', '${S1}', true, null, '${ADMIN}')`);
    expect(await batch("audit_logs", true)).toEqual({ due: 1, skipped: 4, deleted: 0, more: false });
    expect(await batch("audit_logs")).toEqual({ due: 1, skipped: 0, deleted: 1, more: false });
    expect((await rows<{ action: string }>("select action from public.audit_logs order by id")).map((r) => r.action))
      .toEqual(["b", "c", "d", "e", "f", "admin.legal_hold_placed", "admin.legal_hold_placed"]);
  });

  it("rejects an unknown kind", async () => {
    await expect(batch("students")).rejects.toThrow(/bad_kind/);
  });
});

describe("evidence folders", () => {
  it("reports holds per student folder, matching exams by id, name or folder slug and students by roll or id", async () => {
    await db.exec(`
      insert into public.attempts (id, exam_id, student_id, state, submitted_at) values ('${A(40)}', 'EX-1', '${S2}', 'submitted', ${OLD});
      insert into public.result_holds (attempt_id, exam_id, student_id) values ('${A(40)}', 'EX-1', '${S2}');
    `);
    const status = async (folder: string, students: string[]) =>
      Object.fromEntries((await rows<{ student_folder: string; hold: string | null }>(
        "select * from public.retention_folder_status($1, $2)", [folder, students])).map((r) => [r.student_folder, r.hold]));

    for (const folder of ["EX-1", "Sem Exam CS101", "Sem-Exam-CS101", "Mid-term"]) {
      expect(await status(folder, ["21bq1a0502", S2])).toEqual({ "21bq1a0502": "malpractice_hold", [S2]: "malpractice_hold" });
    }
    await db.exec(`insert into public.attempts (exam_id, student_id, state, submitted_at) values ('EX-2', '${S2}', 'submitted', ${OLD})`);
    expect(await status("EX-2", ["21BQ1A0502"])).toEqual({ "21BQ1A0502": null });

    await db.query(`select public.set_legal_hold('student', '${S1}', true, null, '${ADMIN}')`);
    expect(await status("EX-2", ["21BQ1A0501", "21BQ1A0502"])).toEqual({ "21BQ1A0501": "legal_hold", "21BQ1A0502": null });
    await db.query(`select public.set_legal_hold('exam', 'EX-2', true, null, '${ADMIN}')`);
    expect(await status("Other", ["21BQ1A0502", "anyone"])).toEqual({ "21BQ1A0502": "legal_hold", anyone: "legal_hold" });
  });

  it("keeps a folder it cannot match: an unknown exam folder, an unknown student, or a student without an attempt there", async () => {
    await db.exec(`insert into public.attempts (exam_id, student_id, state, submitted_at) values ('EX-1', '${S2}', 'submitted', ${OLD})`);
    expect(Object.fromEntries((await rows<{ student_folder: string; hold: string | null }>(
      "select * from public.retention_folder_status('Deleted-exam', array['21BQ1A0502', 'x'])")).map((r) => [r.student_folder, r.hold])))
      .toEqual({ "21BQ1A0502": "unmatched_exam", x: "unmatched_exam" });
    const st = Object.fromEntries((await rows<{ student_folder: string; hold: string | null }>(
      "select * from public.retention_folder_status('EX-1', array['21BQ1A0501', '21BQ1A0502', 'UNKNOWN'])")).map((r) => [r.student_folder, r.hold]));
    expect(st).toEqual({ "21BQ1A0501": "unmatched_student", "21BQ1A0502": null, UNKNOWN: "unmatched_student" });
  });

  it("matches a renamed exam's old folders by every former name", async () => {
    await db.exec(`
      insert into public.attempts (exam_id, student_id, state, submitted_at) values ('EX-2', '${S2}', 'submitted', ${OLD});
      update public.exams set name = 'Data Structures' where id = 'EX-2';
      update public.exams set name = 'Data Structures' where id = 'EX-2';
      update public.exams set name = 'DS · Sem 3' where id = 'EX-2';
    `);
    expect((await rows<{ name: string }>("select name from public.exam_former_names where exam_id = 'EX-2'")).map((r) => r.name).sort())
      .toEqual(["Data Structures", "Other"]);
    for (const folder of ["Other", "Data-Structures", "Data Structures", "DS-Sem-3"]) {
      expect(await rows("select * from public.retention_folder_status($1, array['21BQ1A0502'])", [folder])).toEqual([{ student_folder: "21BQ1A0502", hold: null }]);
    }
    expect((await rows<{ folder: string }>("select folder from public.legacy_folder_exams() where exam_id = 'EX-2'")).map((r) => r.folder).sort())
      .toEqual(["DS · Sem 3", "DS-Sem-3", "Data Structures", "Data-Structures", "Other"].sort());
  });

  it("keeps the old folder of an edited roll and a reused roll", async () => {
    const S3 = "10000000-0000-0000-0000-000000000003";
    await db.exec(`
      insert into public.attempts (exam_id, student_id, state, submitted_at) values ('EX-1', '${S1}', 'submitted', ${OLD});
      update public.students set roll = '21BQ1A0599' where id = '${S1}';
    `);
    const status = async (students: string[]) => Object.fromEntries((await rows<{ student_folder: string; hold: string | null }>(
      "select * from public.retention_folder_status('EX-1', $1)", [students])).map((r) => [r.student_folder, r.hold]));
    // Edited: the old roll folder matches nobody; the new roll and the id match.
    expect(await status(["21BQ1A0501", "21BQ1A0599", S1])).toEqual({ "21BQ1A0501": "unmatched_student", "21BQ1A0599": null, [S1]: null });
    // Reused by a student with no attempt in this exam: still unmatched.
    await db.exec(`insert into public.students (id, roll, full_name) values ('${S3}', '21BQ1A0501', 'Three')`);
    expect(await status(["21BQ1A0501"])).toEqual({ "21BQ1A0501": "unmatched_student" });
    // A roll shared by two students who both sat this exam is ambiguous.
    await db.exec(`
      insert into public.attempts (exam_id, student_id, state, submitted_at) values ('EX-1', '${S3}', 'submitted', ${OLD});
      update public.students set roll = '21bq1a0501' where id = '${S1}';
    `);
    expect(await status(["21BQ1A0501"])).toEqual({ "21BQ1A0501": "unmatched_student" });
  });
});

describe("phone upload sessions", () => {
  it("deletes sessions older than 90 days except those of held attempts, exams or students", async () => {
    await db.exec(`
      insert into public.attempts (id, exam_id, student_id, state, submitted_at) values
        ('${A(50)}', 'EX-2', '${S2}', 'submitted', ${OLD}), ('${A(51)}', 'EX-2', '${S2}', 'submitted', ${OLD});
      insert into public.result_holds (attempt_id, exam_id, student_id) values ('${A(50)}', 'EX-2', '${S2}');
      insert into public.mobile_upload_sessions (attempt_id, student_id, exam_id, created_at) values
        ('${A(50)}', '${S2}', 'EX-2', now() - interval '100 days'),
        ('${A(51)}', '${S2}', 'EX-2', now() - interval '100 days'),
        ('${A(51)}', '${S2}', 'EX-2', now() - interval '10 days'),
        (null, '${S1}', 'EX-2', now() - interval '100 days'),
        (null, '${S2}', 'EX-1', now() - interval '100 days');
    `);
    await db.query(`select public.set_legal_hold('student', '${S1}', true, null, '${ADMIN}')`);
    await db.query(`select public.set_legal_hold('exam', 'EX-1', true, null, '${ADMIN}')`);
    expect((await one<{ n: number }>("select public.retention_cleanup_upload_sessions() n")).n).toBe(1);
    const left = await rows<{ k: string }>(
      "select concat_ws(' ', coalesce(attempt_id::text, '-'), exam_id, student_id::text, created_at > now() - interval '30 days') k from public.mobile_upload_sessions");
    expect(left.map((r) => r.k).sort()).toEqual([
      `${A(50)} EX-2 ${S2} f`, `${A(51)} EX-2 ${S2} t`, `- EX-1 ${S2} f`, `- EX-2 ${S1} f`,
    ].sort());
  });
});
