-- Prints SQL (run with psql -At) that recreates what the schema dump leaves
-- out because it lives in platform-owned schemas:
--   1. RLS policies on auth and storage tables (the exam-records rules);
--   2. triggers on those tables that call our own functions;
--   3. which of our tables are in the supabase_realtime publication;
--   4. pg_cron jobs, created switched off: they call URLs and read vault
--      secrets that belong to the old project.
-- Restore runs the output after the schema and data.

select '-- platform objects, generated ' || now()::text;

select format('drop policy if exists %I on %I.%I;', policyname, schemaname, tablename) || E'\n' ||
       format('create policy %I on %I.%I as %s for %s to %s%s%s;',
              policyname, schemaname, tablename, permissive, cmd,
              (select string_agg(quote_ident(r::text), ', ') from unnest(roles) r),
              case when qual is not null then format(' using (%s)', qual) else '' end,
              case when with_check is not null then format(' with check (%s)', with_check) else '' end)
  from pg_policies
 where schemaname in ('auth', 'storage')
 order by schemaname, tablename, policyname;

select regexp_replace(pg_get_triggerdef(t.oid), '^CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER') || ';'
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace pn on pn.oid = p.pronamespace
 where not t.tgisinternal
   and n.nspname in ('auth', 'storage')
   and pn.nspname not in ('auth', 'storage', 'extensions', 'realtime', 'supabase_functions', 'pg_catalog')
 order by 1;

select format($f$do $p$ begin
  if not exists (select 1 from pg_publication where pubname = %1$L) then create publication %2$I; end if;
  if not exists (select 1 from pg_publication_tables where pubname = %1$L and schemaname = %3$L and tablename = %4$L) then
    alter publication %2$I add table only %5$I.%6$I;
  end if;
end $p$;$f$, pubname, pubname, schemaname, tablename, schemaname, tablename)
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname <> 'realtime'
 order by schemaname, tablename;

select format('select cron.alter_job(cron.schedule(%L, %L, %L), active := false);', jobname, schedule, command)
  from cron.job
 order by jobname;
