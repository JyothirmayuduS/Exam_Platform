-- Facts the manifest records at backup time, as one JSON line (psql -Atq).
-- The sample attempt is a scored attempt, preferring one with a recording in
-- Storage and with violations, so the restore check exercises all three.
set timezone = 'UTC';

with rec as (
  select o.bucket_id, o.name, coalesce((o.metadata->>'size')::bigint, 0) as bytes,
         split_part(o.name, '/', 1) as folder, split_part(o.name, '/', 2) as student_folder
    from storage.objects o
   where o.name ~* '\.(webm|mp4|mkv|ogg)$'
),
matched as (
  select r.*, a.id as attempt_id
    from rec r
    join public.exams e on r.folder in (e.id, e.name, coalesce(e.legacy_name, ''))
    join public.students st on st.roll <> '' and position(upper(st.roll) in upper(r.student_folder)) > 0
    join public.attempts a on a.exam_id = e.id and a.student_id = st.id
),
pick as (
  select a.id
    from public.attempts a
   order by (a.score is not null) desc,
            exists (select 1 from matched m where m.attempt_id = a.id) desc,
            exists (select 1 from public.violation_events v where v.attempt_id::text = a.id::text) desc,
            a.submitted_at desc nulls last, a.id
   limit 1
),
recording as (
  select bucket_id, name, bytes
    from (select m.bucket_id, m.name, m.bytes, 0 as pref from matched m where m.attempt_id = (select id from pick)
          union all
          select r.bucket_id, r.name, r.bytes, 1 from rec r) x
   order by pref, bytes desc
   limit 1
)
select jsonb_build_object(
  'server_version', current_setting('server_version'),
  'taken_at', now(),
  'retention_days', public.retention_days(),
  'buckets', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'public', public) order by id), '[]') from storage.buckets),
  'vault_secret_names', (select coalesce(jsonb_agg(name order by name), '[]') from vault.secrets),
  'cron_jobs', (select coalesce(jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule, 'active', active) order by jobname), '[]') from cron.job),
  -- Platform tables postgres cannot write, so no restore can load them; the
  -- data dump skips them and the manifest keeps their row counts.
  'not_restored_tables', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', format('%I.%I', n.nspname, c.relname),
             'rows', (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint)
             order by n.nspname, c.relname), '[]')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and n.nspname in ('auth', 'storage', 'supabase_functions')
       and c.relname not in ('schema_migrations', 'migrations')
       and not has_table_privilege('postgres', c.oid, 'INSERT')),
  'sample_attempt_id', (select id from pick),
  'sample_recording', (select jsonb_build_object('store', 'storage-' || bucket_id, 'path', name, 'bytes', bytes) from recording)
);
