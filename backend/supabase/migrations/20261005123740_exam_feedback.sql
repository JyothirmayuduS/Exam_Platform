-- Post-exam feedback from candidates (skipped when the exam sets skipFeedback).
create table if not exists public.exam_feedback (
  id uuid primary key default gen_random_uuid(),
  exam_id text not null,
  attempt_id uuid references public.attempts(id) on delete set null,
  student_id uuid not null references public.students(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text check (char_length(comment) <= 2000),
  created_at timestamptz not null default now(),
  unique (exam_id, student_id)
);

create index if not exists exam_feedback_exam_idx on public.exam_feedback (exam_id);

alter table public.exam_feedback enable row level security;

drop policy if exists "students write own feedback" on public.exam_feedback;
create policy "students write own feedback" on public.exam_feedback
  for insert to authenticated
  with check (student_id in (select id from public.students where auth_id = auth.uid()));

drop policy if exists "students read own feedback" on public.exam_feedback;
create policy "students read own feedback" on public.exam_feedback
  for select to authenticated
  using (
    student_id in (select id from public.students where auth_id = auth.uid())
    or exists (select 1 from public.teachers t where t.auth_id = auth.uid())
  );
