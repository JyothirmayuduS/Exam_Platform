// Storage contract for the Moodle LTI 1.3 tool. The edge function backs it
// with Postgres; tests back it with memory. Policy (who matches whom, who may
// map what) lives in the handler, not here.

export type Platform = {
  id: string;
  issuer: string;
  clientId: string;
  /** Deployments of this client id that may launch. Never empty. */
  deploymentIds: string[];
  authLoginUrl: string;
  authTokenUrl: string;
  jwksUrl: string;
};

/** One Moodle activity (resource link) and the exam a teacher mapped it to. */
export type Link = {
  id: string;
  platformId: string;
  contextId: string | null;
  contextTitle: string | null;
  resourceTitle: string | null;
  examId: string | null;
  lastLaunchAt: string | null;
};

export type LaunchIdentity = {
  sub: string;
  email: string | null;
  name: string | null;
  /** Moodle username. Shown to teachers only; never used to match. */
  username: string | null;
  /** Moodle ID number (lis.person_sourcedid), set by the university. */
  sourcedId: string | null;
  contextTitle: string | null;
};

export type PendingUser = {
  id: string;
  platformId: string;
  sub: string;
  name: string | null;
  email: string | null;
  username: string | null;
  sourcedId: string | null;
  contextId: string | null;
  contextTitle: string | null;
  linkId: string | null;
};

export type Ticket = { studentId: string; authUserId: string; examId: string; linkId: string; expiresAt: number };

export type GradeTarget = {
  linkId: string;
  studentId: string;
  sub: string;
  lineitem: string;
  scoreMaximum: number | null;
  pendingScore: number | null;
  attempts: number;
  platform: Platform;
};

/** A queued score this sender holds the claim on, with the value to send.
 *  `clear`: the result is on hold, so Moodle's grade is cleared instead. */
export type ClaimedScore = GradeTarget & { claim: string; pendingScore: number; clear?: boolean };

export type ScoreOutcome =
  | { ok: true }
  | { ok: false; error: string; attempts: number; nextAttemptAt: number | null };

export type InstructorLaunch = { platformId: string; sub: string; linkId: string; contextId: string | null };

export interface LtiStore {
  findPlatform(issuer: string, clientId: string | null): Promise<Platform | null>;
  getPlatform(id: string): Promise<Platform | null>;
  saveLogin(state: string, nonce: string, platformId: string): Promise<void>;
  /** One-time: the row is removed as it is read. */
  takeLogin(state: string): Promise<{ nonce: string; platformId: string; createdAt: number } | null>;
  upsertLink(input: {
    platformId: string;
    deploymentId: string;
    resourceLinkId: string;
    contextId: string | null;
    contextTitle: string | null;
    resourceTitle: string | null;
  }): Promise<Link>;
  getLink(id: string): Promise<Link | null>;
  linksFor(platformId: string, scope: { linkIds: string[]; contextIds: string[] }): Promise<Link[]>;
  setLinkExam(linkId: string, examId: string | null, teacherAuthId: string): Promise<void>;
  /** The exam exists and is not a draft. */
  examOpen(examId: string): Promise<boolean>;

  // Students
  linkedStudent(platformId: string, sub: string): Promise<string | null>;
  /** Exact roll match, ignoring case. */
  studentByRoll(roll: string): Promise<{ id: string } | null>;
  /** The Moodle sub already linked to this student on this platform, if any. */
  studentLinkedSub(platformId: string, studentId: string): Promise<string | null>;
  linkStudent(platformId: string, sub: string, studentId: string): Promise<void>;
  createStudent(who: { roll: string; name: string | null; email: string | null; batch: string | null }): Promise<{ id: string } | null>;
  /** The student's auth account, created when missing. An existing account
   *  is adopted only when its app_metadata role is "student". */
  ensureAuthUser(studentId: string): Promise<{ authUserId: string } | { error: "no_account" | "not_student_account" }>;
  savePendingUser(platformId: string, who: LaunchIdentity, link: { id: string; contextId: string | null }): Promise<void>;
  pendingFor(platformId: string, scope: { linkIds: string[]; contextIds: string[] }): Promise<PendingUser[]>;
  getPending(id: string): Promise<PendingUser | null>;
  deletePending(id: string): Promise<void>;
  enroll(examId: string, studentId: string): Promise<void>;

  // Teachers
  recordInstructorLaunch(launch: InstructorLaunch): Promise<void>;
  saveClaim(hash: string, claim: { platformId: string; sub: string; expiresAt: number }): Promise<void>;
  takeClaim(hash: string): Promise<{ platformId: string; sub: string; expiresAt: number } | null>;
  /** Teacher already tied to this Moodle account, if any. */
  teacherForSub(platformId: string, sub: string): Promise<string | null>;
  linkTeacher(platformId: string, sub: string, teacherAuthId: string): Promise<void>;
  teacherSubs(teacherAuthId: string): Promise<{ platformId: string; sub: string }[]>;
  instructorLaunches(subs: { platformId: string; sub: string }[]): Promise<InstructorLaunch[]>;
  /** Same rule as public.owns_exam: a teacher, and the exam is theirs or unowned. */
  ownsExam(teacherAuthId: string, examId: string): Promise<boolean>;

  // Session
  createTicket(hash: string, ticket: Ticket): Promise<void>;
  /** One-time: a ticket can be exchanged once. */
  takeTicket(hash: string): Promise<Ticket | null>;
  /** Hashed magic-link token the browser exchanges for a session. */
  sessionTokenHash(authUserId: string): Promise<string | null>;

  // Grades
  saveGradeTarget(target: { linkId: string; studentId: string; examId: string; sub: string; lineitem: string | null }): Promise<void>;
  setScoreMaximum(examId: string, studentId: string, max: number): Promise<void>;
  /** Queue a new score on every graded link of this attempt, due now.
   *  Returns how many links it was queued on. */
  queueScore(examId: string, studentId: string, q: { score: number; max: number | null; nowMs: number }): Promise<number>;
  /** Atomically claim due queued scores (all, or one student's for one exam).
   *  Rows held by another sender are skipped until their lease ends. */
  claimScores(nowMs: number, opts: { limit: number; leaseMs: number; examId?: string; studentId?: string }): Promise<ClaimedScore[]>;
  /** Release a claim. The queued score is cleared only if it still equals the
   *  value that was sent; a stale claim changes nothing. */
  finishScore(c: ClaimedScore, outcome: ScoreOutcome, nowMs: number): Promise<void>;
  attemptScore(attemptId: string): Promise<{ examId: string; studentId: string; score: number | null; submitted: boolean } | null>;
  examScores(examId: string): Promise<{ studentId: string; score: number }[]>;
}
