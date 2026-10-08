import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAnswers, submitAttempt } from "@/shared/data/examApi";
import useOfflineSync from "@/features/student/hooks/useOfflineSync";
import { readPending, writePending } from "@/features/student/domain/resume";

vi.mock("@/shared/data/env", () => ({ supabaseConfigured: true }));
vi.mock("@/shared/data/examApi", () => ({ saveAnswers: vi.fn(), submitAttempt: vi.fn() }));

const STUDENT = "student-1";

function queue(examId: string, over: Record<string, unknown> = {}) {
  writePending(examId, {
    answers: { q1: 1 },
    answered: 1,
    minutesUsed: 5,
    isSubmit: false,
    studentId: STUDENT,
    savedAt: Date.now(),
    ...over,
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(saveAnswers).mockReset();
  vi.mocked(submitAttempt).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("offline queue (pending_sync_)", () => {
  it("retries on a timer, without an online event, until the save lands", async () => {
    queue("EX-1");
    vi.mocked(saveAnswers).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    renderHook(() => useOfflineSync(STUDENT, { retryMs: 15_000 }));

    await advance(10);
    expect(saveAnswers).toHaveBeenCalledTimes(1);
    expect(readPending("EX-1")).not.toBeNull();

    await advance(15_000);
    expect(saveAnswers).toHaveBeenCalledTimes(2);
    expect(readPending("EX-1")).not.toBeNull();

    await advance(15_000);
    expect(saveAnswers).toHaveBeenCalledTimes(3);
    expect(readPending("EX-1")).toBeNull();
    expect(vi.mocked(saveAnswers).mock.calls[2][0]).toMatchObject({ examId: "EX-1", studentId: STUDENT, answers: { q1: 1 } });
  });

  it("finishes a queued final submit and reports it", async () => {
    queue("EX-2", { isSubmit: true });
    vi.mocked(submitAttempt).mockResolvedValue({ ok: true, late: false, grade: null });
    const onSynced = vi.fn();
    renderHook(() => useOfflineSync(STUDENT, { onSynced }));
    await advance(10);
    expect(submitAttempt).toHaveBeenCalledTimes(1);
    expect(saveAnswers).not.toHaveBeenCalled();
    expect(onSynced).toHaveBeenCalledWith("EX-2", true);
    expect(readPending("EX-2")).toBeNull();
  });

  it("leaves the exam being taken to its own autosave", async () => {
    queue("EX-LIVE");
    vi.mocked(saveAnswers).mockResolvedValue(true);
    renderHook(() => useOfflineSync(STUDENT, { activeExamId: "EX-LIVE" }));
    await advance(40_000);
    expect(saveAnswers).not.toHaveBeenCalled();
    expect(readPending("EX-LIVE")).not.toBeNull();
  });

  it("drops an autosave copy that could not land within a day", async () => {
    queue("EX-OLD", { savedAt: Date.now() - 25 * 60 * 60 * 1000 });
    renderHook(() => useOfflineSync(STUDENT));
    await advance(10);
    expect(saveAnswers).not.toHaveBeenCalled();
    expect(readPending("EX-OLD")).toBeNull();
  });

  it("never uploads another student's queued answers", async () => {
    queue("EX-3", { studentId: "someone-else" });
    vi.mocked(saveAnswers).mockResolvedValue(true);
    renderHook(() => useOfflineSync(STUDENT));
    await advance(20_000);
    expect(saveAnswers).not.toHaveBeenCalled();
  });

  it("keeps a newer copy queued while an older one was uploading", async () => {
    const t = Date.now();
    queue("EX-4", { answers: { q1: 1 }, savedAt: t - 2000 });
    vi.mocked(saveAnswers).mockImplementation(async () => {
      queue("EX-4", { answers: { q1: 2 }, savedAt: t - 1000 });
      return true;
    });
    renderHook(() => useOfflineSync(STUDENT));
    await advance(10);
    expect(readPending("EX-4")?.answers).toEqual({ q1: 2 });
  });
});
