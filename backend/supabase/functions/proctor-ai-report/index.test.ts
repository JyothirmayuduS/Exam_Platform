// @vitest-environment node
// Exercise the actual Edge Function handler without credentials or network.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const code = ts.transpileModule(readFileSync(new URL("./index.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const CLEAN = { attempt_id: "A1", exam_id: "EX-1", created_at: "2026-10-10T09:00:00Z", risk_score: 12, verdict: "clean", summary: { summary: "Calm.", incidents: [{ type: "gaze", note: "brief" }] } };
const WITH_MARKS = { ...CLEAN, summary: { summary: "x", incidents: [{ type: "t", score: 40 }] } };

let canManage: boolean;
let canInvigilate: boolean;
let stored: Record<string, unknown> | null;
const upsert = vi.fn();
const llm = vi.fn();
let handler: (request: Request) => Promise<Response>;

function request(body: Record<string, unknown>) {
  return handler(new Request("https://example.invalid/function", {
    method: "POST", headers: { Authorization: "Bearer test-placeholder" }, body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  canManage = false; canInvigilate = false; stored = null; upsert.mockReset(); llm.mockReset();
  llm.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ risk_score: 20, verdict: "clean", summary: "ok", incidents: [] }) } }] })));
  upsert.mockResolvedValue({ error: null });
  const query = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: async () => ({ data: [] }),
      maybeSingle: async () => ({
        data: table === "attempts" ? { id: "A1", exam_id: "EX-1", student_id: "S1", state: "submitted" } : table === "ai_reports" ? stored : null,
      }),
      upsert,
    };
    return chain;
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "auth-id" } } }) },
    from: query,
    rpc: async (fn: string) => ({ data: fn === "can_manage_exam" ? canManage : canInvigilate, error: null }),
  };
  runInNewContext(code, { exports: {}, Request, Response, JSON, console: { log: () => {}, error: () => {} }, fetch: llm,
    Deno: { env: { get: () => "placeholder" }, serve: (fn: typeof handler) => { handler = fn; } },
    require: () => ({ createClient: () => client }),
  });
});

describe("proctor-ai-report", () => {
  it("refuses staff and students who cannot access the attempt's exam", async () => {
    stored = CLEAN;
    expect((await request({ attemptId: "A1" })).status).toBe(403);
    expect((await request({ attemptId: "A1", regenerate: true })).status).toBe(403);
    expect(llm).not.toHaveBeenCalled();
  });

  it("returns and generates reports for the owner, delegated teachers and admins", async () => {
    canManage = true; canInvigilate = true; stored = WITH_MARKS;
    expect((await (await request({ attemptId: "A1" })).json()).report).toEqual(WITH_MARKS);
    const res = await request({ attemptId: "A1", regenerate: true });
    expect(res.status).toBe(200);
    expect(llm).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("gives an assigned proctor a stored report without marks or answers", async () => {
    canInvigilate = true; stored = CLEAN;
    expect((await (await request({ attemptId: "A1" })).json()).report).toEqual(CLEAN);
  });

  it("hides reports created before 13:30 IST on 10 Oct 2026 from an assigned proctor", async () => {
    canInvigilate = true;
    stored = { ...CLEAN, created_at: "2026-10-10T07:59:59Z" };
    expect(await (await request({ attemptId: "A1" })).json()).toEqual({ report: null, cached: false });
    stored = { ...CLEAN, created_at: "2026-10-10T08:00:00Z" };
    expect((await (await request({ attemptId: "A1" })).json()).report).toEqual(stored);
    canManage = true; stored = { ...CLEAN, created_at: "2026-09-01T00:00:00Z" };
    expect((await (await request({ attemptId: "A1" })).json()).report).toEqual(stored);
  });

  it("refuses an assigned proctor a report that holds marks", async () => {
    canInvigilate = true; stored = WITH_MARKS;
    const res = await request({ attemptId: "A1" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/marks or answers/);
  });

  it("never lets a proctor generate or overwrite a verdict", async () => {
    canInvigilate = true;
    expect(await (await request({ attemptId: "A1" })).json()).toEqual({ report: null, cached: false });
    expect((await request({ attemptId: "A1", regenerate: true })).status).toBe(403);
    expect(llm).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
