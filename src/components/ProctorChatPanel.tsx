// Proctor team chat — fully DB-backed (proctor_messages) with realtime updates.
// Used by the Teacher proctoring console and (via broadcast) by students.

import { useEffect, useRef, useState } from "react";
import {
  listProctorMessages,
  sendProctorMessage,
  subscribeToMessages,
  type ProctorMessage,
} from "../lib/examApi";
import { supabaseConfigured } from "../lib/env";

export default function ProctorChatPanel({
  examId,
  senderName = "Proctor",
  senderRole = "proctor",
  onCountChange,
  maxHeight = 320,
}: {
  examId: string;
  senderName?: string;
  senderRole?: "proctor" | "teacher";
  onCountChange?: (count: number) => void;
  maxHeight?: number;
}) {
  const [messages, setMessages] = useState<ProctorMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const load = () => {
    if (!supabaseConfigured) return;
    void listProctorMessages(examId).then((rows) => {
      setMessages(rows);
      onCountChange?.(rows.filter((m) => m.kind === "message").length);
    });
  };

  useEffect(() => {
    load();
    const unsub = subscribeToMessages(examId, load);
    return () => { unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    const ok = await sendProctorMessage({
      examId,
      sender: senderName,
      senderRole,
      body,
      kind: "message",
    });
    setSending(false);
    if (ok) {
      setDraft("");
      load();
    }
  };

  return (
    <section className="flex h-full flex-col border border-line bg-paper">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Team communication</p>
        <span className="font-mono text-[9px] text-ink-soft">{supabaseConfigured ? "● live" : "○ offline"}</span>
      </div>
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-3" style={{ maxHeight }}>
        {messages.length === 0 && (
          <p className="py-8 text-center font-mono text-[11px] text-ink-soft">
            No messages yet — send the first note to your proctor team.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex gap-2 ${m.kind === "broadcast" ? "border border-amber/40 bg-amber/5 p-2" : ""}`}>
            <div className="min-w-0">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ink-soft">
                {m.sender} · {m.sender_role}{m.kind === "broadcast" ? " · Broadcast" : ""}
              </p>
              <p className="mt-0.5 text-[12px]">{m.body}</p>
              <p className="mt-0.5 font-mono text-[9px] text-ink-soft/70">
                {new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
          placeholder="Type a message to the proctor team..."
          className="min-w-0 flex-1 border border-line-strong bg-paper px-3 py-2 font-mono text-[11px] uppercase placeholder:text-ink/30 focus:border-forest focus:outline-none"
        />
        <button
          onClick={() => void send()}
          disabled={!draft.trim() || sending}
          className="border border-forest bg-forest px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-paper hover:bg-forest-light disabled:cursor-not-allowed disabled:border-line disabled:bg-line disabled:text-ink-soft"
        >
          {sending ? "…" : "Send"}
        </button>
      </div>
    </section>
  );
}