-- Exam pool join: a question can now belong to MANY exams (Mettl-style: one
-- bank question is reusable across tests). The old questions.exam_id stays as
-- the "owning" exam used by the question editor / bank label, but every exam's
-- actual pool is the union of its exam_questions rows plus any questions whose
-- exam_id points at it (legacy rows created before this migration).
--
--   questions.created under exam X  ->  exam_id = X (kept)
--   teacher adds bank question to Y ->  exam_questions row (X,Y)
--   removing from a pool            ->  delete its exam_questions row only
--
-- Paper building / counts read through the union, so nothing else changes.

-- Some projects already carry a table named exam_questions with a DIFFERENT
-- shape (an older prototype). `create table if not exists` would silently skip
-- it and every later statement would fail on the missing columns. If the
-- existing table isn't our shape (no question_id), park it aside under a
-- timestamped name — its rows are preserved, never deleted — then create the
-- real join table below.
do $$
declare park text;
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'exam_questions')
     and not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'exam_questions'
                       and column_name = 'question_id') then
    park := 'exam_questions_legacy_' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
    execute format('alter table public.exam_questions rename to %I', park);
  end if;
end $$;

create table if not exists public.exam_questions (
  exam_id     text not null references public.exams(id) on delete cascade,
  question_id text not null references public.questions(id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (exam_id, question_id)
);
create index if not exists exam_questions_question_idx
  on public.exam_questions (question_id, exam_id);

-- Backfill: existing per-exam questions become join rows too.
insert into public.exam_questions (exam_id, question_id)
select e.exam_id, e.id
from public.questions e
where e.exam_id is not null
on conflict (exam_id, question_id) do nothing;

-- ── RLS (auth-scoped; demo-policies.sql reopens for the anon-key prototype) ──
alter table public.exam_questions enable row level security;

drop policy if exists "teachers manage exam pools" on public.exam_questions;
create policy "teachers manage exam pools"
  on public.exam_questions
  for all
  using (
    exists (
      select 1 from public.exams x
      where x.id = exam_questions.exam_id
        and (x.created_by is null or x.created_by = auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.exams x
      where x.id = exam_questions.exam_id
        and (x.created_by is null or x.created_by = auth.uid())
    )
  );

drop policy if exists "read questions of visible exams" on public.exam_questions;
create policy "read questions of visible exams"
  on public.exam_questions
  for select
  using (
    exists (
      select 1 from public.exams x
      where x.id = exam_questions.exam_id
        and x.status <> 'draft'
    )
  );
