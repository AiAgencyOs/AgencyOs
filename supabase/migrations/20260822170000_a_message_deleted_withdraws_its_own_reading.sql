-- A message that is gone withdraws the request to read it.
--
-- `emit_message_received` asks the sales agent to read every inbound client
-- message. That request outlives the message: the event and its job are rows
-- in `core`, and nothing tied them to the row they are about. Delete the
-- message and the runner still claims the job, reads nothing, and settles it
-- succeeded with "message no longer exists" — a full tick spent on work that
-- could not exist.
--
-- Found in CI rather than reasoned about. `verify-milestone-unlock` runs 56th
-- of 60 and sweeps for leaked jobs; the moment inbound messages started asking
-- to be read, it reported seven `message.intent` jobs and five events from
-- five other scripts that had cleaned up their messages properly. The instinct
-- was to teach each of those scripts to delete an event it never knew it
-- caused — fifteen scripts today, and the sixteenth written next month would
-- leak again.
--
-- So the rule goes where the cause is. This is not a test fixture: a job
-- pointing at a row that no longer exists is work that cannot be done, and
-- withdrawing it before the runner claims it is what should have happened
-- anyway.
--
-- Withdrawn, never rewritten. Only an event still unpublished and a job still
-- queued are removed — once the runner has claimed the job it owns the outcome,
-- and once the event is published it is a record of something that happened.
-- `ai.agent_runs` is not touched at all: a run that happened, happened.

create or replace function crm.withdraw_message_reading()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event bigint;
begin
  for v_event in
    select id
      from core.outbox_events
     where organization_id = old.organization_id
       and subject_type = 'conversation_message'
       and subject_id = old.id
  loop
    -- Any handler, not only today's `sales:readIntent`: the dedupe key is
    -- `evt:<id>:<handler>`, so a second subscriber added later is withdrawn
    -- by the same rule rather than by a second copy of it.
    delete from core.jobs
     where dedupe_key like 'evt:' || v_event || ':%'
       and status = 'queued';

    delete from core.outbox_events
     where id = v_event
       and published_at is null;
  end loop;

  return old;
end;
$$;

comment on function crm.withdraw_message_reading() is
  'When a conversation message is deleted, removes the still-queued job and '
  'still-unpublished event asking an agent to read it. Claimed jobs and '
  'published events are left alone — they are records of something that '
  'already happened.';

drop trigger if exists withdraw_message_reading on crm.conversation_messages;
create trigger withdraw_message_reading
  after delete on crm.conversation_messages
  for each row execute function crm.withdraw_message_reading();

notify pgrst, 'reload schema';
