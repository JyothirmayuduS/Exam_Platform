-- Candidates can read evaluator comments on their own attempts (result page).
drop policy if exists "students read own grading comments" on public.grading_comments;
create policy "students read own grading comments" on public.grading_comments
  for select to authenticated
  using (
    attempt_id in (
      select a.id from public.attempts a
      join public.students s on s.id = a.student_id
      where s.auth_id = auth.uid()
    )
  );
