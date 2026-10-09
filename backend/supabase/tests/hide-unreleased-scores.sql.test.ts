// @vitest-environment node
// Marks are not readable off the attempts table by a signed-in student, even
// through the raw API; staff read them through staff_attempts, students only
// through student_result_states(). A hold clears a grade Moodle already has.
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { actAs, BASE, migration } from "./pgliteBase";

const U = {
  owner: "00000000-0000-0000-0000-00000000000a",
  proctor: "00000000-0000-0000-0000-00000000000c",
  studentAuth: "00000000-0000-0000-0000-00000000000e",
};
const S1 = "10000000-0000-0000-0000-000000000001";
const A1 = "20000000-0000-0000-0000-000000000001";
const LINK = "30000000-0000-0000-0000-000000000001";

let db: PGlite;
let as: ReturnType<typeof actAs>;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

beforeAll(async () => {
  db = new PGlite();
  as = actAs(db);
  await db.exec(BASE);
  await db.exec(migration("20261010150000_university_scale.sql"));
  await db.exec(migration("20261010170000_hide_unreleased_scores.sql"));
}, 60_000);

const publish = (on: boolean) => db.exec(`update public.exams set settings = '${JSON.stringify({ results_published: on })}' where id = 'EX-1'`);
const hold = (on: boolean) => as(U.owner, () => rows<{ r: string }>("select public.set_result_hold($1, $2, 'phone seen') r", [A1, on]));
const student = <T>(sql: string) => as(U.studentAuth, () => rows<T>(sql));

beforeEach(async () => {
  await db.exec(`
    truncate public.teachers, public.staff_admins, public.students, public.exams, public.enrollments, public.attempts,
      public.result_holds, public.lti_grade_targets, public.audit_logs restart identity cascade;
    insert into public.teachers (auth_id, role) values ('${U.owner}', 'teacher'), ('${U.proctor}', 'proctor');
    insert into public.students values ('${S1}', '${U.studentAuth}', 'R1', 'One');
    insert into public.exams values ('EX-1', 'Mid-term', 'published', now() - interval '3 hours', 60, '{}', '${U.owner}');
    insert into public.enrollments values ('EX-1', '${S1}');
    insert into public.attempts (id, exam_id, student_id, state, score, percentage, passed, rank, answers, paper)
      values ('${A1}', 'EX-1', '${S1}', 'submitted', 42, 84, true, 1, '{"q1": 2}', '[{"id": "q1", "options": ["b", "a"]}]');
  `);
});

describe("a student reading the attempts table directly", () => {
  for (const col of ["score", "percentage", "passed", "rank", "*"]) {
    it(`cannot read ${col} while the result is unreleased`, async () => {
      await publish(false);
      await expect(student(`select ${col} from public.attempts`)).rejects.toThrow(/permission denied/);
    });

    it(`cannot read ${col} while the result is held, even once published`, async () => {
      await publish(true);
      await hold(true);
      await expect(student(`select ${col} from public.attempts`)).rejects.toThrow(/permission denied/);
    });
  }

  it("cannot filter or sort on the score to infer it", async () => {
    await expect(student("select id from public.attempts where score > 40")).rejects.toThrow(/permission denied/);
    await expect(student("select id from public.attempts order by score")).rejects.toThrow(/permission denied/);
  });

  it("still reads the columns resume, autosave and the results pages use", async () => {
    expect(await student("select id, state, answers, paper, extra_minutes, submitted_at from public.attempts")).toMatchObject([
      { id: A1, state: "submitted", answers: { q1: 2 }, paper: [{ id: "q1", options: ["b", "a"] }] },
    ]);
  });

  it("cannot read marks through staff_attempts", async () => {
    expect(await student("select score from public.staff_attempts")).toEqual([]);
    await expect(as(null, () => rows("select score from public.staff_attempts"))).rejects.toThrow(/permission denied/);
    await expect(as(null, () => rows("select score from public.attempts"))).rejects.toThrow(/permission denied/);
  });

  it("cannot write through staff_attempts", async () => {
    await expect(student(`update public.staff_attempts set score = 100 where id = '${A1}'`)).rejects.toThrow(/permission denied/);
    await expect(as(U.owner, () => rows(`update public.staff_attempts set score = 100 where id = '${A1}'`))).rejects.toThrow(/permission denied/);
  });

  it("gets the score only from student_result_states, after release and without a hold", async () => {
    const mine = () => student<{ held: boolean; score: string | null }>("select held, score from public.student_result_states()");
    await publish(false);
    expect(await mine()).toEqual([{ held: false, score: null }]);
    await publish(true);
    expect(await mine()).toEqual([{ held: false, score: "42" }]);
    await hold(true);
    expect(await mine()).toEqual([{ held: true, score: null }]);
    await hold(false);
    expect(await mine()).toEqual([{ held: false, score: "42" }]);
  });
});

describe("staff", () => {
  it("teachers and proctors read marks through staff_attempts, whatever the release state", async () => {
    await publish(false);
    await hold(true);
    for (const who of [U.owner, U.proctor]) {
      expect(await as(who, () => rows("select score, percentage, passed, rank from public.staff_attempts"))).toEqual([
        { score: "42", percentage: "84", passed: true, rank: 1 },
      ]);
    }
  });

  it("a teacher can still change a score on the attempts table", async () => {
    await as(U.owner, () => rows(`update public.attempts set score = 40 where id = '${A1}'`));
    expect(await rows("select score from public.attempts")).toEqual([{ score: "40" }]);
  });
});

describe("Moodle while a result is held", () => {
  type Claimed = { link_id: string; pending_score: string; clear: boolean; claim_token: string };
  const claim = () => rows<Claimed>("select * from public.lti_claim_scores(now(), 10, 60)");
  const finish = (c: Claimed, ok = true) =>
    rows("select public.lti_finish_score($1, $2, $3, $4, $5, null, 1, now() + interval '1 minute', now(), $6)",
      [c.link_id, S1, c.claim_token, c.pending_score, ok, c.clear]);
  const target = async () => (await rows<any>("select pending_score, last_score, clear_pending, cleared, next_attempt_at <= now() due from public.lti_grade_targets"))[0];
  const posted = (score: number) => db.exec(`
    insert into public.lti_grade_targets (link_id, student_id, exam_id, sub, lineitem, score_maximum, last_score, last_posted_at)
    values ('${LINK}', '${S1}', 'EX-1', 'moodle-sub', 'https://moodle/lineitem/1', 100, ${score}, now() - interval '1 hour')`);

  it("clears a grade Moodle already has, then posts the real score on release", async () => {
    await posted(42);
    await hold(true);
    expect(await target()).toMatchObject({ pending_score: "42", clear_pending: true, cleared: false, due: true });

    const [c] = await claim();
    expect(c).toMatchObject({ link_id: LINK, clear: true });
    await finish(c);
    expect(await target()).toMatchObject({ pending_score: "42", clear_pending: false, cleared: true });
    expect(await claim()).toEqual([]);

    await hold(false);
    const [real] = await claim();
    expect(real).toMatchObject({ pending_score: "42", clear: false });
    await finish(real);
    expect(await target()).toMatchObject({ pending_score: null, last_score: "42", cleared: false, clear_pending: false });
  });

  it("retries a failed clear while held", async () => {
    await posted(42);
    await hold(true);
    await finish((await claim())[0], false);
    expect(await target()).toMatchObject({ clear_pending: true, cleared: false, due: false });
  });

  it("clears again when a hold lands while the real score is on its way", async () => {
    await db.exec(`
      insert into public.lti_grade_targets (link_id, student_id, exam_id, sub, lineitem, score_maximum, pending_score, next_attempt_at)
      values ('${LINK}', '${S1}', 'EX-1', 'moodle-sub', 'https://moodle/lineitem/1', 100, 42, now() - interval '1 minute')`);
    const [inFlight] = await claim();
    expect(inFlight.clear).toBe(false);
    await hold(true);
    await finish(inFlight);
    expect(await target()).toMatchObject({ last_score: "42", pending_score: "42", clear_pending: true, due: true });
    expect((await claim())[0]).toMatchObject({ clear: true });
  });

  it("sends nothing for a held score Moodle never received", async () => {
    await db.exec(`
      insert into public.lti_grade_targets (link_id, student_id, exam_id, sub, lineitem, score_maximum, pending_score, next_attempt_at)
      values ('${LINK}', '${S1}', 'EX-1', 'moodle-sub', 'https://moodle/lineitem/1', 100, 42, now() - interval '1 minute')`);
    await hold(true);
    expect(await target()).toMatchObject({ clear_pending: false });
    expect(await claim()).toEqual([]);
  });

  it("the grade functions stay service-role only", async () => {
    await expect(as(U.owner, () => rows("select * from public.lti_claim_scores(now(), 10, 60)"))).rejects.toThrow(/permission denied/);
  });
});
