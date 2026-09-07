import React, { useState, useEffect, useRef } from "react";
import { getSupabase } from "../../lib/supabase";

export default function ProctorChat({ examId }: { examId: string }) {
  const [messages, setMessages] = useState<{ text: string; from: "proctor" | "student"; t: string }[]>([]);
  const [input, setInput] = useState("");
  const channel = useRef<any>(null);

  useEffect(() => {
    const db = getSupabase();
    if (!db) return;
    const ch = db.channel(`proctor_chat:${examId}`);
    ch.on("broadcast", { event: "msg" }, (payload: any) => {
      setMessages((m) => [...m, { text: payload.text, from: payload.from, t: new Date().toISOString() }]);
    });
    ch.subscribe();
    channel.current = ch;
    return () => { ch.unsubscribe(); };
  }, [examId]);

  const send = () => {
    if (!input.trim() || !channel.current) return;
    channel.current.send({ type: "broadcast", event: "msg", payload: { text: input.trim(), from: "proctor" } });
    setMessages((m) => [...m, { text: input.trim(), from: "proctor", t: new Date().toISOString() }]);
    setInput("");
  };

  return (
    <div className="border border-line rounded-md bg-paper p-3 h-64 flex flex-col">
      <div className="font-mono text-[10px] text-ink-soft mb-2">Live Proctor Chat — exam {examId}</div>
      <div className="flex-1 overflow-auto text-[11px] font-mono mb-2 space-y-1">
        {messages.map((m, i) => (
          <div key={i} className={m.from === "proctor" ? "text-forest" : "text-ink-soft"}>
            [{m.from}] {m.text}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} className="flex-1 border border-line rounded px-2 py-1 text-[11px]" placeholder="Message..." />
        <button onClick={send} className="bg-forest text-paper px-2 py-1 rounded text-[11px]">Send</button>
      </div>
    </div>
  );
}
