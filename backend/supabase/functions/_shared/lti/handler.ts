// Moodle LTI 1.3 tool.
//
// Moodle:
//   GET|POST /login         third-party login initiation
//   POST     /launch        id_token form post; redirects the browser to the app
//   GET      /jwks          the tool's public key (Moodle "Public keyset" URL)
// Student browser:
//   POST     /session       { ticket, examId } -> { tokenHash, examId }
// Teacher (Bearer JWT of a platform teacher):
//   POST     /claim         { claim }            tie my Moodle instructor account to me
//   POST     /links         {}                   activities and waiting students in my Moodle courses
//   POST     /map           { linkId, examId }   link an activity to my exam (null unlinks)
//   POST     /link-student  { pendingId, roll }  confirm a waiting Moodle student (roll null = new student)
//   POST     /resend        { examId }           resend every graded score of my exam
//   POST     /score         { attemptId }        resend one attempt's score
// Scheduler (x-lti-cron-secret header):
//   POST     /retry                              retry queued grade posts that are due
//
// The exam always comes from the teacher's mapping of the Moodle activity.
// A Moodle user becomes a student only through an existing (issuer, sub) link,
// the university-set Moodle ID number, or a teacher's confirmation.
import { readLaunch } from "./claims.ts";
import { decodeJwt, randomToken, sha256Hex, verifyJwt, type Jwk, type ToolKey } from "./jwt.ts";
import { fetchWithTimeout, postAttemptScore, retryDueScores, type ScoreDeps, type ScoreResult } from "./scores.ts";
import type { InstructorLaunch, LaunchIdentity, Link, LtiStore, Platform } from "./types.ts";

export type LtiDeps = {
  store: LtiStore;
  key: () => Promise<ToolKey>;
  /** Public base URL of this function, e.g. https://<ref>.supabase.co/functions/v1/lti */
  toolUrl: string;
  /** Web app origin the student lands on. */
  appUrl: string;
  fetch: typeof fetch;
  now: () => number;
  /** Auth user id of the platform teacher making the request, or null. */
  teacher: (req: Request) => Promise<string | null>;
  /** Shared secret for /retry; the route is disabled when empty. */
  cronSecret?: string;
  jwksTimeoutMs?: number;
};

const LOGIN_TTL_MS = 10 * 60_000;
export const TICKET_TTL_MS = 2 * 60_000;
export const CLAIM_TTL_MS = 15 * 60_000;
const JWKS_TIMEOUT_MS = 5_000;
const ROLE_REFUSALS = new Set(["no_roles", "unsupported_role"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });

async function params(req: Request): Promise<URLSearchParams> {
  const out = new URLSearchParams(new URL(req.url).search);
  if (req.method === "POST" && (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    for (const [k, v] of new URLSearchParams(await req.text())) out.set(k, v);
  }
  return out;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A teacher may manage an activity they launched, or any activity in a
 *  Moodle course they launched something from. */
export function canManage(launches: InstructorLaunch[], link: { id: string | null; platformId: string; contextId: string | null }): boolean {
  return launches.some((l) =>
    l.platformId === link.platformId && ((!!link.id && l.linkId === link.id) || (!!link.contextId && l.contextId === link.contextId))
  );
}

export function createLtiHandler(deps: LtiDeps): (req: Request) => Promise<Response> {
  const { store } = deps;
  const app = (query: Record<string, string>) => `${deps.appUrl.replace(/\/$/, "")}/lti/launch?${new URLSearchParams(query)}`;
  const refuse = (error: string, extra: Record<string, string> = {}) => redirect(app({ error, ...extra }));
  const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

  async function platformKeys(url: string, refresh = false): Promise<Jwk[] | null> {
    const hit = jwksCache.get(url);
    if (!refresh && hit && deps.now() - hit.at < 5 * 60_000) return hit.keys;
    try {
      const res = await fetchWithTimeout(deps.fetch, url, { headers: { Accept: "application/json" } }, deps.jwksTimeoutMs ?? JWKS_TIMEOUT_MS);
      if (!res.ok) return null;
      const keys = (((await res.json()) as { keys?: Jwk[] }).keys ?? []).filter(Boolean);
      jwksCache.set(url, { at: deps.now(), keys });
      return keys;
    } catch {
      return null;
    }
  }

  async function scoreDeps(): Promise<ScoreDeps> {
    return { store, key: await deps.key(), fetch: deps.fetch, now: deps.now };
  }

  /** Existing (issuer, sub) link, else the university-set ID number. Email and
   *  username are user-editable in Moodle and are never used. */
  async function matchStudent(platform: Platform, who: LaunchIdentity): Promise<string | null> {
    const linked = await store.linkedStudent(platform.id, who.sub);
    if (linked) return linked;
    if (!who.sourcedId) return null;
    const student = await store.studentByRoll(who.sourcedId);
    if (!student) return null;
    if (await store.studentLinkedSub(platform.id, student.id)) return null;
    await store.linkStudent(platform.id, who.sub, student.id);
    return student.id;
  }

  async function login(req: Request): Promise<Response> {
    const p = await params(req);
    const iss = p.get("iss");
    const loginHint = p.get("login_hint");
    if (!iss || !loginHint) return refuse("bad_request");
    const platform = await store.findPlatform(iss, p.get("client_id"));
    if (!platform) return refuse("unknown_platform");
    const state = randomToken();
    const nonce = randomToken();
    await store.saveLogin(state, nonce, platform.id);
    const auth = new URL(platform.authLoginUrl);
    const q: Record<string, string> = {
      scope: "openid",
      response_type: "id_token",
      response_mode: "form_post",
      prompt: "none",
      client_id: platform.clientId,
      redirect_uri: `${deps.toolUrl.replace(/\/$/, "")}/launch`,
      login_hint: loginHint,
      state,
      nonce,
    };
    const hint = p.get("lti_message_hint");
    if (hint) q.lti_message_hint = hint;
    for (const [k, v] of Object.entries(q)) auth.searchParams.set(k, v);
    return redirect(auth.toString());
  }

  async function launch(req: Request): Promise<Response> {
    const p = await params(req);
    const idToken = p.get("id_token");
    const state = p.get("state");
    if (!idToken || !state) return refuse("bad_request");
    const login = await store.takeLogin(state);
    if (!login || deps.now() - login.createdAt > LOGIN_TTL_MS) return refuse("expired_login");
    const platform = await store.getPlatform(login.platformId);
    if (!platform) return refuse("unknown_platform");

    const kid = decodeJwt(idToken)?.header.kid;
    let keys = await platformKeys(platform.jwksUrl);
    if (keys && kid !== undefined && !keys.some((k) => k.kid === kid)) keys = await platformKeys(platform.jwksUrl, true);
    if (!keys) return refuse("platform_unreachable");
    const claims = await verifyJwt(idToken, keys);
    if (!claims) return refuse("invalid_token");
    const read = readLaunch(claims, platform, login.nonce, deps.now());
    if (!read.ok) return ROLE_REFUSALS.has(read.reason) ? refuse(read.reason) : refuse("invalid_token", { reason: read.reason });
    const l = read.launch;

    const link = await store.upsertLink({
      platformId: platform.id,
      deploymentId: l.deploymentId,
      resourceLinkId: l.resourceLinkId,
      contextId: l.contextId,
      contextTitle: l.identity.contextTitle,
      resourceTitle: l.resourceTitle,
    });
    const title = l.resourceTitle ?? "";

    if (l.role === "instructor") {
      await store.recordInstructorLaunch({ platformId: platform.id, sub: l.identity.sub, linkId: link.id, contextId: l.contextId });
      const claim = randomToken();
      await store.saveClaim(await sha256Hex(claim), { platformId: platform.id, sub: l.identity.sub, expiresAt: deps.now() + CLAIM_TTL_MS });
      const q: Record<string, string> = { status: "instructor", activity: title };
      if (link.examId) q.exam = link.examId;
      return redirect(`${app(q)}#claim=${encodeURIComponent(claim)}`);
    }

    if (!link.examId) return refuse("not_mapped", { activity: title });
    if (l.pinnedExamId && l.pinnedExamId !== link.examId) return refuse("wrong_exam", { activity: title });
    if (!(await store.examOpen(link.examId))) return refuse("exam_unavailable", { activity: title });

    const studentId = await matchStudent(platform, l.identity);
    if (!studentId) {
      await store.savePendingUser(platform.id, l.identity, { id: link.id, contextId: l.contextId });
      return refuse("account_pending", { activity: title });
    }
    const authUserId = await store.ensureAuthUser(studentId);
    if (!authUserId) return refuse("no_account");
    await store.enroll(link.examId, studentId);
    await store.saveGradeTarget({ linkId: link.id, studentId, examId: link.examId, sub: l.identity.sub, lineitem: l.lineitem });

    const ticket = randomToken();
    await store.createTicket(await sha256Hex(ticket), { studentId, authUserId, examId: link.examId, linkId: link.id, expiresAt: deps.now() + TICKET_TTL_MS });
    // The ticket rides in the fragment so it never reaches server logs or referrers.
    return redirect(`${app({ exam: link.examId })}#ticket=${encodeURIComponent(ticket)}`);
  }

  async function session(req: Request): Promise<Response> {
    const b = await body(req);
    const ticketValue = text(b.ticket);
    if (!ticketValue) return json({ error: "missing_ticket" }, 400);
    const ticket = await store.takeTicket(await sha256Hex(ticketValue));
    if (!ticket || ticket.expiresAt < deps.now()) return json({ error: "expired_ticket" }, 401);
    const asked = text(b.examId);
    if (asked && asked !== ticket.examId) return json({ error: "wrong_exam" }, 403);
    const tokenHash = await store.sessionTokenHash(ticket.authUserId);
    if (!tokenHash) return json({ error: "session_failed" }, 500);
    return json({ tokenHash, examId: ticket.examId });
  }

  // ── Teacher routes ──────────────────────────────────────────────────────

  async function launchesOf(teacherId: string): Promise<InstructorLaunch[]> {
    const subs = await store.teacherSubs(teacherId);
    return subs.length ? store.instructorLaunches(subs) : [];
  }

  function scopes(launches: InstructorLaunch[]): Map<string, { linkIds: string[]; contextIds: string[] }> {
    const out = new Map<string, { linkIds: string[]; contextIds: string[] }>();
    for (const l of launches) {
      const s = out.get(l.platformId) ?? { linkIds: [], contextIds: [] };
      if (!s.linkIds.includes(l.linkId)) s.linkIds.push(l.linkId);
      if (l.contextId && !s.contextIds.includes(l.contextId)) s.contextIds.push(l.contextId);
      out.set(l.platformId, s);
    }
    return out;
  }

  async function teacherRoute(route: string, req: Request, teacherId: string): Promise<Response> {
    const b = await body(req);

    if (route === "claim") {
      const value = text(b.claim);
      if (!value) return json({ error: "missing_claim" }, 400);
      const claim = await store.takeClaim(await sha256Hex(value));
      if (!claim || claim.expiresAt < deps.now()) return json({ error: "expired_claim" }, 401);
      const owner = await store.teacherForSub(claim.platformId, claim.sub);
      if (owner && owner !== teacherId) return json({ error: "claimed_by_other" }, 409);
      if (!owner) await store.linkTeacher(claim.platformId, claim.sub, teacherId);
      return json({ ok: true });
    }

    if (route === "links") {
      const launches = await launchesOf(teacherId);
      const links: Link[] = [];
      const pending = [];
      for (const [platformId, scope] of scopes(launches)) {
        links.push(...(await store.linksFor(platformId, scope)));
        pending.push(...(await store.pendingFor(platformId, scope)));
      }
      return json({ connected: launches.length > 0, links, pending });
    }

    if (route === "map") {
      const link = await store.getLink(text(b.linkId) ?? "");
      if (!link || !canManage(await launchesOf(teacherId), link)) return json({ error: "not_your_course" }, 403);
      const examId = text(b.examId);
      if (examId && !(await store.ownsExam(teacherId, examId))) return json({ error: "not_your_exam" }, 403);
      if (link.examId && link.examId !== examId && !(await store.ownsExam(teacherId, link.examId))) {
        return json({ error: "not_your_exam" }, 403);
      }
      await store.setLinkExam(link.id, examId, teacherId);
      return json({ ok: true });
    }

    if (route === "link-student") {
      const pending = await store.getPending(text(b.pendingId) ?? "");
      if (!pending || !canManage(await launchesOf(teacherId), { id: pending.linkId, platformId: pending.platformId, contextId: pending.contextId })) {
        return json({ error: "not_your_course" }, 403);
      }
      const roll = text(b.roll);
      let studentId: string;
      if (roll) {
        const s = await store.studentByRoll(roll);
        if (!s) return json({ error: "no_student" }, 404);
        studentId = s.id;
      } else {
        const newRoll = (pending.sourcedId ?? `MOODLE-${pending.sub}`).toUpperCase();
        if (await store.studentByRoll(newRoll)) return json({ error: "roll_exists", roll: newRoll }, 409);
        const created = await store.createStudent({ roll: newRoll, name: pending.name, email: pending.email, batch: pending.contextTitle });
        if (!created) return json({ error: "create_failed" }, 500);
        studentId = created.id;
      }
      const taken = await store.studentLinkedSub(pending.platformId, studentId);
      if (taken && taken !== pending.sub) return json({ error: "student_taken" }, 409);
      if (!taken) await store.linkStudent(pending.platformId, pending.sub, studentId);
      await store.deletePending(pending.id);
      return json({ ok: true, studentId });
    }

    if (route === "resend") {
      const examId = text(b.examId) ?? "";
      if (!(await store.ownsExam(teacherId, examId))) return json({ error: "not_your_exam" }, 403);
      const sd = await scoreDeps();
      const total: ScoreResult = { posted: 0, queued: 0 };
      for (const s of await store.examScores(examId)) {
        const r = await postAttemptScore(sd, { examId, studentId: s.studentId, score: s.score });
        total.posted += r.posted;
        total.queued += r.queued;
      }
      return json(total);
    }

    if (route === "score") {
      const a = await store.attemptScore(text(b.attemptId) ?? "");
      if (!a) return json({ error: "attempt_not_found" }, 404);
      if (!(await store.ownsExam(teacherId, a.examId))) return json({ error: "not_your_exam" }, 403);
      if (!a.submitted || a.score === null) return json({ posted: 0, queued: 0 });
      return json(await postAttemptScore(await scoreDeps(), { examId: a.examId, studentId: a.studentId, score: a.score }));
    }

    return json({ error: "not_found" }, 404);
  }

  const TEACHER_ROUTES = new Set(["claim", "links", "map", "link-student", "resend", "score"]);

  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    const route = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
    try {
      if (route === "login" && (req.method === "GET" || req.method === "POST")) return await login(req);
      if (route === "launch" && req.method === "POST") return await launch(req);
      if (route === "session" && req.method === "POST") return await session(req);
      if (route === "jwks" && req.method === "GET") return json({ keys: [(await deps.key()).publicJwk] });
      if (route === "retry" && req.method === "POST") {
        if (!deps.cronSecret || req.headers.get("x-lti-cron-secret") !== deps.cronSecret) return json({ error: "forbidden" }, 403);
        return json(await retryDueScores(await scoreDeps()));
      }
      if (TEACHER_ROUTES.has(route) && req.method === "POST") {
        const teacherId = await deps.teacher(req);
        if (!teacherId) return json({ error: "teachers_only" }, 401);
        return await teacherRoute(route, req, teacherId);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error("lti", route, err);
      return route === "login" || route === "launch" ? refuse("server_error") : json({ error: "server_error" }, 500);
    }
  };
}
