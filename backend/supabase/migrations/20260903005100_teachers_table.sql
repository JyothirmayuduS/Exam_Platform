-- 20260903005200_mobile_upload's policies read public.teachers, which
-- 20260903100000_auth_tables creates later. Same definition, created first.
create table if not exists public.teachers (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid unique not null,
  name text not null,
  email text unique not null,
  role text not null default 'teacher' check (role in ('teacher', 'proctor')),
  created_at timestamptz not null default now()
);
