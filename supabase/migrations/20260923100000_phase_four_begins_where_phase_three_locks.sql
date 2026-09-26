-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 begins where Phase 3 locks.
--
-- `projects.lock_phase_three_direction` (20260919180000, matured
-- 20260920000000) has emitted `project.phase_four_ready` since it was
-- written, the moment a locked handoff carries both the canonical Figma
-- artifact and a finalized design token set. Nothing has ever consumed it —
-- exactly the shape `project.phase_three_ready` was in before
-- 20260918140000, and G-258's own note about that gap applies here verbatim:
-- an event with no receiver is not a bug in the emitter.
--
-- This is the receiver, and the first Phase 4 unit for the same reason
-- `phase_three` was the first Phase 3 one: every later Phase 4 stage —
-- UI design, Design QA, Admin/client review, the prototype build, prototype
-- QA, the M2 finance gate — needs a row to hang its state off, and a phase
-- with no row has nowhere to put one.
--
-- ── scope: the workspace and its state machine, nothing each stage owns ──
--
-- Phase 4's own specification documents describe ~40 additional entities
-- (UIVersion, DesignQAReport, PrototypeBuild, PaymentVerification, and so
-- on) that this migration deliberately does NOT create. Each belongs to the
-- stage that produces it, the same way `projects.phase_three` holds no
-- column for a design or a route — Phase 3 locks a direction and this table
-- does not redraw it. What Task 2 needs before any of those stages can
-- exist is a workspace to start, a place to record which stage owns the
-- next action, and the two waiting/stop patterns every earlier phase table
-- in this repository already carries.
--
-- ── the state machine is deliberately smaller than the specs' own ────────
--
-- The seven Phase 4 specification PDFs describe per-stage state machines
-- (UIVersion: DRAFT → ... → LOCKED; PrototypeBuild: PLANNED → ... → LOCKED;
-- an M2 gate: NOT_DUE → ... → VERIFIED) that belong on the tables those
-- stages will create, not on this one. What THIS table's state machine
-- tracks is which of Task 2's macro-stages the project is currently in —
-- the level the PM Agent, the Admin Panel's Phase 4 Overview and the
-- Orchestrator all need to answer "what is current" without joining
-- through tables that do not exist yet. Building the full nested state
-- machine now, before UIVersion or PrototypeBuild exist to report into it,
-- would be exactly the "code with nowhere to attach" this repository's
-- audit history warns about.
--
-- ── one per project, and that IS the idempotency ──────────────────────────
--
-- Same argument `phase_three` makes for its own UNIQUE `project_id`: a
-- replayed `project.phase_four_ready` event, a second manual repair attempt,
-- and an overlapping runner tick must all collide at the constraint rather
-- than open two Task 2 workspaces for one project.
--
-- ── what it REFERENCES rather than copies ─────────────────────────────────
--
-- The Phase 3 handoff, and nothing else. Every fact Phase 4 needs — the
-- locked screens, the finalized theme and tokens, the approval evidence —
-- is owned by `projects.phase_three_handoffs` already. A copy here would be
-- the second source that drifts from the first the Phase 3 tokens migration
-- explicitly refused to create.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.phase_four (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- Master §3/§22's idempotency, as a constraint rather than a check somebody
  -- remembers.
  project_id       uuid not null unique references projects.projects(id) on delete cascade,

  -- The locked direction this workspace continues. A REFERENCE: the screens,
  -- theme, tokens and approval evidence stay where Phase 3 froze them.
  phase_three_handoff_id uuid not null references projects.phase_three_handoffs(id) on delete restrict,

  -- Task 2's macro-stage state machine (Impl §7.1, scoped to what this table
  -- owns — see header). Named states rather than a UI-only flag, so the
  -- Admin Panel and the PM Agent both read the same fact.
  state            text not null default 'not_started' check (state in (
                     'not_started',
                     'task2_started',
                     'ui_design',
                     'ui_review',
                     'ui_locked',
                     'prototype_build',
                     'prototype_review',
                     'prototype_locked',
                     'completed',
                     -- Waiting states. Not failures — Master §14's pattern,
                     -- reused rather than reinvented for Phase 4.
                     'waiting_client',
                     'waiting_admin',
                     'waiting_designer',
                     'waiting_prototype',
                     'blocked_requirement',
                     -- Stop states. The workflow halts here rather than
                     -- continuing automatically (Master §16, §17).
                     'scope_escalation',
                     'revision_limit_escalation'
                   )),

  -- Three owners, three columns — Master §4's actor table, and
  -- `projects.phase_three` already made the case: a single `owner` column
  -- cannot answer "who owns Task 2 right now" for a stage with three roles.
  pm_agent_key        text not null default 'project_manager' references ai.agents(key) on delete restrict,
  designer_agent_key  text not null default 'ui_designer' references ai.agents(key) on delete restrict,
  prototype_agent_key text not null default 'ui_prototype' references ai.agents(key) on delete restrict,

  -- UI Client Revision Rule: "approximately 2-3 rounds ... according to
  -- configured AgencyOS policy." A number compiled into a door is not
  -- configured — `projects.phase_three` makes the identical argument for its
  -- own revision limit, and Task 2 needs the same knob twice: once for the
  -- UI review loop, once for the prototype review loop, because the specs
  -- describe them as two separate revision counters with two separate
  -- limits, not one shared budget.
  ui_revision_count        int not null default 0 check (ui_revision_count >= 0),
  ui_revision_limit        int not null default 3 check (ui_revision_limit between 1 and 10),
  prototype_revision_count int not null default 0 check (prototype_revision_count >= 0),
  prototype_revision_limit int not null default 3 check (prototype_revision_limit between 1 and 10),

  -- Why it is waiting or stopped, in the words a person reads.
  blocked_reason   text check (blocked_reason is null or length(btrim(blocked_reason)) between 1 and 500),

  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A completed workspace says when. Same shape every phase table in this
  -- repository carries.
  constraint phase_four_completion_is_dated
    check (state <> 'completed' or completed_at is not null),

  -- The three states a person has to act on may not be entered silently.
  constraint phase_four_stop_says_why
    check (state not in ('blocked_requirement', 'scope_escalation', 'revision_limit_escalation')
           or (blocked_reason is not null and length(btrim(blocked_reason)) > 0))
);

create index if not exists phase_four_state_idx
  on projects.phase_four (organization_id, state);

comment on table projects.phase_four is
  'Task 2 / Phase 4 workspace. One per project (Master idempotency rule, same as phase_three). REFERENCES phase_three_handoffs rather than copying the locked direction: every fact Phase 4 needs is owned by a row Phase 3 already froze. The state machine tracks Task 2''s macro-stage only — UIVersion, PrototypeBuild, DesignQAReport and the M2 finance gate each own their own nested state machine on their own table once those stages are built; this table does not anticipate their shape.';

comment on column projects.phase_four.ui_revision_limit is
  'PM/UID specs: "approximately 2-3 rounds ... per configured AgencyOS policy." A number compiled into a door is not configured, so it lives here, separately from prototype_revision_limit because the specs treat UI review and prototype review as two distinct revision budgets, not one shared count.';

-- ── tenancy, exactly as every other org-scoped table carries it ──────────

drop trigger if exists org_match_phase_four_project on projects.phase_four;
create trigger org_match_phase_four_project
  before insert or update of project_id, organization_id on projects.phase_four
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_phase_four_handoff on projects.phase_four;
create trigger org_match_phase_four_handoff
  before insert or update of phase_three_handoff_id, organization_id on projects.phase_four
  for each row execute function core.enforce_parent_org('phase_three_handoff_id', 'projects.phase_three_handoffs');

drop trigger if exists freeze_org_phase_four on projects.phase_four;
create trigger freeze_org_phase_four
  before update of organization_id on projects.phase_four
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_phase_four on projects.phase_four;
create trigger set_updated_at_phase_four
  before update on projects.phase_four
  for each row execute function core.set_updated_at();

alter table projects.phase_four enable row level security;
alter table projects.phase_four force row level security;

-- Internal-only, like every other phase workspace: a client sees what the PM
-- chooses to share with them, never the workflow state around it.
drop policy if exists phase_four_select on projects.phase_four;
create policy phase_four_select on projects.phase_four
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- No write policy, deliberately. Every mutation goes through a door below,
-- the same discipline every phase table in this repository keeps.

grant select on projects.phase_four to authenticated, service_role;

-- ── the event Impl §8/ORCH §19 name for Task 2's own start ───────────────

insert into core.event_types (type, description, canonical) values
  ('project.phase_four_started',
   'Impl §8 Phase4Started / Task2Started. The Task 2 workspace exists and UI design work may begin. Consumed by the PM''s Task 2 start communication once it exists.',
   true)
on conflict (type) do nothing;

-- ── the door ───────────────────────────────────────────────────────────────

create or replace function projects.start_phase_four(p_project_id uuid)
returns table (
  -- 'started' | 'already_started' | 'not_ready' | 'unknown_project'
  -- | 'no_actor' | 'forbidden'
  outcome       text,
  phase_four_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_project  projects.projects;
  v_handoff  projects.phase_three_handoffs;
  v_existing projects.phase_four;
  v_new      uuid;
begin
  -- The service role starts Phase 4 because the trigger is an EVENT:
  -- `project.phase_four_ready` fires and a job acts on it. A person may also
  -- start it — a repair after a lost event — which is why the actor path
  -- exists at all. The same shape `start_phase_three` uses.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  -- Locked before anything is decided: a replayed event and a manual repair
  -- must not both pass the existence check and both insert.
  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_project.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select p4.* into v_existing from projects.phase_four p4 where p4.project_id = v_project.id;
  if v_existing.id is not null then
    -- Master §22: "duplicate event/job - return existing artifact/version
    -- idempotently."
    return query select 'already_started'::text, v_existing.id; return;
  end if;

  -- Master §22's Phase 4 row: "Phase 4 start attempted early -> block until
  -- Phase 3 final selection/handoff is complete." Read from the handoff ROW,
  -- not from the event that woke the caller — an event is a claim about the
  -- past and the row is the present, and a forged or stale `phase_four_ready`
  -- claim in an event payload must not be able to start a workspace the row
  -- itself says is not ready.
  select h.* into v_handoff
    from projects.phase_three_handoffs h
   where h.project_id = v_project.id
     and h.phase_four_ready = true
   order by h.locked_at desc
   limit 1;

  if v_handoff.id is null then
    return query select 'not_ready'::text, null::uuid; return;
  end if;

  insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id, state)
  values (v_project.organization_id, v_project.id, v_handoff.id, 'task2_started')
  returning id into v_new;

  perform core.record_audit(
    v_project.organization_id,
    'project.phase_four_started',
    'phase_four',
    v_new,
    null,
    jsonb_build_object('projectId', v_project.id, 'phaseThreeHandoffId', v_handoff.id)
  );

  perform core.emit_event(
    v_project.organization_id,
    'project.phase_four_started',
    'phase_four',
    v_new,
    jsonb_build_object('projectId', v_project.id, 'phaseThreeHandoffId', v_handoff.id)
  );

  return query select 'started'::text, v_new;
end;
$$;

comment on function projects.start_phase_four(uuid) is
  'Task 2''s entry. Starts Phase 4 for a project whose latest Phase 3 handoff has phase_four_ready = true, reading that from the handoff ROW rather than trusting the event payload that woke the caller - an event is a claim about the past and the row is the present, and this is the one door where trusting the payload instead would let a forged or stale readiness claim start a workspace the row itself refuses. One workspace per project: a replay answers already_started with the existing id, which is Master section 22''s "return existing artifact idempotently."';

revoke all on function projects.start_phase_four(uuid) from public, anon;
grant execute on function projects.start_phase_four(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
