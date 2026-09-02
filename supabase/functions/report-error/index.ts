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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  
  // Wrap the rest of the handler in Sentry to automatically capture unhandled exceptions
  return await Sentry.withIsolationScope(async () => {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const adminEmail = Deno.env.get("ADMIN_EMAIL") ?? "admin@example.com";
  
  if (!resendKey) return json({ error: "Resend API key missing" }, 500);

  // Authenticate user
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  
  let userEmail = "Anonymous / Unauthenticated";
  
  if (jwt && supabaseUrl && anonKey) {
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data } = await supabase.auth.getUser(jwt);
    if (data?.user) {
      userEmail = data.user.email ?? "Unknown User";
    }
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  const message = String(body.message ?? "No message provided").trim();
  const errorInfo = String(body.errorInfo ?? "").trim();
  const url = String(body.url ?? "Unknown URL");
  const kind = String(body.kind ?? "Crash Report"); // "User Report" or "Crash Report"

  const html = `
    <h2>Vignan Exam Platform: ${kind}</h2>
    <p><strong>Reported by:</strong> ${userEmail}</p>
    <p><strong>URL:</strong> ${url}</p>
    <h3>Message / Details</h3>
    <pre style="background: #f4f4f4; padding: 12px;">${message}</pre>
    ${errorInfo ? `<h3>Stack Trace / Info</h3><pre style="background: #f4f4f4; padding: 12px; font-size: 11px;">${errorInfo}</pre>` : ''}
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: "Vignan Exam System <system@vignan-exam.com>",
        to: [adminEmail],
        subject: `[${kind}] ${message.substring(0, 50)}...`,
        html,
      }),
    });

    if (!res.ok) {
      console.error("Resend error:", await res.text());
      return json({ error: "Failed to send email" }, 500);
    }
    
    return json({ success: true });
    } catch (err) {
      console.error("Fetch error:", err);
      Sentry.captureException(err);
      return json({ error: "Internal error" }, 500);
    }
  });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
