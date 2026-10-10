// @vitest-environment node
// Exam data is visible only to the exam's owner, admins and staff assigned to
// it; assigned staff may proctor but not change marks; an exam with no owner
// is admin-only.
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, BASE, migration } from "./pgliteBase";

const U = {
  owner: "00000000-0000-0000-0000-00000000000a",
  other: "00000000-0000-0000-0000-00000000000b",
  proctor: "00000000-0000-0000-0000-00000000000c",
  admin: "00000000-0000-0000-0000-00000000000d",
  loose: "00000000-0000-0000-0000-00000000000f",
  helper: "00000000-0000-0000-0000-000000000010",
};
const T = {
  proctor: "50000000-0000-0000-0000-00000000000c",
  helper: "50000000-0000-0000-0000-000000000010",
  other: "50000000-0000-0000-0000-00000000000b",
};
const S1 = "10000000-0000-0000-0000-000000000001";
const S2 = "10000000-0000-0000-0000-000000000002";
const A1 = "20000000-0000-0000-0000-000000000001";
const A2 = "20000000-0000-0000-0000-000000000002";

let db: PGlite;
let as: ReturnType<typeof actAs>;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

beforeAll(async () => {
  db = new PGlite();
  as = actAs(db);
  await db.exec(BASE);
  await db.exec(migration("20261010150000_university_scale.sql"));
  await db.exec(migration("20261010170000_hide_unreleased_scores.sql"));
  await db.exec(migration("20261010180000_exam_scoped_staff_access.sql"));
  await db.exec("create trigger attempts_a_guard_write before insert or update on public.attempts for each row execute function public.guard_attempt_write()");
}, 60_000);

beforeEach(async () => {
  await db.exec(`
    truncate public.teachers, public.staff_admins, public.students, public.exams, public.enrollments, public.attempts,
      public.proctor_assignments, public.violation_events, public.proctor_sessions, public.proctor_messages, public.ai_reports,
      public.mobile_upload_sessions, storage.objects, public.audit_logs restart identity cascade;
    insert into public.teachers (id, auth_id, role) values
      (gen_random_uuid(), '${U.owner}', 'teacher'), ('${T.other}', '${U.other}', 'teacher'), ('${T.proctor}', '${U.proctor}', 'proctor'),
      (gen_random_uuid(), '${U.admin}', 'teacher'), (gen_random_uuid(), '${U.loose}', 'proctor'), ('${T.helper}', '${U.helper}', 'teacher');
    insert into public.staff_admins values ('${U.admin}');
    insert into public.students values ('${S1}', null, 'R1', 'One'), ('${S2}', null, 'R2', 'Two');
    insert into public.exams values
      ('EX-1', 'Mid term', 'published', now(), 60, '{}', '${U.owner}'),
      ('EX-NULL', 'Legacy', 'published', now(), 60, '{}', null);
    insert into public.proctor_assignments (exam_id, assignee_id, assignee_role) values ('EX-1', '${T.proctor}', 'proctor'), ('EX-1', '${T.helper}', 'teacher');
    insert into public.attempts (id, exam_id, student_id, state, score) values
      ('${A1}', 'EX-1', '${S1}', 'submitted', 42), ('${A2}', 'EX-NULL', '${S2}', 'submitted', 10);
    insert into public.violation_events (exam_id, student_id, attempt_id, severity) values ('EX-1', '${S1}', '${A1}', 'low'), ('EX-NULL', '${S2}', '${A2}', 'low');
    insert into public.proctor_sessions (attempt_id) values ('${A1}'), ('${A2}');
    insert into public.proctor_messages (exam_id, body) values ('EX-1', 'hi'), ('EX-NULL', 'hi');
    insert into public.ai_reports (attempt_id, exam_id, student_id) values ('${A1}', 'EX-1', '${S1}'), ('${A2}', 'EX-NULL', '${S2}');
    insert into public.mobile_upload_sessions (attempt_id, student_id, exam_id) values ('${A1}', '${S1}', 'EX-1'), ('${A2}', '${S2}', 'EX-NULL');
    insert into storage.objects (bucket_id, name) values
      ('exam-records', 'EX-1/R1/phone.jpg'), ('exam-records', 'Mid-term/R1/screen.png'), ('exam-records', 'Mid term/R1/old.png'),
      ('exam-records', 'EX-NULL/R2/phone.jpg'), ('exam-records', 'Legacy/R2/screen.png');
  `);
});

/** Which exams' rows `who` can see, table by table. */
async function visible(who: string) {
  const q = (sql: string) => as(who, async () => (await rows<{ e: string }>(sql)).map((r) => r.e).sort());
  return {
    attempts: await q("select exam_id e from public.attempts"),
    staff_attempts: await q("select exam_id e from public.staff_attempts"),
    violations: await q("select exam_id e from public.violation_events"),
    sessions: await q("select a.exam_id e from public.proctor_sessions s join public.staff_attempts a on a.id = s.attempt_id"),
    messages: await q("select exam_id e from public.proctor_messages"),
    ai_reports: await q("select exam_id e from public.ai_reports"),
    mobile: await q("select exam_id e from public.mobile_upload_sessions"),
    evidence: await q("select name e from storage.objects where bucket_id = 'exam-records'"),
  };
}
const EX1_EVIDENCE = ["EX-1/R1/phone.jpg", "Mid term/R1/old.png", "Mid-term/R1/screen.png"];
const only = (exams: string[], evidence: string[]) => ({
  attempts: exams, staff_attempts: exams, violations: exams, sessions: exams, messages: exams, ai_reports: exams, mobile: exams, evidence,
});
const score = async (id: string) => (await rows<{ score: string }>("select score from public.attempts where id = $1", [id]))[0].score;

describe("the exam's owner", () => {
  it("sees their exam's data and evidence, and not an unowned exam", async () => {
    expect(await visible(U.owner)).toEqual(only(["EX-1"], EX1_EVIDENCE));
  });

  it("can change marks, delete an attempt and assign staff", async () => {
    await as(U.owner, () => rows(`update public.attempts set score = 40 where id = '${A1}'`));
    expect(await score(A1)).toBe("40");
    await as(U.owner, () => rows(`insert into public.proctor_assignments (exam_id, assignee_id) values ('EX-1', '${T.other}')`));
    await as(U.owner, () => rows(`delete from public.attempts where id = '${A1}'`));
    expect(await rows("select id from public.attempts where id = $1", [A1])).toEqual([]);
  });
});

describe("another teacher", () => {
  it("sees nothing", async () => {
    expect(await visible(U.other)).toEqual(only([], []));
  });

  it("cannot change marks, delete, flag, or assign themselves", async () => {
    await as(U.other, () => rows(`update public.attempts set score = 0 where id = '${A1}'`));
    await as(U.other, () => rows(`delete from public.attempts where id = '${A1}'`));
    expect(await score(A1)).toBe("42");
    await expect(as(U.other, () => rows(`insert into public.violation_events (exam_id, student_id, attempt_id) values ('EX-1', '${S1}', '${A1}')`)))
      .rejects.toThrow(/row-level security/);
    await expect(as(U.other, () => rows(`insert into public.proctor_assignments (exam_id, assignee_id) values ('EX-1', '${T.other}')`)))
      .rejects.toThrow(/row-level security/);
    await expect(as(U.other, () => rows("insert into storage.objects (bucket_id, name) values ('exam-records', 'EX-1/R1/x.png')")))
      .rejects.toThrow(/row-level security/);
  });
});

describe("an assigned proctor", () => {
  it("reads the exam's data and evidence", async () => {
    expect(await visible(U.proctor)).toEqual(only(["EX-1"], EX1_EVIDENCE));
  });

  it("can flag, warn and pause, but not change marks", async () => {
    await as(U.proctor, () => rows(`insert into public.violation_events (exam_id, student_id, attempt_id, severity) values ('EX-1', '${S1}', '${A1}', 'high')`));
    await as(U.proctor, () => rows("update public.violation_events set severity = 'medium' where exam_id = 'EX-1'"));
    await as(U.proctor, () => rows("insert into public.proctor_messages (exam_id, body) values ('EX-1', 'eyes on screen')"));
    await as(U.proctor, () => rows(`update public.attempts set state = 'paused', score = 100 where id = '${A1}'`));
    const [a] = await rows<{ state: string; score: string }>("select state, score from public.attempts where id = $1", [A1]);
    expect(a).toEqual({ state: "paused", score: "42" });
    expect((await rows("select 1 from public.violation_events where severity = 'medium'")).length).toBe(2);
  });

  it("cannot delete attempts or flags", async () => {
    await as(U.proctor, () => rows(`delete from public.attempts where id = '${A1}'`));
    await as(U.proctor, () => rows("delete from public.violation_events"));
    expect((await rows("select 1 from public.attempts where id = $1", [A1])).length).toBe(1);
    expect((await rows("select 1 from public.violation_events")).length).toBe(2);
  });

  it("a teacher assigned to proctor someone else's exam cannot change marks either", async () => {
    await as(U.helper, () => rows(`update public.attempts set score = 0 where id = '${A1}'`));
    expect(await score(A1)).toBe("42");
  });
});

describe("an unassigned proctor", () => {
  it("sees nothing", async () => {
    expect(await visible(U.loose)).toEqual(only([], []));
  });
});

describe("an admin", () => {
  it("sees every exam, including an unowned one", async () => {
    expect(await visible(U.admin)).toEqual(only(["EX-1", "EX-NULL"], [...EX1_EVIDENCE, "EX-NULL/R2/phone.jpg", "Legacy/R2/screen.png"].sort()));
  });

  it("can change marks on any exam", async () => {
    await as(U.admin, () => rows(`update public.attempts set score = 9 where id = '${A2}'`));
    expect(await score(A2)).toBe("9");
  });
});

describe("an exam with no owner", () => {
  it("is admin-only", async () => {
    const owns = (who: string) => as(who, async () => (await rows<{ o: boolean }>("select public.owns_exam('EX-NULL') o"))[0].o);
    expect(await owns(U.owner)).toBe(false);
    expect(await owns(U.other)).toBe(false);
    expect(await owns(U.admin)).toBe(true);
    await as(U.owner, () => rows("update public.exams set name = 'mine now' where id = 'EX-NULL'"));
    expect((await rows<{ name: string }>("select name from public.exams where id = 'EX-NULL'"))[0].name).toBe("Legacy");
  });

  it("takes the owner the audit log records, when there is one", async () => {
    await db.exec(`update public.exams set created_by = null where id = 'EX-1'`);
    await db.exec(`insert into public.audit_logs (actor_id, action, target_type, target_id) values ('${U.owner}', 'exam.published', 'exam', 'EX-1')`);
    await db.exec(migration("20261010180000_exam_scoped_staff_access.sql"));
    expect((await rows<{ created_by: string }>("select created_by from public.exams where id = 'EX-1'"))[0].created_by).toBe(U.owner);
    expect((await rows<{ created_by: string | null }>("select created_by from public.exams where id = 'EX-NULL'"))[0].created_by).toBeNull();
  });
});
