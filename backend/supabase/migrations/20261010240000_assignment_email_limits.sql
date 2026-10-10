-- Server-side helpers for the proctor and evaluator assignment emails.
-- assignment_email_staff: which of the requested staff are on the exam —
--   assigned proctors, or evaluators delegated by exam or by one of its attempts.
-- take_assignment_email_slot: counts the caller's recent sends for the exam and
--   records this one in a single step, so concurrent requests cannot exceed the
--   limit; it also drops log rows older than 30 days.

create or replace function public.assignment_email_staff(p_exam text, p_kind text, p_ids uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pa.assignee_id from public.proctor_assignments pa
  where p_kind = 'proctor' and pa.exam_id = p_exam and pa.assignee_id = any(p_ids)
  union
  select g.delegate_id from public.grading_delegations g
  left join public.attempts a on a.id = g.attempt_id
  where p_kind = 'evaluator' and coalesce(g.exam_id, a.exam_id) = p_exam and g.delegate_id = any(p_ids);
$$;

create index if not exists assignment_email_log_created on public.assignment_email_log (created_at);

create or replace function public.take_assignment_email_slot(
  p_caller uuid, p_exam text, p_kind text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('assignment_email:' || p_caller || ':' || p_exam || ':' || p_kind, 0));
  delete from public.assignment_email_log where created_at < now() - interval '30 days';
  if (select count(*) from public.assignment_email_log l
      where l.caller_id = p_caller and l.exam_id = p_exam and l.kind = p_kind
        and l.created_at >= now() - make_interval(secs => p_window_seconds)) >= p_max then
    return false;
  end if;
  insert into public.assignment_email_log (caller_id, exam_id, kind) values (p_caller, p_exam, p_kind);
  return true;
end;
$$;

revoke all on function public.assignment_email_staff(text, text, uuid[]) from public, anon, authenticated;
revoke all on function public.take_assignment_email_slot(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.assignment_email_staff(text, text, uuid[]) to service_role;
grant execute on function public.take_assignment_email_slot(uuid, text, text, integer, integer) to service_role;

delete from public.assignment_email_log where created_at < now() - interval '30 days';

notify pgrst, 'reload schema';
