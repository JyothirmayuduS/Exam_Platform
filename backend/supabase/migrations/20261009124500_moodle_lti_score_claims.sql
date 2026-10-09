-- Moodle grade posts are claimed before they are sent, so the scheduler, a
-- submit and a teacher's resend never post the same row at once, and a post
-- that finishes after a newer score was queued leaves that newer score queued.

alter table public.lti_grade_targets add column if not exists claim_token uuid;
alter table public.lti_grade_targets add column if not exists claimed_until timestamptz;

-- Claim due rows (or one student's rows for one exam). Rows another sender
-- holds are skipped until their lease runs out.
create or replace function public.lti_claim_scores(
  p_now timestamptz,
  p_limit int,
  p_lease_seconds int,
  p_exam_id text default null,
  p_student_id uuid default null
)
returns table (
  link_id uuid, student_id uuid, claim_token uuid, sub text, lineitem text,
  score_maximum numeric, pending_score numeric, post_attempts int
)
language sql
set search_path = public
as $$
  with due as (
    select g.link_id, g.student_id
    from public.lti_grade_targets g
    where g.pending_score is not null
      and g.lineitem is not null
      and g.next_attempt_at is not null
      and g.next_attempt_at <= p_now
      and (g.claimed_until is null or g.claimed_until < p_now)
      and (p_exam_id is null or (g.exam_id = p_exam_id and g.student_id = p_student_id))
    order by g.next_attempt_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update public.lti_grade_targets t
     set claim_token = gen_random_uuid(),
         claimed_until = p_now + make_interval(secs => p_lease_seconds)
    from due
   where t.link_id = due.link_id and t.student_id = due.student_id
  returning t.link_id, t.student_id, t.claim_token, t.sub, t.lineitem,
            t.score_maximum, t.pending_score, t.post_attempts;
$$;

-- Release a claim after a post. The queued score is cleared only when it is
-- still the value that was sent; a newer queued score keeps its own schedule.
create or replace function public.lti_finish_score(
  p_link_id uuid,
  p_student_id uuid,
  p_claim_token uuid,
  p_score numeric,
  p_ok boolean,
  p_error text,
  p_attempts int,
  p_next_attempt_at timestamptz,
  p_now timestamptz
)
returns void
language sql
set search_path = public
as $$
  update public.lti_grade_targets
     set last_score      = case when p_ok then p_score else last_score end,
         last_posted_at  = case when p_ok then p_now else last_posted_at end,
         last_error      = case when p_ok then null else p_error end,
         pending_score   = case when p_ok and pending_score = p_score then null else pending_score end,
         post_attempts   = case when pending_score is distinct from p_score then post_attempts
                                when p_ok then 0 else p_attempts end,
         next_attempt_at = case when pending_score is distinct from p_score then next_attempt_at
                                when p_ok then null else p_next_attempt_at end,
         claim_token     = null,
         claimed_until   = null
   where link_id = p_link_id and student_id = p_student_id and claim_token = p_claim_token;
$$;

revoke all on function public.lti_claim_scores(timestamptz, int, int, text, uuid) from public, anon, authenticated;
revoke all on function public.lti_finish_score(uuid, uuid, uuid, numeric, boolean, text, int, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.lti_claim_scores(timestamptz, int, int, text, uuid) to service_role;
grant execute on function public.lti_finish_score(uuid, uuid, uuid, numeric, boolean, text, int, timestamptz, timestamptz) to service_role;
