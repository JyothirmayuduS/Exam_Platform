// @vitest-environment node
// Exam data by role: the owner, delegated teachers and admins have full
// access; an assigned proctor invigilates without marks, answers, keys or
// grading data; unassigned proctors and other teachers see nothing.
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, BASE, EXAM_ROLES_SCHEMA, migration } from "./pgliteBase";

const U = {
  owner: "00000000-0000-0000-0000-00000000000a",
  other: "00000000-0000-0000-0000-00000000000b",
  proctor: "00000000-0000-0000-0000-00000000000c",
  admin: "00000000-0000-0000-0000-00000000000d",
  loose: "00000000-0000-0000-0000-00000000000f",
  delegate: "00000000-0000-0000-0000-000000000010",
  assigned: "00000000-0000-0000-0000-000000000011",
};
const T = {
  proctor: "50000000-0000-0000-0000-00000000000c",
  delegate: "50000000-0000-0000-0000-000000000010",
  assigned: "50000000-0000-0000-0000-000000000011",
  other: "50000000-0000-0000-0000-00000000000b",
};
const S1 = "10000000-0000-0000-0000-000000000001";
const S2 = "10000000-0000-0000-0000-000000000002";
const A1 = "20000000-0000-0000-0000-000000000001";
const A2 = "20000000-0000-0000-0000-000000000002";
const M1 = "30000000-0000-0000-0000-000000000001";
const M2 = "30000000-0000-0000-0000-000000000002";

let db: PGlite;
let as: ReturnType<typeof actAs>;
const rows = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;
const loadMigrations = async () => {
  await db.exec(migration("20261010180000_exam_scoped_staff_access.sql"));
  await db.exec(migration("20261010190000_exam_access_no_proctors.sql"));
  await db.exec(migration("20261010200000_exam_roles.sql"));
};

beforeAll(async () => {
  db = new PGlite();
  as = actAs(db);
  await db.exec(BASE);
  await db.exec(EXAM_ROLES_SCHEMA);
  await db.exec(migration("20261010150000_university_scale.sql"));
  await db.exec(migration("20261010170000_hide_unreleased_scores.sql"));
  await loadMigrations();
  await db.exec("create trigger attempts_a_guard_write before insert or update on public.attempts for each row execute function public.guard_attempt_write()");
  // Any definer path that tries to change marks for a caller without full access.
  await db.exec(`create function public.test_set_score(p uuid, s numeric) returns void language sql security definer
    as $$ update public.attempts set score = s where id = p $$; grant execute on function public.test_set_score(uuid, numeric) to authenticated`);
}, 60_000);

beforeEach(async () => {
  await db.exec(`
    truncate public.teachers, public.staff_admins, public.students, public.exams, public.enrollments, public.attempts,
      public.proctor_assignments, public.violation_events, public.proctor_sessions, public.proctor_messages, public.ai_reports,
      public.mobile_upload_sessions, public.mobile_session_events, storage.objects, public.audit_logs, public.questions,
      public.exam_questions, public.grading_comments, public.grading_delegations, public.question_submissions,
      public.flag_reviews restart identity cascade;
    insert into public.teachers (id, auth_id, role) values
      (gen_random_uuid(), '${U.owner}', 'teacher'), ('${T.other}', '${U.other}', 'teacher'), ('${T.proctor}', '${U.proctor}', 'proctor'),
      (gen_random_uuid(), '${U.admin}', 'teacher'), (gen_random_uuid(), '${U.loose}', 'proctor'),
      ('${T.delegate}', '${U.delegate}', 'teacher'), ('${T.assigned}', '${U.assigned}', 'teacher');
    insert into public.staff_admins values ('${U.admin}');
    insert into public.students values ('${S1}', null, 'R1', 'One'), ('${S2}', null, 'R2', 'Two');
    insert into public.exams values
      ('EX-1', 'Mid term', 'published', now(), 60, '{}', '${U.owner}'),
      ('EX-NULL', 'Legacy', 'published', now(), 60, '{}', null);
    insert into public.enrollments values ('EX-1', '${S1}'), ('EX-NULL', '${S2}');
    insert into public.proctor_assignments (exam_id, assignee_id, assignee_role) values
      ('EX-1', '${T.proctor}', 'proctor'), ('EX-1', '${T.assigned}', 'teacher');
    insert into public.attempts (id, exam_id, student_id, state, score, answers, paper) values
      ('${A1}', 'EX-1', '${S1}', 'in_progress', 42, '{"Q1":"b"}', '[{"id":"Q1"}]'),
      ('${A2}', 'EX-NULL', '${S2}', 'submitted', 10, '{"QN":"a"}', '[]');
    insert into public.grading_delegations (attempt_id, delegate_id) values ('${A1}', '${T.delegate}');
    insert into public.violation_events (exam_id, student_id, attempt_id, severity) values ('EX-1', '${S1}', '${A1}', 'low'), ('EX-NULL', '${S2}', '${A2}', 'low');
    insert into public.flag_reviews (exam_id) values ('EX-1'), ('EX-NULL');
    insert into public.proctor_sessions (attempt_id) values ('${A1}'), ('${A2}');
    insert into public.proctor_messages (exam_id, body) values ('EX-1', 'hi'), ('EX-NULL', 'hi');
    insert into public.ai_reports (attempt_id, exam_id, student_id) values ('${A1}', 'EX-1', '${S1}'), ('${A2}', 'EX-NULL', '${S2}');
    insert into public.mobile_upload_sessions (id, attempt_id, student_id) values ('${M1}', '${A1}', '${S1}'), ('${M2}', '${A2}', '${S2}');
    insert into public.mobile_session_events (session_id, event_type) values ('${M1}', 'connected'), ('${M2}', 'connected');
    insert into public.questions (id, title, answer, exam_id, created_by) values
      ('Q1', 'q', 'b', 'EX-1', '${U.owner}'), ('QN', 'q', 'a', 'EX-NULL', null),
      ('QBANK', 'bank', 'c', null, '${U.owner}'), ('QPOOL', 'pooled', 'd', null, '${U.owner}');
    insert into public.exam_questions values ('EX-1', 'Q1'), ('EX-1', 'QPOOL'), ('EX-NULL', 'QN');
    insert into public.grading_comments (attempt_id, comment) values ('${A1}', 'good'), ('${A2}', 'ok');
    insert into public.question_submissions (attempt_id, student_id) values ('${A1}', '${S1}'), ('${A2}', '${S2}');
    insert into public.audit_logs (actor_id, action, target_type, target_id, meta) values
      ('${U.owner}', 'exam.published', 'exam', 'EX-1', null),
      ('${U.owner}', 'attempt.paused', 'attempt', '${A1}', null),
      ('${U.owner}', 'attempt.score_changed', 'attempt', '${A1}', '{"score": 40}'),
      ('${U.admin}', 'attempt.time_extended', 'attempt', '${A2}', '{"exam_id": "EX-NULL"}');
    insert into storage.objects (bucket_id, name) values
      ('exam-records', 'EX-1/R1/phone.jpg'), ('exam-records', 'Mid-term/R1/screen.png'), ('exam-records', 'Mid term/R1/old.png'),
      ('exam-records', 'EX-NULL/R2/phone.jpg'), ('exam-records', 'Legacy/R2/screen.png');
  `);
});

/** Which exams' rows `who` can see, table by table. */
async function visible(who: string) {
  const q = (sql: string) => as(who, async () => [...new Set((await rows<{ e: string }>(sql)).map((r) => r.e))].sort());
  return {
    exams: await q("select id e from public.exams"),
    enrollments: await q("select exam_id e from public.enrollments"),
    attempts: await q("select exam_id e from public.attempts"),
    staff_attempts: await q("select exam_id e from public.staff_attempts"),
    proctor_attempts: await q("select exam_id e from public.proctor_attempts"),
    violations: await q("select exam_id e from public.violation_events"),
    flag_reviews: await q("select exam_id e from public.flag_reviews"),
    sessions: await q("select public.attempt_exam(attempt_id::text) e from public.proctor_sessions"),
    messages: await q("select exam_id e from public.proctor_messages"),
    ai_reports: await q("select exam_id e from public.ai_reports"),
    mobile: await q("select public.attempt_exam(attempt_id::text) e from public.mobile_upload_sessions"),
    mobile_events: await q("select public.mobile_session_exam(session_id) e from public.mobile_session_events"),
    questions: await q("select coalesce(exam_id, 'bank:' || id) e from public.questions"),
    exam_questions: await q("select exam_id e from public.exam_questions"),
    comments: await q("select public.attempt_exam(attempt_id::text) e from public.grading_comments"),
    delegations: await q("select public.attempt_exam(attempt_id::text) e from public.grading_delegations"),
    submissions: await q("select public.attempt_exam(attempt_id::text) e from public.question_submissions"),
    audit: await q("select action || ':' || coalesce(target_id, '') e from public.audit_logs"),
    evidence: await q("select name e from storage.objects where bucket_id = 'exam-records'"),
  };
}
const NONE = {
  exams: [], enrollments: [], attempts: [], staff_attempts: [], proctor_attempts: [], violations: [], flag_reviews: [],
  sessions: [], messages: [], ai_reports: [], mobile: [], mobile_events: [], questions: [], exam_questions: [], comments: [],
  delegations: [], submissions: [], audit: [], evidence: [],
};
const EX1 = ["EX-1"];
const EX1_AUDIT = ["attempt.paused:" + A1, "attempt.score_changed:" + A1, "exam.published:EX-1"];
const fullEx1 = (evidence: string[]) => ({
  exams: EX1, enrollments: EX1, attempts: EX1, staff_attempts: EX1, proctor_attempts: EX1, violations: EX1, flag_reviews: EX1,
  sessions: EX1, messages: EX1, ai_reports: EX1, mobile: EX1, mobile_events: EX1, questions: ["EX-1", "bank:QBANK", "bank:QPOOL"],
  exam_questions: EX1, comments: EX1, delegations: EX1, submissions: EX1, audit: EX1_AUDIT, evidence,
});
const score = async (id: string) => Number((await rows<{ score: string }>("select score from public.attempts where id = $1", [id]))[0].score);
const canJoin = (who: string, room: string) =>
  as(who, async () => (await rows<{ ok: boolean }>("select public.can_join_livekit_room($1) ok", [room]))[0].ok);
const folderAccess = (who: string) => as(who, async () => Object.fromEntries(
  (await rows<{ folder: string; access: string | null }>(
    "select folder, access from public.evidence_folder_access(array['EX-1', 'Mid-term', 'Mid term', 'EX-NULL', 'Legacy'])",
  )).map((r) => [r.folder, r.access])));

describe("the exam's owner", () => {
  it("sees all of their exam, including the old name folders", async () => {
    expect(await visible(U.owner)).toEqual(fullEx1(["EX-1/R1/phone.jpg", "Mid term/R1/old.png", "Mid-term/R1/screen.png"]));
  });

  it("changes marks, adds time and gets a LiveKit token", async () => {
    await as(U.owner, () => rows(`update public.attempts set score = 40 where id = '${A1}'`));
    expect(await score(A1)).toBe(40);
    await as(U.owner, () => rows(`select * from public.add_attempt_extra_minutes('${A1}', 5)`));
    expect((await rows<{ extra_minutes: number }>("select extra_minutes from public.attempts where id = $1", [A1]))[0].extra_minutes).toBe(5);
    expect(await canJoin(U.owner, "EX-1")).toBe(true);
    expect(await canJoin(U.owner, "voice-EX-1-R1")).toBe(true);
  });

  it("cannot hand the exam to someone else", async () => {
    await expect(as(U.owner, () => rows(`update public.exams set created_by = '${U.other}' where id = 'EX-1'`)))
      .rejects.toThrow(/row-level security/);
    await as(U.owner, () => rows("update public.exams set name = 'Mid term 2' where id = 'EX-1'"));
    expect((await rows<{ name: string }>("select name from public.exams where id = 'EX-1'"))[0].name).toBe("Mid term 2");
  });
});

describe("a delegated teacher", () => {
  const evidence = ["EX-1/R1/phone.jpg"];

  it("sees the exam through grading_delegations, but not the old name folders", async () => {
    expect(await visible(U.delegate)).toEqual(fullEx1(evidence));
    expect(await folderAccess(U.delegate)).toEqual({ "EX-1": "full", "Mid-term": null, "Mid term": null, "EX-NULL": null, Legacy: null });
  });

  it("sees the exam through a teacher proctor assignment", async () => {
    expect(await visible(U.assigned)).toEqual(fullEx1(evidence));
  });

  it("changes marks and adds time", async () => {
    await as(U.delegate, () => rows(`update public.attempts set score = 39 where id = '${A1}'`));
    expect(await score(A1)).toBe(39);
    await as(U.delegate, () => rows(`select * from public.add_attempt_extra_minutes('${A1}', 3)`));
    expect(await canJoin(U.delegate, "EX-1")).toBe(true);
  });

  it("cannot assign staff or edit the exam's questions", async () => {
    await expect(as(U.delegate, () => rows(`insert into public.proctor_assignments (exam_id, assignee_id) values ('EX-1', '${T.other}')`)))
      .rejects.toThrow(/row-level security/);
    await as(U.delegate, () => rows("update public.questions set answer = 'z' where id = 'Q1'"));
    expect((await rows<{ answer: string }>("select answer from public.questions where id = 'Q1'"))[0].answer).toBe("b");
  });
});

describe("an admin", () => {
  it("sees every exam", async () => {
    const all = await visible(U.admin);
    for (const [table, exams] of Object.entries(all)) {
      if (table === "audit" || table === "evidence" || table === "questions" || table === "delegations") continue;
      expect(exams, table).toEqual(["EX-1", "EX-NULL"]);
    }
    expect(all.evidence).toHaveLength(5);
    expect(all.audit).toHaveLength(4);
  });

  it("marks any exam and gets a token for an unowned one", async () => {
    await as(U.admin, () => rows(`update public.attempts set score = 9 where id = '${A2}'`));
    expect(await score(A2)).toBe(9);
    expect(await canJoin(U.admin, "EX-NULL")).toBe(true);
    expect(await canJoin(U.admin, "no-such-exam")).toBe(false);
  });
});

describe("an assigned proctor", () => {
  it("sees the live data but no marks, answers, keys or grading data", async () => {
    expect(await visible(U.proctor)).toEqual({
      ...NONE,
      exams: EX1, enrollments: EX1, proctor_attempts: EX1, violations: EX1, flag_reviews: EX1, sessions: EX1,
      messages: EX1, ai_reports: EX1, mobile: EX1, mobile_events: EX1,
      audit: ["attempt.paused:" + A1, "exam.published:EX-1"],
    });
  });

  it("gets attempt state without mark or answer columns", async () => {
    const cols = (await rows<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'proctor_attempts'")).map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(["id", "exam_id", "student_id", "state", "answered", "paused_at"]));
    for (const hidden of ["score", "percentage", "passed", "rank", "answers", "paper", "resume_state"]) expect(cols).not.toContain(hidden);
  });

  it("flags, messages and pauses", async () => {
    await as(U.proctor, () => rows(`insert into public.violation_events (exam_id, student_id, attempt_id, severity) values ('EX-1', '${S1}', '${A1}', 'high')`));
    await as(U.proctor, () => rows("insert into public.proctor_messages (exam_id, body) values ('EX-1', 'eyes on screen')"));
    expect((await as(U.proctor, () => rows<{ s: string }>(`select public.set_attempt_paused('${A1}', true) s`)))[0].s).toBe("paused");
    const [a] = await rows<{ state: string; paused_at: string | null }>("select state, paused_at from public.attempts where id = $1", [A1]);
    expect(a.state).toBe("paused");
    expect(a.paused_at).not.toBeNull();
    await as(U.proctor, () => rows(`select public.set_attempt_paused('${A1}', false)`));
    expect((await rows<{ state: string }>("select state from public.attempts where id = $1", [A1]))[0].state).toBe("in_progress");
    expect(await canJoin(U.proctor, "EX-1")).toBe(true);
    expect(await canJoin(U.proctor, "voice-EX-1-R1")).toBe(true);
  });

  it("cannot change marks, add time, or read old name folders", async () => {
    await as(U.proctor, () => rows(`update public.attempts set score = 100 where id = '${A1}'`));
    expect(await score(A1)).toBe(42);
    await expect(as(U.proctor, () => rows(`select public.test_set_score('${A1}', 100)`))).rejects.toThrow(/marks_forbidden/);
    expect(await score(A1)).toBe(42);
    await expect(as(U.proctor, () => rows(`select * from public.add_attempt_extra_minutes('${A1}', 5)`))).rejects.toThrow(/forbidden/);
    expect(await folderAccess(U.proctor)).toEqual({ "EX-1": "proctor", "Mid-term": null, "Mid term": null, "EX-NULL": null, Legacy: null });
  });

  it("cannot pause or join another exam", async () => {
    await expect(as(U.proctor, () => rows(`select public.set_attempt_paused('${A2}', true)`))).rejects.toThrow(/forbidden/);
    expect(await canJoin(U.proctor, "EX-NULL")).toBe(false);
  });
});

describe("an unassigned proctor and another teacher", () => {
  it.each([["unassigned proctor", U.loose], ["other teacher", U.other]])("%s sees nothing and gets no LiveKit token", async (_label, who) => {
    const seen = await visible(who);
    expect({ ...seen, questions: seen.questions.filter((q) => !q.startsWith("bank:")) }).toEqual(NONE);
    expect(await canJoin(who, "EX-1")).toBe(false);
    expect(await canJoin(who, "voice-EX-1-R1")).toBe(false);
    expect(Object.values(await folderAccess(who)).every((v) => v === null)).toBe(true);
    await expect(as(who, () => rows(`select public.set_attempt_paused('${A1}', true)`))).rejects.toThrow(/forbidden/);
  });

  it("another teacher reads an unattached bank question but cannot edit it", async () => {
    expect((await visible(U.other)).questions).toEqual(["bank:QBANK"]);
    expect((await visible(U.loose)).questions).toEqual([]);
    await as(U.other, () => rows("update public.questions set answer = 'z' where id = 'QBANK'"));
    expect((await rows<{ answer: string }>("select answer from public.questions where id = 'QBANK'"))[0].answer).toBe("c");
    await as(U.owner, () => rows("update public.questions set answer = 'y' where id = 'QBANK'"));
    expect((await rows<{ answer: string }>("select answer from public.questions where id = 'QBANK'"))[0].answer).toBe("y");
  });

  it("another teacher cannot write evidence, marks or questions into the exam", async () => {
    await as(U.other, () => rows(`update public.attempts set score = 0 where id = '${A1}'`));
    expect(await score(A1)).toBe(42);
    await expect(as(U.other, () => rows("insert into storage.objects (bucket_id, name) values ('exam-records', 'EX-1/R1/x.png')")))
      .rejects.toThrow(/row-level security/);
    await expect(as(U.other, () => rows("insert into public.questions (id, exam_id, created_by) values ('QX', 'EX-1', current_setting('request.jwt.claim.sub')::uuid)")))
      .rejects.toThrow(/row-level security/);
  });
});

describe("an exam with no owner", () => {
  it("is admin-only", async () => {
    for (const who of [U.owner, U.delegate, U.proctor, U.other]) {
      const seen = await visible(who);
      expect(seen.attempts, who).not.toContain("EX-NULL");
      expect(seen.proctor_attempts, who).not.toContain("EX-NULL");
    }
  });

  it("takes the owner the audit log records, when there is one", async () => {
    await db.exec(`update public.exams set created_by = null where id = 'EX-1'`);
    await loadMigrations();
    expect((await rows<{ created_by: string }>("select created_by from public.exams where id = 'EX-1'"))[0].created_by).toBe(U.owner);
    expect((await rows<{ created_by: string | null }>("select created_by from public.exams where id = 'EX-NULL'"))[0].created_by).toBeNull();
  });
});