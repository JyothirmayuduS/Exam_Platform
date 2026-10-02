type SealProps = {
  label: string;
  sublabel?: string;
  tone?: "maroon" | "forest" | "amber" | "alert";
  size?: number;
};

const toneMap: Record<string, { ring: string; text: string }> = {
  maroon: { ring: "#7A1F2B", text: "#7A1F2B" },
  forest: { ring: "#284B34", text: "#284B34" },
  amber: { ring: "#B7791F", text: "#B7791F" },
  alert: { ring: "#9B2C2C", text: "#9B2C2C" },
};

/**
 * The platform's signature mark: a circular exam-hall "seal", the way an
 * invigilator would stamp an attendance sheet or answer booklet. Used
 * sparingly — identity verification, room-scan clearance, submission
 * receipts — anywhere a moment needs to feel officially attested.
 */
export default function Seal({ label, sublabel, tone = "forest", size = 76 }: SealProps) {
  const c = toneMap[tone];
  const r = size / 2;
  return (
    <div className="inline-flex flex-col items-center gap-1.5" style={{ width: size + 8 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <circle cx={r} cy={r} r={r - 2} fill="none" stroke={c.ring} strokeWidth="1.4" />
        <circle cx={r} cy={r} r={r - 6} fill="none" stroke={c.ring} strokeWidth="1" strokeDasharray="1.5 3" />
        <text
          x={r}
          y={r + 4}
          textAnchor="middle"
          fontFamily="'Source Serif 4', serif"
          fontSize={size * 0.22}
          fontWeight={600}
          fill={c.text}
        >
          ✓
        </text>
      </svg>
      <div className="text-center leading-tight">
        <p className="text-[11px] font-mono uppercase tracking-wider" style={{ color: c.text }}>
          {label}
        </p>
        {sublabel && <p className="text-[10px] text-ink-soft">{sublabel}</p>}
      </div>
    </div>
  );
}
