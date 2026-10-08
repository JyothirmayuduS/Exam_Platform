import { useState } from "react";
import { extendAttemptTime, MAX_LIVE_EXTRA_MINUTES } from "@/shared/data/examApi";

/** "+7 min" for time added during the exam, with the Candidates-tab
 *  accommodation alongside when there is one. Empty when neither is set. */
export function extraTimeLabel(extraMinutes: number, accommodationMinutes = 0): string {
  const parts: string[] = [];
  if (extraMinutes > 0) parts.push(`+${extraMinutes} min extra`);
  if (accommodationMinutes > 0) parts.push(`+${accommodationMinutes} min accommodation`);
  return parts.join(" · ");
}

/** Extra-time badge for a live row. Renders nothing when no time was added. */
export function ExtraTimeBadge({ extraMinutes, accommodationMinutes = 0, className = "" }: { extraMinutes: number; accommodationMinutes?: number; className?: string }) {
  const label = extraTimeLabel(extraMinutes, accommodationMinutes);
  if (!label) return null;
  return <span className={`font-mono text-[9px] text-forest ${className}`} data-testid="extra-time-badge">{label}</span>;
}

/**
 * Extra time for the selected candidate: always shows the minutes already
 * added; the add control appears only for the teacher who owns the exam while
 * the attempt is live. Proctors see the minutes read-only.
 */
export function LiveExtraTimeControl({
  attemptId,
  live,
  canAdd,
  extraMinutes,
  accommodationMinutes = 0,
  onAdded,
  onMessage,
}: {
  attemptId: string | null;
  live: boolean;
  canAdd: boolean;
  extraMinutes: number;
  accommodationMinutes?: number;
  onAdded?: (totalExtra: number) => void;
  onMessage?: (text: string, tone: "ok" | "err") => void;
}) {
  const [minutes, setMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const label = extraTimeLabel(extraMinutes, accommodationMinutes);

  const add = async () => {
    if (!attemptId || busy) return;
    setBusy(true);
    const res = await extendAttemptTime(attemptId, minutes);
    setBusy(false);
    if (res.ok) {
      onAdded?.(res.extraMinutes);
      onMessage?.(`Added ${minutes} min · ${res.extraMinutes} min extra in total`, "ok");
    } else {
      onMessage?.(res.message, "err");
    }
  };

  return (
    <div className="border border-line bg-paper-raised p-3" data-testid="live-extra-time">
      <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Extra time</p>
      <p className="mt-1 text-[12px]">{label || "None added"}</p>
      {canAdd && live && attemptId ? (
        <div className="mt-2 flex items-center gap-2">
          <label className="sr-only" htmlFor={`extra-${attemptId}`}>Minutes to add</label>
          <input
            id={`extra-${attemptId}`}
            type="number"
            min={1}
            max={MAX_LIVE_EXTRA_MINUTES}
            value={minutes}
            onChange={(e) => setMinutes(Math.max(1, Math.min(MAX_LIVE_EXTRA_MINUTES, Number(e.target.value) || 1)))}
            className="w-16 border border-line-strong bg-paper px-2 py-1.5 font-mono text-[11px]"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void add()}
            className="flex-1 border border-forest bg-forest/5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-forest hover:bg-forest hover:text-paper disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add minutes"}
          </button>
        </div>
      ) : !canAdd ? (
        <p className="mt-1 font-mono text-[9px] text-ink-soft">Only the teacher who owns this exam can add time.</p>
      ) : null}
    </div>
  );
}
