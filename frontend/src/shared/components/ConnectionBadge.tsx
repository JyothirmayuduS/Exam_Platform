import type { ConnectionState } from "@/shared/services/lowBandwidth";

const LABEL: Record<ConnectionState, string> = { good: "Connection good", weak: "Connection weak", lost: "Connection lost" };
const SHORT: Record<ConnectionState, string> = { good: "Good", weak: "Weak", lost: "Lost" };
const TONE: Record<ConnectionState, string> = {
  good: "border-success/40 text-success",
  weak: "border-amber/50 text-amber",
  lost: "border-alert/50 text-alert",
};
const DOT: Record<ConnectionState, string> = { good: "bg-success", weak: "bg-amber", lost: "bg-alert animate-pulse" };

/** Good / weak / lost pill shown to the student and to the proctor. */
export default function ConnectionBadge({ state, compact = false, className = "" }: { state: ConnectionState; compact?: boolean; className?: string }) {
  return (
    <span
      role="status"
      aria-label={LABEL[state]}
      data-connection={state}
      className={`inline-flex items-center gap-1.5 border bg-paper px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${TONE[state]} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-none ${DOT[state]}`} aria-hidden />
      {compact ? SHORT[state] : LABEL[state]}
    </span>
  );
}
