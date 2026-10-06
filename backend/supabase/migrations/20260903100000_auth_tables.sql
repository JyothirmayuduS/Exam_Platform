-- Create teachers table
create table if not exists public.teachers (
  id uuid primary key default gen_random_uuid(),
  auth_id uuid unique not null,
  name text not null,
  email text unique not null,
  role text not null default 'teacher' check (role in ('teacher', 'proctor')),
  created_at timestamptz not null default now()
);

-- Enable RLS
alter table public.teachers enable row level security;

-- Policies for teachers
create policy "Teachers can read their own profile" on public.teachers
  for select using (auth.uid() = auth_id);

-- Wait, teachers also need to read their own profile to verify role, and admins might need to read all.
-- For now, self read is enough since role check is auth_id = authUser.id
