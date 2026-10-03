-- The Project Planning Agent: it drafts the operational blueprint itself.
--
-- Phase 2's Master Flow §5.9 and Planning §2: when the advance is VERIFIED the
-- Project Planning Agent builds the blueprint from the accepted scope. Until
-- now the plan domain existed (deliverables, dependencies, milestones, risks,
-- clarifications, versions, the validator) and every row of it was typed by a
-- person; nothing generated a plan and nothing started one when payment landed.
--
-- This migration is the data half of that agent:
--
--   1. the agent exists (`project_planning`), separate from the project manager
--      and from the development planner that does not exist yet - Planning §1
--      is emphatic that these are not one thing. ADM-82's roster folded
--      "plans and sequences a project" into the PM; the locked Phase 2
--      specification (which takes precedence for Phase 2) names it separately.
--      Recorded as a conflict resolved in the specification's favour, in the
--      change log; an owner who disagrees disables the row on the Agents page.
--   2. the dependency vocabulary gains the three kinds the specification's
--      task list names and the register lacked: client_asset, client_approval,
--      other. (human_approval and finance already are ADMIN_APPROVAL and
--      FINANCE_GATE under the repository's own names.) A client asset or a
--      client approval is something the CLIENT owes, so, like client_information
--      and client_access, it belongs to the project manager to collect (§4.4).
--   3. one door writes a whole blueprint atomically, for the runner only. The
--      existing add_* doors already admit the service role, but a blueprint is
--      many rows, and a half-written one that a retry then doubles is worse
--      than none: here every row lands or none does, and a project that
--      already has any plan is refused rather than overwritten (a person's plan
--      is never replaced by a machine's).
--
-- Activation stays a person's act (decision 12, 2026-10-01): the agent drafts,
-- the validator reports, an internal approver activates.

insert into ai.agents (key, display_name, description, autonomy_level, enabled, default_model, default_effort, max_steps, max_cost_minor, disabled_reason)
values (
  'project_planning', 'Project Planning',
  'Turns the accepted scope into the operational project blueprint - deliverables, phase sequence, dependencies, risks and readiness gates. Plans how the project moves through AgencyOS, never how the product is built. Drafts; a person approves.',
  'L2', false, 'claude-sonnet-5', 'medium', 16, 2000,
  'Installed disabled like every agent, then enabled below under the owner''s Phase 2 instruction.'
)
on conflict (key) do nothing;

-- Enabled in the same migration, as the owner asked for Phase 2 to work end to
-- end. It only DRAFTS: nothing it writes is live until a person approves it.
update ai.agents set enabled = true, disabled_reason = null where key = 'project_planning';

-- ── the dependency vocabulary ──────────────────────────────────────────────
alter table projects.plan_dependencies drop constraint if exists plan_dependencies_kind_check;
alter table projects.plan_dependencies add constraint plan_dependencies_kind_check check (
  kind in ('client_information', 'client_access', 'client_asset', 'client_approval',
           'external_service', 'internal_output', 'human_approval', 'finance', 'other')
);

alter table projects.plan_dependencies drop constraint if exists plan_dependencies_client_items_are_pms;
alter table projects.plan_dependencies add constraint plan_dependencies_client_items_are_pms check (
  kind not in ('client_information', 'client_access', 'client_asset', 'client_approval')
  or owner_role = 'project_manager'
);

-- add_plan_dependency, carried forward from its live body with one change: the project-manager-owns-it rule covers the two new client kinds.
CREATE OR REPLACE FUNCTION projects.add_plan_dependency(p_plan_id uuid, p_kind text, p_description text, p_needed_by_phase text, p_owner_role text, p_window_start date DEFAULT NULL::date, p_window_end date DEFAULT NULL::date, p_timing_basis text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, dependency_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_new   uuid;
begin
  -- §4.3 and §11, refused before the lock and by name: a window with no
  -- stated basis is a guarantee nobody can defend.
  if (p_window_start is not null or p_window_end is not null)
     and coalesce(btrim(coalesce(p_timing_basis, '')), '') = '' then
    return query select 'dates_need_a_basis'::text, null::uuid; return;
  end if;

  -- §4.4: the Planning Agent does not take over client communication.
  if p_kind in ('client_information', 'client_access', 'client_asset', 'client_approval') and p_owner_role is distinct from 'project_manager' then
    return query select 'client_items_are_pms'::text, null::uuid; return;
  end if;

  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  insert into projects.plan_dependencies (
    organization_id, plan_id, kind, description, needed_by_phase,
    needed_by_window_start, needed_by_window_end, timing_basis, owner_role
  ) values (
    v_plan.organization_id, v_plan.id, p_kind, p_description, p_needed_by_phase,
    p_window_start, p_window_end, nullif(btrim(coalesce(p_timing_basis, '')), ''), p_owner_role
  )
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$function$

;

-- ── the whole blueprint, atomically ────────────────────────────────────────
create or replace function projects.agent_draft_blueprint(
  p_project_id uuid,
  p_blueprint  jsonb
)
returns table (outcome text, plan_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project projects.projects;
  v_scope   projects.scope_versions;
  v_plan    uuid;
  v_el      jsonb;
  v_i       int;
begin
  if (select auth.role()) is distinct from 'service_role' then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid; return;
  end if;

  -- A machine never replaces a person's plan, nor adds a second version on its
  -- own: any plan at all, in any state, is the answer.
  if exists (select 1 from projects.project_plans pp where pp.project_id = v_project.id) then
    return query select 'plan_exists'::text, (select pp.id from projects.project_plans pp where pp.project_id = v_project.id order by pp.version desc limit 1); return;
  end if;

  select sv.* into v_scope
    from projects.scope_versions sv
   where sv.project_id = v_project.id and sv.status <> 'draft'
   order by sv.version desc limit 1;
  if v_scope.id is null then
    return query select 'no_scope'::text, null::uuid; return;
  end if;

  if coalesce(jsonb_typeof(p_blueprint->'deliverables'), '') <> 'array'
     or jsonb_array_length(p_blueprint->'deliverables') = 0 then
    return query select 'empty_blueprint'::text, null::uuid; return;
  end if;

  insert into projects.project_plans (organization_id, project_id, version, status, scope_version_id, objective, created_by)
  values (v_project.organization_id, v_project.id, 1, 'draft', v_scope.id,
          nullif(btrim(coalesce(p_blueprint->>'objective', '')), ''), null)
  returning id into v_plan;

  -- Deliverables: every one must name an item of THIS plan's approved scope.
  v_i := 0;
  for v_el in select * from jsonb_array_elements(p_blueprint->'deliverables') loop
    v_i := v_i + 1;
    if not exists (select 1 from projects.scope_items si
                    where si.id = (v_el->>'scopeItemId')::uuid and si.scope_version_id = v_scope.id) then
      raise exception 'deliverable % names a scope item outside the approved scope', v_i using errcode = 'check_violation';
    end if;
    insert into projects.plan_deliverables (
      organization_id, plan_id, position, name, scope_item_id, applicable_phase, owner_role,
      readiness_criteria, evidence_required, ambiguity_note
    ) values (
      v_project.organization_id, v_plan, v_i, v_el->>'name', (v_el->>'scopeItemId')::uuid,
      v_el->>'applicablePhase', nullif(btrim(coalesce(v_el->>'ownerRole', '')), ''),
      v_el->>'readinessCriteria', v_el->>'evidenceRequired',
      nullif(btrim(coalesce(v_el->>'ambiguityNote', '')), '')
    );
  end loop;

  v_i := 0;
  for v_el in select * from jsonb_array_elements(coalesce(p_blueprint->'dependencies', '[]'::jsonb)) loop
    v_i := v_i + 1;
    insert into projects.plan_dependencies (
      organization_id, plan_id, kind, description, needed_by_phase, owner_role,
      needed_by_window_start, needed_by_window_end, timing_basis
    ) values (
      v_project.organization_id, v_plan, v_el->>'kind', v_el->>'description', v_el->>'neededByPhase', v_el->>'ownerRole',
      (v_el->>'windowStart')::date, (v_el->>'windowEnd')::date, nullif(btrim(coalesce(v_el->>'timingBasis', '')), '')
    );
  end loop;

  v_i := 0;
  for v_el in select * from jsonb_array_elements(coalesce(p_blueprint->'milestones', '[]'::jsonb)) loop
    v_i := v_i + 1;
    if (v_el->>'paymentMilestoneId') is not null and not exists (
         select 1 from projects.milestones pm where pm.id = (v_el->>'paymentMilestoneId')::uuid and pm.project_id = v_project.id) then
      raise exception 'milestone % names a payment milestone of another project', v_i using errcode = 'check_violation';
    end if;
    insert into projects.plan_milestones (
      organization_id, plan_id, position, name, kind, phase, gate_criteria, payment_milestone_id,
      target_window_start, target_window_end, timing_basis
    ) values (
      v_project.organization_id, v_plan, v_i, v_el->>'name', v_el->>'kind', v_el->>'phase', v_el->>'gateCriteria',
      (v_el->>'paymentMilestoneId')::uuid,
      (v_el->>'windowStart')::date, (v_el->>'windowEnd')::date, nullif(btrim(coalesce(v_el->>'timingBasis', '')), '')
    );
  end loop;

  for v_el in select * from jsonb_array_elements(coalesce(p_blueprint->'notes', '[]'::jsonb)) loop
    insert into projects.plan_notes (organization_id, plan_id, kind, statement, owner_role, escalation_path)
    values (v_project.organization_id, v_plan, v_el->>'kind', v_el->>'statement',
            nullif(btrim(coalesce(v_el->>'ownerRole', '')), ''), nullif(btrim(coalesce(v_el->>'escalationPath', '')), ''));
  end loop;

  for v_el in select * from jsonb_array_elements(coalesce(p_blueprint->'clarifications', '[]'::jsonb)) loop
    insert into projects.plan_clarifications (organization_id, plan_id, question, impact, scope_item_id)
    values (v_project.organization_id, v_plan, v_el->>'question', v_el->>'impact', (v_el->>'scopeItemId')::uuid);
  end loop;

  perform core.emit_event(
    v_project.organization_id, 'project.plan_drafted', 'project', v_project.id,
    jsonb_build_object('plan_id', v_plan, 'version', 1, 'scope_version_id', v_scope.id, 'drafted_by', 'project_planning'),
    null
  );
  if jsonb_array_length(coalesce(p_blueprint->'clarifications', '[]'::jsonb)) > 0 then
    perform core.emit_event(
      v_project.organization_id, 'project.clarification_required', 'project', v_project.id,
      jsonb_build_object('plan_id', v_plan, 'count', jsonb_array_length(p_blueprint->'clarifications')),
      null
    );
  end if;

  perform core.record_audit(
    v_project.organization_id, 'project.plan_drafted_by_agent', 'project', v_project.id, null,
    jsonb_build_object('plan_id', v_plan, 'agent', 'project_planning',
                       'deliverables', jsonb_array_length(p_blueprint->'deliverables'),
                       'clarifications', jsonb_array_length(coalesce(p_blueprint->'clarifications', '[]'::jsonb))),
    null
  );

  return query select 'drafted'::text, v_plan;
end;
$$;

revoke all on function projects.agent_draft_blueprint(uuid, jsonb) from public, anon, authenticated;
grant execute on function projects.agent_draft_blueprint(uuid, jsonb) to service_role;
comment on function projects.agent_draft_blueprint(uuid, jsonb) is
  'The Project Planning Agent''s one door: a whole operational blueprint, all rows or none, for a project with no plan. Refuses any existing plan. Service role only; activation stays a person''s.';

-- ── where it sits in the roster ────────────────────────────────────────────
-- The PM asks it for the blueprint and it hands the result back; its work is
-- certified by quality_assurance, never by itself (ADM-82's producer != verifier).
insert into ai.agent_handoff_targets (from_agent, to_agent)
values ('project_manager', 'project_planning'), ('project_planning', 'project_manager')
on conflict (from_agent, to_agent) do nothing;

insert into ai.agent_verifiers (producer, verifier)
values ('project_planning', 'quality_assurance')
on conflict do nothing;

-- ── asking for it by hand ──────────────────────────────────────────────────
-- The agent starts on its own when the advance is verified. Staff can also ask
-- for it - a project whose advance was settled outside the system, or one that
-- needs a fresh draft - and that is one audited door that publishes the event
-- the agent listens to. It decides nothing about the plan.
insert into core.event_types (type, description, canonical) values
  ('project.planning_requested', 'Somebody asked the Project Planning Agent to draft the operational blueprint for a project.', null)
on conflict (type) do nothing;

create or replace function projects.request_project_planning(p_project_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
begin
  if v_actor is null then return 'needs_person'; end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then return 'unknown_project'; end if;
  if v_project.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return 'forbidden';
  end if;

  if not exists (select 1 from projects.phase_two t where t.project_id = v_project.id) then
    return 'no_phase_two';
  end if;
  if exists (select 1 from projects.project_plans pp where pp.project_id = v_project.id) then
    return 'plan_exists';
  end if;

  perform core.emit_event(
    v_project.organization_id, 'project.planning_requested', 'project', v_project.id,
    jsonb_build_object('requested_by', v_actor), null
  );
  perform core.record_audit(
    v_project.organization_id, 'project.planning_requested', 'project', v_project.id, null,
    jsonb_build_object('requested_by', v_actor), null
  );
  return 'requested';
end;
$$;
revoke all on function projects.request_project_planning(uuid) from public, anon;
grant execute on function projects.request_project_planning(uuid) to authenticated, service_role;
