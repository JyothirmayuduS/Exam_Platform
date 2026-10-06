-- Phone (QR) uploads are written to attempts.answers by the mobile-upload
-- function, but the exam client autosaves the WHOLE answers object every few
-- seconds. If the client never applied the upload, its next save erased it.
-- This trigger merges instead: a stored "[Uploaded answer: …]" survives any
-- write whose value for that question is missing or blank, and on submit every
-- uploaded file in question_submissions is folded into an unanswered question.

create or replace function public.preserve_uploaded_answers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  k text;
  v jsonb;
  incoming jsonb;
  sub record;
begin
  if new.answers is null and old.answers is null then
    return new;
  end if;
  new.answers := coalesce(new.answers, '{}'::jsonb);

  if old.answers is not null and jsonb_typeof(old.answers) = 'object' then
    for k, v in select * from jsonb_each(old.answers) loop
      if jsonb_typeof(v) = 'string' and (v #>> '{}') like '[Uploaded answer:%' then
        incoming := new.answers -> k;
        if incoming is null
           or incoming = 'null'::jsonb
           or (jsonb_typeof(incoming) = 'string' and btrim(incoming #>> '{}') = '') then
          new.answers := new.answers || jsonb_build_object(k, v);
        end if;
      end if;
    end loop;
  end if;

  if new.state = 'submitted' then
    for sub in
      select distinct on (question_id) question_id, pdf_storage_path
      from question_submissions
      where attempt_id = new.id and coalesce(pdf_storage_path, '') <> ''
      order by question_id, created_at desc
    loop
      incoming := new.answers -> sub.question_id;
      if incoming is null
         or incoming = 'null'::jsonb
         or (jsonb_typeof(incoming) = 'string' and btrim(incoming #>> '{}') = '') then
        new.answers := new.answers || jsonb_build_object(sub.question_id, '[Uploaded answer: ' || sub.pdf_storage_path || ']');
      end if;
    end loop;
  end if;

  return new;
end;
$$;

revoke execute on function public.preserve_uploaded_answers() from public, anon, authenticated;

drop trigger if exists attempts_preserve_uploaded_answers on public.attempts;
create trigger attempts_preserve_uploaded_answers
  before update of answers, state on public.attempts
  for each row execute function public.preserve_uploaded_answers();
