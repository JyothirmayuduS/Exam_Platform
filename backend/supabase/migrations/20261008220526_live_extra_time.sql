-- Live extra time: only the teacher who owns the exam can add minutes to an
-- in-progress attempt. The deadline stays computed by attempt_deadline()
-- (duration + attempts.extra_minutes + enrollments.extra_minutes + pauses).

-- Signed-in users can no longer change attempts.extra_minutes directly (the
-- staff update policy let proctors do it); add_attempt_extra_minutes() is the
-- only path and sets app.extra_minutes_ok for its own update.
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
revoke all on function public.guard_attempt_write() from public, anon, authenticated;

create or replace function public.add_attempt_extra_minutes(p_attempt uuid, p_minutes integer)
returns table (extra_minutes integer, deadline timestamptz, seconds_left integer)
language plpgsql security definer set search_path = ''
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
  if not public.owns_exam(v_exam) then
    raise exception 'forbidden: only the teacher who owns this exam can add time' using errcode = '42501';
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
revoke all on function public.add_attempt_extra_minutes(uuid, integer) from public, anon;
grant execute on function public.add_attempt_extra_minutes(uuid, integer) to authenticated;
