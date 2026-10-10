// @vitest-environment node
// Exercise the actual Edge Function handler without credentials or network.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const code = ts.transpileModule(readFileSync(new URL("./index.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

let user: { id: string; email: string; app_metadata?: Record<string, unknown> };
let teacher: { role: string } | null;
let student: { roll: string } | null;
let canJoin: boolean;
let grants: Record<string, unknown>[];
const rpc = vi.fn();
let handler: (request: Request) => Promise<Response>;

function request(room: string) {
  return handler(new Request("https://example.invalid/function", {
    method: "POST", headers: { Authorization: "Bearer test-placeholder" }, body: JSON.stringify({ room }),
  }));
}

beforeEach(() => {
  user = { id: "auth-id", email: "someone@example.invalid" };
  teacher = null; student = null; canJoin = false; grants = []; rpc.mockReset();
  rpc.mockImplementation(async () => ({ data: canJoin, error: null }));
  const client = {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table: string) => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: table === "teachers" ? teacher : table === "students" ? student : null }),
    }) }) }),
    rpc,
  };
  class AccessToken {
    constructor(_k: string, _s: string, public opts: { identity: string }) {}
    addGrant(g: Record<string, unknown>) { grants.push(g); }
    async toJwt() { return "signed"; }
  }
  runInNewContext(code, { exports: {}, Request, Response, URL, console: { log: () => {}, error: () => {} }, crypto, TextEncoder,
    Deno: { env: { get: (key: string) => key === "LIVEKIT_URL" ? "wss://lk.example.invalid" : key === "ALLOWED_ORIGIN" ? "*" : "placeholder" },
      serve: (fn: typeof handler) => { handler = fn; } },
    require: (name: string) => name.includes("supabase-js") ? { createClient: () => client } : { AccessToken },
  });
});

describe("livekit-token", () => {
  it("refuses staff who are not on the exam", async () => {
    teacher = { role: "proctor" };
    const res = await request("EX-1");
    expect(res.status).toBe(403);
    expect(rpc).toHaveBeenCalledWith("can_join_livekit_room", { p_room: "EX-1" });
    expect(grants).toEqual([]);
  });

  it("gives an assigned proctor a watch-only token for the exam room", async () => {
    teacher = { role: "proctor" }; canJoin = true;
    const res = await request("EX-1");
    expect(res.status).toBe(200);
    expect((await res.json()).identity).toBe("proctor:auth-id");
    expect(grants[0]).toMatchObject({ room: "EX-1", canSubscribe: true, canPublish: false });
  });

  it("no longer treats a staff-looking email as staff", async () => {
    user = { id: "auth-id", email: "teacher.admin@example.invalid" };
    const res = await request("EX-1");
    expect(res.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
    expect(grants[0]).toMatchObject({ canSubscribe: false, canPublish: true });
  });

  it("checks staff named only in app_metadata", async () => {
    user = { id: "auth-id", email: "x@example.invalid", app_metadata: { role: "teacher" } };
    expect((await request("EX-1")).status).toBe(403);
  });

  it("still lets a student publish into the exam room", async () => {
    student = { roll: "R1" };
    const res = await request("EX-1");
    expect(res.status).toBe(200);
    expect((await res.json()).identity).toBe("student:R1");
    expect(rpc).not.toHaveBeenCalled();
  });
});
