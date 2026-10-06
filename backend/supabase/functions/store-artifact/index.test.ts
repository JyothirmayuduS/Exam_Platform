// @vitest-environment node
// Exercise the actual Edge Function handler without credentials or network.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const code = ts.transpileModule(readFileSync(new URL("./index.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
let student: { id: string; roll: string } | null;
let staff: boolean;
let handler: (request: Request) => Promise<Response>;
const fetchMock = vi.fn();
function request(body: Record<string, unknown>) {
  return handler(new Request("https://example.invalid/function", { method: "POST", headers: { Authorization: "Bearer test-placeholder" }, body: JSON.stringify(body) }));
}
beforeEach(() => {
  student = { id: "student-uuid", roll: "R1" }; staff = false; fetchMock.mockReset();
  const client = { auth: { getUser: async () => ({ data: { user: { id: "auth-id" } } }) },
    from: (table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "students" ? student : staff ? { id: "teacher-id" } : null }) }) }) }) };
  runInNewContext(code, { exports: {}, Request, Response, console, fetch: fetchMock,
    Deno: { env: { get: (key: string) => key === "R2_S3_ENDPOINT" ? "https://r2.example.invalid" : "placeholder" }, serve: (fn: typeof handler) => { handler = fn; } },
    require: (name: string) => name.includes("supabase-js") ? { createClient: () => client }
      : { AwsClient: class { sign = async (r: Request) => r; } },
  });
});
describe("artifact edge function", () => {
  it.each(["R1", "student-uuid"])("accepts authenticated student's own %s folder", async (owner) => {
    const response = await request({ op: "put", examId: "Exam", studentId: owner, kind: "screenshots", name: "snap_1.jpg" });
    expect(response.status).toBe(200);
    expect((await response.json()).key).toBe(`Exam/${owner}/screenshots/snap_1.jpg`);
  });
  it("rejects another student's folder and users without a profile", async () => {
    expect((await request({ op: "get", key: "Exam/R2/screenshots/a.jpg" })).status).toBe(403);
    student = null;
    for (const op of ["get", "fetch-data", "list", "folders"]) {
      expect((await request({ op, key: "Exam/R1/screenshots/a.jpg", prefix: "Exam/R1/" })).status).toBe(403);
    }
  });
  it("relays the next token and signs a bounded folder prefix on subsequent pages", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>a+/=&amp;x</NextContinuationToken><Contents><Key>Exam/R1/screenshots/a.jpg</Key><Size>12</Size></Contents></ListBucketResult>"));
    const response = await request({ op: "list", prefix: "Exam/R1", continuationToken: "previous+/=&" });
    expect(response.status).toBe(200);
    expect((await response.json()).nextContinuationToken).toBe("a+/=&x");
    const signed = fetchMock.mock.calls[0][0] as Request;
    expect(new URL(signed.url).searchParams.get("prefix")).toBe("Exam/R1/");
    expect(new URL(signed.url).searchParams.get("continuation-token")).toBe("previous+/=&");
  });
  it("does not pretend a truncated page without a token is complete", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"));
    expect((await request({ op: "list", prefix: "Exam/R1" })).status).toBe(502);
  });
});
