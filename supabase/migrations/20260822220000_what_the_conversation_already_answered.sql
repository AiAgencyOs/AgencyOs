-- ═══════════════════════════════════════════════════════════════════════════
-- What the conversation already answered.
--
-- Document 09 §9 lists fifteen things a lead must be qualified on — what they
-- want built, for whom, on which platforms, the core features, integrations,
-- design references, timeline, budget, urgency, whether this person decides,
-- existing systems, special requirements, language, trust concerns, payment
-- expectations. And then the line that says what to do with the list:
--
--   *"The Sales Agent should not interrogate the lead with a rigid checklist
--   when the conversation already provides the answer."*
--
-- `crm.leads.qualification` has existed for months and holds **three** of the
-- fifteen — budget, timeline, decision-maker — typed into a form by a person
-- after they have read the thread themselves. Everything else lives in the
-- transcript, which is exactly where nobody can see it.
--
-- So the qualifier reads what arrived and records **which areas the client has
-- already answered, in the client's own words**. What is left is then the
-- difference between fifteen and that, which is the only useful form of
-- "what should I ask next".
--
-- ── the number that is deliberately not here ─────────────────────────────
--
-- §10 asks for a qualification score across ten dimensions and adds *"Admin
-- can configure scoring weights."* **ADM-88 already answered this**, and
-- `crm.leads.score` carries the answer as a comment on a column that is always
-- null: *"no numeric lead score and no invented weights — the repository has
-- no approved scoring model and inventing one is out of scope."* Nothing here
-- scores anything. Coverage is a count of facts, not a judgement about them.
--
-- ── and the number that is deliberately not here either ──────────────────
--
-- §9's budget area is recorded the same way as the other fourteen: as the
-- sentence the client said it in. **Not as an amount.** `qualification.
-- budgetMinor` is an integer a person types after deciding what the client
-- meant, and business rules §5 forbids any agent treating a client's word as a
-- fact — which is precisely what parsing *"maybe around two lakh, depends"*
-- into `200000` would be. The agent says the area was discussed and quotes it.
-- A person still types the number.

-- No new event type. `message.received` already asks for an inbound client
-- message to be read, and this is a second thing worth reading it for — so the
-- qualifier joins `sales:readIntent` as a subscriber rather than inventing a
-- parallel trigger. §9's instruction is to notice what the conversation gives
-- you, and a message is when the conversation gives you anything.

create table if not exists crm.qualification_coverage (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  lead_id           uuid not null references crm.leads(id) on delete cascade,
  conversation_id   uuid not null references crm.conversations(id) on delete cascade,

  -- Document 09 §9's fifteen, and no sixteenth.
  area              text not null check (area in (
    'what_to_build',
    'service_type',
    'target_users',
    'platforms',
    'core_features',
    'integrations',
    'design_expectations',
    'timeline',
    'budget',
    'urgency',
    'decision_maker',
    'existing_assets',
    'special_requirements',
    'language',
    'trust_concerns',
    'payment_expectations'
  )),

  -- The client's own words. Required, and it is the whole evidence: a coverage
  -- row that cannot point at what it read is an assertion, and an assertion is
  -- what §9 says not to build a checklist out of.
  quote             text not null check (length(btrim(quote)) between 1 and 400),

  read_by_agent     text references ai.agents(key),
  created_at        timestamptz not null default now()
);

-- One answer per area per lead. A later conversation that covers the same
-- ground is not a correction — the first answer is what the client said, and
-- the qualifier is told to skip what is already covered rather than restate
-- it.
create unique index if not exists qualification_coverage_one_per_area
  on crm.qualification_coverage (lead_id, area);

comment on table crm.qualification_coverage is
  'Document 09 section 9, as what the conversation has ALREADY answered rather than what somebody typed into a form. Fifteen areas, each recorded with the client''s own words. No score and no weights - ADM-88 answered section 10 and crm.leads.score carries that answer. No amount either: the budget area holds the sentence, because parsing it into a number would be treating a client''s word as a fact, which business rules section 5 forbids at any level.';

comment on column crm.qualification_coverage.quote is
  'The client''s own words. Required: a coverage row that cannot point at what it read is an assertion, and section 9''s whole instruction is to read the conversation rather than assert over it.';

-- ── a reading is not a rewriting ─────────────────────────────────────────

create or replace function crm.freeze_qualification_coverage()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.area is distinct from old.area or new.quote is distinct from old.quote then
    raise exception
      'a qualification answer is what the client said, not what somebody thinks now'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_qualification_coverage on crm.qualification_coverage;
create trigger freeze_qualification_coverage
  before update on crm.qualification_coverage
  for each row execute function crm.freeze_qualification_coverage();

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table crm.qualification_coverage enable row level security;
alter table crm.qualification_coverage force row level security;

drop policy if exists qualification_coverage_select on crm.qualification_coverage;
create policy qualification_coverage_select on crm.qualification_coverage
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_qualification_coverage_lead on crm.qualification_coverage;
create trigger org_match_qualification_coverage_lead
  before insert or update of lead_id, organization_id on crm.qualification_coverage
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

drop trigger if exists org_match_qualification_coverage_conversation on crm.qualification_coverage;
create trigger org_match_qualification_coverage_conversation
  before insert or update of conversation_id, organization_id on crm.qualification_coverage
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists freeze_org_qualification_coverage on crm.qualification_coverage;
create trigger freeze_org_qualification_coverage
  before update of organization_id on crm.qualification_coverage
  for each row execute function core.freeze_organization_id();

grant select on crm.qualification_coverage to authenticated;
grant select, insert on crm.qualification_coverage to service_role;

-- ── and who reads them ───────────────────────────────────────────────────
--
-- The sales agent, which is already enabled and already reads every inbound
-- message for its intent. **No new agent is turned on by this migration**, and
-- the one whose name fits is deliberately left alone.
--
-- `ai.agents` holds fifteen rows and `src/modules/agents/registry.ts` defines
-- thirteen; `lead_qualifier` and `proposal_drafter` are the two that are
-- installed and undefined, kept as history rather than deleted. G-125's
-- closure conditions, fixed by the owner on 2026-08-14, include (11)
-- **"lead_qualifier is not accidentally enabled as an unimplemented
-- independent runtime agent"** — so enabling it here would have broken a
-- recorded decision to build a feature the same decision did not ask for.
--
-- And Document 09 assigns this work by name anyway. §9: *"The **Sales Agent**
-- should not interrogate the lead with a rigid checklist when the conversation
-- already provides the answer."* §11: *"**Sales Agent** extracts requirements
-- from conversation."* The agent that should notice what a conversation
-- already answers is the one already reading it.

notify pgrst, 'reload schema';
