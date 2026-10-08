// Reload / relaunch: what the student saved must come back from the server —
// answers, question, section and the server's remaining time — merged with a
// newer copy left on the device, and never as a second attempt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabase } from "@/shared/data/supabase";
import { loadAttemptResume, saveAnswers, startAttempt } from "@/shared/data/api/attempts";
import { planResume, readPending, writePending } from "@/features/student/domain/resume";

vi.mock("@/shared/data/supabase", () => ({ getSupabase: vi.fn() }));

type Row = Record<string, unknown>;

/** A one-table stand-in for the attempts chain used by attempts.ts. */
function fakeAttempts(initial: Row | null, timeLeft: number | null) {
  const state = { row: initial ? { ...initial } : null as Row | null, inserts: 0, beforeInsert: null as null | (() => void) };
  const insertRow = (payload: Row) => {
    state.beforeInsert?.();
    if (state.row) return { data: null, error: { code: "23505", message: "duplicate key" } };
    state.inserts += 1;
    state.row = { id: `att-${state.inserts}`, ...payload };
    return { data: { id: state.row.id }, error: null };
  };
  const from = () => {
    let mode: "select" | "update" | "insert" = "select";
    let payload: Row = {};
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: () => q,
      eq: () => q,
      neq: () => q,
      update: (p: Row) => { mode = "update"; payload = p; return q; },
      insert: (p: Row) => { mode = "insert"; payload = p; return q; },
      maybeSingle: async () => {
        if (mode === "insert") return insertRow(payload);
        if (mode === "update") {
          if (!state.row) return { data: null, error: null };
          Object.assign(state.row, payload);
          return { data: { id: state.row.id }, error: null };
        }
        return { data: state.row ? { ...state.row } : null, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        if (mode === "insert") return resolve(insertRow(payload));
        if (mode === "update" && state.row) Object.assign(state.row, payload);
        resolve({ error: null });
      },
    });
    return q;
  };
  const db = { from, rpc: vi.fn(async () => ({ data: timeLeft, error: null })) };
  vi.mocked(getSupabase).mockReturnValue(db as never);
  return state;
}

const EXAM = "EXAM-2026-RESUME";
const STUDENT = "11111111-1111-1111-1111-111111111111";

beforeEach(() => vi.clearAllMocks());
afterEach(() => localStorage.clear());

describe("reload restores the attempt from the server", () => {
  it("brings back answers, question, section and the server's time left", async () => {
    fakeAttempts({ id: "att-1", state: "in_progress", answers: {}, auto_saved_at: null, resume_state: null }, 840);
    const savedAt = Date.parse("2026-10-09T10:05:00Z");
    expect(await saveAnswers({
      examId: EXAM, studentId: STUDENT, answers: { q1: 2, q2: "essay" }, answered: 2, minutesUsed: 6,
      resume: { index: 5, section: 1, sectionSecondsLeft: 240, savedAt }, savedAt,
    })).toBe(true);

    // ── page reload ──
    const snap = await loadAttemptResume(EXAM, STUDENT);
    expect(snap).toMatchObject({ attemptId: "att-1", state: "in_progress", secondsLeft: 840, autoSavedAt: savedAt });
    const plan = planResume(snap, readPending(EXAM), STUDENT);
    expect(plan).toEqual({
      kind: "resume",
      answers: { q1: 2, q2: "essay" },
      resume: { index: 5, section: 1, sectionSecondsLeft: 240, savedAt },
      secondsLeft: 840,
      fromDevice: false,
    });
  });

  it("merges a newer copy that was queued on the device while offline", async () => {
    const savedAt = Date.parse("2026-10-09T10:05:00Z");
    fakeAttempts({
      id: "att-1", state: "in_progress", answers: { q1: 2 }, auto_saved_at: new Date(savedAt).toISOString(),
      resume_state: { index: 1, section: 0, sectionSecondsLeft: null, savedAt },
    }, 600);
    writePending(EXAM, {
      answers: { q1: 3, q4: "written offline" }, answered: 2, minutesUsed: 8, isSubmit: false,
      studentId: STUDENT, savedAt: savedAt + 90_000,
      resume: { index: 4, section: 0, sectionSecondsLeft: null, savedAt: savedAt + 90_000 },
    });

    const plan = planResume(await loadAttemptResume(EXAM, STUDENT), readPending(EXAM), STUDENT);
    expect(plan.kind).toBe("resume");
    if (plan.kind !== "resume") return;
    expect(plan.answers).toEqual({ q1: 3, q4: "written offline" });
    expect(plan.resume?.index).toBe(4);
    expect(plan.fromDevice).toBe(true);
  });

  it("does not resume once the server deadline has passed", async () => {
    fakeAttempts({ id: "att-1", state: "in_progress", answers: { q1: 1 }, auto_saved_at: null, resume_state: null }, 0);
    const plan = planResume(await loadAttemptResume(EXAM, STUDENT), null, STUDENT);
    expect(plan).toEqual({ kind: "submit", answers: { q1: 1 }, reason: "time_over" });
  });
});

describe("no second attempt", () => {
  it("re-opening an existing attempt reuses it", async () => {
    const db = fakeAttempts({ id: "att-1", state: "in_progress", answers: { q1: 1 } }, 600);
    expect(await startAttempt({ examId: EXAM, studentId: STUDENT, total: 10 })).toBe("att-1");
    expect(db.inserts).toBe(0);
  });

  it("re-opening keeps the stored paper instead of writing a re-generated one", async () => {
    const stored = [{ id: "q7" }, { id: "q2" }, { id: "q9" }];
    const db = fakeAttempts({ id: "att-1", state: "in_progress", answers: { q7: 1 }, paper: stored }, 600);
    await startAttempt({ examId: EXAM, studentId: STUDENT, total: 3, paper: [{ id: "q2" }, { id: "q9" }, { id: "q7" }] as never });
    expect(db.row?.paper).toEqual(stored);
  });

  it("an attempt without a paper yet gets the generated one", async () => {
    const db = fakeAttempts({ id: "att-1", state: "in_progress", answers: {}, paper: [] }, 600);
    const paper = [{ id: "q1" }, { id: "q2" }];
    await startAttempt({ examId: EXAM, studentId: STUDENT, total: 2, paper: paper as never });
    expect(db.row?.paper).toEqual(paper);
  });

  it("two starts at once share one request and create one row", async () => {
    const db = fakeAttempts(null, 600);
    const [a, b] = await Promise.all([
      startAttempt({ examId: EXAM, studentId: STUDENT, total: 10 }),
      startAttempt({ examId: EXAM, studentId: STUDENT, total: 10 }),
    ]);
    expect(a).toBe("att-1");
    expect(b).toBe("att-1");
    expect(db.inserts).toBe(1);
  });

  it("losing the insert race to another tab reuses the winner's attempt", async () => {
    const db = fakeAttempts(null, 600);
    db.beforeInsert = () => {
      db.beforeInsert = null;
      db.row = { id: "att-other-tab", state: "in_progress" };
    };
    expect(await startAttempt({ examId: EXAM, studentId: STUDENT, total: 10 })).toBe("att-other-tab");
    expect(db.inserts).toBe(0);
  });
});
