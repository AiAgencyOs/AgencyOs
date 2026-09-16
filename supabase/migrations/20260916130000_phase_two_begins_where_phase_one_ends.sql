-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 begins where Phase 1 ends — Master Flow §5.1–§5.3, PM §6 PM-01/02
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PH1-CLS-002 built the WON handoff packet and said, in as many words, why
-- nothing consumed it: *"Both agents are disabled (BLK-002), and the row will
-- sit at `queued` with no receiver. That is not a defect; it is §13.4 field 8
-- exactly: structured handoff packet ready; Phase 2 not activated."*
--
-- BLK-002 was answered on 2026-09-13 — `project_manager` is enabled — and the
-- four locked Phase 2 specifications arrived. The packet now has a receiver.
--
-- ── the moment Phase 2 can actually start is the BINDING, not the win ─────
--
-- The handoff is written at the win, by a trigger, with **no project**: WON
-- and conversion are two human acts and conversion may come hours later or
-- never. Master §5.3 wants a workspace, and the workspace is the project. So
-- Phase 2 cannot start at `opportunity.handed_off`; it starts when the handoff
-- gains its project.
--
-- That moment is already recorded — `opportunity.handoff_bound`, an AUDIT row
-- — and an audit row is not subscribable. Doc 09 §33's sentence applies to it
-- exactly as it applied to the handoff itself: *"Handoff completion should be
-- a real workflow event, not simply a note."*
--
-- **Held at the row, not in the function.** `sales.record_won_handoff` is four
-- hundred lines and carrying it forward to add one emit would be four hundred
-- lines of risk for one statement. A trigger on `ai.handoffs` fires whenever
-- `project_id` goes from absent to present — through the function, through a
-- repair run, through a direct write — which is a stronger rule than the one
-- an edit to the function would have bought.
--
-- ── what a Phase 2 run is, and what it is not ────────────────────────────
--
-- `projects.projects` already carries the project's own status
-- (`planning → onboarding → active`) and `projects.onboarding_items` already
-- carries a ten-item checklist frozen from a versioned baseline. Neither is
-- the PM's state: PM §11 wants ASSIGNED → CONTEXT_LOADING → ONBOARDING →
-- WAITING_* → PRE_KICKOFF_CHECK → KICKOFF_READY → KICKOFF_SENT →
-- PHASE2_COMPLETE, which spans onboarding, finance and planning.
--
-- So one row per project holds the PHASE's state, pointing at the handoff it
-- inherited rather than copying it. Copying the packet would be a second
-- source for facts `ai.handoffs` already owns, and the first thing a second
-- copy does is disagree with the first.
--
-- ── what this migration deliberately does NOT do ─────────────────────────
--
-- It does not contact the client, ask anything, create a group task, touch
-- money or start planning. PM §6 PM-02 is "load context"; PM-03 is the first
-- message and is its own unit. A Phase 2 that started by messaging a client
-- would be the one part of this flow nobody could undo.

-- ── 1. the event the binding always deserved ─────────────────────────────

insert into core.event_types (type, description, canonical) values
  ('project.handoff_bound',
   'A WON handoff packet gained its project, so a Phase 2 workspace exists to start against (Phase 2 Master Flow section 5.1). Emitted by a trigger on ai.handoffs when project_id goes from absent to present, however that happens.',
   null)
on conflict (type) do nothing;

create or replace function ai.emit_handoff_bound()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only the sales → project_manager packet, and only the transition. An
  -- UPDATE that rewrites the same project_id is not a binding.
  if new.project_id is not null
     and old.project_id is distinct from new.project_id
     and new.from_agent = 'sales'
     and new.to_agent = 'project_manager'
     and new.subject_type = 'opportunity' then
    perform core.emit_event(
      new.organization_id,
      'project.handoff_bound',
      'project',
      new.project_id,
      jsonb_build_object(
        'handoff_id', new.id,
        'opportunity_id', new.subject_id,
        -- The payload names the subject; the handler re-reads the row. A
        -- payload is a forgeable claim and the row is the fact.
        'correlation_id', new.correlation_id
      )
    );
  end if;
  return new;
end;
$$;

comment on function ai.emit_handoff_bound() is
  'Phase 2 Master Flow section 5.1. Emits project.handoff_bound when a WON handoff packet gains its project. Held at the row rather than inside sales.record_won_handoff, so a repair run or a direct write emits it too.';

drop trigger if exists handoffs_emit_bound on ai.handoffs;
create trigger handoffs_emit_bound
  after update of project_id on ai.handoffs
  for each row
  execute function ai.emit_handoff_bound();

-- ── 2. the Phase 2 run ───────────────────────────────────────────────────

create table if not exists projects.phase_two (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- One Phase 2 per project. The unique constraint is the idempotency: a
  -- replayed event, two overlapping runner invocations and a manual repair
  -- all collide here rather than producing two runs.
  project_id       uuid not null unique references projects.projects(id) on delete cascade,

  -- The packet this phase inherited. A REFERENCE: every fact in it — the
  -- accepted quotation, the approval, the acceptance, the requirement version,
  -- the contact and their language — is owned by a row Phase 1 already wrote,
  -- and copying them here would be a second source that drifts.
  handoff_id       uuid not null references ai.handoffs(id) on delete restrict,

  -- PM section 11's state model. `waiting_*` is not failure: it carries the
  -- blocker, the owner and the moment, and safe independent work continues.
  state            text not null default 'context_loading' check (state in (
                     'context_loading',
                     'onboarding',
                     'waiting_client',
                     'waiting_admin',
                     'waiting_finance',
                     'waiting_planning',
                     'pre_kickoff_check',
                     'kickoff_ready',
                     'kickoff_sent',
                     'completed',
                     'blocked'
                   )),

  -- Which agent owns the phase. One PM per project (PM section 2); the column
  -- exists so a later roster change is a data change rather than a rewrite,
  -- and so a reader can see WHO owned a completed phase.
  pm_agent_key     text not null default 'project_manager' references ai.agents(key) on delete restrict,

  -- Why it is waiting, in the vocabulary a person reads. Null when it is not.
  blocked_reason   text check (blocked_reason is null or length(btrim(blocked_reason)) between 1 and 500),

  started_at       timestamptz not null default now(),
  context_loaded_at timestamptz,
  kickoff_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A completed phase says when. The same shape projects.milestones uses for
  -- met_at: a status that claims completion without a moment is a claim
  -- nobody can check.
  constraint phase_two_completion_is_dated
    check ((state = 'completed') = (completed_at is not null)),
  constraint phase_two_kickoff_is_dated
    check (state not in ('kickoff_sent', 'completed') or kickoff_at is not null)
);

comment on table projects.phase_two is
  'One Phase 2 run per project (Phase 2 PM specification section 11). Holds the PHASE''s state - which spans onboarding, finance and planning - rather than the project''s own status or the onboarding checklist, both of which already exist. Points at the inherited handoff packet instead of copying it.';

create index if not exists phase_two_org_state_idx on projects.phase_two (organization_id, state);
create index if not exists phase_two_handoff_idx on projects.phase_two (handoff_id);

alter table projects.phase_two enable row level security;

-- Internal-only, like every other operational table: a client never reads the
-- agency's own phase state.
drop policy if exists phase_two_read on projects.phase_two;
create policy phase_two_read on projects.phase_two
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists phase_two_write on projects.phase_two;
create policy phase_two_write on projects.phase_two
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

-- The tenancy discipline every org-scoped table in this repository carries:
-- the parent's organization must match, and the column may never be moved.
drop trigger if exists phase_two_project_org on projects.phase_two;
create trigger phase_two_project_org
  before insert or update of project_id, organization_id on projects.phase_two
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists phase_two_handoff_org on projects.phase_two;
create trigger phase_two_handoff_org
  before insert or update of handoff_id, organization_id on projects.phase_two
  for each row execute function core.enforce_parent_org('handoff_id', 'ai.handoffs');

drop trigger if exists phase_two_freeze_org on projects.phase_two;
create trigger phase_two_freeze_org
  before update on projects.phase_two
  for each row execute function core.freeze_organization_id();

drop trigger if exists phase_two_touch on projects.phase_two;
create trigger phase_two_touch
  before update on projects.phase_two
  for each row execute function core.set_updated_at();

-- ── 3. the door ──────────────────────────────────────────────────────────

create or replace function projects.start_phase_two(p_project_id uuid)
returns table (
  -- 'started' | 'already_started' | 'no_handoff' | 'unknown_project'
  -- | 'no_actor' | 'forbidden'
  outcome       text,
  phase_two_id  uuid,
  handoff_id    uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_handoff ai.handoffs;
  v_existing projects.phase_two;
  v_new     uuid;
begin
  -- The service role starts Phase 2 because the trigger for it is an EVENT,
  -- not a click: the binding happened, and a job acts on it. A person may
  -- also start it (a repair after a lost event), which is why the actor path
  -- exists at all.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;

  -- Locked: two jobs for one project — a replayed event and a repair — must
  -- not both pass the existence check and both insert.
  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_project.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  select pt.* into v_existing from projects.phase_two pt where pt.project_id = v_project.id;
  if v_existing.id is not null then
    return query select 'already_started'::text, v_existing.id, v_existing.handoff_id; return;
  end if;

  -- Master §5.1: "Block invalid/incomplete handoff instead of inventing
  -- missing data." No packet, no Phase 2 — and the refusal is named so the
  -- remediation is somebody's task rather than a mystery.
  select h.* into v_handoff
    from ai.handoffs h
   where h.project_id = v_project.id
     and h.organization_id = v_project.organization_id
     and h.from_agent = 'sales'
     and h.to_agent = 'project_manager'
     and h.subject_type = 'opportunity'
   order by h.created_at
   limit 1;
  if v_handoff.id is null then
    return query select 'no_handoff'::text, null::uuid, null::uuid; return;
  end if;

  insert into projects.phase_two (organization_id, project_id, handoff_id, state)
  values (v_project.organization_id, v_project.id, v_handoff.id, 'context_loading')
  returning id into v_new;

  -- The packet is no longer sitting at `queued` with no receiver.
  update ai.handoffs
     set status = 'accepted',
         accepted_at = coalesce(accepted_at, now())
   where id = v_handoff.id
     and status = 'queued';

  perform core.record_audit(
    v_project.organization_id,
    'project.phase_two_started',
    'project',
    v_project.id,
    null::jsonb,
    jsonb_build_object(
      'phase_two_id', v_new,
      'handoff_id', v_handoff.id,
      'opportunity_id', v_handoff.subject_id,
      'state', 'context_loading',
      'pm_agent', 'project_manager',
      'started_by', v_actor
    ),
    v_handoff.correlation_id
  );

  return query select 'started'::text, v_new, v_handoff.id;
end;
$$;

comment on function projects.start_phase_two(uuid) is
  'Phase 2 Master Flow sections 5.1-5.3. Starts the Phase 2 run for a project whose WON handoff packet is bound, idempotently (one row per project, under the project lock) and without inventing anything: no packet answers no_handoff rather than starting a phase with no inherited context. Accepts the packet (queued -> accepted) and audits project.phase_two_started. Contacts nobody: the first client message is PM-03 and its own unit.';

revoke all on function projects.start_phase_two(uuid) from public, anon;
grant execute on function projects.start_phase_two(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
