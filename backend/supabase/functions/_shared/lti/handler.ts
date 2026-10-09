// Moodle LTI 1.3 tool: OIDC login, resource-link launch, public key set and
// the one-time ticket the browser trades for a Supabase session.
//
//   GET|POST /login    third-party login initiation from Moodle
//   POST     /launch   id_token form post; redirects the browser to the app
//   GET      /jwks     the tool's public key (Moodle "Public keyset" URL)
//   POST     /session  { ticket, examId } -> { tokenHash, examId }
//
// The exam always comes from the teacher's mapping of the Moodle activity.
// Nothing in the launch or the browser URL can pick a different one.
import { readLaunch } from "./claims.ts";
import { decodeJwt, randomToken, sha256Hex, verifyJwt, type Jwk, type ToolKey } from "./jwt.ts";
import type { LtiStore } from "./types.ts";

export type LtiDeps = {
  store: LtiStore;
  key: () => Promise<ToolKey>;
  /** Public base URL of this function, e.g. https://<ref>.supabase.co/functions/v1/lti */
  toolUrl: string;
  /** Web app origin the student lands on. */
  appUrl: string;
  fetch: typeof fetch;
  now: () => number;
};

const LOGIN_TTL_MS = 10 * 60_000;
export const TICKET_TTL_MS = 2 * 60_000;

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

export function createLtiHandler(deps: LtiDeps): (req: Request) => Promise<Response> {
  const app = (query: Record<string, string>) => `${deps.appUrl.replace(/\/$/, "")}/lti/launch?${new URLSearchParams(query)}`;
  const refuse = (error: string, extra: Record<string, string> = {}) => redirect(app({ error, ...extra }));
  const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

  async function platformKeys(url: string, refresh = false): Promise<Jwk[]> {
    const hit = jwksCache.get(url);
    if (!refresh && hit && deps.now() - hit.at < 5 * 60_000) return hit.keys;
    const res = await deps.fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const keys = (((await res.json()) as { keys?: Jwk[] }).keys ?? []).filter(Boolean);
    jwksCache.set(url, { at: deps.now(), keys });
    return keys;
  }

  async function login(req: Request): Promise<Response> {
    const p = await params(req);
    const iss = p.get("iss");
    const loginHint = p.get("login_hint");
    if (!iss || !loginHint) return refuse("bad_request");
    const platform = await deps.store.findPlatform(iss, p.get("client_id"));
    if (!platform) return refuse("unknown_platform");
    const state = randomToken();
    const nonce = randomToken();
    await deps.store.saveLogin(state, nonce, platform.id);
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
    const login = await deps.store.takeLogin(state);
    if (!login || deps.now() - login.createdAt > LOGIN_TTL_MS) return refuse("expired_login");
    const platform = await deps.store.getPlatform(login.platformId);
    if (!platform) return refuse("unknown_platform");

    const kid = decodeJwt(idToken)?.header.kid;
    let keys = await platformKeys(platform.jwksUrl);
    if (kid !== undefined && !keys.some((k) => k.kid === kid)) keys = await platformKeys(platform.jwksUrl, true);
    const claims = await verifyJwt(idToken, keys);
    if (!claims) return refuse("invalid_token");
    const read = readLaunch(claims, platform, login.nonce, deps.now());
    if (!read.ok) return refuse("invalid_token", { reason: read.reason });
    const l = read.launch;

    const link = await deps.store.upsertLink({
      platformId: platform.id,
      deploymentId: l.deploymentId,
      resourceLinkId: l.resourceLinkId,
      contextId: l.contextId,
      contextTitle: l.identity.contextTitle,
      resourceTitle: l.resourceTitle,
    });
    const title = l.resourceTitle ?? "";
    if (l.staffOnly) return redirect(app({ status: "instructor", activity: title, ...(link.examId ? { exam: link.examId } : {}) }));
    if (!link.examId) return refuse("not_mapped", { activity: title });
    if (l.pinnedExamId && l.pinnedExamId !== link.examId) return refuse("wrong_exam", { activity: title });
    if (!(await deps.store.examOpen(link.examId))) return refuse("exam_unavailable", { activity: title });

    const who = await deps.store.resolveStudent(platform, l.identity);
    if (!who) return refuse("no_account");
    await deps.store.enroll(link.examId, who.studentId);
    await deps.store.saveGradeTarget({ linkId: link.id, studentId: who.studentId, examId: link.examId, sub: l.identity.sub, lineitem: l.lineitem });

    const ticket = randomToken();
    await deps.store.createTicket(await sha256Hex(ticket), {
      studentId: who.studentId,
      authUserId: who.authUserId,
      examId: link.examId,
      linkId: link.id,
      expiresAt: deps.now() + TICKET_TTL_MS,
    });
    // The ticket rides in the fragment so it never reaches server logs or referrers.
    return redirect(`${app({ exam: link.examId })}#ticket=${encodeURIComponent(ticket)}`);
  }

  async function session(req: Request): Promise<Response> {
    let body: { ticket?: unknown; examId?: unknown };
    try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
    const ticketValue = typeof body.ticket === "string" ? body.ticket : "";
    if (!ticketValue) return json({ error: "missing_ticket" }, 400);
    const ticket = await deps.store.takeTicket(await sha256Hex(ticketValue));
    if (!ticket || ticket.expiresAt < deps.now()) return json({ error: "expired_ticket" }, 401);
    if (typeof body.examId === "string" && body.examId && body.examId !== ticket.examId) {
      return json({ error: "wrong_exam" }, 403);
    }
    const tokenHash = await deps.store.sessionTokenHash(ticket.authUserId);
    if (!tokenHash) return json({ error: "session_failed" }, 500);
    return json({ tokenHash, examId: ticket.examId });
  }

  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
    try {
      if (route === "login" && (req.method === "GET" || req.method === "POST")) return await login(req);
      if (route === "launch" && req.method === "POST") return await launch(req);
      if (route === "session" && req.method === "POST") return await session(req);
      if (route === "jwks" && req.method === "GET") {
        const key = await deps.key();
        return json({ keys: [key.publicJwk] });
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      console.error("lti", route, err);
      return route === "session" || route === "jwks" ? json({ error: "server_error" }, 500) : refuse("server_error");
    }
  };
}
