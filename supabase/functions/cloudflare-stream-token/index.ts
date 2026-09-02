import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "https://esm.sh/@sentry/deno@8";

Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN"),
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, tus-resumable, upload-length, upload-metadata, upload-defer-length",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Location, Upload-Offset, Upload-Length",
  "Vary": "Origin",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  
  return await Sentry.withIsolationScope(async () => {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const accountId = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!accountId || !apiToken) return json({ error: "Cloudflare secrets not configured" }, 500);
  if (!supabaseUrl || !anonKey) return json({ error: "Supabase env not configured" }, 500);

  // Authenticate user
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "missing bearer token" }, 401);

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !userData?.user) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  const examId = String(body.examId ?? "").trim();
  const studentId = String(body.studentId ?? "").trim();
  const kind = String(body.kind ?? "camera").trim(); // "camera" or "screen"

  if (!examId || !studentId) return json({ error: "Missing examId or studentId" }, 400);

  // Request a Direct Creator Upload token using TUS from Cloudflare Stream
  // Cloudflare Stream allows you to POST to /stream to get a TUS upload URL
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Tus-Resumable": "1.0.0",
        "Upload-Defer-Length": "1", // Required for live streaming recording
        "Upload-Metadata": `name ${btoa(`${kind}_${studentId}_${examId}`)},examId ${btoa(examId)},studentId ${btoa(studentId)}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[cloudflare-stream] Failed to get upload URL:", res.status, text);
      return json({ error: "Failed to get upload URL from Cloudflare" }, 500);
    }

    // The upload URL is returned in the Location header
    const uploadUrl = res.headers.get("Location");
    if (!uploadUrl) {
      return json({ error: "No Location header in Cloudflare response" }, 500);
    }

    return json({ url: uploadUrl });
    } catch (err) {
      console.error("[cloudflare-stream] Exception:", err);
      Sentry.captureException(err);
      return json({ error: "Internal server error" }, 500);
    }
  });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
