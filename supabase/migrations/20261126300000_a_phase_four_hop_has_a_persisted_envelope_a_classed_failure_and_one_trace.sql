-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 Orchestrator / Router (traceability rows P4-ORCH-004, 007, 009 (profile), 019, 020 (prior failure), 025, 026 (disabled specialist), 035, 036, 040, 041, 042, 044, 045; T06, T10, T11 (scrub)).
--
-- Phase 4's hops were choreography: each subscriber re-read the rows and ran. That is fine for authority (every door re-checks) but left no record of WHAT a hop was told to
-- do, how many times it was allowed to try, why it failed, or who was asked when it could not. This adds, without changing any subscriber:
--
--   * projects.p4q_task_types              the Phase 4 task taxonomy as DATA (event, job kind, agent, order), so it can be compared with the event catalog by a test.
--   * projects.p4q_agent_capability_profiles  per agent: the spec workload tier, the model capabilities a run needs, the data classes it may see, the task types it supports.
--   * projects.p4q_execution_envelopes     the persisted ExecutionEnvelope of one hop: exact references (never "latest"), tools, retry budget, idempotency key, policy version.
--   * projects.p4q_failure_records         a CLASSED failure (transient / permanent / policy / validation / uncertain side effect / no capable agent / provider) with attempts.
--   * projects.p4q_record_failure          bounded retry: retry while the budget lasts, never blind-retry an uncertain side effect, escalate (projects.p4q_escalations) when it is
--                                          exhausted, the failure is permanent, no agent is capable, or the specialist is disabled. It never approves, never verifies.
--   * projects.p4q_phase4_trace            ONE joined trace for a project by correlation: handoffs, envelopes, failures, escalations, designer routing, QA runs, shares.
--   * projects.p4q_failure_queue           envelopes with failures and no success.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── task taxonomy and capability profiles (reference data, not tenant data) ──
create table if not exists projects.p4q_task_types (
  task_type        text primary key check (task_type ~ '^[a-z][a-z0-9_.]{2,80}$'),
  trigger_event    text not null,
  job_kind         text not null,
  agent_key        text not null references ai.agents(key) on delete restrict,
  hop_order        integer not null check (hop_order > 0),
  description      text not null
);
comment on table projects.p4q_task_types is 'OR4-I02: the Phase 4 task taxonomy as data. trigger_event and job_kind are checked against the event catalog by tests/p4q-orchestrator.test.ts so the two cannot drift.';
alter table projects.p4q_task_types enable row level security;
drop policy if exists p4q_task_types_read on projects.p4q_task_types;
create policy p4q_task_types_read on projects.p4q_task_types for select to authenticated using ((select core.is_internal()));
revoke all on projects.p4q_task_types from public, anon, authenticated;
grant select on projects.p4q_task_types to authenticated;
grant all on projects.p4q_task_types to service_role;

insert into projects.p4q_task_types (task_type, trigger_event, job_kind, agent_key, hop_order, description) values
  ('phase_four.route_task2_design', 'project.phase_four_started', 'orchestrator:routeTask2Design', 'orchestrator', 10, 'Route the first Task 2 hop to the Designer'),
  ('ui.draft', 'project.phase_four_started', 'ui_designer:draftUIVersion', 'ui_designer', 20, 'Draft the complete UI from the locked Phase 3 baseline'),
  ('ui.qa_review', 'project.ui_version_drafted', 'quality_assurance:reviewUIVersion', 'quality_assurance', 30, 'Design QA on the exact UI version'),
  ('ui.admin_review_request', 'project.ui_version_qa_reviewed', 'orchestrator:requestUIVersionAdminReview', 'orchestrator', 40, 'Raise Admin review for a QA-passed UI version'),
  ('ui.revise', 'project.ui_version_client_decided', 'ui_designer:reviseUIVersion', 'ui_designer', 50, 'Draft the next UI version from a QA, Admin or client change'),
  ('ui.feedback_classify', 'project.ui_version_client_decided', 'project_manager:classifyClientFeedback', 'project_manager', 55, 'Classify the client''s UI feedback'),
  ('prototype.build', 'project.ui_version_locked', 'ui_prototype:build', 'ui_prototype', 60, 'Build the prototype from the exact locked UI'),
  ('prototype.qa_review', 'project.prototype_build_ready', 'quality_assurance:reviewPrototypeBuild', 'quality_assurance', 70, 'Prototype QA on the exact build'),
  ('prototype.revise', 'project.prototype_qa_reviewed', 'ui_prototype:reviseBuild', 'ui_prototype', 80, 'Build the next prototype from QA, Admin or client changes'),
  ('phase_four.complete', 'project.deliverable_decided', 'projects:completePhaseFourOnPrototypeApproval', 'project_manager', 90, 'Complete Task 2 on the final prototype approval'),
  ('finance.m2_invoice', 'project.phase_four_completed', 'finance:generateM2Invoice', 'finance', 100, 'Prepare the M2 invoice')
on conflict (task_type) do nothing;

create table if not exists projects.p4q_agent_capability_profiles (
  agent_key        text primary key references ai.agents(key) on delete restrict,
  workload_tier    text not null check (workload_tier in ('GENERAL_HIGH_QUALITY_STRUCTURED', 'MULTIMODAL_LONG_CONTEXT', 'REASONING_HIGH_MULTIMODAL', 'CODING_HIGH_TOOL_AGENT', 'FINANCE_STRUCTURED', 'ROUTING_LOW_COST')),
  required_model_capabilities text[] not null,
  data_classes     text[] not null,
  supported_task_types text[] not null
);
comment on table projects.p4q_agent_capability_profiles is 'Orchestrator spec section 6-7: per agent, the workload tier, the model capabilities a run needs, the data classes it may see and the task types it supports. Fed to route planning; planRoute reading it is a wiring step.';
alter table projects.p4q_agent_capability_profiles enable row level security;
drop policy if exists p4q_profiles_read on projects.p4q_agent_capability_profiles;
create policy p4q_profiles_read on projects.p4q_agent_capability_profiles for select to authenticated using ((select core.is_internal()));
revoke all on projects.p4q_agent_capability_profiles from public, anon, authenticated;
grant select on projects.p4q_agent_capability_profiles to authenticated;
grant all on projects.p4q_agent_capability_profiles to service_role;
insert into projects.p4q_agent_capability_profiles (agent_key, workload_tier, required_model_capabilities, data_classes, supported_task_types) values
  ('project_manager', 'GENERAL_HIGH_QUALITY_STRUCTURED', array['structured_output'], array['client_confidential', 'internal'], array['ui.feedback_classify', 'phase_four.complete']),
  ('ui_designer', 'MULTIMODAL_LONG_CONTEXT', array['multimodal', 'long_context', 'structured_output'], array['client_confidential', 'internal'], array['ui.draft', 'ui.revise']),
  ('quality_assurance', 'REASONING_HIGH_MULTIMODAL', array['reasoning', 'multimodal', 'structured_output'], array['client_confidential', 'internal'], array['ui.qa_review', 'prototype.qa_review']),
  ('ui_prototype', 'CODING_HIGH_TOOL_AGENT', array['coding', 'tool_calling', 'structured_output'], array['client_confidential', 'internal'], array['prototype.build', 'prototype.revise']),
  ('finance', 'FINANCE_STRUCTURED', array['structured_output'], array['internal', 'financial'], array['finance.m2_invoice']),
  ('orchestrator', 'ROUTING_LOW_COST', array['structured_output'], array['internal'], array['phase_four.route_task2_design', 'ui.admin_review_request'])
on conflict (agent_key) do nothing;

-- ── envelopes and failures ────────────────────────────────────────────────
create table if not exists projects.p4q_execution_envelopes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  correlation_id   uuid not null,
  task_type        text not null references projects.p4q_task_types(task_type) on delete restrict,
  agent_key        text not null references ai.agents(key) on delete restrict,
  exact_refs       jsonb not null check (jsonb_typeof(exact_refs) = 'object' and exact_refs <> '{}'::jsonb),
  tools            text[] not null default '{}',
  retry_budget     integer not null default 3 check (retry_budget between 1 and 10),
  attempts         integer not null default 0 check (attempts >= 0),
  idempotency_key  text not null check (length(btrim(idempotency_key)) between 5 and 200),
  data_classification text not null default 'internal' check (data_classification in ('internal', 'client_confidential', 'financial')),
  policy_version   text not null check (length(btrim(policy_version)) between 1 and 80),
  status           text not null default 'open' check (status in ('open', 'succeeded', 'failed', 'escalated')),
  opened_at        timestamptz not null default clock_timestamp(),
  closed_at        timestamptz,
  unique (organization_id, idempotency_key),
  constraint p4q_env_closed_is_dated check ((status = 'open') = (closed_at is null))
);
comment on table projects.p4q_execution_envelopes is 'ExecutionEnvelope for a Phase 4 hop, persisted: exact references (ui version, build, deliverable ids; never "latest"), tools, retry budget, idempotency key, data classification and routing-policy version.';

create table if not exists projects.p4q_failure_records (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  envelope_id      uuid not null references projects.p4q_execution_envelopes(id) on delete restrict,
  failure_class    text not null check (failure_class in ('transient', 'permanent', 'policy_denied', 'validation', 'uncertain_side_effect', 'no_capable_agent', 'provider_unavailable')),
  attempt          integer not null check (attempt >= 1),
  detail           text not null check (length(btrim(detail)) between 1 and 1000),
  outcome          text not null check (outcome in ('retry', 'reconcile_first', 'escalated')),
  recorded_at      timestamptz not null default clock_timestamp()
);
comment on table projects.p4q_failure_records is 'RouteFailure: a classed failure of one envelope, the attempt it was and what the policy did (retry, reconcile first, escalate). Detail is scrubbed of credential shapes before it is stored.';

select projects.p7_guard_fk('p4q_execution_envelopes', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_failure_records', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_failure_records', 'envelope_id', 'projects.p4q_execution_envelopes');
select projects.p7_harden('projects', 'p4q_execution_envelopes');
select projects.p7_harden('projects', 'p4q_failure_records');
do $$ declare t text; begin
  foreach t in array array['p4q_execution_envelopes', 'p4q_failure_records'] loop
    execute format('drop trigger if exists %I on projects.%I', t || '_door_only', t);
    execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p4q_door_only()', t || '_door_only', t);
  end loop;
end $$;

create or replace function projects.p4q_open_envelope(p_project_id uuid, p_task_type text, p_exact_refs jsonb, p_idempotency_key text, p_retry_budget int default 3,
                                                       p_policy_version text default 'phase4-routing-1', p_data_classification text default 'internal')
returns table (outcome text, envelope_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_p     projects.projects;
  v_t     projects.p4q_task_types;
  v_agent ai.agents;
  v_f     projects.phase_four;
  v_k     text; v_v text; v_ok boolean;
  v_id    uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::uuid; return; end if;
  select * into v_p from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_p.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_actor is not null and (v_p.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text, null::uuid; return; end if;
  select * into v_t from projects.p4q_task_types where task_type = p_task_type;
  if v_t.task_type is null then return query select 'unknown_task_type'::text, null::uuid; return; end if;
  if p_exact_refs is null or jsonb_typeof(p_exact_refs) <> 'object' or p_exact_refs = '{}'::jsonb then return query select 'refs_required'::text, null::uuid; return; end if;
  -- exact references only: a known key, a uuid value, and the row must belong to THIS project (a stale or foreign id is refused, "latest" is not a reference)
  for v_k, v_v in select e.key, e.value #>> '{}' from jsonb_each(p_exact_refs) e loop
    if v_k not in ('uiVersionId', 'artifactId', 'deliverableId', 'phaseFourId', 'decisionId', 'milestoneId') then return query select 'unknown_ref_key'::text, null::uuid; return; end if;
    if v_v is null or v_v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return query select 'ref_not_exact'::text, null::uuid; return; end if;
    v_ok := case v_k
        when 'uiVersionId' then exists (select 1 from projects.ui_versions x where x.id = v_v::uuid and x.project_id = p_project_id)
        when 'artifactId' then exists (select 1 from projects.prototype_artifacts x where x.id = v_v::uuid and x.project_id = p_project_id)
        when 'deliverableId' then exists (select 1 from projects.deliverables x where x.id = v_v::uuid and x.project_id = p_project_id)
        when 'phaseFourId' then exists (select 1 from projects.phase_four x where x.id = v_v::uuid and x.project_id = p_project_id)
        when 'decisionId' then exists (select 1 from projects.ui_version_client_decisions x where x.id = v_v::uuid and x.project_id = p_project_id)
        else exists (select 1 from projects.milestones x where x.id = v_v::uuid and x.project_id = p_project_id) end;
    if not v_ok then
      return query select 'ref_not_in_project'::text, null::uuid; return;
    end if;
  end loop;
  select e.id into v_id from projects.p4q_execution_envelopes e where e.organization_id = v_p.organization_id and e.idempotency_key = p_idempotency_key;
  if v_id is not null then return query select 'already_open'::text, v_id; return; end if;
  select * into v_agent from ai.agents where key = v_t.agent_key;
  select * into v_f from projects.phase_four f where f.project_id = p_project_id;
  perform set_config('projects.p4q_door', 'on', true);
  if v_agent.enabled is not true then
    -- a disabled specialist is not silently routed around: it is recorded and a person is asked
    perform projects.p4q_open_escalation(p_project_id, 'disabled_specialist', 'The agent ' || v_t.agent_key || ' is disabled, so the Phase 4 task ' || p_task_type || ' cannot run. A person enables it or chooses another route.', 'admin', 'task_type', null, 'orchestrator');
    return query select 'agent_disabled'::text, null::uuid; return;
  end if;
  begin
    insert into projects.p4q_execution_envelopes (organization_id, project_id, correlation_id, task_type, agent_key, exact_refs, tools, retry_budget, idempotency_key, data_classification, policy_version)
    values (v_p.organization_id, p_project_id, coalesce(v_f.id, p_project_id), p_task_type, v_t.agent_key, p_exact_refs, '{}', greatest(1, least(coalesce(p_retry_budget, 3), 10)), p_idempotency_key, coalesce(p_data_classification, 'internal'), coalesce(nullif(btrim(p_policy_version), ''), 'phase4-routing-1'))
    returning id into v_id;
  exception when check_violation then return query select 'invalid'::text, null::uuid; return; end;
  return query select 'opened'::text, v_id;
end $$;
revoke all on function projects.p4q_open_envelope(uuid, text, jsonb, text, int, text, text) from public, anon;
grant execute on function projects.p4q_open_envelope(uuid, text, jsonb, text, int, text, text) to authenticated, service_role;

create or replace function projects.p4q_record_failure(p_envelope_id uuid, p_failure_class text, p_detail text)
returns table (outcome text, attempts integer, escalation_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_e     projects.p4q_execution_envelopes;
  v_n     int;
  v_det   text := projects.mask_secrets(btrim(coalesce(p_detail, '')));
  v_out   text; v_esc uuid; v_cause text; v_o text;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::int, null::uuid; return; end if;
  select * into v_e from projects.p4q_execution_envelopes where id = p_envelope_id for update;
  if v_e.id is null then return query select 'not_found'::text, null::int, null::uuid; return; end if;
  if v_actor is not null and (v_e.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text, null::int, null::uuid; return; end if;
  if v_e.status <> 'open' then return query select 'envelope_closed'::text, v_e.attempts, null::uuid; return; end if;
  if p_failure_class not in ('transient', 'permanent', 'policy_denied', 'validation', 'uncertain_side_effect', 'no_capable_agent', 'provider_unavailable') then return query select 'bad_class'::text, null::int, null::uuid; return; end if;
  if v_det = '' then return query select 'detail_required'::text, null::int, null::uuid; return; end if;
  v_n := v_e.attempts + 1;
  perform set_config('projects.p4q_door', 'on', true);
  if p_failure_class = 'uncertain_side_effect' then
    -- the effect may already have happened: reconcile it, do not run it again
    v_out := 'reconcile_first';
  elsif p_failure_class in ('transient', 'provider_unavailable') and v_n < v_e.retry_budget then
    v_out := 'retry';
  else
    v_out := 'escalated';
    v_cause := case p_failure_class when 'no_capable_agent' then 'no_capable_agent' when 'provider_unavailable' then 'provider_unavailable' else 'repeated_failure' end;
    select x.outcome, x.escalation_id into v_o, v_esc from projects.p4q_open_escalation(v_e.project_id, v_cause,
      'Phase 4 task ' || v_e.task_type || ' stopped after ' || v_n || ' attempt(s): ' || p_failure_class || '. ' || left(v_det, 300), 'admin', 'envelope', v_e.id, 'orchestrator',
      jsonb_build_object('envelopeId', v_e.id, 'taskType', v_e.task_type, 'exactRefs', v_e.exact_refs, 'attempts', v_n)) x;
  end if;
  insert into projects.p4q_failure_records (organization_id, project_id, envelope_id, failure_class, attempt, detail, outcome) values (v_e.organization_id, v_e.project_id, v_e.id, p_failure_class, v_n, left(v_det, 1000), v_out);
  update projects.p4q_execution_envelopes set attempts = v_n, status = case when v_out = 'escalated' then 'escalated' else 'open' end, closed_at = case when v_out = 'escalated' then clock_timestamp() end where id = v_e.id;
  return query select v_out, v_n, v_esc;
end $$;
revoke all on function projects.p4q_record_failure(uuid, text, text) from public, anon;
grant execute on function projects.p4q_record_failure(uuid, text, text) to authenticated, service_role;

create or replace function projects.p4q_complete_envelope(p_envelope_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_e projects.p4q_execution_envelopes;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text; return; end if;
  select * into v_e from projects.p4q_execution_envelopes where id = p_envelope_id for update;
  if v_e.id is null then return query select 'not_found'::text; return; end if;
  if v_actor is not null and (v_e.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text; return; end if;
  if v_e.status = 'succeeded' then return query select 'already_succeeded'::text; return; end if;
  if v_e.status <> 'open' then return query select 'envelope_closed'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update projects.p4q_execution_envelopes set status = 'succeeded', closed_at = clock_timestamp() where id = v_e.id;
  return query select 'succeeded'::text;
end $$;
revoke all on function projects.p4q_complete_envelope(uuid) from public, anon;
grant execute on function projects.p4q_complete_envelope(uuid) to authenticated, service_role;

-- the prior failures of a task, for the retry's context (ORCH-020)
create or replace function projects.p4q_prior_failures(p_envelope_id uuid)
returns table (attempt integer, failure_class text, detail text, outcome text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.role()) is distinct from 'service_role' and not coalesce((select core.is_internal()), false) then return; end if;
  return query select f.attempt, f.failure_class, f.detail, f.outcome from projects.p4q_failure_records f
    where f.envelope_id = p_envelope_id and (f.organization_id = (select core.current_organization_id()) or (select auth.role()) = 'service_role') order by f.attempt;
end $$;
revoke all on function projects.p4q_prior_failures(uuid) from public, anon;
grant execute on function projects.p4q_prior_failures(uuid) to authenticated, service_role;

-- ── the joined trace and the failure queue (internal staff) ────────────────
create or replace function projects.p4q_phase4_trace(p_project_id uuid)
returns table (at timestamptz, source text, kind text, from_agent text, to_agent text, summary text, ref_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_f uuid;
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return; end if;
  select f.id into v_f from projects.phase_four f where f.project_id = p_project_id;
  return query
  select * from (
    select h.created_at, 'handoff'::text, h.status, h.from_agent, h.to_agent, left(coalesce(h.objective, ''), 300), h.id
      from ai.handoffs h where h.organization_id = v_org and (h.project_id = p_project_id or (v_f is not null and h.correlation_id = v_f))
    union all
    select e.opened_at, 'envelope', e.status, null, e.agent_key, e.task_type || ' ' || e.exact_refs::text, e.id from projects.p4q_execution_envelopes e where e.project_id = p_project_id and e.organization_id = v_org
    union all
    select f.recorded_at, 'failure', f.failure_class, null, null, 'attempt ' || f.attempt || ': ' || f.outcome || ' - ' || left(f.detail, 200), f.id from projects.p4q_failure_records f where f.project_id = p_project_id and f.organization_id = v_org
    union all
    select x.opened_at, 'escalation', x.cause || '/' || x.state, x.raised_by_agent, null, left(x.reason, 300), x.id from projects.p4q_escalations x where x.project_id = p_project_id and x.organization_id = v_org
    union all
    select d.decided_at, 'designer_routing', case when d.allowed then 'allowed' else 'withheld' end, null, 'ui_designer', d.classification || ': ' || d.reason, d.id from projects.p4q_designer_routing_decisions d where d.project_id = p_project_id and d.organization_id = v_org
    union all
    select r.started_at, 'qa_run', r.outcome, null, 'quality_assurance', r.checks_failed || ' of ' || r.checks_total || ' checks failed', r.id from projects.p4q_prototype_qa_runs r where r.project_id = p_project_id and r.organization_id = v_org
    union all
    select s.shared_at, 'client_share', s.delivery_state, null, null, s.kind || ' via ' || s.channel, s.id from projects.p4q_client_review_shares s where s.project_id = p_project_id and s.organization_id = v_org
  ) t order by 1, 2, 7;
end $$;
revoke all on function projects.p4q_phase4_trace(uuid) from public, anon, service_role;
grant execute on function projects.p4q_phase4_trace(uuid) to authenticated;

create or replace function projects.p4q_failure_queue(p_project_id uuid)
returns table (envelope_id uuid, task_type text, agent_key text, status text, attempts integer, retry_budget integer, last_class text, last_detail text, last_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  select e.id, e.task_type, e.agent_key, e.status, e.attempts, e.retry_budget, lf.failure_class, lf.detail, lf.recorded_at
    from projects.p4q_execution_envelopes e
    join lateral (select f.* from projects.p4q_failure_records f where f.envelope_id = e.id order by f.attempt desc limit 1) lf on true
   where e.project_id = p_project_id and e.organization_id = v_org and e.status <> 'succeeded'
   order by lf.recorded_at desc;
end $$;
revoke all on function projects.p4q_failure_queue(uuid) from public, anon, service_role;
grant execute on function projects.p4q_failure_queue(uuid) to authenticated;

notify pgrst, 'reload schema';
