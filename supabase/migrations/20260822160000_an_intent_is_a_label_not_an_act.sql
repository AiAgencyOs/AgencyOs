-- ═══════════════════════════════════════════════════════════════════════════
-- An intent is a label, not an act.
--
-- Document 08 §12 lists what a client's message can mean. Twenty-two intents in
-- two closed lists — ten a lead can have, twelve a client on a project can —
-- and AgencyOS records none of them. Every inbound message is a body of text
-- and nothing else, so the first question anyone answers about a lead is one a
-- person answers by reading.
--
-- ── why this is the safest thing an agent can do here ───────────────────
--
-- ADM-61 §2 lets an L2 agent *"update internal work"*. Naming what a message
-- means touches no client and moves no money: nobody is answered, nothing is
-- promised, and the label can be wrong without anything happening. It is the
-- first step of Doc 03 §5's *"Respond to new WhatsApp leads"* and the only step
-- of it that is not §3 work.
--
-- ── the rule that makes it safe, and it is not a prompt ─────────────────
--
-- Two of §12's intents are the dangerous ones: `acceptance` and `approval`.
-- Doc 08 §14 is explicit about them — *"Ambiguous responses should trigger a
-- confirmation request. Do not infer acceptance from a generic 'looks good'"* —
-- and business rules §5 makes it absolute: **"Treat a client's word as a fact"**
-- is one of the five things no agent may do at any level.
--
-- So this column **cannot cause anything**. It is a label on a message and the
-- system reads it nowhere: no trigger fires on it, no status moves with it, no
-- proposal is accepted by it. An `acceptance` intent means somebody should
-- look, and nothing more. The guard below makes that permanent — the label may
-- be written once, by the agent that read the message, and never rewritten to
-- mean something else after the fact.
--
-- The absence is the design, again: an intent that could move a lead's status
-- would be a client's word treated as a fact, and there is no path from one to
-- the other to guard.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.conversation_messages
  add column if not exists intent text
    check (intent in (
      -- Doc 08 §12, lead intents
      'new_enquiry', 'service_inquiry', 'price_inquiry', 'requirement_sharing',
      'trust_concern', 'negotiation', 'quotation_request', 'acceptance',
      'follow_up', 'not_interested',
      -- Doc 08 §12, client/project intents
      'progress_inquiry', 'feedback', 'approval', 'change_request', 'bug_report',
      'payment_message', 'payment_proof', 'support_request', 'cancellation_request',
      'handover_request', 'new_project_inquiry', 'upsell_response'
    ));

alter table crm.conversation_messages
  add column if not exists intent_by_agent text references ai.agents(key) on delete set null;

create index if not exists conversation_messages_unlabelled_idx
  on crm.conversation_messages (organization_id, conversation_id)
  where intent is null and author_type = 'client';

comment on column crm.conversation_messages.intent is
  'What Doc 08 section 12 says this message means. A LABEL AND NOTHING ELSE: no trigger fires on it, no status moves with it, no proposal is accepted by it. `acceptance` and `approval` are the reason that matters - business rules section 5 makes "treat a client''s word as a fact" one of the five things no agent may do at any level, and Doc 08 section 14 requires a confirmation flow rather than an inference.';

comment on column crm.conversation_messages.intent_by_agent is
  'Which agent read the message, or null when a person labelled it. Provenance lives here rather than only in ai.agent_runs because the label is read beside the message.';

-- ── a label is written once ─────────────────────────────────────────────
--
-- Not because relabelling is dangerous — it causes nothing either way — but
-- because a label that changes is a record of what somebody currently believes
-- rather than of what was read at the time. The message is immutable; so is the
-- reading of it.

create or replace function crm.freeze_message_intent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.intent is not null and new.intent is distinct from old.intent then
    raise exception
      'a message''s intent is what was read at the time; record a new reading rather than editing this one (Doc 08 §12)'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_message_intent on crm.conversation_messages;
create trigger freeze_message_intent
  before update of intent on crm.conversation_messages
  for each row execute function crm.freeze_message_intent();

-- ── the event that asks for a reading ───────────────────────────────────
--
-- Not one of Doc 23 §7's twenty-six: §7 names business milestones and an
-- inbound message is not one. Declared with a null canonical name for the same
-- reason the other nine are — inventing a mapping to flatter the coverage
-- number would make it a statement about optimism.

insert into core.event_types (type, description, canonical) values
  ('message.received', 'A client sent a message that nobody has read yet (Doc 08 §12).', null)
on conflict (type) do nothing;

create or replace function crm.emit_message_received()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only what a CLIENT said. An agency message needs no interpreting, and a
  -- system note is not a message from anybody.
  if new.author_type = 'client' and new.intent is null then
    perform core.emit_event(
      new.organization_id, 'message.received', 'conversation_message', new.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_message_received on crm.conversation_messages;
create trigger emit_message_received
  after insert on crm.conversation_messages
  for each row execute function crm.emit_message_received();

-- ── and the agent that reads them ───────────────────────────────────────

update ai.agents
   set enabled = true,
       disabled_reason = null
 where key = 'sales';

notify pgrst, 'reload schema';
