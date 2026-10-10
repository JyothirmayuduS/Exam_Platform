-- public.exam_enrollments exists live but no migration created it;
-- 20260903175500_fix_exams_rls_recursion reads it. Definition matches live.
create table if not exists public.exam_enrollments (
  id uuid primary key default gen_random_uuid(),
  exam_id text not null,
  student_id uuid not null,
  enrolled_at timestamp without time zone default now(),
  access_status text default 'allowed',
  invited_by uuid,
  created_at timestamp without time zone default now(),
  reminder_email_sent boolean default false,
  countdown_notified boolean default false,
  constraint exam_enrollments_exam_fk foreign key (exam_id) references public.exams(id) on delete cascade,
  constraint exam_enrollments_unique unique (exam_id, student_id)
);
create index if not exists idx_exam_enrollments_exam_id on public.exam_enrollments (exam_id);
create index if not exists idx_exam_enrollments_student_id on public.exam_enrollments (student_id);
create index if not exists idx_exam_enrollments_access_status on public.exam_enrollments (access_status);
alter table public.exam_enrollments enable row level security;
