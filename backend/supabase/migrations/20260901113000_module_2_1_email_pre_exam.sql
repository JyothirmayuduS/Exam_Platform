do $$
begin
  if exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'enrollments'
  ) then
    alter table public.enrollments add column if not exists countdown_notified boolean default false;
    alter table public.enrollments add column if not exists reminder_email_sent boolean default false;
  end if;

  if exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'exam_enrollments'
  ) then
    alter table public.exam_enrollments add column if not exists countdown_notified boolean default false;
    alter table public.exam_enrollments add column if not exists reminder_email_sent boolean default false;
  end if;
end $$;

alter table public.exams add column if not exists instructions text;
alter table public.exams add column if not exists resources_url text;
alter table public.exams add column if not exists faq jsonb;

create table if not exists public.exam_reminders (
  id bigserial primary key,
  exam_id text not null references public.exams(id) on delete cascade,
  student_id uuid,
  reminder_type text not null default 'one_hour',
  sent_at timestamptz not null default now(),
  unique (exam_id, student_id, reminder_type)
);

create table if not exists public.email_notifications (
  id bigserial primary key,
  exam_id text references public.exams(id) on delete cascade,
  student_id uuid,
  email text not null,
  notification_type text not null,
  status text not null,
  attempts int not null default 1,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_notifications_exam_type
  on public.email_notifications (exam_id, notification_type, created_at desc);

alter table public.enrollments enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'enrollments'
      and policyname = 'students read own enrollments'
  ) then
    create policy "students read own enrollments"
      on public.enrollments
      for select
      to authenticated
      using (
        student_id in (select id from public.students where auth_id = (select auth.uid()))
      );
  end if;
end $$;
