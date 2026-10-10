// Shared domain types for the exam platform.
//
// These describe the tables the app reads/writes (exams, questions, attempts,
// students, proctor events…) plus the shapes the proctor/teacher consoles and
// the examiner dashboard consume. Pure types only — no logic lives here.

import type { PaperSlot } from "@/shared/domain/exam/paperBuilder";

export type { PaperSlot };

export type ExamStatus = "draft" | "published" | "scheduled" | "completed";
export type ExamMode = "practice" | "lockdown";

export type ExamRecord = {
  id: string;
  /** Set by the database to "Type · CODE · Subject" once the three fields below are filled. */
  name: string;
  academic_type?: string | null;
  subject_code?: string | null;
  subject_name?: string | null;
  batch: string;
  mode: ExamMode;
  status: ExamStatus;
  duration_minutes: number;
  per_student: number;
  pool_count: number;
  total_marks: number;
  scheduled_at: string | null;
  join_link: string;
  settings: Record<string, unknown>;
  description?: string | null;
  instructions?: string | null;
  resources_url?: string | null;
  faq?: { question: string; answer: string }[] | null;
  created_at?: string;
  /** Student views only: this student's attempt state for the exam. */
  my_attempt_state?: string | null;
};

export type DBQuestion = {
  id: string;
  exam_id: string | null;
  title: string;
  type: string;
  unit: string | null;
  difficulty: string | null;
  marks: number;
  options: string[] | null;
  answer: string | null;
  subjective_mode?: "both" | "qr" | "textbox" | null;
};

export type ExamBundle = { exam: ExamRecord | null; questions: DBQuestion[] };

export type AttemptState = "not_started" | "in_progress" | "submitted" | "paused";

export type ViolationSeverity = "info" | "warning" | "high" | "critical";
export type ViolationSource = "ai" | "system" | "proctor" | "student" | "teacher";

/** One proctoring flag / proctor action row from violation_events. */
export type ViolationEvent = {
  id: string;
  exam_id: string;
  attempt_id: string | null;
  student_id: string;
  violation_type: string;
  severity: ViolationSeverity;
  description: string;
  source: ViolationSource;
  /** Seconds from the attempt start — used for red markers on the recording seek bar. */
  offset_seconds: number | null;
  snapshot_key: string | null;
  created_at: string;
};

export type AttemptRecord = {
  id: string;
  exam_id: string;
  student_id: string;
  state: AttemptState;
  answered: number;
  total: number;
  minutes_used: number;
  score: number | null;
  started_at: string | null;
  submitted_at: string | null;
  auto_saved_at: string | null;
  answers: Record<string, unknown>;
  /** Per-student question snapshot (ordered DB question ids + shuffled options). */
  paper: unknown;
  /** When the candidate accepted the recording/consent notice, if ever. */
  consent_at: string | null;
  /** The candidate's browser User-Agent at attempt start (device telemetry). */
  user_agent: string | null;
};

/** One live roster row: an attempt (or an enrolled-not-started placeholder)
 *  joined with the student and the attempt's violation events. */
export type LiveAttempt = {
  id: string;
  exam_id: string;
  state: AttemptState;
  answered: number;
  total: number;
  minutes_used: number;
  score: number | null;
  answers: Record<string, unknown>;
  paper: unknown;
  started_at: string | null;
  submitted_at: string | null;
  auto_saved_at: string | null;
  consent_at: string | null;
  user_agent: string | null;
  /** Minutes added to this attempt during the exam. */
  extra_minutes: number;
  /** Accommodation minutes set on the enrollment (Candidates tab). */
  accommodation_minutes: number;
  student: { id: string; roll: string; full_name: string; email: string | null; auth_id?: string | null } | null;
  violations: ViolationEvent[];
};

export type Student = {
  id: string;
  roll: string;
  full_name: string;
  email: string;
  branch: string;
  section: string;
  phone?: string | null;
  created_at: string;
};

/** A row of the enrolment directory: roll, name and class, no contact details. */
export type DirectoryStudent = {
  id: string;
  roll: string;
  full_name: string | null;
  branch: string | null;
  section: string | null;
  batch: string | null;
  has_email: boolean;
};

export type StudentRosterRecord = {
  id: string;
  roll: string;
  full_name: string;
  email: string;
  branch: string;
  section: string;
  phone?: string | null;
};

export type ProctorMessage = {
  id: string;
  exam_id: string;
  attempt_id: string | null;
  sender: string;
  sender_role: string;
  body: string;
  kind: "message" | "broadcast";
  created_at: string;
};

export type ProctorAssignment = {
  id: string;
  exam_id: string;
  assignee_name: string;
  assignee_role: "proctor" | "teacher" | "ta";
  /** teachers.id when the assignee has a platform account (enables "my exams"). */
  assignee_id: string | null;
  email: string | null;
  created_at: string;
};

/** A teacher/proctor row: used by the Assign Proctors modal + delegate pickers. */
export type FacultyMember = {
  id: string | null;
  name: string;
  role: string;
  department: string | null;
  email: string | null;
};

export type GradingComment = {
  id: string;
  attempt_id: string;
  question_id: string | null;
  comment: string;
  voice_key: string | null;
  created_by: string | null;
  created_at: string;
};

export type DelegationRow = {
  id: string;
  attempt_id: string | null;
  exam_id: string | null;
  delegate_id: string | null;
  delegate_name: string;
  due_date: string | null;
  report_count: number;
  created_at: string;
  student_roll: string | null;
  student_name: string | null;
};

export type ExamAllocation = {
  status: "allocated" | "not_allocated";
  role?: string;
  due_date?: string | null;
  assigned?: number;
  total?: number;
  evaluators?: { id: string; name: string; email?: string | null; count: number }[];
} | null;

export type ExaminerExamRow = {
  id: string;
  name: string;
  batch: string;
  status: string;
  mode: string;
  duration_minutes: number;
  pool_count: number;
  created_at: string | null;
  roster_count: number;
  submitted: number;
  auto_graded: number;
  unassigned: number;
  delegates: number;
  allocation: ExamAllocation;
};

/** Where a candidate was in their paper; stored on attempts.resume_state. */
export type ResumeState = {
  /** Question index in the student's paper. */
  index: number;
  /** Timed-section index (0 when sections are untimed). */
  section: number;
  /** Seconds left in that section when saved; null when sections are untimed. */
  sectionSecondsLeft: number | null;
  /** Client clock (ms) when this position was captured. */
  savedAt: number;
};

/** Server view of an attempt, read when the exam page opens. */
export type AttemptSnapshot = {
  attemptId: string;
  state: string;
  answers: Record<string, unknown>;
  /** Server copy's auto_saved_at (ms), null when never saved. */
  autoSavedAt: number | null;
  resume: ResumeState | null;
  /** Server clock; null when unknown (offline or older database). */
  secondsLeft: number | null;
};
