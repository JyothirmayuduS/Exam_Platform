// Supabase Edge Function: mint short-lived presigned Cloudflare R2 PUT URLs.
//
// Runtime: Deno (Supabase Edge Functions). Deploy WITH JWT verification so only
// authenticated users can request an upload URL:
//   supabase functions deploy store-artifact
// Set secrets (NEVER in the frontend / never committed):
//   supabase secrets set R2_ACCESS_KEY_ID=...
//   supabase secrets set R2_SECRET_ACCESS_KEY=...
//   supabase secrets set R2_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
//   supabase secrets set R2_BUCKET=exam-artifacts
//   supabase secrets set ALLOWED_ORIGIN=https://your-app-origin   # optional CORS lock
//
// Security model:
//   • The caller MUST present a valid Supabase auth JWT (Authorization: Bearer).
//   • R2 credentials live only in Edge Function secrets and never reach the
//     browser. We hand back a presigned URL that expires in 5 minutes.
//   • Object keys are structured exam-folder/student-folder/kind so a full
//     per-exam, per-student artifact tree builds up automatically:
//       ${examId}/${studentId}/{screenshots|report|recording}/${name}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

const KINDS = new Set(["screenshots", "report", "recording"]);

// Only allow a safe leaf filename — no path traversal, no slashes.
function safeName(name: string): string | null {
  const n = name.trim();
  if (!n || n.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(n)) return null;
  if (n.includes("..")) return null;
  return n;
}

// Sanitize an id segment used in the object key path.
function safeSegment(v: string): string | null {
  const s = v.trim();
  if (!s || s.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return null;
  return s;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const endpoint = (Deno.env.get("R2_S3_ENDPOINT") ?? "").replace(/\/+$/, "");
  const bucket = Deno.env.get("R2_BUCKET") ?? "exam-artifacts";
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

  // Presign a PUT via SigV4 (query-string auth). aws4fetch signs the request
  // and, with X-Amz-Expires, produces a URL valid for a short window.
  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto", // R2 uses "auto"
  });

  try {
    const signed = await aws.sign(
      new Request(`${objectUrl}?X-Amz-Expires=300`, { method: "PUT" }),
      { aws: { signQuery: true } },
    );
    return json({ url: signed.url, key });
  } catch (err) {
    console.error("[store-artifact] presign error:", err);
    return json({ error: "failed to presign" }, 500);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
