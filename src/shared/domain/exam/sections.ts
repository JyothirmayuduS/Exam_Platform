import { KIND_LABEL, QUESTION_KINDS, questionKind } from "./questionKind";

/** Sections are one per question kind, labelled for people ("MCQ",
 *  "Descriptive", …). The label is also the key of `settings.sectionMinutes`. */
export const SECTION_ORDER: string[] = QUESTION_KINDS.map((k) => KIND_LABEL[k]);

export type SectionedQuestion = { type?: string | null; options?: unknown[] | null };

export function sectionOf(q: SectionedQuestion): string {
  return KIND_LABEL[questionKind(q.type, q.options?.length ?? 0)];
}

export type SectionSummary = { name: string; count: number; marks: number };

/** Sections present in a pool, in canonical order, with question and mark totals. */
export function summarizeSections<T extends SectionedQuestion & { marks?: number | null }>(questions: T[]): SectionSummary[] {
  const map = new Map<string, SectionSummary>();
  for (const q of questions) {
    const name = sectionOf(q);
    const cur = map.get(name) ?? { name, count: 0, marks: 0 };
    cur.count += 1;
    cur.marks += q.marks || 1;
    map.set(name, cur);
  }
  return [...map.values()].sort((a, b) => SECTION_ORDER.indexOf(a.name) - SECTION_ORDER.indexOf(b.name));
}

/** Stable grouping: questions of a section become contiguous, sections keep
 *  the order in which they first appear, and order inside a section is kept. */
export function groupBySection<T>(items: T[], section: (item: T) => string): { name: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = section(item);
    const list = groups.get(name);
    if (list) list.push(item);
    else groups.set(name, [item]);
  }
  return [...groups.entries()].map(([name, list]) => ({ name, items: list }));
}

export type SectionWindow = {
  name: string;
  /** First question index (inclusive) in the paper. */
  start: number;
  /** Last question index (exclusive). */
  end: number;
  seconds: number;
};

const MIN_SECTION_SECONDS = 60;

/**
 * Time windows for a sectioned paper. `paperSections` is the section label of
 * every question in paper order (sections must already be contiguous).
 * Sections with configured minutes use them; the rest share whatever is left
 * of the exam duration in proportion to their question count.
 */
export function sectionWindows(
  paperSections: string[],
  sectionMinutes: Record<string, number> | null | undefined,
  durationMinutes: number,
): SectionWindow[] {
  const runs: SectionWindow[] = [];
  paperSections.forEach((name, i) => {
    const last = runs[runs.length - 1];
    if (last && last.name === name) last.end = i + 1;
    else runs.push({ name, start: i, end: i + 1, seconds: 0 });
  });

  const configured = (name: string) => Math.max(0, Number(sectionMinutes?.[name]) || 0);
  const fixedSeconds = runs.reduce((t, r) => t + configured(r.name) * 60, 0);
  const open = runs.filter((r) => configured(r.name) === 0);
  const openQuestions = open.reduce((t, r) => t + (r.end - r.start), 0);
  const leftover = Math.max(0, durationMinutes * 60 - fixedSeconds);

  for (const r of runs) {
    const mins = configured(r.name);
    if (mins > 0) r.seconds = Math.round(mins * 60);
    else {
      const share = openQuestions ? leftover * ((r.end - r.start) / openQuestions) : 0;
      r.seconds = Math.max(MIN_SECTION_SECONDS, Math.floor(share));
    }
  }
  return runs;
}

/** Suggested per-section minutes that add up to `totalMinutes`. */
export function splitMinutes(
  sections: SectionSummary[],
  totalMinutes: number,
  by: "even" | "marks",
): Record<string, number> {
  if (sections.length === 0) return {};
  const weights = sections.map((s) => (by === "marks" ? Math.max(1, s.marks) : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (totalMinutes * w) / sum);
  const out = raw.map((m) => Math.max(1, Math.floor(m)));
  let rest = totalMinutes - out.reduce((a, b) => a + b, 0);
  const order = raw.map((m, i) => ({ i, frac: m - Math.floor(m) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0 && order.length; k = (k + 1) % order.length, rest -= 1) out[order[k].i] += 1;
  return Object.fromEntries(sections.map((s, i) => [s.name, out[i]]));
}
