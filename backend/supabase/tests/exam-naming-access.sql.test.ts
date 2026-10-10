// @vitest-environment node
// The access gaps closed after exam roles (AI reports, students, teachers,
// student evidence folders) and exams named by academic type, subject code
// and subject name.
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
  stu1: "00000000-0000-0000-0000-000000000101",
  stu3: "00000000-0000-0000-0000-000000000103",
};
const T = {
  owner: "50000000-0000-0000-0000-00000000000a",
  other: "50000000-0000-0000-0000-00000000000b",
  proctor: "50000000-0000-0000-0000-00000000000c",
  admin: "50000000-0000-0000-0000-00000000000d",
  loose: "50000000-0000-0000-0000-00000000000f",
  delegate: "50000000-0000-0000-0000-000000000010",
  assigned: "50000000-0000-0000-0000-000000000011",
};
const S1 = "10000000-0000-0000-0000-000000000001";
const S2 = "10000000-0000-0000-0000-000000000002";
const S3 = "10000000-0000-0000-0000-000000000003";
const S4 = "10000000-0000-0000-0000-000000000004";
const A1 = "20000000-0000-0000-0000-000000000001";
const A2 = "20000000-0000-0000-0000-000000000002";
const A4 = "20000000-0000-0000-0000-000000000004";
const AS1 = "20000000-0000-0000-0000-000000000005";

const SCHEMA = `
alter table public.teachers add column name text, add column full_name text, add column email text,
  add column department text, add column designation text, add column settings jsonb;
alter table public.students add column email text, add column branch text, add column section text,
  add column phone text, add column batch text;
alter table public.students alter column id set default gen_random_uuid();
alter table public.students add constraint students_roll_key unique (roll);
alter table public.exams add column created_at timestamptz default now();
alter table public.ai_reports alter column summary type jsonb using summary::jsonb;
alter table public.students enable row level security;
alter table public.teachers enable row level security;
grant select, insert, update, delete on public.students to authenticated;
grant select on public.teachers to authenticated;
create policy "ep students self" on public.students for select using (auth_id = auth.uid());
create policy "ep students staff read" on public.students for select to authenticated using (public.auth_is_staff());
create policy "ep students teacher write" on public.students for all to authenticated
  using (public.auth_is_teacher()) with check (public.auth_is_teacher());
create policy "ep teachers self read" on public.teachers for select to authenticated using (auth_id = auth.uid());
create policy "ep teachers staff read" on public.teachers for select using (public.auth_is_staff());
create policy "ep aireports student" on public.ai_reports for select using (student_id = public.current_student_id());
`;

let db: PGlite;
let as: ReturnType<typeof actAs>;
const rows = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;
const NAMING = migration("20261010210000_exam_naming_and_access.sql");

beforeAll(async () => {
  db = new PGlite();
  as = actAs(db);
  await db.exec(BASE);
  await db.exec(EXAM_ROLES_SCHEMA);
  await db.exec(SCHEMA);
  for (const m of ["20261010150000_university_scale.sql", "20261010170000_hide_unreleased_scores.sql",
    "20261010180000_exam_scoped_staff_access.sql", "20261010190000_exam_access_no_proctors.sql", "20261010200000_exam_roles.sql"]) {
    await db.exec(migration(m));
  }
  await db.exec(NAMING);
}, 60_000);

beforeEach(async () => {
  await db.exec(`
    truncate public.teachers, public.staff_admins, public.students, public.exams, public.academic_types, public.enrollments,
      public.attempts, public.proctor_assignments, public.ai_reports, public.grading_delegations restart identity cascade;
    insert into public.academic_types (name, sort_order) values ('Sem Exam', 10), ('Mid Term', 20), ('Test Exam', 30);
    insert into public.teachers (id, auth_id, role, full_name, email, settings) values
      ('${T.owner}', '${U.owner}', 'teacher', 'Owner', 'owner@x.invalid', '{"secret": 1}'),
      ('${T.other}', '${U.other}', 'teacher', 'Other', 'other@x.invalid', null),
      ('${T.proctor}', '${U.proctor}', 'proctor', 'Proctor', 'proctor@x.invalid', null),
      ('${T.admin}', '${U.admin}', 'teacher', 'Admin', 'admin@x.invalid', null),
      ('${T.loose}', '${U.loose}', 'proctor', 'Loose', 'loose@x.invalid', null),
      ('${T.delegate}', '${U.delegate}', 'teacher', 'Delegate', 'delegate@x.invalid', null),
      ('${T.assigned}', '${U.assigned}', 'teacher', 'Assigned', 'assigned@x.invalid', null);
    insert into public.staff_admins values ('${U.admin}');
    insert into public.students (id, auth_id, roll, full_name, email, branch, section, phone, batch) values
      ('${S1}', '${U.stu1}', 'R1', 'One', 'one@x.invalid', 'CSE', 'A', '111', 'CSE-A'),
      ('${S2}', null, 'R2', 'Two', null, 'CSE', 'B', null, 'CSE-B'),
      ('${S3}', '${U.stu3}', 'R3', 'Three', 'three@x.invalid', 'ECE', 'A', null, 'ECE-A'),
      ('${S4}', null, 'R4', 'Four', 'four@x.invalid', 'ECE', 'B', null, 'ECE-B');
    insert into public.exams (id, name, status, created_by) values
      ('EX-1', 'Mid term', 'published', '${U.owner}'),
      ('EX-NULL', 'Legacy', 'published', null),
      ('EX-2', 'Other', 'published', '${U.other}'),
      ('EX-S1', 'Shared', 'published', '${U.owner}'),
      ('EX-S2', 'Shared', 'published', '${U.other}');
    insert into public.enrollments values ('EX-1', '${S1}'), ('EX-1', '${S3}'), ('EX-NULL', '${S2}'),
      ('EX-S1', '${S1}'), ('EX-S2', '${S4}');
    insert into public.proctor_assignments (exam_id, assignee_id, assignee_role) values
      ('EX-1', '${T.proctor}', 'proctor'), ('EX-1', '${T.assigned}', 'teacher');
    insert into public.attempts (id, exam_id, student_id, state, score) values
      ('${A1}', 'EX-1', '${S1}', 'in_progress', null), ('${A4}', 'EX-1', '${S1}', 'submitted', 40),
      ('${A2}', 'EX-NULL', '${S2}', 'submitted', 10), ('${AS1}', 'EX-S1', '${S1}', 'submitted', 5);
    insert into public.grading_delegations (attempt_id, delegate_id) values ('${A1}', '${T.delegate}');
    insert into public.ai_reports (attempt_id, exam_id, student_id, summary) values
      ('${A1}', 'EX-1', '${S1}', '{"summary": "Calm sitting.", "incidents": [{"type": "tab_switch", "at": "10:02"}]}'),
      ('${A4}', 'EX-1', '${S1}', '{"summary": "x", "incidents": [{"type": "t", "score": 40}]}'),
      ('${A2}', 'EX-NULL', '${S2}', '{"summary": "ok", "incidents": []}');
  `);
});

const ids = async (who: string, sql: string) => as(who, async () => (await rows<{ v: string }>(sql)).map((r) => r.v).sort());

describe("ai_reports", () => {
  it("full-access staff read their exam's reports", async () => {
    for (const who of [U.owner, U.delegate, U.assigned]) {
      expect(await ids(who, "select attempt_id::text v from public.ai_reports"), who).toEqual([A1, A4]);
    }
    expect(await ids(U.admin, "select attempt_id::text v from public.ai_reports")).toEqual([A1, A2, A4]);
  });

  it("an assigned proctor reads only reports without marks or answers", async () => {
    expect(await ids(U.proctor, "select attempt_id::text v from public.ai_reports")).toEqual([A1]);
  });

  it("unassigned proctors and other teachers read none", async () => {
    for (const who of [U.loose, U.other]) expect(await ids(who, "select attempt_id::text v from public.ai_reports"), who).toEqual([]);
  });

  it("no signed-in user writes a verdict, not even the owner or an admin", async () => {
    for (const who of [U.proctor, U.owner, U.admin]) {
      await expect(as(who, () => rows(`update public.ai_reports set summary = '{}' where attempt_id = '${A1}'`)), who)
        .rejects.toThrow(/permission denied/);
      await expect(as(who, () => rows(`insert into public.ai_reports (attempt_id, exam_id, student_id) values ('${A2}', 'EX-1', '${S1}')`)), who)
        .rejects.toThrow(/permission denied/);
      await expect(as(who, () => rows(`delete from public.ai_reports where attempt_id = '${A1}'`)), who).rejects.toThrow(/permission denied/);
    }
  });

  it("finds marks and answers anywhere in a report", async () => {
    const has = async (j: string) => (await rows<{ v: boolean }>("select public.ai_report_has_marks($1::jsonb) v", [j]))[0].v;
    expect(await has('{"summary": "fine", "incidents": [{"type": "gaze", "note": "looked away"}]}')).toBe(false);
    expect(await has('{"incidents": [{"meta": {"Percentage": 80}}]}')).toBe(true);
    expect(await has('{"answers": {"Q1": "b"}}')).toBe(true);
    expect(await has('[{"marks": 2}]')).toBe(true);
    expect(await has('"plain"')).toBe(false);
  });
});

describe("students", () => {
  const seen = (who: string) => ids(who, "select roll v from public.students");

  it("staff read the students of exams they can access; admins read all", async () => {
    expect(await seen(U.owner)).toEqual(["R1", "R3"]);
    expect(await seen(U.delegate)).toEqual(["R1", "R3"]);
    expect(await seen(U.proctor)).toEqual(["R1", "R3"]);
    expect(await seen(U.other)).toEqual(["R4"]);
    expect(await seen(U.loose)).toEqual([]);
    expect(await seen(U.admin)).toEqual(["R1", "R2", "R3", "R4"]);
    expect(await seen(U.stu1)).toEqual(["R1"]);
  });

  it("only the owner of an exam the student is in, or an admin, edits the record", async () => {
    const rename = (who: string, id: string) =>
      as(who, async () => (await rows(`update public.students set full_name = 'Edited' where id = '${id}' returning id`)).length);
    expect(await rename(U.owner, S1)).toBe(1);
    expect(await rename(U.owner, S2)).toBe(0);
    expect(await rename(U.owner, S4)).toBe(0);
    expect(await rename(U.delegate, S1)).toBe(0);
    expect(await rename(U.proctor, S1)).toBe(0);
    expect(await rename(U.other, S1)).toBe(0);
    expect(await rename(U.admin, S2)).toBe(1);
    expect(await as(U.owner, async () => (await rows(`delete from public.students where id = '${S3}' returning id`)).length)).toBe(1);
    expect(await as(U.other, async () => (await rows(`delete from public.students where id = '${S1}' returning id`)).length)).toBe(0);
  });

  it("nobody relinks a record to another login, and teachers add students only through an import", async () => {
    await expect(as(U.owner, () => rows(`update public.students set auth_id = '${U.owner}' where id = '${S1}'`))).rejects.toThrow(/permission denied/);
    await expect(as(U.owner, () => rows("insert into public.students (roll) values ('R7')"))).rejects.toThrow(/row-level security/);
    await as(U.admin, () => rows("insert into public.students (roll) values ('R7')"));
  });

  it("the enrolment directory gives teachers roll, name and class only", async () => {
    const dir = await as(U.owner, () => rows<Record<string, unknown>>("select * from public.search_student_directory(null, 'ECE', null)"));
    expect(dir.map((r) => r.roll)).toEqual(["R3", "R4"]);
    expect(Object.keys(dir[0]).sort()).toEqual(["batch", "branch", "full_name", "has_email", "id", "roll", "section"]);
    expect(await as(U.owner, async () => (await rows("select * from public.search_student_directory('CSE-B')")).length)).toBe(1);
    const filters = await as(U.owner, () => rows<{ kind: string; value: string }>("select kind, value from public.student_directory_filters()"));
    expect(filters.filter((f) => f.kind === "branch").map((f) => f.value).sort()).toEqual(["CSE", "ECE"]);
    for (const who of [U.proctor, U.loose]) {
      expect(await as(who, async () => (await rows("select * from public.search_student_directory()")).length), who).toBe(0);
      expect(await as(who, async () => (await rows("select * from public.student_directory_filters()")).length), who).toBe(0);
    }
  });

  it("an import adds new students and enrolls everyone, but leaves other teachers' students as they are", async () => {
    const out = await as(U.owner, () => rows<{ roll: string; created: boolean; updated: boolean }>(
      `select roll, created, updated from public.import_students('EX-1', '[{"roll": "r9", "full_name": "Nine"}, {"roll": "R4", "full_name": "Hacked"}, {"roll": "R1", "full_name": "Uno"}]')`));
    expect(out).toEqual([
      { roll: "r9", created: true, updated: false },
      { roll: "R4", created: false, updated: false },
      { roll: "R1", created: false, updated: true },
    ]);
    const names = Object.fromEntries((await rows<{ roll: string; full_name: string }>("select roll, full_name from public.students")).map((r) => [r.roll, r.full_name]));
    expect(names).toMatchObject({ r9: "Nine", R4: "Four", R1: "Uno" });
    expect(await ids(U.owner, "select s.roll v from public.enrollments e join public.students s on s.id = e.student_id where e.exam_id = 'EX-1'"))
      .toEqual(["R1", "R3", "R4", "r9"]);
  });

  it("only the exam's owner or an admin imports into it", async () => {
    for (const who of [U.other, U.proctor, U.delegate]) {
      await expect(as(who, () => rows(`select * from public.import_students('EX-1', '[{"roll": "R8"}]')`)), who).rejects.toThrow(/forbidden/);
    }
    await expect(as(U.owner, () => rows(`select * from public.import_students(null, '[{"roll": "R8"}]')`))).rejects.toThrow(/forbidden/);
    await as(U.admin, () => rows(`select * from public.import_students(null, '[{"roll": "R8"}]')`));
    expect(await rows("select 1 from public.students where roll = 'R8'")).toHaveLength(1);
  });
});

describe("teachers", () => {
  const seen = (who: string) => ids(who, "select full_name v from public.teachers");

  it("staff read their own row and the staff on their exams; admins read all", async () => {
    expect(await seen(U.owner)).toEqual(["Assigned", "Delegate", "Owner", "Proctor"]);
    expect(await seen(U.delegate)).toEqual(["Assigned", "Delegate", "Owner", "Proctor"]);
    expect(await seen(U.proctor)).toEqual(["Owner", "Proctor"]);
    expect(await seen(U.other)).toEqual(["Other"]);
    expect(await seen(U.loose)).toEqual(["Loose"]);
    expect(await seen(U.admin)).toHaveLength(7);
  });

  it("the assignment picker lists staff names for teachers only, without settings or logins", async () => {
    const staff = await as(U.other, () => rows<Record<string, unknown>>("select * from public.list_assignable_staff()"));
    expect(staff).toHaveLength(7);
    expect(Object.keys(staff[0]).sort()).toEqual(["department", "email", "full_name", "id", "name", "role"]);
    expect(await as(U.proctor, async () => (await rows("select * from public.list_assignable_staff()")).length)).toBe(0);
  });
});

describe("student evidence folders", () => {
  const ok = (who: string, folder: string) =>
    as(who, async () => (await rows<{ v: boolean }>("select public.student_evidence_folder_ok($1) v", [folder]))[0].v);

  it("a student writes under an exam they are enrolled in and have an attempt for", async () => {
    expect(await ok(U.stu1, "EX-1")).toBe(true);
    expect(await ok(U.stu1, "EX-S1")).toBe(true);
  });

  it("an old kiosk may use the exam's name folder, unless another exam shares it", async () => {
    expect(await ok(U.stu1, "Mid term")).toBe(true);
    expect(await ok(U.stu1, "Mid-term")).toBe(true);
    expect(await ok(U.stu1, "Shared")).toBe(false);
  });

  it("refuses other exams, exams without an attempt, and unknown folders", async () => {
    expect(await ok(U.stu1, "EX-2")).toBe(false);
    expect(await ok(U.stu1, "EX-NULL")).toBe(false);
    expect(await ok(U.stu3, "EX-1")).toBe(false);
    expect(await ok(U.stu1, "Nowhere")).toBe(false);
    expect(await ok(U.owner, "EX-1")).toBe(false);
  });

  it("an owner no longer reads a name folder another exam shares", async () => {
    expect(await ids(U.owner, "select public.owner_legacy_folders() v")).toEqual(["Mid term", "Mid-term"]);
  });
});

describe("exam naming", () => {
  const create = (who: string, id: string, type: string | null, code: string | null, subject: string | null) =>
    as(who, () => rows("insert into public.exams (id, name, status, created_by, academic_type, subject_code, subject_name) values ($1, 'x', 'draft', $2, $3, $4, $5)",
      [id, who, type, code, subject]));
  const exam = async (id: string) => (await rows<Record<string, string | null>>(
    "select name, academic_type, subject_code, subject_name from public.exams where id = $1", [id]))[0];

  it("needs the academic type, subject code and subject name, and names the exam after them", async () => {
    await expect(create(U.owner, "EX-N1", null, "MBA101", "Economics")).rejects.toThrow(/exam_naming_required/);
    await expect(create(U.owner, "EX-N1", "Mid Term", " ", "Economics")).rejects.toThrow(/exam_naming_required/);
    await create(U.owner, "EX-N1", "Mid Term", " mba 101 ", "Business   Economics ");
    expect(await exam("EX-N1")).toEqual({
      name: "Mid Term · MBA101 · Business Economics", academic_type: "Mid Term", subject_code: "MBA101", subject_name: "Business Economics",
    });
  });

  it("lets any number of exams share a type, and a code or name repeat under another type", async () => {
    await create(U.owner, "EX-N1", "Mid Term", "MBA101", "Business Economics");
    await create(U.owner, "EX-N2", "Mid Term", "MBA102", "Accounting");
    await create(U.other, "EX-N3", "Sem Exam", "MBA101", "Business Economics");
    expect((await exam("EX-N3")).name).toBe("Sem Exam · MBA101 · Business Economics");
  });

  it("refuses a subject code or subject name already used under the same type", async () => {
    await create(U.owner, "EX-N1", "Mid Term", "MBA101", "Business Economics");
    await expect(create(U.other, "EX-N2", "Mid Term", "mba101", "Marketing")).rejects.toThrow(/exams_type_code_unique/);
    await expect(create(U.other, "EX-N2", "Mid Term", "MBA109", "business economics")).rejects.toThrow(/exams_type_subject_unique/);
    await as(U.owner, () => rows("update public.exams set subject_name = 'Accounting' where id = 'EX-N1'"));
    expect((await exam("EX-N1")).name).toBe("Mid Term · MBA101 · Accounting");
  });

  it("tells the form which field clashes, even for another teacher's exam", async () => {
    await create(U.owner, "EX-N1", "Mid Term", "MBA101", "Business Economics");
    const clash = (who: string, type: string, code: string, subject: string, exclude: string | null = null) =>
      as(who, async () => (await rows<{ v: string | null }>("select public.exam_naming_conflict($1, $2, $3, $4) v", [type, code, subject, exclude]))[0].v);
    expect(await clash(U.other, "Mid Term", "mba 101", "New")).toBe("subject_code");
    expect(await clash(U.other, "mid term", "MBA555", "BUSINESS  economics")).toBe("subject_name");
    expect(await clash(U.other, "Sem Exam", "MBA101", "Business Economics")).toBeNull();
    expect(await clash(U.owner, "Mid Term", "MBA101", "Business Economics", "EX-N1")).toBeNull();
    expect(await clash(U.proctor, "Mid Term", "MBA101", "Business Economics")).toBeNull();
  });

  it("allows two exams with the same plain name now, and leaves unnamed old exams editable", async () => {
    await db.exec("insert into public.exams (id, name, status) values ('EX-DUP', 'Mid term', 'draft')");
    await as(U.owner, () => rows("update public.exams set status = 'scheduled' where id = 'EX-1'"));
    expect((await exam("EX-1")).name).toBe("Mid term");
    await as(U.owner, () => rows(
      "insert into public.exams (id, name, status, created_by) values ('EX-1', 'Mid term', 'published', $1) on conflict (id) do update set status = excluded.status, name = excluded.name",
      [U.owner]));
    expect(await rows("select status from public.exams where id = 'EX-1'")).toEqual([{ status: "published" }]);
  });

  it("refuses a type an admin has retired", async () => {
    await as(U.admin, () => rows("update public.academic_types set active = false where name = 'Test Exam'"));
    await expect(create(U.owner, "EX-N1", "Test Exam", "CS1", "Intro")).rejects.toThrow(/exam_type_inactive/);
  });
});

describe("academic types", () => {
  it("are read by staff and managed by admins only", async () => {
    expect(await ids(U.proctor, "select name v from public.academic_types")).toEqual(["Mid Term", "Sem Exam", "Test Exam"]);
    await expect(as(U.owner, () => rows("insert into public.academic_types (name) values ('Final')"))).rejects.toThrow(/row-level security/);
    await as(U.admin, () => rows("insert into public.academic_types (name) values ('Final')"));
    await expect(as(U.admin, () => rows("insert into public.academic_types (name) values ('final')"))).rejects.toThrow(/academic_types_name_ci/);
  });

  it("a rename reaches every exam of that type; a type in use cannot be deleted", async () => {
    await as(U.owner, () => rows("insert into public.exams (id, name, status, created_by, academic_type, subject_code, subject_name) values ('EX-N1', 'x', 'draft', $1, 'Mid Term', 'MBA101', 'Economics')", [U.owner]));
    await db.exec("insert into public.exams (id, name, academic_type) values ('EX-OLD', 'Mid term old', 'Mid Term')");
    await as(U.admin, () => rows("update public.academic_types set name = 'Mid-Term Exam' where name = 'Mid Term'"));
    expect((await rows<{ name: string }>("select name from public.exams where id = 'EX-N1'"))[0].name).toBe("Mid-Term Exam · MBA101 · Economics");
    expect((await rows<{ academic_type: string }>("select academic_type from public.exams where id = 'EX-OLD'"))[0].academic_type).toBe("Mid-Term Exam");
    await expect(as(U.admin, () => rows("delete from public.academic_types where name = 'Mid-Term Exam'"))).rejects.toThrow(/foreign key/);
  });
});

describe("filling in existing exams", () => {
  it("takes the type, code and subject from the name, never renames, and leaves clashes empty", async () => {
    await db.exec(`
      truncate public.exams cascade;
      insert into public.exams (id, name, created_at) values
        ('OLD-1', 'Mid Term CS301 Data Structures', now() - interval '3 days'),
        ('OLD-2', 'Mid term - CS301 - Algorithms', now() - interval '2 days'),
        ('OLD-3', 'Mathematics Sem III', now()),
        ('OLD-4', 'Test 1', now()),
        ('OLD-5', 'Digital Electronics', now()),
        ('OLD-6', 'test 1', now() + interval '1 day');
    `);
    await db.exec(NAMING);
    const got = Object.fromEntries((await rows<{ id: string; name: string; academic_type: string | null; subject_code: string | null; subject_name: string | null; legacy_name: string }>(
      "select id, name, academic_type, subject_code, subject_name, legacy_name from public.exams order by id")).map((r) => [r.id, r]));
    expect(got["OLD-1"]).toMatchObject({ name: "Mid Term CS301 Data Structures", academic_type: "Mid Term", subject_code: "CS301", subject_name: "Mid Term Data Structures", legacy_name: "Mid Term CS301 Data Structures" });
    expect(got["OLD-2"]).toMatchObject({ academic_type: "Mid Term", subject_code: null, subject_name: "Mid term - Algorithms" });
    expect(got["OLD-3"]).toMatchObject({ academic_type: "Sem Exam", subject_code: null, subject_name: "Mathematics Sem III" });
    expect(got["OLD-4"]).toMatchObject({ academic_type: "Test Exam", subject_code: null, subject_name: "Test 1" });
    expect(got["OLD-5"]).toMatchObject({ academic_type: null, subject_code: null, subject_name: "Digital Electronics" });
    expect(got["OLD-6"]).toMatchObject({ academic_type: "Test Exam", subject_name: null });
  });
});
