-- Normalize a legacy `violation_events` table into the exact shape the teacher
-- + proctor consoles, exports and recording timeline expect.
--
-- Background: projects created before this migration carry a legacy table with
-- a different shape (no `source` / `offset_seconds` / `snapshot_key`, severity
-- defaulting to 'medium', `created_at` without timezone, plus obsolete columns
-- like `timestamp` / `resolved_at` / `resolved_by` / `notes`). Earlier
-- migrations used `create table if not exists`, which silently skipped that
-- legacy table, so the new columns never appeared.
--
-- This migration UPGRADES in place and migrates the existing rows (nothing is
-- dropped). Obsolete columns are kept so no data is lost.

-- 1. Columns the app expects but the legacy table lacks.
alter table public.violation_events add column if not exists
  source text not null default 'system';
alter table public.violation_events add column if not exists
  offset_seconds int;
alter table public.violation_events add column if not exists
  snapshot_key text;

-- 2. Severity: legacy rows may use null / 'low' / 'medium' etc. Map them onto
--    the modern set ('info','warning','high','critical'), then enforce it.
update public.violation_events
set severity = case
  when severity is null                      then 'warning'
  when lower(severity) = 'low'               then 'info'
  when lower(severity) = 'medium'            then 'warning'
  when lower(severity) in ('high','critical') then lower(severity)
  else 'warning'
end
where severity is null or lower(severity) not in ('info','warning','high','critical');

alter table public.violation_events alter column severity set default 'warning';
alter table public.violation_events alter column severity set not null;
alter table public.violation_events drop constraint if exists violation_events_severity_check;
alter table public.violation_events add constraint violation_events_severity_check
  check (severity in ('info','warning','high','critical'));

-- 3. `source` constraint (incl. 'teacher' for teacher-console actions).
alter table public.violation_events drop constraint if exists violation_events_source_check;
alter table public.violation_events add constraint violation_events_source_check
  check (source in ('ai','system','proctor','student','teacher'));

-- 4. `created_at` becomes timestamptz (keeps the instant: values are assumed
--    UTC, which is how Supabase writes them).
update public.violation_events set created_at = now() where created_at is null;
alter table public.violation_events alter column created_at drop default;
alter table public.violation_events alter column created_at type timestamptz
  using created_at at time zone 'UTC';
alter table public.violation_events alter column created_at set not null;
alter table public.violation_events alter column created_at set default now();

-- 5. Indexes the consoles rely on (idempotent).
create index if not exists violation_events_exam_idx
  on public.violation_events (exam_id, created_at desc);
create index if not exists violation_events_attempt_idx
  on public.violation_events (attempt_id);
create index if not exists violation_events_student_idx
  on public.violation_events (student_id);
