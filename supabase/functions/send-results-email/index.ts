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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return json({ error: "Missing Supabase secrets" }, 500);

  const db = createClient(supabaseUrl, serviceRole);
  const { examId, studentEmails, scores } = await req.json().catch(() => ({ examId: null, studentEmails: [], scores: [] }));

  if (!examId) return json({ error: "examId is required" }, 400);

  const { data: exam } = await db.from("exams").select("id,name,total_marks").eq("id", examId).maybeSingle();
  if (!exam) return json({ error: "Exam not found" }, 404);

  const scoreMap = new Map<string, { score: number; total: number }>(
    (Array.isArray(scores) ? scores : []).map((item: { studentEmail: string; score: number; total: number }) => [
      item.studentEmail,
      { score: Number(item.score ?? 0), total: Number(item.total ?? exam.total_marks ?? 0) },
    ]),
  );

  const recipients = (Array.isArray(studentEmails) ? studentEmails : []).filter((email): email is string => !!email);

  const results = await Promise.all(
    recipients.map((email) => {
      const result = scoreMap.get(email) ?? { score: 0, total: Number(exam.total_marks ?? 0) };
      const percentage = result.total > 0 ? ((result.score / result.total) * 100).toFixed(2) : "0.00";
      const resultsLink = `${Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173"}/student/results`;

      return sendWithRetry(() =>
        transporter.sendMail({
          from: `Vignan Exam Platform <${Deno.env.get("GMAIL_USER")}>`,
          to: email,
          subject: `Your results for "${exam.name}" are now available`,
          html: `<div style="font-family:Arial,sans-serif"><p>Dear Student,</p><p>Your exam has been graded!</p><p>📊 Your Score: <strong>${result.score}/${result.total} (${percentage}%)</strong></p><p><a href="${resultsLink}">View detailed results</a></p><p>Regards,<br/>Vignan Exam Platform</p></div>`,
        }),
      ).then(
        () => ({ email, status: "sent", error: null }),
        (error) => ({ email, status: "failed", error: String(error instanceof Error ? error.message : error) }),
      );
    }),
  );

  await Promise.all(
    results.map((item) =>
      db.from("email_notifications").upsert({
        exam_id: examId,
        student_id: null,
        email: item.email,
        notification_type: "results_released",
        status: item.status,
        attempts: 3,
        last_error: item.error,
        sent_at: item.status === "sent" ? new Date().toISOString() : null,
      }),
    ),
  );

  return json({ sent: results.filter((r) => r.status === "sent").length, failed: results.filter((r) => r.status === "failed").length });
});

async function sendWithRetry(task: () => Promise<unknown>, max = 3): Promise<void> {
  let error: unknown;
  for (let i = 0; i < max; i += 1) {
    try {
      await task();
      return;
    } catch (e) {
      error = e;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw error;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
