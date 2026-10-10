-- Exam data is visible only to the exam's owner, admins, and teachers assigned
-- to it (delegates). Staff with the proctor role see no exam data, even when
-- assigned.

create or replace function public.staff_exam_ids()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from public.exams e
  where e.created_by = auth.uid() and public.auth_is_teacher()
  union
  select pa.exam_id from public.proctor_assignments pa
  join public.teachers t on t.id = pa.assignee_id
  where t.auth_id = auth.uid() and t.role = 'teacher' and pa.exam_id is not null;
$$;

revoke all on function public.staff_exam_ids() from public, anon;
grant execute on function public.staff_exam_ids() to authenticated, service_role;

notify pgrst, 'reload schema';
