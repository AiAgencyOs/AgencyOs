-- The kickoff gate says "ready" only when the kickoff can actually complete.
--
-- Carried forward from pre_kickoff_readiness's live body with one addition: an
-- accepted requirement (the one ADM-13 condition the gate did not look at).
-- Found by pressing the real "Send the kickoff" button on a project that read
-- "every gate is met": the message reached the group, and the project was then
-- refused ACTIVE for a missing accepted requirement.

CREATE OR REPLACE FUNCTION projects.pre_kickoff_readiness(p_project_id uuid)
 RETURNS TABLE(ready boolean, unmet text[], onboarding_settled boolean, group_ready boolean, payment_verified boolean, plan_ready boolean)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_onboarding boolean;
  v_group      boolean;
  v_payment    boolean;
  v_plan       boolean;
  v_unmet      text[] := '{}';
  v_start      record;
begin
  -- Every checklist item except the three the kickoff itself settles.
  --
  -- The checklist must EXIST as well as be settled. `not exists (... pending)`
  -- alone is true for a project with no checklist at all, so a project nobody
  -- ever onboarded would sail through the gate that exists to check it was —
  -- the absence-only assertion this repository has been caught by before.
  -- Found by driving it: a bare fixture reported `onboarding_settled` true.
  -- [G-261 edit 1 of 1] Only items the owner has explicitly marked REQUIRED.
  --
  -- G-258 blocked on EVERY pending item, which contradicted ADM-06 — granted
  -- 2026-08-13: "the onboarding checklist blocks nothing; every item is a
  -- reminder." Master §5.10 asks the gate to verify "required onboarding
  -- data", and until this migration nothing recorded which items were
  -- required, so "every item" was the only reading available and it was the
  -- wrong one.
  --
  -- Now: `requirement = 'required'` is the gate. Nothing is marked required
  -- yet, so today this blocks nothing and ADM-06 holds; the moment the owner
  -- marks some, those become the gate and §5.10 holds. ADM-108 asks which.
  --
  -- The existence check is gone with it: a project with no checklist now
  -- passes, because it has no REQUIRED items — which is the same answer
  -- ADM-06 gives for a project with a checklist nobody configured.
  select not exists (
    select 1
      from projects.onboarding_items oi
     where oi.project_id = p_project_id
       and oi.requirement = 'required'
       and oi.status not in ('verified', 'not_applicable')
       and oi.key not in ('kickoff_sent', 'project_activated', 'whatsapp_group_mapped')
  )
  into v_onboarding;

  -- "WhatsApp mapping IF REQUIRED": required exactly when a card was raised
  -- for this project. A project whose Phase 2 began before G-253 has no card,
  -- and demanding a state that nothing can produce would block it forever.
  select coalesce(
    (select gs.state in ('mapped', 'verified') from projects.group_setups gs where gs.project_id = p_project_id),
    true
  ) into v_group;

  -- Reused, not re-derived. `start_readiness.advance_verified` already follows
  -- `verified_minor` rather than `paid_minor` (G-007), which is the rule
  -- Finance §6 states as "proof never auto-verifies".
  select * into v_start from projects.start_readiness(p_project_id);
  v_payment := v_start.advance_verified;

  select exists (
    select 1 from projects.project_plans pp
     where pp.project_id = p_project_id and pp.status = 'active'
  ) into v_plan;

  -- THERE IS DELIBERATELY NO OPEN-QUESTION GATE HERE, and its absence was
  -- found by driving this rather than by reading it.
  --
  -- The first version of this function counted unresolved clarifications on
  -- the active plan. That count can never be anything but zero: a
  -- clarification may only be raised against a DRAFT plan (the door refuses
  -- `not_draft`, and `refuse_write_to_settled_plan` refuses the direct write),
  -- and G-257 already refuses to activate a plan carrying one. So the gate
  -- could not fail, while reading as though the kickoff checked for open
  -- questions — an absence-only assertion, one layer too late.
  --
  -- The rule is held where it can actually bite. If clarifications are ever
  -- made raisable against a live plan, this gate has to come back.

  if not v_onboarding then v_unmet := v_unmet || 'onboarding_incomplete'::text; end if;
  if not v_group     then v_unmet := v_unmet || 'whatsapp_group_not_mapped'::text; end if;
  if not v_payment   then v_unmet := v_unmet || 'advance_not_verified'::text; end if;
  if not v_plan      then v_unmet := v_unmet || 'no_active_plan'::text; end if;
  -- [Phase 2 Master §5.10] "ready" must be TRUE. `projects.start_project` (the
  -- kickoff's last step, ADM-13) also needs an accepted requirement, so a
  -- project could read "every gate is met", have the official kickoff message
  -- SENT to the client, and then be refused ACTIVE for a Phase 1 fact the gate
  -- never looked at. Found by pressing the real kickoff button. The accepted
  -- requirement is Phase 1's, so a missing one is staff's to repair.
  if not coalesce(v_start.requirement_approved, false) then v_unmet := v_unmet || 'no_approved_requirement'::text; end if;

  return query select
    array_length(v_unmet, 1) is null,
    v_unmet, v_onboarding, v_group, v_payment, v_plan;
end;
$function$;
