-- Moodle LTI 1.3: Moodle launches a mapped exam with the student already
-- signed in, and receives the score back (Assignment and Grade Services).
-- Only the `lti` and `submit-attempt` Edge Functions (service role) touch these
-- tables, except that teachers see Moodle activities and map them to their exams.

create table if not exists public.lti_platforms (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  issuer          text not null,               -- Moodle "Platform ID", e.g. https://lms.vignan.ac.in
  client_id       text not null,               -- Moodle "Client ID" for this tool
  deployment_ids  text[] not null default '{}', -- empty = any deployment of this client
  auth_login_url  text not null,               -- .../mod/lti/auth.php
  auth_token_url  text not null,               -- .../mod/lti/token.php
  jwks_url        text not null,               -- .../mod/lti/certs.php
  created_at      timestamptz not null default now(),
  unique (issuer, client_id)
);

-- One Moodle activity (resource link). A teacher maps it to exactly one exam;
-- the launch only ever opens that exam.
create table if not exists public.lti_links (
  id                uuid primary key default gen_random_uuid(),
  platform_id       uuid not null references public.lti_platforms(id) on delete cascade,
  deployment_id     text not null,
  resource_link_id  text not null,
  context_id        text,
  context_title     text,
  resource_title    text,
  exam_id           text references public.exams(id) on delete set null,
  mapped_by         uuid,
  mapped_at         timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_launch_at    timestamptz not null default now(),
  unique (platform_id, resource_link_id)
);
create index if not exists lti_links_exam_idx on public.lti_links (exam_id);

-- Moodle user (platform + sub) -> platform student.
create table if not exists public.lti_users (
  platform_id  uuid not null references public.lti_platforms(id) on delete cascade,
  sub          text not null,
  student_id   uuid not null references public.students(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (platform_id, sub)
);
create unique index if not exists lti_users_student_idx on public.lti_users (platform_id, student_id);

-- OIDC login state + nonce, consumed once by the launch.
create table if not exists public.lti_logins (
  state        text primary key,
  nonce        text not null,
  platform_id  uuid not null references public.lti_platforms(id) on delete cascade,
  created_at   timestamptz not null default now()
);

-- One-time ticket the browser trades for a session (stored hashed).
create table if not exists public.lti_tickets (
  ticket_hash   text primary key,
  student_id    uuid not null references public.students(id) on delete cascade,
  auth_user_id  uuid not null,
  exam_id       text not null references public.exams(id) on delete cascade,
  link_id       uuid not null references public.lti_links(id) on delete cascade,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

-- Where a student's score for an exam goes in Moodle (AGS line item).
create table if not exists public.lti_grade_targets (
  link_id         uuid not null references public.lti_links(id) on delete cascade,
  student_id      uuid not null references public.students(id) on delete cascade,
  exam_id         text not null references public.exams(id) on delete cascade,
  sub             text not null,
  lineitem        text,
  score_maximum   numeric,
  last_score      numeric,
  last_posted_at  timestamptz,
  last_error      text,
  primary key (link_id, student_id)
);
create index if not exists lti_grade_targets_attempt_idx on public.lti_grade_targets (exam_id, student_id);

alter table public.lti_platforms     enable row level security;
alter table public.lti_links         enable row level security;
alter table public.lti_users         enable row level security;
alter table public.lti_logins        enable row level security;
alter table public.lti_tickets       enable row level security;
alter table public.lti_grade_targets enable row level security;

revoke all on public.lti_platforms, public.lti_links, public.lti_users, public.lti_logins,
  public.lti_tickets, public.lti_grade_targets from anon, authenticated;

-- Teachers see which Moodle site an activity came from (no secrets live here).
grant select (id, name, issuer) on public.lti_platforms to authenticated;
drop policy if exists "lti platforms teacher read" on public.lti_platforms;
create policy "lti platforms teacher read" on public.lti_platforms
  for select to authenticated using ((select public.auth_is_teacher()));

-- Teachers list Moodle activities and map/unmap them. A link can only be
-- pointed at an exam the teacher owns, and only unmapped from one they own.
grant select (id, platform_id, context_title, resource_title, exam_id, mapped_at, first_seen_at, last_launch_at)
  on public.lti_links to authenticated;
grant update (exam_id, mapped_by, mapped_at) on public.lti_links to authenticated;
drop policy if exists "lti links teacher read" on public.lti_links;
create policy "lti links teacher read" on public.lti_links
  for select to authenticated using ((select public.auth_is_teacher()));
drop policy if exists "lti links owner map" on public.lti_links;
create policy "lti links owner map" on public.lti_links
  for update to authenticated
  using ((select public.auth_is_teacher()) and (exam_id is null or public.owns_exam(exam_id)))
  with check ((select public.auth_is_teacher()) and (exam_id is null or public.owns_exam(exam_id)));
