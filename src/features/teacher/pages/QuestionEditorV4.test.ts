import { describe, expect, it } from "vitest";
import { prepareRow } from "@/features/teacher/pages/QuestionEditorV4";

const base = { title: "Q", type: "MCQ", options: ["Inorder", "Preorder", "", "Level"], answer: "A", unit: "", difficulty: "medium", marks: "1" };

describe("prepareRow", () => {
  it("maps a letter or option text to the compacted option index", () => {
    expect(prepareRow(2, base).answer).toBe("0");
    expect(prepareRow(2, { ...base, answer: "D" }).answer).toBe("2");
    expect(prepareRow(2, { ...base, answer: "preorder" }).answer).toBe("1");
    expect(prepareRow(2, base).options).toEqual(["Inorder", "Preorder", "Level"]);
  });

  it("parses multi-answer letters and rejects unknown ones", () => {
    expect(prepareRow(2, { ...base, type: "MSQ", answer: "A;D" }).answer).toBe("[0,2]");
    expect(prepareRow(2, { ...base, type: "MSQ", answer: "A;C" }).valid).toBe(false);
  });

  it("handles true/false, numerical, subjective and bad types", () => {
    expect(prepareRow(2, { ...base, type: "True / False", answer: "False" }).answer).toBe("1");
    expect(prepareRow(2, { ...base, type: "numerical", answer: "9" })).toMatchObject({ type: "Numerical", answer: "9", valid: true });
    expect(prepareRow(2, { ...base, type: "Subjective", answer: "" })).toMatchObject({ valid: true, options: null, answer: null });
    expect(prepareRow(2, { ...base, type: "Essay" }).valid).toBe(false);
  });
});
