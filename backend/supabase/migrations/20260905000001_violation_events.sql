-- Violation events: every proctoring flag, proctor action (warning / pause /
-- escalation), and AI detection gets one row. The proctor consoles (teacher +
-- proctor grid), evaluation review, PDF/CSV exports and the recording timeline
-- all read from this table, so a missing table made every "send warning /
-- pause / escalate" button and every violation list silently do nothing.

-- ─────────────────────────────────────────────────────────────────────────────
-- Table
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.violation_events (
  id             uuid primary key default gen_random_uuid(),
  exam_id        text references public.exams(id) on delete cascade,
  attempt_id     uuid references public.attempts(id) on delete cascade,  -- null when the candidate hasn't started yet
  student_id     uuid references public.students(id) on delete cascade,
  violation_type text not null,
  severity       text not null default 'warning'
                   check (severity in ('info','warning','high','critical')),
  description    text not null default '',
  source         text not null default 'system'
                   check (source in ('ai','system','proctor','student')),
  -- Seconds from the attempt's started_at — used to draw the red violation
  -- markers on the recording seek bar and to timestamp the report PDF.
  offset_seconds int,
  snapshot_key   text,  -- R2 object key of the flagged frame, when captured
  created_at     timestamptz not null default now()
);

create index if not exists violation_events_exam_idx
  on public.violation_events (exam_id, created_at desc);
create index if not exists violation_events_attempt_idx
  on public.violation_events (attempt_id);
create index if not exists violation_events_student_idx
  on public.violation_events (student_id);

-- Allow proctors to pause a candidate: a paused attempt stops counting down
-- until the proctor resumes it.
alter table public.attempts drop constraint if exists attempts_state_check;
alter table public.attempts add constraint attempts_state_check
  check (state in ('not_started','in_progress','submitted','paused'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime: broadcast new/updated violations so teacher + proctor consoles
-- refresh the instant a warning or flag is raised.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'violation_events') then
    alter publication supabase_realtime add table public.violation_events;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.violation_events enable row level security;

-- Students may log their own flags (AI / system / tab-switch detections) and
-- read them back on their result page.
drop policy if exists "students own violations" on public.violation_events;
create policy "students own violations" on public.violation_events
  for all using (
    student_id in (select id from public.students where auth_id = auth.uid())
  ) with check (
    student_id in (select id from public.students where auth_id = auth.uid())
  );

-- Teachers / proctors acting on their own exams may log and read violations.
drop policy if exists "teachers own exam violations" on public.violation_events;
create policy "teachers own exam violations" on public.violation_events
  for all using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  ) with check (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );

-- Demo / anon-key prototype: mirror demo-policies.sql. Kept here so a fresh
-- project that only runs migrations (schema.sql's auth policies are also
-- present) still works without auth.
drop policy if exists "demo violation all" on public.violation_events;
create policy "demo violation all" on public.violation_events
  for all using (true) with check (true);
