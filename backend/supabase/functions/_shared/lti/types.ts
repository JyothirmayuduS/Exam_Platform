// Storage contract for the Moodle LTI 1.3 tool. The edge function backs it
// with Postgres; tests back it with memory.

export type Platform = {
  id: string;
  issuer: string;
  clientId: string;
  /** Empty = any deployment of this client id is accepted. */
  deploymentIds: string[];
  authLoginUrl: string;
  authTokenUrl: string;
  jwksUrl: string;
};

/** One Moodle activity (resource link) and the exam a teacher mapped it to. */
export type Link = { id: string; examId: string | null };

export type LaunchIdentity = {
  sub: string;
  email: string | null;
  name: string | null;
  /** Moodle username (ext claim), usually the roll number at Vignan. */
  username: string | null;
  /** Moodle ID number (lis.person_sourcedid). */
  sourcedId: string | null;
  contextTitle: string | null;
};

export type Ticket = { studentId: string; authUserId: string; examId: string; linkId: string; expiresAt: number };

export type GradeTarget = { linkId: string; sub: string; lineitem: string; scoreMaximum: number | null; platform: Platform };

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
  /** The exam exists and is not a draft. */
  examOpen(examId: string): Promise<boolean>;
  /** Find or create the platform student (and their auth account) for this Moodle user. */
  resolveStudent(platform: Platform, who: LaunchIdentity): Promise<{ studentId: string; authUserId: string } | null>;
  enroll(examId: string, studentId: string): Promise<void>;
  saveGradeTarget(target: { linkId: string; studentId: string; examId: string; sub: string; lineitem: string | null }): Promise<void>;
  createTicket(hash: string, ticket: Ticket): Promise<void>;
  /** One-time: a ticket can be exchanged once. */
  takeTicket(hash: string): Promise<Ticket | null>;
  /** Hashed magic-link token the browser exchanges for a session. */
  sessionTokenHash(authUserId: string): Promise<string | null>;
  gradeTargets(examId: string, studentId: string): Promise<GradeTarget[]>;
  setScoreMaximum(examId: string, studentId: string, max: number): Promise<void>;
  recordScorePost(linkId: string, studentId: string, result: { score: number; error: string | null }): Promise<void>;
}
