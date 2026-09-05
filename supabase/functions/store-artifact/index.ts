// Supabase Edge Function: mint short-lived presigned Cloudflare R2 URLs and
// list objects. Credentials live ONLY in Edge Function secrets — never in the
// frontend, never committed.
//
// Runtime: Deno (Supabase Edge Functions). Deploy WITH JWT verification so only
// authenticated users can request operations:
//   supabase functions deploy store-artifact
// Set secrets (NEVER in the frontend / never committed):
//   supabase secrets set R2_ACCESS_KEY_ID=...
//   supabase secrets set R2_SECRET_ACCESS_KEY=...
//   supabase secrets set R2_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
//   supabase secrets set R2_BUCKET=exam-records
//   supabase secrets set ALLOWED_ORIGIN=https://your-app-origin   # optional CORS lock
//
// Request ops (all require a valid Supabase auth JWT):
//   op "put" (default): { examId, studentId, kind, name, contentType }
//       → { url: presigned PUT (5 min), key: `${examId}/${studentId}/${kind}/${name}` }
//   op "get":  { key }                      → { url: presigned GET (default 1h) }
//   op "list": { prefix }                   → { objects: [{key,name,size,lastModified}] }
//
// Kinds match the folder segments used by the app:
//   screenshots | recordings | violations | report | ai_evidence

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const KINDS = new Set(["screenshots", "recordings", "violations", "report", "ai_evidence"]);

// Allow a safe leaf filename or one-level subfolder (e.g. "parts/seg_01.webm").
// No path traversal, no leading/trailing slashes, no double slashes.
function safeName(name: string): string | null {
  const n = name.trim();
  if (!n || n.length > 128) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(n)) return null;
  if (n.includes("..") || n.includes("//") || n.startsWith("/") || n.endsWith("/")) return null;
  return n;
}

// Sanitize an id segment used in the object key path.
function safeSegment(v: string): string | null {
  const s = v.trim();
  if (!s || s.length > 128) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return null;
  if (s.includes("..")) return null;
  return s;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Credentials come ONLY from Edge Function secrets.
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const endpoint = (Deno.env.get("R2_S3_ENDPOINT") ?? "").replace(/\/+$/, "");
  const bucket = Deno.env.get("R2_BUCKET") ?? "exam-records";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    return json({ error: "R2 secrets not configured" }, 500);
  }
  if (!supabaseUrl || !anonKey) return json({ error: "Supabase env not configured" }, 500);

  // ── Authenticate the caller ────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "missing bearer token" }, 401);

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: authError } = await supabase.auth.getUser(jwt);
  const user = userData?.user;
  if (authError || !user) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const op = String(body.op ?? "put").trim();

  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto", // R2 uses "auto"
  });

  // ── op "put" (default): presign a PUT for one new object ──────────────────
  if (op === "put") {
    const examId = safeSegment(String(body.examId ?? ""));
    const studentId = safeSegment(String(body.studentId ?? ""));
    const kind = String(body.kind ?? "").trim();
    const name = safeName(String(body.name ?? ""));
    const contentType = String(body.contentType ?? "application/octet-stream");

    if (!examId) return json({ error: "invalid examId" }, 400);
    if (!studentId) return json({ error: "invalid studentId" }, 400);
    if (!KINDS.has(kind)) return json({ error: "invalid kind" }, 400);
    if (!name) return json({ error: "invalid name" }, 400);

    const key = `${examId}/${studentId}/${kind}/${name}`;
    const objectUrl = `${endpoint}/${bucket}/${key}`;
    try {
      const signed = await aws.sign(
        new Request(`${objectUrl}?X-Amz-Expires=300`, { method: "PUT" }),
        { aws: { signQuery: true } },
      );
      return json({ url: signed.url, key });
    } catch (err) {
      console.error("[store-artifact] presign PUT error:", err);
      return json({ error: "failed to presign" }, 500);
    }
  }

  // ── op "get": presigned GET for an existing object ────────────────────────
  if (op === "get") {
    const key = safeSegment(String(body.key ?? ""));
    if (!key) return json({ error: "invalid key" }, 400);
    const expires = Math.min(Math.max(Number(body.expiresSec ?? 3600) || 3600, 60), 86400);
    try {
      const signed = await aws.sign(
        new Request(`${endpoint}/${bucket}/${key}?X-Amz-Expires=${expires}`, { method: "GET" }),
        { aws: { signQuery: true } },
      );
      return json({ url: signed.url });
    } catch (err) {
      console.error("[store-artifact] presign GET error:", err);
      return json({ error: "failed to presign" }, 500);
    }
  }

  // ── op "list": list objects under a prefix (server-side, XML → JSON) ──────
  if (op === "list") {
    const prefix = safeSegment(String(body.prefix ?? ""));
    if (prefix == null || prefix === "") return json({ error: "invalid prefix" }, 400);
    const qs = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
    try {
      const signed = await aws.sign(
        new Request(`${endpoint}/${bucket}?${qs}`, { method: "GET" }),
        { aws: { signQuery: false } },
      );
      // Server-side signing puts the auth in headers — fetch the signed Request.
      const res = await fetch(signed);
      if (!res.ok) return json({ error: `R2 list failed: ${res.status}` }, 502);
      const xml = await res.text();
      const objects: { key: string; name: string; size: number; lastModified: string | null }[] = [];
      const re = /<Contents>([\s\S]*?)<\/Contents>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        const block = m[1];
        const pick = (tag: string) => {
          const mm = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
          return mm ? mm[1].trim() : null;
        };
        const key = pick("Key");
        if (!key) continue;
        objects.push({
          key,
          name: key.split("/").pop() ?? key,
          size: Number(pick("Size") ?? 0),
          lastModified: pick("LastModified"),
        });
      }
      return json({ objects });
    } catch (err) {
      console.error("[store-artifact] list error:", err);
      return json({ error: "failed to list" }, 500);
    }
  }

  return json({ error: "unknown op" }, 400);
});
