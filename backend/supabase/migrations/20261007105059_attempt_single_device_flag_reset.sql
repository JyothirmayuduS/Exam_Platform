-- Clear the session-claim flag after the claim update, so later writes in the
-- same transaction are checked by the session guard again.
create or replace function public.claim_attempt_session(p_attempt uuid, p_session text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.attempts%rowtype;
begin
  if p_session is null or length(p_session) < 8 then
    return 'invalid';
  end if;
  select * into r from public.attempts where id = p_attempt for update;
  if not found then
    return 'not_found';
  end if;
  if r.student_id is distinct from public.current_student_id() then
    return 'forbidden';
  end if;
  if r.state = 'submitted' then
    return 'submitted';
  end if;
  if r.session_id is not null
     and r.session_id <> p_session
     and r.session_seen_at > now() - interval '45 seconds' then
    return 'busy';
  end if;
  perform set_config('app.session_claim', '1', true);
  update public.attempts set session_id = p_session, session_seen_at = now() where id = p_attempt;
  perform set_config('app.session_claim', '', true);
  return 'ok';
end;
$$;
