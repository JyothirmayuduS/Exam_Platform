import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useAutosave from "@/features/student/hooks/useAutosave";
import { readPending, saveOrQueue, type PendingSync } from "@/features/student/domain/resume";

const INTERVAL = 10_000;
let online = true;

function setOnline(value: boolean, fireEvent: boolean) {
  online = value;
  if (fireEvent) window.dispatchEvent(new Event(value ? "online" : "offline"));
}

/** Wire the hook exactly like the exam page: save, else queue on the device. */
function setup() {
  const server: { answers: Record<string, unknown> | null } = { answers: null };
  const save = vi.fn(async (e: PendingSync) => {
    if (!online) return false;
    server.answers = e.answers;
    return true;
  });
  const hook = renderHook(
    ({ answers }: { answers: Record<string, unknown> }) =>
      useAutosave({
        enabled: true,
        payload: answers,
        intervalMs: INTERVAL,
        onSave: () =>
          saveOrQueue(
            "EX-1",
            { answers, answered: Object.keys(answers).length, minutesUsed: 0, isSubmit: false, savedAt: Date.now(), studentId: "s1" },
            save,
          ),
      }),
    { initialProps: { answers: { q1: 0 } as Record<string, unknown> } },
  );
  return { hook, save, server };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("autosave across a connection drop", () => {
  it("survives a drop longer than the autosave interval and uploads the latest answers", async () => {
    const { hook, save, server } = setup();
    await advance(1500);
    expect(server.answers).toEqual({ q1: 0 });
    expect(hook.result.current.status).toBe("saved");

    setOnline(false, true);
    hook.rerender({ answers: { q1: 0, q2: "a" } });
    await advance(1500);
    expect(hook.result.current.status).toBe("local");
    expect(readPending("EX-1")?.answers).toEqual({ q1: 0, q2: "a" });

    // 35 s offline (3.5 autosave intervals) with one more answer mid-drop.
    const callsBefore = save.mock.calls.length;
    await advance(15_000);
    hook.rerender({ answers: { q1: 0, q2: "a", q3: 1 } });
    await advance(20_000);
    expect(save.mock.calls.length).toBeGreaterThan(callsBefore + 2);
    expect(hook.result.current.failures).toBeGreaterThanOrEqual(3);
    expect(readPending("EX-1")?.answers).toEqual({ q1: 0, q2: "a", q3: 1 });
    expect(server.answers).toEqual({ q1: 0 });

    // Internet back without an `online` event (Wi-Fi never dropped): the
    // retry timer alone must deliver the newest answers.
    setOnline(true, false);
    await advance(INTERVAL);
    expect(server.answers).toEqual({ q1: 0, q2: "a", q3: 1 });
    expect(hook.result.current.status).toBe("saved");
    expect(hook.result.current.failures).toBe(0);
    expect(readPending("EX-1")).toBeNull();
  });

  it("retries failed saves on the timer even when nothing changes", async () => {
    const { hook, save } = setup();
    setOnline(false, true);
    await advance(1500);
    const afterFirst = save.mock.calls.length;
    await advance(INTERVAL * 2);
    expect(save.mock.calls.length).toBe(afterFirst + 2);
    expect(hook.result.current.status).toBe("local");
  });

  it("retries at once when the browser reports it is back online", async () => {
    const { hook, server } = setup();
    setOnline(false, true);
    hook.rerender({ answers: { q1: 3 } });
    await advance(1500);
    expect(server.answers).toBeNull();
    setOnline(true, true);
    await advance(10);
    expect(server.answers).toEqual({ q1: 3 });
  });

  it("never runs two saves at once while one is slow", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const onSave = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 25_000));
      inFlight -= 1;
      return true;
    });
    renderHook(() => useAutosave({ enabled: true, payload: 1, intervalMs: INTERVAL, onSave }));
    await advance(40_000);
    expect(maxInFlight).toBe(1);
  });
});
