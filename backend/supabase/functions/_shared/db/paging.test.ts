// @vitest-environment node
// Reads larger than PostgREST's 1,000-row cap: the paging helper, the ERP
// export of an exam with 1,500 students, and every list the admin console reads.
import { describe, expect, it } from "vitest";
import { createResultsExportHandler } from "../results/handler.ts";
import { supabaseResultsStore } from "../results/supabaseStore.ts";
import { supabaseAdminStore } from "../admin/supabaseStore.ts";
import { fakeSupabase, type Row } from "./fakeSupabase.ts";
import { readAll, readAllIn } from "./paging.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const pad = (i: number) => String(i).padStart(5, "0");
const uuid = (prefix: string, i: number) => `${prefix}0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("paging helper", () => {
  it("the fake caps a plain read at 1,000 rows, as PostgREST does", async () => {
    const db = fakeSupabase({ t: range(2345).map((i) => ({ id: pad(i) })) });
    expect((await db.from("t").select("id")).data).toHaveLength(1000);
  });

  it("reads every row a page at a time", async () => {
    const db = fakeSupabase({ t: range(2345).map((i) => ({ id: pad(i) })) });
    const rows = await readAll(() => db.from("t").select("id").order("id"));
    expect(rows).toHaveLength(2345);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2345);
    expect(db.requests).toHaveLength(3);
  });

  it("reads a long id list in chunks, each chunk completely", async () => {
    const db = fakeSupabase({ t: range(3000).map((i) => ({ id: pad(i), exam: `E${i % 2}` })) });
    expect(await readAllIn(["E0", "E1"], (c) => db.from("t").select("id").in("exam", c).order("id"))).toHaveLength(3000);
    expect(await readAllIn([], (c) => db.from("t").select("id").in("exam", c).order("id"))).toEqual([]);
  });

  it("fails loudly on an error instead of returning a partial list", async () => {
    const db = fakeSupabase({ t: [{ id: "1" }] });
    await expect(readAll(() => db.from("t").select("id"))).rejects.toThrow(/without an order/);
  });
});

describe("ERP export at university scale", () => {
  const STUDENTS = 1500;
  function university() {
    const students: Row[] = range(STUDENTS).map((i) => ({ id: uuid("s", i), roll: `21BQ1A${pad(i)}`, full_name: `Student ${i}` }));
    const absent = new Set(range(50).map((i) => i * 30));
    const held = new Set([1, 2, 3]);
    const attempts: Row[] = range(STUDENTS).filter((i) => !absent.has(i)).map((i) => ({
      id: uuid("a", i), exam_id: "EX-1", student_id: uuid("s", i), state: "submitted", score: i % 11,
      submitted_at: "2026-10-09T08:40:00Z", paper: null, answers: { q1: 0, q2: 1 },
    }));
    return fakeSupabase({
      exams: [{
        id: "EX-1", name: "Data Structures Mid-term", batch: "CSE", status: "published", scheduled_at: "2026-10-09T08:00:00Z",
        duration_minutes: 60, total_marks: 10, passing_marks: 40, created_by: "teacher-A",
        settings: { results_published: true, programme: "B.Tech CSE", semester: "3", courseCode: "CS301" },
      }],
      exam_questions: [{ exam_id: "EX-1", question_id: "q1" }, { exam_id: "EX-1", question_id: "q2" }],
      questions: [
        { id: "q1", exam_id: "EX-1", title: "Q1", type: "MCQ", unit: null, difficulty: null, marks: 5, options: ["a", "b"], answer: "0", subjective_mode: null },
        { id: "q2", exam_id: "EX-1", title: "Q2", type: "MCQ", unit: null, difficulty: null, marks: 5, options: ["a", "b"], answer: "0", subjective_mode: null },
      ],
      enrollments: students.map((s) => ({ exam_id: "EX-1", student_id: s.id })),
      students,
      attempts,
      result_holds: [...held].map((i) => ({ attempt_id: uuid("a", i), exam_id: "EX-1", student_id: uuid("s", i) })),
      audit_logs: [],
    });
  }

  it("exports all 1,500 enrolled students, absentees and held results included", async () => {
    const db = university();
    const handler = createResultsExportHandler({
      store: supabaseResultsStore(db), actor: async () => ({ authId: "teacher-A", isAdmin: false }), now: () => NOW,
    });
    const res = await handler(new Request("https://fn/results-export", { method: "POST", body: JSON.stringify({ scope: "exam", examId: "EX-1", format: "csv" }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const lines = String(body.content).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines).toHaveLength(STUDENTS + 1);
    expect(new Set(lines.slice(1).map((l) => l.split(",")[0])).size).toBe(STUDENTS);
    expect(body.summary).toMatchObject({ rows: STUDENTS, absent: 50, withheld: 3, pending: 0 });
    expect(lines.filter((l) => l.includes(",ABSENT,"))).toHaveLength(50);
    expect(lines.filter((l) => l.includes(",WITHHELD,"))).toHaveLength(3);
    expect(db.tables.audit_logs[0]).toMatchObject({ action: "results.exported", meta: expect.objectContaining({ rows: STUDENTS }) });
  });

  it("finds every exam of a programme when there are more than 1,000", async () => {
    const db = fakeSupabase({
      exams: range(1200).map((i) => ({ id: `EX-${pad(i)}`, name: `Exam ${i}`, status: "published", settings: { programme: "B.Tech CSE", semester: i % 2 ? "3" : "III" } })),
    });
    const exams = await supabaseResultsStore(db).examsForProgramme("b.tech cse", "3");
    expect(exams).toHaveLength(600);
  });
});

describe("admin console reads at university scale", () => {
  const since = "2026-09-09T00:00:00Z";
  const at = (i: number) => new Date(Date.parse("2026-10-01T00:00:00Z") + i * 1000).toISOString();
  const db = fakeSupabase({
    exams: range(1001).map((i) => ({ id: `EX-${pad(i)}`, name: `Exam ${i}`, scheduled_at: i % 5 ? at(i) : null, settings: {} })),
    teachers: range(1050).map((i) => ({ id: uuid("t", i), auth_id: uuid("u", i), name: `T${i}`, role: "teacher" })),
    staff_admins: [{ auth_id: uuid("u", 1) }],
    students: range(2500).map((i) => ({ id: uuid("s", i), auth_id: uuid("v", i), roll: `R${pad(i)}`, full_name: `S${i}` })),
    student_photos: range(1800).map((i) => ({ student_id: uuid("s", i), storage_path: `p/${i}.jpg`, captured_at: at(i) })),
    enrollments: range(1500).map((i) => ({ exam_id: "EX-00001", student_id: uuid("s", i) })),
    attempts: range(3000).map((i) => ({ id: uuid("a", i), exam_id: "EX-00001", student_id: uuid("s", i % 2500), state: "submitted", started_at: at(i) })),
    exam_questions: range(1200).map((i) => ({ exam_id: "EX-00001", question_id: `q${pad(i)}` })),
    questions: [],
    violation_events: range(2400).map((i) => ({ id: uuid("f", i), exam_id: "EX-00001", severity: i % 2 ? "high" : "warning", created_at: at(i) })),
    flag_reviews: range(1100).map((i) => ({ violation_id: uuid("f", i) })),
    lti_grade_targets: range(1200).map((i) => ({ link_id: uuid("l", i % 3), student_id: uuid("s", i), exam_id: "EX-00001", lineitem: "li", pending_score: 5 })),
    lti_pending_users: range(1100).map((i) => ({ id: uuid("p", i), last_launch_at: at(i) })),
    result_holds: range(1100).map((i) => ({ attempt_id: uuid("a", i), exam_id: "EX-00001", student_id: uuid("s", i), held_at: at(i) })),
    mobile_upload_sessions: range(1300).map((i) => ({ id: uuid("m", i), attempt_id: uuid("a", i), exam_id: null, status: "WAITING", created_at: at(i) })),
    evidence_usage: range(1100).map((i) => ({ folder: `F${pad(i)}`, bytes: 1, objects: 1, counted_at: at(i) })),
    evidence_sittings: range(2000).map((i) => ({ folder: "F00001", student_folder: `R${pad(i)}`, kinds: ["recordings"], files: 1 })),
  });
  const store = supabaseAdminStore(db);

  it("reads every row of each list", async () => {
    expect(await store.exams()).toHaveLength(1001);
    expect(await store.staff()).toHaveLength(1050);
    expect(await store.allStudents()).toHaveLength(2500);
    expect(await store.registrationPhotos()).toHaveLength(1800);
    expect(await store.enrollments(["EX-00001"])).toHaveLength(1500);
    expect(await store.attempts(since)).toHaveLength(3000);
    expect((await store.questionCounts(["EX-00001"])).get("EX-00001")).toBe(1200);
    expect(await store.flags(since)).toHaveLength(2400);
    expect(await store.flags(since, ["high", "critical"])).toHaveLength(1200);
    expect((await store.reviewedFlags(range(2400).map((i) => uuid("f", i)))).size).toBe(1100);
    expect(await store.gradeTargets()).toHaveLength(1200);
    expect(await store.pendingMoodleUsers()).toHaveLength(1100);
    expect(await store.holds()).toHaveLength(1100);
    expect(await store.evidenceUsage()).toHaveLength(1100);
    expect(await store.evidenceSittings(["F00001"])).toHaveLength(2000);
    expect((await store.students(range(2500).map((i) => uuid("s", i)))).size).toBe(2500);
  });

  it("finds the exam of every unfinished phone upload, not just the first thousand", async () => {
    const { pending } = await store.phoneUploads(since);
    expect(pending).toHaveLength(1300);
    expect(pending.every((p) => p.exam_id === "EX-00001")).toBe(true);
  });

  it("counts every Moodle grade it queues again", async () => {
    expect(await store.resendGrades(null, "2026-10-09T12:00:00Z")).toBe(1200);
  });
});
