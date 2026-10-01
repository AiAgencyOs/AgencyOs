-- X2 / decision 12 (2026-10-01): plan activation requires internal approval,
-- enforced in the database.
--
-- Before: `projects.approve_project_plan` (20261006400200) recorded an internal
-- approval, and the Plan screen only offered "Validate and activate" once a plan
-- was approved. That was the SCREEN's rule. `projects.activate_project_plan`
-- itself never looked at approved_at, so anything calling the door (or updating
-- the row) could activate an unapproved plan.
--
-- After:
--   1. `projects.activate_project_plan` is carried forward from its LATEST body
--      (20260920100000_forty_eight_guards_that_could_fail_open.sql, which
--      superseded the 20260917150000 and 20260917210000 copies) with exactly one
--      addition: after the not_draft check, `not_approved` when approved_at is
--      null. Signature, grants and every other check are unchanged.
--   2. A trigger `projects.require_approval_before_active` on project_plans
--      refuses ANY row that becomes `active` without approved_at, whoever wrote
--      it. A plan that arrives already approved still activates through the door.
--
-- Additive and idempotent: create or replace, drop trigger if exists.

CREATE OR REPLACE FUNCTION projects.activate_project_plan(p_plan_id uuid)
 RETURNS TABLE(outcome text, findings text[], version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_count int;
  v_open  int;
  v_check record;
begin
  -- A person finalises a plan. §12: "actual phase transition authority remains
  -- with AgencyOS workflow/policy and responsible agents" — and a blueprint
  -- going live is what the pre-kickoff gate reads, so somebody owns it.
  if v_actor is null then
    return query select 'needs_person'::text, '{}'::text[], null::int; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, '{}'::text[], null::int; return;
  end if;

  if v_plan.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, '{}'::text[], null::int; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- [X2 decision 12] A plan goes live only after an internal approval, and the
  -- database is what says so: `projects.approve_project_plan` stamps
  -- approved_by / approved_at, and an unapproved draft is refused here AND by
  -- the trigger below, so no other writer (a script, a service-role call, a
  -- hand-typed UPDATE) can make an unapproved plan active either.
  if v_plan.approved_at is null then
    return query select 'not_approved'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- §7 requires a deliverables register. An empty plan that reads `active`
  -- would satisfy the pre-kickoff gate while containing nothing.
  select count(*) into v_count from projects.plan_deliverables d where d.plan_id = v_plan.id;
  if v_count = 0 then
    return query select 'no_deliverables'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- [G-257 edit 2 of 2] Planning §10: "never guesses an unclear client
  -- requirement", and PLAN-I09 validates ambiguity before ProjectPlanReady. A
  -- plan carrying an unanswered question is a plan that guessed the answer, so
  -- it cannot go live until every clarification is resolved or routed to a
  -- change request. Checked HERE rather than by a constraint because it is a
  -- rule about a moment, not about a row.
  select count(*) into v_open
    from projects.plan_clarifications c
   where c.plan_id = v_plan.id
     and c.status not in ('resolved', 'routed_to_change_request');
  if v_open > 0 then
    return query select 'open_clarifications'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- [G-265 edit 2 of 3] Planning §18 / PLAN-I09: "emit ProjectPlanReady only
  -- after validation pass." `project.plan_activated` IS that event, so the
  -- pass is required here rather than by a second event meaning the same
  -- thing. The findings come back so §18's checklist can be acted on.
  select * into v_check from projects.validate_project_plan(v_plan.id);
  if not v_check.valid then
    return query select 'invalid'::text, v_check.findings, v_plan.version; return;
  end if;

  update projects.project_plans
     set status = 'superseded'
   where project_id = v_plan.project_id and status = 'active';

  update projects.project_plans
     set status = 'active', activated_at = now(), activated_by = v_actor
   where id = v_plan.id;

  perform core.emit_event(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('plan_id', v_plan.id, 'version', v_plan.version, 'deliverables', v_count),
    null
  );

  perform core.record_audit(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'active', 'plan_id', v_plan.id, 'version', v_plan.version, 'activated_by', v_actor),
    null
  );

  return query select 'activated'::text, '{}'::text[], v_plan.version;
end;
$function$;

-- ── the same rule, below the door ──────────────────────────────────────────

create or replace function projects.require_approval_before_active()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active')
     and new.approved_at is null then
    raise exception 'plan % cannot go live: it has not been approved internally (projects.approve_project_plan)', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function projects.require_approval_before_active() is
  'X2 decision 12 - a plan becomes active only with an internal approval recorded (approved_at). Fires for every writer, not only the door.';

drop trigger if exists require_approval_before_active on projects.project_plans;
create trigger require_approval_before_active
  before insert or update of status on projects.project_plans
  for each row execute function projects.require_approval_before_active();

notify pgrst, 'reload schema';
