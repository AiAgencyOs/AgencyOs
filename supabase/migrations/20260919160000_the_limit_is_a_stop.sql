-- ═══════════════════════════════════════════════════════════════════════════
-- The limit is a stop, not a suggestion.
--
-- Master §16, PM §4.6–4.8 and §9, Designer §4.8 and §16. Four documents state
-- the same loop and the same ceiling:
--
--   CLIENT CHANGE REQUEST → PM CAPTURES → DESIGNER REVISION → INTERNAL REVIEW
--   → ADMIN REVIEW → PM RE-SHARE → CLIENT REVIEW     (max ≈ 2–3 rounds)
--
-- G-283 recorded the client's answer. This is what a `design_change_request`
-- becomes: a **structured request**, counted, and stopped.
--
-- ── the sentence this unit exists for ──────────────────────────────────
--
-- PM §4.8: *"When configured revision limit is reached/exceeded, **do not
-- continue an endless generation loop**. Create human escalation with revision
-- history, client requests and current state."*
--
-- Master §16 says the same in one line: *"Beyond allowed iterations, create
-- human escalation **rather than automatically continuing**."*
--
-- Read those twice, because they are not asking for a refusal. A door that
-- answered `limit_reached` and changed nothing would leave the phase sitting in
-- `revision` — a state that claims a designer is working — while in fact
-- nothing will ever happen again. The client would be waiting on a loop that
-- has quietly stopped. **So passing the limit is not an error return; it is a
-- state transition.** The phase moves to `revision_limit_escalation`, the
-- reason names the count and the limit, and the door reports `escalated`
-- rather than `opened`. G-277 made that state unenterable without a reason
-- precisely so this unit could not skip the explanation.
--
-- And once the phase is there, Designer §16 finishes the thought: the designer
-- *"waits for escalation outcome."* A further revision is refused
-- (`escalation_open`) rather than silently resuming the loop a person was
-- asked to decide about.
--
-- ── the count is client-only, and that is a rule not an accident ───────
--
-- PM §9: *"Revision count is incremented **only** for client-requested
-- rounds."*
--
-- This is the distinction the whole ceiling rests on. An Admin EDIT and an
-- internal `changes_required` are both revisions — they return the option to
-- the designer and they belong in the history §19 asks for — but they are the
-- agency correcting its own work before the client ever sees it. Counting them
-- would spend the client's two or three rounds on work the client never asked
-- for and never saw, and a careful internal review would make the limit arrive
-- sooner. The internal gates would start costing the client rounds, which is
-- the exact opposite of what they are for.
--
-- So all three origins create a revision row; **one of them moves the
-- counter.**
--
-- ── a client revision must be able to point at the client ──────────────
--
-- Designer §16: *"Client feedback arrives as a **structured request linked to
-- source evidence**."* A `client_revision` therefore requires the
-- `client_design_decisions` row that asked for it — refused in DDL, not by a
-- service that could forget — and that row is also the **idempotency key**:
-- one client decision opens one revision, so a retried job returns the
-- revision it already opened instead of burning a round.
--
-- ── and the cited decision must actually be a design change ────────────
--
-- Master §17: *"New client-requested functionality is **not automatically a
-- design revision**."* Designer §4.8: *"Do not treat new functionality as
-- normal visual feedback."*
--
-- G-283 gave `possible_scope_change` its own classification. This is where that
-- classification earns its keep: a revision citing one is refused
-- (`not_a_design_change`). Without this check the two documents' rule would be
-- enforced only by whoever chose which decision id to pass — which is to say,
-- not enforced. A scope question would become a design round, and the client
-- would pay a revision for asking about a feature.
--
-- ── what this door does not do ─────────────────────────────────────────
--
-- **It does not draw anything.** No theme option is created here. The revision
-- is the *request*; the new version is the designer's generation unit, and it
-- links back through `theme_options.revision_of` which G-279 already built.
-- That separation is why `to_theme_option_id` is nullable and filled later:
-- a request that had to carry its own answer could not be made before the
-- answer existed.
--
-- **It does not reset the gates.** G-280 already returns an edited option to
-- `changes_required`, and G-283 already marks a client-changed option
-- `change_requested`. Doing it again here would be a second owner for one
-- rule.
--
-- **It does not erase anything.** Designer §20: *"A new revision must not erase
-- a previously reviewed or client-shared version."* The from-option is
-- referenced, never updated.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.design_revisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  phase_three_id   uuid not null references projects.phase_three(id) on delete cascade,

  -- §19's "origin". The same three words `theme_options.origin` already uses,
  -- minus `initial` — a first draft is not a revision. Reused rather than
  -- reinvented so the request and the artifact it produces cannot disagree
  -- about what kind of round this was.
  origin           text not null
                     check (origin in ('internal_review', 'admin_edit', 'client_revision')),

  -- §19's "from/to version". `to` is nullable because the request is made
  -- before the answer exists.
  from_theme_option_id uuid not null references projects.theme_options(id) on delete cascade,
  to_theme_option_id   uuid references projects.theme_options(id) on delete set null,

  -- §19's "requested changes". Required on every origin: a revision nobody can
  -- read the request for is a designer guessing what was wrong.
  requested_changes text not null check (length(btrim(requested_changes)) between 1 and 4000),

  status           text not null default 'open'
                     check (status in ('open', 'in_progress', 'delivered', 'cancelled')),

  -- The source evidence, per origin. A client revision's is mandatory below.
  client_decision_id uuid references projects.client_design_decisions(id) on delete restrict,
  design_review_id   uuid references projects.design_reviews(id) on delete set null,
  admin_decision_id  uuid references projects.admin_design_decisions(id) on delete set null,

  -- Master §16: "revision counter and origin must be visible." The round this
  -- revision IS, frozen at the moment it was opened, so the history reads
  -- correctly even after the counter has moved on.
  round_number     int check (round_number > 0),

  opened_by        uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Designer §16's "linked to source evidence", in DDL.
  constraint design_revisions_client_origin_cites_the_client
    check (origin <> 'client_revision' or client_decision_id is not null),

  -- A round number belongs to a client round and to nothing else. Written as
  -- an equivalence rather than two one-way checks so an internal revision
  -- cannot quietly acquire one and appear in the client's count.
  constraint design_revisions_round_is_client_only
    check ((origin = 'client_revision') = (round_number is not null)),

  -- A delivered revision produced something. Until then `to` is empty, which
  -- is the honest reading of "the designer has not finished".
  constraint design_revisions_delivered_has_a_version
    check (status <> 'delivered' or to_theme_option_id is not null),

  -- A revision cannot be its own answer.
  constraint design_revisions_to_is_not_from
    check (to_theme_option_id is null or to_theme_option_id <> from_theme_option_id),

  -- THE IDEMPOTENCY KEY. One client decision opens one revision: a retried job
  -- must return the round it already opened, not spend another one.
  unique (client_decision_id)
);

comment on table projects.design_revisions is
  'Master section 19 DesignRevision. The REQUEST, not the drawing: from/to version, origin, requested changes, status. All three origins create a row; ONLY client_revision moves phase_three.client_revision_count, because an Admin EDIT and an internal changes_required are the agency correcting its own work before the client saw it - counting them would spend the client rounds on work they never asked for, and a careful internal review would make the limit arrive sooner.';

comment on column projects.design_revisions.round_number is
  'Master section 16 "revision counter and origin must be visible". The round this revision IS, frozen when it was opened, so history reads correctly after the counter moves on. Null on every non-client origin, by constraint.';

comment on column projects.design_revisions.client_decision_id is
  'Designer section 16 "linked to source evidence", and the idempotency key. Required when origin is client_revision. Unique, so one client decision opens one revision and a retry returns it instead of burning a round.';

create index if not exists design_revisions_phase_idx
  on projects.design_revisions (phase_three_id, created_at desc);
create index if not exists design_revisions_from_idx
  on projects.design_revisions (from_theme_option_id);

-- ── tenancy, on every org-scoped foreign key ────────────────────────────

create trigger design_revisions_parent_org_project
  before insert or update of project_id on projects.design_revisions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

create trigger design_revisions_parent_org_phase
  before insert or update of phase_three_id on projects.design_revisions
  for each row execute function core.enforce_parent_org('phase_three_id', 'projects.phase_three');

create trigger design_revisions_parent_org_from
  before insert or update of from_theme_option_id on projects.design_revisions
  for each row execute function core.enforce_parent_org('from_theme_option_id', 'projects.theme_options');

create trigger design_revisions_parent_org_to
  before insert or update of to_theme_option_id on projects.design_revisions
  for each row execute function core.enforce_parent_org('to_theme_option_id', 'projects.theme_options');

create trigger design_revisions_parent_org_decision
  before insert or update of client_decision_id on projects.design_revisions
  for each row execute function core.enforce_parent_org('client_decision_id', 'projects.client_design_decisions');

create trigger design_revisions_parent_org_review
  before insert or update of design_review_id on projects.design_revisions
  for each row execute function core.enforce_parent_org('design_review_id', 'projects.design_reviews');

create trigger design_revisions_parent_org_admin
  before insert or update of admin_decision_id on projects.design_revisions
  for each row execute function core.enforce_parent_org('admin_decision_id', 'projects.admin_design_decisions');

create trigger freeze_org_design_revisions
  before update of organization_id on projects.design_revisions
  for each row execute function core.freeze_organization_id();

create trigger design_revisions_updated_at
  before update on projects.design_revisions
  for each row execute function core.set_updated_at();

-- Master §16 and Designer §20: the ROUND is history. A delivered revision may
-- record what it produced and a live one may be cancelled, but the origin, the
-- request, the round it was and what it started from are what the counter was
-- spent on — and history that can be rewritten is not history.
create or replace function projects.freeze_design_revision_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.origin is distinct from old.origin
     or new.requested_changes is distinct from old.requested_changes
     or new.round_number is distinct from old.round_number
     or new.from_theme_option_id is distinct from old.from_theme_option_id
     or new.client_decision_id is distinct from old.client_decision_id then
    raise exception 'a design revision records what was asked and which round it was; those cannot be edited';
  end if;
  return new;
end;
$$;

create trigger freeze_design_revision_history
  before update on projects.design_revisions
  for each row execute function projects.freeze_design_revision_history();

alter table projects.design_revisions enable row level security;
alter table projects.design_revisions force row level security;

drop policy if exists design_revisions_select on projects.design_revisions;
create policy design_revisions_select on projects.design_revisions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.design_revisions to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.design_revision_opened',
   'Master section 19 DesignRevision. A revision round was opened against a theme option. The payload carries the origin; only a client_revision spent a round.',
   true),
  ('project.revision_limit_escalated',
   'Master section 16 and PM section 4.8 - the configured client revision limit was reached and the phase STOPPED. A person decides continuation, scope or commercial handling; nothing resumes the loop automatically.',
   true)
on conflict (type) do nothing;

-- ── the door ────────────────────────────────────────────────────────────

create or replace function projects.open_design_revision(
  p_from_theme_option_id uuid,
  p_origin               text,
  p_requested_changes    text,
  p_client_decision_id   uuid default null,
  p_design_review_id     uuid default null,
  p_admin_decision_id    uuid default null
)
returns table (
  -- 'opened'    a revision round was created
  -- 'exists'    this client decision already opened one (idempotent retry)
  -- 'escalated' the limit was reached; the PHASE STOPPED and nobody drew
  -- refusals: 'no_actor' | 'forbidden' | 'bad_origin' | 'no_requested_changes'
  --           | 'unknown_option' | 'needs_client_decision'
  --           | 'not_a_design_change' | 'decision_not_for_this_option'
  --           | 'escalation_open'
  outcome     text,
  revision_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_changes  text := nullif(btrim(coalesce(p_requested_changes, '')), '');
  v_option   projects.theme_options;
  v_phase3   projects.phase_three;
  v_decision projects.client_design_decisions;
  v_round    int;
  v_existing uuid;
  v_new      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  -- ── argument-only refusals, before any row is read ────────────────────

  if p_origin not in ('internal_review', 'admin_edit', 'client_revision') then
    return query select 'bad_origin'::text, null::uuid; return;
  end if;

  if v_changes is null then
    return query select 'no_requested_changes'::text, null::uuid; return;
  end if;

  if p_origin = 'client_revision' and p_client_decision_id is null then
    return query select 'needs_client_decision'::text, null::uuid; return;
  end if;

  select t.* into v_option
    from projects.theme_options t
   where t.id = p_from_theme_option_id;

  if v_option.id is null then
    return query select 'unknown_option'::text, null::uuid; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.id = v_option.phase_three_id
   for update;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- Designer §16: once a person has been asked to decide, the designer
  -- "waits for escalation outcome". Resuming the loop here would answer a
  -- question that was put to a human.
  if v_phase3.state = 'revision_limit_escalation' then
    return query select 'escalation_open'::text, null::uuid; return;
  end if;

  -- ── the cited client decision, and what it is allowed to be ───────────

  if p_client_decision_id is not null then
    select d.* into v_decision
      from projects.client_design_decisions d
     where d.id = p_client_decision_id
       and d.phase_three_id = v_phase3.id;

    if v_decision.id is null then
      return query select 'decision_not_for_this_option'::text, null::uuid; return;
    end if;

    -- Master §17 and Designer §4.8. A scope question is not a design round,
    -- and G-283 gave it its own classification so that this line could exist.
    if v_decision.decision <> 'design_change_request' then
      return query select 'not_a_design_change'::text, null::uuid; return;
    end if;

    -- The client commented on an option. Revising a different one would
    -- charge them a round for work they never asked about.
    if v_decision.selected_theme_option_id is distinct from p_from_theme_option_id then
      return query select 'decision_not_for_this_option'::text, null::uuid; return;
    end if;

    -- The idempotency key, read before the limit is touched: a retry must not
    -- be able to trip an escalation the first call did not.
    select r.id into v_existing
      from projects.design_revisions r
     where r.client_decision_id = p_client_decision_id;

    if v_existing is not null then
      return query select 'exists'::text, v_existing; return;
    end if;
  end if;

  -- ── the ceiling (Master §16, PM §4.8) ─────────────────────────────────
  --
  -- Only a client round is counted, and only a client round can reach the
  -- limit. Passing it is a STATE TRANSITION, not an error return: answering
  -- "limit reached" and changing nothing would leave the phase claiming a
  -- designer is working while in fact the loop has silently stopped.

  if p_origin = 'client_revision' then
    if v_phase3.client_revision_count >= v_phase3.client_revision_limit then
      update projects.phase_three
         set state = 'revision_limit_escalation',
             blocked_reason = left(format(
               'The client revision limit was reached: %s of %s rounds used. '
               || 'A person must decide continuation, scope or commercial handling '
               || 'before any further design work. Latest request: %s',
               v_phase3.client_revision_count, v_phase3.client_revision_limit, v_changes), 500)
       where id = v_phase3.id;

      perform core.record_audit(
        v_phase3.organization_id, 'phase_three.revision_limit_escalated', 'phase_three', v_phase3.id, null,
        jsonb_build_object('projectId', v_phase3.project_id,
                           'revisionCount', v_phase3.client_revision_count,
                           'revisionLimit', v_phase3.client_revision_limit)
      );

      perform core.emit_event(
        v_phase3.organization_id, 'project.revision_limit_escalated',
        'phase_three', v_phase3.id,
        jsonb_build_object('projectId', v_phase3.project_id,
                           'revisionCount', v_phase3.client_revision_count,
                           'revisionLimit', v_phase3.client_revision_limit)
      );

      return query select 'escalated'::text, null::uuid; return;
    end if;

    v_round := v_phase3.client_revision_count + 1;
  end if;

  insert into projects.design_revisions (
    organization_id, project_id, phase_three_id, origin, from_theme_option_id,
    requested_changes, client_decision_id, design_review_id, admin_decision_id,
    round_number, opened_by
  ) values (
    v_phase3.organization_id, v_option.project_id, v_phase3.id, p_origin, p_from_theme_option_id,
    v_changes, p_client_decision_id, p_design_review_id, p_admin_decision_id,
    v_round, v_actor
  )
  returning id into v_new;

  -- PM §9: "incremented ONLY for client-requested rounds."
  if p_origin = 'client_revision' then
    update projects.phase_three
       set client_revision_count = client_revision_count + 1
     where id = v_phase3.id;
  end if;

  update projects.phase_three
     set state = 'revision'
   where id = v_phase3.id
     and state in ('waiting_client', 'client_review', 'admin_review', 'internal_review', 'revision');

  perform core.record_audit(
    v_phase3.organization_id, 'design_revision.opened', 'design_revision', v_new, null,
    jsonb_build_object('projectId', v_option.project_id, 'origin', p_origin,
                       'fromThemeOptionId', p_from_theme_option_id, 'round', v_round)
  );

  perform core.emit_event(
    v_phase3.organization_id, 'project.design_revision_opened',
    'design_revision', v_new,
    jsonb_build_object('projectId', v_option.project_id, 'origin', p_origin, 'round', v_round)
  );

  return query select 'opened'::text, v_new;
end;
$$;

comment on function projects.open_design_revision(uuid, text, text, uuid, uuid, uuid) is
  'Master section 16 and 19, PM sections 4.6-4.8 and 9, Designer sections 4.8 and 16. Opens a revision ROUND; it does not draw. THE COUNT IS CLIENT-ONLY (PM section 9): an Admin EDIT and an internal changes_required create a revision and do not spend a client round, because they are the agency correcting its own work before the client saw it. PASSING THE LIMIT IS A STATE TRANSITION, NOT AN ERROR RETURN (PM section 4.8): the phase moves to revision_limit_escalation with the count, the limit and the request in the reason, and returns escalated - answering "limit reached" and changing nothing would leave the phase claiming a designer is working while the loop had silently stopped. Once escalated, a further revision is refused: Designer section 16 says the designer waits for the outcome. A client revision must cite the client_design_decisions row that asked for it, that row must be a design_change_request (Master section 17: new functionality is not automatically a design revision) and must name the option being revised; the citation is also the idempotency key, so a retried job returns the round it already opened instead of burning another.';

revoke all on function projects.open_design_revision(uuid, text, text, uuid, uuid, uuid) from public, anon;
grant execute on function projects.open_design_revision(uuid, text, text, uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
