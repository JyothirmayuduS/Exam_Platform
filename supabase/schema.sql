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
  batch       text not null,                     -- e.g. 'CSE · Sem III'
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

-- M:N pool membership: a bank question can belong to many exams. A question
-- whose exam_id is set also counts as part of that exam's pool (legacy rows).
create table if not exists public.exam_questions (
  exam_id     text not null references public.exams(id) on delete cascade,
  question_id text not null references public.questions(id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (exam_id, question_id)
);
create index if not exists exam_questions_question_idx
  on public.exam_questions (question_id, exam_id);

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
                    check (state in ('not_started','in_progress','submitted','paused')),
  answered        int not null default 0,
  total           int not null default 0,
  minutes_used    int not null default 0,
  score           numeric,
  started_at      timestamptz,
  submitted_at    timestamptz,
  auto_saved_at   timestamptz,
  answers         jsonb not null default '{}'::jsonb,
  extra_minutes   int not null default 0,  -- proctor-granted time extension
  paper           jsonb not null default '[]'::jsonb,  -- per-student question snapshot
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

-- One row per proctoring flag / proctor action (warning, pause, escalation) /
-- AI detection. Read by the teacher + proctor consoles, evaluation review,
-- PDF/CSV exports and the recording timeline with its red violation markers.
create table if not exists public.violation_events (
  id              uuid primary key default gen_random_uuid(),
  exam_id         text references public.exams(id) on delete cascade,
  attempt_id      uuid references public.attempts(id) on delete cascade,
  student_id      uuid references public.students(id) on delete cascade,
  violation_type  text not null,
  severity        text not null default 'warning'
                    check (severity in ('info','warning','high','critical')),
  description     text not null default '',
  source          text not null default 'system'
                    check (source in ('ai','system','proctor','student','teacher')),
  offset_seconds  int,   -- seconds from attempt start -> seek-bar marker
  snapshot_key    text,  -- R2 key of the flagged frame when captured
  created_at      timestamptz not null default now()
);

create index if not exists violation_events_exam_idx
  on public.violation_events (exam_id, created_at desc);
create index if not exists violation_events_attempt_idx
  on public.violation_events (attempt_id);
create index if not exists violation_events_student_idx
  on public.violation_events (student_id);

-- Proctor chat / broadcast messages (seen by proctors + students).
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
create index if not exists proctor_messages_exam_idx
  on public.proctor_messages (exam_id, created_at asc);

-- Faculty assigned to monitor an exam (Assign Proctors modal).
create table if not exists public.proctor_assignments (
  id            uuid primary key default gen_random_uuid(),
  exam_id       text references public.exams(id) on delete cascade,
  assignee_name text not null,
  assignee_role text not null default 'proctor'
                  check (assignee_role in ('proctor','teacher','ta')),
  assignee_id   uuid references public.teachers(id) on delete set null,
  email         text,
  created_at    timestamptz not null default now(),
  unique (exam_id, assignee_name)
);
create index if not exists proctor_assignments_assignee_idx
  on public.proctor_assignments (assignee_id, exam_id);

-- Grading delegation: teacher assigns submitted reports to evaluators
-- (per-attempt rows + exam-level allocation metadata for the dashboard).
create table if not exists public.grading_delegations (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid references public.attempts(id) on delete cascade,
  delegate_name text not null,
  assigned_by   text,
  exam_id       text references public.exams(id) on delete cascade,
  delegate_id   uuid,
  due_date      timestamptz,
  report_count  int not null default 0,
  created_at    timestamptz not null default now(),
  unique (attempt_id, delegate_name)
);
create index if not exists grading_delegations_attempt_idx
  on public.grading_delegations (attempt_id);
create index if not exists grading_delegations_exam_idx
  on public.grading_delegations (exam_id);

alter table public.grading_delegations enable row level security;

create policy "teachers manage grading delegations" on public.grading_delegations
  for all using (
    attempt_id in (select id from public.attempts
                   where exam_id in (select id from public.exams where created_by = auth.uid()))
  ) with check (
    attempt_id in (select id from public.attempts
                   where exam_id in (select id from public.exams where created_by = auth.uid()))
  );

-- Demo / anon-key prototype (mirrors demo-policies.sql).
drop policy if exists "demo grading delegation all" on public.grading_delegations;
create policy "demo grading delegation all" on public.grading_delegations
  for all using (true) with check (true);

-- Teacher grading comments (inline text + voice notes) per attempt/question.
create table if not exists public.grading_comments (
  id          uuid primary key default gen_random_uuid(),
  attempt_id  uuid references public.attempts(id) on delete cascade,
  question_id text,
  comment     text not null,
  voice_key   text,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists grading_comments_attempt_idx
  on public.grading_comments (attempt_id, created_at asc);

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
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'violation_events') then
    alter publication supabase_realtime add table public.violation_events;
  end if;
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
alter table public.students         enable row level security;
alter table public.exams            enable row level security;
alter table public.questions        enable row level security;
alter table public.enrollments      enable row level security;
alter table public.attempts         enable row level security;
alter table public.proctor_sessions enable row level security;
alter table public.violation_events enable row level security;
alter table public.proctor_messages    enable row level security;
alter table public.proctor_assignments enable row level security;
alter table public.grading_comments    enable row level security;
alter table public.exam_questions      enable row level security;

-- Students can read their own profile.
create policy "students read self" on public.students
  for select using (auth.uid() = auth_id);

-- Anyone signed in can read exams that are live (published/scheduled) for their
-- batch. Draft exams stay hidden from students.
create policy "read live exams" on public.exams
  for select using (
    status <> 'draft'
    and batch in (select batch from public.students where auth_id = auth.uid())
  );

-- Teachers (authenticated) manage exams they create.
create policy "teachers manage own exams" on public.exams
  for all using (auth.uid() = created_by) with check (auth.uid() = created_by);

-- Teachers manage which questions sit in the pool of their own exams.
create policy "teachers manage exam pools" on public.exam_questions
  for all using (
    exists (select 1 from public.exams x
            where x.id = exam_questions.exam_id and x.created_by = auth.uid())
  ) with check (
    exists (select 1 from public.exams x
            where x.id = exam_questions.exam_id and x.created_by = auth.uid())
  );

-- Students read the question sets of exams they can see.
create policy "read exam pools of visible exams" on public.exam_questions
  for select using (
    exists (select 1 from public.exams x
            where x.id = exam_questions.exam_id and x.status <> 'draft')
  );

-- Demo / anon-key prototype (mirrors demo-policies.sql).
drop policy if exists "demo exam pool all" on public.exam_questions;
create policy "demo exam pool all" on public.exam_questions
  for all using (true) with check (true);

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

-- Teachers / proctors acting on their own exams may log and read violations.
create policy "teachers own exam violations" on public.violation_events
  for all using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  ) with check (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );

-- Students may log their own AI / system flags and read them on their result page.
create policy "students own violations" on public.violation_events
  for all using (
    student_id in (select id from public.students where auth_id = auth.uid())
  ) with check (
    student_id in (select id from public.students where auth_id = auth.uid())
  );

-- Teachers / proctors on their own exams manage chat + assignments; students
-- may read broadcasts for exams they can see.
create policy "teachers own exam messages" on public.proctor_messages
  for all using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  ) with check (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );
create policy "students read exam messages" on public.proctor_messages
  for select using (
    exam_id in (select id from public.exams
                where status <> 'draft'
                  and batch in (select batch from public.students where auth_id = auth.uid()))
  );
create policy "teachers own exam assignments" on public.proctor_assignments
  for all using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  ) with check (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );
create policy "teachers manage grading comments" on public.grading_comments
  for all using (
    attempt_id in (select id from public.attempts
                   where exam_id in (select id from public.exams where created_by = auth.uid()))
  ) with check (
    attempt_id in (select id from public.attempts
                   where exam_id in (select id from public.exams where created_by = auth.uid()))
  );

-- Proctors assigned to an exam can read it and monitor attempts/violations/
-- messages, so the proctor console is fully DB-backed (see migration
-- 20260906000004_proctor_assignments_contacts.sql).
create policy "proctors read own assignments" on public.proctor_assignments
  for select using (
    assignee_id in (select id from public.teachers where auth_id = auth.uid())
  );
create policy "proctors read assigned exams" on public.exams
  for select using (
    id in (select exam_id from public.proctor_assignments
           where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  );
create policy "proctors read assigned attempts" on public.attempts
  for select using (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  );
create policy "proctors manage assigned violations" on public.violation_events
  for all using (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  ) with check (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  );
create policy "proctors manage assigned messages" on public.proctor_messages
  for all using (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  ) with check (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  );

-- NOTE: For the prototype demo you may temporarily relax the exams SELECT policy
-- to `using (status <> 'draft')` if you have not seeded the students table yet.
-- Run demo-policies.sql (or the "demo violation all" policy in
-- supabase/migrations/20260906000000_violation_events.sql) to open access for
-- the anon-key prototype.
