import { afterEach, expect, it, vi } from "vitest";
import { getSupabase } from "@/shared/data/supabase";
import { saveViolation } from "@/shared/data/api/proctoring";
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
