// AIIntegrityCard.tsx — per-attempt AI proctoring report.
//
// Calls the proctor-ai-report Edge Function (LLM summary over the real
// violation timeline, cached in ai_reports) and renders the verdict: risk
// score, summary and the key incidents. Degrades gracefully when the report
// backend is not configured yet (LLM_API_KEY secret unset).

import { useEffect, useState } from "react";
import { getSupabase } from "../lib/supabase";

type Report = {
  risk_score?: number;
  verdict?: "clean" | "review" | "flagged" | string;
  summary?: { summary?: string; incidents?: { type?: string; severity?: string; at?: string; note?: string }[] };
};

type Tone = "text-success" | "text-amber" | "text-alert";

function toneFor(verdict?: string, score?: number): { tone: Tone; label: string; chip: string } {
  const v = verdict ?? (score != null ? (score >= 75 ? "flagged" : score >= 30 ? "review" : "clean") : "review");
  if (v === "clean") return { tone: "text-success", label: "Clean", chip: "border-success/40 bg-success/5 text-success" };
  if (v === "flagged") return { tone: "text-alert", label: "Flagged", chip: "border-alert/40 bg-alert/5 text-alert" };
  return { tone: "text-amber", label: "Review", chip: "border-amber/40 bg-amber/5 text-amber" };
}

export default function AIIntegrityCard({ attemptId }: { attemptId: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<"idle" | "error" | "unconfigured">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const load = async (regenerate = false) => {
    const db = getSupabase();
    if (!db || !attemptId) return;
    setLoading(true);
    setState("idle");
    try {
      const { data, error } = await db.functions.invoke("proctor-ai-report", {
        body: { attemptId, regenerate },
      });
      if (error) {
        const msg = String(error.message ?? "");
        if (/not configured/i.test(msg) || /503/i.test(msg)) {
          setState("unconfigured");
        } else {
          setState("error");
          setErrorMsg(msg);
        }
        setLoading(false);
        return;
      }
      const rep = (data as { report?: Report })?.report ?? null;
      if (rep) setReport(rep);
      setLoading(false);
    } catch (err) {
      setState("error");
      setErrorMsg(String(err));
      setLoading(false);
    }
  };

  // Auto-load once an attempt is in review.
  useEffect(() => {
    setReport(null);
    setState("idle");
    if (attemptId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  const meta = toneFor(report?.verdict, report?.risk_score);
  const incidents = report?.summary?.incidents ?? [];

  return (
    <div className="border border-line bg-paper">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink">AI Integrity Report</span>
          {report && (
            <span className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${meta.chip}`}>
              {meta.label}
            </span>
          )}
        </div>
        <button
          onClick={() => void load(true)}
          disabled={loading}
          className="font-mono text-[9px] uppercase tracking-wider text-ink-soft underline-offset-2 hover:text-forest hover:underline disabled:opacity-40"
        >
          {loading ? "Analysing…" : report ? "Regenerate" : "Generate"}
        </button>
      </div>

      <div className="px-4 py-3">
        {loading && (
          <p className="flex items-center gap-2 text-[12px] text-ink-soft">
            <span className="h-3 w-3 animate-spin rounded-full border border-forest border-t-transparent" />
            Summarising the violation timeline…
          </p>
        )}

        {!loading && state === "unconfigured" && (
          <p className="text-[12px] leading-relaxed text-ink-soft">
            AI integrity report is not configured on this deployment. Set the{" "}
            <code className="font-mono text-[11px] text-ink">LLM_API_KEY</code> secret on the{" "}
            <code className="font-mono text-[11px] text-ink">proctor-ai-report</code> function to enable it.
          </p>
        )}
        {!loading && state === "error" && (
          <p className="text-[12px] text-alert">Report unavailable: {errorMsg || "unknown error"}</p>
        )}

        {!loading && state === "idle" && report && (
          <div className="space-y-3">
            <div className="flex items-end gap-6">
              <div>
                <p className={`font-serif text-[40px] leading-none ${meta.tone}`}>{report.risk_score ?? 0}</p>
                <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-ink-soft">Risk score / 100</p>
              </div>
              {report.summary?.summary && (
                <p className="max-w-md flex-1 text-[12px] leading-relaxed text-ink">{report.summary.summary}</p>
              )}
            </div>

            {incidents.length > 0 && (
              <div>
                <p className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-ink-soft">
                  Key incidents ({incidents.length})
                </p>
                <ul className="space-y-1">
                  {incidents.slice(0, 8).map((inc, i) => (
                    <li key={i} className="flex items-start justify-between gap-3 border border-line/60 px-2.5 py-1.5">
                      <span className="min-w-0 text-[11px] text-ink">
                        <span className="text-ink-soft">{String(inc.type ?? "event").toUpperCase()}</span>
                        {inc.note ? <span className="text-ink-soft"> — {inc.note}</span> : null}
                      </span>
                      <span className="shrink-0 font-mono text-[9px] text-ink-soft">
                        {inc.at ? String(inc.at).slice(11, 19) : ""} · {String(inc.severity ?? "medium").toLowerCase()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {incidents.length === 0 && report.risk_score === 0 && (
              <p className="text-[12px] text-ink-soft">No integrity incidents in the violation timeline.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
