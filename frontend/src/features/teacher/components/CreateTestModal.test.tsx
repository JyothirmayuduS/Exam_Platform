import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake database: exams of each academic type and term, and the
// exam_naming_conflict and unique-index checks the real database runs.
const db = {
  types: [
    { name: "Sem Exam", sort_order: 10, active: true },
    { name: "Mid Term", sort_order: 20, active: true },
  ],
  exams: [{ id: "EX-OLD", academic_type: "Mid Term", semester: 1, academic_year: "2026-27", attempt_label: "Regular", subject_code: "MBA101", subject_name: "Business Economics" }],
  upserts: [] as Record<string, unknown>[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  conflictCheck: true,
  invokes: [] as { fn: string; body: Record<string, unknown> }[],
};

type Term = { type: string; semester: number; year: string; attempt: string };
const clash = (t: Term, code: string, name: string, exclude?: string | null) => {
  const same = db.exams.filter((e) => e.id !== exclude && e.academic_type.toLowerCase() === t.type.toLowerCase()
    && e.semester === t.semester && e.academic_year === t.year && e.attempt_label === t.attempt);
  if (same.some((e) => e.subject_code === code.replace(/\s+/g, "").toUpperCase())) return "subject_code";
  if (same.some((e) => e.subject_name.toLowerCase() === name.trim().replace(/\s+/g, " ").toLowerCase())) return "subject_name";
  return null;
};

function query(rows: () => unknown[]) {
  const q = {
    select: () => q, order: () => q, eq: () => q,
    then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: rows(), error: null }),
  };
  return q;
}

vi.mock("@/shared/data/supabase", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "academic_types") return query(() => db.types);
      return {
        upsert: async (row: Record<string, unknown>) => {
          db.upserts.push(row);
          const which = clash({ type: String(row.academic_type), semester: Number(row.semester), year: String(row.academic_year), attempt: String(row.attempt_label) },
            String(row.subject_code), String(row.subject_name), String(row.id));
          if (which === "subject_code") return { error: { code: "23505", message: 'duplicate key value violates unique constraint "exams_type_code_unique"' } };
          if (which === "subject_name") return { error: { code: "23505", message: 'duplicate key value violates unique constraint "exams_type_subject_unique"' } };
          return { error: null };
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcs.push({ fn, args });
      if (fn === "exam_naming_conflict") {
        const term = { type: String(args.p_type), semester: Number(args.p_semester), year: String(args.p_year), attempt: String(args.p_attempt) };
        return { data: db.conflictCheck ? clash(term, String(args.p_code), String(args.p_name), args.p_exclude as string | null) : null, error: null };
      }
      if (fn === "student_directory_filters") return { data: [{ kind: "batch", value: "MBA · Sem I", students: 40 }], error: null };
      if (fn === "import_students") return { data: [{ roll: "R1", student_id: "s1", created: true, updated: false }, { roll: "R2", student_id: "s2", created: false, updated: false }], error: null };
      if (fn === "search_student_directory") return { data: [{ id: "s1", roll: "R1", full_name: "Asha", branch: "MBA", section: "A", batch: "MBA · Sem I", has_email: true }], error: null };
      if (fn === "list_assignable_staff") return { data: [{ id: "t1", name: "Dr. Rao", role: "teacher" }], error: null };
      return { data: null, error: { code: "42883", message: "no such function" } };
    },
    functions: { invoke: async (fn: string, opts: { body: Record<string, unknown> }) => { db.invokes.push({ fn, body: opts.body }); return { data: null, error: null }; } },
  }),
}));
vi.mock("@/shared/data/api/audit", () => ({ logAudit: vi.fn() }));

import CreateTestModal from "@/features/teacher/components/CreateTestModal";
import { academicYearOptions, composeExamName, currentAcademicYear, examSaveError, examTitle, namingProblem, type ExamNaming } from "@/shared/data/api/examNaming";
import { importStudents, listFaculty, searchStudentDirectory } from "@/shared/data/examApi";
import { sendEvaluatorAssignmentEmail, sendProctorAssignmentEmail } from "@/features/teacher/services/emailApi";

beforeEach(() => {
  db.upserts = [];
  db.rpcs = [];
  db.conflictCheck = true;
  db.invokes = [];
});
afterEach(cleanup);

const N = (over: Partial<ExamNaming> = {}): ExamNaming => ({
  academic_type: "Mid Term", semester: "1", academic_year: "2026-27", attempt_label: "Regular", subject_code: "mba101", subject_name: "Economics", ...over,
});

describe("exam naming helpers", () => {
  it("builds the name from the tidied type, code, subject, semester and year", () => {
    expect(composeExamName(N({ academic_type: " Mid Term ", subject_code: " mba 101 ", subject_name: "Business   Economics " })))
      .toBe("Mid Term · MBA101 · Business Economics · Sem 1 · 2026-27");
    expect(composeExamName(N({ attempt_label: "Supplementary" }))).toBe("Mid Term · MBA101 · Economics · Sem 1 · 2026-27 · Supplementary");
    expect(examTitle({ name: "Test 1", academic_type: "Test Exam", subject_code: null, subject_name: "Test 1" })).toBe("Test 1");
  });

  it("asks for the fields in order", () => {
    expect(namingProblem(N({ academic_type: "" }))).toBe("Choose the academic type.");
    expect(namingProblem(N({ semester: "" }))).toBe("Choose the semester.");
    expect(namingProblem(N({ academic_year: "2026-28" }))).toBe("Choose the academic year.");
    expect(namingProblem(N({ subject_code: " " }))).toBe("Enter the subject code.");
    expect(namingProblem(N({ subject_name: "" }))).toBe("Enter the subject name.");
    expect(namingProblem(N())).toBeNull();
  });

  it("offers academic years that start in June", () => {
    expect(currentAcademicYear(new Date(2026, 4, 31))).toBe("2025-26");
    expect(currentAcademicYear(new Date(2026, 5, 1))).toBe("2026-27");
    expect(academicYearOptions(new Date(2099, 9, 10))).toEqual(["2098-99", "2099-00", "2100-01", "2101-02"]);
  });

  it("explains what the database refused", () => {
    const n = { academic_type: "Mid Term", semester: 1, academic_year: "2026-27", attempt_label: "Supplementary", subject_code: "MBA101", subject_name: "Economics" };
    expect(examSaveError({ code: "23505", message: 'violates unique constraint "exams_type_code_unique"' }, n))
      .toBe("Another Mid Term exam for Sem 1, 2026-27, supplementary already uses subject code MBA101. Change it, or change the academic type, semester, year or attempt.");
    expect(examSaveError({ code: "23505", message: 'violates unique constraint "exams_type_subject_unique"' }, n))
      .toMatch(/already uses the subject name "Economics"/);
    expect(examSaveError({ code: "23514", message: "exam_naming_required: choose…" })).toMatch(/semester and academic year/);
    expect(examSaveError({ code: "23514", message: "exam_term_invalid: …" })).toMatch(/academic year like 2026-27/);
    expect(examSaveError({ code: "23514", message: "exam_type_inactive: …" })).toMatch(/no longer offered/);
  });
});

describe("CreateTestModal", () => {
  const open = () => {
    const onCreate = vi.fn();
    render(<CreateTestModal onClose={() => {}} onCreate={onCreate} notify={() => {}} />);
    return onCreate;
  };
  const fill = async (type: string, code: string, subject: string, term: { semester?: string; year?: string; attempt?: string } = {}) => {
    await screen.findByRole("option", { name: type });
    fireEvent.change(screen.getByLabelText(/Academic type/), { target: { value: type } });
    fireEvent.change(screen.getByLabelText(/Semester/), { target: { value: term.semester ?? "1" } });
    fireEvent.change(screen.getByLabelText(/Academic year/), { target: { value: term.year ?? "2026-27" } });
    if (term.attempt) fireEvent.click(screen.getByRole("radio", { name: term.attempt }));
    fireEvent.change(screen.getByLabelText(/Subject code/), { target: { value: code } });
    fireEvent.change(screen.getByLabelText(/Subject name/), { target: { value: subject } });
    await screen.findByRole("option", { name: /MBA · Sem I/ });
    fireEvent.change(screen.getByLabelText(/Assigned batch/), { target: { value: "MBA · Sem I" } });
  };
  const proceed = () => screen.getByRole("button", { name: "Proceed" });

  it("asks for the academic type, then the semester and academic year, then the subject code and name", async () => {
    open();
    const fields = ["Academic type", "Semester", "Academic year", "Subject code", "Subject name"].map((l) => screen.getByLabelText(new RegExp(l)));
    expect(fields.map((f) => f.id)).toEqual(["create-test-type", "create-test-semester", "create-test-year", "create-test-code", "create-test-subject"]);
    for (let i = 1; i < fields.length; i++) expect(fields[i - 1].compareDocumentPosition(fields[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fields[1]).toBeDisabled();
    expect(fields[3]).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Regular" })).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByRole("option", { name: "Mid Term" })).toBeInTheDocument();
  });

  it("saves each field separately and names the exam after them", async () => {
    const onCreate = open();
    await fill("Sem Exam", "mba101", "Business Economics", { semester: "3" });
    await waitFor(() => expect(proceed()).toBeEnabled());
    fireEvent.click(proceed());
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(db.upserts[0]).toMatchObject({
      academic_type: "Sem Exam", semester: 3, academic_year: "2026-27", attempt_label: "Regular", subject_code: "MBA101", subject_name: "Business Economics",
      name: "Sem Exam · MBA101 · Business Economics · Sem 3 · 2026-27",
    });
  });

  it("lets the same subject run again next semester, next year or as a supplementary attempt", async () => {
    for (const term of [{ semester: "2" }, { year: "2027-28" }, { attempt: "Supplementary" }]) {
      cleanup();
      db.upserts = [];
      const onCreate = open();
      await fill("Mid Term", "MBA101", "Business Economics", term);
      await waitFor(() => expect(proceed()).toBeEnabled());
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.click(proceed());
      await waitFor(() => expect(onCreate).toHaveBeenCalled());
    }
    expect(db.upserts[0]).toMatchObject({ attempt_label: "Supplementary", name: "Mid Term · MBA101 · Business Economics · Sem 1 · 2026-27 · Supplementary" });
  });

  it("refuses a subject code already used under the same type, with a message on the form", async () => {
    open();
    await fill("Mid Term", "MBA101", "Marketing");
    expect(await screen.findByRole("alert")).toHaveTextContent("Another Mid Term exam for Sem 1, 2026-27 already uses subject code MBA101");
    expect(screen.getByLabelText(/Subject code/)).toHaveAttribute("aria-invalid", "true");
    expect(proceed()).toBeDisabled();
  });

  it("refuses a subject name already used under the same type", async () => {
    open();
    await fill("Mid Term", "MBA200", "business economics");
    expect(await screen.findByRole("alert")).toHaveTextContent('already uses the subject name "business economics"');
    expect(proceed()).toBeDisabled();
  });

  it("shows the database's refusal when the form check missed a clash", async () => {
    db.conflictCheck = false;
    const onCreate = open();
    await fill("Mid Term", "MBA101", "Marketing");
    await waitFor(() => expect(proceed()).toBeEnabled());
    fireEvent.click(proceed());
    expect(await screen.findByText(/Another Mid Term exam for Sem 1, 2026-27 already uses subject code MBA101/)).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("student directory and staff pickers", () => {
  it("imports a CSV into the chosen exam through the server", async () => {
    const res = await importStudents("EX-1", [{ roll: "R1", name: "Asha", email: "", branch: "MBA", section: "A" }, { roll: "R2", name: "Ravi", email: "", branch: "MBA", section: "A" }]);
    expect(res).toEqual({ count: 2, created: 1, updated: 0 });
    expect(db.rpcs[0]).toMatchObject({ fn: "import_students", args: { p_exam: "EX-1" } });
  });

  it("searches the directory without contact details", async () => {
    const rows = await searchStudentDirectory({ branch: "MBA", section: "A" });
    expect(db.rpcs[0]).toEqual({ fn: "search_student_directory", args: { p_batch: null, p_branch: "MBA", p_section: "A" } });
    expect(Object.keys(rows[0]).sort()).toEqual(["batch", "branch", "full_name", "has_email", "id", "roll", "section"]);
  });

  it("lists staff for assignment by name and role only", async () => {
    expect(await listFaculty()).toEqual([{ id: "t1", name: "Dr. Rao", role: "teacher" }]);
    expect(db.rpcs[0].fn).toBe("list_assignable_staff");
  });

  it("sends assignment emails by staff id, for the server to address", async () => {
    await sendProctorAssignmentEmail("EX-1", [{ id: "t1", name: "Dr. Rao" }, { name: "Nobody" }]);
    await sendEvaluatorAssignmentEmail("EX-1", [{ id: "t1", name: "Dr. Rao", count: 3 }], null, 3);
    expect(db.invokes.map((i) => i.fn)).toEqual(["send-proctor-email", "send-evaluator-email"]);
    expect(db.invokes[0].body.proctors).toEqual([{ id: "t1", name: "Dr. Rao" }]);
    expect(db.invokes[1].body.evaluators).toEqual([{ id: "t1", name: "Dr. Rao", count: 3 }]);
  });
});
