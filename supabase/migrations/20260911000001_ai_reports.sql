-- AI proctoring integrity reports: one per attempt, produced by the
-- proctor-ai-report Edge Function (LLM summary over the violation timeline).
-- Staff manage; students read their own report row.

create table if not exists public.ai_reports (
  attempt_id   uuid primary key references public.attempts (id) on delete cascade,
  exam_id      text not null,
  student_id   uuid not null references public.students (id) on delete cascade,
  risk_score   integer not null default 0 check (risk_score between 0 and 100),
  verdict      text not null default 'review' check (verdict in ('clean', 'review', 'flagged')),
  summary      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.ai_reports enable row level security;

drop policy if exists "ep aireports staff" on public.ai_reports;
drop policy if exists "ep aireports student" on public.ai_reports;

create policy "ep aireports staff" on public.ai_reports
  for all using (public.auth_is_staff()) with check (public.auth_is_staff());

create policy "ep aireports student" on public.ai_reports
  for select using (student_id = public.current_student_id());
