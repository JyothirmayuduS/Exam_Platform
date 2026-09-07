-- H2: make the exam-records artifact bucket PRIVATE and scope reads.
-- Recordings, screenshots, subjective PDFs and AI evidence live here. They must
-- never be world-readable via a public URL. The app now mints short-lived
-- SIGNED urls (createSignedUrl / R2 presign) for every read; these policies let
-- a student read only their own folder and staff read everything.
--
-- Object key layout (see store-artifact / mobile-upload):
--   <examId>/<studentId>/<kind>/<name>
-- so split_part(name, '/', 2) is the owning student id.

-- Ensure the bucket exists and is private.
insert into storage.buckets (id, name, public)
values ('exam-records', 'exam-records', false)
on conflict (id) do update set public = false;

-- Drop any prior policies so this migration is re-runnable.
drop policy if exists "exam-records student read own"  on storage.objects;
drop policy if exists "exam-records student write own" on storage.objects;
drop policy if exists "exam-records staff all"         on storage.objects;

-- Students: read + write ONLY within their own <exam>/<studentId>/… prefix.
create policy "exam-records student read own" on storage.objects
  for select using (
    bucket_id = 'exam-records'
    and split_part(name, '/', 2) = public.current_student_id()::text
  );

create policy "exam-records student write own" on storage.objects
  for insert with check (
    bucket_id = 'exam-records'
    and split_part(name, '/', 2) = public.current_student_id()::text
  );

-- Staff: full access to the whole bucket.
create policy "exam-records staff all" on storage.objects
  for all using (
    bucket_id = 'exam-records' and public.auth_is_staff()
  ) with check (
    bucket_id = 'exam-records' and public.auth_is_staff()
  );
