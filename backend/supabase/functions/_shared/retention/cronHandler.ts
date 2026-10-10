// The scheduled retention run. Only pg_cron calls it, with the shared secret in
// the x-retention-cron-secret header; there is no user session.
import type { RunSummary } from "./job.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

export function createRetentionCronHandler(deps: { secret: string; run: () => Promise<RunSummary> }) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!deps.secret) return json({ error: "not_configured" }, 503);
    if (!sameSecret(req.headers.get("x-retention-cron-secret") ?? "", deps.secret)) return json({ error: "forbidden" }, 403);
    try {
      const r = await deps.run();
      return json({ id: r.id, status: r.status, complete: r.complete, deleted: r.deleted, skipped: r.skipped, failed: r.failed });
    } catch (err) {
      console.error("[evidence-retention]", err);
      return json({ error: "server_error" }, 500);
    }
  };
}
