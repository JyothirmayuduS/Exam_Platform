import { afterEach, expect, it, vi } from "vitest";
import { getSupabase } from "@/shared/data/supabase";
import { saveViolation } from "@/shared/data/api/proctoring";
import { markExamStart } from "@/shared/services/examClock";
vi.mock("@/shared/data/supabase", () => ({ getSupabase: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it("timestamps a voice flag at detection, not after slow auth/database requests", async () => {
  vi.useFakeTimers();
  const detected = Date.parse("2026-09-01T10:00:10Z");
  vi.setSystemTime(detected);
  const insert = vi.fn().mockResolvedValue({ error: null });
  const db = {
    auth: { getUser: async () => {
      vi.setSystemTime(detected + 5000);
      return { data: { user: { id: "auth-id" } } };
    } },
    from: (table: string) => ({ insert, select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: table === "students" ? { id: "student-id" } : { started_at: "2026-09-01T10:00:00Z" },
    }) }) }) }),
  };
  vi.mocked(getSupabase).mockReturnValue(db as unknown as ReturnType<typeof getSupabase>);
  expect(await saveViolation("00000000-0000-4000-8000-000000000001", "EXAM", "student-id", "audio_detected", "Speech detected")).toBe(true);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({
    created_at: new Date(detected).toISOString(), offset_seconds: 10,
  }));
});

it("measures a student's flag from the exam start on the student's own clock, not the server's", async () => {
  vi.useFakeTimers();
  const attempt = "00000000-0000-4000-8000-000000000002";
  // The student PC runs 3 minutes behind the server.
  const startOnPc = Date.parse("2026-09-01T09:57:00Z");
  markExamStart(attempt, startOnPc);
  const detected = startOnPc + 95_000;
  vi.setSystemTime(detected);
  const insert = vi.fn().mockResolvedValue({ error: null });
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: "auth-id" } } }) },
    from: (table: string) => ({ insert, select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: table === "students" ? { id: "student-id" } : { started_at: "2026-09-01T10:00:00Z" },
    }) }) }) }),
  };
  vi.mocked(getSupabase).mockReturnValue(db as unknown as ReturnType<typeof getSupabase>);
  expect(await saveViolation(attempt, "EXAM", "student-id", "tab_switch", "Tab switched")).toBe(true);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ offset_seconds: 95 }));
});
