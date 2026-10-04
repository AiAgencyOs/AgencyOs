-- ═══════════════════════════════════════════════════════
-- A client's reply to the design options is read before it is acted on.
--
-- Phase 3 PM §4.5-§4.9, §12: the PM captures what the client selected, asked to change,
-- referenced, or confirmed; "distinguishes visual changes from possible scope changes";
-- and keeps the client's own words. Until now a PERSON read every reply in WhatsApp and
-- typed the classification in. This is the reading step, with the control kept where
-- it matters:
--
--   • Every reply the PM reads becomes a PROPOSAL (this table): the client's words, what
--     the reading concluded, how sure, and what the policy did about it. One per message
--     (the message id is the idempotency key - a replayed event or a retried job reads a
--     reply once and pays for it once).
--   • What the PM may apply ON ITS OWN is the reversible, low-stakes set: a selection, a
--     visual change request (which opens the revision round), a reference the client sent,
--     a clarification the client asked for. A DB CHECK refuses "apply" for the two that
--     are not: `final_confirmed` (it is what LOCKS the design) and `possible_scope_change`
--     (it stops the phase and decides what the client pays for). Those wait for a person.
--   • A client can only choose what they were SHOWN: a reading that names an option not in
--     the share's frozen snapshot is never applied; it goes to a person.
--   • A decision applied by the PM carries `recorded_by_agent`, not a person's name - the
--     record never says a human did what an agent did.
--
-- Nothing here designs, sends or locks anything.
-- ═══════════════════════════════════════════════════════

-- ── a decision may be recorded by the PM agent ────────────────────────────

alter table projects.client_design_decisions alter column recorded_by drop not null;

alter table projects.client_design_decisions
  add column if not exists recorded_by_agent text
    check (recorded_by_agent is null or recorded_by_agent = 'project_manager');

alter table projects.client_design_decisions
  drop constraint if exists client_decisions_has_a_recorder;
alter table projects.client_design_decisions
  add constraint client_decisions_has_a_recorder
  check ((recorded_by is not null) <> (recorded_by_agent is not null));

comment on column projects.client_design_decisions.recorded_by_agent is
  'Set when the project-manager agent recorded the decision from a client reply (see design_reply_proposals). Exactly one of recorded_by / recorded_by_agent is set: the record never says a person did what an agent did.';

-- ── the proposal ──────────────────────────────────────────────────────────

create table if not exists projects.design_reply_proposals (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id),
  project_id               uuid not null references projects.projects(id),
  phase_three_id           uuid not null references projects.phase_three(id),
  share_id                 uuid not null references projects.client_design_shares(id),
  message_id               uuid not null references crm.conversation_messages(id),
  conversation_id          uuid references crm.conversations(id) on delete set null,

  -- 'rule' = a deterministic reading (a plain "yes" to the confirmation question); 'model' = the structured reading.
  source                   text not null check (source in ('rule', 'model')),
  intent                   text not null check (intent in (
                             'client_selected', 'design_change_request', 'client_reference',
                             'possible_scope_change', 'clarification_required', 'final_confirmed',
                             'unclear', 'unrelated')),
  client_words             text not null check (length(btrim(client_words)) between 1 and 4000),
  selected_theme_option_id uuid references projects.theme_options(id),
  selected_color_option_id uuid references projects.color_options(id),
  reference_url            text,
  reference_note           text,
  confidence               numeric(3, 2) not null check (confidence between 0 and 1),
  reasoning                text check (reasoning is null or length(reasoning) <= 600),
  clarifying_question      text check (clarifying_question is null or length(clarifying_question) <= 600),

  -- What the policy decided to do about it.
  action                   text not null check (action in ('apply', 'person', 'clarify', 'ignore')),
  status                   text not null default 'proposed'
                             check (status in ('proposed', 'applied', 'awaiting_person', 'asked', 'ignored', 'accepted', 'dismissed')),
  decision_id              uuid references projects.client_design_decisions(id),
  revision_id              uuid references projects.design_revisions(id),
  resolved_by              uuid references core.users(id),
  resolved_at              timestamptz,
  resolution_note          text check (resolution_note is null or length(resolution_note) <= 1000),
  created_at               timestamptz not null default now(),

  -- THE IDEMPOTENCY KEY: a reply is read once.
  constraint design_reply_one_per_message unique (message_id),

  -- What the PM may NEVER apply on its own.
  constraint design_reply_apply_is_the_safe_set
    check (action <> 'apply' or intent in ('client_selected', 'design_change_request', 'client_reference', 'clarification_required')),

  -- A reference is something to look at.
  constraint design_reply_reference_has_content
    check (intent <> 'client_reference' or coalesce(btrim(reference_url), '') <> '' or coalesce(btrim(reference_note), '') <> ''),

  -- A colour only ever belongs to a direction.
  constraint design_reply_colour_needs_theme
    check (selected_color_option_id is null or selected_theme_option_id is not null)
);

comment on table projects.design_reply_proposals is
  'Phase 3 PM 4.5-4.9, 12. One row per client reply the PM read: the client''s words, the reading, the confidence, what the policy did. An apply is limited by CHECK to the reversible set; a final confirmation or a possible scope change always waits for a person.';

create index if not exists design_reply_proposals_phase_idx on projects.design_reply_proposals (phase_three_id, created_at desc);
create index if not exists design_reply_proposals_waiting_idx on projects.design_reply_proposals (organization_id, status) where status = 'awaiting_person';

drop trigger if exists org_match_design_reply_phase on projects.design_reply_proposals;
create trigger org_match_design_reply_phase
  before insert or update of phase_three_id, organization_id on projects.design_reply_proposals
  for each row execute function core.enforce_parent_org('phase_three_id', 'projects.phase_three');
drop trigger if exists org_match_design_reply_project on projects.design_reply_proposals;
create trigger org_match_design_reply_project
  before insert or update of project_id, organization_id on projects.design_reply_proposals
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists org_match_design_reply_share on projects.design_reply_proposals;
create trigger org_match_design_reply_share
  before insert or update of share_id, organization_id on projects.design_reply_proposals
  for each row execute function core.enforce_parent_org('share_id', 'projects.client_design_shares');
drop trigger if exists org_match_design_reply_message on projects.design_reply_proposals;
create trigger org_match_design_reply_message
  before insert or update of message_id, organization_id on projects.design_reply_proposals
  for each row execute function core.enforce_parent_org('message_id', 'crm.conversation_messages');
drop trigger if exists org_match_design_reply_conversation on projects.design_reply_proposals;
create trigger org_match_design_reply_conversation
  before insert or update of conversation_id, organization_id on projects.design_reply_proposals
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');
drop trigger if exists org_match_design_reply_theme on projects.design_reply_proposals;
create trigger org_match_design_reply_theme
  before insert or update of selected_theme_option_id, organization_id on projects.design_reply_proposals
  for each row execute function core.enforce_parent_org('selected_theme_option_id', 'projects.theme_options');
drop trigger if exists org_match_design_reply_colour on projects.design_reply_proposals;
create trigger org_match_design_reply_colour
  before insert or update of selected_color_option_id, organization_id on projects.design_reply_proposals
  for each row execute function core.enforce_parent_org('selected_color_option_id', 'projects.color_options');
drop trigger if exists org_match_design_reply_decision on projects.design_reply_proposals;
create trigger org_match_design_reply_decision
  before insert or update of decision_id, organization_id on projects.design_reply_proposals
  for each row execute function core.enforce_parent_org('decision_id', 'projects.client_design_decisions');
drop trigger if exists org_match_design_reply_revision on projects.design_reply_proposals;
create trigger org_match_design_reply_revision
  before insert or update of revision_id, organization_id on projects.design_reply_proposals
  for each row execute function core.enforce_parent_org('revision_id', 'projects.design_revisions');
drop trigger if exists freeze_org_design_reply on projects.design_reply_proposals;
create trigger freeze_org_design_reply
  before update of organization_id on projects.design_reply_proposals
  for each row execute function core.freeze_organization_id();

-- The reading is history; only its handling may move.
create or replace function projects.freeze_design_reply_reading()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a read client reply is history and cannot be removed' using errcode = 'P0001';
  end if;
  if new.message_id is distinct from old.message_id or new.intent is distinct from old.intent
     or new.client_words is distinct from old.client_words or new.confidence is distinct from old.confidence
     or new.source is distinct from old.source or new.action is distinct from old.action
     or new.selected_theme_option_id is distinct from old.selected_theme_option_id
     or new.selected_color_option_id is distinct from old.selected_color_option_id
     or new.share_id is distinct from old.share_id then
    raise exception 'how a client reply was read cannot be edited; only how it was handled can move' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists freeze_design_reply_reading on projects.design_reply_proposals;
create trigger freeze_design_reply_reading
  before update or delete on projects.design_reply_proposals
  for each row execute function projects.freeze_design_reply_reading();

alter table projects.design_reply_proposals enable row level security;
alter table projects.design_reply_proposals force row level security;
drop policy if exists design_reply_select on projects.design_reply_proposals;
create policy design_reply_select on projects.design_reply_proposals
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table projects.design_reply_proposals from public, anon, authenticated;
grant select on projects.design_reply_proposals to authenticated, service_role;
grant insert, update on projects.design_reply_proposals to service_role;

insert into core.event_types (type, description, canonical) values
  ('project.design_reply_read', 'Phase 3 PM 4.5 - the PM read a client reply to the design options and recorded what it concluded (applied, waiting for a person, or a question asked).', false)
on conflict (type) do nothing;

-- ── the PM proposes (and may apply the safe set) ──────────────────────────

create or replace function projects.agent_propose_design_reply(
  p_message_id uuid,
  p_share_id uuid,
  p_source text,
  p_intent text,
  p_theme_option_id uuid,
  p_color_option_id uuid,
  p_reference_url text,
  p_reference_note text,
  p_confidence numeric,
  p_reasoning text,
  p_clarifying_question text,
  p_action text
)
returns table (
  -- 'proposed' | 'exists' | refusals: 'unknown_message' | 'not_a_client_message' | 'unknown_share' | 'wrong_project'
  outcome     text,
  proposal_id uuid,
  action      text,
  status      text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_msg      record;
  v_share    projects.client_design_shares;
  v_existing projects.design_reply_proposals;
  v_theme    uuid := p_theme_option_id;
  v_color    uuid := p_color_option_id;
  v_action   text := p_action;
  v_note     text := p_reasoning;
  v_status   text;
  v_id       uuid;
  v_shown    boolean;
begin
  select m.id, m.organization_id, m.body, m.author_type, m.conversation_id into v_msg
    from crm.conversation_messages m where m.id = p_message_id;
  if v_msg.id is null then
    return query select 'unknown_message'::text, null::uuid, null::text, null::text; return;
  end if;
  if v_msg.author_type <> 'client' or coalesce(btrim(v_msg.body), '') = '' then
    return query select 'not_a_client_message'::text, null::uuid, null::text, null::text; return;
  end if;

  select * into v_existing from projects.design_reply_proposals where message_id = p_message_id;
  if v_existing.id is not null then
    return query select 'exists'::text, v_existing.id, v_existing.action, v_existing.status; return;
  end if;

  select s.* into v_share from projects.client_design_shares s where s.id = p_share_id and s.organization_id = v_msg.organization_id;
  if v_share.id is null then
    return query select 'unknown_share'::text, null::uuid, null::text, null::text; return;
  end if;

  -- A client can only choose from what they were SHOWN (the frozen snapshot, not today's options).
  if v_theme is not null then
    select exists (select 1 from jsonb_array_elements(v_share.shared_options) o where (o->>'themeOptionId')::uuid = v_theme) into v_shown;
    if not v_shown then
      v_theme := null; v_color := null;
      if v_action = 'apply' then v_action := 'person'; end if;
      v_note := left(coalesce(v_note, '') || ' [the named option is not in what the client was shown]', 600);
    end if;
  end if;
  if v_color is not null and not exists (select 1 from projects.color_options c where c.id = v_color and c.theme_option_id = v_theme) then
    v_color := null;
    v_note := left(coalesce(v_note, '') || ' [the palette does not belong to that direction]', 600);
  end if;

  -- The structural guarantees, enforced here so no caller can talk the policy out of them.
  if p_intent in ('final_confirmed', 'possible_scope_change') and v_action = 'apply' then v_action := 'person'; end if;
  if p_intent = 'client_selected' and v_theme is null and v_action = 'apply' then v_action := 'clarify'; end if;
  if p_intent = 'design_change_request' and v_action = 'apply' and v_theme is null then
    -- one shared option -> it is the one they mean; several -> ask which.
    if jsonb_array_length(v_share.shared_options) = 1 then
      v_theme := (v_share.shared_options->0->>'themeOptionId')::uuid;
    else
      v_action := 'clarify';
    end if;
  end if;
  if p_intent = 'client_reference' and v_action = 'apply'
     and coalesce(btrim(p_reference_url), '') = '' and coalesce(btrim(p_reference_note), '') = '' then
    v_action := 'person';
  end if;

  v_status := case v_action when 'apply' then 'proposed' when 'clarify' then 'proposed' when 'ignore' then 'ignored' else 'awaiting_person' end;

  insert into projects.design_reply_proposals
    (organization_id, project_id, phase_three_id, share_id, message_id, conversation_id, source, intent, client_words,
     selected_theme_option_id, selected_color_option_id, reference_url, reference_note, confidence, reasoning,
     clarifying_question, action, status)
  values
    (v_msg.organization_id, v_share.project_id, v_share.phase_three_id, v_share.id, v_msg.id, v_msg.conversation_id, p_source, p_intent,
     left(v_msg.body, 4000), v_theme, v_color, nullif(btrim(coalesce(p_reference_url, '')), ''), nullif(btrim(coalesce(p_reference_note, '')), ''),
     greatest(0, least(1, coalesce(p_confidence, 0))), v_note, left(p_clarifying_question, 600), v_action, v_status)
  returning id into v_id;

  perform core.record_audit(v_msg.organization_id, 'design_reply.read', 'design_reply_proposal', v_id, null,
    jsonb_build_object('intent', p_intent, 'action', v_action, 'confidence', p_confidence, 'source', p_source));
  perform core.emit_event(v_msg.organization_id, 'project.design_reply_read', 'design_reply_proposal', v_id,
    jsonb_build_object('projectId', v_share.project_id, 'intent', p_intent, 'action', v_action));

  return query select 'proposed'::text, v_id, v_action, v_status;
end;
$$;

revoke all on function projects.agent_propose_design_reply(uuid, uuid, text, text, uuid, uuid, text, text, numeric, text, text, text) from public, anon, authenticated;
grant execute on function projects.agent_propose_design_reply(uuid, uuid, text, text, uuid, uuid, text, text, numeric, text, text, text) to service_role;

-- ── the PM applies the safe set ───────────────────────────────────────────
--
-- Mirrors record_client_design_decision (and, for a change request, open_design_revision) with
-- one difference: the recorder is the agent, not a person. Same state moves, same snapshot rule.

create or replace function projects.agent_apply_design_reply(p_proposal_id uuid)
returns table (
  -- 'applied' | 'already_applied' | 'escalated' (the revision limit was reached)
  -- refusals: 'unknown_proposal' | 'not_applicable' | 'phase_not_listening'
  outcome     text,
  decision_id uuid,
  revision_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p      projects.design_reply_proposals;
  v_phase  projects.phase_three;
  v_new    uuid;
  v_rev    uuid;
  v_round  int;
begin
  select p.* into v_p from projects.design_reply_proposals p where p.id = p_proposal_id for update;
  if v_p.id is null then
    return query select 'unknown_proposal'::text, null::uuid, null::uuid; return;
  end if;
  if v_p.status = 'applied' then
    return query select 'already_applied'::text, v_p.decision_id, v_p.revision_id; return;
  end if;
  if v_p.action <> 'apply' or v_p.status <> 'proposed' then
    return query select 'not_applicable'::text, null::uuid, null::uuid; return;
  end if;

  select p3.* into v_phase from projects.phase_three p3 where p3.id = v_p.phase_three_id for update;
  if v_phase.state not in ('waiting_client', 'client_review', 'revision', 'final_confirmation') then
    update projects.design_reply_proposals set status = 'awaiting_person',
           resolution_note = 'The phase was not waiting on the client when this reply was read.' where id = v_p.id;
    return query select 'phase_not_listening'::text, null::uuid, null::uuid; return;
  end if;

  insert into projects.client_design_decisions
    (organization_id, project_id, phase_three_id, share_id, decision, client_words, evidence_ref, conversation_id,
     selected_theme_option_id, selected_color_option_id, reference_url, reference_note, recorded_by_agent)
  values
    (v_p.organization_id, v_p.project_id, v_p.phase_three_id, v_p.share_id, v_p.intent, v_p.client_words,
     'message:' || v_p.message_id, v_p.conversation_id, v_p.selected_theme_option_id, v_p.selected_color_option_id,
     v_p.reference_url, v_p.reference_note, 'project_manager')
  returning id into v_new;

  if v_p.intent = 'client_selected' and v_p.selected_theme_option_id is not null then
    update projects.theme_options set client_status = 'selected'
     where id = v_p.selected_theme_option_id and client_status in ('shared', 'change_requested');
    if v_p.selected_color_option_id is not null then
      update projects.color_options set client_status = 'selected' where id = v_p.selected_color_option_id;
    end if;
  end if;
  if v_p.intent = 'design_change_request' and v_p.selected_theme_option_id is not null then
    update projects.theme_options set client_status = 'change_requested'
     where id = v_p.selected_theme_option_id and client_status = 'shared';
  end if;

  update projects.phase_three
     set state = case v_p.intent
                   when 'client_selected' then 'final_confirmation'
                   when 'design_change_request' then 'revision'
                   else 'waiting_client'
                 end
   where id = v_phase.id and state in ('waiting_client', 'client_review', 'revision', 'final_confirmation');

  -- A visual change request opens the revision round (the ceiling is a STOP, not an error).
  if v_p.intent = 'design_change_request' then
    if v_phase.client_revision_count >= v_phase.client_revision_limit then
      update projects.phase_three
         set state = 'revision_limit_escalation',
             blocked_reason = left(format('The client revision limit was reached: %s of %s rounds used. A person must decide continuation, scope or commercial handling before any further design work. Latest request: %s',
                                          v_phase.client_revision_count, v_phase.client_revision_limit, v_p.client_words), 500)
       where id = v_phase.id;
      perform core.emit_event(v_phase.organization_id, 'project.revision_limit_escalated', 'phase_three', v_phase.id,
        jsonb_build_object('projectId', v_phase.project_id, 'revisionCount', v_phase.client_revision_count, 'revisionLimit', v_phase.client_revision_limit));
    else
      v_round := v_phase.client_revision_count + 1;
      insert into projects.design_revisions
        (organization_id, project_id, phase_three_id, origin, from_theme_option_id, requested_changes, client_decision_id, round_number)
      values
        (v_phase.organization_id, v_phase.project_id, v_phase.id, 'client_revision', v_p.selected_theme_option_id, left(v_p.client_words, 4000), v_new, v_round)
      returning id into v_rev;
      update projects.phase_three set client_revision_count = client_revision_count + 1 where id = v_phase.id;
      perform core.emit_event(v_phase.organization_id, 'project.design_revision_opened', 'design_revision', v_rev,
        jsonb_build_object('projectId', v_phase.project_id, 'origin', 'client_revision', 'round', v_round));
    end if;
  end if;

  update projects.design_reply_proposals
     set status = 'applied', decision_id = v_new, revision_id = v_rev, resolved_at = now(),
         resolution_note = 'Applied by the project manager.'
   where id = v_p.id;

  perform core.record_audit(v_p.organization_id, 'client_design_decision.recorded', 'client_design_decision', v_new, null,
    jsonb_build_object('projectId', v_p.project_id, 'decision', v_p.intent, 'shareId', v_p.share_id, 'recordedBy', 'project_manager', 'proposalId', v_p.id));
  perform core.emit_event(v_p.organization_id,
    case v_p.intent when 'client_selected' then 'project.client_design_selected'
                    when 'client_reference' then 'project.client_reference_received'
                    else 'project.client_design_change_requested' end,
    'client_design_decision', v_new,
    jsonb_build_object('projectId', v_p.project_id, 'decision', v_p.intent));

  return query select case when v_p.intent = 'design_change_request' and v_rev is null then 'escalated' else 'applied' end::text, v_new, v_rev;
end;
$$;

revoke all on function projects.agent_apply_design_reply(uuid) from public, anon, authenticated;
grant execute on function projects.agent_apply_design_reply(uuid) to service_role;

-- ── the PM records that it asked the client a question ───────────────────

create or replace function projects.agent_mark_design_reply_asked(p_proposal_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update projects.design_reply_proposals set status = 'asked', resolved_at = now(),
         resolution_note = 'The project manager asked the client to clarify.'
   where id = p_proposal_id and status = 'proposed' and action = 'clarify';
  if not found then
    return query select 'not_applicable'::text; return;
  end if;
  return query select 'asked'::text;
end;
$$;
revoke all on function projects.agent_mark_design_reply_asked(uuid) from public, anon, authenticated;
grant execute on function projects.agent_mark_design_reply_asked(uuid) to service_role;

-- ── a person handles what the PM would not decide ──────────────────────────

create or replace function projects.accept_design_reply_proposal(
  p_proposal_id uuid,
  p_theme_option_id uuid default null,
  p_color_option_id uuid default null
)
returns table (
  -- 'accepted' | refusals: 'no_actor' | 'forbidden' | 'unknown_proposal' | 'not_waiting' | or the decision door's own outcome
  outcome     text,
  decision_id uuid,
  revision_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_p     projects.design_reply_proposals;
  v_theme uuid;
  v_color uuid;
  v_dec   record;
  v_rev   record;
  v_revid uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;
  select p.* into v_p from projects.design_reply_proposals p where p.id = p_proposal_id for update;
  if v_p.id is null then
    return query select 'unknown_proposal'::text, null::uuid, null::uuid; return;
  end if;
  if v_p.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;
  if v_p.status not in ('awaiting_person', 'asked', 'proposed') or v_p.intent in ('unclear', 'unrelated') then
    return query select 'not_waiting'::text, null::uuid, null::uuid; return;
  end if;

  v_theme := coalesce(p_theme_option_id, v_p.selected_theme_option_id);
  v_color := coalesce(p_color_option_id, v_p.selected_color_option_id);

  -- The person's own record, through the same door every other person uses.
  select * into v_dec from projects.record_client_design_decision(
    v_p.share_id, v_p.intent, v_p.client_words, v_theme, v_color, v_p.reference_url, v_p.reference_note, 'message:' || v_p.message_id);
  if v_dec.outcome is distinct from 'recorded' then
    return query select v_dec.outcome::text, null::uuid, null::uuid; return;
  end if;

  if v_p.intent = 'design_change_request' and v_theme is not null then
    select * into v_rev from projects.open_design_revision(v_theme, 'client_revision', v_p.client_words, v_dec.decision_id, null, null);
    v_revid := v_rev.revision_id;
  end if;

  update projects.design_reply_proposals
     set status = 'accepted', decision_id = v_dec.decision_id, revision_id = v_revid, resolved_by = v_actor, resolved_at = now()
   where id = v_p.id;

  perform core.record_audit(v_p.organization_id, 'design_reply.accepted', 'design_reply_proposal', v_p.id, null,
    jsonb_build_object('intent', v_p.intent, 'decisionId', v_dec.decision_id));

  return query select 'accepted'::text, v_dec.decision_id, v_revid;
end;
$$;
revoke all on function projects.accept_design_reply_proposal(uuid, uuid, uuid) from public, anon;
grant execute on function projects.accept_design_reply_proposal(uuid, uuid, uuid) to authenticated;

create or replace function projects.dismiss_design_reply_proposal(p_proposal_id uuid, p_note text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_p     projects.design_reply_proposals;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  select p.* into v_p from projects.design_reply_proposals p where p.id = p_proposal_id for update;
  if v_p.id is null then
    return query select 'unknown_proposal'::text; return;
  end if;
  if v_p.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if v_p.status not in ('awaiting_person', 'asked', 'proposed') then
    return query select 'not_waiting'::text; return;
  end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then
    return query select 'needs_note'::text; return;
  end if;
  update projects.design_reply_proposals
     set status = 'dismissed', resolved_by = v_actor, resolved_at = now(), resolution_note = left(btrim(p_note), 1000)
   where id = v_p.id;
  perform core.record_audit(v_p.organization_id, 'design_reply.dismissed', 'design_reply_proposal', v_p.id, null,
    jsonb_build_object('intent', v_p.intent));
  return query select 'dismissed'::text;
end;
$$;
revoke all on function projects.dismiss_design_reply_proposal(uuid, text) from public, anon;
grant execute on function projects.dismiss_design_reply_proposal(uuid, text) to authenticated;

notify pgrst, 'reload schema';
