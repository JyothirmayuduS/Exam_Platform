// LTI Assignment and Grade Services: post an attempt's score to every Moodle
// activity the student launched this exam from.
import { SCORE_SCOPE } from "./claims.ts";
import { randomToken, signJwt, type ToolKey } from "./jwt.ts";
import type { LtiStore, Platform } from "./types.ts";

export type ScoreDeps = { store: LtiStore; key: ToolKey; fetch: typeof fetch; now: () => number };

/** `<lineitem>/scores`, keeping any query string Moodle put on the line item. */
export function scoresUrl(lineitem: string): string {
  const u = new URL(lineitem);
  u.pathname = u.pathname.replace(/\/?$/, "/scores");
  return u.toString();
}

async function accessToken(platform: Platform, deps: ScoreDeps): Promise<string> {
  const iat = Math.floor(deps.now() / 1000);
  const assertion = await signJwt(
    { iss: platform.clientId, sub: platform.clientId, aud: platform.authTokenUrl, iat, exp: iat + 300, jti: randomToken(16) },
    deps.key.privateKey,
    deps.key.kid,
  );
  const res = await deps.fetch(platform.authTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      scope: SCORE_SCOPE,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("token missing");
  return body.access_token;
}

/** Post a graded score. `max` falls back to the maximum recorded at submit.
 *  Never throws: failures are recorded per activity and counted. */
export async function postAttemptScore(
  deps: ScoreDeps,
  input: { examId: string; studentId: string; score: number; max?: number | null },
): Promise<{ posted: number; failed: number }> {
  const targets = await deps.store.gradeTargets(input.examId, input.studentId).catch(() => []);
  const tokens = new Map<string, Promise<string>>();
  let posted = 0;
  let failed = 0;
  for (const t of targets) {
    const max = input.max ?? t.scoreMaximum;
    try {
      if (!max || max <= 0) throw new Error("no score maximum");
      if (!tokens.has(t.platform.id)) tokens.set(t.platform.id, accessToken(t.platform, deps));
      const token = await tokens.get(t.platform.id)!;
      const res = await deps.fetch(scoresUrl(t.lineitem), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/vnd.ims.lis.v1.score+json" },
        body: JSON.stringify({
          userId: t.sub,
          scoreGiven: Math.min(max, Math.max(0, input.score)),
          scoreMaximum: max,
          activityProgress: "Completed",
          gradingProgress: "FullyGraded",
          timestamp: new Date(deps.now()).toISOString(),
        }),
      });
      if (!res.ok) throw new Error(`scores ${res.status}`);
      posted += 1;
      await deps.store.recordScorePost(t.linkId, input.studentId, { score: input.score, error: null }).catch(() => {});
    } catch (err) {
      failed += 1;
      await deps.store
        .recordScorePost(t.linkId, input.studentId, { score: input.score, error: String((err as Error)?.message ?? err) })
        .catch(() => {});
    }
  }
  return { posted, failed };
}
