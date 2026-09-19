-- ═══════════════════════════════════════════════════════════════════════════
-- A client answer is not a guess.
--
-- PM §12 gives six classifications and no seventh, and the whole table is one
-- idea: a client's reply is turned into a structured decision **and the words
-- they actually wrote are kept**.
--
--   CLIENT_SELECTED          they picked one
--   DESIGN_CHANGE_REQUEST    they want it different
--   CLIENT_REFERENCE         they sent something to look at
--   POSSIBLE_SCOPE_CHANGE    they asked for something that is not design
--   CLARIFICATION_REQUIRED   nobody can tell what they meant
--   FINAL_CONFIRMED          they confirmed the choice
--
-- ── the two sentences this unit is built around ────────────────────────
--
-- PM §4.5: *"Do not treat ambiguous feedback as final approval."*
-- PM §4.9: *"Do not rely on an informal assumption that the client 'seems
-- okay'."*
--
-- Both are about the same failure, and both are structural here rather than
-- advisory. **A final confirmation must name the exact theme and the exact
-- colour**, and both must be options that client was actually shown — not the
-- current favourites, not what somebody remembers. A confirmation that cannot
-- point at what was confirmed is the informal assumption §4.9 forbids, wearing
-- a status.
--
-- And `CLARIFICATION_REQUIRED` exists precisely so an unclear reply has
-- somewhere to go that is not an approval. Without it, a PM facing *"looks
-- good but can we talk"* has to choose between two wrong answers.
--
-- ── the client's own words, always ─────────────────────────────────────
--
-- PM §4.5 and Master §8 both require the original message to be preserved, and
-- §19's ClientDesignDecision carries *"feedback, evidence"*. So `client_words`
-- is NOT NULL on every classification: an interpretation this system cannot
-- show the source of is this system's opinion about a client, recorded as if
-- it were the client's.
--
-- The same rule `crm.qualification_coverage` has carried since August — *"a
-- coverage row that cannot point at what it read is an assertion"* — applied
-- to the one conversation where the stakes are a signed-off visual direction.
--
-- ── scope is routed, never designed ────────────────────────────────────
--
-- Master §17 and PM §18: a request for new functionality *"is not automatically
-- a design revision"*. `POSSIBLE_SCOPE_CHANGE` is therefore a classification a
-- PM records and **not** something that produces a revision. What happens next
-- is `projects.change_requests`, which has existed since Doc 11 and already
-- refuses to become a priced change without an approved proposal behind it.
--
-- Nothing here creates one automatically. Master §17's instruction is to
-- *"route to the appropriate requirement/scope/change workflow"*, and routing
-- means a person decides, with the client's words in front of them.
--
-- ── what this door does not do ─────────────────────────────────────────
--
-- **It does not revise anything.** A `DESIGN_CHANGE_REQUEST` is a recorded
-- request; turning it into a new theme version, counting it against the 2–3
-- limit and escalating past that limit is the revision engine, which is its
-- own unit and its own set of refusals.
--
-- **It does not lock.** `FINAL_CONFIRMED` records what the client confirmed;
-- freezing the direction and building the Phase 4 handoff is the lock unit.
-- The option's own `client_status` reaches `selected` here and `locked` only
-- there, and G-279's row rule already refuses `locked` on anything Admin never
-- approved.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.client_design_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  phase_three_id   uuid not null references projects.phase_three(id) on delete cascade,

  -- Which set of options the client was answering. A decision that cannot say
  -- what the client was looking at is a decision about nothing — and G-282
  -- froze exactly that, so this points at a record of what they SAW rather
  -- than at options that may have moved since.
  share_id         uuid not null references projects.client_design_shares(id) on delete restrict,

  -- PM §12's six, and no seventh.
  decision         text not null check (decision in (
                     'client_selected',
                     'design_change_request',
                     'client_reference',
                     'possible_scope_change',
                     'clarification_required',
                     'final_confirmed'
                   )),

  -- PM §4.5 and Master §8: the original message, always. An interpretation
  -- this system cannot show the source of is its own opinion about a client.
  client_words     text not null check (length(btrim(client_words)) between 1 and 4000),

  -- Where those words came from, so somebody can go and read them in context.
  evidence_ref     text,
  conversation_id  uuid references crm.conversations(id) on delete set null,

  -- What they picked, when they picked. Both, or neither: a colour chosen
  -- against no direction is a swatch (§12), and a direction chosen with no
  -- palette is half an answer.
  selected_theme_option_id uuid references projects.theme_options(id) on delete restrict,
  selected_color_option_id uuid references projects.color_options(id) on delete restrict,

  -- §12's "shares own reference": what they sent us to look at.
  reference_url    text,
  reference_note   text,

  recorded_by      uuid not null references core.users(id) on delete restrict,
  created_at       timestamptz not null default now(),

  -- PM §4.9, as a row rule. A final confirmation that cannot name the exact
  -- theme AND the exact colour is the informal assumption §4.9 forbids.
  constraint client_decisions_final_names_both
    check (decision <> 'final_confirmed'
           or (selected_theme_option_id is not null and selected_color_option_id is not null)),

  -- A selection names at least the direction. The palette may follow.
  constraint client_decisions_selection_names_a_theme
    check (decision <> 'client_selected' or selected_theme_option_id is not null),

  -- §12: a reference is a thing to look at. One without either a link or a
  -- note is a classification with no content.
  constraint client_decisions_reference_has_content
    check (decision <> 'client_reference'
           or (coalesce(btrim(reference_url), '') <> ''
               or coalesce(btrim(reference_note), '') <> ''))
);

create index if not exists client_design_decisions_project_idx
  on projects.client_design_decisions (organization_id, project_id, created_at desc);

comment on table projects.client_design_decisions is
  'PM section 12s six classifications and no seventh. client_words is NOT NULL on every one of them: PM section 4.5 and Master section 8 both require the original message, and an interpretation this system cannot show the source of is its own opinion about a client recorded as if it were the clients. A final confirmation must name the exact theme AND colour - PM section 4.9 forbids relying on an informal assumption that the client seems okay, and a confirmation that cannot point at what was confirmed is exactly that assumption wearing a status.';

comment on column projects.client_design_decisions.share_id is
  'Which set of options the client was answering. G-282 froze what was actually shown, so this points at a record of what they SAW rather than at options that may have been revised since.';

-- History, not a worksheet: a client said what they said.
create or replace function projects.freeze_client_design_decision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'a client decision is a record of what the client said; record a new one instead'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists freeze_client_design_decision on projects.client_design_decisions;
create trigger freeze_client_design_decision
  before update on projects.client_design_decisions
  for each row execute function projects.freeze_client_design_decision();

drop trigger if exists org_match_decisions_project on projects.client_design_decisions;
create trigger org_match_decisions_project
  before insert or update of project_id, organization_id on projects.client_design_decisions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_decisions_phase on projects.client_design_decisions;
create trigger org_match_decisions_phase
  before insert or update of phase_three_id, organization_id on projects.client_design_decisions
  for each row execute function core.enforce_parent_org('phase_three_id', 'projects.phase_three');

drop trigger if exists org_match_decisions_share on projects.client_design_decisions;
create trigger org_match_decisions_share
  before insert or update of share_id, organization_id on projects.client_design_decisions
  for each row execute function core.enforce_parent_org('share_id', 'projects.client_design_shares');

drop trigger if exists org_match_decisions_theme on projects.client_design_decisions;
create trigger org_match_decisions_theme
  before insert or update of selected_theme_option_id, organization_id on projects.client_design_decisions
  for each row execute function core.enforce_parent_org('selected_theme_option_id', 'projects.theme_options');

drop trigger if exists org_match_decisions_color on projects.client_design_decisions;
create trigger org_match_decisions_color
  before insert or update of selected_color_option_id, organization_id on projects.client_design_decisions
  for each row execute function core.enforce_parent_org('selected_color_option_id', 'projects.color_options');

drop trigger if exists org_match_decisions_conversation on projects.client_design_decisions;
create trigger org_match_decisions_conversation
  before insert or update of conversation_id, organization_id on projects.client_design_decisions
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists freeze_org_client_design_decisions on projects.client_design_decisions;
create trigger freeze_org_client_design_decisions
  before update of organization_id on projects.client_design_decisions
  for each row execute function core.freeze_organization_id();

alter table projects.client_design_decisions enable row level security;
alter table projects.client_design_decisions force row level security;

drop policy if exists client_design_decisions_select on projects.client_design_decisions;
create policy client_design_decisions_select on projects.client_design_decisions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.client_design_decisions to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.client_design_selected',
   'Master section 15 ClientDesignSelected - the client picked a direction. Not a lock: the lock unit freezes it and builds the Phase 4 handoff.',
   true),
  ('project.client_design_change_requested',
   'Master section 15 ClientDesignChangeRequested - the client wants a visual change. The revision engine counts it against the configured limit.',
   true),
  ('project.client_reference_received',
   'Master section 15 ClientReferenceReceived - the client sent something to look at.',
   true),
  ('project.possible_scope_change_detected',
   'Master section 15 PossibleScopeChangeDetected - the client asked for something that is not a design change. Routed to the scope workflow by a PERSON; nothing here creates a change request automatically.',
   true),
  ('project.client_final_design_confirmed',
   'Master section 15 ClientFinalDesignConfirmed - the client confirmed an exact theme and colour. The lock unit consumes it.',
   true)
on conflict (type) do nothing;

-- ── the door ────────────────────────────────────────────────────────────

create or replace function projects.record_client_design_decision(
  p_share_id       uuid,
  p_decision       text,
  p_client_words   text,
  p_theme_option_id uuid default null,
  p_color_option_id uuid default null,
  p_reference_url  text default null,
  p_reference_note text default null,
  p_evidence_ref   text default null
)
returns table (
  -- 'recorded' | 'unknown_share' | 'bad_decision' | 'no_client_words'
  -- | 'not_shown' | 'needs_selection' | 'needs_both' | 'needs_reference'
  -- | 'color_not_of_theme' | 'no_actor' | 'forbidden'
  outcome     text,
  decision_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_share  projects.client_design_shares;
  v_phase3 projects.phase_three;
  v_words  text := nullif(btrim(coalesce(p_client_words, '')), '');
  v_shown  boolean;
  v_new    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if p_decision not in ('client_selected', 'design_change_request', 'client_reference',
                        'possible_scope_change', 'clarification_required', 'final_confirmed') then
    return query select 'bad_decision'::text, null::uuid; return;
  end if;

  -- PM §4.5 and Master §8, refused on the argument. Every classification
  -- carries the client's own words; there is no shape of this call that
  -- records an interpretation with no source.
  if v_words is null then
    return query select 'no_client_words'::text, null::uuid; return;
  end if;

  select s.* into v_share from projects.client_design_shares s where s.id = p_share_id;
  if v_share.id is null then
    return query select 'unknown_share'::text, null::uuid; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.id = v_share.phase_three_id
   for update;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- PM §4.9, and the reason the share is frozen. A confirmation must name
  -- both; a selection must name at least the direction.
  if p_decision = 'final_confirmed'
     and (p_theme_option_id is null or p_color_option_id is null) then
    return query select 'needs_both'::text, null::uuid; return;
  end if;

  if p_decision = 'client_selected' and p_theme_option_id is null then
    return query select 'needs_selection'::text, null::uuid; return;
  end if;

  if p_decision = 'client_reference'
     and coalesce(btrim(coalesce(p_reference_url, '')), '') = ''
     and coalesce(btrim(coalesce(p_reference_note, '')), '') = '' then
    return query select 'needs_reference'::text, null::uuid; return;
  end if;

  -- ── THE RULE PM §4.9 IS ASKING FOR ─────────────────────────────────────
  --
  -- A client can only choose from what they were SHOWN. Checked against the
  -- frozen snapshot G-282 wrote, not against the options as they stand now:
  -- an option revised since the share is not the thing the client saw, and
  -- accepting it here would record a confirmation of something else.
  if p_theme_option_id is not null then
    select exists (
      select 1
        from jsonb_array_elements(v_share.shared_options) o
       where (o->>'themeOptionId')::uuid = p_theme_option_id
    ) into v_shown;

    if not v_shown then
      return query select 'not_shown'::text, null::uuid; return;
    end if;
  end if;

  -- §12: a colour belongs to a direction. A palette from a different theme is
  -- not an answer to this one.
  if p_color_option_id is not null then
    if not exists (
      select 1 from projects.color_options c
       where c.id = p_color_option_id
         and c.theme_option_id = p_theme_option_id
    ) then
      return query select 'color_not_of_theme'::text, null::uuid; return;
    end if;
  end if;

  insert into projects.client_design_decisions (
    organization_id, project_id, phase_three_id, share_id, decision, client_words,
    evidence_ref, conversation_id, selected_theme_option_id, selected_color_option_id,
    reference_url, reference_note, recorded_by
  ) values (
    v_phase3.organization_id, v_share.project_id, v_phase3.id, v_share.id, p_decision, v_words,
    nullif(btrim(coalesce(p_evidence_ref, '')), ''), v_share.conversation_id,
    p_theme_option_id, p_color_option_id,
    nullif(btrim(coalesce(p_reference_url, '')), ''),
    nullif(btrim(coalesce(p_reference_note, '')), ''),
    v_actor
  )
  returning id into v_new;

  -- The option records that the client chose it. `selected`, never `locked`:
  -- locking is the lock unit's act, and G-279's row rule already refuses
  -- `locked` on anything Admin never approved.
  if p_decision in ('client_selected', 'final_confirmed') and p_theme_option_id is not null then
    update projects.theme_options set client_status = 'selected'
     where id = p_theme_option_id and client_status in ('shared', 'change_requested');
    if p_color_option_id is not null then
      update projects.color_options set client_status = 'selected' where id = p_color_option_id;
    end if;
  end if;

  if p_decision = 'design_change_request' and p_theme_option_id is not null then
    update projects.theme_options set client_status = 'change_requested'
     where id = p_theme_option_id and client_status = 'shared';
  end if;

  -- §14's states. A scope question stops the phase rather than continuing it
  -- — Master §17: new functionality is not automatically a design revision,
  -- and a person decides what happens next.
  update projects.phase_three
     set state = case p_decision
                   when 'final_confirmed'         then 'final_confirmation'
                   when 'client_selected'         then 'final_confirmation'
                   when 'design_change_request'   then 'revision'
                   when 'possible_scope_change'   then 'scope_escalation'
                   else 'waiting_client'
                 end,
         blocked_reason = case p_decision
                            when 'possible_scope_change'
                              then left('The client asked for something that may be new scope: ' || v_words, 500)
                            else blocked_reason
                          end
   where id = v_phase3.id
     and state in ('waiting_client', 'client_review', 'revision', 'final_confirmation');

  perform core.record_audit(
    v_phase3.organization_id, 'client_design_decision.recorded', 'client_design_decision', v_new, null,
    jsonb_build_object('projectId', v_share.project_id, 'decision', p_decision, 'shareId', v_share.id)
  );

  perform core.emit_event(
    v_phase3.organization_id,
    case p_decision
      when 'client_selected'        then 'project.client_design_selected'
      when 'final_confirmed'        then 'project.client_final_design_confirmed'
      when 'design_change_request'  then 'project.client_design_change_requested'
      when 'client_reference'       then 'project.client_reference_received'
      when 'possible_scope_change'  then 'project.possible_scope_change_detected'
      else 'project.client_design_change_requested'
    end,
    'client_design_decision', v_new,
    jsonb_build_object('projectId', v_share.project_id, 'decision', p_decision)
  );

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function projects.record_client_design_decision(uuid, text, text, uuid, uuid, text, text, text) is
  'PM section 12. Turns a client reply into one of six classifications and keeps the words they wrote - client_words is refused when empty, on every classification, because an interpretation this system cannot show the source of is its own opinion about a client. A CLIENT CAN ONLY CHOOSE FROM WHAT THEY WERE SHOWN, checked against the frozen share snapshot rather than the options as they stand now: an option revised since the share is not the thing the client saw. A final confirmation must name the exact theme AND colour (PM section 4.9). It does not revise and it does not lock: a change request is a recorded request for the revision engine, and a confirmation is consumed by the lock unit. A possible scope change STOPS the phase and records why - Master section 17 says new functionality is not automatically a design revision, and routing means a person decides.';

revoke all on function projects.record_client_design_decision(uuid, text, text, uuid, uuid, text, text, text) from public, anon;
grant execute on function projects.record_client_design_decision(uuid, text, text, uuid, uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';
