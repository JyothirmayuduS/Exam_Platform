import { describe, expect, it } from "vitest";
import { resolveActiveExamId, type ProctoringStatsMap } from "./useTeacherExams";
import type { ExamRecord } from "../lib/examApi";

function exam(id: string, status: "draft" | "published" | "scheduled" = "published"): ExamRecord {
  return {
    id,
    name: `Exam ${id}`,
    batch: "Sem III",
    mode: "lockdown",
    status,
    duration_minutes: 45,
    per_student: 0,
    pool_count: 10,
    total_marks: 50,
    scheduled_at: null,
    join_link: "",
    settings: {},
  };
}

const noStats: ProctoringStatsMap = {};

describe("resolveActiveExamId", () => {
  it("returns null when there are no exams", () => {
    expect(resolveActiveExamId([], noStats, null, null)).toBeNull();
  });

  it("honours a URL exam id that exists", () => {
    const exams = [exam("E1"), exam("E2")];
    expect(resolveActiveExamId(exams, noStats, "E2", null)).toBe("E2");
  });

  it("ignores a URL exam id that is not the teacher's", () => {
    const exams = [exam("E1")];
    expect(resolveActiveExamId(exams, noStats, "E2", null)).toBe("E1");
  });

  it("falls back to the stored selection before guessing", () => {
    const exams = [exam("E1"), exam("E2")];
    expect(resolveActiveExamId(exams, noStats, null, "E1")).toBe("E1");
  });

  it("prefers a non-draft exam that already has candidates over a newer idle one", () => {
    const exams = [exam("E-new"), exam("E-active")];
    const stats: ProctoringStatsMap = { "E-active": { candidates: 4, active: 2, submitted: 1, paused: 0, flagged: 1 } };
    expect(resolveActiveExamId(exams, stats, null, null)).toBe("E-active");
  });

  it("falls back to the newest non-draft exam when nothing has activity", () => {
    const exams = [exam("E-new"), exam("E-draft", "draft")];
    expect(resolveActiveExamId(exams, noStats, null, null)).toBe("E-new");
  });

  it("skips drafts entirely and only uses them as the very last resort", () => {
    const exams = [exam("E-draft-a", "draft"), exam("E-draft-b", "draft")];
    // Newest draft is returned only when there is literally nothing else.
    expect(resolveActiveExamId(exams, noStats, null, null)).toBe("E-draft-a");
  });
});
