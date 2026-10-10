// @vitest-environment node
// send-proctor-email and send-evaluator-email, run as the real handlers with a
// fake database and mailer: who may send, who may receive, what comes back.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const load = (rel: string) => ts.transpileModule(readFileSync(new URL(rel, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const GATE = load("./assignmentEmail.ts");
const FUNCTIONS = { proctor: load("../send-proctor-email/index.ts"), evaluator: load("../send-evaluator-email/index.ts") };
type Kind = keyof typeof FUNCTIONS;

const OWNER = "00000000-0000-0000-0000-00000000000a";
const STRANGER = "00000000-0000-0000-0000-00000000000b";
const ON_EXAM = "50000000-0000-0000-0000-000000000001";
const NO_EMAIL = "50000000-0000-0000-0000-000000000002";
const OTHER_EXAM = "50000000-0000-0000-0000-000000000003";

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let session: string | null;
let manages: Record<string, string[]>;
let env: Record<string, string | undefined> = {};
const sendMail = vi.fn();

function table(name: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let head = false;
  const rows = () => (tables[name] ??= []).filter((r) => filters.every((f) => f(r)));
  const chain: Record<string, unknown> = {
    select: (_cols: string, opts?: { head?: boolean }) => { head = !!opts?.head; return chain; },
    eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return chain; },
    in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return chain; },
    gte: (k: string, v: string) => { filters.push((r) => String(r[k]) >= v); return chain; },
    insert: async (row: Row) => { (tables[name] ??= []).push({ created_at: new Date().toISOString(), ...row }); return { error: null }; },
    upsert: async (row: Row) => { (tables[name] ??= []).push(row); return { error: null }; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve(head ? { count: rows().length, error: null } : { data: rows(), error: null }).then(ok, bad),
  };
  return chain;
}

// Mirrors the SQL helpers; their real behaviour is covered in exam-naming-access.sql.test.ts.
const slotCalls = vi.fn();
async function adminRpc(fn: string, a: Record<string, unknown>) {
  if (fn === "assignment_email_staff") {
    const ids = a.p_ids as string[];
    const examOf = (r: Row) => r.exam_id ?? tables.attempts.find((t) => t.id === r.attempt_id)?.exam_id;
    const rows = a.p_kind === "proctor"
      ? tables.proctor_assignments.filter((r) => r.exam_id === a.p_exam && ids.includes(String(r.assignee_id))).map((r) => r.assignee_id)
      : tables.grading_delegations.filter((r) => examOf(r) === a.p_exam && ids.includes(String(r.delegate_id))).map((r) => r.delegate_id);
    return { data: [...new Set(rows)], error: null };
  }
  if (fn === "take_assignment_email_slot") {
    slotCalls(a);
    const mine = tables.assignment_email_log.filter((r) => r.caller_id === a.p_caller && r.exam_id === a.p_exam && r.kind === a.p_kind);
    if (mine.length >= Number(a.p_max)) return { data: false, error: null };
    tables.assignment_email_log.push({ caller_id: a.p_caller, exam_id: a.p_exam, kind: a.p_kind });
    return { data: true, error: null };
  }
  throw new Error(`unexpected rpc ${fn}`);
}

function createClient(_url: string, _key: string, opts?: { global?: { headers?: { Authorization?: string } } }) {
  if (!opts?.global?.headers?.Authorization) return { from: table, rpc: adminRpc };
  return {
    auth: { getUser: async () => ({ data: { user: session ? { id: session } : null } }) },
    rpc: async (fn: string, args: { p_exam: string }) =>
      ({ data: fn === "can_manage_exam" && !!session && (manages[session] ?? []).includes(args.p_exam), error: null }),
  };
}

const handlers = {} as Record<Kind, (r: Request) => Promise<Response>>;
for (const kind of Object.keys(FUNCTIONS) as Kind[]) {
  const gate = { exports: {} as Record<string, unknown> };
  runInNewContext(GATE, { exports: gate.exports, Date, Number, String, Map, Set, Array });
  runInNewContext(FUNCTIONS[kind], {
    exports: {}, Request, Response, JSON, Date, console: { log: () => {}, error: () => {} },
    Deno: { env: { get: (k: string) => k in env ? env[k] : "placeholder" }, serve: (fn: (r: Request) => Promise<Response>) => { handlers[kind] = fn; } },
    require: (spec: string) => spec.includes("assignmentEmail") ? gate.exports
      : spec.includes("nodemailer") ? { __esModule: true, default: { createTransport: () => ({ sendMail }) } }
      : { createClient },
  });
}

const LIST = { proctor: "proctors", evaluator: "evaluators" } as const;
function send(kind: Kind, staff: unknown[], opts: { examId?: string; auth?: string | null; extra?: Row } = {}) {
  const headers: Record<string, string> = {};
  if (opts.auth !== null) headers.Authorization = opts.auth ?? "Bearer user-session";
  return handlers[kind](new Request("https://example.invalid/function", {
    method: "POST", headers, body: JSON.stringify({ examId: opts.examId ?? "EX-1", [LIST[kind]]: staff, ...opts.extra }),
  }));
}
const mailedTo = () => sendMail.mock.calls.map(([m]) => (m as { to: string }).to).sort();

beforeEach(() => {
  sendMail.mockReset();
  sendMail.mockResolvedValue({});
  slotCalls.mockReset();
  env = { APP_BASE_URL: "https://exams.example.invalid/" };
  session = OWNER;
  manages = { [OWNER]: ["EX-1", "EX-2"] };
  tables = {
    exams: [{ id: "EX-1", name: "Mid Term", batch: "CSE-A" }, { id: "EX-2", name: "Other", batch: "CSE-B" }],
    proctor_assignments: [
      { exam_id: "EX-1", assignee_id: ON_EXAM }, { exam_id: "EX-1", assignee_id: NO_EMAIL }, { exam_id: "EX-2", assignee_id: OTHER_EXAM },
    ],
    grading_delegations: [
      { exam_id: "EX-1", delegate_id: ON_EXAM }, { exam_id: "EX-1", delegate_id: NO_EMAIL }, { exam_id: "EX-2", delegate_id: OTHER_EXAM },
    ],
    teachers: [
      { id: ON_EXAM, email: "on.exam@staff.invalid", full_name: "Dr. Rao" },
      { id: NO_EMAIL, email: null, full_name: "No Mail" },
      { id: OTHER_EXAM, email: "other.exam@staff.invalid", full_name: "Elsewhere" },
    ],
    attempts: [{ id: "AT-1", exam_id: "EX-1" }, { id: "AT-2", exam_id: "EX-2" }],
    assignment_email_log: [],
    email_notifications: [],
  };
});

describe.each(Object.keys(FUNCTIONS) as Kind[])("send-%s-email", (kind) => {
  it("refuses an anonymous caller with 403", async () => {
    session = null;
    expect((await send(kind, [{ id: ON_EXAM }], { auth: null })).status).toBe(403);
    expect((await send(kind, [{ id: ON_EXAM }], { auth: "Bearer anon-key" })).status).toBe(403);
    expect(sendMail).not.toHaveBeenCalled();
    expect(tables.assignment_email_log).toEqual([]);
  });

  it("refuses a teacher who cannot manage the exam with 403", async () => {
    session = STRANGER;
    const res = await send(kind, [{ id: ON_EXAM }]);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/@/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("emails only staff on the exam, at their own address, ignoring raw addresses", async () => {
    const res = await send(kind, [
      { id: ON_EXAM, email: "attacker@evil.invalid", count: 2 },
      { id: OTHER_EXAM },
      { email: "outsider@evil.invalid" },
      { id: "not-a-staff-id", email: "x@evil.invalid" },
      { id: NO_EMAIL },
    ]);
    expect(res.status).toBe(200);
    expect(mailedTo()).toEqual(["on.exam@staff.invalid"]);
    const body = await res.json();
    expect(body).toMatchObject({ sent: 1, skipped: 1, failed: 0, refused: 3 });
    expect(body.results).toEqual(expect.arrayContaining([
      { id: ON_EXAM, status: "sent" },
      { id: OTHER_EXAM, status: "refused" },
      { id: null, status: "refused" },
      { id: "not-a-staff-id", status: "refused" },
      { id: NO_EMAIL, status: "skipped" },
    ]));
  });

  it("never returns an email address, even when a send fails", async () => {
    sendMail.mockRejectedValue(new Error("550 mailbox on.exam@staff.invalid unavailable"));
    const res = await send(kind, [{ id: ON_EXAM }, { email: "outsider@evil.invalid" }]);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/@/);
    expect(body.results).toEqual([{ id: null, status: "refused" }, { id: ON_EXAM, status: "failed" }]);
    for (const r of body.results) expect(Object.keys(r).sort()).toEqual(["id", "status"]);
  });

  it("limits each caller to a few requests per exam", async () => {
    for (let i = 0; i < 5; i++) expect((await send(kind, [{ id: ON_EXAM }])).status, `request ${i + 1}`).toBe(200);
    expect((await send(kind, [{ id: ON_EXAM }])).status).toBe(429);
    expect((await send(kind, [{ id: OTHER_EXAM }], { examId: "EX-2" })).status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(6);
  });

  it("takes a rate-limit slot only once there is someone to email", async () => {
    session = STRANGER;
    await send(kind, [{ id: ON_EXAM }]);
    session = OWNER;
    for (let i = 0; i < 7; i++) await send(kind, [{ id: OTHER_EXAM }, { id: NO_EMAIL }, { email: "outsider@evil.invalid" }]);
    expect(slotCalls).not.toHaveBeenCalled();
    expect(tables.assignment_email_log).toEqual([]);
    expect((await send(kind, [{ id: ON_EXAM }])).status).toBe(200);
    expect(slotCalls).toHaveBeenCalledOnce();
    expect(slotCalls.mock.calls[0][0]).toEqual({ p_caller: OWNER, p_exam: "EX-1", p_kind: kind, p_max: 5, p_window_seconds: 600 });
  });

  it("builds the link from APP_BASE_URL only, escaped, ignoring appBaseUrl in the request", async () => {
    env.APP_BASE_URL = 'https://exams.example.invalid/?a=1&b="x"/';
    await send(kind, [{ id: ON_EXAM }], { extra: { appBaseUrl: "https://evil.invalid" } });
    const html = String((sendMail.mock.calls[0][0] as { html: string }).html);
    expect(html).not.toContain("evil.invalid");
    expect(html).not.toContain('b="x"');
    const path = kind === "proctor" ? "/proctor?exam=EX-1" : "/teacher/evaluate?exam=EX-1";
    const link = `https://exams.example.invalid/?a=1&amp;b=&quot;x&quot;${path}`;
    expect(html).toContain(`href="${link}"`);
    expect(html.split(link)).toHaveLength(3);
  });

  it("refuses to send without APP_BASE_URL", async () => {
    env.APP_BASE_URL = undefined;
    const res = await send(kind, [{ id: ON_EXAM }], { extra: { appBaseUrl: "https://evil.invalid" } });
    expect(res.status).toBe(500);
    expect(sendMail).not.toHaveBeenCalled();
    expect(slotCalls).not.toHaveBeenCalled();
  });
});

describe("send-evaluator-email delegations by attempt", () => {
  it("accepts a delegation that has only an attempt id when the attempt belongs to the exam", async () => {
    const BY_ATTEMPT = "50000000-0000-0000-0000-000000000004";
    const WRONG_ATTEMPT = "50000000-0000-0000-0000-000000000005";
    tables.grading_delegations.push(
      { exam_id: null, attempt_id: "AT-1", delegate_id: BY_ATTEMPT },
      { exam_id: null, attempt_id: "AT-2", delegate_id: WRONG_ATTEMPT },
    );
    tables.teachers.push(
      { id: BY_ATTEMPT, email: "by.attempt@staff.invalid", full_name: "By Attempt" },
      { id: WRONG_ATTEMPT, email: "wrong.attempt@staff.invalid", full_name: "Wrong Attempt" },
    );
    const body = await (await send("evaluator", [{ id: BY_ATTEMPT }, { id: WRONG_ATTEMPT }])).json();
    expect(mailedTo()).toEqual(["by.attempt@staff.invalid"]);
    expect(body.results).toEqual([{ id: WRONG_ATTEMPT, status: "refused" }, { id: BY_ATTEMPT, status: "sent" }]);
  });
});
