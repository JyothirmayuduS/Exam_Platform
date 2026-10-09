import type { JwtClaims } from "./jwt.ts";
import type { LaunchIdentity, Platform } from "./types.ts";

const LTI = "https://purl.imsglobal.org/spec/lti/claim/";
export const CLAIM = {
  messageType: `${LTI}message_type`,
  version: `${LTI}version`,
  deploymentId: `${LTI}deployment_id`,
  resourceLink: `${LTI}resource_link`,
  context: `${LTI}context`,
  roles: `${LTI}roles`,
  custom: `${LTI}custom`,
  lis: `${LTI}lis`,
  ext: `${LTI}ext`,
  ags: "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
} as const;
export const SCORE_SCOPE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";

const CLOCK_SKEW_S = 60;
const LEARNER = [
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student",
];
const STAFF = [
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
  "http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper",
  "http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator",
  "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator",
  "http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator",
];

export type Launch = {
  deploymentId: string;
  resourceLinkId: string;
  resourceTitle: string | null;
  contextId: string | null;
  identity: LaunchIdentity;
  /** Staff without a learner role: shown the mapping status, never signed in. */
  staffOnly: boolean;
  /** Optional Moodle custom parameter `exam_id`; must agree with the mapping. */
  pinnedExamId: string | null;
  /** AGS line item for this link, when Moodle accepts grades from the tool. */
  lineitem: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Check a verified id_token against the registered platform and the nonce
 *  from our login step. Returns the launch, or the reason it was refused. */
export function readLaunch(
  claims: JwtClaims,
  platform: Platform,
  expectedNonce: string,
  nowMs: number,
): { ok: true; launch: Launch } | { ok: false; reason: string } {
  const now = Math.floor(nowMs / 1000);
  if (claims.iss !== platform.issuer) return { ok: false, reason: "issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(platform.clientId)) return { ok: false, reason: "audience" };
  if (aud.length > 1 && claims.azp !== platform.clientId) return { ok: false, reason: "audience" };
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) return { ok: false, reason: "expired" };
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > now) return { ok: false, reason: "issued_in_future" };
  if (!expectedNonce || claims.nonce !== expectedNonce) return { ok: false, reason: "nonce" };
  if (claims[CLAIM.version] !== "1.3.0") return { ok: false, reason: "version" };
  if (claims[CLAIM.messageType] !== "LtiResourceLinkRequest") return { ok: false, reason: "message_type" };
  const deploymentId = str(claims[CLAIM.deploymentId]);
  if (!deploymentId) return { ok: false, reason: "deployment" };
  if (platform.deploymentIds.length && !platform.deploymentIds.includes(deploymentId)) return { ok: false, reason: "deployment" };
  const link = obj(claims[CLAIM.resourceLink]);
  const resourceLinkId = str(link.id);
  if (!resourceLinkId) return { ok: false, reason: "resource_link" };
  const sub = str(claims.sub);
  if (!sub) return { ok: false, reason: "anonymous" };

  const roles = Array.isArray(claims[CLAIM.roles]) ? (claims[CLAIM.roles] as unknown[]).map(String) : [];
  const learner = roles.some((r) => LEARNER.includes(r));
  const staff = roles.some((r) => STAFF.includes(r));
  const context = obj(claims[CLAIM.context]);
  const ags = obj(claims[CLAIM.ags]);
  const scopes = Array.isArray(ags.scope) ? ags.scope.map(String) : [];

  return {
    ok: true,
    launch: {
      deploymentId,
      resourceLinkId,
      resourceTitle: str(link.title),
      contextId: str(context.id),
      staffOnly: staff && !learner,
      pinnedExamId: str(obj(claims[CLAIM.custom]).exam_id),
      lineitem: scopes.includes(SCORE_SCOPE) ? str(ags.lineitem) : null,
      identity: {
        sub,
        email: str(claims.email),
        name: str(claims.name) ?? ([str(claims.given_name), str(claims.family_name)].filter(Boolean).join(" ") || null),
        username: str(obj(claims[CLAIM.ext]).user_username),
        sourcedId: str(obj(claims[CLAIM.lis]).person_sourcedid),
        contextTitle: str(context.title),
      },
    },
  };
}
