-- ═══════════════════════════════════════════════════════════════════════════
-- An objection is recorded. It is not answered by an agent.
--
-- Document 09 §19 names four kinds of objection and then says, in one line,
-- what the system owes:
--
--   *"The CRM should store objection type, exact concern, response, outcome
--   and next action."*
--
-- None of the five is stored anywhere. The sales agent already labels an
-- inbound message `negotiation`, `trust_concern` or `price_inquiry` — Doc 08
-- §12's vocabulary, shipped two changes ago — and that label is where it ends.
-- The concern itself, what the agency said back, whether it worked, and what
-- happens next all live in a WhatsApp thread somebody has to re-read.
--
-- §20 asks for the other half: *"Track each negotiation round … Negotiation is
-- a controlled state machine, not an endless chat loop."* A round is a number
-- here rather than a second table — the thing §20 wants countable is how many
-- times this has gone round, and a lead's rounds are its objections in order.
--
-- ── who may write which half ─────────────────────────────────────────────
--
-- This is the whole design, and it is a row rule rather than a convention.
--
-- The agent may write **type and concern**: which of §19's four this is, and
-- the client's own words. Both are readings of a message it has already read.
--
-- The agent may never write **response, outcome or next action**. Look at what
-- §13 says a response IS: *"Use approved trust-building evidence… Offer only
-- approved low-advance/no-advance structures… Request Admin approval for
-- exceptions… Never make unsupported guarantees."* Every one of those is a
-- commitment to a client — ADM-61 §3's `client_facing`, and for the payment
-- structures §3's `money` as well. An agent that could write the response
-- field would be an agent recording a promise nobody made.
--
-- `objections_agent_writes_no_answer` refuses it at the row, so it holds for a
-- direct PostgREST write and not only for the workflow that behaves.
--
-- ── the numbers §21 asks for, and does not have ──────────────────────────
--
-- §21 lists nine negotiation limits — maximum discount, minimum acceptable
-- price, minimum advance, maximum rounds — and ends: *"All limits are
-- configurable in the Admin Approval & Policy Engine."* **None is configured.**
-- So none is enforced and none is invented: there is no discount column, no
-- amount, no floor and no cap on `round`. The round number counts; it does not
-- stop anything. Inventing a maximum here would be inventing the business
-- rule, which is what ADM-22 and ADM-88 both refused in their own areas.

create table if not exists sales.objections (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  lead_id           uuid not null references crm.leads(id) on delete cascade,

  -- What it was read from. §19 wants the *exact* concern, and a quote with no
  -- message behind it is a paraphrase nobody can check.
  message_id        uuid references crm.conversation_messages(id) on delete set null,

  -- §20: "Track each negotiation round" and "Track quote version". The round
  -- is this objection's place in the sequence for this lead; the proposal is
  -- the version it was raised against, when there is one.
  round             int not null check (round >= 1),
  proposal_id       uuid references sales.proposals(id) on delete set null,

  -- §19's four, and no fifth.
  kind              text not null check (kind in ('price', 'trust', 'timeline', 'feature')),

  -- The client's own words.
  concern           text not null check (length(btrim(concern)) between 1 and 600),

  -- §19's other three. A person's, all of them.
  response          text check (response is null or length(btrim(response)) between 1 and 2000),
  outcome           text check (outcome is null or outcome in (
    'resolved', 'conceded', 'escalated', 'withdrawn', 'lost'
  )),
  next_action       text check (next_action is null or length(btrim(next_action)) between 1 and 600),

  raised_by_agent   text references ai.agents(key),
  answered_by       uuid references core.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists objections_one_per_round
  on sales.objections (lead_id, round);

comment on table sales.objections is
  'Document 09 section 19: "The CRM should store objection type, exact concern, response, outcome and next action." The first two are readings and an agent may write them; the last three are a person''s, because section 13 defines a response as offering an approved structure, requesting an Admin exception or presenting evidence - each a commitment to a client. `round` is section 20''s countable state machine. No discount, amount or limit: section 21''s nine limits are Admin-configurable and none is configured, so none is enforced and none is invented.';

comment on column sales.objections.round is
  'Document 09 section 20: "Negotiation is a controlled state machine, not an endless chat loop." The number counts; it stops nothing, because section 21''s maximum rounds is Admin-configurable and unset, and a cap invented here would be an invented business rule.';

-- ── an agent records the concern; a person records the answer ────────────

create or replace function sales.objections_agent_writes_no_answer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.raised_by_agent is not null
     and (new.response is not null or new.outcome is not null or new.next_action is not null)
     and new.answered_by is null
  then
    raise exception
      'an agent records what the client said, not what the agency answered (Doc 09 §13)'
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists objections_agent_writes_no_answer on sales.objections;
create trigger objections_agent_writes_no_answer
  before insert or update on sales.objections
  for each row execute function sales.objections_agent_writes_no_answer();

-- ── and the concern itself is what was said ──────────────────────────────

create or replace function sales.freeze_objection_concern()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind or new.concern is distinct from old.concern then
    raise exception
      'the concern is what the client raised, not what somebody thinks now'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_objection_concern on sales.objections;
create trigger freeze_objection_concern
  before update on sales.objections
  for each row execute function sales.freeze_objection_concern();

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table sales.objections enable row level security;
alter table sales.objections force row level security;

drop policy if exists objections_select on sales.objections;
create policy objections_select on sales.objections
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Answering is internal sales work; `sales.write` is the capability that
-- already governs a proposal.
drop policy if exists objections_answer on sales.objections;
create policy objections_answer on sales.objections
  for update to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_objections_lead on sales.objections;
create trigger org_match_objections_lead
  before insert or update of lead_id, organization_id on sales.objections
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

drop trigger if exists org_match_objections_message on sales.objections;
create trigger org_match_objections_message
  before insert or update of message_id, organization_id on sales.objections
  for each row execute function core.enforce_parent_org('message_id', 'crm.conversation_messages');

drop trigger if exists org_match_objections_proposal on sales.objections;
create trigger org_match_objections_proposal
  before insert or update of proposal_id, organization_id on sales.objections
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');

drop trigger if exists freeze_org_objections on sales.objections;
create trigger freeze_org_objections
  before update of organization_id on sales.objections
  for each row execute function core.freeze_organization_id();

grant select, update on sales.objections to authenticated;
grant select, insert, update on sales.objections to service_role;

-- ── what asks for one to be read ─────────────────────────────────────────
--
-- Not every inbound message. The sales agent already labels each one with a
-- Doc 08 §12 intent, and three of those twenty-two are objection-shaped:
-- `price_inquiry`, `negotiation`, `trust_concern`. Reading only those costs a
-- model call when there is something to read rather than on every message
-- that arrives.
--
-- **The honest limit of that, stated rather than papered over:** a timeline or
-- a feature objection that arrives labelled something else is not noticed
-- here. §12's vocabulary has no intent for either, so the trigger cannot ask
-- for what nothing names. The classifier can still answer `timeline` or
-- `feature` — a message labelled `negotiation` is often really one of those —
-- but an unlabelled one waits for a person. Widening the trigger to every
-- message would find them at the cost of a model call per message, which is
-- the trade §12's own labelling was built to avoid.

insert into core.event_types (type, description, canonical)
values ('objection.raised', 'A client message was read as an objection (Doc 09 §19).', 'ObjectionRaised')
on conflict (type) do nothing;

create or replace function crm.emit_objection_raised()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.intent in ('price_inquiry', 'negotiation', 'trust_concern')
     and old.intent is null
  then
    perform core.emit_event(
      new.organization_id, 'objection.raised', 'conversation_message', new.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'intent', new.intent)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_objection_raised on crm.conversation_messages;
create trigger emit_objection_raised
  after update of intent on crm.conversation_messages
  for each row execute function crm.emit_objection_raised();

notify pgrst, 'reload schema';
