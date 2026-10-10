-- Exam data is visible only to the people responsible for the exam: its owner
-- (exams.created_by), admins, and staff assigned to it in proctor_assignments.
-- An exam with no owner is admin-only. Assigned staff may proctor (read, pause,
-- warn, flag) but only the owner or an admin may change marks.
-- Server functions use the service role and are not affected.

-- ── Who may access an exam ──────────────────────────────────────────────────
create or replace function public.owns_exam(p_exam text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.auth_is_teacher() and exists (
    select 1 from public.exams e
    where e.id = p_exam
      and (e.created_by = auth.uid() or (e.created_by is null and public.auth_is_staff_admin()))
  );
$$;

-- Exams the signed-in staff member owns or is assigned to. Admins see every
-- exam through auth_is_staff_admin() in the policies, not through this list.
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
  where t.auth_id = auth.uid() and pa.exam_id is not null;
$$;

create or replace function public.can_access_exam(p_exam text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.auth_is_staff_admin() or p_exam in (select public.staff_exam_ids());
$$;

-- Evidence folders are named after the exam id (phone uploads) or the exam
-- name as the kiosk wrote it, raw or slugged the way slugifyFolderSegment does.
create or replace function public.staff_exam_folders()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select f from public.exams e
  cross join lateral (values
    (e.id),
    (e.name),
    (left(regexp_replace(regexp_replace(btrim(coalesce(e.name, '')), '[^A-Za-z0-9._-]+', '-', 'g'), '^-+|-+$', '', 'g'), 60))
  ) v(f)
  where e.id in (select public.staff_exam_ids()) and coalesce(f, '') <> '';
$$;

create or replace function public.teaches_student(p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.auth_is_teacher() and exists (
    select 1 from public.enrollments en
    join public.exams e on e.id = en.exam_id
    where en.student_id = p_student and e.created_by = auth.uid()
  );
$$;

revoke all on function public.staff_exam_ids() from public, anon;
revoke all on function public.can_access_exam(text) from public, anon;
revoke all on function public.staff_exam_folders() from public, anon;
grant execute on function public.staff_exam_ids() to authenticated, service_role;
grant execute on function public.can_access_exam(text) to authenticated, service_role;
grant execute on function public.staff_exam_folders() to authenticated, service_role;

-- Give unowned exams the teacher who first published or created them, where
-- the audit log records one. The rest stay admin-only.
update public.exams e
   set created_by = src.actor_id
  from (
    select distinct on (l.target_id) l.target_id, l.actor_id
    from public.audit_logs l
    join public.teachers t on t.auth_id = l.actor_id and t.role = 'teacher'
    where l.target_type = 'exam' and l.action in ('exam.created', 'exam.published') and l.actor_id is not null
    order by l.target_id, l.created_at
  ) src
 where e.created_by is null and e.id = src.target_id;

-- ── exams: owner-only edits (an unowned exam: admins) ───────────────────────
drop policy if exists "ep exams owner update" on public.exams;
drop policy if exists "ep exams owner delete" on public.exams;
create policy "ep exams owner update" on public.exams
  for update to authenticated
  using (public.owns_exam(id))
  with check ((select public.auth_is_teacher()));
create policy "ep exams owner delete" on public.exams
  for delete to authenticated
  using (public.owns_exam(id));

-- ── proctor_assignments: only the owner or an admin assigns staff ───────────
drop policy if exists "ep assignments teacher write" on public.proctor_assignments;
drop policy if exists "ep assignments owner write" on public.proctor_assignments;
create policy "ep assignments owner write" on public.proctor_assignments
  for all to authenticated
  using (public.owns_exam(exam_id) or (select public.auth_is_staff_admin()))
  with check (public.owns_exam(exam_id) or (select public.auth_is_staff_admin()));

-- ── attempts ────────────────────────────────────────────────────────────────
drop policy if exists "ep attempts staff read" on public.attempts;
drop policy if exists "ep attempts staff update" on public.attempts;
drop policy if exists "ep attempts teacher insert" on public.attempts;
drop policy if exists "ep attempts teacher delete" on public.attempts;
drop policy if exists "proctors read assigned attempts" on public.attempts;

drop policy if exists "ep attempts exam staff read" on public.attempts;
create policy "ep attempts exam staff read" on public.attempts
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));
-- Assigned staff may update (pause, submit); guard_attempt_write keeps marks
-- and answers unless the caller owns the exam or is an admin.
drop policy if exists "ep attempts exam staff update" on public.attempts;
create policy "ep attempts exam staff update" on public.attempts
  for update to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()))
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));
drop policy if exists "ep attempts owner insert" on public.attempts;
create policy "ep attempts owner insert" on public.attempts
  for insert to authenticated
  with check ((select public.auth_is_staff_admin()) or public.owns_exam(exam_id));
drop policy if exists "ep attempts owner delete" on public.attempts;
create policy "ep attempts owner delete" on public.attempts
  for delete to authenticated
  using ((select public.auth_is_staff_admin()) or public.owns_exam(exam_id));

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
       and not (public.owns_exam(old.exam_id) or public.auth_is_staff_admin()) then
      new.score := old.score;
      new.percentage := old.percentage;
      new.passed := old.passed;
      new.rank := old.rank;
      new.answers := old.answers;
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

create or replace view public.staff_attempts with (security_barrier = true) as
  select a.* from public.attempts a
  where (select public.auth_is_staff_admin()) or a.exam_id in (select public.staff_exam_ids());

-- ── violation_events ────────────────────────────────────────────────────────
drop policy if exists "ep violation staff read" on public.violation_events;
drop policy if exists "ep violation staff insert" on public.violation_events;
drop policy if exists "ep violation staff update" on public.violation_events;
drop policy if exists "ep violation teacher delete" on public.violation_events;
drop policy if exists "violation_events_teachers_select" on public.violation_events;

drop policy if exists "ep violation exam staff read" on public.violation_events;
create policy "ep violation exam staff read" on public.violation_events
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));
drop policy if exists "ep violation exam staff insert" on public.violation_events;
create policy "ep violation exam staff insert" on public.violation_events
  for insert to authenticated
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));
drop policy if exists "ep violation exam staff update" on public.violation_events;
create policy "ep violation exam staff update" on public.violation_events
  for update to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()))
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));
drop policy if exists "ep violation owner delete" on public.violation_events;
create policy "ep violation owner delete" on public.violation_events
  for delete to authenticated
  using ((select public.auth_is_staff_admin()) or public.owns_exam(exam_id));

-- ── proctor_sessions (keyed by attempt) ─────────────────────────────────────
drop policy if exists "ep psession staff" on public.proctor_sessions;
drop policy if exists "ep psession exam staff" on public.proctor_sessions;
create policy "ep psession exam staff" on public.proctor_sessions
  for all to authenticated
  using ((select public.auth_is_staff_admin()) or exists (
    select 1 from public.attempts a
    where a.id = proctor_sessions.attempt_id and a.exam_id in (select public.staff_exam_ids())))
  with check ((select public.auth_is_staff_admin()) or exists (
    select 1 from public.attempts a
    where a.id = proctor_sessions.attempt_id and a.exam_id in (select public.staff_exam_ids())));

-- ── proctor_messages ────────────────────────────────────────────────────────
drop policy if exists "ep messages staff" on public.proctor_messages;
drop policy if exists "proctors manage assigned messages" on public.proctor_messages;
drop policy if exists "ep messages exam staff" on public.proctor_messages;
create policy "ep messages exam staff" on public.proctor_messages
  for all to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()))
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));

-- ── ai_reports ──────────────────────────────────────────────────────────────
drop policy if exists "ep aireports staff" on public.ai_reports;
drop policy if exists "ep aireports exam staff" on public.ai_reports;
create policy "ep aireports exam staff" on public.ai_reports
  for all to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()))
  with check ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));

-- ── mobile_upload_sessions (keyed by attempt) ───────────────────────────────
drop policy if exists "ep mobile staff read" on public.mobile_upload_sessions;
drop policy if exists "ep mobile exam staff read" on public.mobile_upload_sessions;
create policy "ep mobile exam staff read" on public.mobile_upload_sessions
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exists (
    select 1 from public.attempts a
    where a.id::text = mobile_upload_sessions.attempt_id::text and a.exam_id in (select public.staff_exam_ids())));

-- ── storage: exam-records ───────────────────────────────────────────────────
drop policy if exists "exam-records staff all" on storage.objects;
drop policy if exists "exam-records exam staff" on storage.objects;
create policy "exam-records exam staff" on storage.objects
  for all to authenticated
  using (bucket_id = 'exam-records' and (
    (select public.auth_is_staff_admin()) or split_part(name, '/', 1) in (select public.staff_exam_folders())))
  with check (bucket_id = 'exam-records' and (
    (select public.auth_is_staff_admin()) or split_part(name, '/', 1) in (select public.staff_exam_folders())));

notify pgrst, 'reload schema';
