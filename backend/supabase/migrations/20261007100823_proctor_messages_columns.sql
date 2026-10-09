-- proctor_messages predates 20260906000001, so that migration's
-- `create table if not exists` was skipped and only exam_id / sender_role /
-- kind were added. The app writes `sender` and `body`, and the legacy
-- attempt_id / proctor_id / message_text columns were NOT NULL, so every
-- announcement and message insert failed.
alter table public.proctor_messages add column if not exists sender text not null default 'Proctor';
alter table public.proctor_messages add column if not exists body text;

alter table public.proctor_messages alter column attempt_id drop not null;
alter table public.proctor_messages alter column proctor_id drop not null;
alter table public.proctor_messages alter column message_text drop not null;

update public.proctor_messages set body = message_text where body is null;
alter table public.proctor_messages alter column body set not null;
