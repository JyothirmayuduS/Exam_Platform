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
let access: Record<string, string>;
let sitting: Set<string>;
let handler: (request: Request) => Promise<Response>;
const fetchMock = vi.fn();
function request(body: Record<string, unknown>) {
  return handler(new Request("https://example.invalid/function", { method: "POST", headers: { Authorization: "Bearer test-placeholder" }, body: JSON.stringify(body) }));
}
beforeEach(() => {
  student = { id: "student-uuid", roll: "R1" }; staff = false; access = {}; sitting = new Set(["Exam"]); fetchMock.mockReset();
  const client = { auth: { getUser: async () => ({ data: { user: { id: "auth-id" } } }) },
    from: (table: string) => ({ select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: table === "students" ? student : null }) }),
      or: async () => ({ data: staff ? [{ id: "teacher-id", auth_id: "auth-id" }] : [] }),
    }) }),
    rpc: async (fn: string, args: { p_folders?: string[]; p_folder?: string }) => fn === "student_evidence_folder_ok"
      ? { data: sitting.has(args.p_folder ?? ""), error: null }
      : { data: (args.p_folders ?? []).map((folder) => ({ folder, access: access[folder] ?? null })), error: null } };
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
  it("refuses a student's own folder under an exam they are not sitting", async () => {
    sitting = new Set(["EX-1", "Mid-term"]);
    expect((await request({ op: "put", examId: "EX-1", studentId: "R1", kind: "recordings", name: "a.webm" })).status).toBe(200);
    expect((await request({ op: "put", examId: "Mid-term", studentId: "R1", kind: "screenshots", name: "a.jpg" })).status).toBe(200);
    const refused = await request({ op: "put", examId: "EX-2", studentId: "R1", kind: "screenshots", name: "a.jpg" });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatch(/not sitting this exam/);
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
  describe("staff", () => {
    beforeEach(() => { student = null; staff = true; });

    it("write evidence only under the id of an exam they have full access to", async () => {
      access = { "EX-1": "full", "Mid-term": "legacy" };
      expect((await request({ op: "put", examId: "EX-1", studentId: "R1", kind: "recordings", name: "a.webm" })).status).toBe(200);
      expect((await request({ op: "put", examId: "Mid-term", studentId: "R1", kind: "recordings", name: "a.webm" })).status).toBe(403);
      expect((await request({ op: "put", examId: "EX-2", studentId: "R1", kind: "violations", name: "a.jpg" })).status).toBe(403);
    });

    it("read old name folders only with legacy access", async () => {
      access = { "Mid-term": "legacy" };
      expect((await request({ op: "get", key: "Mid-term/R1/screenshots/a.jpg" })).status).toBe(200);
      expect((await request({ op: "get", key: "Other/R1/screenshots/a.jpg" })).status).toBe(403);
    });

    it("an assigned proctor reads and writes violation frames only", async () => {
      access = { "EX-1": "proctor" };
      expect((await request({ op: "put", examId: "EX-1", studentId: "R1", kind: "violations", name: "a.jpg" })).status).toBe(200);
      expect((await request({ op: "put", examId: "EX-1", studentId: "R1", kind: "recordings", name: "a.webm" })).status).toBe(403);
      expect((await request({ op: "get", key: "EX-1/R1/violations/a.jpg" })).status).toBe(200);
      expect((await request({ op: "get", key: "EX-1/R1/subjective/a.jpg" })).status).toBe(403);
      fetchMock.mockResolvedValueOnce(new Response("<ListBucketResult><Contents><Key>EX-1/R1/violations/a.jpg</Key></Contents><Contents><Key>EX-1/R1/recordings/b.webm</Key></Contents></ListBucketResult>"));
      const listed = await (await request({ op: "list", prefix: "EX-1/R1" })).json();
      expect(listed.objects.map((o: { key: string }) => o.key)).toEqual(["EX-1/R1/violations/a.jpg"]);
    });

    it("see only the top-level folders of exams they can access", async () => {
      access = { "EX-1": "full", "Mid-term": "legacy" };
      fetchMock.mockResolvedValueOnce(new Response("<ListBucketResult><CommonPrefixes><Prefix>EX-1/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>Mid-term/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>EX-2/</Prefix></CommonPrefixes></ListBucketResult>"));
      expect((await (await request({ op: "folders", prefix: "" })).json()).folders).toEqual(["EX-1/", "Mid-term/"]);
      expect((await request({ op: "folders", prefix: "EX-2/" })).status).toBe(403);
    });
  });
  it("does not pretend a truncated page without a token is complete", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>"));
    expect((await request({ op: "list", prefix: "Exam/R1" })).status).toBe(502);
  });
});
