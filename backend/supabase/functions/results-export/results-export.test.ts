// @vitest-environment node
// ERP results export: totals, absent and withheld students, the column config,
// the CSV/Excel files, who may export, and the audit entry.
import { beforeEach, describe, expect, it } from "vitest";
import type { DBQuestion } from "../_shared/exam/types.ts";
import { ERP_EXPORT_CONFIG, parseExportConfig, type ExportConfig } from "../_shared/results/columns.ts";
import { formatDate, toCsv, toTable, toXlsx } from "../_shared/results/formats.ts";
import { createResultsExportHandler, type Actor, type ExamData, type ResultsStore } from "../_shared/results/handler.ts";
import { buildExamRows, type ExportAttempt, type ExportExam, type ExportStudent } from "../_shared/results/rows.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const q = (id: string, type: string, marks: number, answer: string | null, options: string[] | null): DBQuestion =>
  ({ id, exam_id: "EX-1", title: id, type, unit: null, difficulty: null, marks, options, answer, subjective_mode: null });
const POOL = [q("q1", "MCQ", 2, "1", ["a", "b", "c"]), q("q2", "MCQ", 3, "0", ["p", "q"]), q("q3", "Subjective", 5, null, null)];

function exam(over: Partial<ExportExam> = {}, settings: Record<string, unknown> = {}): ExportExam {
  return {
    id: "EX-1", name: "Data Structures Mid-term", batch: "CSE — Sem III", status: "published",
    scheduled_at: "2026-10-09T08:00:00Z", duration_minutes: 60, total_marks: 10, passing_marks: 40, created_by: "teacher-A",
    settings: { results_published: true, programme: "B.Tech CSE", semester: "3", courseCode: "CS301", ...settings },
    ...over,
  };
}
const student = (id: string, roll: string, full_name: string): ExportStudent => ({ id, roll, full_name });
const STUDENTS = new Map([
  ["s1", student("s1", "21BQ1A0501", "Asha Rao")],
  ["s2", student("s2", "21BQ1A0502", "Ravi Teja")],
  ["s3", student("s3", "21BQ1A0503", "Absent Abhi")],
  ["s4", student("s4", "21BQ1A0504", "Held Hema")],
  ["s5", student("s5", "21BQ1A0505", "Pending Pavan")],
  ["s6", student("s6", "21BQ1A0506", "Started Sita")],
]);
const submitted = (id: string, sid: string, score: number | null, answers: Record<string, unknown>, at = "2026-10-09T08:40:00Z"): ExportAttempt =>
  ({ id, student_id: sid, state: "submitted", score, submitted_at: at, paper: null, answers });
const ATTEMPTS: ExportAttempt[] = [
  submitted("a1", "s1", 8, { q1: 1, q2: 0, q3: "a long answer" }),
  submitted("a2", "s2", 3, { q1: 0, q2: 0 }),
  submitted("a4", "s4", 9, { q1: 1, q2: 0 }),
  submitted("a5", "s5", null, { q1: 1 }),
  { id: "a6", student_id: "s6", state: "in_progress", score: null, submitted_at: null, paper: null, answers: { q1: 1 } },
];
const ENROLLED = ["s1", "s2", "s3", "s4", "s5", "s6"];

const build = (e: ExportExam = exam(), held = new Set(["a4"]), attempts = ATTEMPTS) =>
  buildExamRows({ exam: e, pool: POOL, enrolled: ENROLLED, students: STUDENTS, attempts, heldAttemptIds: held, now: NOW });
const byRoll = (rows: ReturnType<typeof build>["rows"], roll: string) => rows.find((r) => r.roll === roll)!;

describe("ERP rows: totals", () => {
  it("splits each total into MCQ and descriptive marks that add up", () => {
    const { rows } = build();
    expect(byRoll(rows, "21BQ1A0501")).toMatchObject({
      mcq_marks: 5, descriptive_marks: 3, total: 8, maximum: 10, percentage: 80, result_status: "pass",
      programme: "B.Tech CSE", semester: "3", course_code: "CS301", exam_name: "Data Structures Mid-term", attempt_date: "2026-10-09T08:40:00Z",
    });
    expect(byRoll(rows, "21BQ1A0502")).toMatchObject({ mcq_marks: 3, descriptive_marks: 0, total: 3, maximum: 10, result_status: "fail" });
    for (const r of rows.filter((x) => x.total !== null)) expect(r.mcq_marks! + r.descriptive_marks!).toBeCloseTo(r.total!, 6);
  });

  it("puts the subject code in the course code column, with the academic type and subject name", () => {
    const named = exam({ academic_type: "Mid Term", subject_code: "MBA101", subject_name: "Business Economics" }, { courseCode: "OLD9" });
    expect(byRoll(build(named).rows, "21BQ1A0501")).toMatchObject({
      academic_type: "Mid Term", course_code: "MBA101", subject_name: "Business Economics",
    });
  });

  it("uses the teacher's final total for an all-MCQ paper, even if it was adjusted", () => {
    const mcqOnly = [POOL[0], POOL[1]];
    const { rows } = buildExamRows({
      exam: exam({ total_marks: 5 }), pool: mcqOnly, enrolled: ["s1"], students: STUDENTS,
      attempts: [submitted("a1", "s1", 4.5, { q1: 1, q2: 0 })], heldAttemptIds: new Set(), now: NOW,
    });
    expect(rows[0]).toMatchObject({ mcq_marks: 4.5, descriptive_marks: 0, total: 4.5, maximum: 5 });
  });

  it("applies the pass mark as a percentage or as plain marks, as the teacher chose", () => {
    const pct = build(exam({}, { passMarkType: "percent", passMark: 50 })).rows;
    expect(byRoll(pct, "21BQ1A0501").result_status).toBe("pass");
    expect(byRoll(pct, "21BQ1A0502").result_status).toBe("fail");

    const marks = build(exam({}, { passMarkType: "marks", passMark: 3 })).rows;
    expect(byRoll(marks, "21BQ1A0502").result_status).toBe("pass");
    const strict = build(exam({}, { passMarkType: "marks", passMark: 8.5 })).rows;
    expect(byRoll(strict, "21BQ1A0501").result_status).toBe("fail");
  });

  it("falls back to the exam's passing marks as a percentage when the teacher set nothing", () => {
    const rows = build(exam({ passing_marks: 35 })).rows;
    expect(byRoll(rows, "21BQ1A0502").result_status).toBe("fail");
    expect(byRoll(build(exam({ passing_marks: 30 })).rows, "21BQ1A0502").result_status).toBe("pass");
  });

  it("uses the latest submission when a student submitted more than once", () => {
    const { rows } = build(exam(), new Set(), [
      submitted("old", "s1", 2, { q1: 0 }, "2026-10-09T08:20:00Z"),
      submitted("new", "s1", 8, { q1: 1, q2: 0 }, "2026-10-09T08:50:00Z"),
    ]);
    expect(byRoll(rows, "21BQ1A0501")).toMatchObject({ total: 8, attempt_date: "2026-10-09T08:50:00Z" });
  });
});

describe("ERP rows: absent students", () => {
  it("lists enrolled students with no submission as absent, without marks", () => {
    const { rows } = build();
    for (const roll of ["21BQ1A0503", "21BQ1A0506"]) {
      expect(byRoll(rows, roll)).toMatchObject({
        result_status: "absent", mcq_marks: null, descriptive_marks: null, total: null, percentage: null, attempt_date: null, maximum: 10,
      });
    }
  });

  it("does not call anyone absent while the exam is still open to them", () => {
    const open = exam({ scheduled_at: "2026-10-09T11:30:00Z", duration_minutes: 120 }, { results_published: false, release_timing: "on_submit" });
    const { rows, pending } = build(open);
    expect(rows.some((r) => r.result_status === "absent")).toBe(false);
    expect(rows.map((r) => r.roll)).toEqual(["21BQ1A0501", "21BQ1A0502", "21BQ1A0504"]);
    expect(pending).toBe(3);
  });

  it("leaves ungraded papers out and counts them as pending", () => {
    const { rows, pending } = build();
    expect(rows.find((r) => r.roll === "21BQ1A0505")).toBeUndefined();
    expect(pending).toBe(1);
  });
});

describe("ERP rows: withheld for malpractice review", () => {
  it("shows a held student as withheld with no marks, even when the paper is graded", () => {
    const { rows } = build();
    expect(byRoll(rows, "21BQ1A0504")).toMatchObject({
      result_status: "withheld", mcq_marks: null, descriptive_marks: null, total: null, percentage: null, maximum: 10, attempt_date: "2026-10-09T08:40:00Z",
    });
  });

  it("shows the marks again once the hold is cleared", () => {
    expect(byRoll(build(exam(), new Set()).rows, "21BQ1A0504")).toMatchObject({ result_status: "pass", total: 9 });
  });

  it("withholds an ungraded paper too, instead of leaving it out", () => {
    const { rows, pending } = build(exam(), new Set(["a4", "a5"]));
    expect(byRoll(rows, "21BQ1A0505").result_status).toBe("withheld");
    expect(pending).toBe(0);
  });
});

describe("ERP column config", () => {
  it("ships with the requested columns in order", () => {
    expect(ERP_EXPORT_CONFIG.columns.map((c) => c.field)).toEqual([
      "roll", "name", "programme", "semester", "academic_type", "course_code", "subject_name", "exam_name",
      "mcq_marks", "descriptive_marks", "total", "maximum", "result_status", "attempt_date",
    ]);
    expect(ERP_EXPORT_CONFIG.status).toEqual({ pass: "PASS", fail: "FAIL", absent: "ABSENT", withheld: "WITHHELD" });
  });

  it("lays the file out exactly as the config says: renamed, reordered, fewer columns", () => {
    const custom = parseExportConfig({
      dateFormat: "YYYY-MM-DD",
      columns: [
        { field: "result_status", header: "RESULT_CODE" },
        { field: "roll", header: "HTNO" },
        { field: "total", header: "MARKS" },
        { field: "attempt_date", header: "EXAM_DT" },
      ],
      status: { pass: "P", fail: "F", absent: "AB", withheld: "MP" },
    });
    const table = toTable(build().rows, custom);
    expect(table[0]).toEqual(["RESULT_CODE", "HTNO", "MARKS", "EXAM_DT"]);
    expect(table.find((r) => r[1] === "21BQ1A0501")).toEqual(["P", "21BQ1A0501", 8, "2026-10-09"]);
    expect(table.find((r) => r[1] === "21BQ1A0503")).toEqual(["AB", "21BQ1A0503", "", ""]);
    expect(table.find((r) => r[1] === "21BQ1A0504")).toEqual(["MP", "21BQ1A0504", "", "2026-10-09"]);
  });

  it.each([
    ["an unknown field", { columns: [{ field: "grade_point", header: "GP" }] }, /grade_point/],
    ["a repeated field", { columns: [{ field: "roll", header: "A" }, { field: "roll", header: "B" }] }, /appears twice/],
    ["a repeated header", { columns: [{ field: "roll", header: "X" }, { field: "name", header: "x" }] }, /appears twice/],
    ["an empty header", { columns: [{ field: "roll", header: " " }] }, /header is empty/],
    ["no columns", { columns: [] }, /non-empty/],
    ["a missing status label", { columns: [{ field: "roll", header: "R" }], status: { pass: "P", fail: "F", absent: "A" } }, /status.withheld/],
    ["an unknown date format", { dateFormat: "MM/DD/YY", columns: [{ field: "roll", header: "R" }] }, /dateFormat/],
  ])("rejects a config with %s", (_label, cfg, message) => {
    const status = { pass: "P", fail: "F", absent: "A", withheld: "W" };
    expect(() => parseExportConfig({ status, ...cfg })).toThrow(message);
  });

  it("formats the attempt date in India time", () => {
    expect(formatDate("2026-10-09T20:00:00Z", "DD-MM-YYYY")).toBe("10-10-2026");
    expect(formatDate("2026-10-09T08:00:00Z", "DD/MM/YYYY")).toBe("09/10/2026");
    expect(formatDate(null, "DD-MM-YYYY")).toBe("");
  });
});

describe("ERP files", () => {
  it("writes a CSV Excel opens cleanly, quoting where needed and defusing formulas", () => {
    const csv = toCsv([["Roll", "Name", "Total"], ["21BQ1A0501", 'Rao, "Asha"', 8], ["=HYPERLINK(1)", "-x", 0]]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.slice(1).split("\r\n")).toEqual(["Roll,Name,Total", '21BQ1A0501,"Rao, ""Asha""",8', "'=HYPERLINK(1),'-x,0", ""]);
  });

  it("writes a valid single-sheet workbook with the config headers", () => {
    const table = toTable(build().rows, ERP_EXPORT_CONFIG);
    const files = unzip(toXlsx(table, "Results"));
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml",
    ]);
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Roll Number</t></is></c>');
    expect(sheet).toContain('<t xml:space="preserve">21BQ1A0501</t>');
    expect(sheet).toMatch(/<c r="K\d+"><v>8<\/v><\/c>/);
    expect(files["xl/workbook.xml"]).toContain('<sheet name="Results"');
  });
});

/** Read an uncompressed zip and check every entry's CRC. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, string> = {};
  let p = 0;
  while (view.getUint32(p, true) === 0x04034b50) {
    expect(view.getUint16(p + 8, true)).toBe(0);
    const size = view.getUint32(p + 18, true);
    const nameLen = view.getUint16(p + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const data = bytes.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
    expect(crc(data)).toBe(view.getUint32(p + 14, true));
    out[name] = new TextDecoder().decode(data);
    p += 30 + nameLen + size;
  }
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  return out;
}
function crc(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; }
  return ~c >>> 0;
}

describe("results-export endpoint", () => {
  let audits: { actorId: string; action: string; targetType: string; targetId: string; meta: Record<string, unknown> }[];
  let exams: Map<string, ExportExam>;
  let auditFails: boolean;
  const ACTORS: Record<string, Actor> = {
    "teacher-A": { authId: "teacher-A", isAdmin: false },
    "teacher-B": { authId: "teacher-B", isAdmin: false },
    "admin-1": { authId: "admin-1", isAdmin: true },
  };
  const data: ExamData = { pool: POOL, enrolled: ENROLLED, attempts: ATTEMPTS, heldAttemptIds: new Set(["a4"]) };

  beforeEach(() => {
    audits = [];
    auditFails = false;
    exams = new Map([
      ["EX-1", exam()],
      ["EX-2", exam({ id: "EX-2", name: "DBMS Mid-term", created_by: "teacher-B" }, { courseCode: "CS302" })],
      ["EX-3", exam({ id: "EX-3", name: "OS Mid-term" }, { courseCode: "CS303", results_published: false })],
    ]);
  });

  const store = (): ResultsStore => ({
    examById: async (id) => exams.get(id) ?? null,
    examsForProgramme: async (programme, semester) =>
      [...exams.values()].filter((e) => String(e.settings?.programme).toLowerCase() === programme.toLowerCase() && String(e.settings?.semester) === semester),
    examData: async () => data,
    students: async (ids) => new Map(ids.filter((id) => STUDENTS.has(id)).map((id) => [id, STUDENTS.get(id)!])),
    audit: async (e) => { if (auditFails) throw new Error("insert failed"); audits.push(e); },
  });
  const call = (who: string | null, body: Record<string, unknown>, config?: ExportConfig) =>
    createResultsExportHandler({ store: store(), actor: async () => (who ? ACTORS[who] : null), now: () => NOW, config })(
      new Request("https://fn.example/results-export", { method: "POST", body: JSON.stringify(body) }),
    );

  it("exports one exam as CSV and records it in the audit log", async () => {
    const res = await call("teacher-A", { scope: "exam", examId: "EX-1", format: "csv" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBe("results_CS301_2026-10-09.csv");
    const lines = String(body.content).slice(1).trim().split("\r\n");
    expect(lines[0]).toBe("Roll Number,Student Name,Programme,Semester,Academic Type,Course Code,Subject Name,Exam Name,MCQ Marks,Descriptive Marks,Total Marks,Maximum Marks,Result,Attempt Date");
    expect(lines[1]).toBe("21BQ1A0501,Asha Rao,B.Tech CSE,3,,CS301,,Data Structures Mid-term,5,3,8,10,PASS,09-10-2026");
    expect(lines).toContain("21BQ1A0503,Absent Abhi,B.Tech CSE,3,,CS301,,Data Structures Mid-term,,,,10,ABSENT,");
    expect(lines).toContain("21BQ1A0504,Held Hema,B.Tech CSE,3,,CS301,,Data Structures Mid-term,,,,10,WITHHELD,09-10-2026");
    expect(body.summary).toMatchObject({ rows: 5, pending: 1, absent: 2, withheld: 1 });
    expect(audits).toEqual([{
      actorId: "teacher-A", action: "results.exported", targetType: "exam", targetId: "EX-1",
      meta: expect.objectContaining({ format: "csv", admin: false, exam_ids: ["EX-1"], rows: 5, pending: 1, absent: 2, withheld: 1 }),
    }]);
  });

  it("exports Excel as a base64 workbook", async () => {
    const body = await (await call("teacher-A", { scope: "exam", examId: "EX-1", format: "xlsx" })).json();
    expect(body).toMatchObject({ encoding: "base64", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const bytes = Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0));
    expect(unzip(bytes)["xl/worksheets/sheet1.xml"]).toContain("Held Hema");
    expect(audits[0].meta.format).toBe("xlsx");
  });

  it("lets a teacher export only their own exams, and an admin any exam", async () => {
    expect((await call("teacher-A", { scope: "exam", examId: "EX-2", format: "csv" })).status).toBe(403);
    expect((await call(null, { scope: "exam", examId: "EX-1", format: "csv" })).status).toBe(401);
    expect((await call("admin-1", { scope: "exam", examId: "EX-2", format: "csv" })).status).toBe(200);
    expect(audits).toEqual([expect.objectContaining({ actorId: "admin-1", targetId: "EX-2", meta: expect.objectContaining({ admin: true }) })]);
  });

  it("refuses an exam whose results are not released, and logs nothing", async () => {
    const res = await call("teacher-A", { scope: "exam", examId: "EX-3", format: "csv" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_released" });
    expect(audits).toEqual([]);
  });

  it("exports a programme and semester across the caller's released exams", async () => {
    const mine = await (await call("teacher-A", { scope: "programme", programme: "b.tech cse", semester: "3", format: "csv" })).json();
    expect(mine.summary.exams.map((e: { id: string }) => e.id)).toEqual(["EX-1"]);
    expect(mine.summary.skipped).toEqual([{ id: "EX-3", name: "OS Mid-term", reason: "not_released" }]);
    expect(mine.filename).toBe("results_b.tech-cse_sem3_2026-10-09.csv");

    const all = await (await call("admin-1", { scope: "programme", programme: "B.Tech CSE", semester: "3", format: "csv" })).json();
    expect(all.summary.exams.map((e: { id: string }) => e.id)).toEqual(["EX-1", "EX-2"]);
    expect(all.summary.rows).toBe(10);
    expect(audits.map((a) => [a.actorId, a.targetType, a.targetId])).toEqual([
      ["teacher-A", "programme", "b.tech cse|3"],
      ["admin-1", "programme", "B.Tech CSE|3"],
    ]);
    expect((await call("teacher-B", { scope: "programme", programme: "ECE", semester: "3", format: "csv" })).status).toBe(404);
  });

  it("returns no file when the audit entry cannot be written", async () => {
    auditFails = true;
    const res = await call("teacher-A", { scope: "exam", examId: "EX-1", format: "csv" });
    expect(res.status).toBe(500);
    expect((await res.json()).content).toBeUndefined();
  });

  it("rejects requests without a format or scope", async () => {
    expect((await call("teacher-A", { scope: "exam", examId: "EX-1" })).status).toBe(400);
    expect((await call("teacher-A", { examId: "EX-1", format: "csv" })).status).toBe(400);
    expect((await call("teacher-A", { scope: "programme", programme: "B.Tech CSE", format: "csv" })).status).toBe(400);
  });
});
