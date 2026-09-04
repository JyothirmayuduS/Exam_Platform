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

/** Email proctors after the teacher assigns them to an exam. */
export async function sendProctorAssignmentEmail(
  examId: string,
  proctors: { name?: string; email?: string | null }[],
) {
  const db = getSupabase();
  const withEmail = proctors.filter((p) => !!p.email);
  if (!db || withEmail.length === 0) return { ok: false, error: "offline" };
  const appBaseUrl = typeof window !== "undefined" ? window.location.origin : undefined;
  const { data, error } = await db.functions.invoke("send-proctor-email", {
    body: { examId, proctors: withEmail, appBaseUrl },
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

/** Email evaluators after the examiner auto-assigns them test reports. */
export async function sendEvaluatorAssignmentEmail(
  examId: string,
  evaluators: { name?: string; email?: string | null; count?: number }[],
  dueDate?: string | null,
  reportCount?: number,
) {
  const db = getSupabase();
  const withEmail = evaluators.filter((e) => !!e.email);
  if (!db || withEmail.length === 0) return { ok: false, error: "offline" };
  const appBaseUrl = typeof window !== "undefined" ? window.location.origin : undefined;
  const { data, error } = await db.functions.invoke("send-evaluator-email", {
    body: { examId, evaluators: withEmail, dueDate, reportCount, appBaseUrl },
  });
  return error ? { ok: false, error: error.message } : { ok: true, data };
}
