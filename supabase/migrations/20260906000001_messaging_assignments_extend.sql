-- Real backend for the previously-dead proctor buttons:
--   • Proctor chat / broadcast messages (proctor_messages)
--   • Assign proctors modal (proctor_assignments)
--   • Teacher evaluation inline + voice comments (grading_comments)
--   • Extend (+5m) per candidate (attempts.extra_minutes — the student's live
--     timer adds these seconds without resetting)

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.proctor_messages (
  id          uuid primary key default gen_random_uuid(),
  exam_id     text references public.exams(id) on delete cascade,
  sender      text not null default 'Proctor',
  sender_role text not null default 'proctor'
                check (sender_role in ('proctor','teacher','system')),
  body        text not null,
  kind        text not null default 'message'
                check (kind in ('message','broadcast')),
  created_at  timestamptz not null default now()
);

-- A legacy proctor_messages table (created before exam_id/sender_role/kind were
-- added) may already exist on the project. `create table if not exists` skips
-- it in that case, so upgrade the legacy shape instead of assuming the columns
-- are present.
alter table public.proctor_messages add column if not exists
  exam_id text references public.exams(id) on delete cascade;
alter table public.proctor_messages add column if not exists
  sender_role text not null default 'proctor';
alter table public.proctor_messages add column if not exists
  kind text not null default 'message';

create index if not exists proctor_messages_exam_idx
  on public.proctor_messages (exam_id, created_at asc);

create table if not exists public.proctor_assignments (
  id            uuid primary key default gen_random_uuid(),
  exam_id       text references public.exams(id) on delete cascade,
  assignee_name text not null,
  assignee_role text not null default 'proctor'
                  check (assignee_role in ('proctor','teacher','ta')),
  created_at    timestamptz not null default now(),
  unique (exam_id, assignee_name)
);

create table if not exists public.grading_comments (
  id          uuid primary key default gen_random_uuid(),
  attempt_id  uuid references public.attempts(id) on delete cascade,
  question_id text,
  comment     text not null,
  voice_key   text,           -- storage key when this is a recorded voice note
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists grading_comments_attempt_idx
  on public.grading_comments (attempt_id, created_at asc);

-- Per-candidate extra minutes granted by a proctor. The student timer reads the
-- attempts row and adds the delta live (no countdown reset).
alter table public.attempts add column if not exists extra_minutes int not null default 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime: broadcast new proctor messages so consoles + students update live.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'proctor_messages') then
    alter publication supabase_realtime add table public.proctor_messages;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'proctor_assignments') then
    alter publication supabase_realtime add table public.proctor_assignments;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.proctor_messages     enable row level security;
alter table public.proctor_assignments  enable row level security;
alter table public.grading_comments     enable row level security;

-- Teachers / proctors acting on their own exams manage messages + assignments.
drop policy if exists "teachers own exam messages" on public.proctor_messages;
create policy "teachers own exam messages" on public.proctor_messages
  for all using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  ) with check (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );

-- Students may READ messages/broadcasts for exams they can see (they never write).
drop policy if exists "students read exam messages" on public.proctor_messages;
create policy "students read exam messages" on public.proctor_messages
  for select using (
    exam_id in (select id from public.exams
                where status <> 'draft'
                  and batch in (select batch from public.students where auth_id = auth.uid()))
  );

drop policy if exists "teachers own exam assignments" on public.proctor_assignments;
create policy "teachers own exam assignments" on public.proctor_assignments
  for all using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  ) with check (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );

drop policy if exists "teachers manage grading comments" on public.grading_comments;
create policy "teachers manage grading comments" on public.grading_comments
  for all using (
    attempt_id in (select id from public.attempts
                   where exam_id in (select id from public.exams where created_by = auth.uid()))
  ) with check (
    attempt_id in (select id from public.attempts
                   where exam_id in (select id from public.exams where created_by = auth.uid()))
  );

-- Demo / anon-key prototype (mirrors demo-policies.sql).
drop policy if exists "demo messages all"     on public.proctor_messages;
drop policy if exists "demo assignments all"  on public.proctor_assignments;
drop policy if exists "demo grading all"      on public.grading_comments;
create policy "demo messages all"     on public.proctor_messages    for all using (true) with check (true);
create policy "demo assignments all"  on public.proctor_assignments for all using (true) with check (true);
create policy "demo grading all"      on public.grading_comments    for all using (true) with check (true);