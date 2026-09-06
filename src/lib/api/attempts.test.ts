// Tests for the answer-upload self-healing fix: saveAnswers / submitAttempt
// must never report success when the attempt row doesn't exist — they create
// it (upsert) instead of silently no-op'ing like the old blind UPDATE did.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSupabase } from "../supabase";
import { saveAnswers, submitAttempt } from "./attempts";

vi.mock("../supabase", () => ({ getSupabase: vi.fn() }));

/** Build a fake supabase query builder that mirrors the attempts.ts chain. */
function mockChain(results: {
  maybeSingle?: { data: { id: string } | null; error: unknown };
  insertError?: unknown;
  retryError?: unknown;
}) {
  const insert = vi.fn(() => Promise.resolve({ error: results.insertError ?? null }));
  const update = vi.fn();
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    update,
    maybeSingle: () =>
      Promise.resolve(
        results.maybeSingle ?? { data: null, error: null },
      ),
    insert,
    // When awaited directly (the re-apply / retry updates in
    // upsertAttemptPatch) resolve like a PostgREST write result.
    then: (resolve: (v: unknown) => void) =>
      resolve({ error: results.retryError ?? null }),
  };
  update.mockReturnValue(chain);
  return chain;
}

const opts = {
  examId: "EXAM-2026-0001",
  studentId: "11111111-1111-1111-1111-111111111111",
  answers: { "Q-1": 2 },
  answered: 1,
  minutesUsed: 5,
  total: 10,
};

describe("attempt answer upload (self-healing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the existing attempt row and does NOT insert when the row is there", async () => {
    const chain = mockChain({ maybeSingle: { data: { id: "attempt-1" }, error: null } });
    const db = { from: vi.fn(() => chain) };
    vi.mocked(getSupabase).mockReturnValue(db as never);

    const ok = await saveAnswers(opts);

    expect(ok).toBe(true);
    expect(db.from).toHaveBeenCalledWith("attempts");
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it("creates the missing attempt row instead of silently no-op'ing", async () => {
    // First update matches zero rows (data null, no error) — the old silent
    // data-loss bug. The fix must insert the row, then re-apply the patch.
    const chain = mockChain({ maybeSingle: { data: null, error: null } });
    const db = { from: vi.fn(() => chain) };
    vi.mocked(getSupabase).mockReturnValue(db as never);

    const ok = await saveAnswers(opts);

    expect(ok).toBe(true);
    expect(chain.insert).toHaveBeenCalledTimes(1);
    const inserted = chain.insert.mock.calls[0][0];
    expect(inserted.exam_id).toBe(opts.examId);
    expect(inserted.student_id).toBe(opts.studentId);
    expect(inserted.state).toBe("in_progress");
    expect(inserted.total).toBe(opts.total);
  });

  it("submits by creating the row when startAttempt never created it", async () => {
    const chain = mockChain({ maybeSingle: { data: null, error: null } });
    const db = { from: vi.fn(() => chain) };
    vi.mocked(getSupabase).mockReturnValue(db as never);

    const ok = await submitAttempt(opts);

    expect(ok).toBe(true);
    expect(chain.insert).toHaveBeenCalledTimes(1);
  });

  it("returns false when the row is missing and the insert genuinely fails", async () => {
    const chain = mockChain({
      maybeSingle: { data: null, error: null },
      insertError: new Error("RLS blocked insert"),
      retryError: new Error("still blocked"),
    });
    const db = { from: vi.fn(() => chain) };
    vi.mocked(getSupabase).mockReturnValue(db as never);

    const ok = await saveAnswers(opts);

    expect(ok).toBe(false);
  });

  it("recovers from an insert race (unique violation) by retrying the update", async () => {
    // maybeSingle: no row; insert: unique violation (a concurrent writer
    // created the row) — the retry update then succeeds.
    const chain = mockChain({
      maybeSingle: { data: null, error: null },
      insertError: { code: "23505", message: "duplicate key" },
      retryError: null,
    });
    const db = { from: vi.fn(() => chain) };
    vi.mocked(getSupabase).mockReturnValue(db as never);

    const ok = await submitAttempt(opts);

    expect(ok).toBe(true);
    expect(chain.insert).toHaveBeenCalledTimes(1);
  });
});