// Supabase Edge Function: notify evaluators when test reports are assigned to
// them (the Examiner dashboard "Auto-assign Test Reports" flow). Mirrors
// send-exam-email / send-proctor-email (Gmail SMTP via nodemailer). Env needed:
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
  const { examId, evaluators = [], dueDate = null, reportCount = 0, appBaseUrl: reqBase } = await req
    .json()
    .catch(() => ({ examId: null, evaluators: [], dueDate: null, reportCount: 0, appBaseUrl: null }));
  if (!examId) return json({ error: "examId is required" }, 400);
  const list = Array.isArray(evaluators) ? evaluators : [];

  const { data: exam } = await db
    .from("exams")
    .select("id,name,batch,scheduled_at,duration_minutes")
    .eq("id", examId)
    .maybeSingle();
  if (!exam) return json({ error: "Exam not found" }, 404);

  const baseUrl = (reqBase || Deno.env.get("APP_BASE_URL") || "http://localhost:5173").replace(/\/$/, "");
  const gradeLink = `${baseUrl}/teacher/evaluate?exam=${encodeURIComponent(exam.id)}`;
  const due = dueDate ? new Date(dueDate) : null;

  const results = await Promise.all(
    list.map((e: { name?: string; email?: string; count?: number }) =>
      (async () => {
        if (!e.email) return { email: "", status: "skipped", error: "no email" };
        try {
          await transporter.sendMail({
            from: `Vignan Exam Platform <${Deno.env.get("GMAIL_USER")}>`,
            to: e.email,
            subject: `Test reports assigned to you: ${exam.name}`,
            html: evaluatorTemplate({
              evaluatorName: e.name || "Evaluator",
              examName: exam.name,
              examBatch: exam.batch ?? "",
              reportCount: Number(e.count ?? reportCount ?? 0),
              dueDate: due ? due.toLocaleDateString() : null,
              gradeLink,
            }),
          });
          await db.from("email_notifications").upsert({
            exam_id: examId,
            student_id: null,
            email: e.email,
            notification_type: "reports_assigned",
            status: "sent",
            sent_at: new Date().toISOString(),
          });
          return { email: e.email, status: "sent", error: null };
        } catch (err) {
          return { email: e.email, status: "failed", error: String(err instanceof Error ? err.message : err) };
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

function evaluatorTemplate(p: {
  evaluatorName: string; examName: string; examBatch: string; reportCount: number; dueDate: string | null; gradeLink: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#202124">
  <div style="padding:40px 16px;background:#f4f5f7">
    <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.08)">
      <div style="background:#1a3a2a;padding:26px 36px;color:white">
        <p style="margin:0;font-size:24px;font-weight:800;letter-spacing:1px">VIGNAN</p>
        <p style="margin:4px 0 0;font-size:12px;letter-spacing:1.5px;font-weight:600;opacity:.9">EXAM PLATFORM · EVALUATION DUTY</p>
      </div>
      <div style="padding:36px">
        <p style="margin:0 0 24px;font-size:16px">Dear <strong>${escapeHtml(p.evaluatorName)}</strong>,</p>
        <p style="margin:0;font-size:22px;font-weight:700;color:#1a3a2a">Test reports have been assigned to you ✍️</p>
        <p style="margin:14px 0 0;font-size:15px;line-height:1.7;color:#444">You have been assigned <strong style="color:#1a3a2a">${p.reportCount} test report${p.reportCount === 1 ? "" : "s"}</strong> for the exam <strong style="color:#1a3a2a">"${escapeHtml(p.examName)}"</strong> (${escapeHtml(p.examBatch)}).</p>
        <table style="margin-top:28px;width:100%;border-collapse:collapse;border:1px solid #e1e4e8;border-radius:10px;overflow:hidden">
          <tr style="background:#fafafa">
            <td style="padding:14px 18px;font-size:12px;color:#707784;width:50%">🗂 Reports assigned</td>
            <td style="padding:14px 18px;font-size:12px;color:#707784">📅 Due date</td>
          </tr>
          <tr>
            <td style="padding:14px 18px;font-size:15px;font-weight:700">${p.reportCount}</td>
            <td style="padding:14px 18px;font-size:15px;font-weight:700">${p.dueDate ? escapeHtml(p.dueDate) : "Not set"}</td>
          </tr>
        </table>
        <a href="${p.gradeLink}" style="display:block;margin-top:26px;padding:15px 20px;background:#1a3a2a;color:#ffffff;text-decoration:none;font-weight:700;text-align:center;border-radius:8px;font-size:15px">→ &nbsp; Open Grading Queue</a>
        <p style="margin:18px 0 0;color:#687180;font-size:12px">If the button does not work, copy this link into your browser:<br><span style="color:#1a3a2a;word-break:break-all">${p.gradeLink}</span></p>
      </div>
      <div style="padding:20px 24px;background:#272b31;color:#ffffff;text-align:center;font-size:11px">© 2026 Vignan Exam Platform · Automated assignment notification — please do not reply.</div>
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
