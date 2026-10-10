import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ATTEMPT = "0b6f3a52-6c4e-4d8a-9a51-2f1f0f7c9e11";

// Fake database: add_attempt_extra_minutes behaves like the SQL function —
// only the owning teacher may call it, and only while the attempt is live.
const db = {
  caller: "owner" as "owner" | "proctor",
  state: "in_progress",
  extra: 0,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
};

vi.mock("@/shared/data/supabase", () => ({
  getSupabase: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.calls.push({ fn, args });
      if (fn === "can_manage_exam") return { data: db.caller === "owner", error: null };
      if (fn !== "add_attempt_extra_minutes") return { data: null, error: { code: "42883", message: "no such function" } };
      if (db.caller !== "owner") return { data: null, error: { code: "42501", message: "forbidden" } };
      if (db.state !== "in_progress" && db.state !== "paused") return { data: null, error: { code: "P0001", message: "not_live" } };
      db.extra += Number(args.p_minutes);
      return { data: [{ extra_minutes: db.extra, deadline: null, seconds_left: 3000 + db.extra * 60 }], error: null };
    },
  }),
}));

import { extendAttemptTime, canManageExam } from "@/shared/data/examApi";
import { extraTimeLabel, LiveExtraTimeControl } from "@/features/proctoring/components/LiveExtraTime";

beforeEach(() => {
  db.caller = "owner";
  db.state = "in_progress";
  db.extra = 0;
  db.calls = [];
});
afterEach(cleanup);

describe("extendAttemptTime", () => {
  it("adds minutes through the database function for the owning teacher", async () => {
    const res = await extendAttemptTime(ATTEMPT, 7);
    expect(res).toEqual({ ok: true, extraMinutes: 7, secondsLeft: 3420 });
    expect(db.calls).toEqual([{ fn: "add_attempt_extra_minutes", args: { p_attempt: ATTEMPT, p_minutes: 7 } }]);
  });

  it("reports forbidden for a proctor and changes nothing", async () => {
    db.caller = "proctor";
    const res = await extendAttemptTime(ATTEMPT, 7);
    expect(res).toMatchObject({ ok: false, reason: "forbidden" });
    expect(db.extra).toBe(0);
  });

  it("refuses once the attempt is no longer live", async () => {
    db.state = "submitted";
    expect(await extendAttemptTime(ATTEMPT, 5)).toMatchObject({ ok: false, reason: "not_live" });
  });

  it("rejects out-of-range minutes without calling the database", async () => {
    expect(await extendAttemptTime(ATTEMPT, 0)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await extendAttemptTime(ATTEMPT, 121)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await extendAttemptTime("enrolled-123", 5)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(db.calls).toHaveLength(0);
  });

  it("canManageExam reflects the database check", async () => {
    expect(await canManageExam("EX-1")).toBe(true);
    db.caller = "proctor";
    expect(await canManageExam("EX-1")).toBe(false);
  });
});

describe("extraTimeLabel", () => {
  it("shows live and accommodation minutes", () => {
    expect(extraTimeLabel(0, 0)).toBe("");
    expect(extraTimeLabel(7)).toBe("+7 min extra");
    expect(extraTimeLabel(7, 15)).toBe("+7 min extra · +15 min accommodation");
    expect(extraTimeLabel(0, 15)).toBe("+15 min accommodation");
  });
});

describe("LiveExtraTimeControl", () => {
  it("lets a proctor see the minutes but not change them", () => {
    render(<LiveExtraTimeControl attemptId={ATTEMPT} live canAdd={false} extraMinutes={7} accommodationMinutes={10} />);
    expect(screen.getByText("+7 min extra · +10 min accommodation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add minutes/i })).toBeNull();
    expect(screen.queryByLabelText(/minutes to add/i)).toBeNull();
    expect(screen.getByText(/only the exam.s owner, a delegated teacher or an admin/i)).toBeTruthy();
  });

  it("lets the owning teacher add minutes during a live attempt", async () => {
    const onAdded = vi.fn();
    const onMessage = vi.fn();
    render(<LiveExtraTimeControl attemptId={ATTEMPT} live canAdd extraMinutes={0} onAdded={onAdded} onMessage={onMessage} />);
    fireEvent.change(screen.getByLabelText(/minutes to add/i), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: /add minutes/i }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(7));
    expect(db.calls.at(-1)).toEqual({ fn: "add_attempt_extra_minutes", args: { p_attempt: ATTEMPT, p_minutes: 7 } });
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("Added 7 min"), "ok");
  });

  it("hides the add control once the attempt has ended", () => {
    render(<LiveExtraTimeControl attemptId={ATTEMPT} live={false} canAdd extraMinutes={5} />);
    expect(screen.getByText("+5 min extra")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add minutes/i })).toBeNull();
  });
});
