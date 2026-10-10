// @vitest-environment node
// Backup and restore (backend/backup): the manifest helpers the scripts rely
// on, the scripts' safety checks, and the SQL that captures platform objects,
// the sample attempt and the backup facts.
import { PGlite } from "@electric-sql/pglite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildManifest, compareCounts, compareListings, countCopyRows, countSql, parseCounts, parseListing,
  pgEnvFromUrl, pickRecording, projectRef, redactText, sameJson, sampleFiles, secretValues, setAt,
  shellExports, verifySums,
} from "../../backup/lib/manifest.mjs";
import { BASE } from "./pgliteBase";

const BACKUP = resolve(__dirname, "../../backup");
const sqlFile = (name: string) => readFileSync(join(BACKUP, "sql", name), "utf8");
const lines = (text: string) => text.split("\n");

describe("connection settings", () => {
  it("reads a session-pooler URL with an encoded password", () => {
    const env = pgEnvFromUrl("postgresql://cli_login_postgres.abcdefghijklmnopqrst:p%40ss%2Fw0rd@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full");
    expect(env).toEqual({
      PGHOST: "aws-0-ap-southeast-1.pooler.supabase.com", PGPORT: "5432", PGUSER: "cli_login_postgres.abcdefghijklmnopqrst",
      PGPASSWORD: "p@ss/w0rd", PGDATABASE: "postgres", PGSSLMODE: "verify-full",
    });
  });

  it("defaults the port, database and sslmode", () => {
    expect(pgEnvFromUrl("postgres://postgres:x@db.example.com")).toMatchObject({ PGPORT: "5432", PGDATABASE: "postgres", PGSSLMODE: "require" });
  });

  it("rejects URLs that are not Postgres, without echoing them", () => {
    expect(() => pgEnvFromUrl("https://user:secret-pw@example.com")).toThrow(/postgres:\/\//);
    expect(() => pgEnvFromUrl("not a url secret-pw")).toThrow("database URL is not a valid URL");
    expect(() => pgEnvFromUrl("postgres://db.example.com/x")).toThrow(/no user/);
  });

  it("quotes exports so the shell gets the exact password back", () => {
    const pw = `it's $HOME "quoted" \`x\``;
    const out = spawnSync("bash", ["-c", `eval "$X"; printf %s "$PGPASSWORD"`], {
      env: { PATH: process.env.PATH, X: shellExports({ PGPASSWORD: pw }) }, encoding: "utf8",
    });
    expect(out.stdout).toBe(pw);
  });

  it("takes the project ref from the Supabase URL", () => {
    expect(projectRef("https://xdwhftrierzxsppindfj.supabase.co")).toBe("xdwhftrierzxsppindfj");
    expect(() => projectRef("https://example.com")).toThrow(/project-ref/);
  });
});

describe("secret masking", () => {
  it("hides secret-looking variables and the password inside a database URL", () => {
    const secrets = secretValues({
      SOURCE_SERVICE_ROLE_KEY: "fake.service.role.key", R2_SECRET_ACCESS_KEY: "r2-secret-1234", PATH: "/usr/bin:/bin",
      TARGET_DB_URL: "postgresql://postgres.ref:p%40ssword99@host/postgres", SHORT_KEY: "abc",
    });
    const text = "region fake.service.role.key; r2-secret-1234; p@ssword99; p%40ssword99; /usr/bin:/bin; abc";
    expect(redactText(text, secrets)).toBe("region [redacted]; [redacted]; [redacted]; [redacted]; /usr/bin:/bin; abc");
  });

  it("masks tool errors in the scripts' error stream", () => {
    const out = spawnSync("bash", ["-c", `. "${BACKUP}/lib/common.sh"; echo "bad region $FAKE_SERVICE_ROLE_KEY" | redact`], {
      env: { PATH: process.env.PATH, FAKE_SERVICE_ROLE_KEY: "fake-service-role-0123456789" }, encoding: "utf8",
    });
    expect(out.stdout).toBe("bad region [redacted]\n");
  });
});

describe("data dump row counts", () => {
  const dump = [
    "SET session_replication_role = replica;",
    'COPY "public"."attempts" ("id", "answers") FROM stdin;',
    "a1\t{\"q1\": \"line one\\nline two\"}",
    "a2\t\\N",
    "\\.",
    "",
    'COPY "public"."empty" ("id") FROM stdin;',
    "\\.",
    'COPY "auth"."we""ird.name" ("id") FROM stdin;',
    "x",
    "\\.",
    "SELECT pg_catalog.setval('public.seq', 3, true);",
  ];

  it("counts one row per line, including empty tables and quoted names", async () => {
    expect(await countCopyRows(dump)).toEqual({ "public.attempts": 2, "public.empty": 0, 'auth.we"ird.name': 1 });
  });

  it("rejects a truncated dump", async () => {
    await expect(countCopyRows(dump.slice(0, 3))).rejects.toThrow(/ends inside the COPY block for public.attempts/);
  });

  it("builds a count query that survives odd table names", async () => {
    const db = new PGlite();
    await db.exec(`create schema auth; create table auth."we""ird.name" (id int); insert into auth."we""ird.name" values (1), (2);
                   create table public.empty (id int);`);
    const res = await db.query<{ "?column?": string }>(countSql(['auth.we"ird.name', "public.empty"]).replace(/;\n$/, ""));
    expect(parseCounts(res.rows.map((r) => Object.values(r)[0]).join("\n"))).toEqual({ 'auth.we"ird.name': 2, "public.empty": 0 });
    await db.close();
  }, 60_000);

  it("reports missing tables and differing counts", () => {
    expect(compareCounts({ "public.a": 2, "public.b": 0 }, { "public.a": 2, "public.b": 0, "public.extra": 9 }))
      .toEqual({ ok: true, tables: 2, rows: 2, diffs: [] });
    expect(compareCounts({ "public.a": 2, "public.b": 1 }, { "public.a": 3 }).diffs).toEqual([
      { table: "public.a", expected: 2, actual: 3 },
      { table: "public.b", expected: 1, actual: null },
    ]);
  });
});

describe("evidence listings", () => {
  const listing = parseListing("10\tEXAM-1/21BQ1A0501/recording.webm\n5\tTest 2/Student_21BQ1A0501/snap 1.jpg\n7\tEXAM-1/a.json\n");

  it("parses rclone size/path lines, spaces included", () => {
    expect(listing[1]).toEqual({ size: 5, path: "Test 2/Student_21BQ1A0501/snap 1.jpg" });
  });

  it("requires every backed-up file with its size, and allows extras", () => {
    const restored = [...listing.slice(0, 2), { size: 8, path: "EXAM-1/a.json" }, { size: 1, path: "new.txt" }];
    expect(compareListings(listing, restored)).toEqual({ ok: false, missing: [], wrongSize: ["EXAM-1/a.json"] });
    expect(compareListings(listing, listing.slice(1)).missing).toEqual(["EXAM-1/21BQ1A0501/recording.webm"]);
    expect(compareListings(listing, [...listing, { size: 1, path: "new.txt" }]).ok).toBe(true);
  });

  it("samples files for the download check, always including the recording", () => {
    const sample = sampleFiles(listing, 1, ["EXAM-1/21BQ1A0501/recording.webm"]);
    expect(sample).toHaveLength(2);
    expect(sample[0]).toBe("EXAM-1/21BQ1A0501/recording.webm");
    expect(sampleFiles(listing, 25)).toHaveLength(3);
    expect(sampleFiles(listing, 0, ["not-listed"])).toEqual([]);
  });

  it("picks the largest recording when the database has none", () => {
    expect(pickRecording(listing)?.path).toBe("EXAM-1/21BQ1A0501/recording.webm");
    expect(pickRecording(listing.slice(1))).toBeNull();
  });
});

describe("manifest and checksums", () => {
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "backup-test-"));
    mkdirSync(join(work, "db", "listings"), { recursive: true });
    mkdirSync(join(work, "listings"));
    for (const f of ["roles", "schema", "migrations", "platform"]) writeFileSync(join(work, "db", `${f}.sql.gz`), gzipSync(`-- ${f}\n`));
    writeFileSync(join(work, "db", "data.sql.gz"), gzipSync('COPY "public"."exams" ("id") FROM stdin;\nE1\nE2\n\\.\n'));
    const tsv = "3\tE1/r.webm\n4\tE1/s.jpg\n";
    writeFileSync(join(work, "listings", "r2.tsv"), tsv);
    writeFileSync(join(work, "db", "listings", "r2.tsv"), tsv);
    writeFileSync(join(work, "facts.json"), JSON.stringify({ retention_days: 1825 }));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("records files, row counts, evidence totals and facts", async () => {
    const m = await buildManifest(work, { stamp: "2026-10-11T000000Z", source_ref: "abcdefghijklmnopqrst" });
    expect(m.rows).toEqual({ "public.exams": 2 });
    expect(m.evidence).toEqual({ r2: { objects: 2, bytes: 7, listing: "listings/r2.tsv" } });
    expect(m.facts.retention_days).toBe(1825);
    expect(Object.keys(m.files)).toEqual(["roles.sql.gz", "schema.sql.gz", "migrations.sql.gz", "data.sql.gz", "platform.sql.gz", "listings/r2.tsv"]);
    expect(JSON.parse(readFileSync(join(work, "db", "manifest.json"), "utf8")).stamp).toBe("2026-10-11T000000Z");
    expect(await verifySums(join(work, "db"))).toEqual([]);
  });

  it("catches a changed or missing backup file", async () => {
    writeFileSync(join(work, "db", "schema.sql.gz"), gzipSync("-- tampered\n"));
    rmSync(join(work, "db", "listings", "r2.tsv"));
    expect(await verifySums(join(work, "db"))).toEqual(["schema.sql.gz: checksum mismatch", "listings/r2.tsv: missing"]);
  });

  it("sets nested values and compares JSON ignoring key order", () => {
    expect(setAt({ a: { b: 1 } }, "a.c.d", "x")).toEqual({ a: { b: 1, c: { d: "x" } } });
    expect(sameJson({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ score: 2 }, { score: 3 })).toBe(false);
  });
});

describe("scripts", { timeout: 60_000 }, () => {
  const run = (script: string, args: string[], env: Record<string, string>) =>
    spawnSync("bash", [join(BACKUP, script), ...args], { env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env }, encoding: "utf8" });

  it("run the helper through a symlinked path (macOS /tmp is one)", () => {
    const dir = mkdtempSync(join(tmpdir(), "backup-link-"));
    symlinkSync(join(BACKUP, "lib"), join(dir, "lib"));
    const out = spawnSync("node", [join(dir, "lib", "manifest.mjs"), "encode-path", "Test 2/a b.webm"], { encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    expect(out.stdout).toBe("Test%202/a%20b.webm\n");
  });

  it("parse", () => {
    for (const f of ["backup.sh", "restore.sh", "lib/common.sh"]) {
      expect(spawnSync("bash", ["-n", join(BACKUP, f)]).status, f).toBe(0);
    }
  });

  it("backup names the missing variables and prints no secret", () => {
    const out = run("backup.sh", [], { SOURCE_SERVICE_ROLE_KEY: "fake-service-role-key-0123456789" });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("missing environment variables: SOURCE_DB_URL SOURCE_SUPABASE_URL SOURCE_ANON_KEY");
    expect(out.stdout + out.stderr).not.toContain("fake-service-role-key-0123456789");
  });

  it("backup needs the R2 settings unless evidence is skipped", () => {
    const env = {
      SOURCE_DB_URL: "postgres://u:fake-db-password-123@127.0.0.1:1/postgres", SOURCE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SOURCE_SERVICE_ROLE_KEY: "fake-key-0123456789", SOURCE_ANON_KEY: "fake-anon-0123456789",
    };
    expect(run("backup.sh", [], env).stderr).toContain("missing environment variables: R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_S3_ENDPOINT R2_BUCKET");
    expect(run("backup.sh", [], { ...env, R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_S3_ENDPOINT: "c", R2_BUCKET: "d" }).stderr)
      .toContain("missing environment variables: BACKUP_S3_ENDPOINT");
  });

  it("backup stops on a database URL that is not Postgres", () => {
    const local = mkdtempSync(join(tmpdir(), "backup-dest-"));
    const out = run("backup.sh", ["--skip-evidence"], {
      SOURCE_DB_URL: "https://u:fake-db-password-123@example.com/x", SOURCE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SOURCE_SERVICE_ROLE_KEY: "fake-key-0123456789", SOURCE_ANON_KEY: "fake-anon-0123456789", BACKUP_LOCAL_DIR: local,
    });
    rmSync(local, { recursive: true, force: true });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("SOURCE_DB_URL is not a usable postgres URL");
    expect(out.stdout + out.stderr).not.toContain("fake-db-password-123");
  });

  it("restore refuses a protected project before connecting to anything", () => {
    const out = run("restore.sh", ["--skip-evidence"], {
      TARGET_DB_URL: "postgres://postgres:fake-pw-0123456@127.0.0.1:1/postgres", TARGET_SUPABASE_URL: "https://xdwhftrierzxsppindfj.supabase.co",
      TARGET_SERVICE_ROLE_KEY: "fake-key-0123456789", TARGET_ANON_KEY: "fake-anon-0123456789",
      PROTECTED_PROJECT_REFS: "abcdefghijklmnopqrst,xdwhftrierzxsppindfj", BACKUP_LOCAL_DIR: tmpdir(),
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("refusing to restore into protected project xdwhftrierzxsppindfj");
  });

  it("restore needs ffmpeg settings and a restore bucket for evidence", () => {
    const out = run("restore.sh", [], {
      TARGET_DB_URL: "postgres://postgres:x@127.0.0.1:1/postgres", TARGET_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      TARGET_SERVICE_ROLE_KEY: "k", TARGET_ANON_KEY: "a", PATH: `${process.env.PATH}`,
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/ffmpeg is required|ffprobe is required|missing environment variables: RESTORE_R2_BUCKET/);
  });
});

describe("SQL the backup runs", { timeout: 60_000 }, () => {
  const PLATFORM_SETUP = `
    create function public.touch_object() returns trigger language plpgsql as $$ begin return new; end $$;
    create function storage.internal_guard() returns trigger language plpgsql as $$ begin return new; end $$;
    create schema cron;
    create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
    create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as
      $$ insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
         on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
    create function cron.alter_job(job_id bigint, active boolean) returns void language sql as
      $$ update cron.job set active = alter_job.active where jobid = job_id $$;`;

  it("platform.sql recreates Storage policies, our triggers, realtime tables and inactive cron jobs", async () => {
    const live = new PGlite();
    await live.exec(BASE + PLATFORM_SETUP + `
      create policy "exam-records student read own" on storage.objects for select to authenticated
        using (bucket_id = 'exam-records' and split_part(name, '/', 2) = (select roll from public.students where auth_id = auth.uid()));
      create policy "public read question media" on storage.objects for select to public using (bucket_id = 'question-media');
      create trigger touch_object before update on storage.objects for each row execute function public.touch_object();
      create trigger internal_guard before delete on storage.objects for each row execute function storage.internal_guard();
      create publication supabase_realtime for table public.attempts, public.violation_events;
      insert into cron.job (jobname, schedule, command) values
        ('lti-grade-retry', '*/5 * * * *', $$select net.http_post(url := 'https://old.supabase.co/functions/v1/lti/retry')$$),
        ('retention-daily-cleanup', '15 3 * * *', 'select public.retention_cleanup_upload_sessions();');`);
    const generated = (await live.exec(sqlFile("platform.sql"))).flatMap((r) => r.rows.map((row) => Object.values(row)[0])).join("\n");
    await live.close();

    expect(generated).not.toContain("internal_guard");
    const fresh = new PGlite();
    await fresh.exec(BASE + PLATFORM_SETUP);
    await fresh.exec(generated);
    const policies = await fresh.query<{ policyname: string; roles: string; qual: string }>(
      "select policyname, roles::text, qual from pg_policies where schemaname = 'storage' order by policyname");
    expect(policies.rows.map((p) => [p.policyname, p.roles])).toEqual([
      ["exam-records student read own", "{authenticated}"],
      ["public read question media", "{public}"],
    ]);
    expect(policies.rows[0].qual).toContain("split_part(name, '/'::text, 2)");
    const triggers = await fresh.query<{ tgname: string }>("select tgname from pg_trigger where tgrelid = 'storage.objects'::regclass and not tgisinternal");
    expect(triggers.rows.map((t) => t.tgname)).toEqual(["touch_object"]);
    const realtime = await fresh.query<{ tablename: string }>("select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1");
    expect(realtime.rows.map((r) => r.tablename)).toEqual(["attempts", "violation_events"]);
    const jobs = await fresh.query<{ jobname: string; active: boolean; command: string }>("select jobname, active, command from cron.job order by jobname");
    expect(jobs.rows.map((j) => [j.jobname, j.active])).toEqual([["lti-grade-retry", false], ["retention-daily-cleanup", false]]);
    expect(jobs.rows[0].command).toContain("https://old.supabase.co/functions/v1/lti/retry");
    await fresh.exec(generated);
    expect((await fresh.query("select 1 from pg_policies where schemaname = 'storage'")).rows).toHaveLength(2);
    await fresh.close();
  });

  const SAMPLE_DATA = `
    insert into public.exams (id, name) values ('EXAM-1', 'Mid term'), ('EXAM-2', 'Final');
    insert into public.students (id, roll) values ('10000000-0000-0000-0000-000000000001', '21BQ1A0501'), ('10000000-0000-0000-0000-000000000002', '21BQ1A0502');
    insert into public.attempts (id, exam_id, student_id, state, score, submitted_at, answers) values
      ('20000000-0000-0000-0000-000000000001', 'EXAM-1', '10000000-0000-0000-0000-000000000001', 'submitted', 7, '2026-10-08 07:54:12+00', '{"q1": "b", "q2": "c", "q3": "a"}'),
      ('20000000-0000-0000-0000-000000000002', 'EXAM-2', '10000000-0000-0000-0000-000000000002', 'submitted', 9, '2026-10-09 07:54:12+00', '{"q1": "a"}'),
      ('20000000-0000-0000-0000-000000000003', 'EXAM-2', '10000000-0000-0000-0000-000000000001', 'in_progress', null, null, '{}');
    insert into public.violation_events (id, attempt_id, violation_type) values
      ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'tab_switch'),
      ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'face_missing');
    insert into storage.objects (bucket_id, name, metadata) values
      ('exam-records', 'Mid term/Student_21BQ1A0501/recordings/recording_1.webm', '{"size": 1000}'),
      ('exam-records', 'Final/Other/recording.webm', '{"size": 99999}'),
      ('exam-records', 'Mid term/Student_21BQ1A0501/screenshots/a.jpg', '{"size": 5}');`;
  const attemptJson = async (db: PGlite, id: string) =>
    (await db.exec(sqlFile("attempt.sql").replace(":'attempt_id'", `'${id}'`)))
      .flatMap((r) => r.rows.map((row) => Object.values(row)[0]))[0] as Record<string, unknown>;

  it("attempt.sql fingerprints score, answers and violations, whatever order the rows were loaded in", async () => {
    const a = new PGlite();
    await a.exec(BASE + SAMPLE_DATA);
    const b = new PGlite();
    await b.exec(BASE + SAMPLE_DATA.replace(/\('30000000-0000-0000-0000-000000000002'[^)]*\),\n\s*(\('30000000-0000-0000-0000-000000000001'[^)]*\))/, "$1, ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'tab_switch')"));
    const first = await attemptJson(a, "20000000-0000-0000-0000-000000000001");
    expect(first).toMatchObject({ roll: "21BQ1A0501", score: 7, answers: 3, violations: 2, state: "submitted" });
    expect(sameJson(first, await attemptJson(b, "20000000-0000-0000-0000-000000000001"))).toBe(true);
    await b.exec("update public.attempts set score = 8 where id = '20000000-0000-0000-0000-000000000001'");
    expect(sameJson(first, await attemptJson(b, "20000000-0000-0000-0000-000000000001"))).toBe(false);
    await a.close();
    await b.close();
  });

  it("facts.sql samples a scored attempt that has a recording and violations", async () => {
    const db = new PGlite();
    await db.exec(BASE + SAMPLE_DATA + `
      alter table public.exams add column legacy_name text;
      create table storage.buckets (id text primary key, public boolean);
      insert into storage.buckets values ('exam-records', false), ('question-media', true);
      create schema vault; create table vault.secrets (name text); insert into vault.secrets values ('lti_cron_secret');
      create schema cron; create table cron.job (jobname text, schedule text, command text, active boolean);
      insert into cron.job values ('lti-grade-retry', '*/5 * * * *', 'select 1', true);
      create function public.retention_days() returns integer language sql as $$ select 1825 $$;`);
    const facts = (await db.exec(sqlFile("facts.sql"))).flatMap((r) => r.rows.map((row) => Object.values(row)[0]))[0] as Record<string, unknown>;
    expect(facts).toMatchObject({
      retention_days: 1825,
      buckets: [{ id: "exam-records", public: false }, { id: "question-media", public: true }],
      vault_secret_names: ["lti_cron_secret"],
      cron_jobs: [{ jobname: "lti-grade-retry", schedule: "*/5 * * * *", active: true }],
      not_restored_tables: [],
      sample_attempt_id: "20000000-0000-0000-0000-000000000001",
      sample_recording: { store: "storage-exam-records", path: "Mid term/Student_21BQ1A0501/recordings/recording_1.webm", bytes: 1000 },
    });
    await db.close();
  });
});

describe("restore order", () => {
  it("loads roles, schema, migration history, data, then platform objects, in one transaction", () => {
    const script = readFileSync(join(BACKUP, "restore.sh"), "utf8");
    const call = script.slice(script.indexOf("sql --single-transaction"), script.indexOf("step_done", script.indexOf("sql --single-transaction")));
    expect(lines(call).join(" ").match(/db\/(\w+)\.sql/g)).toEqual(["db/roles.sql", "db/schema.sql", "db/migrations.sql", "db/data.sql", "db/platform.sql"]);
  });
});
