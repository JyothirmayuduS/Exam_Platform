// ────────────────────────────────────────────────────────────────────────────
// Watermark templates — Test Options → "Custom watermark text".
//
// Teachers write placeholder tokens; each candidate's exam screen renders the
// text with THEIR details substituted, tiled across the page:
//
//   "{registration number} {name}"  →  "221FA12345 Ravi Teja"
//
// Tokens are matched case-insensitively and tolerate the common
// "registraion" typo. Unknown tokens are left untouched so a mistake is
// visible on screen instead of silently disappearing.
// ────────────────────────────────────────────────────────────────────────────

export type WatermarkContext = {
  /** Candidate full name (e.g. "Ravi Teja"). */
  name: string;
  /** Candidate roll / registration number (e.g. "221FA12345"). */
  roll: string;
  email?: string;
  examName?: string;
  examId?: string;
  /** Defaults to "now" at render time. */
  date?: Date;
};

const TOKENS: Record<string, (ctx: WatermarkContext) => string> = {
  "name": (c) => c.name,
  "student name": (c) => c.name,
  "candidate name": (c) => c.name,
  "registration number": (c) => c.roll,
  "registraion number": (c) => c.roll, // common typo — accept it
  "registration": (c) => c.roll,
  "reg no": (c) => c.roll,
  "reg number": (c) => c.roll,
  "roll number": (c) => c.roll,
  "roll no": (c) => c.roll,
  "roll": (c) => c.roll,
  "usn": (c) => c.roll,
  "email": (c) => c.email ?? "",
  "exam": (c) => c.examName ?? "",
  "exam name": (c) => c.examName ?? "",
  "exam id": (c) => c.examId ?? "",
  "date": (c) => (c.date ?? new Date()).toLocaleDateString(),
  "time": (c) => (c.date ?? new Date()).toLocaleTimeString(),
};

const TOKEN_RE = /\{\s*([^{}]+?)\s*\}/g;

/**
 * Substitute `{token}` placeholders in a watermark template. Returns "" for an
 * empty template so callers can fall back to their default watermark.
 */
export function renderWatermarkTemplate(template: string, ctx: WatermarkContext): string {
  if (!template || !template.trim()) return "";
  const out = template.replace(TOKEN_RE, (whole, rawKey: string) => {
    const token = TOKENS[rawKey.trim().toLowerCase()];
    return token ? token(ctx) : whole; // unknown token → keep it visible
  });
  // Collapse whitespace runs left behind by empty substitutions.
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/** The classic fallback: "Name · ROLL" (used when no custom watermark is set). */
export function defaultWatermarkText(ctx: Pick<WatermarkContext, "name" | "roll">): string {
  return `${ctx.name} · ${ctx.roll}`;
}
