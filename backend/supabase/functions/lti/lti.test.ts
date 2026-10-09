// @vitest-environment node
// Moodle LTI 1.3 end to end against an in-memory store: OIDC login, signed
// launch, account matching, teacher mapping and grade passback with retry,
// using real RS256 keys.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIM, INSTRUCTOR, LEARNER, SCORE_SCOPE } from "../_shared/lti/claims.ts";
import { createLtiHandler } from "../_shared/lti/handler.ts";
import { loadToolKey, signJwt, verifyJwt, type Jwk, type ToolKey } from "../_shared/lti/jwt.ts";
import { postAttemptScore, retryDueScores } from "../_shared/lti/scores.ts";
import type { GradeTarget, InstructorLaunch, Link, LtiStore, PendingUser, Platform, Ticket } from "../_shared/lti/types.ts";
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
const form = { "content-type": "application/x-www-form-urlencoded" };

type Student = { id: string; roll: string; email: string; authId: string | null };
type Target = { linkId: string; studentId: string; examId: string; sub: string; lineitem: string | null; scoreMaximum: number | null; pendingScore: number | null; attempts: number; nextAttemptAt: number | null; lastScore: number | null };

function memoryStore(clock: () => number) {
  const s = {
    platform: { ...platform },
    logins: new Map<string, { nonce: string; platformId: string; createdAt: number }>(),
    links: new Map<string, Link & { resourceLinkId: string }>(),
    students: [
      { id: "stu-0501", roll: "21BQ1A0501", email: "asha@vignan.example", authId: "auth-0501" },
      { id: "stu-0777", roll: "21BQ1A0777", email: "ravi@vignan.example", authId: null },
    ] as Student[],
    ltiUsers: new Map<string, string>(),
    pending: new Map<string, PendingUser>(),
    enrollments: new Set<string>(),
    tickets: new Map<string, Ticket>(),
    claims: new Map<string, { platformId: string; sub: string; expiresAt: number }>(),
    ltiTeachers: new Map<string, string>(),
    instructorLaunches: [] as InstructorLaunch[],
    targets: new Map<string, Target>(),
    exams: new Map([["EXAM-A", "auth-A"], ["EXAM-B", "auth-Z"]]),
    attempts: [] as { studentId: string; examId: string; score: number }[],
  };
  const linkOut = (l: Link & { resourceLinkId: string }): Link => {
    const { resourceLinkId: _drop, ...rest } = l;
    return rest;
  };
  const inScope = (platformId: string, linkId: string | null, contextId: string | null, scope: { linkIds: string[]; contextIds: string[] }) =>
    platformId === s.platform.id && ((!!linkId && scope.linkIds.includes(linkId)) || (!!contextId && scope.contextIds.includes(contextId)));
  const target = (t: Target): GradeTarget => ({
    linkId: t.linkId, studentId: t.studentId, sub: t.sub, lineitem: t.lineitem!, scoreMaximum: t.scoreMaximum,
    pendingScore: t.pendingScore, attempts: t.attempts, platform: s.platform,
  });

  const store: LtiStore = {
    findPlatform: async (iss, clientId) => (iss === s.platform.issuer && (!clientId || clientId === s.platform.clientId) ? s.platform : null),
    getPlatform: async (id) => (id === s.platform.id ? s.platform : null),
    saveLogin: async (state, nonce, platformId) => { s.logins.set(state, { nonce, platformId, createdAt: clock() }); },
    takeLogin: async (state) => { const l = s.logins.get(state) ?? null; s.logins.delete(state); return l; },
    upsertLink: async (i) => {
      let link = s.links.get(i.resourceLinkId);
      if (!link) {
        link = { id: `link-${i.resourceLinkId}`, platformId: i.platformId, contextId: i.contextId, contextTitle: i.contextTitle, resourceTitle: i.resourceTitle, examId: null, lastLaunchAt: null, resourceLinkId: i.resourceLinkId };
        s.links.set(i.resourceLinkId, link);
      }
      return linkOut(link);
    },
    getLink: async (id) => { const l = [...s.links.values()].find((x) => x.id === id); return l ? linkOut(l) : null; },
    linksFor: async (platformId, scope) => [...s.links.values()].filter((l) => inScope(platformId, l.id, l.contextId, scope)).map(linkOut),
    setLinkExam: async (linkId, examId) => { const l = [...s.links.values()].find((x) => x.id === linkId)!; l.examId = examId; },
    examOpen: async (examId) => s.exams.has(examId),
    linkedStudent: async (_p, sub) => s.ltiUsers.get(sub) ?? null,
    studentByRoll: async (roll) => { const st = s.students.find((x) => x.roll.toLowerCase() === roll.trim().toLowerCase()); return st ? { id: st.id } : null; },
    studentLinkedSub: async (_p, studentId) => [...s.ltiUsers.entries()].find(([, id]) => id === studentId)?.[0] ?? null,
    linkStudent: async (_p, sub, studentId) => { s.ltiUsers.set(sub, studentId); },
    createStudent: async (who) => { const st = { id: `stu-${who.roll}`, roll: who.roll, email: who.email ?? "", authId: null }; s.students.push(st); return { id: st.id }; },
    ensureAuthUser: async (studentId) => { const st = s.students.find((x) => x.id === studentId); if (!st) return null; st.authId ??= `auth-${st.roll}`; return st.authId; },
    savePendingUser: async (platformId, who, link) => {
      const id = `pending-${who.sub}`;
      s.pending.set(id, { id, platformId, sub: who.sub, name: who.name, email: who.email, username: who.username, sourcedId: who.sourcedId, contextId: link.contextId, contextTitle: who.contextTitle, linkId: link.id });
    },
    pendingFor: async (platformId, scope) => [...s.pending.values()].filter((p) => inScope(platformId, p.linkId, p.contextId, scope)),
    getPending: async (id) => s.pending.get(id) ?? null,
    deletePending: async (id) => { s.pending.delete(id); },
    enroll: async (examId, studentId) => { s.enrollments.add(`${examId}:${studentId}`); },
    recordInstructorLaunch: async (l) => {
      if (!s.instructorLaunches.some((x) => x.sub === l.sub && x.linkId === l.linkId)) s.instructorLaunches.push(l);
    },
    saveClaim: async (hash, c) => { s.claims.set(hash, c); },
    takeClaim: async (hash) => { const c = s.claims.get(hash) ?? null; s.claims.delete(hash); return c; },
    teacherForSub: async (_p, sub) => s.ltiTeachers.get(sub) ?? null,
    linkTeacher: async (_p, sub, teacher) => { s.ltiTeachers.set(sub, teacher); },
    teacherSubs: async (teacher) => [...s.ltiTeachers.entries()].filter(([, t]) => t === teacher).map(([sub]) => ({ platformId: s.platform.id, sub })),
    instructorLaunches: async (subs) => s.instructorLaunches.filter((l) => subs.some((x) => x.sub === l.sub && x.platformId === l.platformId)),
    ownsExam: async (teacher, examId) => s.exams.get(examId) === teacher,
    createTicket: async (hash, t) => { s.tickets.set(hash, t); },
    takeTicket: async (hash) => { const t = s.tickets.get(hash) ?? null; s.tickets.delete(hash); return t; },
    sessionTokenHash: async (authUserId) => `magic-${authUserId}`,
    saveGradeTarget: async (t) => {
      s.targets.set(`${t.linkId}:${t.studentId}`, { ...t, scoreMaximum: null, pendingScore: null, attempts: 0, nextAttemptAt: null, lastScore: null });
    },
    gradeTargets: async (examId, studentId) => [...s.targets.values()].filter((t) => t.examId === examId && t.studentId === studentId && t.lineitem).map(target),
    setScoreMaximum: async (examId, studentId, max) => {
      for (const t of s.targets.values()) if (t.examId === examId && t.studentId === studentId) t.scoreMaximum = max;
    },
    scorePosted: async (linkId, studentId, score) => {
      Object.assign(s.targets.get(`${linkId}:${studentId}`)!, { lastScore: score, pendingScore: null, attempts: 0, nextAttemptAt: null });
    },
    scoreQueued: async (linkId, studentId, q) => {
      const t = s.targets.get(`${linkId}:${studentId}`)!;
      Object.assign(t, { pendingScore: q.score, attempts: q.attempts, nextAttemptAt: q.nextAttemptAt });
      if (q.max && q.max > 0) t.scoreMaximum = q.max;
    },
    dueScorePosts: async (nowMs, limit) =>
      [...s.targets.values()].filter((t) => t.pendingScore !== null && t.nextAttemptAt !== null && t.nextAttemptAt <= nowMs && t.lineitem).slice(0, limit).map(target),
    attemptScore: async () => null,
    examScores: async (examId) => s.attempts.filter((a) => a.examId === examId).map((a) => ({ studentId: a.studentId, score: a.score })),
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

beforeAll(async () => {
  moodle = await rsaKey();
  intruder = await rsaKey();
  moodleJwk = { ...((await crypto.subtle.exportKey("jwk", moodle.publicKey)) as Jwk), kid: "moodle-1" };
  const tool = await rsaKey();
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", tool.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  toolKey = await loadToolKey(pem, "tool-1");
});

let now: number;
const clock = () => now;
let mem: ReturnType<typeof memoryStore>;
let handler: (req: Request) => Promise<Response>;
const fetchMock = vi.fn<typeof fetch>();
const TEACHERS = new Set(["auth-A", "auth-B", "auth-C"]);

function build(extra: Partial<Parameters<typeof createLtiHandler>[0]> = {}) {
  handler = createLtiHandler({
    store: mem.store,
    key: async () => toolKey,
    toolUrl: TOOL,
    appUrl: APP,
    fetch: fetchMock,
    now: clock,
    teacher: async (req) => {
      const id = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
      return TEACHERS.has(id) ? id : null;
    },
    cronSecret: "cron-secret",
    ...extra,
  });
}

beforeEach(() => {
  now = Date.parse("2026-10-09T10:00:00Z");
  mem = memoryStore(clock);
  mem.s.links.set("rl-1", { id: "link-rl-1", platformId: "plat-1", contextId: "course-9", contextTitle: "CSE Sem III", resourceTitle: "Mid-term", examId: "EXAM-A", lastLaunchAt: null, resourceLinkId: "rl-1" });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) =>
    String(input) === platform.jwksUrl ? new Response(JSON.stringify({ keys: [moodleJwk] })) : new Response("not found", { status: 404 }));
  build();
});

function claimsFor(nonce: string, extra: Record<string, unknown>) {
  const iat = Math.floor(now / 1000);
  return {
    iss: ISS,
    aud: CLIENT,
    sub: "7",
    iat,
    exp: iat + 60,
    nonce,
    name: "Asha Rao",
    email: "someone@vignan.example",
    [CLAIM.version]: "1.3.0",
    [CLAIM.messageType]: "LtiResourceLinkRequest",
    [CLAIM.deploymentId]: "1",
    [CLAIM.resourceLink]: { id: "rl-1", title: "Mid-term (proctored)" },
    [CLAIM.context]: { id: "course-9", title: "CSE Sem III" },
    [CLAIM.roles]: [LEARNER],
    [CLAIM.lis]: { person_sourcedid: "21BQ1A0501" },
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
  const state = auth.searchParams.get("state")!;
  const idToken = await signJwt(claimsFor(auth.searchParams.get("nonce")!, extra), signer, "moodle-1");
  const res = await handler(new Request(`${TOOL}/launch`, { method: "POST", headers: form, body: new URLSearchParams({ id_token: idToken, state }) }));
  const location = new URL(res.headers.get("location") ?? `${APP}/none`);
  return { res, state, idToken, location, error: location.searchParams.get("error") };
}

const fragment = (location: URL, key: string) => new URLSearchParams(location.hash.slice(1)).get(key) ?? "";
const exchange = (ticket: string, examId?: string) =>
  handler(new Request(`${TOOL}/session`, { method: "POST", body: JSON.stringify({ ticket, examId }) }));
const asTeacher = (teacher: string, route: string, body: Record<string, unknown> = {}) =>
  handler(new Request(`${TOOL}/${route}`, { method: "POST", headers: { Authorization: `Bearer ${teacher}` }, body: JSON.stringify(body) }));

/** A Moodle instructor opens an activity; returns the one-time claim. */
async function instructorOpens(sub: string, contextId: string, resourceLinkId: string) {
  const { location } = await launch({
    sub,
    [CLAIM.roles]: [INSTRUCTOR],
    [CLAIM.context]: { id: contextId, title: contextId },
    [CLAIM.resourceLink]: { id: resourceLinkId, title: `Activity ${resourceLinkId}` },
    [CLAIM.lis]: undefined,
  });
  expect(location.searchParams.get("status")).toBe("instructor");
  return fragment(location, "claim");
}

describe("Moodle launch: signing in the right student", () => {
  it("opens the mapped exam as the student whose university ID number matches", async () => {
    const { res, location } = await launch();
    expect(res.status).toBe(302);
    expect(location.searchParams.get("exam")).toBe("EXAM-A");
    expect(mem.s.enrollments).toEqual(new Set(["EXAM-A:stu-0501"]));
    expect(mem.s.ltiUsers.get("7")).toBe("stu-0501");

    const session = await exchange(fragment(location, "ticket"), "EXAM-A");
    expect(await session.json()).toEqual({ tokenHash: "magic-auth-0501", examId: "EXAM-A" });
    expect((await exchange(fragment(location, "ticket"), "EXAM-A")).status).toBe(401);
  });

  it("does not sign in as an existing student whose email or username matches", async () => {
    const { error, location } = await launch({
      sub: "8",
      email: "asha@vignan.example",
      [CLAIM.ext]: { user_username: "21bq1a0501" },
      [CLAIM.lis]: undefined,
    });
    expect(error).toBe("account_pending");
    expect(location.hash).toBe("");
    expect(mem.s.tickets.size).toBe(0);
    expect(mem.s.enrollments.size).toBe(0);
    expect(mem.s.ltiUsers.has("8")).toBe(false);
    expect(mem.s.pending.get("pending-8")).toMatchObject({ email: "asha@vignan.example", username: "21bq1a0501", contextId: "course-9" });
  });

  it("does not take over a student already linked to another Moodle account", async () => {
    mem.s.ltiUsers.set("7", "stu-0501");
    const { error } = await launch({ sub: "99" });
    expect(error).toBe("account_pending");
    expect(mem.s.ltiUsers.get("7")).toBe("stu-0501");
  });

  it("keeps using the (issuer, sub) link once made, whatever the ID number says later", async () => {
    mem.s.ltiUsers.set("7", "stu-0777");
    const { location } = await launch({ [CLAIM.lis]: { person_sourcedid: "21BQ1A0501" } });
    expect(await (await exchange(fragment(location, "ticket"))).json()).toEqual({ tokenHash: "magic-auth-21BQ1A0777", examId: "EXAM-A" });
  });

  it("signs in a waiting student after a teacher of that course confirms them", async () => {
    await launch({ sub: "8", [CLAIM.lis]: undefined });
    await asTeacher("auth-A", "claim", { claim: await instructorOpens("t-1", "course-9", "rl-1") });
    await asTeacher("auth-B", "claim", { claim: await instructorOpens("t-2", "course-77", "rl-77") });

    expect((await asTeacher("auth-B", "link-student", { pendingId: "pending-8", roll: "21BQ1A0777" })).status).toBe(403);
    const ok = await asTeacher("auth-A", "link-student", { pendingId: "pending-8", roll: "21BQ1A0777" });
    expect(await ok.json()).toEqual({ ok: true, studentId: "stu-0777" });

    const { location } = await launch({ sub: "8", [CLAIM.lis]: undefined });
    expect(await (await exchange(fragment(location, "ticket"))).json()).toEqual({ tokenHash: "magic-auth-21BQ1A0777", examId: "EXAM-A" });
  });
});

describe("Moodle launch: refusals", () => {
  it("refuses a launch that asks for a different exam than the mapped one", async () => {
    const { error, location } = await launch({ [CLAIM.custom]: { exam_id: "EXAM-B" } });
    expect(error).toBe("wrong_exam");
    expect(location.hash).toBe("");
    expect(mem.s.tickets.size).toBe(0);
    expect(mem.s.enrollments.size).toBe(0);
  });

  it("refuses to trade a launch ticket for a different exam", async () => {
    const { location } = await launch();
    expect((await exchange(fragment(location, "ticket"), "EXAM-B")).status).toBe(403);
    expect((await exchange(fragment(location, "ticket"), "EXAM-A")).status).toBe(401);
  });

  it("opens nothing from an activity no teacher has mapped", async () => {
    const { error } = await launch({ [CLAIM.resourceLink]: { id: "rl-new", title: "Quiz 2" } });
    expect(error).toBe("not_mapped");
    expect(mem.s.tickets.size).toBe(0);
  });

  it.each([
    ["no roles at all", [], "no_roles"],
    ["only a Moodle administrator role", ["http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator"], "unsupported_role"],
    ["only the institution Student role", ["http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student"], "unsupported_role"],
    ["Learner and Instructor together", [LEARNER, INSTRUCTOR], "unsupported_role"],
  ])("refuses a launch with %s", async (_label, roles, expected) => {
    const { error } = await launch({ [CLAIM.roles]: roles });
    expect(error).toBe(expected);
    expect(mem.s.tickets.size).toBe(0);
    expect(mem.s.enrollments.size).toBe(0);
    expect(mem.s.claims.size).toBe(0);
  });

  it("rejects forged, replayed and mis-addressed tokens", async () => {
    expect((await launch({}, intruder.privateKey)).error).toBe("invalid_token");
    expect((await launch({ aud: "someone-else" })).location.searchParams.get("reason")).toBe("audience");
    expect((await launch({ [CLAIM.deploymentId]: "99" })).location.searchParams.get("reason")).toBe("deployment");
    const first = await launch();
    const replay = await handler(new Request(`${TOOL}/launch`, { method: "POST", headers: form, body: new URLSearchParams({ id_token: first.idToken, state: first.state }) }));
    expect(new URL(replay.headers.get("location")!).searchParams.get("error")).toBe("expired_login");
  });

  it("refuses every launch from a platform with no deployment ids", async () => {
    mem.s.platform.deploymentIds = [];
    expect((await launch()).location.searchParams.get("reason")).toBe("deployment");
  });

  it("gives up on a Moodle keyset that does not answer in time", async () => {
    build({ jwksTimeoutMs: 20 });
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    expect((await launch()).error).toBe("platform_unreachable");
  });

  it("publishes the tool's public key and never the private part", async () => {
    const { keys } = await (await handler(new Request(`${TOOL}/jwks`))).json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "RSA", kid: "tool-1", alg: "RS256", use: "sig" });
    expect(keys[0].d).toBeUndefined();
  });
});

describe("Moodle activity mapping", () => {
  it("lets only a teacher tied to the course see and map its activities, and only to their own exam", async () => {
    mem.s.exams.set("EXAM-OF-B", "auth-B");
    mem.s.exams.set("EXAM-OF-C", "auth-C");
    const claim = await instructorOpens("t-1", "course-9", "rl-2");
    expect(mem.s.links.get("rl-2")?.examId).toBeNull();
    expect(mem.s.tickets.size).toBe(0);

    // auth-B never launched course-9 in Moodle.
    expect(await (await asTeacher("auth-B", "links")).json()).toEqual({ connected: false, links: [], pending: [] });
    const outsider = await asTeacher("auth-B", "map", { linkId: "link-rl-2", examId: "EXAM-OF-B" });
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toEqual({ error: "not_your_course" });

    // auth-C is a Moodle instructor too, but of another course.
    await asTeacher("auth-C", "claim", { claim: await instructorOpens("t-3", "course-77", "rl-77") });
    const cLinks = (await (await asTeacher("auth-C", "links")).json()).links.map((l: Link) => l.id);
    expect(cLinks).toEqual(["link-rl-77"]);
    expect((await asTeacher("auth-C", "map", { linkId: "link-rl-2", examId: "EXAM-OF-C" })).status).toBe(403);
    expect(mem.s.links.get("rl-2")?.examId).toBeNull();

    expect((await asTeacher("auth-A", "claim", { claim })).status).toBe(200);
    const aLinks = (await (await asTeacher("auth-A", "links")).json()).links.map((l: Link) => l.id).sort();
    expect(aLinks).toEqual(["link-rl-1", "link-rl-2"]);
    expect((await asTeacher("auth-A", "map", { linkId: "link-rl-2", examId: "EXAM-B" })).status).toBe(403);
    expect((await asTeacher("auth-A", "map", { linkId: "link-rl-2", examId: "EXAM-A" })).status).toBe(200);
    expect(mem.s.links.get("rl-2")?.examId).toBe("EXAM-A");
    expect(mem.s.links.get("rl-1")?.examId).toBe("EXAM-A");
  });

  it("ties a Moodle instructor account to one teacher only, and claims work once", async () => {
    const claim = await instructorOpens("t-1", "course-9", "rl-1");
    expect((await asTeacher("auth-A", "claim", { claim })).status).toBe(200);
    expect((await asTeacher("auth-B", "claim", { claim })).status).toBe(401);
    const second = await instructorOpens("t-1", "course-9", "rl-1");
    expect((await asTeacher("auth-B", "claim", { claim: second })).status).toBe(409);
    expect((await asTeacher("not-a-teacher", "links")).status).toBe(401);
  });

  it("does not let a course colleague take an activity off another teacher's exam", async () => {
    await asTeacher("auth-A", "claim", { claim: await instructorOpens("t-1", "course-9", "rl-1") });
    await asTeacher("auth-B", "claim", { claim: await instructorOpens("t-2", "course-9", "rl-1") });
    mem.s.exams.set("EXAM-C", "auth-B");
    expect((await asTeacher("auth-B", "map", { linkId: "link-rl-1", examId: "EXAM-C" })).status).toBe(403);
    expect((await asTeacher("auth-B", "map", { linkId: "link-rl-1", examId: null })).status).toBe(403);
    expect(mem.s.links.get("rl-1")?.examId).toBe("EXAM-A");
  });
});

describe("Moodle grade passback", () => {
  const q = (id: string, answer: string, options: string[] | null) =>
    ({ id, exam_id: "EXAM-A", title: id, type: options ? "MCQ" : "Numerical", unit: null, difficulty: null, marks: 2, options, answer, subjective_mode: null });
  const pool = [q("a", "1", ["x", "y", "z"]), q("b", "2.5", null), q("c", "0", ["p", "q"])];
  const ags = { [CLAIM.ags]: { scope: [SCORE_SCOPE], lineitem: LINEITEM } };
  const deps = () => ({ store: mem.store, key: toolKey, fetch: fetchMock, now: clock });
  const moodleUp = () =>
    fetchMock.mockImplementation(async (input) =>
      String(input) === platform.authTokenUrl ? new Response(JSON.stringify({ access_token: "moodle-access" })) : new Response(null, { status: 200 }));
  const scoreBodies = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes("/scores")).map(([, init]) => JSON.parse(String(init!.body)));

  it("posts the graded score to the Moodle activity the student launched from", async () => {
    await launch(ags);
    const grade = autoGradeAttempt(pool, [], { a: 1, b: "2.50" });
    expect(grade).toMatchObject({ score: 4, max: 6 });
    fetchMock.mockReset();
    moodleUp();
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: grade.score!, max: grade.max })).toEqual({ posted: 1, queued: 0 });

    const [tokenCall, scoreCall] = fetchMock.mock.calls;
    const tokenForm = new URLSearchParams(String(tokenCall[1]!.body));
    expect(tokenForm.get("scope")).toBe(SCORE_SCOPE);
    expect(await verifyJwt(tokenForm.get("client_assertion")!, [toolKey.publicJwk])).toMatchObject({ iss: CLIENT, aud: platform.authTokenUrl });
    expect(String(scoreCall[0])).toBe(`${ISS}/mod/lti/services.php/2/lineitems/5/lineitem/scores?type_id=1`);
    expect((scoreCall[1]!.headers as Record<string, string>).Authorization).toBe("Bearer moodle-access");
    expect(scoreBodies()[0]).toMatchObject({ userId: "7", scoreGiven: 4, scoreMaximum: 6, gradingProgress: "FullyGraded" });
  });

  it("queues a failed post, retries it after the backoff and later succeeds", async () => {
    await launch(ags);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("busy", { status: 503 }));
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 4, max: 6 })).toEqual({ posted: 0, queued: 1 });
    const t = mem.s.targets.get("link-rl-1:stu-0501")!;
    expect(t).toMatchObject({ pendingScore: 4, attempts: 1, nextAttemptAt: now + 60_000, scoreMaximum: 6 });

    // Still down at the first retry: the next wait is longer.
    now += 61_000;
    expect(await retryDueScores(deps())).toEqual({ posted: 0, queued: 1 });
    expect(t).toMatchObject({ attempts: 2, nextAttemptAt: now + 5 * 60_000 });

    // Not due yet: nothing is sent.
    fetchMock.mockReset();
    moodleUp();
    now += 60_000;
    expect(await retryDueScores(deps())).toEqual({ posted: 0, queued: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    now += 5 * 60_000;
    expect(await retryDueScores(deps())).toEqual({ posted: 1, queued: 0 });
    expect(scoreBodies()).toEqual([expect.objectContaining({ userId: "7", scoreGiven: 4, scoreMaximum: 6 })]);
    expect(t).toMatchObject({ pendingScore: null, attempts: 0, nextAttemptAt: null, lastScore: 4 });
  });

  it("lets the exam's teacher resend every graded score, and nobody else", async () => {
    await launch(ags);
    mem.s.targets.get("link-rl-1:stu-0501")!.scoreMaximum = 6;
    mem.s.attempts.push({ studentId: "stu-0501", examId: "EXAM-A", score: 5 });
    fetchMock.mockReset();
    moodleUp();
    expect((await asTeacher("auth-B", "resend", { examId: "EXAM-A" })).status).toBe(403);
    expect(await (await asTeacher("auth-A", "resend", { examId: "EXAM-A" })).json()).toEqual({ posted: 1, queued: 0 });
    expect(scoreBodies()[0]).toMatchObject({ userId: "7", scoreGiven: 5, scoreMaximum: 6 });
  });

  it("runs scheduled retries only with the scheduler secret", async () => {
    const bare = await handler(new Request(`${TOOL}/retry`, { method: "POST" }));
    expect(bare.status).toBe(403);
    const ok = await handler(new Request(`${TOOL}/retry`, { method: "POST", headers: { "x-lti-cron-secret": "cron-secret" } }));
    expect(await ok.json()).toEqual({ posted: 0, queued: 0 });
  });

  it("posts nothing for a student who did not come from Moodle or a link without grades", async () => {
    await launch();
    fetchMock.mockReset();
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 4, max: 6 })).toEqual({ posted: 0, queued: 0 });
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-other", score: 4, max: 6 })).toEqual({ posted: 0, queued: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
