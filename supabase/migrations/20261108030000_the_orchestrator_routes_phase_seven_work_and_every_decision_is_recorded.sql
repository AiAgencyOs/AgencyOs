-- ═══════════════════════════════════════════════════════════════════════════
-- P703: the Orchestrator's runtime for Phase 7.
--
--   * three handoff edges, orchestrator -> deployment_agent / release_qa / incident_recovery (the mirror of src/modules/agents/registry.ts; the receiver of a
--     handoff must be a declared target of the sender, and the roster migration is where those pairs live)
--   * projects.p7b_routing_decisions   append-only: what the Orchestrator decided for a Phase 7 task, with every candidate explained and the execution
--                                      envelope it would hand over. The decision is made in TypeScript (src/modules/orchestrator/phase-seven-route.ts) and
--                                      RECORDED here; the database refuses a decision the rules forbid, so a model or a hand-typed call cannot route around them.
--   * projects.record_phase_seven_routing   SERVICE ROLE ONLY.
--
-- The Orchestrator ROUTES. It approves no deployment, validates no production, closes no incident and grants no tool. Every Phase 7 agent is installed
-- disabled and holds no tool, so today every agent-bound task is HELD with the reason stated.
-- ═══════════════════════════════════════════════════════════════════════════

insert into ai.agent_handoff_targets (from_agent, to_agent)
values
  ('orchestrator', 'deployment_agent'), ('orchestrator', 'release_qa'), ('orchestrator', 'incident_recovery')
on conflict (from_agent, to_agent) do nothing;

create table if not exists projects.p7b_routing_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_type        text not null check (task_type in ('deployment_execution', 'readiness_review', 'smoke_validation', 'health_check', 'incident_triage', 'rollback_coordination', 'client_update', 'financial_clearance_review')),
  decision_key     text not null check (length(btrim(decision_key)) > 0),
  outcome          text not null check (outcome in ('routed', 'held', 'refused', 'event_handled')),
  code             text not null check (length(btrim(code)) > 0),
  to_agent         text references ai.agents(key) on delete restrict,
  reason           text not null check (length(btrim(reason)) > 0 and not projects.p7_has_secret(reason)),
  candidates       jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  envelope         jsonb check (envelope is null or jsonb_typeof(envelope) = 'object'),
  subject_id       uuid,
  policy_version   text,
  correlation_id   uuid,
  decided_at       timestamptz not null default clock_timestamp(),
  unique (project_id, decision_key),
  check (outcome in ('refused') or to_agent is not null)
);
comment on table projects.p7b_routing_decisions is 'The Orchestrator''s recorded decision for a Phase 7 task: routed, held (disabled / no tool / gate not met), refused (no route, code defect) or event_handled (the PM and Finance act through their existing handlers and doors, not through an agent handoff). History: never edited.';

select projects.p7_guard_fk('p7b_routing_decisions', 'project_id', 'projects.projects');
select projects.p7_harden('projects', 'p7b_routing_decisions');
drop trigger if exists p7b_routing_decisions_append_only on projects.p7b_routing_decisions;
create trigger p7b_routing_decisions_append_only before insert or update or delete on projects.p7b_routing_decisions for each row execute function projects.p7_append_only();

create or replace function projects.record_phase_seven_routing(
  p_organization_id uuid, p_project_id uuid, p_task_type text, p_decision_key text, p_outcome text, p_code text, p_to_agent text, p_reason text,
  p_candidates jsonb, p_envelope jsonb, p_subject_id uuid default null, p_policy_version text default null, p_correlation_id uuid default null)
returns table (outcome text, decision_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_expected text; v_id uuid; v_plan uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  -- the organization is the JOB's, never one a payload names
  if not exists (select 1 from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = p_organization_id) then return query select 'not_in_phase_seven'::text, null::uuid; return; end if;
  v_expected := case p_task_type
    when 'deployment_execution' then 'deployment_agent' when 'readiness_review' then 'deployment_agent'
    when 'smoke_validation' then 'release_qa' when 'health_check' then 'release_qa'
    when 'incident_triage' then 'incident_recovery' when 'rollback_coordination' then 'incident_recovery'
    when 'client_update' then 'project_manager' when 'financial_clearance_review' then 'finance' end;
  if v_expected is null or p_outcome not in ('routed', 'held', 'refused', 'event_handled') or p_decision_key is null or length(btrim(p_decision_key)) = 0
     or p_code is null or length(btrim(p_code)) = 0 or p_reason is null or length(btrim(p_reason)) = 0
     or jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array' or (p_envelope is not null and jsonb_typeof(p_envelope) <> 'object') then
    return query select 'bad_decision'::text, null::uuid; return;
  end if;
  if projects.p7_has_secret(p_reason) or projects.p7_has_secret(coalesce(p_envelope::text, '')) or projects.p7_has_secret(coalesce(p_candidates::text, '')) then return query select 'contains_secret'::text, null::uuid; return; end if;
  -- the work goes to the specialist that owns it, nobody else
  if p_outcome in ('routed', 'held', 'event_handled') and p_to_agent is distinct from v_expected then return query select 'wrong_agent_for_task'::text, null::uuid; return; end if;
  -- the PM and Finance act through their own handlers and doors: they are never "routed" or "held" as an agent handoff
  if (v_expected in ('project_manager', 'finance')) <> (p_outcome = 'event_handled') and p_outcome <> 'refused' then return query select 'handled_by_events_not_handoff'::text, null::uuid; return; end if;
  if p_outcome = 'routed' then
    -- held when disabled is a rule of the database too, not only of the TypeScript
    if not coalesce((select a.enabled from ai.agents a where a.key = p_to_agent), false) then return query select 'agent_not_enabled'::text, null::uuid; return; end if;
    if not exists (select 1 from ai.agent_handoff_targets t where t.from_agent = 'orchestrator' and t.to_agent = p_to_agent) then return query select 'no_declared_route'::text, null::uuid; return; end if;
    -- a deployment is routed only for a plan whose Admin approval still holds for the current candidate
    if p_task_type = 'deployment_execution' then
      begin v_plan := (p_envelope ->> 'planId')::uuid; exception when others then v_plan := null; end;
      if v_plan is null or not exists (select 1 from projects.p7_deployment_plans pl where pl.id = v_plan and pl.project_id = p_project_id and pl.organization_id = p_organization_id)
         or not projects.p7_deployment_approved(v_plan) then
        return query select 'deployment_not_approved'::text, null::uuid; return;
      end if;
    end if;
    -- a rollback is coordinated only against an Admin-approved rollback decision for that incident
    if p_task_type = 'rollback_coordination' then
      if p_subject_id is null or not exists (select 1 from projects.p7_rollback_decisions r join projects.p7_incidents i on i.id = r.incident_id
                                              where r.incident_id = p_subject_id and r.decision = 'approve' and i.project_id = p_project_id and i.organization_id = p_organization_id) then
        return query select 'rollback_not_approved'::text, null::uuid; return;
      end if;
    end if;
  end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7b_routing_decisions (organization_id, project_id, task_type, decision_key, outcome, code, to_agent, reason, candidates, envelope, subject_id, policy_version, correlation_id)
  values (p_organization_id, p_project_id, p_task_type, btrim(p_decision_key), p_outcome, btrim(p_code), p_to_agent, btrim(p_reason), coalesce(p_candidates, '[]'::jsonb), p_envelope, p_subject_id, p_policy_version, p_correlation_id)
  on conflict (project_id, decision_key) do nothing returning id into v_id;
  if v_id is null then return query select 'already_recorded'::text, null::uuid; return; end if;
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_phase_seven_routing(uuid, uuid, text, text, text, text, text, text, jsonb, jsonb, uuid, text, uuid) from public, anon, authenticated;
grant execute on function projects.record_phase_seven_routing(uuid, uuid, text, text, text, text, text, text, jsonb, jsonb, uuid, text, uuid) to service_role;

notify pgrst, 'reload schema';
