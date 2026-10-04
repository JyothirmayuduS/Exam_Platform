/** Sticky status strip for long jobs (PDF, ZIP) so progress stays visible while scrolling. */
export default function JobBanner({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-14 z-20 mb-4 flex items-center gap-3 border border-forest/30 bg-forest/10 px-4 py-3"
    >
      <span className="relative block h-4 w-4 shrink-0" aria-hidden>
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-forest" />
      </span>
      <p className="text-[13px] text-ink">{label}</p>
    </div>
  );
}
