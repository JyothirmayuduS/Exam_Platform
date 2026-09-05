-- 1. Audit log: every privileged staff action (score change, force submit,
--    publish, etc.) lands here with actor + timestamp. Staff read/write only;
--    students cannot see it. Rows are immutable history — no update policy.
create table if not exists public.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  actor_role  text not null default 'staff' check (actor_role in ('teacher','proctor','system')),
  action      text not null,
  target_type text not null,
  target_id   text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_target_idx on public.audit_logs (target_type, target_id);

alter table public.audit_logs enable row level security;

drop policy if exists "ep audit staff" on public.audit_logs;
create policy "ep audit staff" on public.audit_logs
  for all using (public.auth_is_staff()) with check (public.auth_is_staff());

-- 2. Retention: R2 binary artifacts auto-expire at 90 days via bucket
--    lifecycle rules (configured by the r2-retention Edge Function). This
--    cron only sweeps the DB rows that should not outlive them:
--    transient upload sessions and AI integrity reports.
create extension if not exists pg_cron;

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'retention-daily-cleanup') then
    perform cron.unschedule('retention-daily-cleanup');
  end if;
  perform cron.schedule(
    'retention-daily-cleanup',
    '15 3 * * *',  -- 3:15 AM daily
    $sql$
    delete from public.mobile_upload_sessions
    where created_at < now() - interval '90 days';
    delete from public.ai_reports
    where updated_at < now() - interval '90 days';
    $sql$
  );
end $do$;
