-- Vignan OS — Lockdown Exam Platform
-- Supabase schema. Run this in the Supabase SQL editor (or `supabase db push`).
--
-- Security model: the frontend uses ONLY the anon key. Row Level Security below
-- decides who can read/write what. The service_role key and DB password stay on
-- the server (Edge Functions) and must never reach the browser.

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.students (
  id          uuid primary key default gen_random_uuid(),
  auth_id     uuid unique,                       -- links to auth.users when signed in
  roll        text unique not null,
  full_name   text not null,
  email       text unique not null,
  branch      text not null,                     -- e.g. 'CSE', 'ECE'
  section     text not null,                     -- e.g. 'A', 'B'
  phone       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.exams (
  id               text primary key,             -- e.g. 'EXAM-2026-014'
  name             text not null,
  batch            text not null,
  mode             text not null default 'lockdown'
                     check (mode in ('practice','lockdown')),
  status           text not null default 'draft'
                     check (status in ('draft','published','scheduled')),
  duration_minutes int  not null default 45,
  per_student      int  not null default 5,
  pool_count       int  not null default 0,
  total_marks      int  not null default 0,
  scheduled_at     timestamptz,
  join_link        text,
  settings         jsonb not null default '{}'::jsonb,
  created_by       uuid,                          -- teacher auth id
  created_at       timestamptz not null default now()
);

create table if not exists public.questions (
  id          text primary key,                   -- e.g. 'Q-1042'
  exam_id     text references public.exams(id) on delete cascade,
  title       text not null,
  type        text not null,
  unit        text,
  difficulty  text,
  marks       int not null default 1,
  options     jsonb,
  answer      text,
  created_at  timestamptz not null default now()
);

create table if not exists public.enrollments (
  exam_id     text references public.exams(id) on delete cascade,
  student_id  uuid references public.students(id) on delete cascade,
  primary key (exam_id, student_id)
);

create table if not exists public.attempts (
  id              uuid primary key default gen_random_uuid(),
  exam_id         text references public.exams(id) on delete cascade,
  student_id      uuid references public.students(id) on delete cascade,
  state           text not null default 'not_started'
                    check (state in ('not_started','in_progress','submitted')),
  answered        int not null default 0,
  total           int not null default 0,
  minutes_used    int not null default 0,
  score           numeric,
  started_at      timestamptz,
  submitted_at    timestamptz,
  auto_saved_at   timestamptz,
  answers         jsonb not null default '{}'::jsonb,
  unique (exam_id, student_id)
);

create table if not exists public.proctor_sessions (
  id              uuid primary key default gen_random_uuid(),
  attempt_id      uuid references public.attempts(id) on delete cascade,
  livekit_room    text not null,
  livekit_identity text not null,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  flags           jsonb not null default '[]'::jsonb
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime: broadcast row changes so students see published exams instantly
-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotent: only add each table to the realtime publication if not already a
-- member (re-running the raw `alter ... add table` errors with 42710).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'exams') then
    alter publication supabase_realtime add table public.exams;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attempts') then
    alter publication supabase_realtime add table public.attempts;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'proctor_sessions') then
    alter publication supabase_realtime add table public.proctor_sessions;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.students         enable row level security;
alter table public.exams            enable row level security;
alter table public.questions        enable row level security;
alter table public.enrollments      enable row level security;
alter table public.attempts         enable row level security;
alter table public.proctor_sessions enable row level security;

-- Students can read their own profile.
create policy "students read self" on public.students
  for select using (auth.uid() = auth_id);

-- Anyone signed in can read exams that are live (published/scheduled) if they are enrolled
create policy "read live exams" on public.exams
  for select using (
    status <> 'draft'
    and id in (select exam_id from public.enrollments where student_id in (select id from public.students where auth_id = auth.uid()))
  );

-- Teachers (authenticated) manage exams they create.
create policy "teachers manage own exams" on public.exams
  for all using (auth.uid() = created_by) with check (auth.uid() = created_by);

-- Students read questions for exams they can see.
create policy "read questions of visible exams" on public.questions
  for select using (
    exam_id in (select id from public.exams where status <> 'draft')
  );

-- A student reads/writes only their own attempt.
create policy "own attempt read"  on public.attempts
  for select using (
    student_id in (select id from public.students where auth_id = auth.uid())
  );
create policy "own attempt write" on public.attempts
  for all using (
    student_id in (select id from public.students where auth_id = auth.uid())
  ) with check (
    student_id in (select id from public.students where auth_id = auth.uid())
  );

-- NOTE: For the prototype demo you may temporarily relax the exams SELECT policy
-- to `using (status <> 'draft')` if you have not seeded the students table yet.
