import { useEffect, useRef, useState } from "react";
import { startVoiceListen, voiceRoom, type VoiceListenHandle } from "../lib/proctorVoice";

/**
 * While the exam runs, subscribe to this candidate's own announcement channel
 * (voice-<exam>-<roll>). When the proctor presses "Speak to candidate" the
 * audio plays here and an amber chip appears. Silent no-op when LiveKit or the
 * session isn't configured, so the exam UI is never blocked by voice.
 */
export default function InvigilatorVoice({
  examId,
  roll,
  active,
}: {
  examId: string;
  roll: string;
  /** Only listen while the candidate is actually sitting the exam. */
  active: boolean;
}) {
  const [speaking, setSpeaking] = useState(false);
  const handleRef = useRef<VoiceListenHandle | null>(null);

  useEffect(() => {
    if (!active || !examId || !roll) return;
    let cancelled = false;
    (async () => {
      const handle = await startVoiceListen({
        room: voiceRoom(examId, roll),
        onSpeaking: (on) => { if (!cancelled) setSpeaking(on); },
      });
      if (cancelled) { handle?.stop(); return; }
      handleRef.current = handle;
    })();
    return () => {
      cancelled = true;
      handleRef.current?.stop();
      handleRef.current = null;
      setSpeaking(false);
    };
  }, [active, examId, roll]);

  if (!speaking) return null;

  return (
    <div className="flex items-center gap-2 border border-amber/60 bg-amber/10 px-3 py-2">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber" />
      <span className="font-mono text-[9px] uppercase tracking-widest text-amber">Invigilator speaking</span>
      <span className="text-[11px] text-ink-soft">— listen carefully</span>
    </div>
  );
}

// Re-export so callers can preview whether voice is possible without importing
// the whole lib.
export { voiceRoom };
