// Supabase Edge Function: r2-retention
// ─────────────────────────────────────────────────────────────────────────────
// Enforces the 3-month (90-day) auto-delete policy on Cloudflare R2 exam
// artifacts (recordings, per-second screenshots, violation frames, AI evidence,
// PDF reports). Staff-gated: only a signed-in teacher/proctor may call it.
//
// Why lifecycle rules instead of a cron: R2 applies expiration automatically
// from each object's LastModified — nothing has to run daily, nothing depends
// on a scheduler, and no secret ever lives in Postgres.
//
// Ops:  { op: "ensure" }  → idempotently PUT the 90-day lifecycle rule
//   optionally  { op: "cleanup" } → immediately delete objects already past
//   the cutoff (useful right after enabling, or for buckets with pre-existing
//   objects older than 90 days).
//
// Secrets (server-side only):
//   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_BUCKET
//   RETENTION_DAYS (optional, default 90)
//
// Deploy WITH JWT verification:
//   supabase functions deploy r2-retention

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const RULE_ID = "exam-artifacts-retention";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const endpoint = (Deno.env.get("R2_S3_ENDPOINT") ?? "").replace(/\/+$/, "");
  const bucket = Deno.env.get("R2_BUCKET") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    return json({ error: "R2 secrets not configured" }, 500);
  }
  if (!supabaseUrl || !anonKey) return json({ error: "Supabase env not configured" }, 500);

  // Staff-only gate: a signed-in teacher/proctor account must call this.
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "missing bearer token" }, 401);
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !userData?.user) return json({ error: "unauthorized" }, 401);
  const { data: staff } = await supabase.from("teachers").select("id").eq("auth_id", userData.user.id).maybeSingle();
  if (!staff) return json({ error: "staff only" }, 403);

  const days = Math.max(1, Math.min(3650, Number(Deno.env.get("RETENTION_DAYS") ?? 90)));
  const body = await req.json().catch(() => ({}));
  const op = String((body as { op?: string }).op ?? "ensure");

  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });

  if (op === "ensure") {
    // Check whether the rule already exists with the same retention.
    try {
      const existingReq = await aws.sign(new Request(`${endpoint}/${bucket}?lifecycle`, { method: "GET" }));
      const existing = await fetch(existingReq);
      if (existing.ok) {
        const xml = await existing.text();
        const re = new RegExp(`<ID>${RULE_ID}</ID>[\\s\\S]*?<Days>(\\d+)</Days>`);
        const m = xml.match(re);
        if (m && Number(m[1]) === days) {
          return json({ ok: true, rule: RULE_ID, days, alreadyConfigured: true });
        }
      }
    } catch (err) {
      console.warn("[r2-retention] lifecycle GET failed (may not exist yet):", err);
    }

    const lifecycleXml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<LifecycleConfiguration>` +
      `<Rule><ID>${RULE_ID}</ID><Status>Enabled</Status>` +
      `<Filter><Prefix></Prefix></Filter>` +
      `<Expiration><Days>${days}</Days></Expiration>` +
      `</Rule></LifecycleConfiguration>`;
    try {
      const putReq = await aws.sign(
        new Request(`${endpoint}/${bucket}?lifecycle`, {
          method: "PUT",
          body: lifecycleXml,
          headers: { "Content-Type": "application/xml" },
        }),
      );
      const res = await fetch(putReq);
      if (!res.ok) return json({ error: `failed to set lifecycle: ${res.status}` }, 502);
      return json({ ok: true, rule: RULE_ID, days, alreadyConfigured: false });
    } catch (err) {
      console.error("[r2-retention] set lifecycle error:", err);
      return json({ error: "failed to set lifecycle" }, 500);
    }
  }

  if (op === "cleanup") {
    // Immediate sweep: list every object and delete those past the cutoff.
    const cutoff = Date.now() - days * 86_400_000;
    let deleted = 0;
    let token: string | undefined;
    do {
      const qs = new URLSearchParams({ "list-type": "2" });
      if (token) qs.set("continuation-token", token);
      const listReq = await aws.sign(new Request(`${endpoint}/${bucket}?${qs}`, { method: "GET" }));
      const listRes = await fetch(listReq);
      if (!listRes.ok) return json({ error: `list failed: ${listRes.status}` }, 502);
      const xml = await listRes.text();
      const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1].trim());
      const lastMods = [...xml.matchAll(/<LastModified>([\s\S]*?)<\/LastModified>/g)].map((m) => m[1].trim());
      const nextToken = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1]?.trim();
      for (let i = 0; i < keys.length; i++) {
        const age = Date.parse(lastMods[i] ?? "");
        if (!age || age > cutoff) continue;
        try {
          const delReq = await aws.sign(
            new Request(`${endpoint}/${bucket}/${keys[i]}?X-Amz-Expires=300`, { method: "DELETE" }),
            { aws: { signQuery: true } },
          );
          const delRes = await fetch(delReq);
          if (delRes.ok || delRes.status === 204) deleted++;
        } catch {
          /* keep sweeping */
        }
      }
      token = nextToken;
    } while (token);
    return json({ ok: true, deleted });
  }

  return json({ error: "unknown op" }, 400);
});
