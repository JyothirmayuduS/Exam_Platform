// Postgres implementation of LtiStore. Needs a service-role client: the LTI
// tables are not readable or writable by browsers.
// deno-lint-ignore-file no-explicit-any
import { randomToken } from "./jwt.ts";
import type { LaunchIdentity, LtiStore, Platform } from "./types.ts";

type Db = any;
type StudentRow = { id: string; roll: string; auth_id: string | null };

const toPlatform = (r: any): Platform => ({
  id: String(r.id),
  issuer: String(r.issuer),
  clientId: String(r.client_id),
  deploymentIds: Array.isArray(r.deployment_ids) ? r.deployment_ids.map(String) : [],
  authLoginUrl: String(r.auth_login_url),
  authTokenUrl: String(r.auth_token_url),
  jwksUrl: String(r.jwks_url),
});
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const loginEmail = (roll: string) => `${roll.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-")}@student.vignan.ac.in`;

async function findStudent(db: Db, who: LaunchIdentity): Promise<StudentRow | null> {
  for (const roll of [who.username, who.sourcedId]) {
    if (!roll) continue;
    const { data } = await db.from("students").select("id, roll, auth_id").ilike("roll", escapeLike(roll)).limit(2);
    if (data?.length === 1) return data[0];
  }
  if (who.email) {
    const { data } = await db.from("students").select("id, roll, auth_id").ilike("email", escapeLike(who.email)).limit(2);
    if (data?.length === 1) return data[0];
  }
  return null;
}

async function findAuthUserByEmail(db: Db, email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u: { email?: string }) => u.email?.toLowerCase() === email);
    if (hit) return String(hit.id);
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
      const { error } = await db.from("lti_logins").insert({ state, nonce, platform_id: platformId });
      if (error) throw new Error(error.message);
      await db.from("lti_logins").delete().lt("created_at", new Date(Date.now() - 60 * 60_000).toISOString());
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
            last_launch_at: new Date().toISOString(),
          },
          { onConflict: "platform_id,resource_link_id" },
        )
        .select("id, exam_id")
        .single();
      if (error || !data) throw new Error(error?.message ?? "link upsert failed");
      return { id: String(data.id), examId: data.exam_id ? String(data.exam_id) : null };
    },

    async examOpen(examId) {
      const { data } = await db.from("exams").select("status").eq("id", examId).maybeSingle();
      return !!data && data.status !== "draft";
    },

    async resolveStudent(platform, who) {
      const { data: mapped } = await db.from("lti_users").select("student_id").eq("platform_id", platform.id).eq("sub", who.sub).maybeSingle();
      let student: StudentRow | null = null;
      if (mapped) {
        const { data } = await db.from("students").select("id, roll, auth_id").eq("id", mapped.student_id).maybeSingle();
        student = data ?? null;
      }
      if (!student) {
        student = await findStudent(db, who);
        if (student) {
          // A student already tied to another Moodle account is never taken over.
          const { data: other } = await db.from("lti_users").select("sub").eq("platform_id", platform.id).eq("student_id", student.id).maybeSingle();
          if (other && other.sub !== who.sub) return null;
        }
      }
      if (!student) {
        const roll = (who.username ?? who.sourcedId ?? `MOODLE-${who.sub}`).trim().toUpperCase();
        const { data, error } = await db
          .from("students")
          .insert({
            roll,
            full_name: who.name ?? roll,
            email: who.email ?? `${roll.toLowerCase().replace(/[^a-z0-9._-]/g, "-")}@moodle.invalid`,
            batch: who.contextTitle ?? "Moodle",
          })
          .select("id, roll, auth_id")
          .single();
        if (error || !data) return null;
        student = data;
      }
      const s = student as StudentRow;
      await db.from("lti_users").upsert({ platform_id: platform.id, sub: who.sub, student_id: s.id }, { onConflict: "platform_id,sub" });

      let authUserId = s.auth_id ? String(s.auth_id) : null;
      if (!authUserId) {
        const email = loginEmail(s.roll);
        const { data: created } = await db.auth.admin.createUser({
          email,
          password: randomToken(24),
          email_confirm: true,
          app_metadata: { role: "student", roll: s.roll, lti: true },
          user_metadata: { roll: s.roll },
        });
        authUserId = created?.user?.id ? String(created.user.id) : await findAuthUserByEmail(db, email);
        if (!authUserId) return null;
        await db.from("students").update({ auth_id: authUserId }).eq("id", s.id).is("auth_id", null);
      }
      return { studentId: String(s.id), authUserId };
    },

    async enroll(examId, studentId) {
      const { error } = await db
        .from("enrollments")
        .upsert({ exam_id: examId, student_id: studentId }, { onConflict: "exam_id,student_id", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    },

    async saveGradeTarget(t) {
      const { error } = await db.from("lti_grade_targets").upsert(
        { link_id: t.linkId, student_id: t.studentId, exam_id: t.examId, sub: t.sub, lineitem: t.lineitem },
        { onConflict: "link_id,student_id" },
      );
      if (error) throw new Error(error.message);
    },

    async createTicket(hash, t) {
      const { error } = await db.from("lti_tickets").insert({
        ticket_hash: hash,
        student_id: t.studentId,
        auth_user_id: t.authUserId,
        exam_id: t.examId,
        link_id: t.linkId,
        expires_at: new Date(t.expiresAt).toISOString(),
      });
      if (error) throw new Error(error.message);
      await db.from("lti_tickets").delete().lt("expires_at", new Date(Date.now() - 60 * 60_000).toISOString());
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

    async gradeTargets(examId, studentId) {
      const { data } = await db
        .from("lti_grade_targets")
        .select("link_id, sub, lineitem, score_maximum, link:lti_links(platform:lti_platforms(*))")
        .eq("exam_id", examId)
        .eq("student_id", studentId)
        .not("lineitem", "is", null);
      return (data ?? [])
        .map((r: any) => {
          const link = Array.isArray(r.link) ? r.link[0] : r.link;
          const platform = Array.isArray(link?.platform) ? link.platform[0] : link?.platform;
          if (!platform) return null;
          return {
            linkId: String(r.link_id),
            sub: String(r.sub),
            lineitem: String(r.lineitem),
            scoreMaximum: r.score_maximum === null || r.score_maximum === undefined ? null : Number(r.score_maximum),
            platform: toPlatform(platform),
          };
        })
        .filter(Boolean);
    },

    async setScoreMaximum(examId, studentId, max) {
      await db.from("lti_grade_targets").update({ score_maximum: max }).eq("exam_id", examId).eq("student_id", studentId);
    },

    async recordScorePost(linkId, studentId, r) {
      await db
        .from("lti_grade_targets")
        .update(r.error ? { last_error: r.error } : { last_score: r.score, last_posted_at: new Date().toISOString(), last_error: null })
        .eq("link_id", linkId)
        .eq("student_id", studentId);
    },
  };
}
