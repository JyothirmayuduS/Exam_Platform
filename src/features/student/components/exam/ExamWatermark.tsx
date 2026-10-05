/**
 * Candidate-identifying watermark over the exam screen. It sits above the
 * question panels (pointer-events: none) so any photo or screenshot of a
 * question carries the candidate's identity, but stays light enough to read
 * through.
 */
export default function ExamWatermark({ primary, secondary }: { primary: string; secondary?: string }) {
  const width = Math.max(340, Math.max(primary.length * 8.4, (secondary?.length ?? 0) * 6.4) + 140);
  const height = 190;
  const mark = (x: number, y: number) => (
    <g transform={`translate(${x} ${y})`}>
      <text fontSize="12.5" fontWeight="600" letterSpacing="1.6" fontFamily="Inter, system-ui, sans-serif">
        {primary.toUpperCase()}
      </text>
      {secondary && (
        <text y="17" fontSize="9.5" letterSpacing="1" fontFamily="'IBM Plex Mono', ui-monospace, monospace" opacity="0.8">
          {secondary}
        </text>
      )}
    </g>
  );
  return (
    <svg aria-hidden className="pointer-events-none fixed inset-0 z-[60] h-full w-full select-none">
      <defs>
        <pattern id="exam-watermark" width={width} height={height} patternUnits="userSpaceOnUse" patternTransform="rotate(-24)">
          <g fill="#284B34" fillOpacity="0.075">
            {mark(24, 52)}
            {mark(24 + width / 2, 52 + height / 2)}
            {mark(24 - width / 2, 52 + height / 2)}
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#exam-watermark)" />
    </svg>
  );
}
