-- Retention fixes.
--  * exam_former_names: every name an exam had before, recorded whenever its
--    name changes (the naming trigger composes names from the subject fields).
--    Legacy evidence folders are matched against all of them.
--  * retention_folder_status: an exam folder that matches no exam, or a student
--    folder that does not match exactly one student with an attempt in that
--    exam, is unknown and kept ('unmatched_exam' / 'unmatched_student').
--  * retention_db_batch: a deleting call only looks at the batch it deletes.
--  * retention_cleanup_upload_sessions: the daily 90-day phone upload session
--    cleanup skips sessions of held attempts, exams and students.

create table if not exists public.exam_former_names (
  exam_id text not null references public.exams(id) on delete cascade,
  name text not null,
  recorded_at timestamptz not null default now(),
  primary key (exam_id, name)
);
alter table public.exam_former_names enable row level security;
revoke all on public.exam_former_names from public, anon, authenticated;

insert into public.exam_former_names (exam_id, name)
select e.id, e.legacy_name from public.exams e
where coalesce(btrim(e.legacy_name), '') <> ''
on conflict do nothing;

create or replace function public.exams_record_former_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(btrim(old.name), '') <> '' then
    insert into public.exam_former_names (exam_id, name) values (new.id, old.name) on conflict do nothing;
  end if;
  return null;
end;
$$;

drop trigger if exists exams_record_former_name on public.exams;
create trigger exams_record_former_name after update on public.exams
  for each row when (old.name is distinct from new.name) execute function public.exams_record_former_name();

-- Folders old kiosks may have used for an exam: its name, legacy name and every
-- former name, raw and slugged. A folder shared by two exams, or equal to an
-- exam id, belongs to no exam.
create or replace function public.legacy_folder_exams()
returns table(folder text, exam_id text)
language sql
stable
security definer
set search_path = ''
as $$
  with names as (
    select e.id as exam_id, n.name
    from public.exams e
    cross join lateral (values (e.name), (e.legacy_name)) n(name)
    union
    select f.exam_id, f.name from public.exam_former_names f
  ), candidates as (
    select distinct v.f as folder, n.exam_id
    from names n
    cross join lateral (values (n.name), (public.exam_folder_slug(n.name))) v(f)
    where coalesce(v.f, '') <> ''
  )
  select c.folder, min(c.exam_id) from candidates c
  where not exists (select 1 from public.exams x where x.id = c.folder)
  group by c.folder
  having count(*) = 1;
$$;

-- For each student folder inside an evidence exam folder: why its files must be
-- kept, or null. The exam folder is the exam id or any of its names (raw or
-- slugged); the student folder is a roll or a student id, and must match exactly
-- one student with an attempt in that exam. Anything else is kept as unmatched.
create or replace function public.retention_folder_status(p_folder text, p_students text[])
returns table(student_folder text, hold text)
language sql
stable
security definer
set search_path = ''
as $$
  with ex as (
    select e.id from public.exams e
    where e.id = p_folder or e.name = p_folder or public.exam_folder_slug(e.name) = p_folder
       or e.legacy_name = p_folder or public.exam_folder_slug(e.legacy_name) = p_folder
       or exists (select 1 from public.exam_former_names f
                  where f.exam_id = e.id and (f.name = p_folder or public.exam_folder_slug(f.name) = p_folder))
  ), sf as (
    select distinct f from unnest(p_students) f
  ), st as (
    select sf.f, s.id from sf join public.students s on upper(s.roll) = upper(sf.f) or s.id::text = lower(sf.f)
  ), sa as (
    select st.f, a.id, a.exam_id, a.student_id
    from st join public.attempts a on a.student_id = st.id and a.exam_id in (select id from ex)
  )
  select sf.f, case
    when not exists (select 1 from ex) then 'unmatched_exam'
    when exists (select 1 from public.legal_holds l
                 where l.lifted_at is null and l.target_type = 'exam' and l.target_id in (select id from ex)) then 'legal_hold'
    when exists (select 1 from st join public.legal_holds l
                   on l.lifted_at is null and l.target_type = 'student' and l.target_id = st.id::text
                 where st.f = sf.f) then 'legal_hold'
    when (select count(distinct sa.student_id) from sa where sa.f = sf.f) <> 1 then 'unmatched_student'
    else (select x.h from sa
          cross join lateral (select public.retention_attempt_hold(sa.id, sa.exam_id, sa.student_id) h) x
          where sa.f = sf.f and x.h is not null limit 1)
  end
  from sf;
$$;

-- A dry run (or a limit of 0) counts everything past the cutoff: due (not held)
-- and skipped (held). A deleting call deletes up to p_limit rows that are not
-- held, oldest id first, and reports only that batch.
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
  v_count boolean := p_dry_run or coalesce(p_limit, 0) <= 0;
begin
  if p_kind = 'attempts' then
    if v_count then
      select count(*) filter (where x.h is null), count(*) filter (where x.h is not null) into v_due, v_skipped
      from public.attempts a
      cross join lateral (select public.retention_attempt_hold(a.id, a.exam_id, a.student_id) h) x
      where coalesce(a.submitted_at, a.started_at, a.auto_saved_at) < p_cutoff;
    else
      delete from public.attempts a where a.id in (
        select a2.id from public.attempts a2
        where coalesce(a2.submitted_at, a2.started_at, a2.auto_saved_at) < p_cutoff
          and public.retention_attempt_hold(a2.id, a2.exam_id, a2.student_id) is null
        order by a2.id limit p_limit);
      get diagnostics v_deleted = row_count;
    end if;
  elsif p_kind = 'violation_events' then
    if v_count then
      select count(*) filter (where x.h is null), count(*) filter (where x.h is not null) into v_due, v_skipped
      from public.violation_events v
      cross join lateral (select public.retention_violation_hold(v.attempt_id, v.exam_id, v.student_id, v.severity, v.id) h) x
      where v.created_at < p_cutoff;
    else
      delete from public.violation_events v where v.id in (
        select v2.id from public.violation_events v2
        where v2.created_at < p_cutoff
          and public.retention_violation_hold(v2.attempt_id, v2.exam_id, v2.student_id, v2.severity, v2.id) is null
        order by v2.id limit p_limit);
      get diagnostics v_deleted = row_count;
    end if;
  elsif p_kind = 'audit_logs' then
    if v_count then
      select count(*) filter (where x.h is null), count(*) filter (where x.h is not null) into v_due, v_skipped
      from public.audit_logs l
      cross join lateral (select public.retention_audit_hold(l.target_type, l.target_id, l.meta) h) x
      where l.created_at < p_cutoff;
    else
      delete from public.audit_logs l where l.id in (
        select l2.id from public.audit_logs l2
        where l2.created_at < p_cutoff and public.retention_audit_hold(l2.target_type, l2.target_id, l2.meta) is null
        order by l2.id limit p_limit);
      get diagnostics v_deleted = row_count;
    end if;
  else
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if not v_count then
    v_due := v_deleted;
  end if;
  return jsonb_build_object('due', v_due, 'skipped', v_skipped, 'deleted', v_deleted,
                            'more', not v_count and v_deleted >= p_limit);
end;
$$;

-- Phone upload sessions older than 90 days, except those of a held attempt or
-- of an exam or student on a legal hold.
create or replace function public.retention_cleanup_upload_sessions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.mobile_upload_sessions s
  where s.created_at < now() - interval '90 days'
    and not public.retention_legal_hold(s.exam_id, s.student_id)
    and not exists (select 1 from public.attempts a
                    where a.id::text = s.attempt_id::text
                      and public.retention_attempt_hold(a.id, a.exam_id, a.student_id) is not null);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public.exams_record_former_name()',
    'public.retention_folder_status(text, text[])',
    'public.retention_db_batch(text, timestamptz, integer, boolean)',
    'public.retention_cleanup_upload_sessions()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $grants$;

do $cron$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if exists (select 1 from cron.job where jobname = 'retention-daily-cleanup') then
      perform cron.unschedule('retention-daily-cleanup');
    end if;
    perform cron.schedule('retention-daily-cleanup', '15 3 * * *', 'select public.retention_cleanup_upload_sessions();');
  end if;
end $cron$;

notify pgrst, 'reload schema';
