-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3 begins where Phase 2 ends.
--
-- G-258 built `record_kickoff`, which closes Phase 2 and emits
-- `project.phase_three_ready`. Its own record said what that event was for:
--
--   *"Master section 9 Phase3Ready - the structured handoff out of Phase 2.
--   Nothing consumes it yet, exactly as Phase 1 emitted opportunity.handed_off
--   with no receiver until Phase 2 existed."*
--
-- This is that receiver, and it is the first Phase 3 unit for the same reason
-- G-250 was the first Phase 2 one: every later unit hangs off a workspace row,
-- and a phase with no row has nowhere to put a state.
--
-- ── what Phase 3 is, and the boundary that matters ──────────────────────
--
-- Master §1: Phase 3 *"does not create the complete final UI or functional
-- product"*. It converts approved context into **a locked visual direction** —
-- a finalized screen list, a screen-by-screen content baseline, a
-- client-approved theme and a client-approved colour combination — so that
-- Phase 4 does not re-decide any of it.
--
-- So there is no column here for a design, a prototype, a component or a
-- route. The same argument G-256 made for the operational plan: the boundary
-- is held by the schema having nowhere to put the thing it must not hold.
--
-- ── the state model is Master §14's, and waiting is not failure ─────────
--
-- Eleven states from `not_started` to `completed`, plus the waiting and
-- escalation states §14 and Master §22 name. `phase_two` made the same choice
-- and the reason holds: a `waiting_client` row carries the blocker, the owner
-- and the moment, and safe independent work continues around it.
--
-- Two of the waiting states are escalations rather than waits, and they are
-- listed as states rather than booleans because Master §16 and §17 both say
-- the workflow must **stop** at them rather than continue automatically:
-- `scope_escalation` and `revision_limit_escalation`.
--
-- ── one per project, and that IS the idempotency ────────────────────────
--
-- Master §3: *"Phase 3 has not already been started for the same
-- project/version."* Master §22: a duplicate event must *"return existing
-- artifact/version idempotently."* A UNIQUE column and a row lock answer both,
-- the same way `phase_two.project_id` does — a replayed event, two overlapping
-- runner invocations and a manual repair all collide at the constraint rather
-- than producing two workspaces.
--
-- ── what it REFERENCES rather than copies ───────────────────────────────
--
-- The phase-two row, and nothing else. Every fact Phase 3 needs — the accepted
-- quotation, the approved scope, the operational plan, the kickoff evidence,
-- the client's confirmed preferences — is owned by a row an earlier phase
-- already wrote. Master §6's first cost-control line is *"reuse Phase 1
-- requirements, Phase 2 onboarding data and Project Planning output"*, and a
-- copy here would be a second source that drifts from the first.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.phase_three (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- Master §3 and §22, as a constraint rather than a check somebody remembers.
  project_id       uuid not null unique references projects.projects(id) on delete cascade,

  -- The phase this one continues. A REFERENCE: its handoff packet, its
  -- onboarding answers and its kickoff evidence stay where Phase 2 wrote them.
  phase_two_id     uuid not null references projects.phase_two(id) on delete restrict,

  -- Master §14's state machine.
  state            text not null default 'context_loading' check (state in (
                     'not_started',
                     'context_loading',
                     'screen_definition',
                     'theme_generation',
                     'internal_review',
                     'admin_review',
                     'client_review',
                     'revision',
                     'final_confirmation',
                     'locked',
                     'completed',
                     -- Master §14's waiting states. Not failures.
                     'waiting_client',
                     'waiting_admin',
                     'waiting_review',
                     'waiting_designer',
                     'blocked_requirement',
                     -- Master §16 and §17: the workflow STOPS at these two.
                     'scope_escalation',
                     'revision_limit_escalation'
                   )),

  -- Master §4's actor table. Three owners, three columns, because Master §8
  -- requires the Admin Panel to show WHO owns the phase right now and a single
  -- `owner` column cannot answer that for a phase with three roles.
  pm_agent_key       text not null default 'project_manager' references ai.agents(key) on delete restrict,
  designer_agent_key text not null default 'ui_designer' references ai.agents(key) on delete restrict,
  -- The internal reviewer is a PERSON, not an agent. Master §4 lists "Internal
  -- Design Reviewer" as an actor that must not own client-facing approval, and
  -- Designer §5 forbids the Designer bypassing it. Null until assigned, which
  -- is a real state: a project whose reviewer nobody has named is a project
  -- whose internal gate has no owner, and that is worth being able to see.
  reviewer_user_id   uuid references core.users(id) on delete set null,

  -- Master §16: "revision counter and origin must be visible". Client rounds
  -- only — Master §9 of the PM specification is explicit that the count
  -- increments for client-requested rounds, not for internal or Admin ones,
  -- because the limit exists to bound what the CLIENT can ask for.
  client_revision_count int not null default 0 check (client_revision_count >= 0),

  -- Master §16, "approximately 2-3": a configurable policy rather than a
  -- literal, because §16 says "configured limit" four times and a number
  -- compiled into a door is not configured.
  client_revision_limit int not null default 3
                          check (client_revision_limit between 1 and 10),

  -- Why it is waiting or stopped, in the words a person reads.
  blocked_reason   text check (blocked_reason is null or length(btrim(blocked_reason)) between 1 and 500),

  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A completed phase says when. The same shape `phase_two` uses, and the same
  -- reason: "completed" with no moment is a state nobody can audit.
  constraint phase_three_completion_is_dated
    check (state <> 'completed' or completed_at is not null),

  -- Master §22: a stopped or waiting phase must SHOW why. `blocked_requirement`
  -- and both escalations are the states a person has to act on, so they may not
  -- be entered silently.
  constraint phase_three_stop_says_why
    check (state not in ('blocked_requirement', 'scope_escalation', 'revision_limit_escalation')
           or (blocked_reason is not null and length(btrim(blocked_reason)) > 0))
);

create index if not exists phase_three_state_idx
  on projects.phase_three (organization_id, state);

comment on table projects.phase_three is
  'Master section 14 - the Phase 3 workspace. One per project, which is the idempotency section 3 and section 22 both ask for. It REFERENCES phase_two rather than copying it: every fact Phase 3 needs is owned by a row an earlier phase wrote, and section 6 asks for reuse rather than duplication. There is no column for a design, a prototype or a route - Phase 3 locks a direction and Phase 4 builds it.';

comment on column projects.phase_three.client_revision_count is
  'Master section 16. CLIENT rounds only: the PM specification section 9 says the count increments for client-requested rounds, because the limit bounds what the client may ask for, not how carefully the team reviews its own work.';

comment on column projects.phase_three.reviewer_user_id is
  'Master section 4 - the Internal Design Reviewer is a PERSON. Null until assigned, which is a real and visible state rather than a default: a project whose reviewer nobody has named has no owner for its internal gate.';

-- ── tenancy, exactly as every other org-scoped table carries it ──────────

drop trigger if exists org_match_phase_three_project on projects.phase_three;
create trigger org_match_phase_three_project
  before insert or update of project_id, organization_id on projects.phase_three
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_phase_three_phase_two on projects.phase_three;
create trigger org_match_phase_three_phase_two
  before insert or update of phase_two_id, organization_id on projects.phase_three
  for each row execute function core.enforce_parent_org('phase_two_id', 'projects.phase_two');

drop trigger if exists freeze_org_phase_three on projects.phase_three;
create trigger freeze_org_phase_three
  before update of organization_id on projects.phase_three
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_phase_three on projects.phase_three;
create trigger set_updated_at_phase_three
  before update on projects.phase_three
  for each row execute function core.set_updated_at();

alter table projects.phase_three enable row level security;
alter table projects.phase_three force row level security;

-- Internal-only, like every other phase workspace: a client sees the design
-- options PM shares with them, never the workflow state around them.
drop policy if exists phase_three_select on projects.phase_three;
create policy phase_three_select on projects.phase_three
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- No write policy, deliberately. Every mutation goes through a door below, the
-- same discipline every phase table in this repository keeps.

grant select on projects.phase_three to authenticated, service_role;

-- ── the event Master §15 names ───────────────────────────────────────────

insert into core.event_types (type, description, canonical) values
  ('project.phase_three_started',
   'Master section 15 Phase3Started - the Phase 3 workspace exists and UI finalization has begun. Consumed by the PM announcement and the design workflow.',
   true)
on conflict (type) do nothing;

-- ── the door ─────────────────────────────────────────────────────────────

create or replace function projects.start_phase_three(p_project_id uuid)
returns table (
  -- 'started' | 'already_started' | 'phase_two_incomplete' | 'no_phase_two'
  -- | 'unknown_project' | 'no_actor' | 'forbidden'
  outcome        text,
  phase_three_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := (select auth.uid());
  v_project   projects.projects;
  v_phase_two projects.phase_two;
  v_existing  projects.phase_three;
  v_new       uuid;
begin
  -- The service role starts Phase 3 because the trigger is an EVENT: Phase 2
  -- completed, and a job acts on it. A person may also start it — a repair
  -- after a lost event — which is why the actor path exists at all. The same
  -- shape `start_phase_two` uses, and for the same reason.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  -- Locked before anything is decided: two jobs for one project — a replayed
  -- event and a repair — must not both pass the existence check and both
  -- insert. The UNIQUE column would catch the second, but a refusal named
  -- `already_started` is a better answer than a constraint violation.
  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_project.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select p3.* into v_existing from projects.phase_three p3 where p3.project_id = v_project.id;
  if v_existing.id is not null then
    -- Master §22: "duplicate event/job - return existing artifact/version
    -- idempotently." The id comes back so a replay learns nothing new and
    -- breaks nothing.
    return query select 'already_started'::text, v_existing.id; return;
  end if;

  select pt.* into v_phase_two
    from projects.phase_two pt
   where pt.project_id = v_project.id;

  if v_phase_two.id is null then
    return query select 'no_phase_two'::text, null::uuid; return;
  end if;

  -- Master §3's first start condition, and Master §22's first failure row:
  -- "Phase 2 handoff incomplete - block Phase 3 start and show missing
  -- context." Read from the phase-two row rather than from the event that
  -- woke us: an event is a claim about the past and the row is the present.
  if v_phase_two.state <> 'completed' then
    return query select 'phase_two_incomplete'::text, null::uuid; return;
  end if;

  insert into projects.phase_three (organization_id, project_id, phase_two_id, state)
  values (v_project.organization_id, v_project.id, v_phase_two.id, 'context_loading')
  returning id into v_new;

  perform core.record_audit(
    v_project.organization_id,
    'project.phase_three_started',
    'phase_three',
    v_new,
    null,
    jsonb_build_object('projectId', v_project.id, 'phaseTwoId', v_phase_two.id)
  );

  perform core.emit_event(
    v_project.organization_id,
    'project.phase_three_started',
    'phase_three',
    v_new,
    jsonb_build_object('projectId', v_project.id, 'phaseTwoId', v_phase_two.id)
  );

  return query select 'started'::text, v_new;
end;
$$;

comment on function projects.start_phase_three(uuid) is
  'Master section 3 and section 22. Starts Phase 3 for a project whose Phase 2 is COMPLETED, reading that from the phase_two row rather than from the event that woke it - an event is a claim about the past and the row is the present. One workspace per project: a replay answers already_started with the existing id rather than raising, which is section 22s "return existing artifact idempotently". Refuses phase_two_incomplete by name so the remediation is somebody task rather than a mystery.';

revoke all on function projects.start_phase_three(uuid) from public, anon;
grant execute on function projects.start_phase_three(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
