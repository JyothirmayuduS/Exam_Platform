// Single source of truth for the live exam session roster.
// Submissions (live tracking) and Evaluate (grading) both read from here so the
// two pages never disagree about who wrote which exam.

export type Severity = "critical" | "notice";
export type Flag = { severity: Severity; label: string; at: string };
export type AttemptState = "Submitted" | "In progress" | "Not started" | "Paused";
export type Network = "Stable" | "Reconnected" | "Unstable" | "Offline";

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

export const LIVE_EXAM = "Data Structures & Algorithms";
export const SESSION_MINUTES = 45;

export const needsAttention = (a: Attempt) => a.flags.length > 0 || a.network === "Offline";
export const evaluationPath = (id: string) => `/teacher/evaluate?review=${id}`;
