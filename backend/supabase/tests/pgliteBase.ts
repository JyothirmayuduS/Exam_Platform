// Just enough of the live schema for the migrations under test to run on PGlite.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

export const migration = (name: string) => readFileSync(resolve(__dirname, "../migrations", name), "utf8");

export const BASE = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, created_at timestamptz default now(), last_sign_in_at timestamptz, raw_app_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create schema storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb);

create table public.teachers (id uuid primary key default gen_random_uuid(), auth_id uuid, role text);
create table public.staff_admins (auth_id uuid primary key);
create table public.students (id uuid primary key, auth_id uuid, roll text, full_name text);
create table public.exams (id text primary key, name text, status text, scheduled_at timestamptz, duration_minutes int, settings jsonb, created_by uuid);
create table public.enrollments (exam_id text, student_id uuid, primary key (exam_id, student_id));
create table public.attempts (
  id uuid primary key default gen_random_uuid(), exam_id text, student_id uuid, state text, answered int, total int,
  minutes_used int, score numeric, started_at timestamptz, submitted_at timestamptz, auto_saved_at timestamptz,
  answers jsonb, status text, total_time_spent_seconds int, percentage numeric, passed boolean, rank int,
  device_info jsonb, last_saved_at timestamptz, auto_submitted boolean, created_at timestamptz default now(),
  updated_at timestamptz default now(), extra_minutes int, paper jsonb, consent_at timestamptz, consent_text text,
  user_agent text, session_id text, session_seen_at timestamptz, paused_at timestamptz, paused_seconds int, resume_state jsonb);
create table public.result_holds (attempt_id uuid primary key, exam_id text not null, student_id uuid not null, reason text, held_by uuid, held_at timestamptz not null default now());
create table public.student_photos (student_id uuid primary key, storage_path text, bytes int, captured_at timestamptz default now());
create table public.lti_grade_targets (link_id uuid, student_id uuid, exam_id text, sub text, lineitem text, score_maximum numeric,
  last_score numeric, last_posted_at timestamptz, last_error text, pending_score numeric, post_attempts int default 0,
  next_attempt_at timestamptz, claim_token uuid, claimed_until timestamptz, primary key (link_id, student_id));
create table public.audit_logs (id bigserial primary key, actor_id uuid, actor_role text, action text, target_type text, target_id text, meta jsonb, created_at timestamptz default now());
create table public.proctor_assignments (id uuid primary key default gen_random_uuid(), exam_id text, assignee_id uuid, assignee_name text not null default 'x', assignee_role text not null default 'proctor');
create table public.violation_events (id uuid primary key default gen_random_uuid(), exam_id text, student_id uuid, attempt_id uuid, severity text, violation_type text);
create table public.proctor_sessions (id uuid primary key default gen_random_uuid(), attempt_id uuid, livekit_room text);
create table public.proctor_messages (id uuid primary key default gen_random_uuid(), exam_id text, body text);
create table public.ai_reports (attempt_id uuid primary key, exam_id text, student_id uuid, summary text);
create table public.mobile_upload_sessions (id uuid primary key default gen_random_uuid(), attempt_id uuid, student_id uuid, exam_id text);
create function public.attempt_deadline(p_attempt uuid) returns timestamptz language sql stable as $$ select null::timestamptz $$;

create function public.auth_is_staff() returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from public.teachers where auth_id = auth.uid()) $$;
create function public.auth_is_teacher() returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from public.teachers where auth_id = auth.uid() and role = 'teacher') $$;
create function public.auth_is_staff_admin() returns boolean language sql stable security definer set search_path = '' as
  $$ select public.auth_is_teacher() and exists (select 1 from public.staff_admins a where a.auth_id = auth.uid()) $$;
create function public.owns_exam(p_exam text) returns boolean language sql stable security definer set search_path = '' as
  $$ select public.auth_is_teacher() and exists (select 1 from public.exams e where e.id = p_exam and (e.created_by is null or e.created_by = auth.uid())) $$;
create function public.current_student_id() returns uuid language sql stable security definer set search_path = public as
  $$ select id from public.students where auth_id = auth.uid() limit 1 $$;

alter table public.attempts enable row level security;
alter table public.result_holds enable row level security;
alter table public.student_photos enable row level security;
alter table public.exams enable row level security;
alter table public.proctor_assignments enable row level security;
alter table public.violation_events enable row level security;
alter table public.proctor_sessions enable row level security;
alter table public.proctor_messages enable row level security;
alter table public.ai_reports enable row level security;
alter table public.mobile_upload_sessions enable row level security;
alter table storage.objects enable row level security;
grant usage on schema public, storage to anon, authenticated;
grant select, insert, update, delete on public.exams, public.proctor_assignments, public.violation_events, public.proctor_sessions,
  public.proctor_messages, public.ai_reports, public.mobile_upload_sessions, storage.objects to authenticated;
grant delete on public.attempts to authenticated;
create policy "ep exams staff read" on public.exams for select to authenticated using (public.auth_is_staff());
grant select, insert, update on public.attempts to anon, authenticated;
grant select on public.result_holds, public.student_photos to authenticated;
create policy "ep attempts student read" on public.attempts for select to authenticated using (student_id = public.current_student_id());
create policy "ep attempts student update" on public.attempts for update to authenticated
  using (student_id = public.current_student_id() and state <> 'submitted') with check (student_id = public.current_student_id());
create policy "ep attempts staff read" on public.attempts for select to authenticated using (public.auth_is_staff());
create policy "ep attempts staff update" on public.attempts for update to authenticated using (public.auth_is_staff()) with check (public.auth_is_staff());
create policy "result holds staff read" on public.result_holds for select to authenticated using (public.auth_is_staff());
create policy "student photos own read" on public.student_photos for select to authenticated using (student_id = public.current_student_id());
create policy "student photos staff read" on public.student_photos for select to authenticated using (public.auth_is_staff());
`;

/** Run `fn` as a signed-in user (`authId`), as anon (`null`), or as the owner (`undefined`). */
export function actAs(db: PGlite) {
  return async <T>(authId: string | null | undefined, run: () => Promise<T>): Promise<T> => {
    await db.exec(`set request.jwt.claim.sub = '${authId ?? ""}'; set request.jwt.claim.role = '${authId ? "authenticated" : authId === null ? "anon" : ""}'`);
    if (authId) await db.exec("set role authenticated");
    else if (authId === null) await db.exec("set role anon");
    try {
      return await run();
    } finally {
      await db.exec("reset role; reset request.jwt.claim.sub; reset request.jwt.claim.role");
    }
  };
}
