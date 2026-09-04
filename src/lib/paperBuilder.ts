// Per-student paper snapshots.
//
// The teacher sets "questions per student", "random select" and "shuffle
// order/options" on an exam. At delivery time each student gets a *deterministic*
// paper derived from their exam + student id, so the same paper survives
// reloads, reconnects and autosave. The snapshot is stored on the attempt row
// (attempts.paper) and answers are keyed by DB question id, so grading reads
// the student's own paper — not the full pool.

import type { DBQuestion } from "./examApi";

/** One slot of a student's paper. `options` is present only when option
 *  shuffle is on, and holds the options in the order the student saw them. */
export type PaperSlot = {
  id: string;
  options?: string[];
};

export type PaperSettings = {
  perStudent: number;
  randomSelect: boolean;
  shuffleOrder: boolean;
  shuffleOptions: boolean;
};

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────
function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const difficultyKey = (q: DBQuestion): "easy" | "medium" | "hard" => {
  const d = (q.difficulty ?? "").trim().toLowerCase();
  return d === "easy" || d === "medium" || d === "hard" ? d : "medium";
};

/**
 * Build a student's paper from the pool.
 * - difficulty mix of the pool is preserved (Easy/Medium/Hard interleaved)
 * - `randomSelect: false` takes the first N in pool order instead
 * - `shuffleOrder` scrambles question order
 * - `shuffleOptions` scrambles each question's options (recorded in the slot)
 */
export function buildPaper(
  examId: string,
  studentSeed: string,
  pool: DBQuestion[],
  settings: Partial<PaperSettings> & { perStudent?: number },
): PaperSlot[] {
  const per = Math.max(1, Math.min(settings.perStudent ?? pool.length, Math.max(1, pool.length)));
  const rand = mulberry32(hashSeed(`${examId}:${studentSeed}:paper`));

  let selected: DBQuestion[];
  if (settings.randomSelect === false) {
    selected = pool.slice(0, per);
  } else {
    const jittered = shuffleInPlace([...pool], rand);
    const groups: Record<string, DBQuestion[]> = {};
    for (const q of jittered) {
      (groups[difficultyKey(q)] ??= []).push(q);
    }
    const keys = Object.keys(groups);
    selected = [];
    let gi = 0;
    let stalled = 0;
    while (selected.length < per && keys.length > 0 && stalled <= keys.length * 2) {
      const group = groups[keys[gi % keys.length]];
      if (group.length) {
        selected.push(group.pop() as DBQuestion);
        stalled = 0;
      } else {
        stalled += 1;
      }
      gi += 1;
    }
    if (selected.length < per) {
      const rest = jittered.filter((q) => !selected.includes(q));
      selected.push(...rest.slice(0, per - selected.length));
    }
  }

  let ordered = selected;
  if (settings.shuffleOrder) ordered = shuffleInPlace([...selected], rand);

  return ordered.map((q) => {
    const slot: PaperSlot = { id: q.id };
    if (settings.shuffleOptions && Array.isArray(q.options) && q.options.length >= 2) {
      const idx = q.options.map((_, i) => i);
      shuffleInPlace(idx, rand);
      slot.options = idx.map((i) => String((q.options as string[])[i]));
    }
    return slot;
  });
}

/** Ordered questions for a paper snapshot; falls back to the full pool for
 *  legacy attempts that predate snapshots. */
export function questionsForPaper(
  paper: unknown,
  pool: DBQuestion[],
): DBQuestion[] {
  const slots: PaperSlot[] = Array.isArray(paper) ? (paper as PaperSlot[]) : [];
  if (slots.length === 0) return pool;
  const byId = new Map(pool.map((q) => [q.id, q]));
  const out: DBQuestion[] = [];
  for (const s of slots) {
    const q = byId.get(s.id);
    if (q) out.push(q);
  }
  return out.length ? out : pool;
}

/** Map a student's answer (in displayed option order) back to the original
 *  option index, so it can be compared against the stored answer key. */
export function remapAnswer(slot: PaperSlot | undefined, originalOptions: string[] | null | undefined, value: unknown): unknown {
  if (!slot?.options || !Array.isArray(originalOptions)) return value;
  const mapIdx = (v: number): number => {
    const shown = slot.options?.[v];
    const orig = originalOptions.findIndex((o) => o === shown);
    return orig >= 0 ? orig : v;
  };
  if (typeof value === "number") return mapIdx(value);
  if (Array.isArray(value)) return (value as unknown[]).map((v) => (typeof v === "number" ? mapIdx(v) : v));
  return value;
}