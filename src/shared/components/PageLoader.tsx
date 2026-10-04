/** Centered page loader — one treatment for auth, paper builder, and evidence. */
export default function PageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-4" role="status" aria-live="polite">
      <span className="relative block h-10 w-10" aria-hidden>
        <span className="absolute inset-0 rounded-full border-2 border-line" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-forest" />
      </span>
      <p className="font-mono text-[11px] uppercase tracking-widest text-soft">{label}</p>
    </div>
  );
}
