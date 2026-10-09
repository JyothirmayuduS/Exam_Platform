-- One active device per attempt. The exam client claims the attempt with a
-- per-device session id and renews the claim every 15s. A second device
-- logged in with the same credentials is refused while the claim is fresh;
-- a claim older than 45s (crashed laptop, dead network) can be taken over.
alter table public.attempts add column if not exists session_id text;
alter table public.attempts add column if not exists session_seen_at timestamptz;

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

revoke all on function public.claim_attempt_session(uuid, text) from public;
grant execute on function public.claim_attempt_session(uuid, text) to authenticated;

-- Writes that carry a session id must come from the device holding the claim,
-- so a second laptop cannot overwrite answers or submit.
create or replace function public.guard_attempt_session()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_setting('app.session_claim', true) = '1' or public.auth_is_staff() then
    return new;
  end if;
  if old.session_id is not null and new.session_id is distinct from old.session_id then
    raise exception 'attempt_session_conflict: this exam is open on another device'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists attempts_guard_session on public.attempts;
create trigger attempts_guard_session
  before update on public.attempts
  for each row execute function public.guard_attempt_session();
