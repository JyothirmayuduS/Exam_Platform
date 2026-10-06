-- Make violation_events insert-only for students.
-- Students may INSERT their own violations but may not UPDATE or DELETE.
-- Staff (teachers/proctors) retain full control.
-- Run AFTER 20260910000006_auth_provision_and_production_rls.sql so the
-- production "ep violation student" policy is replaced.

alter table public.violation_events enable row level security;

drop policy if exists "ep violation student" on public.violation_events;
drop policy if exists "ep violation staff" on public.violation_events;

-- Students: INSERT only, and only their own rows.
create policy "ep violation student insert" on public.violation_events
  for insert
  with check (student_id = public.current_student_id());

create policy "ep violation student read" on public.violation_events
  for select
  using (student_id = public.current_student_id());

-- Staff: full access.
create policy "ep violation staff" on public.violation_events
  for all
  using (public.auth_is_staff())
  with check (public.auth_is_staff());
