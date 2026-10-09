// LTI Assignment and Grade Services: post an attempt's score to every Moodle
// activity the student launched this exam from. A post that fails is queued
// and retried with backoff; nothing here ever throws into the caller.
import { SCORE_SCOPE } from "./claims.ts";
import { randomToken, signJwt, type ToolKey } from "./jwt.ts";
import type { GradeTarget, LtiStore, Platform } from "./types.ts";

export type ScoreDeps = { store: LtiStore; key: ToolKey; fetch: typeof fetch; now: () => number };
export type ScoreResult = { posted: number; queued: number };

/** Minutes to wait after the 1st, 2nd, … failure; the last step repeats. */
export const RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720, 1440];
/** After this many failures the score stays queued for a teacher resend only. */
export const MAX_POST_ATTEMPTS = 12;
const HTTP_TIMEOUT_MS = 10_000;

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

async function postTargets(
  deps: ScoreDeps,
  items: { target: GradeTarget; score: number; max: number | null; priorAttempts: number }[],
): Promise<ScoreResult> {
  const tokens = new Map<string, Promise<string>>();
  const out: ScoreResult = { posted: 0, queued: 0 };
  for (const { target: t, score, max, priorAttempts } of items) {
    try {
      if (!max || max <= 0) throw new Error("no score maximum");
      if (!tokens.has(t.platform.id)) tokens.set(t.platform.id, accessToken(t.platform, deps));
      const token = await tokens.get(t.platform.id)!;
      const res = await fetchWithTimeout(deps.fetch, scoresUrl(t.lineitem), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.ims.lis.v1.score+json" },
        body: JSON.stringify({
          userId: t.sub,
          scoreGiven: Math.min(max, Math.max(0, score)),
          scoreMaximum: max,
          activityProgress: "Completed",
          gradingProgress: "FullyGraded",
          timestamp: new Date(deps.now()).toISOString(),
        }),
      }, HTTP_TIMEOUT_MS);
      if (!res.ok) throw new Error(`scores ${res.status}`);
      out.posted += 1;
      await deps.store.scorePosted(t.linkId, t.studentId, score).catch(() => {});
    } catch (err) {
      out.queued += 1;
      const attempts = priorAttempts + 1;
      await deps.store
        .scoreQueued(t.linkId, t.studentId, {
          score,
          max: max ?? null,
          error: String((err as Error)?.message ?? err),
          attempts,
          nextAttemptAt: nextAttemptAt(attempts, deps.now()),
        })
        .catch(() => {});
    }
  }
  return out;
}

/** Post a freshly graded score. `max` falls back to the maximum recorded at submit. */
export async function postAttemptScore(
  deps: ScoreDeps,
  input: { examId: string; studentId: string; score: number; max?: number | null },
): Promise<ScoreResult> {
  const targets = await deps.store.gradeTargets(input.examId, input.studentId).catch(() => [] as GradeTarget[]);
  return postTargets(deps, targets.map((t) => ({ target: t, score: input.score, max: input.max ?? t.scoreMaximum, priorAttempts: 0 })));
}

/** Retry queued posts whose backoff has elapsed. */
export async function retryDueScores(deps: ScoreDeps, limit = 25): Promise<ScoreResult> {
  const due = await deps.store.dueScorePosts(deps.now(), limit).catch(() => [] as GradeTarget[]);
  return postTargets(
    deps,
    due.filter((t) => t.pendingScore !== null).map((t) => ({ target: t, score: t.pendingScore!, max: t.scoreMaximum, priorAttempts: t.attempts })),
  );
}
