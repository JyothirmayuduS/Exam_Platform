-- Close remaining privilege holes found by the security advisor pass.

-- Staff rows: "ep teachers self" was FOR ALL, so any signed-in user (including
-- a student) could INSERT a teachers row with their own auth_id and become
-- staff, and a proctor could UPDATE their own role to 'teacher'.
drop policy if exists "ep teachers self" on public.teachers;
create policy "ep teachers self read" on public.teachers
  for select to authenticated using (auth_id = auth.uid());
create policy "ep teachers self update" on public.teachers
  for update to authenticated using (auth_id = auth.uid()) with check (auth_id = auth.uid());
revoke insert, update, delete on public.teachers from anon, authenticated;
grant update (name, full_name, department, designation, email, settings) on public.teachers to authenticated;

-- Answer-sheet uploads: drop the demo-era world-readable policy; staff read
-- through their own policy, students keep "view their own submissions".
drop policy if exists "Allow anonymous reads for demo" on public.question_submissions;
drop policy if exists "ep qsub staff read" on public.question_submissions;
create policy "ep qsub staff read" on public.question_submissions
  for select to authenticated using (auth_is_staff());

-- Legacy tables: open policies granted to every role (including anon).
-- Server code writes these with the service role, which bypasses RLS.
drop policy if exists "exam_enrollments_admin_all" on public.exam_enrollments;
drop policy if exists "appeal_requests_system_insert" on public.appeal_requests;
drop policy if exists "recordings_system_insert" on public.recordings;
drop policy if exists "exam_access_logs_system_insert" on public.exam_access_logs;
drop policy if exists "notifications_system_insert" on public.notifications;
drop policy if exists "comments_system_insert" on public.comments;

-- Materialized views cannot carry RLS; keep item stats off the anonymous API.
revoke select on public.item_analysis from anon;

alter function public.next_question_id(text) set search_path = public;
alter function public.questions_autoid() set search_path = public;
