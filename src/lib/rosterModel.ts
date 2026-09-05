// Shared view model for the live candidate roster.
//
// TeacherSubmissions (live tracking) and TeacherEvaluation (grading) both
// consume this same shape so the two pages never disagree about who wrote
// which exam. Real DB rows (attempts + students) are mapped into this UI model
// by src/hooks/useLiveAttempts.ts — nothing here is mocked or seeded.

export type Severity = "critical" | "notice";
export type Flag = { severity: Severity; label: string; at: string };
export type AttemptState = "Submitted" | "In progress" | "Not started" | "Paused";
export type Network = "Stable" | "Reconnected" | "Unstable" | "Offline" | "Idle";

export type Attempt = {
  id: string;
  name: string;
  roll: string;
  initials: string;
  email?: string | null;
  studentId?: string | null;
  examId?: string;
  exam: string;
  state: AttemptState;
  answered: number;
  total: number;
  startedAt: string;
  submittedAgo: string;
  minutesUsed: number;
  lastActivity: string;
  device: string;
  network: Network;
  autoSaveAt: string;
  flags: Flag[];
  answers?: Record<string, any>;
  /** Per-student paper snapshot (ordered DB question ids + shuffled options). */
  paper?: unknown;
  score?: number | null;
};

export const needsAttention = (a: Attempt) => a.flags.length > 0 || a.network === "Offline";
export const evaluationPath = (id: string) => `/teacher/evaluate?review=${id}`;
