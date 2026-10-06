export type ExamPhase = "live" | "upcoming" | "draft" | "completed";

export const PHASE_FILTERS = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "upcoming", label: "Upcoming" },
  { value: "draft", label: "Drafts" },
  { value: "completed", label: "Completed" },
] as const;

export type PhaseFilter = (typeof PHASE_FILTERS)[number]["value"];

export const PHASE_LABEL: Record<ExamPhase, string> = {
  live: "Live",
  upcoming: "Upcoming",
  draft: "Draft",
  completed: "Completed",
};

type PhaseInput = {
  status?: string | null;
  scheduled_at?: string | null;
  duration_minutes?: number | null;
};

/** Where an exam sits right now, from its DB status plus its schedule window. */
export function examPhase(exam: PhaseInput, now = Date.now()): ExamPhase {
  const status = (exam.status ?? "").toLowerCase();
  if (status === "draft") return "draft";
  if (status === "completed") return "completed";
  const start = exam.scheduled_at ? Date.parse(exam.scheduled_at) : NaN;
  if (!Number.isFinite(start)) return status === "scheduled" ? "upcoming" : "live";
  if (now < start) return "upcoming";
  const end = start + Math.max(0, exam.duration_minutes ?? 0) * 60_000;
  if (exam.duration_minutes && now > end) return "completed";
  return "live";
}

export function matchesPhase(exam: PhaseInput, filter: PhaseFilter, now = Date.now()): boolean {
  return filter === "all" || examPhase(exam, now) === filter;
}

export function createdAtMs(exam: { created_at?: string | null }): number {
  const t = exam.created_at ? Date.parse(exam.created_at) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Newest-created first; ties fall back to id so order is stable. */
export function byNewest<T extends { id: string; created_at?: string | null }>(a: T, b: T): number {
  return createdAtMs(b) - createdAtMs(a) || b.id.localeCompare(a.id);
}
