import { describe, expect, it } from "vitest";
import { questionKind } from "./questionKind";
import { groupBySection, sectionOf, sectionWindows, splitMinutes, summarizeSections } from "./sections";
import { describeNegative, gradeObjective, numericEqual, paperTotal, penaltyFor, scoreObjective } from "./scoring";

describe("questionKind", () => {
  it("normalises the labels stored in the DB", () => {
    expect(questionKind("True / False")).toBe("truefalse");
    expect(questionKind("MCQ")).toBe("mcq");
    expect(questionKind("MSQ")).toBe("msq");
    expect(questionKind("Numerical")).toBe("numerical");
    expect(questionKind("LONG_ANSV")).toBe("subjective");
    expect(questionKind("Coding")).toBe("coding");
    expect(questionKind("", 4)).toBe("mcq");
    expect(questionKind(null)).toBe("subjective");
  });
});

describe("sections", () => {
  const pool = [
    { type: "Subjective", marks: 5 },
    { type: "MCQ", marks: 1 },
    { type: "True / False", marks: 1 },
    { type: "MCQ", marks: 2 },
  ];

  it("labels and summarises in canonical order", () => {
    expect(sectionOf(pool[2])).toBe("True / False");
    expect(summarizeSections(pool)).toEqual([
      { name: "MCQ", count: 2, marks: 3 },
      { name: "True / False", count: 1, marks: 1 },
      { name: "Descriptive", count: 1, marks: 5 },
    ]);
  });

  it("groups stably", () => {
    const groups = groupBySection(pool, sectionOf);
    expect(groups.map((g) => g.name)).toEqual(["Descriptive", "MCQ", "True / False"]);
    expect(groups[1].items).toEqual([pool[1], pool[3]]);
  });

  it("uses configured minutes and shares the rest by question count", () => {
    const w = sectionWindows(["MCQ", "MCQ", "Numerical", "Descriptive", "Descriptive", "Descriptive"], { MCQ: 10 }, 50);
    expect(w).toEqual([
      { name: "MCQ", start: 0, end: 2, seconds: 600 },
      { name: "Numerical", start: 2, end: 3, seconds: 600 },
      { name: "Descriptive", start: 3, end: 6, seconds: 1800 },
    ]);
  });

  it("splits minutes so they add up to the total", () => {
    const s = [{ name: "MCQ", count: 10, marks: 10 }, { name: "Descriptive", count: 2, marks: 20 }];
    expect(splitMinutes(s, 45, "even")).toEqual({ MCQ: 23, Descriptive: 22 });
    expect(splitMinutes(s, 45, "marks")).toEqual({ MCQ: 15, Descriptive: 30 });
  });
});

describe("scoring", () => {
  it("grades each objective kind", () => {
    expect(gradeObjective("mcq", "2", 2)).toBe("correct");
    expect(gradeObjective("mcq", "2", 1)).toBe("wrong");
    expect(gradeObjective("truefalse", "1", 1)).toBe("correct");
    expect(gradeObjective("msq", "[0,2]", [2, 0])).toBe("correct");
    expect(gradeObjective("msq", "[0,2]", [0])).toBe("wrong");
    expect(gradeObjective("msq", "[0,2]", [])).toBe("unanswered");
    expect(gradeObjective("numerical", "2.5", "2.50")).toBe("correct");
    expect(gradeObjective("mcq", "0", undefined)).toBe("unanswered");
  });

  it("compares numbers numerically and text case-insensitively", () => {
    expect(numericEqual("1e3", "1000")).toBe(true);
    expect(numericEqual("Paris", "paris")).toBe(true);
    expect(numericEqual("", "0")).toBe(false);
  });

  it("deducts only for wrong answers on penalised kinds", () => {
    const fraction = { negative: true, negativeMode: "fraction" as const, negativeFraction: 0.25 };
    expect(penaltyFor("mcq", 4, fraction)).toBe(1);
    expect(penaltyFor("subjective", 4, fraction)).toBe(0);
    expect(penaltyFor("mcq", 4, { negative: false })).toBe(0);
    const fixed = { negative: true, negativeMode: "fixed" as const, negativeMarks: 0.5, negativeKinds: ["mcq" as const] };
    expect(scoreObjective("mcq", 2, "wrong", fixed)).toBe(-0.5);
    expect(scoreObjective("msq", 2, "wrong", fixed)).toBe(0);
    expect(scoreObjective("mcq", 2, "unanswered", fixed)).toBe(0);
    expect(scoreObjective("mcq", 2, "correct", fixed)).toBe(2);
  });

  it("never lets the total go below zero", () => {
    expect(paperTotal([-1, -0.5, 0])).toBe(0);
    expect(paperTotal([2, -0.25, 1])).toBe(2.75);
  });

  it("describes the rule", () => {
    expect(describeNegative({ negative: false })).toBeNull();
    expect(describeNegative({ negative: true, negativeMode: "fraction", negativeFraction: 0.25 })).toBe(
      "Wrong answers on objective questions deduct 1/4 of the question's marks. Unanswered questions are not penalised.",
    );
  });
});

import { releaseTiming, visibilityFor } from "./release";

describe("result release", () => {
  const graded = { examClosed: false, graded: true };
  it("hides everything until the teacher releases (default manual)", () => {
    expect(visibilityFor({}, graded)).toEqual({ score: false, answerKey: false, note: "Your teacher hasn't released results yet." });
  });
  it("releases results and the answer key independently", () => {
    expect(visibilityFor({ results_published: true }, graded)).toMatchObject({ score: true, answerKey: false });
    expect(visibilityFor({ answer_key_published: true }, graded)).toMatchObject({ score: true, answerKey: true });
  });
  it("never shows an ungraded score", () => {
    expect(visibilityFor({ results_published: true }, { examClosed: true, graded: false })).toMatchObject({ score: false, note: "Your paper is still being evaluated." });
  });
  it("auto-releases on submit or when the exam closes", () => {
    expect(visibilityFor({ release_timing: "on_submit" }, graded).score).toBe(true);
    expect(visibilityFor({ release_timing: "on_close" }, graded).score).toBe(false);
    expect(visibilityFor({ release_timing: "on_close" }, { examClosed: true, graded: true }).answerKey).toBe(true);
  });
  it("reads the legacy settings", () => {
    expect(releaseTiming({ showReportToTaker: true })).toBe("on_submit");
    expect(releaseTiming({ release_mode: "auto", release_timing: "submit" })).toBe("on_submit");
    expect(releaseTiming({ release_mode: "manual", release_timing: "close" })).toBe("manual");
  });
});

import { autoGradeAttempt } from "./autoGrade";

describe("auto-grading on submit", () => {
  const q = (id: string, type: string, answer: string | null, options: string[] | null = null, marks = 2) =>
    ({ id, exam_id: "e", title: id, type, unit: null, difficulty: null, marks, options, answer });
  const pool = [q("a", "MCQ", "1", ["x", "y", "z"]), q("b", "Numerical", "2.5"), q("c", "MCQ", "0", ["p", "q"])];

  it("scores a fully objective paper", () => {
    const r = autoGradeAttempt(pool, [], { a: 1, b: "2.50" });
    expect(r).toMatchObject({ score: 4, max: 6, correct: 2, wrong: 0, unanswered: 1, manual: 0 });
  });
  it("leaves the score open when written answers need marking", () => {
    const r = autoGradeAttempt([...pool, q("d", "Subjective", null)], [], { a: 1 });
    expect(r.score).toBeNull();
    expect(r).toMatchObject({ objectiveScore: 2, objectiveMax: 6, manual: 1, max: 8 });
  });
});
