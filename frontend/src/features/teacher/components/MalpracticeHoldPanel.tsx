import { useEffect, useState } from "react";
import { getResultHold, setResultHold, type ResultHold } from "@/shared/data/api/resultsExport";

/** Withhold one attempt's result pending malpractice review. A held result is
 *  exported to the ERP as "withheld", without marks, until it is released. */
export default function MalpracticeHoldPanel({ attemptId, notify }: { attemptId: string; notify: (m: string) => void }) {
  const [hold, setHold] = useState<ResultHold | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setReason("");
    void getResultHold(attemptId).then((h) => {
      if (!alive) return;
      setHold(h);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [attemptId]);

  const change = async (next: boolean) => {
    setBusy(true);
    const res = await setResultHold(attemptId, next, next ? reason : undefined);
    setBusy(false);
    if (!res.ok) { notify(res.error ?? "Could not change the hold."); return; }
    setHold(next ? { attemptId, reason: reason.trim() || null, heldAt: new Date().toISOString() } : null);
    setReason("");
    notify(next ? "Result withheld for malpractice review. It is exported as withheld until you release it." : "Hold released. The result is exported normally again.");
  };

  return (
    <section className="border-b border-line px-5 py-5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft">Malpractice review</p>
      {!loaded ? (
        <p className="mt-2 text-[12px] text-ink-soft">Checking…</p>
      ) : hold ? (
        <>
          <p className="mt-2 text-[12.5px] text-alert">Result withheld{hold.reason ? `: ${hold.reason}` : ""}.</p>
          <p className="mt-1 text-[11px] text-ink-soft">The ERP export lists this student as withheld, without marks.</p>
          <button disabled={busy} onClick={() => void change(false)} className="mt-3 border border-line-strong bg-paper px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-soft enabled:hover:border-forest enabled:hover:text-ink disabled:opacity-50">Release hold</button>
        </>
      ) : (
        <>
          <label className="mt-2 block text-[11px] text-ink-soft">Reason (optional)
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. Phone seen at 10:42" className="mt-1 block w-full border border-line bg-paper px-2.5 py-1.5 text-[12px] outline-none focus:border-forest" />
          </label>
          <button disabled={busy} onClick={() => void change(true)} className="mt-3 border border-alert/60 bg-paper px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-alert enabled:hover:bg-alert/5 disabled:opacity-50">Withhold result</button>
        </>
      )}
    </section>
  );
}
