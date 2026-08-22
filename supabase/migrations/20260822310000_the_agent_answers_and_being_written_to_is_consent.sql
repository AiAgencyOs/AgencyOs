-- ═══════════════════════════════════════════════════════════════════════════
-- The agent answers — ADM-91 — and being written to is consent — ADM-92.
--
-- Flow 01 has been complete except for its last step since the sales agent was
-- enabled: an inbound WhatsApp message creates the contact, the lead, the
-- conversation and the message; the requirement collector reads the thread; the
-- sales agent labels the intent, the language, the qualification and the
-- objection. **Nothing answers the client.**
--
-- That was not missing code. `ai.agent_steps` holds zero tool calls of any kind
-- because ADM-61 §3 sent anything client-facing to the internal group, and §4
-- recorded follow-ups as *"the only path in AgencyOS where something reaches a
-- client unread"*. Doc 03 §5 (*"Respond to new WhatsApp leads"*) and Doc 08 §6
-- (`AGENT → RESPONSE → SEND`) both asked for the reply and the rule forbade it.
--
-- The conflict was reported with three options and the owner chose to widen the
-- rule: **ADM-91, 2026-08-22 — "ai agent khud kare".**
--
-- ── the consequence nobody had written down ──────────────────────────────
--
-- ADM-91 could not take effect on its own. `crm.send_outbound_message` refuses
-- a client message without recorded consent (ADM-70), and
-- `crm.ingest_whatsapp_message` has never recorded any: a person who writes to
-- the agency has a contact, a lead and a thread, and **no consent row**. Every
-- reply — agent or human — came back `no_consent`.
--
-- Whether an inbound message *is* consent appears nowhere in the twenty-three
-- documents. It was stated back to the owner as an assumption before being
-- acted on, and is recorded as **ADM-92** rather than smuggled in as an
-- implementation detail, because ADM-70 says an agent may not grant consent and
-- this is the system inferring it.
--
-- What it is not: consent to be added to a campaign, and consent for any other
-- channel. `source` says `inbound_message` and the evidence is the message, so
-- an operator can see the system inferred it rather than a person entering it.
-- Withdrawal is unchanged and still wins — and a withdrawn row cannot be
-- deleted and re-granted (20260815130000), so this cannot quietly re-permit
-- somebody who opted out.

-- ── consent, recorded where the message lands ────────────────────────────

create or replace function crm.record_inbound_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
begin
  if new.author_type <> 'client' then
    return new;
  end if;

  select c.contact_id into v_contact
    from crm.conversations c
   where c.id = new.conversation_id;

  if v_contact is null then
    return new;
  end if;

  -- Only if nothing is recorded yet. A contact who WITHDREW consent and then
  -- writes again keeps their withdrawal: ADM-70 says withdrawal stops future
  -- sending, and a message is not a retraction of it. They can be answered by
  -- a person recording consent again, deliberately.
  -- `note` carries the message id: the consent table has `source` and `note`
  -- and no evidence column, and inventing one for a single caller would be a
  -- schema change dressed as a feature. The first draft of this named a
  -- column that does not exist and applied cleanly anyway — a plpgsql body is
  -- not checked until it runs.
  insert into crm.communication_consent (
    organization_id, contact_id, channel, status, source, note
  )
  values (
    new.organization_id, v_contact, 'whatsapp', 'granted',
    'inbound_message', 'first inbound message ' || new.id::text
  )
  on conflict (organization_id, contact_id, channel) do nothing;

  return new;
end;
$$;

comment on function crm.record_inbound_consent() is
  'ADM-92. Records WhatsApp consent for a contact who writes to the agency first, with the message as evidence and source "inbound_message" so an operator can see the system inferred it rather than a person entering it. ON CONFLICT DO NOTHING, so a WITHDRAWN contact keeps their withdrawal - ADM-70 says withdrawal stops future sending, and writing again is not a retraction.';

drop trigger if exists record_inbound_consent on crm.conversation_messages;
create trigger record_inbound_consent
  after insert on crm.conversation_messages
  for each row execute function crm.record_inbound_consent();

-- ── what asks the agent to answer ────────────────────────────────────────
--
-- A separate event rather than a third subscriber on `message.received`,
-- because answering is a different act from reading and must be able to be
-- turned off on its own. `emit_message_received` already fires on every
-- unlabelled inbound client message; this fires beside it, from the same row,
-- and only when the organization has switched replying on.

insert into core.event_types (type, description, canonical)
values ('reply.due', 'A client message is waiting for an answer (ADM-91).', 'ReplyDue')
on conflict (type) do nothing;

-- ── and it is off until somebody turns it on ─────────────────────────────
--
-- The same shape `agent_writes_follow_ups` and `reactivation_pilot_enabled`
-- already have, and for the stronger version of the same reason: this is the
-- second path in AgencyOS where a model's words reach a client unread, and a
-- merge is not how it should start.

alter table core.organizations
  add column if not exists agent_answers_clients boolean not null default false;

comment on column core.organizations.agent_answers_clients is
  'ADM-91: the sales agent composes and sends the reply to an inbound WhatsApp message, and nobody reads it first. Default false - this is the second path where a model''s words reach a client unread (the first is ADM-11 follow-ups), and a merge is not how it should start. With it off the agent still drafts and the draft is still recorded, so the wording can be read before anybody is answered by it.';

create or replace function crm.emit_reply_due()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.author_type <> 'client' then
    return new;
  end if;

  if not exists (
    select 1 from core.organizations o
     where o.id = new.organization_id
       and o.agent_answers_clients
  ) then
    return new;
  end if;

  perform core.emit_event(
    new.organization_id, 'reply.due', 'conversation_message', new.id,
    jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq)
  );

  return new;
end;
$$;

comment on function crm.emit_reply_due() is
  'ADM-91. Asks the sales agent to answer an inbound client message - and only when this organization has switched agent_answers_clients on. Fires from the message row rather than from the webhook, so a message that arrives by any other path is answered the same way.';

drop trigger if exists emit_reply_due on crm.conversation_messages;
create trigger emit_reply_due
  after insert on crm.conversation_messages
  for each row execute function crm.emit_reply_due();

-- ── what an agent's reply may not contain ────────────────────────────────
--
-- **Nothing new.** The rule already exists, and it is better than the one this
-- migration first wrote.
--
-- `crm.refuse_unread_price` (2026-08-21) refuses an agency message that states
-- a price when `author_id` is null — no human behind it — using
-- `crm.states_a_price`, which reads a currency marker in either order, an
-- amount named in words ("2 lakh"), and a discount, while deliberately letting
-- "50% complete" through because *"blocking it would teach whoever hits it to
-- route around the guard"*.
--
-- `send_outbound_message` writes every outbound row with `author_id` set to
-- whatever the caller passed, and the reply workflow passes nothing. So an
-- agent's reply is exactly the shape that guard was written for, and it fires
-- on INSERT — before the message reaches the provider, not after.
--
-- The first draft of this migration added a second trigger doing the same
-- thing with a worse regex. It is not here. A second copy of a rule is a
-- second thing to keep in step, and the one that drifts is the one nobody
-- remembers exists.
--
-- The length cap lives in `clientReplySchema` and nowhere else: it is about
-- what a reply should read like, not about what may reach a client, and a rule
-- with no danger behind it does not need a second home.

-- ── provenance ───────────────────────────────────────────────────────────
--
-- Which agent composed an outbound message, or null when a person did. Not a
-- control: `refuse_unread_price` already decides what may be said, and it
-- decides it from `author_id`. This is so an operator reading a thread can see
-- which of them wrote a line, and so `ai.agent_runs` can be joined to the
-- message it produced.

alter table crm.conversation_messages
  add column if not exists authored_by_agent text references ai.agents(key);

comment on column crm.conversation_messages.authored_by_agent is
  'ADM-91: which agent composed this outbound message, or null when a person did. Provenance, not a control - crm.refuse_unread_price already refuses a price from anything with no human behind it, and it decides that from author_id.';

notify pgrst, 'reload schema';
