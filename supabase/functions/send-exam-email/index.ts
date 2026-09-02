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
      .select("student_id,student:students(email,full_name,unsubscribed_emails)")
      .eq("exam_id", examId);

    recipients = (data ?? [])
      .map((row) => {
        const student = Array.isArray((row as { student: unknown }).student)
          ? (row as { student: { email?: string; full_name?: string; unsubscribed_emails?: boolean }[] }).student[0]
          : ((row as { student: { email?: string; full_name?: string; unsubscribed_emails?: boolean } }).student ?? null);
        if (!student?.email) return null;
        if (student.unsubscribed_emails === true) return null; // Skip unsubscribed students
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
        const dateObj = exam.scheduled_at ? new Date(exam.scheduled_at) : null;
        const html = examPublishedTemplate({
          studentId: recipient.student_id,
          studentName: recipient.full_name,
          examName: exam.name,
          examDate: dateObj ? dateObj.toLocaleDateString() : "Available now",
          examTime: dateObj ? dateObj.toLocaleTimeString() : "-",
          duration: Number(exam.duration_minutes ?? 0),
          marks: Number(exam.total_marks ?? 0),
          joinLink,
          systemCheckLink: `${Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173"}/system-check`,
          practiceLink: `${Deno.env.get("APP_BASE_URL") ?? "http://localhost:5173"}/student/practice`,
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
  studentId: string;
  studentName: string;
  examName: string;
  examDate: string;
  examTime: string;
  duration: number;
  marks: number;
  joinLink: string;
  systemCheckLink: string;
  practiceLink: string;
}): string {
  const unsubscribeLink = `${Deno.env.get("SUPABASE_URL")}/functions/v1/unsubscribe-email?studentId=${payload.studentId}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vignan Exam Notification</title>

  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: #f4f5f7; font-family: Arial, Helvetica, sans-serif; color: #202124; }
    .email-wrapper { width: 100%; padding: 40px 16px; background: #f4f5f7; }
    .email { max-width: 760px; margin: auto; background: #ffffff; border-radius: 14px; overflow: hidden; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08); }
    .header { background: #8b1e2d; padding: 28px 42px; color: white; }
    .header-table { width: 100%; }
    .logo { font-size: 28px; font-weight: 800; letter-spacing: 1px; margin: 0; }
    .logo-subtitle { margin-top: 4px; font-size: 13px; letter-spacing: 1.5px; font-weight: 600; }
    .tagline { text-align: right; font-size: 14px; font-style: italic; opacity: 0.95; }
    .content { padding: 42px; }
    .greeting { font-size: 18px; margin: 0 0 28px; }
    .hero-table { width: 100%; }
    .hero-text { width: 65%; vertical-align: middle; }
    .hero-image { width: 35%; text-align: right; vertical-align: middle; }
    .hero-title { margin: 0 0 14px; font-size: 34px; line-height: 1.15; color: #8b1e2d; font-weight: 800; }
    .hero-description { margin: 0; font-size: 17px; line-height: 1.7; color: #444; }
    .exam-name { color: #8b1e2d; font-weight: 700; }
    .laptop { width: 180px; max-width: 100%; }
    .details { margin-top: 38px; border: 1px solid #e1e4e8; border-radius: 12px; overflow: hidden; }
    .details-heading { padding: 20px 22px; font-size: 19px; font-weight: 700; background: #fafafa; }
    .details-table { width: 100%; }
    .detail { width: 25%; text-align: center; padding: 22px 12px; border-right: 1px solid #e5e7eb; }
    .detail:last-child { border-right: 0; }
    .detail-icon { font-size: 25px; margin-bottom: 10px; }
    .detail-label { display: block; color: #707784; font-size: 13px; margin-bottom: 9px; }
    .detail-value { display: block; color: #17191c; font-size: 15px; font-weight: 700; line-height: 1.5; }
    .actions { margin-top: 30px; padding: 25px; background: #fff8f9; border: 1px solid #f1dadd; border-radius: 12px; }
    .action-table { width: 100%; }
    .action { width: 33.33%; padding: 0 7px; text-align: center; vertical-align: top; }
    .button { display: block; padding: 15px 10px; border-radius: 8px; text-decoration: none; font-size: 15px; font-weight: 700; }
    .join { background: #8b1e2d; color: #ffffff !important; }
    .outline { background: #ffffff; color: #8b1e2d !important; border: 1px solid #8b1e2d; }
    .action-text { margin: 11px 0 0; color: #69717d; font-size: 12px; line-height: 1.5; }
    .checklist { margin-top: 30px; padding: 24px; background: #f4f8ff; border: 1px solid #d8e5f7; border-radius: 12px; }
    .check-title { margin: 0 0 17px; color: #1c568f; font-size: 18px; font-weight: 700; }
    .check-item { padding: 9px 0; font-size: 14px; color: #555f6d; border-bottom: 1px solid #dce6f2; }
    .check-item:last-child { border-bottom: 0; }
    .tick { color: #1769aa; font-weight: 800; margin-right: 8px; }
    .support { margin-top: 32px; padding-top: 25px; border-top: 1px solid #e5e7eb; }
    .support-table { width: 100%; }
    .support-left { width: 60%; }
    .support-right { width: 40%; text-align: right; }
    .support-title { font-size: 14px; color: #687180; margin-bottom: 5px; }
    .support-email { color: #8b1e2d; font-size: 14px; font-weight: 700; }
    .regards { color: #687180; font-size: 13px; }
    .platform { color: #8b1e2d; font-size: 14px; font-weight: 700; margin-top: 4px; }
    .footer { padding: 24px; background: #272b31; color: #ffffff; text-align: center; }
    .footer-brand { font-size: 15px; font-weight: 700; margin: 0 0 8px; }
    .footer-text { margin: 0; color: #aeb4bd; font-size: 11px; line-height: 1.6; }
    @media screen and (max-width: 600px) {
      .email-wrapper { padding: 10px; }
      .header { padding: 24px; }
      .content { padding: 25px 20px; }
      .tagline { display: none; }
      .hero-text, .hero-image { width: 100%; display: block; text-align: left; }
      .hero-image { margin-top: 20px; text-align: center; }
      .hero-title { font-size: 28px; }
      .hero-description { font-size: 15px; }
      .detail { width: 50%; display: inline-block; border-right: 0; border-bottom: 1px solid #e5e7eb; }
      .action { width: 100%; display: block; padding: 6px 0; }
      .support-left, .support-right { width: 100%; display: block; text-align: left; }
      .support-right { margin-top: 20px; }
    }
  </style>
</head>
<body>
<div class="email-wrapper">
  <div class="email">
    <div class="header">
      <table class="header-table">
        <tr>
          <td><p class="logo">VIGNAN</p><div class="logo-subtitle">EXAM PLATFORM</div></td>
          <td class="tagline">Excellence Through Evaluation</td>
        </tr>
      </table>
    </div>
    <div class="content">
      <p class="greeting">Dear <strong>${escapeHtml(payload.studentName)}</strong>,</p>
      <table class="hero-table">
        <tr>
          <td class="hero-text">
            <h1 class="hero-title">Great news! 🎉</h1>
            <p class="hero-description">Your exam <span class="exam-name">"${escapeHtml(payload.examName)}"</span> has been published and is ready for you to take.</p>
          </td>
          <td class="hero-image">
            <img class="laptop" src="https://ik.imagekit.io/jxy62xubr/laptop-test.png?updatedAt=1708512140411" alt="Exam Ready" />
          </td>
        </tr>
      </table>
      <div class="details">
        <div class="details-heading">📋 &nbsp; Exam Details</div>
        <table class="details-table">
          <tr>
            <td class="detail">
              <div class="detail-icon">📅</div>
              <span class="detail-label">Date &amp; Time</span>
              <span class="detail-value">${escapeHtml(payload.examDate)}<br>${escapeHtml(payload.examTime)}</span>
            </td>
            <td class="detail">
              <div class="detail-icon">◷</div>
              <span class="detail-label">Duration</span>
              <span class="detail-value">${payload.duration} Minutes</span>
            </td>
            <td class="detail">
              <div class="detail-icon">🏆</div>
              <span class="detail-label">Total Marks</span>
              <span class="detail-value">${payload.marks} Marks</span>
            </td>
            <td class="detail">
              <div class="detail-icon">💻</div>
              <span class="detail-label">Mode</span>
              <span class="detail-value">Online<br>Proctored</span>
            </td>
          </tr>
        </table>
      </div>
      <div class="actions">
        <table class="action-table">
          <tr>
            <td class="action">
              <a href="${payload.joinLink}" class="button join">→ &nbsp; Join Exam</a>
              <p class="action-text">Enter the exam hall<br>at the scheduled time</p>
            </td>
            <td class="action">
              <a href="${payload.systemCheckLink}" class="button outline">✓ &nbsp; System Check</a>
              <p class="action-text">Check camera, microphone,<br>browser &amp; internet</p>
            </td>
            <td class="action">
              <a href="${payload.practiceLink}" class="button outline">📖 &nbsp; Practice Mode</a>
              <p class="action-text">Try a demo exam and<br>familiarize yourself</p>
            </td>
          </tr>
        </table>
      </div>
      <div class="checklist">
        <p class="check-title">🛡️ &nbsp; Before you begin</p>
        <div class="check-item"><span class="tick">✓</span>Check your internet connection</div>
        <div class="check-item"><span class="tick">✓</span>Run the system compatibility check</div>
        <div class="check-item"><span class="tick">✓</span>Allow camera and microphone access</div>
        <div class="check-item"><span class="tick">✓</span>Use a supported browser</div>
        <div class="check-item"><span class="tick">✓</span>Sit in a quiet and well-lit environment</div>
      </div>
      <div class="support">
        <table class="support-table">
          <tr>
            <td class="support-left">
              <div class="support-title">Need help? Contact our support team</div>
              <div class="support-email">exam-support@vignan.ac.in</div>
            </td>
            <td class="support-right">
              <div class="regards">Regards,</div>
              <div class="platform">Vignan Exam Platform</div>
            </td>
          </tr>
        </table>
      </div>
    </div>
    <div class="footer">
      <p class="footer-brand">Vignan Exam Platform</p>
      <p class="footer-text">This is an automated examination notification. Please do not reply to this email.</p>
      <p class="footer-text">Don't want to receive these emails? <a href="${unsubscribeLink}" style="color:#aeb4bd;text-decoration:underline">Unsubscribe</a></p>
      <p class="footer-text">© 2026 Vignan Exam Platform. All rights reserved.</p>
    </div>
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char] ?? char));
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
