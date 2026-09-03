-- Allow teachers to read and update attempts for exams they created
create policy "teachers read attempts for own exams" on public.attempts
  for select using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );

create policy "teachers update attempts for own exams" on public.attempts
  for update using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );
