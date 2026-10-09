// Postgres implementation of LtiStore. Needs a service-role client: the LTI
// tables are not readable or writable by browsers.
// deno-lint-ignore-file no-explicit-any
import { randomToken } from "./jwt.ts";
import type { ClaimedScore, Link, LtiStore, PendingUser, Platform } from "./types.ts";

type Db = any;

const toPlatform = (r: any): Platform => ({
  id: String(r.id),
  issuer: String(r.issuer),
  clientId: String(r.client_id),
  deploymentIds: Array.isArray(r.deployment_ids) ? r.deployment_ids.map(String) : [],
  authLoginUrl: String(r.auth_login_url),
  authTokenUrl: String(r.auth_token_url),
  jwksUrl: String(r.jwks_url),
});
const LINK_COLS = "id, platform_id, context_id, context_title, resource_title, exam_id, last_launch_at";
const toLink = (r: any): Link => ({
  id: String(r.id),
  platformId: String(r.platform_id),
  contextId: r.context_id ?? null,
  contextTitle: r.context_title ?? null,
  resourceTitle: r.resource_title ?? null,
  examId: r.exam_id ?? null,
  lastLaunchAt: r.last_launch_at ?? null,
});
const toPending = (r: any): PendingUser => ({
  id: String(r.id),
  platformId: String(r.platform_id),
  sub: String(r.sub),
  name: r.name ?? null,
  email: r.email ?? null,
  username: r.username ?? null,
  sourcedId: r.sourced_id ?? null,
  contextId: r.context_id ?? null,
  contextTitle: r.context_title ?? null,
  linkId: r.link_id ?? null,
});
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const loginEmail = (roll: string) => `${roll.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-")}@student.vignan.ac.in`;
const iso = (ms: number) => new Date(ms).toISOString();
const must = ({ error }: { error: { message: string } | null }) => { if (error) throw new Error(error.message); };

/** PostgREST `or` filter over the links/contexts a teacher launched. */
function scopeFilter(scope: { linkIds: string[]; contextIds: string[] }, linkCol: string): string | null {
  const parts: string[] = [];
  const list = (xs: string[]) => xs.map((x) => `"${x.replace(/"/g, '\\"')}"`).join(",");
  if (scope.linkIds.length) parts.push(`${linkCol}.in.(${list(scope.linkIds)})`);
  if (scope.contextIds.length) parts.push(`context_id.in.(${list(scope.contextIds)})`);
  return parts.length ? parts.join(",") : null;
}

async function findAuthUserByEmail(db: Db, email: string): Promise<{ id: string; role: unknown } | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u: { email?: string }) => u.email?.toLowerCase() === email);
    if (hit) return { id: String(hit.id), role: hit.app_metadata?.role };
    if (data.users.length < 1000) return null;
  }
  return null;
}

export function supabaseLtiStore(db: Db): LtiStore {
  return {
    async findPlatform(issuer, clientId) {
      let q = db.from("lti_platforms").select("*").eq("issuer", issuer);
      if (clientId) q = q.eq("client_id", clientId);
      const { data } = await q.limit(2);
      // Without a client id the issuer alone must be unambiguous.
      if (!data?.length || (!clientId && data.length > 1)) return null;
      return toPlatform(data[0]);
    },

    async getPlatform(id) {
      const { data } = await db.from("lti_platforms").select("*").eq("id", id).maybeSingle();
      return data ? toPlatform(data) : null;
    },

    async saveLogin(state, nonce, platformId) {
      must(await db.from("lti_logins").insert({ state, nonce, platform_id: platformId }));
      await db.from("lti_logins").delete().lt("created_at", iso(Date.now() - 60 * 60_000));
    },

    async takeLogin(state) {
      const { data } = await db.from("lti_logins").delete().eq("state", state).select("nonce, platform_id, created_at").maybeSingle();
      return data ? { nonce: String(data.nonce), platformId: String(data.platform_id), createdAt: Date.parse(data.created_at) } : null;
    },

    async upsertLink(i) {
      const { data, error } = await db
        .from("lti_links")
        .upsert(
          {
            platform_id: i.platformId,
            deployment_id: i.deploymentId,
            resource_link_id: i.resourceLinkId,
            context_id: i.contextId,
            context_title: i.contextTitle,
            resource_title: i.resourceTitle,
            last_launch_at: iso(Date.now()),
          },
          { onConflict: "platform_id,resource_link_id" },
        )
        .select(LINK_COLS)
        .single();
      if (error || !data) throw new Error(error?.message ?? "link upsert failed");
      return toLink(data);
    },

    async getLink(id) {
      if (!id) return null;
      const { data } = await db.from("lti_links").select(LINK_COLS).eq("id", id).maybeSingle();
      return data ? toLink(data) : null;
    },

    async linksFor(platformId, scope) {
      const filter = scopeFilter(scope, "id");
      if (!filter) return [];
      const { data } = await db.from("lti_links").select(LINK_COLS).eq("platform_id", platformId).or(filter).order("last_launch_at", { ascending: false });
      return (data ?? []).map(toLink);
    },

    async setLinkExam(linkId, examId, teacherAuthId) {
      must(await db.from("lti_links").update({
        exam_id: examId,
        mapped_by: examId ? teacherAuthId : null,
        mapped_at: examId ? iso(Date.now()) : null,
      }).eq("id", linkId));
    },

    async examOpen(examId) {
      const { data } = await db.from("exams").select("status").eq("id", examId).maybeSingle();
      return !!data && data.status !== "draft";
    },

    async linkedStudent(platformId, sub) {
      const { data } = await db.from("lti_users").select("student_id").eq("platform_id", platformId).eq("sub", sub).maybeSingle();
      return data?.student_id ? String(data.student_id) : null;
    },

    async studentByRoll(roll) {
      const { data } = await db.from("students").select("id").ilike("roll", escapeLike(roll.trim())).limit(2);
      return data?.length === 1 ? { id: String(data[0].id) } : null;
    },

    async studentLinkedSub(platformId, studentId) {
      const { data } = await db.from("lti_users").select("sub").eq("platform_id", platformId).eq("student_id", studentId).maybeSingle();
      return data?.sub ? String(data.sub) : null;
    },

    async linkStudent(platformId, sub, studentId) {
      must(await db.from("lti_users").insert({ platform_id: platformId, sub, student_id: studentId }));
    },

    async createStudent(who) {
      let email = who.email;
      if (email) {
        const { data: taken } = await db.from("students").select("id").ilike("email", escapeLike(email)).limit(1);
        if (taken?.length) email = null;
      }
      const { data, error } = await db
        .from("students")
        .insert({
          roll: who.roll,
          full_name: who.name ?? who.roll,
          email: email ?? `${who.roll.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}@moodle.invalid`,
          batch: who.batch ?? "Moodle",
        })
        .select("id")
        .single();
      return error || !data ? null : { id: String(data.id) };
    },

    async ensureAuthUser(studentId) {
      const { data: s } = await db.from("students").select("id, roll, auth_id").eq("id", studentId).maybeSingle();
      if (!s) return { error: "no_account" };
      if (s.auth_id) return { authUserId: String(s.auth_id) };
      const email = loginEmail(s.roll);
      const { data: created } = await db.auth.admin.createUser({
        email,
        password: randomToken(24),
        email_confirm: true,
        app_metadata: { role: "student", roll: s.roll, lti: true },
        user_metadata: { roll: s.roll },
      });
      let authUserId = created?.user?.id ? String(created.user.id) : null;
      if (!authUserId) {
        const existing = await findAuthUserByEmail(db, email);
        if (!existing) return { error: "no_account" };
        if (existing.role !== "student") return { error: "not_student_account" };
        authUserId = existing.id;
      }
      const { data: linked } = await db.from("students").update({ auth_id: authUserId }).eq("id", s.id).is("auth_id", null).select("auth_id");
      if (linked?.length) return { authUserId };
      const { data: again } = await db.from("students").select("auth_id").eq("id", s.id).maybeSingle();
      return again?.auth_id ? { authUserId: String(again.auth_id) } : { error: "no_account" };
    },

    async savePendingUser(platformId, who, link) {
      must(await db.from("lti_pending_users").upsert({
        platform_id: platformId,
        sub: who.sub,
        name: who.name,
        email: who.email,
        username: who.username,
        sourced_id: who.sourcedId,
        context_id: link.contextId,
        context_title: who.contextTitle,
        link_id: link.id,
        last_launch_at: iso(Date.now()),
      }, { onConflict: "platform_id,sub" }));
    },

    async pendingFor(platformId, scope) {
      const filter = scopeFilter(scope, "link_id");
      if (!filter) return [];
      const { data } = await db.from("lti_pending_users").select("*").eq("platform_id", platformId).or(filter).order("last_launch_at", { ascending: false });
      return (data ?? []).map(toPending);
    },

    async getPending(id) {
      if (!id) return null;
      const { data } = await db.from("lti_pending_users").select("*").eq("id", id).maybeSingle();
      return data ? toPending(data) : null;
    },

    async deletePending(id) {
      await db.from("lti_pending_users").delete().eq("id", id);
    },

    async enroll(examId, studentId) {
      must(await db.from("enrollments").upsert({ exam_id: examId, student_id: studentId }, { onConflict: "exam_id,student_id", ignoreDuplicates: true }));
    },

    async recordInstructorLaunch(l) {
      must(await db.from("lti_instructor_launches").upsert(
        { platform_id: l.platformId, sub: l.sub, link_id: l.linkId, context_id: l.contextId, last_launch_at: iso(Date.now()) },
        { onConflict: "platform_id,sub,link_id" },
      ));
    },

    async saveClaim(hash, c) {
      must(await db.from("lti_claims").insert({ claim_hash: hash, platform_id: c.platformId, sub: c.sub, expires_at: iso(c.expiresAt) }));
      await db.from("lti_claims").delete().lt("expires_at", iso(Date.now() - 60 * 60_000));
    },

    async takeClaim(hash) {
      const { data } = await db.from("lti_claims").delete().eq("claim_hash", hash).select("platform_id, sub, expires_at").maybeSingle();
      return data ? { platformId: String(data.platform_id), sub: String(data.sub), expiresAt: Date.parse(data.expires_at) } : null;
    },

    async teacherForSub(platformId, sub) {
      const { data } = await db.from("lti_teachers").select("teacher_auth_id").eq("platform_id", platformId).eq("sub", sub).maybeSingle();
      return data?.teacher_auth_id ? String(data.teacher_auth_id) : null;
    },

    async linkTeacher(platformId, sub, teacherAuthId) {
      must(await db.from("lti_teachers").insert({ platform_id: platformId, sub, teacher_auth_id: teacherAuthId }));
    },

    async teacherSubs(teacherAuthId) {
      const { data } = await db.from("lti_teachers").select("platform_id, sub").eq("teacher_auth_id", teacherAuthId);
      return (data ?? []).map((r: any) => ({ platformId: String(r.platform_id), sub: String(r.sub) }));
    },

    async instructorLaunches(subs) {
      const out = [];
      for (const s of subs) {
        const { data } = await db.from("lti_instructor_launches").select("link_id, context_id").eq("platform_id", s.platformId).eq("sub", s.sub);
        for (const r of data ?? []) out.push({ platformId: s.platformId, sub: s.sub, linkId: String(r.link_id), contextId: r.context_id ?? null });
      }
      return out;
    },

    async ownsExam(teacherAuthId, examId) {
      if (!examId) return false;
      const { data: t } = await db.from("teachers").select("role").eq("auth_id", teacherAuthId).maybeSingle();
      if (t?.role !== "teacher") return false;
      const { data: e } = await db.from("exams").select("created_by").eq("id", examId).maybeSingle();
      return !!e && (e.created_by === null || String(e.created_by) === teacherAuthId);
    },

    async createTicket(hash, t) {
      must(await db.from("lti_tickets").insert({
        ticket_hash: hash,
        student_id: t.studentId,
        auth_user_id: t.authUserId,
        exam_id: t.examId,
        link_id: t.linkId,
        expires_at: iso(t.expiresAt),
      }));
      await db.from("lti_tickets").delete().lt("expires_at", iso(Date.now() - 60 * 60_000));
    },

    async takeTicket(hash) {
      const { data } = await db.from("lti_tickets").delete().eq("ticket_hash", hash).select("*").maybeSingle();
      if (!data) return null;
      return {
        studentId: String(data.student_id),
        authUserId: String(data.auth_user_id),
        examId: String(data.exam_id),
        linkId: String(data.link_id),
        expiresAt: Date.parse(data.expires_at),
      };
    },

    async sessionTokenHash(authUserId) {
      const { data: u } = await db.auth.admin.getUserById(authUserId);
      const email = u?.user?.email;
      if (!email) return null;
      const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email });
      if (error) return null;
      return data?.properties?.hashed_token ?? null;
    },

    async saveGradeTarget(t) {
      must(await db.from("lti_grade_targets").upsert(
        { link_id: t.linkId, student_id: t.studentId, exam_id: t.examId, sub: t.sub, lineitem: t.lineitem },
        { onConflict: "link_id,student_id" },
      ));
    },

    async setScoreMaximum(examId, studentId, max) {
      await db.from("lti_grade_targets").update({ score_maximum: max }).eq("exam_id", examId).eq("student_id", studentId);
    },

    async queueScore(examId, studentId, q) {
      const { data, error } = await db.from("lti_grade_targets").update({
        pending_score: q.score,
        ...(q.max && q.max > 0 ? { score_maximum: q.max } : {}),
        post_attempts: 0,
        next_attempt_at: iso(q.nowMs),
        last_error: null,
      }).eq("exam_id", examId).eq("student_id", studentId).not("lineitem", "is", null).select("link_id");
      if (error) throw new Error(error.message);
      return data?.length ?? 0;
    },

    async claimScores(nowMs, o) {
      const { data, error } = await db.rpc("lti_claim_scores", {
        p_now: iso(nowMs),
        p_limit: o.limit,
        p_lease_seconds: Math.ceil(o.leaseMs / 1000),
        p_exam_id: o.examId ?? null,
        p_student_id: o.studentId ?? null,
      });
      if (error) throw new Error(error.message);
      const rows: any[] = data ?? [];
      if (!rows.length) return [];
      const { data: links } = await db.from("lti_links").select("id, platform:lti_platforms(*)").in("id", [...new Set(rows.map((r) => r.link_id))]);
      const platforms = new Map<string, Platform>();
      for (const l of links ?? []) {
        const p = Array.isArray(l.platform) ? l.platform[0] : l.platform;
        if (p) platforms.set(String(l.id), toPlatform(p));
      }
      const out: ClaimedScore[] = [];
      for (const r of rows) {
        const platform = platforms.get(String(r.link_id));
        if (!platform || r.pending_score === null) continue;
        out.push({
          linkId: String(r.link_id),
          studentId: String(r.student_id),
          sub: String(r.sub),
          lineitem: String(r.lineitem),
          scoreMaximum: num(r.score_maximum),
          pendingScore: Number(r.pending_score),
          attempts: Number(r.post_attempts ?? 0),
          platform,
          claim: String(r.claim_token),
        });
      }
      return out;
    },

    async finishScore(c, outcome, nowMs) {
      must(await db.rpc("lti_finish_score", {
        p_link_id: c.linkId,
        p_student_id: c.studentId,
        p_claim_token: c.claim,
        p_score: c.pendingScore,
        p_ok: outcome.ok,
        p_error: outcome.ok ? null : outcome.error,
        p_attempts: outcome.ok ? 0 : outcome.attempts,
        p_next_attempt_at: outcome.ok || outcome.nextAttemptAt === null ? null : iso(outcome.nextAttemptAt),
        p_now: iso(nowMs),
      }));
    },

    async attemptScore(attemptId) {
      if (!attemptId) return null;
      const { data } = await db.from("attempts").select("exam_id, student_id, score, state").eq("id", attemptId).maybeSingle();
      if (!data) return null;
      return { examId: String(data.exam_id), studentId: String(data.student_id), score: num(data.score), submitted: data.state === "submitted" };
    },

    async examScores(examId) {
      const { data } = await db.from("attempts").select("student_id, score").eq("exam_id", examId).eq("state", "submitted").not("score", "is", null);
      return (data ?? []).map((r: any) => ({ studentId: String(r.student_id), score: Number(r.score) }));
    },
  };
}
