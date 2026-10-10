-- Exam data by role.
--
-- Full access (marks, answers, keys, grading): the exam's owner, teachers
-- delegated to it (grading_delegations, or proctor_assignments where the
-- assignee's teachers.role is 'teacher'), and admins.
-- Invigilation: proctors assigned to the exam (teachers.role = 'proctor') see
-- the student list, attempt state through proctor_attempts, violations,
-- messages and AI reports, and may flag, warn and pause. Never marks,
-- answers, questions or grading data.
-- Everyone else on staff sees nothing of the exam.
-- Server functions use the service role and are not affected.

-- ── Who may do what ─────────────────────────────────────────────────────────
-- Exams with full access, admins aside (policies add auth_is_staff_admin()).
create or replace function public.staff_exam_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from public.exams e
  where e.created_by = auth.uid() and public.auth_is_teacher()
  union
  select pa.exam_id from public.proctor_assignments pa
  join public.teachers t on t.id = pa.assignee_id
  where t.auth_id = auth.uid() and t.role = 'teacher' and pa.exam_id is not null
  union
  select coalesce(g.exam_id, a.exam_id) from public.grading_delegations g
  join public.teachers t on t.id = g.delegate_id
  left join public.attempts a on a.id = g.attempt_id
  where t.auth_id = auth.uid() and t.role = 'teacher' and coalesce(g.exam_id, a.exam_id) is not null;
$$;

create or replace function public.proctor_exam_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select pa.exam_id from public.proctor_assignments pa
  join public.teachers t on t.id = pa.assignee_id
  where t.auth_id = auth.uid() and t.role = 'proctor' and pa.exam_id is not null;
$$;

create or replace function public.invigilated_exam_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select public.staff_exam_ids() union select public.proctor_exam_ids();
$$;

create or replace function public.can_manage_exam(p_exam text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_exam is not null and (public.auth_is_staff_admin() or p_exam in (select public.staff_exam_ids()));
$$;

create or replace function public.can_invigilate_exam(p_exam text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_exam is not null and (public.auth_is_staff_admin() or p_exam in (select public.invigilated_exam_ids()));
$$;

create or replace function public.can_access_exam(p_exam text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_manage_exam(p_exam);
$$;

-- attempt_id is text on some tables; anything that is not a uuid has no exam.
create or replace function public.attempt_exam(p_attempt text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select a.exam_id from public.attempts a
  where a.id = (case when p_attempt ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_attempt::uuid end);
$$;

create or replace function public.mobile_session_exam(p_session uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(s.exam_id, public.attempt_exam(s.attempt_id::text))
  from public.mobile_upload_sessions s where s.id = p_session;
$$;

-- Every exam a question belongs to: its own exam and any exam pool it is in.
create or replace function public.question_exams(p_question text)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select q.exam_id from public.questions q where q.id = p_question and q.exam_id is not null
  union
  select xq.exam_id from public.exam_questions xq where xq.question_id = p_question;
$$;

-- ── Evidence folders ────────────────────────────────────────────────────────
-- New evidence is written under the exam id. Folders the kiosk used to name
-- after the exam (raw or slugged) stay readable by the exam's owner only.
create or replace function public.exam_folder_slug(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(regexp_replace(regexp_replace(btrim(coalesce(p_name, '')), '[^A-Za-z0-9._-]+', '-', 'g'), '^-+|-+$', '', 'g'), 60);
$$;

create or replace function public.owner_legacy_folders()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select f from public.exams e
  cross join lateral (values (e.name), (public.exam_folder_slug(e.name))) v(f)
  where e.created_by = auth.uid() and public.auth_is_teacher()
    and coalesce(f, '') <> ''
    and not exists (select 1 from public.exams other where other.id = f);
$$;

-- What the signed-in staff member may do with each top-level evidence folder:
-- 'full' (read and write), 'legacy' (read only), 'proctor' (violation frames
-- of an exam they invigilate), or null.
create or replace function public.evidence_folder_access(p_folders text[])
returns table(folder text, access text)
language sql
stable
security definer
set search_path = ''
as $$
  select f, case
    when public.auth_is_staff_admin() then 'full'
    when f in (select public.staff_exam_ids()) then 'full'
    when f in (select public.owner_legacy_folders()) then 'legacy'
    when f in (select public.proctor_exam_ids()) then 'proctor'
  end
  from unnest(p_folders) f;
$$;

drop policy if exists "exam-records exam staff" on storage.objects;
drop function if exists public.staff_exam_folders();

-- Two exams may not share a name or a folder slug.
create unique index if not exists exams_name_unique on public.exams (name)
  where coalesce(name, '') <> '';
create unique index if not exists exams_folder_slug_unique on public.exams (public.exam_folder_slug(name))
  where public.exam_folder_slug(name) <> '';

-- ── LiveKit rooms ───────────────────────────────────────────────────────────
-- Rooms are named after the exam id, or voice-<exam id>-<roll>.
create or replace function public.livekit_room_exam(p_room text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from public.exams e
  cross join lateral (select left(regexp_replace(e.id, '[^A-Za-z0-9_-]', '-', 'g'), 120) s) r
  where p_room = r.s or left(p_room, length(r.s) + 7) = 'voice-' || r.s || '-'
  order by length(e.id) desc
  limit 1;
$$;

create or replace function public.can_join_livekit_room(p_room text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.can_invigilate_exam(public.livekit_room_exam(p_room)), false);
$$;

revoke all on function public.staff_exam_ids() from public, anon;
revoke all on function public.proctor_exam_ids() from public, anon;
revoke all on function public.invigilated_exam_ids() from public, anon;
revoke all on function public.can_manage_exam(text) from public, anon;
revoke all on function public.can_invigilate_exam(text) from public, anon;
revoke all on function public.can_access_exam(text) from public, anon;
revoke all on function public.attempt_exam(text) from public, anon;
revoke all on function public.mobile_session_exam(uuid) from public, anon;
revoke all on function public.question_exams(text) from public, anon;
revoke all on function public.owner_legacy_folders() from public, anon;
revoke all on function public.evidence_folder_access(text[]) from public, anon;
revoke all on function public.livekit_room_exam(text) from public, anon;
revoke all on function public.can_join_livekit_room(text) from public, anon;
grant execute on function public.staff_exam_ids() to authenticated, service_role;
grant execute on function public.proctor_exam_ids() to authenticated, service_role;
grant execute on function public.invigilated_exam_ids() to authenticated, service_role;
grant execute on function public.can_manage_exam(text) to authenticated, service_role;
grant execute on function public.can_invigilate_exam(text) to authenticated, service_role;
grant execute on function public.can_access_exam(text) to authenticated, service_role;
grant execute on function public.attempt_exam(text) to authenticated, service_role;
grant execute on function public.mobile_session_exam(uuid) to authenticated, service_role;
grant execute on function public.question_exams(text) to authenticated, service_role;
grant execute on function public.owner_legacy_folders() to authenticated, service_role;
grant execute on function public.evidence_folder_access(text[]) to authenticated, service_role;
grant execute on function public.livekit_room_exam(text) to authenticated, service_role;
grant execute on function public.can_join_livekit_room(text) to authenticated, service_role;

-- ── exams ───────────────────────────────────────────────────────────────────
drop policy if exists "ep exams staff read" on public.exams;
drop policy if exists "proctors read assigned exams" on public.exams;
drop policy if exists "ep exams exam staff read" on public.exams;
create policy "ep exams exam staff read" on public.exams
  for select to authenticated
  using (created_by = (select auth.uid()) or (select public.auth_is_staff_admin())
         or id in (select public.invigilated_exam_ids()));

drop policy if exists "ep exams teacher insert" on public.exams;
create policy "ep exams teacher insert" on public.exams
  for insert to authenticated
  with check ((select public.auth_is_teacher())
              and (created_by = (select auth.uid()) or (select public.auth_is_staff_admin())));

-- An owner cannot hand the exam to someone else; an admin can.
drop policy if exists "ep exams owner update" on public.exams;
create policy "ep exams owner update" on public.exams
  for update to authenticated
  using ((select public.auth_is_staff_admin()) or public.owns_exam(id))
  with check ((select public.auth_is_staff_admin())
              or (created_by = (select auth.uid()) and (select public.auth_is_teacher())));
drop policy if exists "ep exams owner delete" on public.exams;
create policy "ep exams owner delete" on public.exams
  for delete to authenticated
  using ((select public.auth_is_staff_admin()) or public.owns_exam(id));

-- ── proctor_assignments ─────────────────────────────────────────────────────
drop policy if exists "ep assignments staff read" on public.proctor_assignments;
drop policy if exists "ep assignments exam staff read" on public.proctor_assignments;
create policy "ep assignments exam staff read" on public.proctor_assignments
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));

-- ── enrollments: the student list ───────────────────────────────────────────
drop policy if exists "ep enroll staff read" on public.enrollments;
drop policy if exists "ep enroll exam staff read" on public.enrollments;
create policy "ep enroll exam staff read" on public.enrollments
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()));
drop policy if exists "ep enroll owner write" on public.enrollments;
create policy "ep enroll owner write" on public.enrollments
  for all to authenticated
  using ((select public.auth_is_staff_admin()) or public.owns_exam(exam_id))
  with check ((select public.auth_is_staff_admin()) or public.owns_exam(exam_id));

-- ── attempts: full access only; proctors use proctor_attempts ───────────────
drop policy if exists "ep attempts exam staff read" on public.attempts;
create policy "ep attempts exam staff read" on public.attempts
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));
drop policy if exists "ep attempts exam staff update" on public.attempts;
create policy "ep attempts exam staff update" on public.attempts
  for update to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()))
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));

create or replace view public.staff_attempts with (security_barrier = true) as
  select a.* from public.attempts a
  where (select public.auth_is_staff_admin()) or a.exam_id in (select public.staff_exam_ids());

-- Attempt state for invigilation: no marks, answers, paper or resume state.
create or replace view public.proctor_attempts with (security_barrier = true) as
  select a.id, a.exam_id, a.student_id, a.state, a.answered, a.total, a.minutes_used,
         a.started_at, a.submitted_at, a.auto_saved_at, a.last_saved_at, a.status, a.auto_submitted,
         a.extra_minutes, a.paused_at, a.paused_seconds, a.consent_at, a.user_agent,
         a.session_seen_at, a.created_at, a.updated_at
  from public.attempts a
  where (select public.auth_is_staff_admin()) or a.exam_id in (select public.invigilated_exam_ids());

revoke all on public.proctor_attempts from public, anon, authenticated;
grant select on public.proctor_attempts to authenticated, service_role;

create or replace function public.set_attempt_paused(p_attempt uuid, p_paused boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam text;
  v_state text;
begin
  select a.exam_id, a.state into v_exam, v_state from public.attempts a where a.id = p_attempt for update;
  if v_exam is null then
    raise exception 'not_found: attempt not found' using errcode = 'P0002';
  end if;
  if not public.can_invigilate_exam(v_exam) then
    raise exception 'forbidden: you are not invigilating this exam' using errcode = '42501';
  end if;
  if v_state = 'submitted' then
    raise exception 'not_live: this attempt has been submitted' using errcode = 'P0001';
  end if;
  update public.attempts a
     set state = case when p_paused then 'paused' else 'in_progress' end
   where a.id = p_attempt
  returning a.state into v_state;
  return v_state;
end;
$$;

revoke all on function public.set_attempt_paused(uuid, boolean) from public, anon;
grant execute on function public.set_attempt_paused(uuid, boolean) to authenticated;

-- Marks and answers: a refused change is an error, never a silent revert.
create or replace function public.guard_attempt_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deadline timestamptz;
begin
  if coalesce(auth.role(), '') = 'authenticated' and not public.auth_is_staff() then
    if tg_op = 'INSERT' then
      new.state := 'in_progress';
      new.score := null;
      new.percentage := null;
      new.passed := null;
      new.rank := null;
      new.submitted_at := null;
      new.auto_submitted := false;
      new.started_at := now();
      new.extra_minutes := 0;
      new.paused_at := null;
      new.paused_seconds := 0;
      return new;
    end if;

    if old.state = 'submitted' then
      raise exception 'attempt_submitted: this exam has already been submitted' using errcode = 'P0001';
    end if;
    new.id := old.id;
    new.exam_id := old.exam_id;
    new.student_id := old.student_id;
    new.score := old.score;
    new.percentage := old.percentage;
    new.passed := old.passed;
    new.rank := old.rank;
    new.submitted_at := old.submitted_at;
    new.auto_submitted := old.auto_submitted;
    new.extra_minutes := old.extra_minutes;
    new.paused_at := old.paused_at;
    new.paused_seconds := old.paused_seconds;
    new.started_at := coalesce(old.started_at, now());
    if old.state = 'in_progress' and new.state = 'submitted' then
      new.submitted_at := now();
    elsif not (old.state = 'not_started' and new.state = 'in_progress') then
      new.state := old.state;
    end if;
    if jsonb_typeof(old.paper) = 'array' and jsonb_array_length(old.paper) > 0 then
      new.paper := old.paper;
    end if;
    if new.answers is distinct from old.answers then
      if old.state = 'paused' then
        new.answers := old.answers;
      else
        v_deadline := public.attempt_deadline(old.id);
        if v_deadline is not null and now() > v_deadline + interval '2 minutes' then
          if new.state = 'submitted' then
            new.answers := old.answers;
          else
            raise exception 'exam_time_over: the time for this exam is over' using errcode = 'P0001';
          end if;
        end if;
      end if;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if coalesce(auth.role(), '') = 'authenticated'
       and not public.can_manage_exam(old.exam_id)
       and (new.score is distinct from old.score
            or new.percentage is distinct from old.percentage
            or new.passed is distinct from old.passed
            or new.rank is distinct from old.rank
            or new.answers is distinct from old.answers) then
      raise exception 'marks_forbidden: only the exam''s owner, a delegated teacher or an admin can change marks'
        using errcode = '42501';
    end if;
    if coalesce(auth.role(), '') = 'authenticated'
       and coalesce(current_setting('app.extra_minutes_ok', true), '') <> '1' then
      new.extra_minutes := old.extra_minutes;
    end if;
    if new.state = 'paused' and old.state is distinct from 'paused' then
      new.paused_at := now();
    elsif old.state = 'paused' and new.state is distinct from 'paused' then
      new.paused_seconds := coalesce(old.paused_seconds, 0)
        + greatest(0, floor(extract(epoch from now() - coalesce(old.paused_at, now()))))::integer;
      new.paused_at := null;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.add_attempt_extra_minutes(p_attempt uuid, p_minutes integer)
returns table(extra_minutes integer, deadline timestamptz, seconds_left integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exam text;
  v_student uuid;
  v_state text;
  v_total integer;
  v_deadline timestamptz;
begin
  if p_minutes is null or p_minutes < 1 or p_minutes > 120 then
    raise exception 'invalid_minutes: add between 1 and 120 minutes' using errcode = '22023';
  end if;
  select a.exam_id, a.student_id, a.state into v_exam, v_student, v_state
  from public.attempts a where a.id = p_attempt
  for update;
  if v_exam is null then
    raise exception 'not_found: attempt not found' using errcode = 'P0002';
  end if;
  if not public.can_manage_exam(v_exam) then
    raise exception 'forbidden: only the exam''s owner, a delegated teacher or an admin can add time' using errcode = '42501';
  end if;
  if v_state not in ('in_progress', 'paused') then
    raise exception 'not_live: time can only be added while the attempt is in progress' using errcode = 'P0001';
  end if;

  perform set_config('app.extra_minutes_ok', '1', true);
  update public.attempts a
     set extra_minutes = coalesce(a.extra_minutes, 0) + p_minutes
   where a.id = p_attempt
  returning a.extra_minutes into v_total;
  perform set_config('app.extra_minutes_ok', '', true);

  insert into public.audit_logs (actor_id, actor_role, action, target_type, target_id, meta)
  values (auth.uid(), 'teacher', 'attempt.time_extended', 'attempt', p_attempt::text,
          jsonb_build_object('minutes', p_minutes, 'total_extra', v_total, 'exam_id', v_exam, 'student_id', v_student));

  v_deadline := public.attempt_deadline(p_attempt);
  return query select v_total, v_deadline,
    greatest(0, floor(extract(epoch from v_deadline - now())))::integer;
end;
$$;

-- ── violation_events ────────────────────────────────────────────────────────
drop policy if exists "ep violation exam staff read" on public.violation_events;
create policy "ep violation exam staff read" on public.violation_events
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()));
drop policy if exists "ep violation exam staff insert" on public.violation_events;
create policy "ep violation exam staff insert" on public.violation_events
  for insert to authenticated
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()));
drop policy if exists "ep violation exam staff update" on public.violation_events;
create policy "ep violation exam staff update" on public.violation_events
  for update to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()))
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()));

-- ── flag_reviews ────────────────────────────────────────────────────────────
drop policy if exists "flag reviews staff read" on public.flag_reviews;
drop policy if exists "flag reviews exam staff read" on public.flag_reviews;
create policy "flag reviews exam staff read" on public.flag_reviews
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()));

-- ── proctor_sessions, proctor_messages, ai_reports ──────────────────────────
drop policy if exists "ep psession exam staff" on public.proctor_sessions;
create policy "ep psession exam staff" on public.proctor_sessions
  for all to authenticated
  using ((select public.auth_is_staff_admin())
         or public.attempt_exam(attempt_id::text) in (select public.invigilated_exam_ids()))
  with check ((select public.auth_is_staff_admin())
              or public.attempt_exam(attempt_id::text) in (select public.invigilated_exam_ids()));

drop policy if exists "ep messages exam staff" on public.proctor_messages;
create policy "ep messages exam staff" on public.proctor_messages
  for all to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()))
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()));

drop policy if exists "ep aireports exam staff" on public.ai_reports;
create policy "ep aireports exam staff" on public.ai_reports
  for all to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()))
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.invigilated_exam_ids()));

-- ── phone monitor sessions and their events ─────────────────────────────────
drop policy if exists "ep mobile exam staff read" on public.mobile_upload_sessions;
create policy "ep mobile exam staff read" on public.mobile_upload_sessions
  for select to authenticated
  using ((select public.auth_is_staff_admin())
         or coalesce(exam_id, public.attempt_exam(attempt_id::text)) in (select public.invigilated_exam_ids()));

drop policy if exists "Staff read all mobile session events" on public.mobile_session_events;
drop policy if exists "ep mobile events exam staff read" on public.mobile_session_events;
create policy "ep mobile events exam staff read" on public.mobile_session_events
  for select to authenticated
  using ((select public.auth_is_staff_admin())
         or public.mobile_session_exam(session_id) in (select public.invigilated_exam_ids()));

-- ── Grading data: full access only ──────────────────────────────────────────
drop policy if exists "ep qsub staff read" on public.question_submissions;
drop policy if exists "ep qsub exam staff read" on public.question_submissions;
create policy "ep qsub exam staff read" on public.question_submissions
  for select to authenticated
  using ((select public.auth_is_staff_admin())
         or public.attempt_exam(attempt_id::text) in (select public.staff_exam_ids()));

drop policy if exists "ep comments staff read" on public.grading_comments;
drop policy if exists "ep comments teacher write" on public.grading_comments;
drop policy if exists "ep comments exam staff" on public.grading_comments;
create policy "ep comments exam staff" on public.grading_comments
  for all to authenticated
  using ((select public.auth_is_staff_admin())
         or public.attempt_exam(attempt_id::text) in (select public.staff_exam_ids()))
  with check ((select public.auth_is_staff_admin())
              or public.attempt_exam(attempt_id::text) in (select public.staff_exam_ids()));

drop policy if exists "ep delegation staff read" on public.grading_delegations;
drop policy if exists "ep delegation teacher write" on public.grading_delegations;
drop policy if exists "teachers manage grading delegations" on public.grading_delegations;
drop policy if exists "ep delegation exam staff read" on public.grading_delegations;
create policy "ep delegation exam staff read" on public.grading_delegations
  for select to authenticated
  using ((select public.auth_is_staff_admin())
         or coalesce(exam_id, public.attempt_exam(attempt_id::text)) in (select public.staff_exam_ids()));
drop policy if exists "ep delegation owner write" on public.grading_delegations;
create policy "ep delegation owner write" on public.grading_delegations
  for all to authenticated
  using ((select public.auth_is_staff_admin()) or public.owns_exam(coalesce(exam_id, public.attempt_exam(attempt_id::text))))
  with check ((select public.auth_is_staff_admin()) or public.owns_exam(coalesce(exam_id, public.attempt_exam(attempt_id::text))));

-- ── Questions and exam pools ────────────────────────────────────────────────
alter table public.questions add column if not exists created_by uuid default auth.uid();
update public.questions q set created_by = e.created_by
  from public.exams e
 where q.created_by is null and q.exam_id = e.id and e.created_by is not null;

drop policy if exists "ep pool staff read" on public.exam_questions;
drop policy if exists "ep pool exam staff read" on public.exam_questions;
create policy "ep pool exam staff read" on public.exam_questions
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));
drop policy if exists "ep pool owner write" on public.exam_questions;
create policy "ep pool owner write" on public.exam_questions
  for all to authenticated
  using ((select public.auth_is_staff_admin()) or public.owns_exam(exam_id))
  with check ((select public.auth_is_staff_admin()) or public.owns_exam(exam_id));

-- A question in an exam: that exam's full-access staff. A shared bank question
-- in no exam: any teacher reads it, only its creator edits it.
drop policy if exists "ep questions staff read" on public.questions;
drop policy if exists "ep questions exam staff read" on public.questions;
create policy "ep questions exam staff read" on public.questions
  for select to authenticated
  using ((select public.auth_is_staff_admin())
         or created_by = (select auth.uid())
         or exam_id in (select public.staff_exam_ids())
         or exists (select 1 from public.question_exams(id) x(exam_id)
                    where x.exam_id in (select public.staff_exam_ids()))
         or ((select public.auth_is_teacher()) and exam_id is null
             and not exists (select 1 from public.question_exams(id))));
drop policy if exists "ep questions teacher insert" on public.questions;
create policy "ep questions teacher insert" on public.questions
  for insert to authenticated
  with check ((select public.auth_is_staff_admin())
              or ((select public.auth_is_teacher()) and created_by = (select auth.uid())
                  and (exam_id is null or public.owns_exam(exam_id))));
drop policy if exists "ep questions teacher update" on public.questions;
create policy "ep questions teacher update" on public.questions
  for update to authenticated
  using ((select public.auth_is_staff_admin())
         or (exam_id is not null and public.owns_exam(exam_id))
         or (exam_id is null and created_by = (select auth.uid()) and (select public.auth_is_teacher())))
  with check ((select public.auth_is_staff_admin())
              or (exam_id is not null and public.owns_exam(exam_id))
              or (exam_id is null and created_by = (select auth.uid()) and (select public.auth_is_teacher())));
drop policy if exists "ep questions teacher delete" on public.questions;
create policy "ep questions teacher delete" on public.questions
  for delete to authenticated
  using ((select public.auth_is_staff_admin())
         or (exam_id is not null and public.owns_exam(exam_id))
         or (exam_id is null and created_by = (select auth.uid()) and (select public.auth_is_teacher())));

-- ── audit_logs ──────────────────────────────────────────────────────────────
create or replace function public.audit_exam_id(p_target_type text, p_target_id text, p_meta jsonb)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(p_meta ->> 'exam_id', ''),
                  case when p_target_type = 'exam' then p_target_id
                       when p_target_type = 'attempt' then public.attempt_exam(p_target_id) end);
$$;
revoke all on function public.audit_exam_id(text, text, jsonb) from public, anon;
grant execute on function public.audit_exam_id(text, text, jsonb) to authenticated, service_role;

drop policy if exists "ep audit teacher read" on public.audit_logs;
drop policy if exists "ep audit exam staff read" on public.audit_logs;
create policy "ep audit exam staff read" on public.audit_logs
  for select to authenticated
  using ((select public.auth_is_staff_admin())
         or public.audit_exam_id(target_type, target_id, meta) in (select public.staff_exam_ids())
         or (public.audit_exam_id(target_type, target_id, meta) in (select public.proctor_exam_ids())
             and action <> 'attempt.score_changed'
             and action not like 'result%'
             and action not like 'grade%'
             and not coalesce(meta ? 'score', false)));

-- ── storage: exam-records ───────────────────────────────────────────────────
drop policy if exists "exam-records exam staff read" on storage.objects;
create policy "exam-records exam staff read" on storage.objects
  for select to authenticated
  using (bucket_id = 'exam-records' and (
    (select public.auth_is_staff_admin())
    or split_part(name, '/', 1) in (select public.staff_exam_ids())
    or split_part(name, '/', 1) in (select public.owner_legacy_folders())));
drop policy if exists "exam-records exam staff insert" on storage.objects;
create policy "exam-records exam staff insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'exam-records' and (
    (select public.auth_is_staff_admin()) or split_part(name, '/', 1) in (select public.staff_exam_ids())));
drop policy if exists "exam-records exam staff update" on storage.objects;
create policy "exam-records exam staff update" on storage.objects
  for update to authenticated
  using (bucket_id = 'exam-records' and (
    (select public.auth_is_staff_admin()) or split_part(name, '/', 1) in (select public.staff_exam_ids())))
  with check (bucket_id = 'exam-records' and (
    (select public.auth_is_staff_admin()) or split_part(name, '/', 1) in (select public.staff_exam_ids())));
drop policy if exists "exam-records exam staff delete" on storage.objects;
create policy "exam-records exam staff delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'exam-records' and (
    (select public.auth_is_staff_admin()) or split_part(name, '/', 1) in (select public.staff_exam_ids())));

notify pgrst, 'reload schema';
