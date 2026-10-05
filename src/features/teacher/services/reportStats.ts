import type { DBQuestion, PaperSlot } from "@/shared/data/examApi";
import {
  KIND_LABEL,
  gradeObjective,
  isAutoGraded,
  questionKind,
  questionsForPaper,
  remapAnswer,
  round2,
  type QuestionKind,
} from "@/shared/domain/exam";

/** Pass line used across the platform (student result page uses the same). */
export const PASS_PERCENT = 40;

type AttemptLike = {
  id: string;
  name: string;
  roll: string;
  state: string;
  answered: number;
  total: number;
  score?: number | null;
  answers?: Record<string, unknown>;
  paper?: unknown;
  flags: unknown[];
};

export type StudentRow = {
  id: string;
  name: string;
  roll: string;
  answered: number;
  total: number;
  score: number | null;
  max: number;
  pct: number | null;
  passed: boolean | null;
  flags: number;
};

export type ItemRow = {
  id: string;
  no: number;
  title: string;
  kind: QuestionKind;
  kindLabel: string;
  marks: number;
  served: number;
  attempted: number;
  /** Objective questions only; null for hand-graded kinds. */
  correct: number | null;
  pctCorrect: number | null;
};

export type ExamReport = {
  submitted: number;
  graded: number;
  rows: StudentRow[];
  mean: number | null;
  median: number | null;
  highest: number | null;
  lowest: number | null;
  passRate: number | null;
  /** Ten 10-point buckets of percentage scores. */
  buckets: number[];
  items: ItemRow[];
};

const blank = (v: unknown) =>
  v == null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

export function buildExamReport(attempts: AttemptLike[], pool: DBQuestion[]): ExamReport {
  const done = attempts.filter((a) => a.state === "Submitted");
  const items = new Map<string, ItemRow>();
  pool.forEach((q, i) => {
    const kind = questionKind(q.type, q.options?.length ?? 0);
    items.set(q.id, {
      id: q.id, no: i + 1, title: q.title, kind, kindLabel: KIND_LABEL[kind], marks: q.marks || 1,
      served: 0, attempted: 0, correct: isAutoGraded(kind) ? 0 : null, pctCorrect: null,
    });
  });

  const rows: StudentRow[] = done.map((a) => {
    const paper = questionsForPaper(a.paper, pool);
    const slots = new Map(((Array.isArray(a.paper) ? a.paper : []) as PaperSlot[]).map((s) => [s.id, s]));
    let max = 0;
    for (const q of paper) {
      max += q.marks || 1;
      const item = items.get(q.id);
      if (!item) continue;
      item.served += 1;
      const raw = a.answers?.[q.id];
      if (blank(raw)) continue;
      item.attempted += 1;
      if (item.correct != null && gradeObjective(item.kind, q.answer, remapAnswer(slots.get(q.id), q.options, raw)) === "correct") {
        item.correct += 1;
      }
    }
    const pct = a.score != null && max > 0 ? round2((a.score / max) * 100) : null;
    return {
      id: a.id, name: a.name, roll: a.roll, answered: a.answered, total: a.total,
      score: a.score ?? null, max, pct, passed: pct == null ? null : pct >= PASS_PERCENT, flags: a.flags.length,
    };
  });

  for (const item of items.values()) {
    if (item.correct != null && item.served > 0) item.pctCorrect = round2((item.correct / item.served) * 100);
  }

  const pcts = rows.map((r) => r.pct).filter((p): p is number => p != null).sort((x, y) => x - y);
  const n = pcts.length;
  const buckets = Array.from({ length: 10 }, () => 0);
  for (const p of pcts) buckets[Math.min(9, Math.max(0, Math.floor(p / 10)))] += 1;

  return {
    submitted: done.length,
    graded: n,
    rows: rows.sort((x, y) => (y.pct ?? -1) - (x.pct ?? -1) || x.name.localeCompare(y.name)),
    mean: n ? round2(pcts.reduce((s, v) => s + v, 0) / n) : null,
    median: n ? (n % 2 ? pcts[(n - 1) / 2] : round2((pcts[n / 2 - 1] + pcts[n / 2]) / 2)) : null,
    highest: n ? pcts[n - 1] : null,
    lowest: n ? pcts[0] : null,
    passRate: n ? round2((pcts.filter((p) => p >= PASS_PERCENT).length / n) * 100) : null,
    buckets,
    items: [...items.values()],
  };
}
