-- Phase 5 Orchestrator spec: an Admin-approved development plan is routed to the specialists its tasks name.
-- The Orchestrator gets declared handoff routes to the eleven specialists (ADM-113); a route hands work over and grants nothing.
insert into ai.agent_handoff_targets (from_agent, to_agent)
values
  ('orchestrator', 'frontend_developer'), ('orchestrator', 'backend_developer'), ('orchestrator', 'database_developer'),
  ('orchestrator', 'mobile_developer'), ('orchestrator', 'integration'), ('orchestrator', 'devops_build'),
  ('orchestrator', 'test_automation'), ('orchestrator', 'security_review'), ('orchestrator', 'bug_fix'),
  ('orchestrator', 'refactor_performance'), ('orchestrator', 'documentation')
on conflict (from_agent, to_agent) do nothing;

insert into core.event_types (type, description, canonical) values
  ('project.development_plan_approved',
   'An Admin approved a development plan: every task has acceptance criteria and a named specialist, scope is covered, and unsequenced work on the same files is ruled out. The Orchestrator routes its tasks.',
   true)
on conflict (type) do nothing;

CREATE OR REPLACE FUNCTION projects.approve_development_plan(p_plan_id uuid)
 RETURNS TABLE(outcome text, problems text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.development_plans; v_problems text[];
begin
  if v_actor is null then return query select 'no_actor'::text, '{}'::text[]; return; end if;
  -- the PM cannot approve a plan: an Admin does
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, '{}'::text[]; return; end if;
  select * into v_plan from projects.development_plans p where p.id = p_plan_id and p.organization_id = v_org for update;
  if v_plan.id is null then return query select 'not_found'::text, '{}'::text[]; return; end if;
  if v_plan.status = 'approved' then return query select 'already_approved'::text, '{}'::text[]; return; end if;
  if v_plan.status <> 'draft' then return query select 'not_draft'::text, '{}'::text[]; return; end if;
  select coalesce(array_agg(c.problem), '{}') into v_problems from projects.check_development_plan(p_plan_id) c;
  if cardinality(v_problems) > 0 then return query select 'not_approvable'::text, v_problems; return; end if;
  update projects.development_plans set status = 'superseded' where project_id = v_plan.project_id and status = 'approved';
  update projects.development_plans set status = 'approved', approved_by = v_actor, approved_at = now() where id = v_plan.id;
  perform core.record_audit(v_org, 'development_plan.approved', 'development_plan', v_plan.id, null, jsonb_build_object('projectId', v_plan.project_id, 'version', v_plan.version));
  perform core.emit_event(v_org, 'project.development_plan_approved', 'development_plan', v_plan.id,
    jsonb_build_object('projectId', v_plan.project_id, 'version', v_plan.version));
  return query select 'approved'::text, '{}'::text[];
end $function$;

revoke all on function projects.approve_development_plan(uuid) from public, anon;
grant execute on function projects.approve_development_plan(uuid) to authenticated;

notify pgrst, 'reload schema';
