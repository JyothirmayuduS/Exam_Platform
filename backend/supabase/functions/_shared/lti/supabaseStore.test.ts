// @vitest-environment node
// ensureAuthUser against a stand-in Supabase client: an existing auth account
// is adopted for a Moodle student only when it is a student account.
import { beforeEach, describe, expect, it } from "vitest";
import { supabaseLtiStore } from "./supabaseStore.ts";

type AuthUser = { id: string; email: string; app_metadata: Record<string, unknown> };
type StudentRow = { id: string; roll: string; auth_id: string | null };

function fakeDb(students: StudentRow[], users: AuthUser[]) {
  const created: AuthUser[] = [];
  const query = (table: string) => {
    const filters: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const run = () => {
      if (table !== "students") throw new Error(`unexpected table ${table}`);
      const rows = students.filter((s) => Object.entries(filters).every(([k, v]) => (s as Record<string, unknown>)[k] === v));
      if (patch) rows.forEach((r) => Object.assign(r, patch));
      return rows;
    };
    const b = {
      select: () => b,
      update: (p: Record<string, unknown>) => { patch = p; return b; },
      eq: (k: string, v: unknown) => { filters[k] = v; return b; },
      is: (k: string, v: unknown) => { filters[k] = v; return b; },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (ok: (r: { data: StudentRow[]; error: null }) => unknown) => Promise.resolve({ data: run(), error: null }).then(ok),
    };
    return b;
  };
  const db = {
    from: query,
    auth: {
      admin: {
        createUser: async (u: { email: string; app_metadata: Record<string, unknown> }) => {
          if (users.some((x) => x.email === u.email)) return { data: { user: null }, error: { message: "already registered" } };
          const user = { id: `new-${u.email}`, email: u.email, app_metadata: u.app_metadata };
          users.push(user);
          created.push(user);
          return { data: { user }, error: null };
        },
        listUsers: async ({ page }: { page: number }) => ({ data: { users: page === 1 ? users : [] }, error: null }),
      },
    },
  };
  return { db, created };
}

describe("ensureAuthUser", () => {
  let students: StudentRow[];
  beforeEach(() => {
    students = [{ id: "stu-1", roll: "21BQ1A0501", auth_id: null }];
  });

  it("creates a student auth account when none exists", async () => {
    const { db, created } = fakeDb(students, []);
    expect(await supabaseLtiStore(db).ensureAuthUser("stu-1")).toEqual({ authUserId: "new-21bq1a0501@student.vignan.ac.in" });
    expect(created[0].app_metadata).toMatchObject({ role: "student" });
    expect(students[0].auth_id).toBe("new-21bq1a0501@student.vignan.ac.in");
  });

  it("adopts an existing account at the login email only when its role is student", async () => {
    const { db } = fakeDb(students, [{ id: "auth-s", email: "21bq1a0501@student.vignan.ac.in", app_metadata: { role: "student" } }]);
    expect(await supabaseLtiStore(db).ensureAuthUser("stu-1")).toEqual({ authUserId: "auth-s" });
    expect(students[0].auth_id).toBe("auth-s");
  });

  it.each([
    ["a teacher account", { role: "teacher" }],
    ["an admin account", { role: "admin" }],
    ["an account with no role", {}],
  ])("refuses %s at the student's login email and links nothing", async (_label, appMetadata) => {
    const { db } = fakeDb(students, [{ id: "auth-x", email: "21bq1a0501@student.vignan.ac.in", app_metadata: appMetadata }]);
    expect(await supabaseLtiStore(db).ensureAuthUser("stu-1")).toEqual({ error: "not_student_account" });
    expect(students[0].auth_id).toBeNull();
  });

  it("keeps the account a student row is already linked to", async () => {
    students[0].auth_id = "auth-linked";
    const { db, created } = fakeDb(students, []);
    expect(await supabaseLtiStore(db).ensureAuthUser("stu-1")).toEqual({ authUserId: "auth-linked" });
    expect(created).toEqual([]);
  });

  it("reports a missing student", async () => {
    const { db } = fakeDb(students, []);
    expect(await supabaseLtiStore(db).ensureAuthUser("nobody")).toEqual({ error: "no_account" });
  });
});
