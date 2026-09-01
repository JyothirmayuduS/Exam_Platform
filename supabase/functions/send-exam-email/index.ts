import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.10.0";

type Recipient = {
  student_id: string;
  email: string;
  full_name: string;
};

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
  const { examId, studentEmails } = await req.json().catch(() => ({ examId: null, studentEmails: [] }));

  if (!examId) return json({ error: "examId is required" }, 400);

  const { data: exam } = await db.from("exams").select("id,name,scheduled_at,duration_minutes,total_marks").eq("id", examId).maybeSingle();
  if (!exam) return json({ error: "Exam not found" }, 404);

  let recipients: Recipient[] = [];

  if (Array.isArray(studentEmails) && studentEmails.length > 0) {
    recipients = studentEmails.map((email: string) => ({ student_id: "manual", email, full_name: "Student" }));
  } else {
    const { data } = await db
      .from("enrollments")
      .select("student_id,student:students(email,full_name)")
      .eq("exam_id", examId);

    recipients = (data ?? [])
      .map((row) => {
        const student = Array.isArray((row as { student: unknown }).student)
          ? (row as { student: { email?: string; full_name?: string }[] }).student[0]
          : ((row as { student: { email?: string; full_name?: string } }).student ?? null);
        if (!student?.email) return null;
        return {
          student_id: String((row as { student_id?: string }).student_id ?? ""),
          email: student.email,
          full_name: student.full_name ?? "Student",
        };
      })
      .filter((row): row is Recipient => !!row);
  }

  const results = await Promise.all(
    recipients.map((recipient) =>
      sendWithRetry(async () => {
        const joinLink = `${Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173"}/student/exam?examId=${encodeURIComponent(exam.id)}`;
        const html = examPublishedTemplate({
          studentName: recipient.full_name,
          examName: exam.name,
          dateTime: exam.scheduled_at ? new Date(exam.scheduled_at).toLocaleString() : "Available now",
          duration: Number(exam.duration_minutes ?? 0),
          marks: Number(exam.total_marks ?? 0),
          joinLink,
        });

        await transporter.sendMail({
          from: `Vignan Exam Platform <${Deno.env.get("GMAIL_USER")}>`,
          to: recipient.email,
          subject: `Your exam is ready: ${exam.name}`,
          html,
        });
      }).then(
        () => ({ recipient, status: "sent", error: null }),
        (error) => ({ recipient, status: "failed", error: String(error instanceof Error ? error.message : error) }),
      ),
    ),
  );

  await Promise.all(
    results.map((item) =>
      db.from("email_notifications").upsert({
        exam_id: examId,
        student_id: item.recipient.student_id || null,
        email: item.recipient.email,
        notification_type: "exam_published",
        status: item.status,
        attempts: 3,
        last_error: item.error,
        sent_at: item.status === "sent" ? new Date().toISOString() : null,
      }),
    ),
  );

  return json({ sent: results.filter((r) => r.status === "sent").length, failed: results.filter((r) => r.status === "failed").length });
});

async function sendWithRetry(task: () => Promise<void>, max = 3): Promise<void> {
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

function examPublishedTemplate(payload: {
  studentName: string;
  examName: string;
  dateTime: string;
  duration: number;
  marks: number;
  joinLink: string;
}): string {
  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #eee;padding:24px">
      <h2 style="color:#7A1F2B;margin:0">Vignan Exam Platform</h2>
      <p>Dear ${escapeHtml(payload.studentName)},</p>
      <p>Your exam <strong>"${escapeHtml(payload.examName)}"</strong> has been published and is ready to take.</p>
      <p>📋 <strong>Exam Details</strong><br/>
      - Date & Time: ${escapeHtml(payload.dateTime)}<br/>
      - Duration: ${payload.duration} minutes<br/>
      - Total Marks: ${payload.marks}</p>
      <p><a href="${payload.joinLink}" style="background:#7A1F2B;color:#fff;padding:10px 14px;text-decoration:none">Join Exam</a></p>
      <p>✓ Before starting:<br/>- Check internet connection<br/>- Run system compatibility check<br/>- Try practice mode if available</p>
      <p>Regards,<br/>Vignan Exam Platform</p>
    </div>
  `;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char] ?? char));
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
