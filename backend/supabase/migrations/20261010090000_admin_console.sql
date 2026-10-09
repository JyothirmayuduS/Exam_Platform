-- Admin console.
--  * flag_reviews: an admin (or the exam's teacher) has looked at a proctoring
--    flag. Kept apart from violation_events so flag capture is untouched.
--  * admin_system_status(): scheduled jobs, storage buckets, database size and
--    accounts without a role. It reads cron, storage and auth, so only the
--    admin-dashboard edge function (service role) may call it.

create table if not exists public.flag_reviews (
  violation_id uuid primary key references public.violation_events(id) on delete cascade,
  exam_id      text references public.exams(id) on delete cascade,
  reviewed_by  uuid not null,
  reviewed_at  timestamptz not null default now(),
  note         text
);
create index if not exists flag_reviews_exam_idx on public.flag_reviews (exam_id);

alter table public.flag_reviews enable row level security;
revoke all on public.flag_reviews from anon, authenticated;
grant select on public.flag_reviews to authenticated;
drop policy if exists "flag reviews staff read" on public.flag_reviews;
create policy "flag reviews staff read" on public.flag_reviews
  for select to authenticated using ((select public.auth_is_staff()));

create or replace function public.admin_system_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', j.jobname,
        'schedule', j.schedule,
        'active', j.active,
        'last_run', (
          select jsonb_build_object('status', d.status, 'started_at', d.start_time, 'ended_at', d.end_time, 'message', left(d.return_message, 200))
          from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1),
        'failures_24h', (
          select count(*) from cron.job_run_details d
          where d.jobid = j.jobid and d.status <> 'succeeded' and d.start_time > now() - interval '24 hours')
      ) order by j.jobname)
      from cron.job j), '[]'::jsonb),
    'buckets', coalesce((
      select jsonb_agg(jsonb_build_object('bucket', s.bucket_id, 'objects', s.n, 'bytes', s.b) order by s.bucket_id)
      from (select bucket_id, count(*) n, coalesce(sum((metadata->>'size')::bigint), 0) b from storage.objects group by bucket_id) s), '[]'::jsonb),
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
      where coalesce(u.raw_app_meta_data->>'role', '') = ''), '[]'::jsonb)
  );
$$;
revoke all on function public.admin_system_status() from public, anon, authenticated;
grant execute on function public.admin_system_status() to service_role;
