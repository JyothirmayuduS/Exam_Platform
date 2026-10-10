import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake database: exams of each academic type, and the exam_naming_conflict and
// unique-index checks the real database runs.
const db = {
  types: [
    { name: "Sem Exam", sort_order: 10, active: true },
    { name: "Mid Term", sort_order: 20, active: true },
  ],
  exams: [{ id: "EX-OLD", academic_type: "Mid Term", subject_code: "MBA101", subject_name: "Business Economics" }],
  upserts: [] as Record<string, unknown>[],
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  conflictCheck: true,
};

const clash = (type: string, code: string, name: string, exclude?: string | null) => {
  const same = db.exams.filter((e) => e.id !== exclude && e.academic_type.toLowerCase() === type.toLowerCase());
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
          const which = clash(String(row.academic_type), String(row.subject_code), String(row.subject_name), String(row.id));
          if (which === "subject_code") return { error: { code: "23505", message: 'duplicate key value violates unique constraint "exams_type_code_unique"' } };
          if (which === "subject_name") return { error: { code: "23505", message: 'duplicate key value violates unique constraint "exams_type_subject_unique"' } };
          return { error: null };
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcs.push({ fn, args });
      if (fn === "exam_naming_conflict") {
        return { data: db.conflictCheck ? clash(String(args.p_type), String(args.p_code), String(args.p_name), args.p_exclude as string | null) : null, error: null };
      }
      if (fn === "student_directory_filters") return { data: [{ kind: "batch", value: "MBA · Sem I", students: 40 }], error: null };
      if (fn === "import_students") return { data: [{ roll: "R1", student_id: "s1", created: true, updated: false }, { roll: "R2", student_id: "s2", created: false, updated: false }], error: null };
      if (fn === "search_student_directory") return { data: [{ id: "s1", roll: "R1", full_name: "Asha", branch: "MBA", section: "A", batch: "MBA · Sem I", has_email: true }], error: null };
      if (fn === "list_assignable_staff") return { data: [{ id: "t1", full_name: "Dr. Rao", name: null, role: "teacher", department: "MBA", email: "rao@vignan.ac.in" }], error: null };
      return { data: null, error: { code: "42883", message: "no such function" } };
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
  }),
}));
vi.mock("@/shared/data/api/audit", () => ({ logAudit: vi.fn() }));

import CreateTestModal from "@/features/teacher/components/CreateTestModal";
import { composeExamName, examSaveError, examTitle, namingProblem } from "@/shared/data/api/examNaming";
import { importStudents, listFaculty, searchStudentDirectory } from "@/shared/data/examApi";

beforeEach(() => {
  db.upserts = [];
  db.rpcs = [];
  db.conflictCheck = true;
});
afterEach(cleanup);

describe("exam naming helpers", () => {
  it("builds the name from the tidied type, code and subject", () => {
    expect(composeExamName({ academic_type: " Mid Term ", subject_code: " mba 101 ", subject_name: "Business   Economics " }))
      .toBe("Mid Term · MBA101 · Business Economics");
    expect(examTitle({ name: "Test 1", academic_type: "Test Exam", subject_code: null, subject_name: "Test 1" })).toBe("Test 1");
  });

  it("asks for the fields in order", () => {
    expect(namingProblem({ academic_type: "", subject_code: "X1", subject_name: "Y" })).toBe("Choose the academic type.");
    expect(namingProblem({ academic_type: "Mid Term", subject_code: " ", subject_name: "Y" })).toBe("Enter the subject code.");
    expect(namingProblem({ academic_type: "Mid Term", subject_code: "X1", subject_name: "" })).toBe("Enter the subject name.");
    expect(namingProblem({ academic_type: "Mid Term", subject_code: "X1", subject_name: "Y" })).toBeNull();
  });

  it("explains what the database refused", () => {
    const n = { academic_type: "Mid Term", subject_code: "mba101", subject_name: "Economics" };
    expect(examSaveError({ code: "23505", message: 'violates unique constraint "exams_type_code_unique"' }, n))
      .toBe("Another Mid Term exam already uses subject code MBA101. Use a different code, or choose another academic type.");
    expect(examSaveError({ code: "23505", message: 'violates unique constraint "exams_type_subject_unique"' }, n))
      .toMatch(/already uses the subject name "Economics"/);
    expect(examSaveError({ code: "23514", message: "exam_naming_required: choose…" })).toMatch(/Choose the academic type/);
    expect(examSaveError({ code: "23514", message: "exam_type_inactive: …" })).toMatch(/no longer offered/);
  });
});

describe("CreateTestModal", () => {
  const open = () => {
    const onCreate = vi.fn();
    render(<CreateTestModal onClose={() => {}} onCreate={onCreate} notify={() => {}} />);
    return onCreate;
  };
  const fill = async (type: string, code: string, subject: string) => {
    await screen.findByRole("option", { name: type });
    fireEvent.change(screen.getByLabelText(/Academic type/), { target: { value: type } });
    fireEvent.change(screen.getByLabelText(/Subject code/), { target: { value: code } });
    fireEvent.change(screen.getByLabelText(/Subject name/), { target: { value: subject } });
    await screen.findByRole("option", { name: /MBA · Sem I/ });
    fireEvent.change(screen.getByLabelText(/Assigned batch/), { target: { value: "MBA · Sem I" } });
  };
  const proceed = () => screen.getByRole("button", { name: "Proceed" });

  it("asks for the academic type first, then the subject code, then the subject name", async () => {
    open();
    const fields = [screen.getByLabelText(/Academic type/), screen.getByLabelText(/Subject code/), screen.getByLabelText(/Subject name/)];
    expect(fields.map((f) => f.id)).toEqual(["create-test-type", "create-test-code", "create-test-subject"]);
    expect(fields[0].compareDocumentPosition(fields[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fields[1].compareDocumentPosition(fields[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fields[1]).toBeDisabled();
    expect(await screen.findByRole("option", { name: "Mid Term" })).toBeInTheDocument();
  });

  it("saves the three fields separately and names the exam after them", async () => {
    const onCreate = open();
    await fill("Sem Exam", "mba101", "Business Economics");
    await waitFor(() => expect(proceed()).toBeEnabled());
    fireEvent.click(proceed());
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(db.upserts[0]).toMatchObject({
      academic_type: "Sem Exam", subject_code: "MBA101", subject_name: "Business Economics", name: "Sem Exam · MBA101 · Business Economics",
    });
  });

  it("refuses a subject code already used under the same type, with a message on the form", async () => {
    open();
    await fill("Mid Term", "MBA101", "Marketing");
    expect(await screen.findByRole("alert")).toHaveTextContent("Another Mid Term exam already uses subject code MBA101");
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
    expect(await screen.findByText(/Another Mid Term exam already uses subject code MBA101/)).toBeInTheDocument();
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

  it("lists staff for assignment through the server function", async () => {
    expect(await listFaculty()).toEqual([{ id: "t1", name: "Dr. Rao", role: "teacher", department: "MBA", email: "rao@vignan.ac.in" }]);
    expect(db.rpcs[0].fn).toBe("list_assignable_staff");
  });
});
