import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};

type EmailType = "exam_published" | "exam_reminder" | "results_released";

type ReqBody = {
  examId: string;
  type: EmailType;
  examName?: string;
  joinLink?: string;
  scheduledAt?: string | null;
  studentIds?: string[];
};

type Recipient = {
  id: string;
  email: string;
  full_name: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const emailFrom = Deno.env.get("EMAIL_FROM") ?? "Exam Platform <noreply@example.com>";

  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "supabase env missing" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "missing bearer token" }, 401);

  const authClient = createClient(supabaseUrl, anonKey);
  const { data: authData, error: authError } = await authClient.auth.getUser(jwt);
  if (authError || !authData.user) return json({ error: "unauthorized" }, 401);

  const role = String((authData.user.app_metadata as Record<string, unknown> | undefined)?.role ?? "");
  if (!["teacher", "admin"].includes(role)) return json({ error: "forbidden" }, 403);

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  const examId = body.examId?.trim();
  if (!examId) return json({ error: "examId is required" }, 400);

  const type = body.type;
  if (!["exam_published", "exam_reminder", "results_released"].includes(type)) {
    return json({ error: "invalid notification type" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const recipients = await resolveRecipients(admin, examId, body.studentIds);
  if (recipients.length === 0) return json({ sent: 0, failed: 0, message: "no recipients" }, 200);

  const results = await Promise.all(
    recipients.map(async (recipient) => {
      const { data: notificationRow } = await admin
        .from("notifications")
        .insert({ recipient_id: recipient.id, exam_id: examId, type, delivery_status: "pending" })
        .select("id")
        .maybeSingle();

      const notificationId = notificationRow?.id as string | undefined;

      const sent = await sendEmail({
        to: recipient.email,
        subject: buildSubject(type, body.examName),
        html: buildTemplate(type, recipient.full_name, body),
        from: emailFrom,
      });

      if (notificationId) {
        await admin
          .from("notifications")
          .update({
            email_sent_at: sent ? new Date().toISOString() : null,
            delivery_status: sent ? "sent" : "failed",
          })
          .eq("id", notificationId);
      }

      return sent;
    }),
  );

  const sent = results.filter(Boolean).length;
  return json({ sent, failed: recipients.length - sent });
});

async function resolveRecipients(
  admin: ReturnType<typeof createClient>,
  examId: string,
  studentIds?: string[],
): Promise<Recipient[]> {
  if (studentIds && studentIds.length > 0) {
    const { data } = await admin
      .from("students")
      .select("id,email,full_name")
      .in("id", studentIds);
    return (data ?? []) as Recipient[];
  }

  const { data } = await admin
    .from("exam_enrollments")
    .select("student:students(id,email,full_name)")
    .eq("exam_id", examId)
    .eq("access_status", "allowed");

  const rows = (data ?? []) as Array<{ student: Recipient | Recipient[] | null }>;
  return rows
    .map((row) => (Array.isArray(row.student) ? row.student[0] : row.student))
    .filter((row): row is Recipient => !!row && !!row.email);
}

function buildSubject(type: EmailType, examName?: string) {
  const title = examName ?? "Exam";
  if (type === "exam_published") return `${title} is now available`;
  if (type === "exam_reminder") return `Reminder: ${title} starts in 1 hour`;
  return `Results released for ${title}`;
}

function buildTemplate(type: EmailType, fullName: string, payload: ReqBody) {
  const examName = payload.examName ?? "Your exam";
  const joinLink = payload.joinLink ?? "";
  const scheduled = payload.scheduledAt ? new Date(payload.scheduledAt).toLocaleString() : "as scheduled";

  if (type === "exam_published") {
    return `
      <p>Hi ${fullName},</p>
      <p><strong>${examName}</strong> has been published.</p>
      <p>Start time: ${scheduled}</p>
      <p><a href="${joinLink}">System compatibility check</a></p>
      <p>Please complete room scan, photo capture, and ID capture before the exam starts.</p>
    `;
  }

  if (type === "exam_reminder") {
    return `
      <p>Hi ${fullName},</p>
      <p>This is a reminder that <strong>${examName}</strong> starts in 1 hour.</p>
      <p><a href="${joinLink}">Open exam and run system check</a></p>
    `;
  }

  return `
    <p>Hi ${fullName},</p>
    <p>Your result for <strong>${examName}</strong> is now available.</p>
    <p>Please log in to the exam platform to view it.</p>
  `;
}

async function sendEmail(opts: { to: string; subject: string; html: string; from: string }): Promise<boolean> {
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (resendApiKey) {
    const authValue = ["Bearer", resendApiKey].join(" ");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: authValue,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: opts.from, to: opts.to, subject: opts.subject, html: opts.html }),
    });
    return res.ok;
  }

  const sendgridApiKey = Deno.env.get("SENDGRID_API_KEY");
  if (sendgridApiKey) {
    const authValue = ["Bearer", sendgridApiKey].join(" ");
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: authValue,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: opts.to }] }],
        from: { email: opts.from.replace(/.*<(.*)>/, "$1") },
        subject: opts.subject,
        content: [{ type: "text/html", value: opts.html }],
      }),
    });
    return res.ok;
  }

  console.warn("No email provider configured: RESEND_API_KEY or SENDGRID_API_KEY missing");
  return false;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
