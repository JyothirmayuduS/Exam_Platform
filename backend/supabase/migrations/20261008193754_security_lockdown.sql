-- Security lockdown from the October audit.
--
--  * Students can no longer read the answer key, write their own score/state,
--    reset their start time, or delete their attempt. Final submission and
--    grading happen in the `submit-attempt` Edge Function (service role).
--  * The server owns the exam clock: start time, proctor pauses, proctor
--    extensions and per-student accommodation minutes.
--  * Proctors can supervise (pause, extend, flag) but not author exams,
--    change marks or delete evidence. Teachers edit only exams they own.
--  * Legacy "allow everything" policies on mobile uploads, violations and the
--    evidence bucket are removed.

-- ── Columns ──────────────────────────────────────────────────────────────────
alter table public.attempts
  add column if not exists paused_at timestamptz,
  add column if not exists paused_seconds integer not null default 0;

alter table public.enrollments
  add column if not exists extra_minutes integer not null default 0;
do $$ begin
  alter table public.enrollments
    add constraint enrollments_extra_minutes_range check (extra_minutes between 0 and 600);
exception when duplicate_object then null; end $$;

-- ── Exam clock ───────────────────────────────────────────────────────────────
-- Deadline = start + duration + proctor extensions + accommodation + paused time.
-- Null when the exam is untimed or the attempt has not started.
create or replace function public.attempt_deadline(p_attempt uuid)
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select a.started_at
       + make_interval(mins => coalesce(e.duration_minutes, 0) + coalesce(a.extra_minutes, 0) + coalesce(en.extra_minutes, 0))
       + make_interval(secs => coalesce(a.paused_seconds, 0))
       + case when a.state = 'paused' and a.paused_at is not null then now() - a.paused_at else interval '0' end
  from public.attempts a
  join public.exams e on e.id = a.exam_id
  left join public.enrollments en on en.exam_id = a.exam_id and en.student_id = a.student_id
  where a.id = p_attempt
    and a.started_at is not null
    and coalesce(e.duration_minutes, 0) > 0;
$$;
revoke all on function public.attempt_deadline(uuid) from public, anon, authenticated;
grant execute on function public.attempt_deadline(uuid) to service_role;

-- Seconds left on the caller's own attempt (null = untimed / not started).
create or replace function public.attempt_time_left(p_exam text)
returns integer
language sql stable security definer set search_path = ''
as $$
  select greatest(0, floor(extract(epoch from public.attempt_deadline(a.id) - now())))::integer
  from public.attempts a
  where a.exam_id = p_exam and a.student_id = public.current_student_id();
$$;
revoke all on function public.attempt_time_left(text) from public, anon;
grant execute on function public.attempt_time_left(text) to authenticated;

-- ── Attempt write guard ─────────────────────────────────────────────────────
create or replace function public.guard_attempt_write()
returns trigger
language plpgsql security definer set search_path = ''
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
      -- Kiosk builds before 0.2.35 submit directly; they get no score
      -- (graded by submit-attempt or the evaluator) and no late answers.
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
    if coalesce(auth.role(), '') = 'authenticated' and not public.auth_is_teacher() then
      -- Proctors run the session; marks and answers stay with teachers.
      new.score := old.score;
      new.percentage := old.percentage;
      new.passed := old.passed;
      new.rank := old.rank;
      new.answers := old.answers;
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
revoke all on function public.guard_attempt_write() from public, anon, authenticated;

drop trigger if exists attempts_a_guard_write on public.attempts;
create trigger attempts_a_guard_write
  before insert or update on public.attempts
  for each row execute function public.guard_attempt_write();

-- ── Release visibility (mirrors shared/domain/exam/release.ts) ──────────────
create or replace function public.exam_release_state(p_exam text, p_student uuid)
returns table (score_visible boolean, key_visible boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  s jsonb;
  t text;
  rm text;
  timing text;
  closed boolean;
  auto_release boolean;
  key_on boolean;
  results_on boolean;
  graded boolean;
  x record;
begin
  select e.settings, e.status, e.scheduled_at, e.duration_minutes into x
  from public.exams e where e.id = p_exam;
  if not found then
    return query select false, false;
    return;
  end if;
  s := coalesce(x.settings, '{}'::jsonb);
  t := s ->> 'release_timing';
  rm := s ->> 'release_mode';
  timing := case
    when t in ('on_submit', 'submit') then case when rm = 'manual' then 'manual' else 'on_submit' end
    when t in ('on_close', 'close') then case when rm = 'manual' then 'manual' else 'on_close' end
    when t = 'manual' then 'manual'
    when s ->> 'showReportToTaker' = 'true' then 'on_submit'
    when rm = 'auto' then 'on_close'
    else 'manual'
  end;
  closed := lower(coalesce(x.status, '')) = 'completed'
    or (x.scheduled_at is not null and coalesce(x.duration_minutes, 0) > 0
        and now() > x.scheduled_at + make_interval(mins => x.duration_minutes));
  auto_release := timing = 'on_submit' or (timing = 'on_close' and closed);
  key_on := s ->> 'answer_key_published' = 'true' or auto_release;
  results_on := s ->> 'results_published' = 'true' or key_on;
  select exists (
    select 1 from public.attempts a
    where a.exam_id = p_exam and a.student_id = p_student and a.state = 'submitted' and a.score is not null
  ) into graded;
  return query select results_on and graded, key_on and graded;
end;
$$;
revoke all on function public.exam_release_state(text, uuid) from public, anon, authenticated;

-- ── Student question delivery (no answer key unless released) ───────────────
create or replace function public.student_exam_questions(p_exam text)
returns table (
  id text, exam_id text, title text, type text, unit text, difficulty text,
  marks integer, options jsonb, subjective_mode text, created_at timestamptz, answer text
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_student uuid := public.current_student_id();
  v_mode text;
  v_reveal boolean;
begin
  if v_student is null then return; end if;
  select e.mode into v_mode
  from public.exams e
  join public.enrollments en on en.exam_id = e.id and en.student_id = v_student
  where e.id = p_exam and e.status <> 'draft';
  if not found then return; end if;
  v_reveal := v_mode = 'practice'
    or coalesce((select r.key_visible from public.exam_release_state(p_exam, v_student) r), false);
  return query
    select q.id, q.exam_id, q.title, q.type, q.unit, q.difficulty, q.marks, q.options,
           q.subjective_mode, q.created_at, case when v_reveal then q.answer else null end
    from public.questions q
    where q.id in (select eq.question_id from public.exam_questions eq where eq.exam_id = p_exam)
       or q.exam_id = p_exam
    order by q.id;
end;
$$;
revoke all on function public.student_exam_questions(text) from public, anon;
grant execute on function public.student_exam_questions(text) to authenticated;

-- Class statistics for a released result (students only see their own row).
create or replace function public.student_exam_stats(p_exam text)
returns table (class_avg numeric, scored integer, below_me integer)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_student uuid := public.current_student_id();
  v_mine numeric;
begin
  if v_student is null then return; end if;
  if not coalesce((select r.score_visible from public.exam_release_state(p_exam, v_student) r), false) then
    return;
  end if;
  select a.score into v_mine from public.attempts a where a.exam_id = p_exam and a.student_id = v_student;
  return query
    select round(avg(a.score), 2), count(*)::integer, count(*) filter (where a.score < v_mine)::integer
    from public.attempts a
    where a.exam_id = p_exam and a.state = 'submitted' and a.score is not null;
end;
$$;
revoke all on function public.student_exam_stats(text) from public, anon;
grant execute on function public.student_exam_stats(text) to authenticated;

-- ── Attempts policies ───────────────────────────────────────────────────────
drop policy if exists "ep attempts student" on public.attempts;
drop policy if exists "ep attempts staff" on public.attempts;
drop policy if exists "ep attempts student read" on public.attempts;
drop policy if exists "ep attempts student insert" on public.attempts;
drop policy if exists "ep attempts student update" on public.attempts;
drop policy if exists "ep attempts staff read" on public.attempts;
drop policy if exists "ep attempts staff update" on public.attempts;
drop policy if exists "ep attempts teacher insert" on public.attempts;
drop policy if exists "ep attempts teacher delete" on public.attempts;

create policy "ep attempts student read" on public.attempts
  for select to authenticated using (student_id = (select public.current_student_id()));
create policy "ep attempts student insert" on public.attempts
  for insert to authenticated with check (student_id = (select public.current_student_id()));
create policy "ep attempts student update" on public.attempts
  for update to authenticated
  using (student_id = (select public.current_student_id()) and state <> 'submitted')
  with check (student_id = (select public.current_student_id()));
create policy "ep attempts staff read" on public.attempts
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep attempts staff update" on public.attempts
  for update to authenticated using ((select public.auth_is_staff())) with check ((select public.auth_is_staff()));
create policy "ep attempts teacher insert" on public.attempts
  for insert to authenticated with check ((select public.auth_is_teacher()));
create policy "ep attempts teacher delete" on public.attempts
  for delete to authenticated using ((select public.auth_is_teacher()));

-- ── Exams: staff read, owning teacher writes ────────────────────────────────
drop policy if exists "ep exams teacher" on public.exams;
drop policy if exists "exams_students_select" on public.exams;
drop policy if exists "ep exams staff read" on public.exams;
drop policy if exists "ep exams teacher insert" on public.exams;
drop policy if exists "ep exams owner update" on public.exams;
drop policy if exists "ep exams owner delete" on public.exams;

create policy "ep exams staff read" on public.exams
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep exams teacher insert" on public.exams
  for insert to authenticated with check ((select public.auth_is_teacher()));
create policy "ep exams owner update" on public.exams
  for update to authenticated
  using ((select public.auth_is_teacher()) and (created_by is null or created_by = (select auth.uid())))
  with check ((select public.auth_is_teacher()));
create policy "ep exams owner delete" on public.exams
  for delete to authenticated
  using ((select public.auth_is_teacher()) and (created_by is null or created_by = (select auth.uid())));

create or replace function public.owns_exam(p_exam text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.auth_is_teacher() and exists (
    select 1 from public.exams e
    where e.id = p_exam and (e.created_by is null or e.created_by = auth.uid())
  );
$$;
revoke all on function public.owns_exam(text) from public, anon;
grant execute on function public.owns_exam(text) to authenticated;

-- ── Questions & pools ───────────────────────────────────────────────────────
-- The answer key column is not readable through the API at all. Teachers
-- fetch it with staff_question_answers(); students get it from
-- student_exam_questions() once released. Row access for enrolled students
-- stays so kiosk builds that read the table directly keep working.
revoke select on public.questions from anon, authenticated;
grant select (id, exam_id, title, type, unit, difficulty, marks, options, subjective_mode, created_at)
  on public.questions to authenticated;

create or replace function public.staff_question_answers(p_ids text[])
returns table (id text, answer text)
language sql stable security definer set search_path = ''
as $$
  select q.id, q.answer from public.questions q
  where public.auth_is_teacher() and q.id = any (p_ids);
$$;
revoke all on function public.staff_question_answers(text[]) from public, anon;
grant execute on function public.staff_question_answers(text[]) to authenticated;

drop policy if exists "ep questions staff" on public.questions;
drop policy if exists "ep questions staff read" on public.questions;
drop policy if exists "ep questions teacher insert" on public.questions;
drop policy if exists "ep questions teacher update" on public.questions;
drop policy if exists "ep questions teacher delete" on public.questions;

create policy "ep questions staff read" on public.questions
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep questions teacher insert" on public.questions
  for insert to authenticated with check ((select public.auth_is_teacher()));
create policy "ep questions teacher update" on public.questions
  for update to authenticated
  using ((select public.auth_is_teacher()) and (exam_id is null or public.owns_exam(exam_id)))
  with check ((select public.auth_is_teacher()));
create policy "ep questions teacher delete" on public.questions
  for delete to authenticated
  using ((select public.auth_is_teacher()) and (exam_id is null or public.owns_exam(exam_id)));

drop policy if exists "ep pool staff" on public.exam_questions;
drop policy if exists "read questions of visible exams" on public.exam_questions;
drop policy if exists "ep pool staff read" on public.exam_questions;
drop policy if exists "ep pool owner write" on public.exam_questions;

create policy "ep pool staff read" on public.exam_questions
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep pool owner write" on public.exam_questions
  for all to authenticated using (public.owns_exam(exam_id)) with check (public.owns_exam(exam_id));

-- ── Enrollments ─────────────────────────────────────────────────────────────
drop policy if exists "ep enroll staff" on public.enrollments;
drop policy if exists "ep enroll staff read" on public.enrollments;
drop policy if exists "ep enroll owner write" on public.enrollments;
create policy "ep enroll staff read" on public.enrollments
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep enroll owner write" on public.enrollments
  for all to authenticated using (public.owns_exam(exam_id)) with check (public.owns_exam(exam_id));

-- ── Students roster: teachers manage, proctors read ─────────────────────────
drop policy if exists "ep students staff" on public.students;
drop policy if exists "ep students staff read" on public.students;
drop policy if exists "ep students teacher write" on public.students;
create policy "ep students staff read" on public.students
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep students teacher write" on public.students
  for all to authenticated using ((select public.auth_is_teacher())) with check ((select public.auth_is_teacher()));

-- ── Grading data: teachers only write ───────────────────────────────────────
drop policy if exists "ep comments staff" on public.grading_comments;
drop policy if exists "ep comments staff read" on public.grading_comments;
drop policy if exists "ep comments teacher write" on public.grading_comments;
create policy "ep comments staff read" on public.grading_comments
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep comments teacher write" on public.grading_comments
  for all to authenticated using ((select public.auth_is_teacher())) with check ((select public.auth_is_teacher()));

drop policy if exists "ep delegation staff" on public.grading_delegations;
drop policy if exists "ep delegation staff read" on public.grading_delegations;
drop policy if exists "ep delegation teacher write" on public.grading_delegations;
create policy "ep delegation staff read" on public.grading_delegations
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep delegation teacher write" on public.grading_delegations
  for all to authenticated using ((select public.auth_is_teacher())) with check ((select public.auth_is_teacher()));

drop policy if exists "ep assignments staff" on public.proctor_assignments;
drop policy if exists "ep assignments staff read" on public.proctor_assignments;
drop policy if exists "ep assignments teacher write" on public.proctor_assignments;
create policy "ep assignments staff read" on public.proctor_assignments
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep assignments teacher write" on public.proctor_assignments
  for all to authenticated using ((select public.auth_is_teacher())) with check ((select public.auth_is_teacher()));

-- ── Audit log: append-only, teachers read ───────────────────────────────────
drop policy if exists "ep audit staff" on public.audit_logs;
drop policy if exists "ep audit teacher read" on public.audit_logs;
drop policy if exists "ep audit staff insert" on public.audit_logs;
create policy "ep audit teacher read" on public.audit_logs
  for select to authenticated using ((select public.auth_is_teacher()));
create policy "ep audit staff insert" on public.audit_logs
  for insert to authenticated
  with check ((select public.auth_is_staff()) and (actor_id is null or actor_id = (select auth.uid())));

-- ── Violations: no anonymous inserts, evidence deleted only by teachers ─────
drop policy if exists "violation_events_system_insert" on public.violation_events;
drop policy if exists "violation_events_students_select" on public.violation_events;
drop policy if exists "proctors manage assigned violations" on public.violation_events;
drop policy if exists "ep violation staff" on public.violation_events;
drop policy if exists "ep violation staff read" on public.violation_events;
drop policy if exists "ep violation staff insert" on public.violation_events;
drop policy if exists "ep violation staff update" on public.violation_events;
drop policy if exists "ep violation teacher delete" on public.violation_events;
create policy "ep violation staff read" on public.violation_events
  for select to authenticated using ((select public.auth_is_staff()));
create policy "ep violation staff insert" on public.violation_events
  for insert to authenticated with check ((select public.auth_is_staff()));
create policy "ep violation staff update" on public.violation_events
  for update to authenticated using ((select public.auth_is_staff())) with check ((select public.auth_is_staff()));
create policy "ep violation teacher delete" on public.violation_events
  for delete to authenticated using ((select public.auth_is_teacher()));

-- ── Mobile upload sessions: the signed-in student owns their rows ───────────
drop policy if exists "ep mobile upload anon" on public.mobile_upload_sessions;
drop policy if exists "Allow all inserts on mobile_upload_sessions" on public.mobile_upload_sessions;
drop policy if exists "Allow anonymous inserts for demo" on public.mobile_upload_sessions;
drop policy if exists "Allow all selects on mobile_upload_sessions" on public.mobile_upload_sessions;
drop policy if exists "Allow anonymous reads for demo" on public.mobile_upload_sessions;
drop policy if exists "Allow anonymous updates for demo" on public.mobile_upload_sessions;
drop policy if exists "Allow all updates on mobile_upload_sessions" on public.mobile_upload_sessions;
drop policy if exists "Students can update mobile upload sessions" on public.mobile_upload_sessions;
drop policy if exists "ep mobile student own" on public.mobile_upload_sessions;
drop policy if exists "ep mobile staff read" on public.mobile_upload_sessions;
create policy "ep mobile student own" on public.mobile_upload_sessions
  for all to authenticated
  using (student_id = (select public.current_student_id()))
  with check (student_id = (select public.current_student_id()));
create policy "ep mobile staff read" on public.mobile_upload_sessions
  for select to authenticated using ((select public.auth_is_staff()));

-- ── Storage: evidence stays private to its student and staff ────────────────
drop policy if exists "Give system write access to exam records" on storage.objects;
drop policy if exists "Give proctors read access to exam records" on storage.objects;
drop policy if exists "teachers write question media" on storage.objects;
drop policy if exists "teachers write question media v2" on storage.objects;
create policy "teachers write question media v2" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'question-media' and (select public.auth_is_teacher()));
