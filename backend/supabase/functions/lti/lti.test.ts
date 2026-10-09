// @vitest-environment node
// Moodle LTI 1.3 end to end against an in-memory store: OIDC login, signed
// launch, account matching, teacher mapping and grade passback with retry,
// using real RS256 keys.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIM, INSTRUCTOR, LEARNER, SCORE_SCOPE } from "../_shared/lti/claims.ts";
import { createLtiHandler, sameSecret } from "../_shared/lti/handler.ts";
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
type Target = {
  linkId: string; studentId: string; examId: string; sub: string; lineitem: string | null; scoreMaximum: number | null;
  pendingScore: number | null; attempts: number; nextAttemptAt: number | null; lastScore: number | null; claim: string | null; claimedUntil: number | null;
  clearPending?: boolean; cleared?: boolean;
};

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
    holds: new Set<string>(),
  };
  const held = (t: Target) => s.holds.has(`${t.examId}:${t.studentId}`);
  /** Same rules as set_result_hold. */
  const setHold = (examId: string, studentId: string, on: boolean) => {
    if (on) s.holds.add(`${examId}:${studentId}`);
    else s.holds.delete(`${examId}:${studentId}`);
    for (const t of s.targets.values()) {
      if (t.examId !== examId || t.studentId !== studentId || !t.lineitem) continue;
      if (on && t.lastScore !== null && !t.cleared) {
        Object.assign(t, { pendingScore: t.pendingScore ?? t.lastScore, clearPending: true, attempts: 0, nextAttemptAt: clock() });
      } else if (!on && t.pendingScore !== null) {
        Object.assign(t, { clearPending: false, attempts: 0, nextAttemptAt: clock() });
      }
    }
  };
  const linkOut = (l: Link & { resourceLinkId: string }): Link => {
    const { resourceLinkId: _drop, ...rest } = l;
    return rest;
  };
  const inScope = (platformId: string, linkId: string | null, contextId: string | null, scope: { linkIds: string[]; contextIds: string[] }) =>
    platformId === s.platform.id && ((!!linkId && scope.linkIds.includes(linkId)) || (!!contextId && scope.contextIds.includes(contextId)));
  let claimSeq = 0;
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
    ensureAuthUser: async (studentId) => {
      const st = s.students.find((x) => x.id === studentId);
      if (!st) return { error: "no_account" };
      st.authId ??= `auth-${st.roll}`;
      return { authUserId: st.authId };
    },
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
      s.targets.set(`${t.linkId}:${t.studentId}`, { ...t, scoreMaximum: null, pendingScore: null, attempts: 0, nextAttemptAt: null, lastScore: null, claim: null, claimedUntil: null });
    },
    setScoreMaximum: async (examId, studentId, max) => {
      for (const t of s.targets.values()) if (t.examId === examId && t.studentId === studentId) t.scoreMaximum = max;
    },
    // Same rules as lti_claim_scores / lti_finish_score.
    queueScore: async (examId, studentId, q) => {
      let n = 0;
      for (const t of s.targets.values()) {
        if (t.examId !== examId || t.studentId !== studentId || !t.lineitem) continue;
        Object.assign(t, { pendingScore: q.score, attempts: 0, nextAttemptAt: q.nowMs });
        if (q.max && q.max > 0) t.scoreMaximum = q.max;
        n += 1;
      }
      return n;
    },
    claimScores: async (nowMs, o) =>
      [...s.targets.values()]
        .filter((t) => t.pendingScore !== null && t.lineitem && t.nextAttemptAt !== null && t.nextAttemptAt <= nowMs
          && (t.claimedUntil === null || t.claimedUntil < nowMs)
          && (!o.examId || (t.examId === o.examId && t.studentId === o.studentId))
          && (t.clearPending || !held(t)))
        .sort((a, b) => a.nextAttemptAt! - b.nextAttemptAt!)
        .slice(0, o.limit)
        .map((t) => {
          t.claim = `claim-${++claimSeq}`;
          t.claimedUntil = nowMs + o.leaseMs;
          return { ...target(t), pendingScore: t.pendingScore!, claim: t.claim, clear: held(t) };
        }),
    finishScore: async (c, outcome, nowMs) => {
      const t = s.targets.get(`${c.linkId}:${c.studentId}`);
      if (!t || t.claim !== c.claim) return;
      const same = t.pendingScore === c.pendingScore;
      if (c.clear) {
        if (outcome.ok) Object.assign(t, { cleared: true, clearPending: false, attempts: 0, nextAttemptAt: nowMs });
        else if (held(t)) Object.assign(t, { attempts: outcome.attempts, nextAttemptAt: outcome.nextAttemptAt });
        else Object.assign(t, { attempts: 0, nextAttemptAt: nowMs });
      } else if (outcome.ok && held(t)) {
        Object.assign(t, { lastScore: c.pendingScore, pendingScore: t.pendingScore ?? c.pendingScore, cleared: false, clearPending: true, attempts: 0, nextAttemptAt: nowMs });
      } else if (outcome.ok) {
        Object.assign(t, { lastScore: c.pendingScore, cleared: false });
        if (same) Object.assign(t, { pendingScore: null, attempts: 0, nextAttemptAt: null });
      } else if (same) {
        Object.assign(t, { attempts: outcome.attempts, nextAttemptAt: outcome.nextAttemptAt });
      }
      Object.assign(t, { claim: null, claimedUntil: null });
    },
    attemptScore: async () => null,
    examScores: async (examId) => s.attempts.filter((a) => a.examId === examId).map((a) => ({ studentId: a.studentId, score: a.score })),
  };
  return { s, store, setHold };
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

  it("refuses to sign in through an auth account that is not a student account", async () => {
    mem.store.ensureAuthUser = async () => ({ error: "not_student_account" });
    const { error, location } = await launch();
    expect(error).toBe("not_student_account");
    expect(location.hash).toBe("");
    expect(mem.s.tickets.size).toBe(0);
    expect(mem.s.enrollments.size).toBe(0);
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

  /** Moodle that holds every score post until `release()` is called. */
  function slowMoodle(status = 200) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === platform.authTokenUrl) return new Response(JSON.stringify({ access_token: "moodle-access" }));
      await gate;
      return new Response(null, { status });
    });
    return () => release();
  }
  const scorePostsStarted = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("/scores")).length;
  async function until(cond: () => boolean) {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
    expect(cond()).toBe(true);
  }
  async function queueFailedScore(score: number) {
    await launch(ags);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("busy", { status: 503 }));
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score, max: 6 })).toEqual({ posted: 0, queued: 1 });
    now += 61_000;
    return mem.s.targets.get("link-rl-1:stu-0501")!;
  }

  it("posts a queued score once when the scheduler, a submit and a teacher's resend race", async () => {
    await queueFailedScore(4);
    mem.s.attempts.push({ studentId: "stu-0501", examId: "EXAM-A", score: 4 });
    const release = slowMoodle();

    const cronA = retryDueScores(deps());
    const cronB = retryDueScores(deps());
    await until(() => scorePostsStarted() === 1);
    // While that post is in flight, both of these find the row held and leave it queued.
    expect(await (await asTeacher("auth-A", "resend", { examId: "EXAM-A" })).json()).toEqual({ posted: 0, queued: 1 });
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 4, max: 6 })).toEqual({ posted: 0, queued: 1 });
    release();

    const results = await Promise.all([cronA, cronB]);
    expect(results.reduce((n, r) => n + r.posted, 0)).toBe(1);
    expect(scoreBodies()).toEqual([expect.objectContaining({ scoreGiven: 4 })]);
    expect(mem.s.targets.get("link-rl-1:stu-0501")).toMatchObject({ pendingScore: null, lastScore: 4, claim: null });
    expect(await retryDueScores(deps())).toEqual({ posted: 0, queued: 0 });
    expect(scorePostsStarted()).toBe(1);
  });

  it("never lets a slow retry clear or overwrite a newer score", async () => {
    const t = await queueFailedScore(4);
    const release = slowMoodle();

    const staleRetry = retryDueScores(deps());
    await until(() => scorePostsStarted() === 1);
    // A regrade lands while the old score is still on its way to Moodle.
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 5, max: 6 })).toEqual({ posted: 0, queued: 1 });
    expect(scorePostsStarted()).toBe(1);
    release();
    expect(await staleRetry).toEqual({ posted: 1, queued: 0 });
    expect(t).toMatchObject({ pendingScore: 5, nextAttemptAt: now, claim: null });

    expect(await retryDueScores(deps())).toEqual({ posted: 1, queued: 0 });
    expect(scoreBodies().map((b) => b.scoreGiven)).toEqual([4, 5]);
    expect(t).toMatchObject({ pendingScore: null, lastScore: 5 });
  });

  it("keeps a newer score's schedule when an older retry fails", async () => {
    const t = await queueFailedScore(4);
    const release = slowMoodle(503);

    const staleRetry = retryDueScores(deps());
    await until(() => scorePostsStarted() === 1);
    await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 5, max: 6 });
    release();
    await staleRetry;
    expect(t).toMatchObject({ pendingScore: 5, attempts: 0, nextAttemptAt: now, claim: null });
  });

  it("lets another sender take over a claim whose sender died, and ignores the dead sender", async () => {
    const t = await queueFailedScore(4);
    const [abandoned] = await mem.store.claimScores(now, { limit: 5, leaseMs: 60_000 });
    expect(await retryDueScores(deps())).toEqual({ posted: 0, queued: 0 });

    now += 61_000;
    fetchMock.mockReset();
    moodleUp();
    expect(await retryDueScores(deps())).toEqual({ posted: 1, queued: 0 });
    await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 6, max: 6 });
    t.claim = "held-by-someone-else";
    await mem.store.finishScore(abandoned, { ok: true }, now);
    expect(t).toMatchObject({ lastScore: 6, claim: "held-by-someone-else" });
  });

  it("clears a posted grade in Moodle while the result is held, then posts the real score on release", async () => {
    await launch(ags);
    fetchMock.mockReset();
    moodleUp();
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 4, max: 6 })).toEqual({ posted: 1, queued: 0 });
    const t = mem.s.targets.get("link-rl-1:stu-0501")!;

    mem.setHold("EXAM-A", "stu-0501", true);
    expect(await retryDueScores(deps())).toEqual({ posted: 1, queued: 0 });
    const cleared = scoreBodies()[1];
    expect(cleared).toMatchObject({ userId: "7", activityProgress: "Completed", gradingProgress: "PendingManual" });
    expect(cleared).not.toHaveProperty("scoreGiven");
    expect(t).toMatchObject({ cleared: true, clearPending: false, pendingScore: 4, lastScore: 4 });

    // Held and already cleared: a regrade waits, nothing more is sent.
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 5, max: 6 })).toEqual({ posted: 0, queued: 1 });
    expect(await retryDueScores(deps())).toEqual({ posted: 0, queued: 0 });
    expect(scoreBodies()).toHaveLength(2);

    mem.setHold("EXAM-A", "stu-0501", false);
    expect(await retryDueScores(deps())).toEqual({ posted: 1, queued: 0 });
    expect(scoreBodies()[2]).toMatchObject({ scoreGiven: 5, scoreMaximum: 6, gradingProgress: "FullyGraded" });
    expect(t).toMatchObject({ cleared: false, pendingScore: null, lastScore: 5 });
  });

  it("clears the grade again when a hold lands while the score is on its way to Moodle", async () => {
    await launch(ags);
    const release = slowMoodle();
    const post = postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 4, max: 6 });
    await until(() => scorePostsStarted() === 1);
    mem.setHold("EXAM-A", "stu-0501", true);
    release();
    expect(await post).toEqual({ posted: 1, queued: 0 });
    expect(await retryDueScores(deps())).toEqual({ posted: 1, queued: 0 });
    expect(scoreBodies()[1]).toMatchObject({ gradingProgress: "PendingManual" });
    expect(mem.s.targets.get("link-rl-1:stu-0501")).toMatchObject({ cleared: true, pendingScore: 4 });
  });

  it("does not clear anything in Moodle for a held score that was never posted", async () => {
    await launch(ags);
    mem.setHold("EXAM-A", "stu-0501", true);
    fetchMock.mockReset();
    moodleUp();
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 4, max: 6 })).toEqual({ posted: 0, queued: 1 });
    expect(await retryDueScores(deps())).toEqual({ posted: 0, queued: 0 });
    expect(scoreBodies()).toEqual([]);
  });

  it("runs scheduled retries only with the scheduler secret", async () => {
    const retry = (secret?: string) =>
      handler(new Request(`${TOOL}/retry`, { method: "POST", headers: secret === undefined ? {} : { "x-lti-cron-secret": secret } }));
    expect((await retry()).status).toBe(403);
    expect((await retry("cron-secreT")).status).toBe(403);
    expect((await retry("cron-")).status).toBe(403);
    expect((await retry("cron-secret-and-more")).status).toBe(403);
    expect(await (await retry("cron-secret")).json()).toEqual({ posted: 0, queued: 0 });
    build({ cronSecret: "" });
    expect((await retry("")).status).toBe(403);
  });

  it("compares secrets without depending on where they differ", async () => {
    expect(await sameSecret("cron-secret", "cron-secret")).toBe(true);
    expect(await sameSecret("cron-secreT", "cron-secret")).toBe(false);
    expect(await sameSecret("", "cron-secret")).toBe(false);
    expect(await sameSecret("cron-secret\0", "cron-secret")).toBe(false);
  });

  it("posts nothing for a student who did not come from Moodle or a link without grades", async () => {
    await launch();
    fetchMock.mockReset();
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-0501", score: 4, max: 6 })).toEqual({ posted: 0, queued: 0 });
    expect(await postAttemptScore(deps(), { examId: "EXAM-A", studentId: "stu-other", score: 4, max: 6 })).toEqual({ posted: 0, queued: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
