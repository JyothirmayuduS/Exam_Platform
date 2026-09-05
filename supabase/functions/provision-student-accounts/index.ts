// Supabase Edge Function: provision-student-accounts
// ─────────────────────────────────────────────────────────────────────────────
// Creates real Supabase Auth accounts for student rows (by roll) and links each
// profile's auth_id, so candidates can sign in at /login with
//   <roll>@student.vignan.ac.in  /  Vignan@123 (override with STUDENT_DEFAULT_PASSWORD)
// Caller must be staff. Idempotent: rolls with an account are reported, never
// recreated. Deploy:
//   supabase functions deploy provision-student-accounts --no-verify-jwt
// Request: { "rolls": ["21BQ1A0501"], "sendEmail": true }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.10.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const normRoll = (roll: string) => roll.trim().toLowerCase();
const defaultPassword = () => Deno.env.get("STUDENT_DEFAULT_PASSWORD") ?? "Vignan@123";

async function sendCredentialEmail(email: string, login: string, password: string) {
  const user = Deno.env.get("GMAIL_USER");
  const pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) return { ok: false, reason: "GMAIL secrets not configured" };
  try {
    const transport = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    await transport.sendMail({
      from: `Vignan Exam Platform <${user}>`,
      to: email,
      subject: "Your Vignan CDOE exam login",
      text:
        `Your exam platform account is ready.\n\nSign in at the exam platform with:\n` +
        `  Login: ${login}\n  Password: ${password}\n\nChange it after your first sign-in.`,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err) };
  }
}

async function provisionOne(
  admin: ReturnType<typeof createClient>,
  roll: string,
): Promise<{ status: "created" | "already" | "linked"; login: string } | { status: "failed"; reason: string }> {
  const login = `${normRoll(roll)}@student.vignan.ac.in`;
  const { data: student, error: findError } = await admin.from("students").select("id, roll, email").eq("roll", roll).maybeSingle();
  if (findError) return { status: "failed", reason: findError.message };
  if (!student) return { status: "failed", reason: "no student row with this roll" };

  const { data: link } = await admin.from("students").select("auth_id").eq("id", student.id).maybeSingle();
  if (link?.auth_id) return { status: "already", login };

  const { data: user, error: createError } = await admin.auth.admin.createUser({
    email: login,
    password: defaultPassword(),
    email_confirm: true,
    app_metadata: { role: "student", roll: student.roll },
    user_metadata: { full_name: student.email ?? "", roll: student.roll },
  });    if (createError || !user?.user?.id) {
    // Email may already exist as an auth user (re-import) — link it instead.
    if (createError && (createError.message.includes("already been registered") || createError.status === 422)) {
      const { data: list } = await admin.auth.admin.listUsers();
      const match = list?.users.find((u) => u.email?.toLowerCase() === login);
      if (match) {
        const { error: ue } = await admin.from("students").update({ auth_id: match.id }).eq("id", student.id);
        if (!ue) return { status: "linked", login };
      }
    }
    return { status: "failed", reason: createError?.message ?? "createUser returned no id" };
  }

  const { error: linkError } = await admin.from("students").update({ auth_id: user.user.id }).eq("id", student.id);
  if (linkError) return { status: "failed", reason: linkError.message };
  return { status: "created", login };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceRole) return json({ error: "service role not configured" }, 500);

  // Staff only.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "missing authorization" }, 401);
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: authUser } = await userClient.auth.getUser();
  if (!authUser?.user) return json({ error: "invalid session" }, 401);
  const { data: staff } = await userClient.from("teachers").select("id").eq("auth_id", authUser.user.id).maybeSingle();
  if (!staff) return json({ error: "staff only" }, 403);

  let body: { rolls?: string[]; sendEmail?: boolean };
  try { body = await req.json(); } catch { return json({ error: "invalid body" }, 400); }
  const rolls = [...new Set((body.rolls ?? []).map(String).filter(Boolean))];
  if (!rolls.length) return json({ error: "rolls required" }, 400);
  const sendEmail = body.sendEmail !== false;

  const admin = createClient(supabaseUrl, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
  const created: { roll: string; login: string }[] = [];
  const alreadyProvisioned: string[] = [];
  const failed: { roll: string; reason: string }[] = [];

  for (const roll of rolls) {
    const res = await provisionOne(admin, roll);
    if (res.status === "created") {
      created.push({ roll, login: res.login });
      if (sendEmail) {
        const { data: st } = await admin.from("students").select("email, full_name").eq("roll", roll).maybeSingle();
        const creds = await sendCredentialEmail(st?.email ?? "", res.login, defaultPassword());
        if (!creds.ok && !creds.reason?.includes("not configured")) {
          failed.push({ roll, reason: `account created, email failed: ${creds.reason}` });
        }
      }
    } else if (res.status === "already" || res.status === "linked") {
      alreadyProvisioned.push(roll);
    } else {
      failed.push({ roll, reason: res.reason });
    }
  }

  return json({ created, alreadyProvisioned, failed, total: rolls.length });
});
