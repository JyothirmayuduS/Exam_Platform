import { KIND_LABEL, type QuestionKind } from "./questionKind";

export type NegativeMode = "fixed" | "fraction";

/** Negative-marking fields stored in `exams.settings`. */
export type NegativeSettings = {
  negative?: boolean;
  negativeMode?: NegativeMode;
  /** Marks deducted per wrong answer when mode is "fixed". */
  negativeMarks?: number;
  /** Share of the question's marks deducted when mode is "fraction" (0.25 = ¼). */
  negativeFraction?: number;
  /** Kinds that carry a penalty. Absent = every objective kind. */
  negativeKinds?: QuestionKind[];
};

export const NEGATIVE_KINDS: QuestionKind[] = ["mcq", "msq", "truefalse", "numerical"];

export const NEGATIVE_DEFAULTS: Required<Omit<NegativeSettings, "negative">> = {
  negativeMode: "fraction",
  negativeMarks: 1,
  negativeFraction: 0.25,
  negativeKinds: NEGATIVE_KINDS,
};

export type Verdict = "correct" | "wrong" | "unanswered";

const toIndex = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v);
  return null;
};

const toIndexSet = (v: unknown): number[] => {
  let list: unknown = v;
  if (typeof v === "string") {
    try { list = JSON.parse(v); } catch { list = v.split(/[;,]/); }
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(toIndex).filter((n): n is number => n !== null))].sort((a, b) => a - b);
};

const isBlank = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

/** Numbers compare numerically ("2.50" equals "2.5"); anything else as
 *  trimmed, case-insensitive text. */
export function numericEqual(response: unknown, key: unknown): boolean {
  const a = String(response ?? "").trim();
  const b = String(key ?? "").trim();
  if (!a || !b) return false;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(nb));
  return a.toLowerCase() === b.toLowerCase();
}

/** Compare a response with the answer key. Only meaningful for objective kinds. */
export function gradeObjective(kind: QuestionKind, key: unknown, response: unknown): Verdict {
  if (isBlank(response)) return "unanswered";
  switch (kind) {
    case "mcq":
    case "truefalse": {
      const chosen = toIndex(response);
      if (chosen === null) return "unanswered";
      return chosen === toIndex(key) ? "correct" : "wrong";
    }
    case "msq": {
      const chosen = toIndexSet(response);
      if (chosen.length === 0) return "unanswered";
      const correct = toIndexSet(key);
      return chosen.length === correct.length && chosen.every((v, i) => v === correct[i]) ? "correct" : "wrong";
    }
    case "numerical":
      return numericEqual(response, key) ? "correct" : "wrong";
    default:
      return "unanswered";
  }
}

/** Marks deducted for one wrong answer (a positive number, 0 when off). */
export function penaltyFor(kind: QuestionKind, marks: number, settings: NegativeSettings | null | undefined): number {
  if (!settings?.negative) return 0;
  const kinds = settings.negativeKinds ?? NEGATIVE_DEFAULTS.negativeKinds;
  if (!kinds.includes(kind)) return 0;
  const mode = settings.negativeMode ?? NEGATIVE_DEFAULTS.negativeMode;
  const raw = mode === "fixed"
    ? Number(settings.negativeMarks ?? NEGATIVE_DEFAULTS.negativeMarks)
    : marks * Number(settings.negativeFraction ?? NEGATIVE_DEFAULTS.negativeFraction);
  return Number.isFinite(raw) && raw > 0 ? round2(raw) : 0;
}

/** Score of one objective answer: full marks, a deduction, or 0 when skipped. */
export function scoreObjective(kind: QuestionKind, marks: number, verdict: Verdict, settings?: NegativeSettings | null): number {
  if (verdict === "correct") return marks;
  const penalty = verdict === "wrong" ? penaltyFor(kind, marks, settings) : 0;
  return penalty ? -penalty : 0;
}

/** Paper total, never below zero. */
export function paperTotal(scores: number[]): number {
  return Math.max(0, round2(scores.reduce((a, b) => a + b, 0)));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const FRACTION_LABEL: Record<string, string> = { "0.25": "1/4", "0.33": "1/3", "0.5": "1/2", "1": "full" };

/** One-line rule for candidates and teachers, or null when marking is off. */
export function describeNegative(settings: NegativeSettings | null | undefined): string | null {
  if (!settings?.negative) return null;
  const kinds = settings.negativeKinds ?? NEGATIVE_DEFAULTS.negativeKinds;
  if (kinds.length === 0) return null;
  const mode = settings.negativeMode ?? NEGATIVE_DEFAULTS.negativeMode;
  const amount = mode === "fixed"
    ? `${round2(Number(settings.negativeMarks ?? NEGATIVE_DEFAULTS.negativeMarks))} mark(s)`
    : (() => {
        const f = round2(Number(settings.negativeFraction ?? NEGATIVE_DEFAULTS.negativeFraction));
        const label = FRACTION_LABEL[String(f)];
        return label === "full" ? "the question's full marks" : `${label ?? `${f * 100}%`} of the question's marks`;
      })();
  const scope = kinds.length === NEGATIVE_KINDS.length ? "objective questions" : kinds.map((k) => KIND_LABEL[k]).join(", ");
  return `Wrong answers on ${scope} deduct ${amount}. Unanswered questions are not penalised.`;
}
