-- Email notifications tracking table
create table if not exists public.email_notifications (
  id uuid primary key default gen_random_uuid(),
  exam_id text references public.exams(id) on delete cascade,
  student_id uuid references public.students(id) on delete set null,
  email text not null,
  notification_type text not null,
  status text not null,
  attempts int not null default 1,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- We also need to add unsubscribed tracking to students if it doesn't exist
alter table public.students add column if not exists unsubscribed_emails boolean not null default false;

-- Create policy for the edge function to upsert (Service Role bypasses RLS anyway, 
-- but we might want teachers to view the status)
alter table public.email_notifications enable row level security;

drop policy if exists "teachers read own exam notifications" on public.email_notifications;
create policy "teachers read own exam notifications" on public.email_notifications
  for select using (
    exam_id in (select id from public.exams where created_by = auth.uid())
  );
