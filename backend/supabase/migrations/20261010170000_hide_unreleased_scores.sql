-- Students cannot read marks off the attempts table, even through the raw API.
--
-- Teachers and students share the `authenticated` role, so the mark columns
-- (score, percentage, passed, rank) are not selectable by that role at all.
-- Students get their score only from student_result_states(), which applies
-- the release and hold rules; staff read marks through staff_attempts.
-- `paper` (question ids and shuffled options) and `answers` (the student's own
-- responses) carry no marks or answer key and stay readable.
--
-- A malpractice hold placed after Moodle received the grade now clears the
-- grade in Moodle until the hold is released, then the real score is posted.

-- ── Column-level read access on attempts ────────────────────────────────────
-- Revoking the table-level grant also drops every column grant; the safe
-- columns are granted back. A new column is not readable until added here.
revoke select on public.attempts from public, anon, authenticated;
grant select (
  id, exam_id, student_id, state, answered, total, minutes_used,
  started_at, submitted_at, auto_saved_at, answers, status, total_time_spent_seconds,
  device_info, last_saved_at, auto_submitted, created_at, updated_at, extra_minutes,
  paper, consent_at, consent_text, user_agent, session_id, session_seen_at,
  paused_at, paused_seconds, resume_state
) on public.attempts to anon, authenticated;

-- ── Staff read path (all columns, staff rows only) ──────────────────────────
-- Runs as its owner, so it reads past the column grants; the where clause is
-- the same row rule as "ep attempts staff read" (teachers and proctors).
create or replace view public.staff_attempts with (security_barrier = true) as
  select a.* from public.attempts a
  where (select public.auth_is_staff());

revoke all on public.staff_attempts from public, anon, authenticated;
grant select on public.staff_attempts to authenticated;
grant select on public.staff_attempts to service_role;

-- ── Moodle: clear a posted grade while a hold is on ─────────────────────────
alter table public.lti_grade_targets
  add column if not exists clear_pending boolean not null default false,
  add column if not exists cleared boolean not null default false;

comment on column public.lti_grade_targets.clear_pending is
  'A hold was placed after Moodle received a grade; a cleared grade still has to be posted.';
comment on column public.lti_grade_targets.cleared is
  'Moodle currently shows a cleared grade because of a hold; pending_score is re-posted on release.';

drop function if exists public.lti_claim_scores(timestamptz, int, int, text, uuid);
create function public.lti_claim_scores(
  p_now timestamptz, p_limit int, p_lease_seconds int,
  p_exam_id text default null, p_student_id uuid default null
)
returns table(link_id uuid, student_id uuid, claim_token uuid, sub text, lineitem text,
              score_maximum numeric, pending_score numeric, post_attempts int, clear boolean)
language sql
set search_path = public
as $$
  with due as (
    select g.link_id, g.student_id,
           exists (select 1 from public.result_holds h where h.exam_id = g.exam_id and h.student_id = g.student_id) as held
    from public.lti_grade_targets g
    where g.pending_score is not null
      and g.lineitem is not null
      and g.next_attempt_at is not null
      and g.next_attempt_at <= p_now
      and (g.claimed_until is null or g.claimed_until < p_now)
      and (p_exam_id is null or (g.exam_id = p_exam_id and g.student_id = p_student_id))
      and (g.clear_pending or not exists (
        select 1 from public.result_holds h where h.exam_id = g.exam_id and h.student_id = g.student_id))
    order by g.next_attempt_at
    limit greatest(p_limit, 0)
    for update of g skip locked
  )
  update public.lti_grade_targets t
     set claim_token = gen_random_uuid(),
         claimed_until = p_now + make_interval(secs => p_lease_seconds)
    from due
   where t.link_id = due.link_id and t.student_id = due.student_id
  returning t.link_id, t.student_id, t.claim_token, t.sub, t.lineitem,
            t.score_maximum, t.pending_score, t.post_attempts, due.held;
$$;

drop function if exists public.lti_finish_score(uuid, uuid, uuid, numeric, boolean, text, int, timestamptz, timestamptz);
create function public.lti_finish_score(
  p_link_id uuid, p_student_id uuid, p_claim_token uuid, p_score numeric, p_ok boolean,
  p_error text, p_attempts int, p_next_attempt_at timestamptz, p_now timestamptz,
  p_clear boolean default false
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_held boolean;
begin
  select exists (select 1 from public.result_holds h where h.exam_id = g.exam_id and h.student_id = g.student_id)
    into v_held
    from public.lti_grade_targets g
   where g.link_id = p_link_id and g.student_id = p_student_id and g.claim_token = p_claim_token;
  if not found then
    return;
  end if;

  if p_clear then
    -- pending_score stays set: it is the real score to post once released.
    update public.lti_grade_targets
       set cleared         = cleared or p_ok,
           clear_pending   = clear_pending and not p_ok,
           last_posted_at  = case when p_ok then p_now else last_posted_at end,
           last_error      = case when p_ok then null else p_error end,
           post_attempts   = case when p_ok or not v_held then 0 else p_attempts end,
           next_attempt_at = case when p_ok or not v_held then p_now else p_next_attempt_at end,
           claim_token     = null,
           claimed_until   = null
     where link_id = p_link_id and student_id = p_student_id and claim_token = p_claim_token;
  elsif p_ok and v_held then
    -- A hold landed while this score was on its way: clear it again.
    update public.lti_grade_targets
       set last_score      = p_score,
           last_posted_at  = p_now,
           last_error      = null,
           pending_score   = coalesce(pending_score, p_score),
           cleared         = false,
           clear_pending   = true,
           post_attempts   = 0,
           next_attempt_at = p_now,
           claim_token     = null,
           claimed_until   = null
     where link_id = p_link_id and student_id = p_student_id and claim_token = p_claim_token;
  else
    update public.lti_grade_targets
       set last_score      = case when p_ok then p_score else last_score end,
           last_posted_at  = case when p_ok then p_now else last_posted_at end,
           last_error      = case when p_ok then null else p_error end,
           cleared         = case when p_ok then false else cleared end,
           pending_score   = case when p_ok and pending_score = p_score then null else pending_score end,
           post_attempts   = case when pending_score is distinct from p_score then post_attempts
                                  when p_ok then 0 else p_attempts end,
           next_attempt_at = case when pending_score is distinct from p_score then next_attempt_at
                                  when p_ok then null else p_next_attempt_at end,
           claim_token     = null,
           claimed_until   = null
     where link_id = p_link_id and student_id = p_student_id and claim_token = p_claim_token;
  end if;
end;
$$;

revoke all on function public.lti_claim_scores(timestamptz, int, int, text, uuid) from public, anon, authenticated;
revoke all on function public.lti_finish_score(uuid, uuid, uuid, numeric, boolean, text, int, timestamptz, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.lti_claim_scores(timestamptz, int, int, text, uuid) to service_role;
grant execute on function public.lti_finish_score(uuid, uuid, uuid, numeric, boolean, text, int, timestamptz, timestamptz, boolean) to service_role;

create or replace function public.set_result_hold(p_attempt uuid, p_hold boolean, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
begin
  select id, exam_id, student_id, state into a from public.attempts where id = p_attempt;
  if not found then
    return 'not_found';
  end if;
  if not (public.owns_exam(a.exam_id) or public.auth_is_staff_admin()) then
    return 'forbidden';
  end if;
  if p_hold then
    insert into public.result_holds (attempt_id, exam_id, student_id, reason, held_by)
    values (a.id, a.exam_id, a.student_id, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
    on conflict (attempt_id) do update
      set reason = excluded.reason, held_by = excluded.held_by, held_at = now();
    -- Moodle already has a grade: clear it there on the next retry run.
    update public.lti_grade_targets g
       set pending_score = coalesce(g.pending_score, g.last_score),
           clear_pending = true,
           post_attempts = 0,
           next_attempt_at = now(),
           last_error = null
     where g.exam_id = a.exam_id and g.student_id = a.student_id
       and g.lineitem is not null and g.last_score is not null and not g.cleared;
  else
    delete from public.result_holds where attempt_id = a.id;
    if not found then
      return 'ok';
    end if;
    -- Scores that waited out the hold go to Moodle on the next retry run.
    update public.lti_grade_targets g
       set next_attempt_at = now(), post_attempts = 0, clear_pending = false
     where g.exam_id = a.exam_id and g.student_id = a.student_id
       and g.pending_score is not null and g.lineitem is not null
       and not exists (select 1 from public.result_holds h where h.exam_id = a.exam_id and h.student_id = a.student_id);
  end if;
  insert into public.audit_logs (actor_id, actor_role, action, target_type, target_id, meta)
  values (auth.uid(), 'teacher', case when p_hold then 'result.withheld' else 'result.released_from_hold' end,
          'attempt', a.id::text,
          jsonb_build_object('exam_id', a.exam_id, 'student_id', a.student_id, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  return 'ok';
end;
$$;

revoke all on function public.set_result_hold(uuid, boolean, text) from public, anon;
grant execute on function public.set_result_hold(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';
