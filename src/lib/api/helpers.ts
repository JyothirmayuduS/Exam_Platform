// Shared normalization + derivation helpers extracted from src/lib/examApi.ts.
// These are internal building blocks — domain modules import from here instead
// of re-implementing row-shaping logic. They are not part of the public API
// barrel (helpers stay private to the api layer).

import type { ExamRecord } from "./types";
import type { ViolationSeverity, ViolationSource } from "./types";

/** Options come back as jsonb (array) — guard against string/null shapes. */
export function normalizeOptions(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return raw.map((o) => String(o));
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((o) => String(o)) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeFaq(
  raw: unknown,
): { question: string; answer: string }[] | null {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        const q = String((item as { question?: unknown }).question ?? "").trim();
        const a = String((item as { answer?: unknown }).answer ?? "").trim();
        return q && a ? { question: q, answer: a } : null;
      })
      .filter((item): item is { question: string; answer: string } => !!item);
  }
  return null;
}

export function normalizeExamRecord(record: ExamRecord): ExamRecord {
  return {
    ...record,
    faq: normalizeFaq(record.faq),
  };
}

// Severity + source implied by the violation type, so proctor actions and AI
// flags don't all collapse into a generic "warning".
export function severityForType(violationType: string): ViolationSeverity {
  const t = violationType.toLowerCase();
  if (t.includes("escalat") || t.includes("critical") || t.includes("second_face") || t.includes("prohibited") || t.includes("multiple_face")) return "critical";
  if (t.includes("pause") || t.includes("force_submit") || t.includes("phone") || t.includes("no_face") || t.includes("camera_lost") || t.includes("tab") || t.includes("audio")) return "high";
  return "warning";
}

export function sourceForType(violationType: string): ViolationSource {
  const t = violationType.toLowerCase();
  if (t.startsWith("[ai]")) return "ai";
  if (t.startsWith("proctor_")) return "proctor";
  if (t.startsWith("[system]")) return "system";
  return "student";
}

/** True when a string is a real uuid (not an `enrolled-…` placeholder). */
export function isRealUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
