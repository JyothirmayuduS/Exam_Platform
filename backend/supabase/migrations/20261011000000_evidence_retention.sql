-- Evidence and results retention, with the app as the only thing that deletes.
--  * retention_settings: one site retention period (default 1825 days, 5 years).
--    Only admins change it, through set_retention_days, which audits the change.
--  * legal_holds: admins hold an exam or a student; set_legal_hold audits placing
--    and lifting. Lifting changes nothing else: retention still counts from the
--    original upload or submission date.
--  * retention_runs: one row per run of the deletion job (deleted, skipped, failed).
--  * retention_attempt_hold / retention_folder_status / retention_db_batch: what
--    the job may delete. Nothing is deleted for an attempt on a malpractice hold
--    (result_holds), an exam or student on a legal hold, an attempt with an open
--    appeal, or an attempt with a serious flag nobody has reviewed yet.
-- Everything here is for the server functions (service role) only.

create table if not exists public.retention_settings (
  id boolean primary key default true check (id),
  retention_days integer not null default 1825 check (retention_days between 30 and 3650),
  storage_cursor text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.retention_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.legal_holds (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('exam', 'student')),
  target_id text not null,
  reason text,
  placed_by uuid not null,
  placed_at timestamptz not null default now(),
  lifted_by uuid,
  lifted_at timestamptz
);
create unique index if not exists legal_holds_active on public.legal_holds (target_type, target_id) where lifted_at is null;

create table if not exists public.retention_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  dry_run boolean not null,
  trigger text not null check (trigger in ('schedule', 'admin')),
  requested_by uuid,
  retention_days integer not null,
  cutoff timestamptz not null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  complete boolean not null default false,
  deleted integer not null default 0,
  skipped integer not null default 0,
  failed integer not null default 0,
  due_week integer,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists retention_runs_started on public.retention_runs (started_at desc);

-- Appeals students file against an attempt; live has this table without a migration.
create table if not exists public.student_appeals (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  student_id uuid not null,
  question_id text,
  reason text,
  requested_score numeric(5,2),
  status text default 'pending',
  teacher_response text,
  reviewed_by uuid,
  reviewed_at timestamp without time zone,
  created_at timestamp without time zone default now()
);

alter table public.retention_settings enable row level security;
alter table public.legal_holds enable row level security;
alter table public.retention_runs enable row level security;
alter table public.student_appeals enable row level security;
revoke all on public.retention_settings, public.legal_holds, public.retention_runs from public, anon, authenticated;

-- ── Period ──────────────────────────────────────────────────────────────────
create or replace function public.retention_days()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.retention_days from public.retention_settings s where s.id), 1825);
$$;

create or replace function public.set_retention_days(p_days integer, p_actor uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old integer;
begin
  if p_actor is null or not exists (select 1 from public.staff_admins a where a.auth_id = p_actor) then
    raise exception 'admins_only' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 30 and 3650 then
    raise exception 'retention_days_out_of_range: choose between 30 and 3650 days' using errcode = '22023';
  end if;
  select s.retention_days into v_old from public.retention_settings s where s.id for update;
  if v_old is distinct from p_days then
    update public.retention_settings set retention_days = p_days, updated_at = now(), updated_by = p_actor where id;
    insert into public.audit_logs (actor_id, actor_role, action, target_type, target_id, meta)
    values (p_actor, 'teacher', 'admin.retention_changed', 'retention', 'site', jsonb_build_object('from', v_old, 'to', p_days));
  end if;
  return p_days;
end;
$$;

-- ── Legal holds ─────────────────────────────────────────────────────────────
create or replace function public.set_legal_hold(p_type text, p_target text, p_on boolean, p_reason text, p_actor uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed boolean := false;
begin
  if p_actor is null or not exists (select 1 from public.staff_admins a where a.auth_id = p_actor) then
    raise exception 'admins_only' using errcode = '42501';
  end if;
  if p_type = 'exam' then
    if not exists (select 1 from public.exams e where e.id = p_target) then
      raise exception 'target_not_found' using errcode = 'P0002';
    end if;
  elsif p_type = 'student' then
    if p_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.students s where s.id = p_target::uuid) then
      raise exception 'target_not_found' using errcode = 'P0002';
    end if;
    p_target := lower(p_target);
  else
    raise exception 'bad_target_type' using errcode = '22023';
  end if;

  if p_on then
    insert into public.legal_holds (target_type, target_id, reason, placed_by)
    values (p_type, p_target, nullif(btrim(coalesce(p_reason, '')), ''), p_actor)
    on conflict (target_type, target_id) where lifted_at is null do nothing;
    v_changed := found;
  else
    update public.legal_holds set lifted_by = p_actor, lifted_at = now()
    where target_type = p_type and target_id = p_target and lifted_at is null;
    v_changed := found;
  end if;
  if v_changed then
    insert into public.audit_logs (actor_id, actor_role, action, target_type, target_id, meta)
    values (p_actor, 'teacher', case when p_on then 'admin.legal_hold_placed' else 'admin.legal_hold_lifted' end,
            p_type, p_target, jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')));
  end if;
  return v_changed;
end;
$$;

-- ── What must be kept ───────────────────────────────────────────────────────
create or replace function public.retention_open_status(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(lower(btrim(p_status)), 'pending')
    not in ('resolved', 'rejected', 'closed', 'withdrawn', 'accepted', 'approved', 'dismissed', 'completed', 'done');
$$;

create or replace function public.retention_legal_hold(p_exam text, p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.legal_holds l
    where l.lifted_at is null
      and ((l.target_type = 'exam' and l.target_id = p_exam) or (l.target_type = 'student' and l.target_id = p_student::text)));
$$;

-- Why an attempt must be kept, or null when retention may delete it.
create or replace function public.retention_attempt_hold(p_attempt uuid, p_exam text, p_student uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.result_holds h where h.attempt_id = p_attempt) then 'malpractice_hold'
    when public.retention_legal_hold(p_exam, p_student) then 'legal_hold'
    when exists (select 1 from public.appeal_requests r where r.attempt_id = p_attempt and public.retention_open_status(r.status))
      or exists (select 1 from public.student_appeals r where r.attempt_id = p_attempt and public.retention_open_status(r.status)) then 'appeal'
    when exists (select 1 from public.violation_events v
                 where v.attempt_id = p_attempt and v.severity in ('high', 'critical')
                   and not exists (select 1 from public.flag_reviews f where f.violation_id = v.id)) then 'under_review'
  end;
$$;

-- For each student folder inside an evidence exam folder: why its files must be
-- kept, or null. The exam folder is the exam id or its (slugged) name; the
-- student folder is the roll or the student id.
create or replace function public.retention_folder_status(p_folder text, p_students text[])
returns table(student_folder text, hold text)
language sql
stable
security definer
set search_path = ''
as $$
  with ex as (
    select e.id from public.exams e
    where e.id = p_folder or e.name = p_folder
       or public.exam_folder_slug(e.name) = p_folder or public.exam_folder_slug(e.legacy_name) = p_folder
  ), sf as (
    select distinct f from unnest(p_students) f
  ), st as (
    select sf.f, s.id from sf join public.students s on upper(s.roll) = upper(sf.f) or s.id::text = lower(sf.f)
  )
  select sf.f, coalesce(
    (select 'legal_hold' from public.legal_holds l
     where l.lifted_at is null and l.target_type = 'exam' and l.target_id in (select id from ex) limit 1),
    (select 'legal_hold' from st join public.legal_holds l
       on l.lifted_at is null and l.target_type = 'student' and l.target_id = st.id::text
     where st.f = sf.f limit 1),
    (select x.h from st
     join public.attempts a on a.student_id = st.id and a.exam_id in (select id from ex)
     cross join lateral (select public.retention_attempt_hold(a.id, a.exam_id, a.student_id) h) x
     where st.f = sf.f and x.h is not null limit 1))
  from sf;
$$;

create or replace function public.retention_violation_hold(p_attempt uuid, p_exam text, p_student uuid, p_severity text, p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case when p_attempt is not null then public.retention_attempt_hold(p_attempt, p_exam, p_student) end,
    case when public.retention_legal_hold(p_exam, p_student) then 'legal_hold' end,
    case when p_severity in ('high', 'critical') and not exists (select 1 from public.flag_reviews f where f.violation_id = p_id)
         then 'under_review' end);
$$;

create or replace function public.retention_audit_hold(p_target_type text, p_target_id text, p_meta jsonb)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_target_type = 'exam' and public.retention_legal_hold(p_target_id, null) then 'legal_hold'
    when p_target_type = 'student' and exists (select 1 from public.legal_holds l
      where l.lifted_at is null and l.target_type = 'student' and l.target_id = lower(p_target_id)) then 'legal_hold'
    when p_meta ? 'exam_id' and public.retention_legal_hold(p_meta->>'exam_id', null) then 'legal_hold'
    when p_target_type = 'attempt' and p_target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      (select public.retention_attempt_hold(a.id, a.exam_id, a.student_id) from public.attempts a where a.id = p_target_id::uuid)
  end;
$$;

-- One batch of database deletions past the cutoff. Results and marks are the
-- attempts (their answers, grading, AI reports and holds go with them);
-- violation_events and audit_logs are deleted by their own date. Returns how
-- many are due (past the cutoff and not held), how many are held (skipped), how
-- many this call deleted (none on a dry run), and whether more remain.
create or replace function public.retention_db_batch(p_kind text, p_cutoff timestamptz, p_limit integer, p_dry_run boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due integer := 0;
  v_skipped integer := 0;
  v_deleted integer := 0;
begin
  if p_kind = 'attempts' then
    select count(*) filter (where x.h is null), count(*) filter (where x.h is not null) into v_due, v_skipped
    from public.attempts a
    cross join lateral (select public.retention_attempt_hold(a.id, a.exam_id, a.student_id) h) x
    where coalesce(a.submitted_at, a.started_at, a.auto_saved_at) < p_cutoff;
    if not p_dry_run and v_due > 0 then
      delete from public.attempts a where a.id in (
        select a2.id from public.attempts a2
        where coalesce(a2.submitted_at, a2.started_at, a2.auto_saved_at) < p_cutoff
          and public.retention_attempt_hold(a2.id, a2.exam_id, a2.student_id) is null
        order by a2.id limit p_limit);
      get diagnostics v_deleted = row_count;
    end if;
  elsif p_kind = 'violation_events' then
    select count(*) filter (where x.h is null), count(*) filter (where x.h is not null) into v_due, v_skipped
    from public.violation_events v
    cross join lateral (select public.retention_violation_hold(v.attempt_id, v.exam_id, v.student_id, v.severity, v.id) h) x
    where v.created_at < p_cutoff;
    if not p_dry_run and v_due > 0 then
      delete from public.violation_events v where v.id in (
        select v2.id from public.violation_events v2
        where v2.created_at < p_cutoff
          and public.retention_violation_hold(v2.attempt_id, v2.exam_id, v2.student_id, v2.severity, v2.id) is null
        order by v2.id limit p_limit);
      get diagnostics v_deleted = row_count;
    end if;
  elsif p_kind = 'audit_logs' then
    select count(*) filter (where x.h is null), count(*) filter (where x.h is not null) into v_due, v_skipped
    from public.audit_logs l
    cross join lateral (select public.retention_audit_hold(l.target_type, l.target_id, l.meta) h) x
    where l.created_at < p_cutoff;
    if not p_dry_run and v_due > 0 then
      delete from public.audit_logs l where l.id in (
        select l2.id from public.audit_logs l2
        where l2.created_at < p_cutoff and public.retention_audit_hold(l2.target_type, l2.target_id, l2.meta) is null
        order by l2.id limit p_limit);
      get diagnostics v_deleted = row_count;
    end if;
  else
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  return jsonb_build_object('due', v_due, 'skipped', v_skipped, 'deleted', v_deleted,
                            'more', not p_dry_run and v_deleted > 0 and v_due > v_deleted);
end;
$$;

do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public.retention_days()',
    'public.set_retention_days(integer, uuid)',
    'public.set_legal_hold(text, text, boolean, text, uuid)',
    'public.retention_legal_hold(text, uuid)',
    'public.retention_attempt_hold(uuid, text, uuid)',
    'public.retention_folder_status(text, text[])',
    'public.retention_violation_hold(uuid, text, uuid, text, uuid)',
    'public.retention_audit_hold(text, text, jsonb)',
    'public.retention_db_batch(text, timestamptz, integer, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $grants$;

notify pgrst, 'reload schema';
