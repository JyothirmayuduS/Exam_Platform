// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { withStaffEmails } from "./staffEmails.ts";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function teachers(rows: { id: string; email: string | null }[]) {
  const asked: string[][] = [];
  const db = {
    from: vi.fn(() => ({ select: () => ({ in: async (_col: string, ids: string[]) => { asked.push(ids); return { data: rows.filter((r) => ids.includes(r.id)) }; } }) })),
  };
  return { db, asked };
}

describe("withStaffEmails", () => {
  it("takes each staff member's address from their record, not from the browser", async () => {
    const { db, asked } = teachers([{ id: T1, email: "rao@vignan.ac.in" }, { id: T2, email: null }]);
    const out = await withStaffEmails(db, [
      { id: T1, name: "Dr. Rao", email: "someone-else@example.com" },
      { id: T2, name: "No Mail" },
      { id: null, name: "Typed in", email: "typed@vignan.ac.in" },
    ]);
    expect(out.map((r) => r.email)).toEqual(["rao@vignan.ac.in", null, "typed@vignan.ac.in"]);
    expect(asked).toEqual([[T1, T2]]);
  });

  it("does not query when nobody has a staff id", async () => {
    const { db } = teachers([]);
    const list = [{ name: "Typed in", email: "typed@vignan.ac.in" }, { id: "not-a-uuid", email: null }];
    expect(await withStaffEmails(db, list)).toBe(list);
    expect(db.from).not.toHaveBeenCalled();
  });
});
