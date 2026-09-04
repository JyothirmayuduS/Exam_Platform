-- Grading delegation: a teacher assigns a colleague to cross-check marks for
-- specific candidate attempts. Rows are readable/writable by the owning teacher
-- (and by the demo anon policy below).

create table if not exists public.grading_delegations (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid references public.attempts(id) on delete cascade,
  delegate_name text not null,
  assigned_by   text,
  created_at    timestamptz not null default now(),
  unique (attempt_id, delegate_name)
);
create index if not exists grading_delegations_attempt_idx
  on public.grading_delegations (attempt_id);

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