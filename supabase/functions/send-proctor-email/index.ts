// Supabase Edge Function: notify proctors when they are assigned to monitor an exam.
// Mirrors send-exam-email (Gmail SMTP via nodemailer). Env needed:
//   GMAIL_USER, GMAIL_APP_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.10.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: Deno.env.get("GMAIL_USER"),
    pass: Deno.env.get("GMAIL_APP_PASSWORD"),
  },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return json({ error: "Missing Supabase secrets" }, 500);

  const db = createClient(supabaseUrl, serviceRole);
  const { examId, proctors = [], appBaseUrl: reqBase } = await req.json().catch(() => ({ examId: null, proctors: [], appBaseUrl: null }));
  if (!examId) return json({ error: "examId is required" }, 400);
  const list = Array.isArray(proctors) ? proctors : [];

  const { data: exam } = await db
    .from("exams")
    .select("id,name,batch,scheduled_at,duration_minutes")
    .eq("id", examId)
    .maybeSingle();
  if (!exam) return json({ error: "Exam not found" }, 404);

  const baseUrl = (reqBase || Deno.env.get("APP_BASE_URL") || "http://localhost:5173").replace(/\/$/, "");
  const monitorLink = `${baseUrl}/proctor?exam=${encodeURIComponent(exam.id)}`;
  const dateObj = exam.scheduled_at ? new Date(exam.scheduled_at) : null;

  const results = await Promise.all(
    list.map((p: { name?: string; email?: string }) =>
      (async () => {
        if (!p.email) return { email: "", status: "skipped", error: "no email" };
        try {
          await transporter.sendMail({
            from: `Vignan Exam Platform <${Deno.env.get("GMAIL_USER")}>`,
            to: p.email,
            subject: `You're assigned to proctor: ${exam.name}`,
            html: proctorTemplate({
              proctorName: p.name || "Proctor",
              examName: exam.name,
              examBatch: exam.batch ?? "",
              examDate: dateObj ? dateObj.toLocaleDateString() : "Live now",
              examTime: dateObj ? dateObj.toLocaleTimeString() : "-",
              duration: Number(exam.duration_minutes ?? 0),
              monitorLink,
            }),
          });
          await db.from("email_notifications").upsert({
            exam_id: examId,
            student_id: null,
            email: p.email,
            notification_type: "proctor_assigned",
            status: "sent",
            sent_at: new Date().toISOString(),
          });
          return { email: p.email, status: "sent", error: null };
        } catch (e) {
          return { email: p.email, status: "failed", error: String(e instanceof Error ? e.message : e) };
        }
      })(),
    ),
  );

  return json({
    sent: results.filter((r) => r.status === "sent").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  });
});

function proctorTemplate(p: {
  proctorName: string; examName: string; examBatch: string; examDate: string; examTime: string;
  duration: number; monitorLink: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#202124">
  <div style="padding:40px 16px;background:#f4f5f7">
    <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.08)">
      <div style="background:#8b1e2d;padding:26px 36px;color:white">
        <p style="margin:0;font-size:24px;font-weight:800;letter-spacing:1px">VIGNAN</p>
        <p style="margin:4px 0 0;font-size:12px;letter-spacing:1.5px;font-weight:600;opacity:.9">EXAM PLATFORM · PROCTORING DUTY</p>
      </div>
      <div style="padding:36px">
        <p style="margin:0 0 24px;font-size:16px">Dear <strong>${escapeHtml(p.proctorName)}</strong>,</p>
        <p style="margin:0;font-size:22px;font-weight:700;color:#8b1e2d">You have been assigned as a proctor 🛡️</p>
        <p style="margin:14px 0 0;font-size:15px;line-height:1.7;color:#444">You are scheduled to monitor the exam <strong style="color:#8b1e2d">"${escapeHtml(p.examName)}"</strong> for <strong>${escapeHtml(p.examBatch)}</strong>.</p>
        <table style="margin-top:28px;width:100%;border-collapse:collapse;border:1px solid #e1e4e8;border-radius:10px;overflow:hidden">
          <tr style="background:#fafafa">
            <td style="padding:14px 18px;font-size:12px;color:#707784;width:50%">📅 Date &amp; time</td>
            <td style="padding:14px 18px;font-size:12px;color:#707784">◷ Duration</td>
          </tr>
          <tr>
            <td style="padding:14px 18px;font-size:15px;font-weight:700">${escapeHtml(p.examDate)} · ${escapeHtml(p.examTime)}</td>
            <td style="padding:14px 18px;font-size:15px;font-weight:700">${p.duration} Minutes</td>
          </tr>
        </table>
        <p style="margin:26px 0 0;font-size:14px;color:#444">You will see live camera &amp; screen feeds, real-time violation flags, and can warn, pause, or escalate candidates straight from the proctor console.</p>
        <a href="${p.monitorLink}" style="display:block;margin-top:26px;padding:15px 20px;background:#8b1e2d;color:#ffffff;text-decoration:none;font-weight:700;text-align:center;border-radius:8px;font-size:15px">→ &nbsp; Open Proctor Console</a>
        <p style="margin:18px 0 0;color:#687180;font-size:12px">If the button does not work, copy this link into your browser:<br><span style="color:#8b1e2d;word-break:break-all">${p.monitorLink}</span></p>
      </div>
      <div style="padding:20px 24px;background:#272b31;color:#ffffff;text-align:center;font-size:11px;color:#aeb4bd">© 2026 Vignan Exam Platform · Automated proctoring notification — please do not reply.</div>
    </div>
  </div>
</body></html>`;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char] ?? char));
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
