/** Full-screen overlay for long jobs (PDF, ZIP) so progress cannot be missed. */
export default function JobBanner({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[200] flex items-center justify-center px-6"
      style={{ background: "rgba(26, 24, 20, 0.45)" }}
    >
      <div className="flex w-full max-w-md items-start gap-4 border border-forest bg-paper px-6 py-5">
        <span className="relative mt-0.5 block h-6 w-6 shrink-0" aria-hidden>
          <span className="absolute inset-0 animate-spin rounded-full border-2 border-line border-t-forest" />
        </span>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-forest">Working</p>
          <p className="mt-1 text-[15px] text-ink">{label}</p>
          <p className="mt-2 text-[12px] text-soft">Keep this tab open. Large reports download every stored snapshot.</p>
        </div>
      </div>
    </div>
  );
}
