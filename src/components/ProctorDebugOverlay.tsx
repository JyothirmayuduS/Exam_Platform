// ProctorDebugOverlay.tsx — development-only diagnostic overlay for the AI
// engine. Shows the raw signals the models produce (face count, gaze, tracked
// objects + confidence, audio level, risk) so you can SEE why a flag did or
// did not fire while testing detection. It is never rendered unless explicitly
// enabled (VITE_PROCTOR_DEBUG=1 or ?proctorDebug=1 on the URL), so candidates
// never see it.

import { useEffect, useState } from "react";
import { proctorDiag } from "../proctoring";

export default function ProctorDebugOverlay({ enabled }: { enabled: boolean }) {
  const [, setTick] = useState(0);

  // Poll the diag sink — the AI loop writes outside React, so this is a cheap
  // timer read, not a render storm.
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(id);
  }, [enabled]);

  if (!enabled) return null;

  const d = proctorDiag;
  const riskColor =
    d.risk.level === "critical" ? "text-red-400" :
    d.risk.level === "high" ? "text-orange-300" :
    d.risk.level === "low" ? "text-amber-200" : "text-emerald-300";

  return (
    <div className="pointer-events-none fixed bottom-4 right-3 z-[80] w-[290px] rounded border border-amber-400/60 bg-[#111] p-2 font-mono text-[9px] leading-relaxed text-amber-100 shadow-xl">
      <p className="mb-1 border-b border-white/10 pb-1 font-semibold tracking-widest text-amber-300">
        AI ENGINE {d.engineError ? "· ERROR" : ""}
      </p>
      {d.engineError ? (
        <p className="text-red-300">{d.engineError}</p>
      ) : (
        <>
          <Row k="step" v={d.loadStep} />
          <Row k="fps" v={String(d.fps)} />
          <Row k="face" v={String(d.faceCount)} />
          <Row k="gaze" v={`${d.gazeDirection.toUpperCase()} ${Math.round(d.gazeScore * 100)}%`} />
          <Row k="audio" v={d.voiceSpeaking ? `VOICE ${Math.round(d.voiceLevel * 100)}%` : `${Math.round(d.voiceLevel * 100)}%`} />
          <div className="mt-0.5 flex justify-between border-t border-white/10 pt-0.5">
            <span>RISK</span>
            <span className={riskColor}>{d.risk.score} · {d.risk.level.toUpperCase()}</span>
          </div>
          <div className="mt-0.5 border-t border-white/10 pt-0.5">
            <span className="text-white/60">TRACKS</span>
            {d.tracks.length === 0 ? (
              <p className="text-white/40">(none)</p>
            ) : (
              d.tracks.map((t) => (
                <p key={t.id}>
                  #{t.id} {t.kind} · {Math.round(t.lastScore * 100)}% · hits {t.hits} · miss {t.misses}
                  {t.confirmed ? " · CONFIRMED" : ""}
                </p>
              ))
            )}
          </div>
          <div className="mt-0.5 border-t border-white/10 pt-0.5">
            <span className="text-white/60">OBJECT SAMPLES</span>
            {d.objectSamples.length === 0 ? (
              <p className="text-white/40">(none)</p>
            ) : (
              d.objectSamples.slice(-5).map((s, i) => <p key={i} className="truncate text-white/70">{s}</p>)
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-white/60">{k.toUpperCase()}</span>
      <span className="truncate pl-2">{v}</span>
    </div>
  );
}
