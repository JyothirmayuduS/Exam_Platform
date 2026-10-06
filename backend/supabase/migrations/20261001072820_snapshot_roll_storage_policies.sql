-- Snapshot clients use <exam>/<roll>/..., while legacy clients used UUIDs.
-- Accept either identifier ONLY from the signed-in student's database row.
-- Keep the exam-records bucket private; add SELECT + UPDATE for safe upserts.
drop policy if exists "exam-records student read own" on storage.objects;
drop policy if exists "exam-records student write own" on storage.objects;
drop policy if exists "exam-records student update own" on storage.objects;

create policy "exam-records student read own" on storage.objects
  for select to authenticated using (
    bucket_id = 'exam-records'
    and exists (
      select 1 from public.students s
      where s.auth_id = (select auth.uid())
        and split_part(storage.objects.name, '/', 2) in (s.id::text, s.roll)
    )
  );

create policy "exam-records student write own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'exam-records'
    and exists (
      select 1 from public.students s
      where s.auth_id = (select auth.uid())
        and split_part(storage.objects.name, '/', 2) in (s.id::text, s.roll)
    )
  );

create policy "exam-records student update own" on storage.objects
  for update to authenticated using (
    bucket_id = 'exam-records'
    and exists (
      select 1 from public.students s
      where s.auth_id = (select auth.uid())
        and split_part(storage.objects.name, '/', 2) in (s.id::text, s.roll)
    )
  ) with check (
    bucket_id = 'exam-records'
    and exists (
      select 1 from public.students s
      where s.auth_id = (select auth.uid())
        and split_part(storage.objects.name, '/', 2) in (s.id::text, s.roll)
    )
  );
