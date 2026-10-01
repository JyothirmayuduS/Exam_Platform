import { beforeEach, describe, expect, it, vi } from "vitest";
import { r2List } from "./r2Function";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("./env", () => ({ supabaseConfigured: true }));
vi.mock("./supabase", () => ({ getSupabase: () => ({ functions: { invoke } }) }));
beforeEach(() => invoke.mockReset());
describe("R2 list pagination", () => {
  it("follows every continuation token", async () => {
    const object = (key: string) => ({ key, name: key, size: 1, lastModified: null });
    invoke.mockResolvedValueOnce({ data: { objects: [object("first")], nextContinuationToken: "a+/=&token" } })
      .mockResolvedValueOnce({ data: { objects: [object("last")], nextContinuationToken: null } });
    expect((await r2List("Exam/R1"))?.map((o) => o.key)).toEqual(["first", "last"]);
    expect(invoke).toHaveBeenLastCalledWith("store-artifact", { body: { op: "list", prefix: "Exam/R1", continuationToken: "a+/=&token" } });
  });
  it("does not return a silently truncated success when a later page fails", async () => {
    invoke.mockResolvedValueOnce({ data: { objects: [], nextContinuationToken: "next" } })
      .mockResolvedValueOnce({ error: new Error("offline") });
    expect(await r2List("Exam/R1")).toBeNull();
  });
  it("terminates repeated pagination tokens instead of looping forever", async () => {
    invoke.mockResolvedValue({ data: { objects: [], nextContinuationToken: "same" } });
    expect(await r2List("Exam/R1")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
