-- Vignan OS — GO-LIVE: provision real auth users and switch to role-scoped RLS
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS DOES
--   1. Creates real Supabase Auth accounts for the seeded teacher, proctor and
--      every student (roll@student.vignan.ac.in / password Vignan@123, staff
--      password123) and links students.auth_id / teachers.auth_id.
--   2. Drops the wide-open "demo" anon policies and replaces them with
--      role-scoped policies (staff vs student), so anonymous visitors can no
--      longer read or write exams/questions/attempts/violations.
--   3. Keeps ONE narrow anon exception: mobile_upload_sessions, so the QR
--      handwritten-answer upload flow keeps working without a login (it is
--      token-gated by the edge function server-side).
--
-- ⚠️  REVIEW BEFORE APPLYING. After this runs, the app requires real logins:
--      Student → roll + Vignan@123   Teacher → teacher@vignan.ac.in / password123
--      Proctor  → proctor@vignan.ac.in / password123
--    It is idempotent (safe to re-run).
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Provision auth users for seeded accounts (idempotent per email)
-- ─────────────────────────────────────────────────────────────────────────────
-- pgcrypto lives in the `extensions` schema on Supabase; install there and
-- qualify every call so migrations never depend on the active search_path.
create extension if not exists pgcrypto with schema extensions;

do $$
declare
  u uuid;
  login_email text;
  r record;
begin
  -- Teachers & proctors (from public.teachers)
  for r in select email from public.teachers loop
    login_email := lower(btrim(r.email));
    if not exists (select 1 from auth.users where email = login_email) then
      u := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, recovery_token,
        email_change_token_new, email_change_token_current
      ) values (
        '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
        login_email, extensions.crypt('password123', extensions.gen_salt('bf')), now(),
        jsonb_build_object('provider','email','providers',array['email']),
        '{}'::jsonb, now(), now(), '', '', '', ''
      );
      insert into auth.identities (
        id, user_id, provider_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(), u, u::text,
        jsonb_build_object('sub', u::text, 'email', login_email, 'email_verified', true, 'phone_verified', false),
        'email', now(), now(), now()
      );
    end if;
  end loop;

  -- Students: login email is roll@student.vignan.ac.in (lowercase roll)
  for r in select roll, id from public.students loop
    login_email := lower(btrim(r.roll)) || '@student.vignan.ac.in';
    if not exists (select 1 from auth.users where email = login_email) then
      u := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, confirmation_token, recovery_token,
        email_change_token_new, email_change_token_current
      ) values (
        '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
        login_email, extensions.crypt('Vignan@123', extensions.gen_salt('bf')), now(),
        jsonb_build_object('provider','email','providers',array['email']),
        '{}'::jsonb, now(), now(), '', '', '', ''
      );
      insert into auth.identities (
        id, user_id, provider_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) values (
        gen_random_uuid(), u, u::text,
        jsonb_build_object('sub', u::text, 'email', login_email, 'email_verified', true, 'phone_verified', false),
        'email', now(), now(), now()
      );
    end if;
  end loop;
end $$;

-- Link auth_id on the profile rows (never overwrite a real link).
update public.teachers t
  set auth_id = a.id
  from auth.users a
  where a.email = lower(btrim(t.email))
    and (t.auth_id is null or t.auth_id = '00000000-0000-0000-0000-000000000001'::uuid or t.auth_id = '00000000-0000-0000-0000-000000000002'::uuid);

update public.students s
  set auth_id = a.id
  from auth.users a
  where a.email = lower(btrim(s.roll)) || '@student.vignan.ac.in'
    and s.auth_id is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Role helpers (security definer — stable across RLS evaluations)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.current_student_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.students where auth_id = auth.uid() limit 1;
$$;

create or replace function public.auth_is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.teachers where auth_id = auth.uid());
$$;

create or replace function public.auth_is_teacher()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.teachers where auth_id = auth.uid() and role = 'teacher');
$$;

create or replace function public.auth_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role from public.teachers where auth_id = auth.uid() limit 1),
    case when exists (select 1 from public.students where auth_id = auth.uid()) then 'student' else null end
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Drop every open demo policy (see 20260910000001 + demo-policies.sql)
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "demo students all"    on public.students;
drop policy if exists "demo exams read"      on public.exams;
drop policy if exists "demo exams write"     on public.exams;
drop policy if exists "demo questions all"   on public.questions;
drop policy if exists "demo exam pool all"   on public.exam_questions;
drop policy if exists "demo enrollments all" on public.enrollments;
drop policy if exists "demo attempts all"    on public.attempts;
drop policy if exists "demo proctor all"     on public.proctor_sessions;
drop policy if exists "demo violation all"   on public.violation_events;
drop policy if exists "demo messages all"    on public.proctor_messages;
drop policy if exists "demo assignments all" on public.proctor_assignments;
drop policy if exists "demo grading all"     on public.grading_comments;
drop policy if exists "demo grading delegation all" on public.grading_delegations;
drop policy if exists "demo teachers all"    on public.teachers;
drop policy if exists "Teachers can read their own profile" on public.teachers;

-- Older auth-scoped names (schema.sql) that could linger:
drop policy if exists "students read self"            on public.students;
drop policy if exists "read live exams"               on public.exams;
drop policy if exists "teachers manage own exams"     on public.exams;
drop policy if exists "read questions of visible exams" on public.questions;
drop policy if exists "own attempt read"              on public.attempts;
drop policy if exists "own attempt write"             on public.attempts;
drop policy if exists "teachers read attempts for own exams" on public.attempts;
drop policy if exists "teachers update attempts for own exams" on public.attempts;
drop policy if exists "teachers update own profile"          on public.teachers;
drop policy if exists "students own violations"         on public.violation_events;
drop policy if exists "teachers own exam violations"    on public.violation_events;
drop policy if exists "teachers own exam messages"      on public.proctor_messages;
drop policy if exists "students read exam messages"     on public.proctor_messages;
drop policy if exists "teachers own exam assignments"   on public.proctor_assignments;
drop policy if exists "teachers manage grading comments" on public.grading_comments;
drop policy if exists "teachers manage exam pools"       on public.exam_questions;
drop policy if exists "read exam pools of visible exams" on public.exam_questions;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Role-scoped policies
-- ─────────────────────────────────────────────────────────────────────────────
-- students: self read/update; staff may read/write the roster (enrolment admin)
alter table public.students enable row level security;
drop policy if exists "ep students self" on public.students;
drop policy if exists "ep students staff" on public.students;
create policy "ep students self" on public.students
  for select using (auth_id = auth.uid());
create policy "ep students staff" on public.students
  for all using (public.auth_is_staff()) with check (public.auth_is_staff());

-- teachers: self read/update; staff (any teacher/proctor) may read colleagues
alter table public.teachers enable row level security;
drop policy if exists "ep teachers self" on public.teachers;
drop policy if exists "ep teachers staff read" on public.teachers;
create policy "ep teachers self" on public.teachers
  for all using (auth_id = auth.uid()) with check (auth_id = auth.uid());
create policy "ep teachers staff read" on public.teachers
  for select using (public.auth_is_staff());

-- exams: teachers full; proctors read non-draft; students read non-draft when enrolled
alter table public.exams enable row level security;
drop policy if exists "ep exams teacher" on public.exams;
drop policy if exists "ep exams proctor read" on public.exams;
drop policy if exists "ep exams student read" on public.exams;
create policy "ep exams teacher" on public.exams
  for all using (public.auth_is_staff()) with check (public.auth_is_teacher());
create policy "ep exams student read" on public.exams
  for select using (
    status <> 'draft'
    and exists (
      select 1 from public.enrollments e
      where e.exam_id = exams.id and e.student_id = public.current_student_id()
    )
  );

-- questions / exam_questions: staff full; students read questions of their exams
alter table public.questions enable row level security;
drop policy if exists "ep questions staff" on public.questions;
drop policy if exists "ep questions student read" on public.questions;
create policy "ep questions staff" on public.questions
  for all using (public.auth_is_staff()) with check (public.auth_is_teacher());
create policy "ep questions student read" on public.questions
  for select using (
    -- question owned directly by one of the student's exams
    exists (
      select 1 from public.exams x
      join public.enrollments e on e.exam_id = x.id
      where x.id = questions.exam_id
        and e.student_id = public.current_student_id()
        and x.status <> 'draft'
    )
    -- or part of a reusable pool attached to one of the student's exams
    or exists (
      select 1 from public.exam_questions xq
      join public.exams x on x.id = xq.exam_id
      join public.enrollments e on e.exam_id = x.id
      where xq.question_id = questions.id
        and e.student_id = public.current_student_id()
        and x.status <> 'draft'
    )
  );

alter table public.exam_questions enable row level security;
drop policy if exists "ep pool staff" on public.exam_questions;
drop policy if exists "ep pool student read" on public.exam_questions;
create policy "ep pool staff" on public.exam_questions
  for all using (public.auth_is_staff()) with check (public.auth_is_teacher());
create policy "ep pool student read" on public.exam_questions
  for select using (
    exists (
      select 1 from public.exams x
      join public.enrollments e on e.exam_id = x.id
      where x.id = exam_questions.exam_id
        and e.student_id = public.current_student_id()
        and x.status <> 'draft'
    )
  );

-- enrollments: staff manage; student reads own enrolment (sees own exams)
alter table public.enrollments enable row level security;
drop policy if exists "ep enroll staff" on public.enrollments;
drop policy if exists "ep enroll student" on public.enrollments;
create policy "ep enroll staff" on public.enrollments
  for all using (public.auth_is_staff()) with check (public.auth_is_teacher());
create policy "ep enroll student" on public.enrollments
  for select using (student_id = public.current_student_id());

-- attempts: student owns their rows (create/read/update); staff read + update all
alter table public.attempts enable row level security;
drop policy if exists "ep attempts student" on public.attempts;
drop policy if exists "ep attempts staff" on public.attempts;
create policy "ep attempts student" on public.attempts
  for all using (student_id = public.current_student_id())
  with check (student_id = public.current_student_id());
create policy "ep attempts staff" on public.attempts
  for all using (public.auth_is_staff()) with check (public.auth_is_staff());

-- proctor_sessions: the student registers a room for their OWN attempt
-- (sessions are keyed by attempt_id, which resolves back to the student);
-- staff manage all sessions.
alter table public.proctor_sessions enable row level security;
drop policy if exists "ep psession student" on public.proctor_sessions;
drop policy if exists "ep psession staff" on public.proctor_sessions;
create policy "ep psession student" on public.proctor_sessions
  for all using (
    exists (
      select 1 from public.attempts a
      where a.id = proctor_sessions.attempt_id
        and a.student_id = public.current_student_id()
    )
  )
  with check (
    exists (
      select 1 from public.attempts a
      where a.id = proctor_sessions.attempt_id
        and a.student_id = public.current_student_id()
    )
  );
create policy "ep psession staff" on public.proctor_sessions
  for all using (public.auth_is_staff()) with check (public.auth_is_staff());

-- violation_events: student logs/reads own; staff read + write all
alter table public.violation_events enable row level security;
drop policy if exists "ep violation student" on public.violation_events;
drop policy if exists "ep violation staff" on public.violation_events;
create policy "ep violation student" on public.violation_events
  for all using (student_id = public.current_student_id())
  with check (student_id = public.current_student_id());
create policy "ep violation staff" on public.violation_events
  for all using (public.auth_is_staff()) with check (public.auth_is_staff());

-- proctor_messages: staff read/write; student reads messages aimed at their exam
alter table public.proctor_messages enable row level security;
drop policy if exists "ep messages staff" on public.proctor_messages;
drop policy if exists "ep messages student" on public.proctor_messages;
create policy "ep messages staff" on public.proctor_messages
  for all using (public.auth_is_staff()) with check (public.auth_is_staff());
create policy "ep messages student" on public.proctor_messages
  for select using (
    exists (
      select 1 from public.enrollments e
      where e.exam_id = proctor_messages.exam_id
        and e.student_id = public.current_student_id()
    )
  );

-- proctor_assignments / grading_delegations / grading_comments: staff-managed
alter table public.proctor_assignments enable row level security;
drop policy if exists "ep assignments staff" on public.proctor_assignments;
create policy "ep assignments staff" on public.proctor_assignments
  for all using (public.auth_is_staff()) with check (public.auth_is_staff());

do $$ begin
  if to_regclass('public.grading_delegations') is not null then
    execute 'alter table public.grading_delegations enable row level security';
    execute 'drop policy if exists "ep delegation staff" on public.grading_delegations';
    execute 'create policy "ep delegation staff" on public.grading_delegations for all using (public.auth_is_staff()) with check (public.auth_is_staff())';
  end if;
  if to_regclass('public.grading_comments') is not null then
    execute 'alter table public.grading_comments enable row level security';
    execute 'drop policy if exists "ep comments staff" on public.grading_comments';
    execute 'create policy "ep comments staff" on public.grading_comments for all using (public.auth_is_staff()) with check (public.auth_is_staff())';
  end if;
  if to_regclass('public.teacher_settings') is not null then
    execute 'alter table public.teacher_settings enable row level security';
    execute 'drop policy if exists "ep teacher settings staff" on public.teacher_settings';
    execute 'create policy "ep teacher settings staff" on public.teacher_settings for all using (public.auth_is_staff()) with check (public.auth_is_staff())';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The single anon exception: QR mobile upload sessions (token-gated by the
--    mobile-upload edge function server-side). Nothing else stays anon-open.
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if to_regclass('public.mobile_upload_sessions') is not null then
    execute 'alter table public.mobile_upload_sessions enable row level security';
    execute 'drop policy if exists "ep mobile upload anon" on public.mobile_upload_sessions';
    execute 'create policy "ep mobile upload anon" on public.mobile_upload_sessions for all using (true) with check (true)';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sanity: no anonymous access remains on the core tables.
--   select schemaname, tablename, policyname, roles from pg_policies
--   where tablename in ('attempts','violation_events','questions','exams');
-- ─────────────────────────────────────────────────────────────────────────────
