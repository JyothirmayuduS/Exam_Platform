import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return json({ error: "Missing Supabase secrets" }, 500);

  const db = createClient(supabaseUrl, serviceRole);
  
  // Accept student_id via GET query param or POST body
  const url = new URL(req.url);
  let studentId = url.searchParams.get("studentId");
  
  if (!studentId && req.method === "POST") {
    const body = await req.json().catch(() => ({ studentId: null }));
    studentId = body.studentId;
  }

  if (!studentId) return json({ error: "studentId is required" }, 400);

  const { error } = await db.from("students").update({ unsubscribed_emails: true }).eq("id", studentId);
  if (error) return json({ error: String(error.message) }, 500);

  if (req.method === "GET") {
    return new Response(
      `<html><body style="font-family:sans-serif;text-align:center;padding:50px;"><h2>You have successfully unsubscribed from exam notifications.</h2></body></html>`,
      { headers: { ...CORS, "Content-Type": "text/html" } }
    );
  }

  return json({ success: true, message: "Unsubscribed successfully" });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
