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
  const { examId, studentEmail } = await req.json().catch(() => ({ examId: null, studentEmail: null }));

  if (!examId) return json({ error: "examId is required" }, 400);

  const { data: exam } = await db.from("exams").select("id,name,scheduled_at").eq("id", examId).maybeSingle();
  if (!exam) return json({ error: "Exam not found" }, 404);

  const now = Date.now();
  const startsAt = exam.scheduled_at ? new Date(exam.scheduled_at).getTime() : null;
  if (!startsAt || startsAt - now > 60 * 60 * 1000) {
    return json({ skipped: true, reason: "Exam not within 1 hour window" });
  }

  const { data: enrolled } = await db
    .from("enrollments")
    .select("student_id,reminder_email_sent,countdown_notified,student:students(email,full_name)")
    .eq("exam_id", examId)
    .or("reminder_email_sent.is.null,reminder_email_sent.eq.false");

  const recipients = (enrolled ?? [])
    .map((row) => {
      const student = Array.isArray((row as { student: unknown }).student)
        ? (row as { student: { email?: string; full_name?: string }[] }).student[0]
        : ((row as { student: { email?: string; full_name?: string } }).student ?? null);
      const email = student?.email ?? "";
      if (!email) return null;
      if (studentEmail && studentEmail !== email) return null;
      return {
        studentId: String((row as { student_id?: string }).student_id ?? ""),
        email,
        name: student?.full_name ?? "Student",
      };
    })
    .filter((row): row is { studentId: string; email: string; name: string } => !!row);

  const joinLink = `${Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173"}/student/exam?examId=${encodeURIComponent(exam.id)}`;

  const results = await Promise.all(
    recipients.map((recipient) =>
      sendWithRetry(() =>
        transporter.sendMail({
          from: `Vignan Exam Platform <${Deno.env.get("GMAIL_USER")}>`,
          to: recipient.email,
          subject: `Reminder: Exam "${exam.name}" starts in 1 hour`,
          html: `<div style="font-family:Arial,sans-serif"><p>Hi ${escapeHtml(recipient.name)},</p><p>Your exam <strong>${escapeHtml(exam.name)}</strong> starts in 1 hour. Make sure your system is ready.</p><p><a href="${joinLink}">Join Exam</a></p></div>`,
        }),
      ).then(
        () => ({ recipient, status: "sent", error: null }),
        (error) => ({ recipient, status: "failed", error: String(error instanceof Error ? error.message : error) }),
      ),
    ),
  );

  await Promise.all(
    results.map(async (item) => {
      await db.from("email_notifications").upsert({
        exam_id: examId,
        student_id: item.recipient.studentId,
        email: item.recipient.email,
        notification_type: "exam_reminder",
        status: item.status,
        attempts: 3,
        last_error: item.error,
        sent_at: item.status === "sent" ? new Date().toISOString() : null,
      });

      if (item.status === "sent") {
        await db
          .from("enrollments")
          .update({ countdown_notified: true, reminder_email_sent: true })
          .eq("exam_id", examId)
          .eq("student_id", item.recipient.studentId);
      }
    }),
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

function escapeHtml(input: string): string {
  return input.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char] ?? char));
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
