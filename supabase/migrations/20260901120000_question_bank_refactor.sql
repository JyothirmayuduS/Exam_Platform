-- 1. Create the many-to-many relationship table for exams and questions
create table if not exists public.exam_question_links (
  exam_id     text references public.exams(id) on delete cascade,
  question_id text references public.questions(id) on delete cascade,
  display_order int not null default 0,
  marks_override int,
  primary key (exam_id, question_id)
);

-- 2. Migrate existing question links to the new table
insert into public.exam_question_links (exam_id, question_id)
select exam_id, id from public.questions where exam_id is not null
on conflict do nothing;

-- 3. Update questions RLS policy BEFORE dropping the column
drop policy if exists "read questions of visible exams" on public.questions;

-- 4. Drop the exam_id column from questions to decouple them
alter table public.questions drop column if exists exam_id;

-- 5. Add new fields to support Question Bank features
alter table public.questions
add column if not exists status text not null default 'draft' check (status in ('draft', 'approved')),
add column if not exists tags text[] not null default '{}'::text[],
add column if not exists topic text,
add column if not exists version int not null default 1,
add column if not exists parent_id text references public.questions(id) on delete set null,
add column if not exists created_by uuid; -- teacher auth id

-- 6. Enable RLS on new table
alter table public.exam_question_links enable row level security;

create policy "read exam_question_links of visible exams" on public.exam_question_links
  for select using (
    exam_id in (select id from public.exams where status <> 'draft')
  );

create policy "teachers manage own exam_question_links" on public.exam_question_links
  for all using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );

-- 7. Create new questions RLS policy
create policy "read questions via exam_question_links" on public.questions
  for select using (
    id in (select question_id from public.exam_question_links where exam_id in (select id from public.exams where status <> 'draft'))
    or created_by = auth.uid()
  );

create policy "teachers manage own questions" on public.questions
  for all using (created_by = auth.uid()) with check (created_by = auth.uid());

-- 8. Create storage bucket for question media
insert into storage.buckets (id, name, public) 
values ('question-media', 'question-media', true)
on conflict (id) do nothing;

create policy "public read question media" on storage.objects
  for select using ( bucket_id = 'question-media' );
  
create policy "teachers write question media" on storage.objects
  for insert with check ( bucket_id = 'question-media' and auth.role() = 'authenticated' );
