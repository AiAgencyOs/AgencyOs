-- ═══════════════════════════════════════════════════════════════════════════
-- Work about a row that is gone.
--
-- `crm.withdraw_message_reading` shipped one change ago with a rule that was
-- right and too narrow: when a conversation message is deleted, remove the
-- request to read it — but **only if the job was still queued and the event
-- still unpublished**, because *"a claimed job owns its outcome and a
-- published event is a record of something that happened."*
--
-- That reasoning is about the WORK. It is not about the subject. And the very
-- next event type raised — `handover.accepted` — broke on the difference:
-- `verify-milestone-unlock` reported two `success.checkin` jobs, both
-- `succeeded`, and their two published events, left by scripts that had
-- deleted their projects cleanly. Nothing was still pending, so nothing was
-- withdrawn, and the rows sat pointing at handovers that no longer exist.
--
-- ── the rule, said properly this time ────────────────────────────────────
--
-- `core.outbox_events` and `core.jobs` are **working tables, not history**.
-- An event is a request that something be done; a job is that request claimed.
-- Both are meaningful only because of the row they are about, so when that row
-- is deleted they are not history — they are pointers to nothing.
--
-- History lives in two places and neither is touched here. `audit.audit_log`
-- is append-only and records what was done. `ai.agent_runs` records what an
-- agent did, including the failures — 33 of them taught this project most of
-- what it knows — and a run that happened, happened, whatever became of its
-- subject afterwards.
--
-- ── and it is one function, not two ──────────────────────────────────────
--
-- Written as a trigger function taking the subject type as an argument, the
-- way `core.enforce_parent_org` takes its column and parent. The alternative
-- is a copy per table, and the message version already proved what a copy
-- does: it carries the reasoning that was true when it was written, and the
-- second table's case is the one that shows the reasoning was incomplete.

create or replace function core.withdraw_work_about()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject_type text := tg_argv[0];
  v_event        bigint;
begin
  for v_event in
    select id
      from core.outbox_events
     where organization_id = old.organization_id
       and subject_type = v_subject_type
       and subject_id = old.id
  loop
    -- Any handler, not only today's. The dedupe key is `evt:<id>:<handler>`,
    -- so a second subscriber added later is swept by the same rule rather
    -- than by somebody remembering to extend this one.
    delete from core.jobs where dedupe_key like 'evt:' || v_event || ':%';
    delete from core.outbox_events where id = v_event;
  end loop;

  return old;
end;
$$;

comment on function core.withdraw_work_about() is
  'Removes the outbox events about a deleted row, and the jobs those events created. Takes the subject type as its trigger argument. core.outbox_events and core.jobs are working tables: an event is a request and a job is that request claimed, and both are meaningful only because of the row they name. History is not touched - audit.audit_log is append-only, and ai.agent_runs records what an agent did whatever became of its subject.';

drop trigger if exists withdraw_message_reading on crm.conversation_messages;
drop function if exists crm.withdraw_message_reading();

create trigger withdraw_work_about_message
  after delete on crm.conversation_messages
  for each row execute function core.withdraw_work_about('conversation_message');

create trigger withdraw_work_about_handover
  after delete on projects.handovers
  for each row execute function core.withdraw_work_about('handover');

notify pgrst, 'reload schema';
