-- Teacher workspace settings (profile defaults, notifications, templates, keys)
-- Stored as a single jsonb blob on the teacher row so every Settings tab can
-- persist without schema churn. The frontend reads/writes it with the anon key.

alter table public.teachers add column if not exists settings jsonb not null default '{}'::jsonb;

-- Teachers may update their own row (profile fields + settings blob).
create policy "teachers update own profile" on public.teachers
  for update using (auth.uid() = auth_id) with check (auth.uid() = auth_id);