-- Schedules the evidence-retention job and stops the old 90-day sweep from
-- deleting AI reports: results are deleted only by the retention job.
--
-- The job calls the evidence-retention edge function with a shared secret. Store
-- the function URL and the secret in Vault once (docs/retention.md):
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/evidence-retention', 'evidence_retention_url');
--   select vault.create_secret('<RETENTION_CRON_SECRET>', 'evidence_retention_cron_secret');
create extension if not exists pg_cron;
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;

  if exists (select 1 from cron.job where jobname = 'retention-daily-cleanup') then
    perform cron.unschedule('retention-daily-cleanup');
  end if;
  perform cron.schedule(
    'retention-daily-cleanup',
    '15 3 * * *',
    $sql$ delete from public.mobile_upload_sessions where created_at < now() - interval '90 days'; $sql$
  );

  if exists (select 1 from cron.job where jobname = 'evidence-retention') then
    perform cron.unschedule('evidence-retention');
  end if;
  perform cron.schedule(
    'evidence-retention',
    '30 21 * * *',  -- 03:00 IST daily
    $sql$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'evidence_retention_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-retention-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'evidence_retention_cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 300000
    );
    $sql$
  );
end $do$;
