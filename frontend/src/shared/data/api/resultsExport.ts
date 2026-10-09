// Domain module: results export for the university ERP, and malpractice holds
// that keep a result out of it. The export runs in the results-export edge
// function, which also writes the audit entry; holds go through the
// set_result_hold database function, which checks the exam's owner and logs.

import { getSupabase } from "@/shared/data/supabase";

export type ExportScope =
  | { scope: "exam"; examId: string }
  | { scope: "programme"; programme: string; semester: string };
export type ExportFormat = "csv" | "xlsx";

export type ExportSummary = {
  rows: number;
  pending: number;
  absent: number;
  withheld: number;
  exams: { id: string; name: string; rows: number; pending: number }[];
  skipped: { id: string; name: string; reason: "not_released" }[];
};

const ERRORS: Record<string, string> = {
  teachers_only: "Only teachers can export results.",
  not_your_exam: "You can only export your own exams.",
  exam_not_found: "That exam no longer exists.",
  not_released: "Results are not released yet, so there is nothing to export.",
  no_exams: "None of your exams are set to this programme and semester. Set them under Test options → Results & ERP.",
  programme_and_semester_required: "Pick a programme and a semester.",
  server_error: "The export failed on the server. Try again.",
};

async function functionError(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    const body = await ctx.json().catch(() => null) as { error?: string } | null;
    if (body?.error) return ERRORS[body.error] ?? body.error;
  }
  return "Could not reach the export service.";
}

function saveFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download the ERP results file. Resolves with what was included. */
export async function exportResults(scope: ExportScope, format: ExportFormat): Promise<{ ok: true; summary: ExportSummary; filename: string } | { ok: false; error: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "Offline: connect to the database to export results." };
  const { data, error } = await db.functions.invoke("results-export", { body: { ...scope, format } });
  if (error) return { ok: false, error: await functionError(error) };
  const res = data as { filename: string; mime: string; encoding: "utf8" | "base64"; content: string; summary: ExportSummary };
  const blob = res.encoding === "base64"
    ? new Blob([Uint8Array.from(atob(res.content), (c) => c.charCodeAt(0))], { type: res.mime })
    : new Blob([res.content], { type: res.mime });
  saveFile(res.filename, blob);
  return { ok: true, summary: res.summary, filename: res.filename };
}

export type ResultHold = { attemptId: string; reason: string | null; heldAt: string };

export async function getResultHold(attemptId: string): Promise<ResultHold | null> {
  const db = getSupabase();
  if (!db) return null;
  const { data } = await db.from("result_holds").select("attempt_id, reason, held_at").eq("attempt_id", attemptId).maybeSingle();
  return data ? { attemptId: String(data.attempt_id), reason: data.reason ?? null, heldAt: String(data.held_at) } : null;
}

/** Withhold (or release) one attempt's result pending malpractice review. */
export async function setResultHold(attemptId: string, hold: boolean, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: "Offline" };
  const { data, error } = await db.rpc("set_result_hold", { p_attempt: attemptId, p_hold: hold, p_reason: reason ?? null });
  if (error) return { ok: false, error: error.message };
  if (data === "forbidden") return { ok: false, error: "Only the exam's teacher or an admin can change this." };
  if (data === "not_found") return { ok: false, error: "That attempt no longer exists." };
  return { ok: true };
}
