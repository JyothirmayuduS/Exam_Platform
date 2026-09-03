import { getSupabase } from "./supabase";

type ResultScore = {
  studentEmail: string;
  score: number;
  total: number;
};

export async function sendExamPublishedEmail(examId: string, studentEmails: string[]) {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const appBaseUrl = typeof window !== "undefined" ? window.location.origin : undefined;
  const { data, error } = await db.functions.invoke("send-exam-email", {
    body: { examId, studentEmails, appBaseUrl },
  });
  return error ? { ok: false, error: error.message } : { ok: true, data };
}

export async function sendExamReminderEmail(examId: string, studentEmail?: string) {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const { data, error } = await db.functions.invoke("send-reminder-email", {
    body: { examId, studentEmail },
  });
  return error ? { ok: false, error: error.message } : { ok: true, data };
}

export async function sendResultsReleasedEmail(
  examId: string,
  studentEmails: string[],
  scores: ResultScore[],
) {
  const db = getSupabase();
  if (!db) return { ok: false, error: "offline" };
  const { data, error } = await db.functions.invoke("send-results-email", {
    body: { examId, studentEmails, scores },
  });
  return error ? { ok: false, error: error.message } : { ok: true, data };
}
