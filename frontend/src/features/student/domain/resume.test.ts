import { afterEach, describe, expect, it } from "vitest";
import {
  clearPending,
  listPending,
  planResume,
  readPending,
  resumeSection,
  writePending,
  type AttemptSnapshot,
  type PendingSync,
} from "@/features/student/domain/resume";

const STUDENT = "student-1";
const T0 = Date.parse("2026-10-09T10:00:00Z");

function snap(over: Partial<AttemptSnapshot> = {}): AttemptSnapshot {
  return {
    attemptId: "att-1",
    state: "in_progress",
    answers: { q1: 0, q2: "server text" },
    autoSavedAt: T0,
    resume: { index: 4, section: 1, sectionSecondsLeft: 300, savedAt: T0 },
    secondsLeft: 1200,
    ...over,
  };
}

function pending(over: Partial<PendingSync> = {}): PendingSync {
  return {
    answers: { q1: 2, q3: "typed offline" },
    answered: 2,
    minutesUsed: 12,
    isSubmit: false,
    savedAt: T0 + 30_000,
    studentId: STUDENT,
    resume: { index: 7, section: 1, sectionSecondsLeft: 270, savedAt: T0 + 30_000 },
    ...over,
  };
}

afterEach(() => localStorage.clear());

describe("planResume", () => {
  it("restores the server copy, position and time when nothing newer is on the device", () => {
    const plan = planResume(snap(), null, STUDENT);
    expect(plan).toEqual({
      kind: "resume",
      answers: { q1: 0, q2: "server text" },
      resume: { index: 4, section: 1, sectionSecondsLeft: 300, savedAt: T0 },
      secondsLeft: 1200,
      fromDevice: false,
    });
  });

  it("a newer device copy wins wholesale, including its position", () => {
    const plan = planResume(snap(), pending(), STUDENT);
    expect(plan.kind).toBe("resume");
    if (plan.kind !== "resume") return;
    expect(plan.answers).toEqual({ q1: 2, q3: "typed offline" });
    expect(plan.resume?.index).toBe(7);
    expect(plan.fromDevice).toBe(true);
  });

  it("an older device copy is ignored", () => {
    const plan = planResume(snap(), pending({ savedAt: T0 - 60_000 }), STUDENT);
    expect(plan.kind === "resume" && plan.answers).toEqual({ q1: 0, q2: "server text" });
  });

  it("never applies another student's copy (shared lab machine)", () => {
    const plan = planResume(snap(), pending({ studentId: "someone-else" }), STUDENT);
    expect(plan.kind === "resume" && plan.answers).toEqual({ q1: 0, q2: "server text" });
  });

  it("a legacy copy without a timestamp only fills blanks", () => {
    const legacy = pending({ savedAt: undefined, studentId: undefined, answers: { q1: 3, q4: "old" } });
    const plan = planResume(snap(), legacy, STUDENT);
    expect(plan.kind === "resume" && plan.answers).toEqual({ q1: 0, q2: "server text", q4: "old" });
  });

  it("submits instead of resuming when the server deadline has passed", () => {
    const plan = planResume(snap({ secondsLeft: 0 }), pending(), STUDENT);
    expect(plan).toEqual({ kind: "submit", answers: { q1: 2, q3: "typed offline" }, reason: "time_over" });
  });

  it("finishes a final submit that never reached the server", () => {
    const plan = planResume(snap(), pending({ isSubmit: true }), STUDENT);
    expect(plan.kind).toBe("submit");
    expect(plan.kind === "submit" && plan.reason).toBe("pending_submit");
  });

  it("does not reopen a submitted attempt", () => {
    expect(planResume(snap({ state: "submitted" }), pending(), STUDENT)).toEqual({ kind: "submitted" });
  });

  it("resumes from the device when the attempt row was never created", () => {
    const plan = planResume(null, pending(), STUDENT);
    expect(plan.kind === "resume" && plan.fromDevice).toBe(true);
    expect(planResume(null, null, STUDENT)).toEqual({ kind: "fresh" });
  });
});

describe("resumeSection", () => {
  const windows = [{ seconds: 600 }, { seconds: 300 }, { seconds: 900 }];

  it("subtracts the time the page was closed", () => {
    expect(resumeSection(windows, { section: 1, sectionSecondsLeft: 200 }, 50)).toEqual({ index: 1, secondsLeft: 150 });
  });

  it("walks into later sections when the closed time outlasts the saved one", () => {
    expect(resumeSection(windows, { section: 0, sectionSecondsLeft: 100 }, 450)).toEqual({ index: 2, secondsLeft: 850 });
  });

  it("stops at zero in the last section", () => {
    expect(resumeSection(windows, { section: 2, sectionSecondsLeft: 10 }, 99)).toEqual({ index: 2, secondsLeft: 0 });
  });
});

describe("pending_sync_ storage", () => {
  it("round-trips, stamps savedAt and lists entries", () => {
    writePending("EX-1", { answers: { q1: 1 }, answered: 1, minutesUsed: 1, isSubmit: false, studentId: STUDENT });
    const got = readPending("EX-1");
    expect(got?.answers).toEqual({ q1: 1 });
    expect(typeof got?.savedAt).toBe("number");
    expect(listPending().map(([id]) => id)).toEqual(["EX-1"]);
  });

  it("an autosave success keeps a queued final submit", () => {
    writePending("EX-1", { answers: {}, answered: 0, minutesUsed: 0, isSubmit: true });
    clearPending("EX-1", { keepSubmit: true });
    expect(readPending("EX-1")?.isSubmit).toBe(true);
    clearPending("EX-1");
    expect(readPending("EX-1")).toBeNull();
  });
});
