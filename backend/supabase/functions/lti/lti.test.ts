// @vitest-environment node
// Moodle LTI 1.3 end to end against an in-memory store: OIDC login, signed
// launch, ticket exchange and grade passback, with real RS256 keys.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIM, SCORE_SCOPE } from "../_shared/lti/claims.ts";
import { createLtiHandler } from "../_shared/lti/handler.ts";
import { decodeJwt, loadToolKey, signJwt, verifyJwt, type Jwk, type ToolKey } from "../_shared/lti/jwt.ts";
import { postAttemptScore } from "../_shared/lti/scores.ts";
import type { GradeTarget, Link, LtiStore, Platform, Ticket } from "../_shared/lti/types.ts";
import { autoGradeAttempt } from "../_shared/exam/autoGrade.ts";

const TOOL = "https://tool.example/functions/v1/lti";
const APP = "https://exam.example";
const ISS = "https://lms.vignan.example";
const CLIENT = "client-123";
const platform: Platform = {
  id: "plat-1",
  issuer: ISS,
  clientId: CLIENT,
  deploymentIds: ["1"],
  authLoginUrl: `${ISS}/mod/lti/auth.php`,
  authTokenUrl: `${ISS}/mod/lti/token.php`,
  jwksUrl: `${ISS}/mod/lti/certs.php`,
};
const LINEITEM = `${ISS}/mod/lti/services.php/2/lineitems/5/lineitem?type_id=1`;

type Student = { id: string; roll: string; authId: string };

function memoryStore() {
  const s = {
    logins: new Map<string, { nonce: string; platformId: string; createdAt: number }>(),
    links: new Map<string, Link & { resourceLinkId: string }>(),
    students: [{ id: "stu-0501", roll: "21BQ1A0501", authId: "auth-0501" }] as Student[],
    ltiUsers: new Map<string, string>(),
    enrollments: new Set<string>(),
    tickets: new Map<string, Ticket>(),
    targets: new Map<string, { linkId: string; studentId: string; examId: string; sub: string; lineitem: string | null; scoreMaximum: number | null }>(),
    posts: [] as { linkId: string; studentId: string; score: number; error: string | null }[],
    exams: new Set(["EXAM-A", "EXAM-B"]),
  };
  const store: LtiStore = {
    findPlatform: async (iss, clientId) => (iss === platform.issuer && (!clientId || clientId === platform.clientId) ? platform : null),
    getPlatform: async (id) => (id === platform.id ? platform : null),
    saveLogin: async (state, nonce, platformId) => { s.logins.set(state, { nonce, platformId, createdAt: Date.now() }); },
    takeLogin: async (state) => { const l = s.logins.get(state) ?? null; s.logins.delete(state); return l; },
    upsertLink: async (i) => {
      const existing = s.links.get(i.resourceLinkId);
      if (existing) return { id: existing.id, examId: existing.examId };
      const link = { id: `link-${i.resourceLinkId}`, examId: null, resourceLinkId: i.resourceLinkId };
      s.links.set(i.resourceLinkId, link);
      return { id: link.id, examId: null };
    },
    examOpen: async (examId) => s.exams.has(examId),
    resolveStudent: async (_p, who) => {
      const mapped = s.ltiUsers.get(who.sub);
      let student = s.students.find((x) => x.id === mapped)
        ?? s.students.find((x) => !!who.username && x.roll.toLowerCase() === who.username.toLowerCase());
      if (!student) {
        student = { id: `stu-${who.sub}`, roll: `MOODLE-${who.sub}`, authId: `auth-${who.sub}` };
        s.students.push(student);
      }
      s.ltiUsers.set(who.sub, student.id);
      return { studentId: student.id, authUserId: student.authId };
    },
    enroll: async (examId, studentId) => { s.enrollments.add(`${examId}:${studentId}`); },
    saveGradeTarget: async (t) => { s.targets.set(`${t.linkId}:${t.studentId}`, { ...t, scoreMaximum: null }); },
    createTicket: async (hash, t) => { s.tickets.set(hash, t); },
    takeTicket: async (hash) => { const t = s.tickets.get(hash) ?? null; s.tickets.delete(hash); return t; },
    sessionTokenHash: async (authUserId) => `magic-${authUserId}`,
    gradeTargets: async (examId, studentId) =>
      [...s.targets.values()]
        .filter((t) => t.examId === examId && t.studentId === studentId && t.lineitem)
        .map((t): GradeTarget => ({ linkId: t.linkId, sub: t.sub, lineitem: t.lineitem!, scoreMaximum: t.scoreMaximum, platform })),
    setScoreMaximum: async () => {},
    recordScorePost: async (linkId, studentId, r) => { s.posts.push({ linkId, studentId, ...r }); },
  };
  return { s, store };
}

async function rsaKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}

let moodle: CryptoKeyPair;
let moodleJwk: Jwk;
let intruder: CryptoKeyPair;
let toolKey: ToolKey;
const form = { "content-type": "application/x-www-form-urlencoded" };

beforeAll(async () => {
  moodle = await rsaKey();
  intruder = await rsaKey();
  moodleJwk = { ...((await crypto.subtle.exportKey("jwk", moodle.publicKey)) as Jwk), kid: "moodle-1" };
  const tool = await rsaKey();
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", tool.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  toolKey = await loadToolKey(pem, "tool-1");
});

let mem: ReturnType<typeof memoryStore>;
let handler: (req: Request) => Promise<Response>;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  mem = memoryStore();
  mem.s.links.set("rl-1", { id: "link-rl-1", examId: "EXAM-A", resourceLinkId: "rl-1" });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    if (String(input) === platform.jwksUrl) return new Response(JSON.stringify({ keys: [moodleJwk] }));
    return new Response("not found", { status: 404 });
  });
  handler = createLtiHandler({ store: mem.store, key: async () => toolKey, toolUrl: TOOL, appUrl: APP, fetch: fetchMock, now: Date.now });
});

function claimsFor(nonce: string, extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISS,
    aud: CLIENT,
    sub: "7",
    iat: now,
    exp: now + 60,
    nonce,
    name: "Asha Rao",
    email: "asha@vignan.example",
    [CLAIM.version]: "1.3.0",
    [CLAIM.messageType]: "LtiResourceLinkRequest",
    [CLAIM.deploymentId]: "1",
    [CLAIM.resourceLink]: { id: "rl-1", title: "Mid-term (proctored)" },
    [CLAIM.context]: { id: "course-9", title: "CSE Sem III" },
    [CLAIM.roles]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    [CLAIM.ext]: { user_username: "21bq1a0501" },
    ...extra,
  };
}

/** Moodle side of a launch: login initiation, then the signed id_token post. */
async function launch(extra: Record<string, unknown> = {}, signer: CryptoKey = moodle.privateKey) {
  const login = await handler(new Request(`${TOOL}/login`, {
    method: "POST",
    headers: form,
    body: new URLSearchParams({ iss: ISS, login_hint: "7", target_link_uri: `${TOOL}/launch`, client_id: CLIENT, lti_deployment_id: "1" }),
  }));
  expect(login.status).toBe(302);
  const auth = new URL(login.headers.get("location")!);
  expect(auth.origin + auth.pathname).toBe(platform.authLoginUrl);
  expect(auth.searchParams.get("redirect_uri")).toBe(`${TOOL}/launch`);
  const state = auth.searchParams.get("state")!;
  const idToken = await signJwt(claimsFor(auth.searchParams.get("nonce")!, extra), signer, "moodle-1");
  const res = await handler(new Request(`${TOOL}/launch`, { method: "POST", headers: form, body: new URLSearchParams({ id_token: idToken, state }) }));
  return { res, state, idToken, location: new URL(res.headers.get("location") ?? `${APP}/none`) };
}

const exchange = (ticket: string, examId?: string) =>
  handler(new Request(`${TOOL}/session`, { method: "POST", body: JSON.stringify({ ticket, examId }) }));
const ticketOf = (location: URL) => new URLSearchParams(location.hash.slice(1)).get("ticket") ?? "";

describe("Moodle LTI 1.3 launch", () => {
  it("opens the mapped exam signed in as the launched Moodle user", async () => {
    const { res, location } = await launch();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe(`${APP}/lti/launch`);
    expect(location.searchParams.get("exam")).toBe("EXAM-A");
    expect(location.searchParams.get("error")).toBeNull();
    expect(mem.s.enrollments).toEqual(new Set(["EXAM-A:stu-0501"]));

    const session = await exchange(ticketOf(location), "EXAM-A");
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ tokenHash: "magic-auth-0501", examId: "EXAM-A" });
    // The ticket works once.
    expect((await exchange(ticketOf(location), "EXAM-A")).status).toBe(401);
  });

  it("signs in a different Moodle user as themselves, not as an earlier one", async () => {
    const { location } = await launch({ sub: "8", [CLAIM.ext]: { user_username: "newstudent" } });
    const body = await (await exchange(ticketOf(location))).json();
    expect(body).toEqual({ tokenHash: "magic-auth-8", examId: "EXAM-A" });
    expect(mem.s.enrollments).toEqual(new Set(["EXAM-A:stu-8"]));
  });

  it("refuses a launch that asks for a different exam than the mapped one", async () => {
    const { location } = await launch({ [CLAIM.custom]: { exam_id: "EXAM-B" } });
    expect(location.searchParams.get("error")).toBe("wrong_exam");
    expect(location.hash).toBe("");
    expect(mem.s.tickets.size).toBe(0);
    expect(mem.s.enrollments.size).toBe(0);
  });

  it("refuses to trade a launch ticket for a different exam", async () => {
    const { location } = await launch();
    const res = await exchange(ticketOf(location), "EXAM-B");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "wrong_exam" });
    // Burned: it cannot be retried for the right exam either.
    expect((await exchange(ticketOf(location), "EXAM-A")).status).toBe(401);
  });

  it("opens nothing from an activity no teacher has mapped", async () => {
    const { location } = await launch({ [CLAIM.resourceLink]: { id: "rl-new", title: "Quiz 2" } });
    expect(location.searchParams.get("error")).toBe("not_mapped");
    expect(mem.s.links.get("rl-new")?.examId).toBeNull();
    expect(mem.s.tickets.size).toBe(0);
  });

  it("shows instructors the mapping instead of signing them in", async () => {
    const { location } = await launch({ [CLAIM.roles]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"] });
    expect(location.searchParams.get("status")).toBe("instructor");
    expect(location.searchParams.get("exam")).toBe("EXAM-A");
    expect(mem.s.tickets.size).toBe(0);
  });

  it("rejects forged, replayed and mis-addressed tokens", async () => {
    expect((await launch({}, intruder.privateKey)).location.searchParams.get("error")).toBe("invalid_token");
    expect((await launch({ aud: "someone-else" })).location.searchParams.get("reason")).toBe("audience");
    expect((await launch({ [CLAIM.deploymentId]: "99" })).location.searchParams.get("reason")).toBe("deployment");

    const first = await launch();
    const replay = await handler(new Request(`${TOOL}/launch`, {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ id_token: first.idToken, state: first.state }),
    }));
    expect(new URL(replay.headers.get("location")!).searchParams.get("error")).toBe("expired_login");
  });

  it("publishes the tool's public key and never the private part", async () => {
    const res = await handler(new Request(`${TOOL}/jwks`));
    const { keys } = await res.json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "RSA", kid: "tool-1", alg: "RS256", use: "sig" });
    expect(keys[0].d).toBeUndefined();
  });
});

describe("Moodle grade passback", () => {
  const q = (id: string, answer: string, options: string[] | null) =>
    ({ id, exam_id: "EXAM-A", title: id, type: options ? "MCQ" : "Numerical", unit: null, difficulty: null, marks: 2, options, answer, subjective_mode: null });
  const pool = [q("a", "1", ["x", "y", "z"]), q("b", "2.5", null), q("c", "0", ["p", "q"])];

  it("posts the graded score to the Moodle activity the student launched from", async () => {
    await launch({ [CLAIM.ags]: { scope: [SCORE_SCOPE], lineitem: LINEITEM } });
    const grade = autoGradeAttempt(pool, [], { a: 1, b: "2.50" });
    expect(grade).toMatchObject({ score: 4, max: 6 });

    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) =>
      String(input) === platform.authTokenUrl
        ? new Response(JSON.stringify({ access_token: "moodle-access", token_type: "Bearer" }))
        : new Response(null, { status: 200 }));
    const result = await postAttemptScore(
      { store: mem.store, key: toolKey, fetch: fetchMock, now: Date.now },
      { examId: "EXAM-A", studentId: "stu-0501", score: grade.score!, max: grade.max },
    );
    expect(result).toEqual({ posted: 1, failed: 0 });

    const [tokenCall, scoreCall] = fetchMock.mock.calls;
    expect(String(tokenCall[0])).toBe(platform.authTokenUrl);
    const tokenForm = new URLSearchParams(String(tokenCall[1]!.body));
    expect(tokenForm.get("grant_type")).toBe("client_credentials");
    expect(tokenForm.get("scope")).toBe(SCORE_SCOPE);
    const assertion = tokenForm.get("client_assertion")!;
    expect(await verifyJwt(assertion, [toolKey.publicJwk])).toMatchObject({ iss: CLIENT, sub: CLIENT, aud: platform.authTokenUrl });

    expect(String(scoreCall[0])).toBe(`${ISS}/mod/lti/services.php/2/lineitems/5/lineitem/scores?type_id=1`);
    const init = scoreCall[1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer moodle-access");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/vnd.ims.lis.v1.score+json");
    expect(JSON.parse(String(init.body))).toMatchObject({
      userId: "7",
      scoreGiven: 4,
      scoreMaximum: 6,
      activityProgress: "Completed",
      gradingProgress: "FullyGraded",
    });
    expect(mem.s.posts).toEqual([{ linkId: "link-rl-1", studentId: "stu-0501", score: 4, error: null }]);
  });

  it("posts nothing for a student who did not come from Moodle or a link without grades", async () => {
    await launch();
    fetchMock.mockReset();
    const deps = { store: mem.store, key: toolKey, fetch: fetchMock, now: Date.now };
    expect(await postAttemptScore(deps, { examId: "EXAM-A", studentId: "stu-0501", score: 4, max: 6 })).toEqual({ posted: 0, failed: 0 });
    expect(await postAttemptScore(deps, { examId: "EXAM-A", studentId: "stu-other", score: 4, max: 6 })).toEqual({ posted: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records a refused score post instead of failing the submit", async () => {
    await launch({ [CLAIM.ags]: { scope: [SCORE_SCOPE], lineitem: LINEITEM } });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const result = await postAttemptScore(
      { store: mem.store, key: toolKey, fetch: fetchMock, now: Date.now },
      { examId: "EXAM-A", studentId: "stu-0501", score: 4, max: 6 },
    );
    expect(result).toEqual({ posted: 0, failed: 1 });
    expect(mem.s.posts[0].error).toBe("token 401");
    expect(decodeJwt(new URLSearchParams(String(fetchMock.mock.calls[0][1]!.body)).get("client_assertion")!)?.header.kid).toBe("tool-1");
  });
});
