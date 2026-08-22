-- ═══════════════════════════════════════════════════════════════════════════
-- The follow-up writes itself — and is off until somebody turns it on.
--
-- `FOLLOW_UP_BODY` has been one hardcoded English sentence since follow-ups
-- were built: *"Following up on our last message."* Its own comment calls it a
-- placeholder and says why:
--
--   *"ADM-11 permits AgencyOS to write follow-up text without a human reading
--   it first, and the agent infrastructure that would write it is Phase 5 — so
--   generating something here would either invent an agent path or hardcode
--   prose nobody approved."*
--
-- The agent path exists now. Eight agents run, the sales agent reads every
-- inbound message, and one change ago it started recording **which language
-- the client actually writes in** — which is the fact this needs and the
-- reason it was built.
--
-- ── the one client-facing thing any agent does ───────────────────────────
--
-- ADM-61: *"L2 acts alone on internal work and asks for anything client-facing
-- or touching money, **with the ADM-11 follow-ups as the single exception**."*
-- This is that exception, and it is the only workflow in the system whose work
-- class is `client_facing`. A test asserts it stays the only one.
--
-- ── and it is off ────────────────────────────────────────────────────────
--
-- `core.organizations.agent_writes_follow_ups` defaults to **false**, the same
-- shape `reactivation_pilot_enabled` already has and for the same reason: text
-- that reaches a client unread is not something a merge should switch on. With
-- it off the agent still drafts and the draft is still recorded — so the
-- quality can be read before anybody is sent anything — and the placeholder is
-- what actually goes out.
--
-- ── what an agent-written follow-up may not contain ──────────────────────
--
-- **No digits at all.** Blunt, and deliberately so: a price is a number, a
-- promised date is a number, a discount is a number, and a percentage is a
-- number. ADM-22 forbids an agent naming a price and ADM-61 §5 forbids it
-- promising a date it was not given — and at a surface that sends unread text
-- to a real client, a rule a constraint can check beats a rule a prompt asks
-- for. A follow-up needs no digits. A human writing one is not constrained by
-- this at all.
--
-- **And short.** 300 characters. A follow-up that runs long is an agent
-- explaining something, and explaining is the part it may not do.

alter table core.organizations
  add column if not exists agent_writes_follow_ups boolean not null default false;

comment on column core.organizations.agent_writes_follow_ups is
  'ADM-11 permits an agent to write follow-up text without a human reading it first. This says whether this organization has turned that on - default false, the same shape reactivation_pilot_enabled has, because text reaching a client unread is not something a merge should switch on. With it off the draft is still written and recorded, and the neutral placeholder is what is sent.';

alter table crm.follow_up_sequences
  add column if not exists drafted_body      text,
  add column if not exists drafted_language  text
    check (drafted_language is null or drafted_language ~ '^[a-z]{2,3}(-[a-z]{2,3})?$'),
  add column if not exists drafted_by_agent  text references ai.agents(key),
  add column if not exists drafted_at        timestamptz;

alter table crm.follow_up_sequences
  drop constraint if exists follow_up_sequences_agent_draft_is_plain;

alter table crm.follow_up_sequences
  add constraint follow_up_sequences_agent_draft_is_plain check (
    drafted_by_agent is null
    or (
      drafted_body is not null
      and length(btrim(drafted_body)) between 1 and 300
      and drafted_body !~ '[0-9]'
    )
  );

comment on column crm.follow_up_sequences.drafted_body is
  'The follow-up an agent wrote for this sequence, in the language the contact actually writes in. Constrained to contain NO DIGITS and to stay under 300 characters when an agent wrote it: a price is a number, a promised date is a number, a discount is a number, and at a surface that sends unread text to a client a rule a constraint can check beats a rule a prompt asks for. A human is not constrained by it.';

-- ── every draft is on the record ─────────────────────────────────────────
--
-- A trigger rather than a call in the workflow, per G-093: the row records
-- itself without anybody remembering to. What is audited is the text and who
-- wrote it — the two things somebody asking "what did we send this client, and
-- who decided that" needs, and neither is reconstructible from the message row
-- alone once the sequence advances.

create or replace function crm.audit_follow_up_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.drafted_by_agent is not null
     and new.drafted_body is distinct from coalesce(old.drafted_body, null)
  then
    perform core.record_audit(
      new.organization_id,
      'follow_up.drafted',
      'follow_up_sequence',
      new.id,
      jsonb_build_object('body', old.drafted_body),
      jsonb_build_object(
        'body', new.drafted_body,
        'language', new.drafted_language,
        'agent', new.drafted_by_agent
      )
    );
  end if;
  return new;
end;
$$;

comment on function crm.audit_follow_up_draft() is
  'Records every agent-written follow-up in audit.audit_log. A trigger rather than a call in the workflow, per G-093: the row records itself without anybody remembering to, and the text is not reconstructible from the message once the sequence advances.';

drop trigger if exists audit_follow_up_draft on crm.follow_up_sequences;
create trigger audit_follow_up_draft
  after update of drafted_body on crm.follow_up_sequences
  for each row execute function crm.audit_follow_up_draft();

-- ── what asks for one to be written ──────────────────────────────────────
--
-- Emitted when a sequence is SCHEDULED, not when it is due. The composer then
-- has until the send time to answer, and the send never waits on a model call:
-- with no draft the placeholder goes, exactly as it does today.

insert into core.event_types (type, description, canonical)
values ('followup.due', 'A follow-up was scheduled and needs its text written (ADM-11).', 'FollowUpDue')
on conflict (type) do nothing;

-- And the third table to use `core.withdraw_work_about`, which is the whole
-- point of it having been written as one function taking its subject type as
-- an argument. A sequence that is deleted takes the request to write its text
-- with it — `verify-milestone-unlock` found the leak within a chain run of
-- this change being written, exactly as it found the other two.

create trigger withdraw_work_about_follow_up
  after delete on crm.follow_up_sequences
  for each row execute function core.withdraw_work_about('follow_up_sequence');

notify pgrst, 'reload schema';
