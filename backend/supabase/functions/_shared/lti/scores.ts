// LTI Assignment and Grade Services: post an attempt's score to every Moodle
// activity the student launched this exam from. A post that fails is queued
// and retried with backoff; nothing here ever throws into the caller.
import { SCORE_SCOPE } from "./claims.ts";
import { randomToken, signJwt, type ToolKey } from "./jwt.ts";
import type { ClaimedScore, LtiStore, Platform } from "./types.ts";

export type ScoreDeps = { store: LtiStore; key: ToolKey; fetch: typeof fetch; now: () => number };
export type ScoreResult = { posted: number; queued: number };

/** Minutes to wait after the 1st, 2nd, … failure; the last step repeats. */
export const RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720, 1440];
/** After this many failures the score stays queued for a teacher resend only. */
export const MAX_POST_ATTEMPTS = 12;
const HTTP_TIMEOUT_MS = 10_000;
/** How long a sender holds a claimed row; must outlast one batch of posts. */
export const CLAIM_LEASE_MS = 10 * 60_000;

export function nextAttemptAt(attempts: number, nowMs: number): number | null {
  if (attempts >= MAX_POST_ATTEMPTS) return null;
  return nowMs + RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1] * 60_000;
}

/** `<lineitem>/scores`, keeping any query string Moodle put on the line item. */
export function scoresUrl(lineitem: string): string {
  const u = new URL(lineitem);
  u.pathname = u.pathname.replace(/\/?$/, "/scores");
  return u.toString();
}

/** fetch with a deadline, so a hung Moodle never holds a worker. */
export async function fetchWithTimeout(f: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new Error("timeout")); }, ms);
  });
  try {
    return await Promise.race([f(url, { ...init, signal: ctl.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken(platform: Platform, deps: ScoreDeps): Promise<string> {
  const iat = Math.floor(deps.now() / 1000);
  const assertion = await signJwt(
    { iss: platform.clientId, sub: platform.clientId, aud: platform.authTokenUrl, iat, exp: iat + 300, jti: randomToken(16) },
    deps.key.privateKey,
    deps.key.kid,
  );
  const res = await fetchWithTimeout(deps.fetch, platform.authTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      scope: SCORE_SCOPE,
    }).toString(),
  }, HTTP_TIMEOUT_MS);
  if (!res.ok) throw new Error(`token ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("token missing");
  return body.access_token;
}

async function postClaimed(deps: ScoreDeps, claimed: ClaimedScore[]): Promise<ScoreResult> {
  const tokens = new Map<string, Promise<string>>();
  const out: ScoreResult = { posted: 0, queued: 0 };
  for (const t of claimed) {
    const { pendingScore: score, scoreMaximum: max } = t;
    try {
      if (!t.clear && (!max || max <= 0)) throw new Error("no score maximum");
      if (!tokens.has(t.platform.id)) tokens.set(t.platform.id, accessToken(t.platform, deps));
      const token = await tokens.get(t.platform.id)!;
      const timestamp = new Date(deps.now()).toISOString();
      // No scoreGiven and a progress short of FullyGraded clears Moodle's grade.
      const body = t.clear
        ? { userId: t.sub, activityProgress: "Completed", gradingProgress: "PendingManual", timestamp }
        : {
          userId: t.sub,
          scoreGiven: Math.min(max!, Math.max(0, score)),
          scoreMaximum: max,
          activityProgress: "Completed",
          gradingProgress: "FullyGraded",
          timestamp,
        };
      const res = await fetchWithTimeout(deps.fetch, scoresUrl(t.lineitem), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.ims.lis.v1.score+json" },
        body: JSON.stringify(body),
      }, HTTP_TIMEOUT_MS);
      if (!res.ok) throw new Error(`scores ${res.status}`);
      out.posted += 1;
      await deps.store.finishScore(t, { ok: true }, deps.now()).catch(() => {});
    } catch (err) {
      out.queued += 1;
      const attempts = t.attempts + 1;
      await deps.store
        .finishScore(t, {
          ok: false,
          error: String((err as Error)?.message ?? err),
          attempts,
          nextAttemptAt: nextAttemptAt(attempts, deps.now()),
        }, deps.now())
        .catch(() => {});
    }
  }
  return out;
}

/** Post a freshly graded score. It is queued first, then sent only on links no
 *  other sender holds; a held link sends it after the current post finishes.
 *  `max` falls back to the maximum recorded at submit. */
export async function postAttemptScore(
  deps: ScoreDeps,
  input: { examId: string; studentId: string; score: number; max?: number | null },
): Promise<ScoreResult> {
  const queued = await deps.store
    .queueScore(input.examId, input.studentId, { score: input.score, max: input.max ?? null, nowMs: deps.now() })
    .catch(() => 0);
  if (!queued) return { posted: 0, queued: 0 };
  const claimed = await deps.store
    .claimScores(deps.now(), { limit: queued, leaseMs: CLAIM_LEASE_MS, examId: input.examId, studentId: input.studentId })
    .catch(() => [] as ClaimedScore[]);
  const r = await postClaimed(deps, claimed);
  return { posted: r.posted, queued: queued - r.posted };
}

/** Retry queued posts whose backoff has elapsed. */
export async function retryDueScores(deps: ScoreDeps, limit = 25): Promise<ScoreResult> {
  const claimed = await deps.store.claimScores(deps.now(), { limit, leaseMs: CLAIM_LEASE_MS }).catch(() => [] as ClaimedScore[]);
  return postClaimed(deps, claimed);
}
