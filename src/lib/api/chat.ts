// ──────────────────────────────────────────────────────────────────────────
// Domain module: chat — extracted from src/lib/examApi.ts.
// ──────────────────────────────────────────────────────────────────────────

import { getSupabase } from "../supabase";
import type { ProctorMessage } from "./types";

export async function listProctorMessages(examId: string): Promise<ProctorMessage[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("proctor_messages")
    .select("*")
    .eq("exam_id", examId)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data as unknown[]).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      exam_id: String(r.exam_id),
      sender: String(r.sender ?? "Proctor"),
      sender_role: String(r.sender_role ?? "proctor"),
      body: String(r.body ?? ""),
      kind: (r.kind as ProctorMessage["kind"]) ?? "message",
      created_at: String(r.created_at),
    };
  });
}


export async function sendProctorMessage(opts: {
  examId: string;
  sender: string;
  senderRole: string;
  body: string;
  kind?: "message" | "broadcast";
}): Promise<boolean> {
  const db = getSupabase();
  if (!db || !opts.body.trim()) return false;
  const { error } = await db.from("proctor_messages").insert({
    exam_id: opts.examId,
    sender: opts.sender.slice(0, 80),
    sender_role: opts.senderRole === "proctor" ? "proctor" : opts.senderRole === "teacher" ? "teacher" : "proctor",
    body: opts.body.trim().slice(0, 500),
    kind: opts.kind === "broadcast" ? "broadcast" : "message",
  });
  return !error;
}

/** Realtime: fire `onChange` whenever a new message/broadcast lands for an exam. */


export function subscribeToMessages(examId: string, onChange: () => void): () => void {
  const db = getSupabase();
  if (!db) return () => undefined;
  const channel = db
    .channel(`messages-${examId}-${Math.random().toString(36).slice(2)}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "proctor_messages", filter: `exam_id=eq.${examId}` },
      () => onChange(),
    )
    .subscribe();
  return () => { void db.removeChannel(channel); };
}

// ── Proctor assignments (Assign Proctors modal) ──────────────────────────────
