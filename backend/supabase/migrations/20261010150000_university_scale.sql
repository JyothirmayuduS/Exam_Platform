-- University scale and access fixes for the ERP export, admin console and photos.
--   1. Hold reasons and registration photo rows: exam owners and admins only.
--   2. A held result is hidden from the student and not posted to Moodle;
--      releasing the hold shows it and queues the Moodle post again.
--   3. backup_runs: the backup job reports each run; the admin console reads it.
--   4. Evidence counts per R2 exam folder, so the console never lists the bucket.
--   5. admin_system_status works without pg_cron.

-- 1. Who may read hold reasons and photo rows ------------------------------

drop policy if exists "result holds staff read" on public.result_holds;
drop policy if exists "result holds owner read" on public.result_holds;
create policy "result holds owner read" on public.result_holds
  for select to authenticated
  using (public.owns_exam(exam_id) or public.auth_is_staff_admin());

-- A teacher (not a proctor) who owns an exam the student is enrolled in.
create or replace function public.teaches_student(p_student uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.auth_is_teacher() and exists (
    select 1 from public.enrollments en
    join public.exams e on e.id = en.exam_id
    where en.student_id = p_student and (e.created_by is null or e.created_by = auth.uid())
  );
$$;
revoke all on function public.teaches_student(uuid) from public, anon;
grant execute on function public.teaches_student(uuid) to authenticated;

drop policy if exists "student photos staff read" on public.student_photos;
drop policy if exists "student photos owner read" on public.student_photos;
create policy "student photos owner read" on public.student_photos
  for select to authenticated
  using (public.teaches_student(student_id) or public.auth_is_staff_admin());

-- 2. Malpractice hold ------------------------------------------------------

create or replace function public.exam_release_state(p_exam text, p_student uuid)
returns table(score_visible boolean, key_visible boolean)
language plpgsql stable security definer
set search_path = ''
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
  if exists (select 1 from public.result_holds h where h.exam_id = p_exam and h.student_id = p_student) then
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

-- The signed-in student's submitted papers. The score is null unless it is
-- released and not on hold.
create or replace function public.student_result_states()
returns table(exam_id text, graded boolean, held boolean, score numeric)
language sql stable security definer
set search_path = ''
as $$
  select a.exam_id,
         a.score is not null,
         h.held,
         case when not h.held and coalesce(r.score_visible, false) then a.score end
  from public.attempts a
  cross join lateral (
    select exists (select 1 from public.result_holds x where x.exam_id = a.exam_id and x.student_id = a.student_id) as held
  ) h
  left join lateral public.exam_release_state(a.exam_id, a.student_id) r on true
  where a.student_id = public.current_student_id() and a.state = 'submitted';
$$;
revoke all on function public.student_result_states() from public, anon;
grant execute on function public.student_result_states() to authenticated;

create or replace function public.lti_claim_scores(
  p_now timestamptz, p_limit integer, p_lease_seconds integer,
  p_exam_id text default null, p_student_id uuid default null)
returns table(link_id uuid, student_id uuid, claim_token uuid, sub text, lineitem text,
              score_maximum numeric, pending_score numeric, post_attempts integer)
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
      and not exists (
        select 1 from public.result_holds h where h.exam_id = g.exam_id and h.student_id = g.student_id)
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

create or replace function public.set_result_hold(p_attempt uuid, p_hold boolean, p_reason text default null)
returns text
language plpgsql security definer
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
  else
    delete from public.result_holds where attempt_id = a.id;
    if not found then
      return 'ok';
    end if;
    -- Scores that waited out the hold go to Moodle on the next retry run.
    update public.lti_grade_targets g
       set next_attempt_at = now(), post_attempts = 0
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

-- 3. Backup runs -----------------------------------------------------------

create table if not exists public.backup_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  kind text not null default 'database' check (length(kind) between 1 and 40),
  location text check (length(location) <= 500),
  size_bytes bigint check (size_bytes >= 0),
  message text check (length(message) <= 1000)
);
create index if not exists backup_runs_started_idx on public.backup_runs (started_at desc);
alter table public.backup_runs enable row level security;
revoke all on public.backup_runs from anon, authenticated;
grant select, insert, update on public.backup_runs to service_role;

-- Called by the backup job (service role, or psql as postgres). Pass p_id to
-- finish a run that was recorded as 'running'. Returns the run id.
create or replace function public.record_backup_run(
  p_status text,
  p_started_at timestamptz default null,
  p_finished_at timestamptz default null,
  p_kind text default 'database',
  p_location text default null,
  p_size_bytes bigint default null,
  p_message text default null,
  p_id bigint default null)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_id is not null then
    update public.backup_runs
       set status = p_status,
           finished_at = coalesce(p_finished_at, case when p_status <> 'running' then now() end, finished_at),
           location = coalesce(p_location, location),
           size_bytes = coalesce(p_size_bytes, size_bytes),
           message = coalesce(left(p_message, 1000), message)
     where id = p_id
     returning id into v_id;
    if v_id is null then
      raise exception 'backup run % not found', p_id;
    end if;
    return v_id;
  end if;
  insert into public.backup_runs (started_at, finished_at, status, kind, location, size_bytes, message)
  values (coalesce(p_started_at, now()),
          coalesce(p_finished_at, case when p_status <> 'running' then now() end),
          p_status, coalesce(p_kind, 'database'), p_location, p_size_bytes, left(p_message, 1000))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.record_backup_run(text, timestamptz, timestamptz, text, text, bigint, text, bigint) from public, anon, authenticated;
grant execute on function public.record_backup_run(text, timestamptz, timestamptz, text, text, bigint, text, bigint) to service_role;

-- 4. Evidence counts per R2 exam folder ------------------------------------
-- The console counts one folder at a time (prefix listing, a few pages per
-- request) and keeps the result here. scan_* hold a count in progress.

create table if not exists public.evidence_usage (
  folder text primary key check (length(folder) between 1 and 300 and position('/' in folder) = 0),
  bytes bigint not null default 0,
  objects bigint not null default 0,
  oldest timestamptz,
  due_soon_bytes bigint not null default 0,
  due_soon_objects bigint not null default 0,
  next_deletion timestamptz,
  retention_days integer,
  counted_at timestamptz,
  scan_id uuid,
  scan_started_at timestamptz,
  scan_bytes bigint not null default 0,
  scan_objects bigint not null default 0,
  scan_oldest timestamptz,
  scan_due_bytes bigint not null default 0,
  scan_due_objects bigint not null default 0,
  scan_next_deletion timestamptz
);

-- What each student folder inside an exam folder holds: <folder>/<student>/<kind>/…
create table if not exists public.evidence_sittings (
  folder text not null references public.evidence_usage(folder) on delete cascade,
  student_folder text not null,
  kinds text[] not null default '{}',
  files bigint not null default 0,
  last_upload timestamptz,
  scan_id uuid,
  primary key (folder, student_folder)
);

alter table public.evidence_usage enable row level security;
alter table public.evidence_sittings enable row level security;
revoke all on public.evidence_usage, public.evidence_sittings from anon, authenticated;
grant select, insert, update, delete on public.evidence_usage, public.evidence_sittings to service_role;

create or replace function public.evidence_scan_begin(p_folder text, p_scan uuid)
returns void
language sql security definer
set search_path = ''
as $$
  insert into public.evidence_usage as u (folder, scan_id, scan_started_at)
  values (p_folder, p_scan, now())
  on conflict (folder) do update
    set scan_id = excluded.scan_id, scan_started_at = now(),
        scan_bytes = 0, scan_objects = 0, scan_oldest = null,
        scan_due_bytes = 0, scan_due_objects = 0, scan_next_deletion = null;
$$;

-- Adds one batch of listed objects to the count in progress. p_part:
-- {bytes, objects, oldest, due_soon_bytes, due_soon_objects, next_deletion};
-- p_sittings: [{student_folder, kinds, files, last_upload}]. With p_done the
-- count replaces the stored totals. False when a newer count took over.
create or replace function public.evidence_scan_add(
  p_folder text, p_scan uuid, p_part jsonb, p_sittings jsonb, p_done boolean, p_retention_days integer)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.evidence_usage
     set scan_bytes = scan_bytes + coalesce((p_part ->> 'bytes')::bigint, 0),
         scan_objects = scan_objects + coalesce((p_part ->> 'objects')::bigint, 0),
         scan_oldest = least(scan_oldest, (p_part ->> 'oldest')::timestamptz),
         scan_due_bytes = scan_due_bytes + coalesce((p_part ->> 'due_soon_bytes')::bigint, 0),
         scan_due_objects = scan_due_objects + coalesce((p_part ->> 'due_soon_objects')::bigint, 0),
         scan_next_deletion = least(scan_next_deletion, (p_part ->> 'next_deletion')::timestamptz)
   where folder = p_folder and scan_id = p_scan;
  if not found then
    return false;
  end if;

  insert into public.evidence_sittings as s (folder, student_folder, kinds, files, last_upload, scan_id)
  select p_folder, x ->> 'student_folder',
         coalesce(array(select jsonb_array_elements_text(x -> 'kinds')), '{}'),
         coalesce((x ->> 'files')::bigint, 0), (x ->> 'last_upload')::timestamptz, p_scan
  from jsonb_array_elements(coalesce(p_sittings, '[]'::jsonb)) x
  where coalesce(x ->> 'student_folder', '') <> ''
  on conflict (folder, student_folder) do update
    set kinds = case when s.scan_id = excluded.scan_id
                     then array(select distinct k from unnest(s.kinds || excluded.kinds) k order by k)
                     else excluded.kinds end,
        files = case when s.scan_id = excluded.scan_id then s.files + excluded.files else excluded.files end,
        last_upload = case when s.scan_id = excluded.scan_id then greatest(s.last_upload, excluded.last_upload) else excluded.last_upload end,
        scan_id = excluded.scan_id;

  if p_done then
    update public.evidence_usage
       set bytes = scan_bytes, objects = scan_objects, oldest = scan_oldest,
           due_soon_bytes = scan_due_bytes, due_soon_objects = scan_due_objects, next_deletion = scan_next_deletion,
           retention_days = p_retention_days, counted_at = now(), scan_id = null, scan_started_at = null
     where folder = p_folder;
    delete from public.evidence_sittings where folder = p_folder and scan_id is distinct from p_scan;
  end if;
  return true;
end;
$$;
revoke all on function public.evidence_scan_begin(text, uuid) from public, anon, authenticated;
revoke all on function public.evidence_scan_add(text, uuid, jsonb, jsonb, boolean, integer) from public, anon, authenticated;
grant execute on function public.evidence_scan_begin(text, uuid) to service_role;
grant execute on function public.evidence_scan_add(text, uuid, jsonb, jsonb, boolean, integer) to service_role;

-- 5. System status without pg_cron -----------------------------------------

create or replace function public.admin_system_status()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_cron boolean := to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null;
  v_jobs jsonb := '[]'::jsonb;
  v_buckets jsonb := '[]'::jsonb;
begin
  if v_cron then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', j.jobname,
        'schedule', j.schedule,
        'active', j.active,
        'last_run', (
          select jsonb_build_object('status', d.status, 'started_at', d.start_time, 'ended_at', d.end_time, 'message', left(d.return_message, 200))
          from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1),
        'failures_24h', (
          select count(*) from cron.job_run_details d
          where d.jobid = j.jobid and d.status <> 'succeeded' and d.start_time > now() - interval '24 hours')
      ) order by j.jobname), '[]'::jsonb)
      from cron.job j
    $q$ into v_jobs;
  end if;

  if to_regclass('storage.objects') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('bucket', s.bucket_id, 'objects', s.n, 'bytes', s.b) order by s.bucket_id), '[]'::jsonb)
      from (select bucket_id, count(*) n, coalesce(sum((metadata->>'size')::bigint), 0) b from storage.objects group by bucket_id) s
    $q$ into v_buckets;
  end if;

  return jsonb_build_object(
    'cron_installed', v_cron,
    'jobs', v_jobs,
    'buckets', v_buckets,
    'database_bytes', pg_database_size(current_database()),
    'unlinked_accounts', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at) order by u.created_at desc)
      from auth.users u
      where not exists (select 1 from public.teachers t where t.auth_id = u.id)
        and not exists (select 1 from public.students s where s.auth_id = u.id)), '[]'::jsonb),
    'missing_app_role', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id, 'email', u.email,
        'kind', case when exists (select 1 from public.teachers t where t.auth_id = u.id) then 'staff'
                     when exists (select 1 from public.students s where s.auth_id = u.id) then 'student'
                     else 'unlinked' end) order by u.email)
      from auth.users u
      where coalesce(u.raw_app_meta_data->>'role', '') = ''), '[]'::jsonb),
    'backups', jsonb_build_object(
      'latest', (
        select jsonb_build_object('id', b.id, 'status', b.status, 'kind', b.kind, 'started_at', b.started_at, 'finished_at', b.finished_at,
                                  'location', b.location, 'size_bytes', b.size_bytes, 'message', b.message)
        from public.backup_runs b order by b.started_at desc, b.id desc limit 1),
      'last_success', (
        select jsonb_build_object('id', b.id, 'status', b.status, 'kind', b.kind, 'started_at', b.started_at, 'finished_at', b.finished_at,
                                  'location', b.location, 'size_bytes', b.size_bytes, 'message', b.message)
        from public.backup_runs b where b.status = 'succeeded' order by b.started_at desc, b.id desc limit 1),
      'failures_7d', (select count(*) from public.backup_runs b where b.status = 'failed' and b.started_at > now() - interval '7 days'))
  );
end;
$$;
revoke all on function public.admin_system_status() from public, anon, authenticated;
grant execute on function public.admin_system_status() to service_role;
