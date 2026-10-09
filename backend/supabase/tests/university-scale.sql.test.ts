// @vitest-environment node
// The university-scale migration on a real Postgres (PGlite, no pg_cron):
// system status without cron, backup runs, who may read holds and photos,
// held results hidden from students and Moodle, and evidence counts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATION = readFileSync(resolve(__dirname, "../migrations/20261010150000_university_scale.sql"), "utf8");

// Just enough of the live schema for the migration to run against.
const BASE = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, created_at timestamptz default now(), last_sign_in_at timestamptz, raw_app_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.teachers (id uuid primary key default gen_random_uuid(), auth_id uuid, role text);
create table public.staff_admins (auth_id uuid primary key);
create table public.students (id uuid primary key, auth_id uuid, roll text, full_name text);
create table public.exams (id text primary key, name text, status text, scheduled_at timestamptz, duration_minutes int, settings jsonb, created_by uuid);
create table public.enrollments (exam_id text, student_id uuid, primary key (exam_id, student_id));
create table public.attempts (id uuid primary key default gen_random_uuid(), exam_id text, student_id uuid, state text, score numeric);
create table public.result_holds (attempt_id uuid primary key, exam_id text not null, student_id uuid not null, reason text, held_by uuid, held_at timestamptz not null default now());
create table public.student_photos (student_id uuid primary key, storage_path text, bytes int, captured_at timestamptz default now());
create table public.lti_grade_targets (link_id uuid, student_id uuid, exam_id text, sub text, lineitem text, score_maximum numeric,
  last_score numeric, last_posted_at timestamptz, last_error text, pending_score numeric, post_attempts int default 0,
  next_attempt_at timestamptz, claim_token uuid, claimed_until timestamptz, primary key (link_id, student_id));
create table public.audit_logs (id bigserial primary key, actor_id uuid, actor_role text, action text, target_type text, target_id text, meta jsonb, created_at timestamptz default now());

create function public.auth_is_staff() returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from public.teachers where auth_id = auth.uid()) $$;
create function public.auth_is_teacher() returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from public.teachers where auth_id = auth.uid() and role = 'teacher') $$;
create function public.auth_is_staff_admin() returns boolean language sql stable security definer set search_path = '' as
  $$ select public.auth_is_teacher() and exists (select 1 from public.staff_admins a where a.auth_id = auth.uid()) $$;
create function public.owns_exam(p_exam text) returns boolean language sql stable security definer set search_path = '' as
  $$ select public.auth_is_teacher() and exists (select 1 from public.exams e where e.id = p_exam and (e.created_by is null or e.created_by = auth.uid())) $$;
create function public.current_student_id() returns uuid language sql stable security definer set search_path = public as
  $$ select id from public.students where auth_id = auth.uid() limit 1 $$;

alter table public.result_holds enable row level security;
alter table public.student_photos enable row level security;
grant usage on schema public to authenticated;
grant select on public.result_holds, public.student_photos, public.attempts to authenticated;
create policy "result holds staff read" on public.result_holds for select to authenticated using (public.auth_is_staff());
create policy "student photos own read" on public.student_photos for select to authenticated using (student_id = public.current_student_id());
create policy "student photos staff read" on public.student_photos for select to authenticated using (public.auth_is_staff());
`;

const U = {
  owner: "00000000-0000-0000-0000-00000000000a",
  other: "00000000-0000-0000-0000-00000000000b",
  proctor: "00000000-0000-0000-0000-00000000000c",
  admin: "00000000-0000-0000-0000-00000000000d",
  studentAuth: "00000000-0000-0000-0000-00000000000e",
};
const S1 = "10000000-0000-0000-0000-000000000001";
const S2 = "10000000-0000-0000-0000-000000000002";
const A1 = "20000000-0000-0000-0000-000000000001";
const LINK = "30000000-0000-0000-0000-000000000001";

let db: PGlite;

async function as<T>(authId: string | null, run: () => Promise<T>): Promise<T> {
  await db.exec(`set request.jwt.claim.sub = '${authId ?? ""}'`);
  if (authId) await db.exec("set role authenticated");
  try {
    return await run();
  } finally {
    await db.exec("reset role; reset request.jwt.claim.sub");
  }
}
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION);
}, 60_000);

beforeEach(async () => {
  await db.exec(`
    truncate public.teachers, public.staff_admins, public.students, public.exams, public.enrollments, public.attempts,
      public.result_holds, public.student_photos, public.lti_grade_targets, public.audit_logs, public.backup_runs,
      public.evidence_sittings, public.evidence_usage, auth.users restart identity cascade;
    insert into public.teachers (auth_id, role) values ('${U.owner}', 'teacher'), ('${U.other}', 'teacher'), ('${U.proctor}', 'proctor'), ('${U.admin}', 'teacher');
    insert into public.staff_admins values ('${U.admin}');
    insert into public.students values ('${S1}', '${U.studentAuth}', 'R1', 'One'), ('${S2}', null, 'R2', 'Two');
    insert into public.exams values
      ('EX-1', 'Mid-term', 'published', now() - interval '3 hours', 60, '{"results_published": true}', '${U.owner}'),
      ('EX-2', 'Other', 'published', now() - interval '3 hours', 60, '{}', '${U.other}');
    insert into public.enrollments values ('EX-1', '${S1}'), ('EX-2', '${S2}');
    insert into public.attempts (id, exam_id, student_id, state, score) values ('${A1}', 'EX-1', '${S1}', 'submitted', 42);
    insert into public.student_photos (student_id, storage_path) values ('${S1}', 'p/s1.jpg'), ('${S2}', 'p/s2.jpg');
    insert into public.lti_grade_targets (link_id, student_id, exam_id, sub, lineitem, score_maximum, pending_score, post_attempts, next_attempt_at)
      values ('${LINK}', '${S1}', 'EX-1', 'moodle-sub', 'https://moodle/lineitem/1', 100, 42, 0, now() - interval '1 minute');
  `);
});

describe("admin_system_status", () => {
  it("works when pg_cron is not installed", async () => {
    const [{ s }] = await rows<{ s: any }>("select public.admin_system_status() s");
    expect(s.cron_installed).toBe(false);
    expect(s.jobs).toEqual([]);
    expect(s.buckets).toEqual([]);
    expect(typeof s.database_bytes).toBe("number");
    expect(s.backups).toEqual({ latest: null, last_success: null, failures_7d: 0 });
  });

  it("lists jobs and their last run once pg_cron is there", async () => {
    await db.exec(`
      create schema cron;
      create table cron.job (jobid bigint, jobname text, schedule text, active boolean);
      create table cron.job_run_details (jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
      insert into cron.job values (1, 'lti-grade-retry', '*/5 * * * *', true);
      insert into cron.job_run_details values (1, 'failed', now() - interval '1 hour', now(), 'boom'), (1, 'succeeded', now() - interval '5 minutes', now(), null);
    `);
    try {
      const [{ s }] = await rows<{ s: any }>("select public.admin_system_status() s");
      expect(s.cron_installed).toBe(true);
      expect(s.jobs).toMatchObject([{ name: "lti-grade-retry", active: true, failures_24h: 1, last_run: { status: "succeeded" } }]);
    } finally {
      await db.exec("drop schema cron cascade");
    }
  });
});

describe("backup runs", () => {
  it("records a run, finishes it, and reports the latest and last good one", async () => {
    await rows("select public.record_backup_run('failed', now() - interval '2 days', null, 'database', null, null, 'disk full')");
    const [{ id }] = await rows<{ id: number }>("select public.record_backup_run('running') id");
    await rows("select public.record_backup_run('succeeded', p_size_bytes => 1234, p_location => 's3://bk/x.dump', p_id => $1)", [id]);
    const [{ s }] = await rows<{ s: any }>("select public.admin_system_status() s");
    expect(s.backups.latest).toMatchObject({ id, status: "succeeded", size_bytes: 1234, location: "s3://bk/x.dump" });
    expect(s.backups.latest.finished_at).toBeTruthy();
    expect(s.backups.last_success.id).toBe(id);
    expect(s.backups.failures_7d).toBe(1);
  });

  it("is not readable or writable by signed-in users", async () => {
    await expect(as(U.admin, () => rows("select * from public.backup_runs"))).rejects.toThrow(/permission denied/);
    await expect(as(U.admin, () => rows("select public.record_backup_run('succeeded')"))).rejects.toThrow(/permission denied/);
  });
});

describe("who may read hold reasons and photo rows", () => {
  beforeEach(async () => {
    await db.exec(`insert into public.result_holds (attempt_id, exam_id, student_id, reason, held_by) values ('${A1}', 'EX-1', '${S1}', 'phone seen', '${U.owner}')`);
  });

  it("hold reasons: the exam owner and admins, not proctors or other teachers", async () => {
    const reasons = (who: string) => as(who, () => rows<{ reason: string }>("select reason from public.result_holds"));
    expect(await reasons(U.owner)).toEqual([{ reason: "phone seen" }]);
    expect(await reasons(U.admin)).toEqual([{ reason: "phone seen" }]);
    expect(await reasons(U.proctor)).toEqual([]);
    expect(await reasons(U.other)).toEqual([]);
    expect(await reasons(U.studentAuth)).toEqual([]);
  });

  it("photo rows: teachers who own an exam the student sits, and admins; not proctors", async () => {
    const photos = (who: string) => as(who, async () => (await rows<{ student_id: string }>("select student_id from public.student_photos order by student_id")).map((r) => r.student_id));
    expect(await photos(U.owner)).toEqual([S1]);
    expect(await photos(U.other)).toEqual([S2]);
    expect(await photos(U.admin)).toEqual([S1, S2]);
    expect(await photos(U.proctor)).toEqual([]);
    expect(await photos(U.studentAuth)).toEqual([S1]);
  });
});

describe("malpractice hold", () => {
  const myResults = () => as(U.studentAuth, () => rows<{ exam_id: string; graded: boolean; held: boolean; score: string | null }>("select * from public.student_result_states()"));
  const hold = (on: boolean) => as(U.owner, () => rows<{ r: string }>("select public.set_result_hold($1, $2, 'phone seen') r", [A1, on]));
  const claim = () => rows<{ link_id: string }>("select * from public.lti_claim_scores(now(), 10, 60)");

  it("hides the score from the student while held and shows it after release", async () => {
    expect(await myResults()).toEqual([{ exam_id: "EX-1", graded: true, held: false, score: "42" }]);
    expect(await hold(true)).toEqual([{ r: "ok" }]);
    expect(await myResults()).toEqual([{ exam_id: "EX-1", graded: true, held: true, score: null }]);
    expect(await rows("select * from public.exam_release_state('EX-1', $1)", [S1])).toEqual([{ score_visible: false, key_visible: false }]);
    expect(await hold(false)).toEqual([{ r: "ok" }]);
    expect(await myResults()).toEqual([{ exam_id: "EX-1", graded: true, held: false, score: "42" }]);
  });

  it("only returns the signed-in student's own papers", async () => {
    await db.exec(`insert into public.attempts (exam_id, student_id, state, score) values ('EX-2', '${S2}', 'submitted', 7)`);
    expect((await myResults()).map((r) => r.exam_id)).toEqual(["EX-1"]);
  });

  it("does not post a held score to Moodle, and queues it again on release", async () => {
    await hold(true);
    expect(await claim()).toEqual([]);
    await db.exec(`update public.lti_grade_targets set post_attempts = 7, next_attempt_at = null`);
    await hold(false);
    const [t] = await rows<{ post_attempts: number; due: boolean }>("select post_attempts, next_attempt_at <= now() due from public.lti_grade_targets");
    expect(t).toEqual({ post_attempts: 0, due: true });
    expect((await claim()).map((r) => r.link_id)).toEqual([LINK]);
  });

  it("a proctor cannot place or lift a hold", async () => {
    expect(await as(U.proctor, () => rows("select public.set_result_hold($1, true, 'x') r", [A1]))).toEqual([{ r: "forbidden" }]);
  });
});

describe("evidence counts", () => {
  const SCAN = "40000000-0000-0000-0000-000000000001";
  const NEWER = "40000000-0000-0000-0000-000000000002";
  const part = (bytes: number, objects: number, oldest: string) => JSON.stringify({ bytes, objects, oldest, due_soon_bytes: 0, due_soon_objects: 0, next_deletion: null });

  it("adds batches up, merges a student split across batches, and replaces the old count when done", async () => {
    await db.exec(`insert into public.evidence_usage (folder, bytes, objects, counted_at) values ('Mid-term', 1, 1, now() - interval '1 day')`);
    await db.exec(`insert into public.evidence_sittings (folder, student_folder, kinds, files) values ('Mid-term', 'GONE', '{report}', 1)`);
    await rows("select public.evidence_scan_begin('Mid-term', $1)", [SCAN]);
    await rows("select public.evidence_scan_add('Mid-term', $1, $2, $3, false, 7)", [SCAN, part(100, 2, "2026-10-01T00:00:00Z"),
      JSON.stringify([{ student_folder: "R1", kinds: ["screenshots"], files: 2, last_upload: "2026-10-01T00:00:00Z" }])]);
    expect((await rows<{ bytes: number }>("select bytes from public.evidence_usage"))[0].bytes).toBe(1);
    const [{ ok }] = await rows<{ ok: boolean }>("select public.evidence_scan_add('Mid-term', $1, $2, $3, true, 7) ok", [SCAN, part(50, 1, "2026-09-30T00:00:00Z"),
      JSON.stringify([{ student_folder: "R1", kinds: ["recordings"], files: 1, last_upload: "2026-10-02T00:00:00Z" }])]);
    expect(ok).toBe(true);
    const [u] = await rows<any>("select bytes, objects, oldest, retention_days, counted_at > now() - interval '1 minute' fresh, scan_id from public.evidence_usage");
    expect(u).toMatchObject({ bytes: 150, objects: 3, retention_days: 7, fresh: true, scan_id: null });
    expect(new Date(u.oldest).toISOString()).toBe("2026-09-30T00:00:00.000Z");
    const sittings = await rows<any>("select student_folder, kinds, files from public.evidence_sittings");
    expect(sittings).toEqual([{ student_folder: "R1", kinds: ["recordings", "screenshots"], files: 3 }]);
  });

  it("drops a count that a newer one took over", async () => {
    await rows("select public.evidence_scan_begin('Mid-term', $1)", [SCAN]);
    await rows("select public.evidence_scan_begin('Mid-term', $1)", [NEWER]);
    const [{ ok }] = await rows<{ ok: boolean }>("select public.evidence_scan_add('Mid-term', $1, $2, '[]', true, 7) ok", [SCAN, part(1, 1, "2026-10-01T00:00:00Z")]);
    expect(ok).toBe(false);
  });

  it("is service-role only", async () => {
    await expect(as(U.admin, () => rows("select * from public.evidence_usage"))).rejects.toThrow(/permission denied/);
    await expect(as(U.admin, () => rows("select public.evidence_scan_begin('x', $1)", [SCAN]))).rejects.toThrow(/permission denied/);
  });
});
