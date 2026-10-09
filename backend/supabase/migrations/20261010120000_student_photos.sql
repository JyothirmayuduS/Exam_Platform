-- Registration photos. Each student takes one webcam photo before their first
-- exam; an admin can clear it so the student retakes it. Photos live in the
-- private student-photos bucket. Only the registration-photo and
-- admin-dashboard edge functions (service role) write rows or files; browsers
-- can read their own row, staff can read every row, and nobody reads the
-- files directly.

create table if not exists public.student_photos (
  student_id   uuid primary key references public.students(id) on delete cascade,
  storage_path text not null,
  bytes        integer not null check (bytes > 0),
  captured_at  timestamptz not null default now()
);

alter table public.student_photos enable row level security;
revoke all on public.student_photos from anon, authenticated;
grant select on public.student_photos to authenticated;

drop policy if exists "student photos own read" on public.student_photos;
create policy "student photos own read" on public.student_photos
  for select to authenticated
  using (student_id in (select s.id from public.students s where s.auth_id = (select auth.uid())));

drop policy if exists "student photos staff read" on public.student_photos;
create policy "student photos staff read" on public.student_photos
  for select to authenticated using ((select public.auth_is_staff()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-photos', 'student-photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];
