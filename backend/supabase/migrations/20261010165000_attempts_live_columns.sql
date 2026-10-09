-- attempts columns the live database has but no earlier migration creates.
-- 20261010170000_hide_unreleased_scores grants on them by name, so a database
-- built from the migrations alone needs them first. Types match live.
alter table public.attempts
  add column if not exists status text default 'in_progress',
  add column if not exists total_time_spent_seconds integer,
  add column if not exists percentage numeric(5,2),
  add column if not exists passed boolean,
  add column if not exists rank integer,
  add column if not exists device_info jsonb,
  add column if not exists last_saved_at timestamp without time zone,
  add column if not exists auto_submitted boolean default false,
  add column if not exists created_at timestamp without time zone default now(),
  add column if not exists updated_at timestamp without time zone default now();
