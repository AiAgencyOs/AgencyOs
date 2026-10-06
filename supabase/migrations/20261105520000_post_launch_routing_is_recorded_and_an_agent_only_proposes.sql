-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 (part B), post-launch routing and the agents' proposals (tables: 20261105500000; gates and doors: 20261105510000).
--
--   projects.set_maintenance_sla_policy        an Admin chooses the SLA hours per priority, versioned. NONE is invented: until a policy exists routing says
--                                              the SLA is unknown. (20260821260000 declined SLA numbers because no document makes a commitment.)
--   projects.record_maintenance_routing        SERVICE ROLE ONLY. The Orchestrator's decision (pure TypeScript) is recorded with its explained candidates and
--                                              the policy it was made under. The Orchestrator ROUTES: it approves, verifies and releases nothing, and a builder
--                                              is never routed as its own QA.
--   projects.request_maintenance_agent_run     a person with delivery rights asks the Bug Fix agent for a fix plan or the Regression agent for a regression
--                                              plan; the request records WHO asked (the person who may not accept what comes back)
--   projects.record_maintenance_agent_proposal SERVICE ROLE ONLY. A proposal is a draft: it never records a QA result, a commit or a release.
--   projects.decide_maintenance_agent_proposal an INDEPENDENT person accepts or rejects; a rejection is final
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.set_maintenance_sla_policy(p_priority text, p_response_hours int, p_resolution_hours int, p_at_risk_percent int default null)
returns table (outcome text, policy_version int)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_next int;
begin
  if v_actor is null then return query select 'no_actor'::text, 0; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, 0; return; end if;
  if p_priority not in ('p0', 'p1', 'p2', 'p3') then return query select 'bad_priority'::text, 0; return; end if;
  if p_response_hours is null or p_response_hours <= 0 or p_resolution_hours is null or p_resolution_hours < p_response_hours then return query select 'bad_hours'::text, 0; return; end if;
  if p_at_risk_percent is not null and p_at_risk_percent not between 1 and 99 then return query select 'bad_at_risk_percent'::text, 0; return; end if;
  perform pg_advisory_xact_lock(hashtext('maintenance_sla:' || v_org::text || p_priority));
  select coalesce(max(version), 0) + 1 into v_next from projects.maintenance_sla_policies where organization_id = v_org and priority = p_priority;
  insert into projects.maintenance_sla_policies (organization_id, priority, version, response_hours, resolution_hours, at_risk_percent, set_by) values (v_org, p_priority, v_next, p_response_hours, p_resolution_hours, p_at_risk_percent, v_actor);
  perform core.record_audit(v_org, 'maintenance_sla.set', 'maintenance_sla_policy', null, null, jsonb_build_object('priority', p_priority, 'version', v_next, 'response', p_response_hours, 'resolution', p_resolution_hours));
  return query select 'set'::text, v_next;
end $$;
revoke all on function projects.set_maintenance_sla_policy(text, int, int, int) from public, anon;
grant execute on function projects.set_maintenance_sla_policy(text, int, int, int) to authenticated;

create or replace function projects.record_maintenance_routing(
  p_organization_id uuid, p_work_item_id uuid, p_decision_key text, p_outcome text, p_priority text, p_to_agent text, p_reason text,
  p_candidates jsonb, p_sla jsonb, p_requires_security_review boolean, p_independent_qa jsonb, p_policy_version text, p_correlation_id uuid default null, p_decided_by uuid default null)
returns table (outcome text, decision_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_i projects.maintenance_work_items; v_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id;
  if v_i.id is null or v_i.organization_id is distinct from p_organization_id then return query select 'not_found'::text, null::uuid; return; end if;
  if v_i.status in ('released', 'cancelled') then return query select 'item_closed'::text, null::uuid; return; end if;
  if p_outcome not in ('routed', 'held', 'refused', 'escalated') or p_priority not in ('p0', 'p1', 'p2', 'p3') then return query select 'bad_decision'::text, null::uuid; return; end if;
  if p_outcome = 'routed' and (p_to_agent is null or not exists (select 1 from ai.agents a where a.key = p_to_agent)) then return query select 'unknown_agent'::text, null::uuid; return; end if;
  -- the builder is never the QA of its own work
  if p_outcome = 'routed' and p_to_agent in ('quality_assurance', 'regression_test', 'functional_test', 'security_test', 'release_readiness') then return query select 'builder_cannot_be_qa'::text, null::uuid; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 or jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_sla, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_independent_qa, '[]'::jsonb)) <> 'array' or p_decision_key is null or length(btrim(p_decision_key)) = 0 then
    return query select 'bad_input'::text, null::uuid; return;
  end if;
  insert into projects.maintenance_routing_decisions (organization_id, work_item_id, decision_key, outcome, priority, to_agent, reason, candidates, sla, requires_security_review, independent_qa, policy_version, correlation_id, decided_by)
  values (p_organization_id, v_i.id, btrim(p_decision_key), p_outcome, p_priority, p_to_agent, btrim(p_reason), coalesce(p_candidates, '[]'::jsonb), coalesce(p_sla, '{}'::jsonb), coalesce(p_requires_security_review, false),
          coalesce(p_independent_qa, '[]'::jsonb), p_policy_version, p_correlation_id, p_decided_by)
  on conflict (work_item_id, decision_key) do nothing returning id into v_id;
  if v_id is null then return query select 'already_recorded'::text, null::uuid; return; end if;
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_maintenance_routing(uuid, uuid, text, text, text, text, text, jsonb, jsonb, boolean, jsonb, text, uuid, uuid) from public, anon, authenticated;
grant execute on function projects.record_maintenance_routing(uuid, uuid, text, text, text, text, text, jsonb, jsonb, boolean, jsonb, text, uuid, uuid) to service_role;

create or replace function projects.request_maintenance_agent_run(p_work_item_id uuid, p_agent_key text)
returns table (outcome text, request_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.maintenance_work_items; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_agent_key not in ('bug_fix', 'regression_test') then return query select 'bad_agent'::text, null::uuid; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org;
  if v_i.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_i.status in ('released', 'cancelled') then return query select 'item_closed'::text, null::uuid; return; end if;
  -- a regression plan is about a change that exists
  if p_agent_key = 'regression_test' and v_i.commit_ref is null then return query select 'no_commit_yet'::text, null::uuid; return; end if;
  insert into projects.maintenance_agent_requests (organization_id, work_item_id, agent_key, requested_by) values (v_org, v_i.id, p_agent_key, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_work.agent_requested', 'maintenance_work_item', v_i.id, null, jsonb_build_object('agent', p_agent_key, 'requestId', v_id));
  return query select 'requested'::text, v_id;
end $$;
revoke all on function projects.request_maintenance_agent_run(uuid, text) from public, anon;
grant execute on function projects.request_maintenance_agent_run(uuid, text) to authenticated;

create or replace function projects.record_maintenance_agent_proposal(
  p_request_id uuid, p_organization_id uuid, p_agent_key text, p_kind text, p_summary text, p_steps jsonb, p_risks jsonb, p_needs_scope_change boolean,
  p_recommends_security_review boolean, p_evidence_refs text[], p_commit_ref text)
returns table (outcome text, proposal_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_req projects.maintenance_agent_requests; v_i projects.maintenance_work_items; v_text text; v_id uuid; v_refs text[] := coalesce(p_evidence_refs, '{}');
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_req from projects.maintenance_agent_requests r where r.id = p_request_id;
  if v_req.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  -- the organization is the JOB's, never one a payload names
  if v_req.organization_id is distinct from p_organization_id then return query select 'wrong_organization'::text, null::uuid; return; end if;
  if p_agent_key is distinct from v_req.agent_key then return query select 'wrong_agent'::text, null::uuid; return; end if;
  if p_kind is distinct from (case v_req.agent_key when 'bug_fix' then 'fix_plan' else 'regression_plan' end) then return query select 'kind_not_for_this_agent'::text, null::uuid; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = v_req.work_item_id;
  if v_i.id is null or v_i.organization_id is distinct from p_organization_id then return query select 'wrong_organization'::text, null::uuid; return; end if;
  if v_i.status in ('released', 'cancelled') then return query select 'item_closed'::text, null::uuid; return; end if;
  if p_summary is null or length(btrim(p_summary)) = 0 or length(p_summary) > 2000 or jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) not between 1 and 20
     or jsonb_typeof(coalesce(p_risks, '[]'::jsonb)) <> 'array' or cardinality(v_refs) > 20 then
    return query select 'bad_input'::text, null::uuid; return;
  end if;
  -- a proposal that names a commit names the one the item holds NOW
  if p_commit_ref is not null and p_commit_ref is distinct from v_i.commit_ref then return query select 'wrong_commit'::text, null::uuid; return; end if;
  v_text := p_summary || E'\n' || p_steps::text || E'\n' || coalesce(p_risks::text, '') || E'\n' || array_to_string(v_refs, E'\n');
  if v_text ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-.]{12,}' or v_text ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})' then
    return query select 'secret_in_text'::text, null::uuid; return;
  end if;
  insert into projects.maintenance_agent_proposals (organization_id, work_item_id, request_id, agent_key, kind, summary, steps, risks, needs_scope_change, recommends_security_review, evidence_refs, commit_ref, requested_by)
  values (p_organization_id, v_i.id, v_req.id, p_agent_key, p_kind, btrim(p_summary), p_steps, coalesce(p_risks, '[]'::jsonb), coalesce(p_needs_scope_change, false), coalesce(p_recommends_security_review, false), v_refs, p_commit_ref, v_req.requested_by)
  on conflict (request_id, kind) do nothing returning id into v_id;
  if v_id is null then return query select 'already_proposed'::text, null::uuid; return; end if;
  return query select 'proposed'::text, v_id;
end $$;
revoke all on function projects.record_maintenance_agent_proposal(uuid, uuid, text, text, text, jsonb, jsonb, boolean, boolean, text[], text) from public, anon, authenticated;
grant execute on function projects.record_maintenance_agent_proposal(uuid, uuid, text, text, text, jsonb, jsonb, boolean, boolean, text[], text) to service_role;

create or replace function projects.decide_maintenance_agent_proposal(p_proposal_id uuid, p_decision text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.maintenance_agent_proposals;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('accepted', 'rejected') then return query select 'bad_decision'::text; return; end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_note, ''))) = 0 then return query select 'note_required'::text; return; end if;
  select * into v_p from projects.maintenance_agent_proposals x where x.id = p_proposal_id and x.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if exists (select 1 from projects.maintenance_agent_proposal_decisions d where d.proposal_id = v_p.id) then return query select 'already_decided'::text; return; end if;
  -- creator != validator: whoever asked for the work does not accept it, and cannot bury an unwelcome one
  if v_p.requested_by = v_actor then return query select 'self_acceptance'::text; return; end if;
  insert into projects.maintenance_agent_proposal_decisions (organization_id, proposal_id, decision, note, decided_by) values (v_org, v_p.id, p_decision, nullif(btrim(coalesce(p_note, '')), ''), v_actor);
  perform core.record_audit(v_org, 'maintenance_work.proposal_' || p_decision, 'maintenance_agent_proposal', v_p.id, null, jsonb_build_object('agent', v_p.agent_key, 'kind', v_p.kind));
  return query select p_decision;
end $$;
revoke all on function projects.decide_maintenance_agent_proposal(uuid, text, text) from public, anon;
grant execute on function projects.decide_maintenance_agent_proposal(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
