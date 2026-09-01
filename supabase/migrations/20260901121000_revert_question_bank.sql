-- 1. Add exam_id back to questions
alter table public.questions add column if not exists exam_id text references public.exams(id) on delete cascade;

-- 2. Migrate data back from exam_question_links (if any)
update public.questions q
set exam_id = l.exam_id
from public.exam_question_links l
where q.id = l.question_id;

-- 3. Revert RLS policies on questions FIRST to avoid dependency errors
drop policy if exists "read questions via exam_question_links" on public.questions;
drop policy if exists "teachers manage own questions" on public.questions;

-- 4. Drop new fields from questions
alter table public.questions 
  drop column if exists status,
  drop column if exists tags,
  drop column if exists topic,
  drop column if exists version,
  drop column if exists parent_id,
  drop column if exists created_by;

-- 5. Drop the join table
drop table if exists public.exam_question_links cascade;

-- 6. Recreate old policies
create policy "read questions of visible exams" on public.questions
  for select using (
    exam_id in (select id from public.exams where status <> 'draft')
  );

