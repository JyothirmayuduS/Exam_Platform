-- Proctors see AI reports created from 13:30 IST on 10 Oct 2026; proctor-ai-report matches.
-- The proctor and evaluator assignment emails record each send here so the
-- edge functions can limit how often one caller emails staff about one exam.

drop policy if exists "ep aireports proctor read" on public.ai_reports;
create policy "ep aireports proctor read" on public.ai_reports
  for select to authenticated
  using (exam_id in (select public.proctor_exam_ids())
         and created_at >= timestamptz '2026-10-10 13:30:00+05:30'
         and not public.ai_report_has_marks(summary::jsonb));

create table if not exists public.assignment_email_log (
  id bigint generated always as identity primary key,
  caller_id uuid not null,
  exam_id text not null references public.exams(id) on delete cascade,
  kind text not null check (kind in ('proctor', 'evaluator')),
  created_at timestamptz not null default now()
);
create index if not exists assignment_email_log_recent
  on public.assignment_email_log (caller_id, exam_id, kind, created_at desc);

-- Only the edge functions (service role) read or write it.
alter table public.assignment_email_log enable row level security;
revoke all on public.assignment_email_log from public, anon, authenticated;

notify pgrst, 'reload schema';
