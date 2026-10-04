-- Phase 2 starting moves the project to ONBOARDING.
--
-- Master §9: PROJECT is WON_HANDOFF -> ONBOARDING -> KICKOFF_READY -> ACTIVE.
-- `start_phase_two` is carried forward from its live body with one addition: the
-- project's status moves planning -> onboarding with the phase, so the kickoff
-- (`start_project`, which accepts only `onboarding`) can complete without
-- somebody editing the status by hand first.

CREATE OR REPLACE FUNCTION projects.start_phase_two(p_project_id uuid)
 RETURNS TABLE(outcome text, phase_two_id uuid, handoff_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          or not coalesce((select core.can_write()), false)) then
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

  -- [Master §9 project state] WON_HANDOFF -> ONBOARDING. A won deal becomes a
  -- project in `planning`, and `projects.start_project` (the kickoff's last
  -- step) starts only a project in `onboarding`; nothing moved it there, so
  -- the official kickoff of a project that had gone through the whole of Phase 2
  -- was refused as 'would not start' unless a person had changed its status by
  -- hand. Found by driving the whole flow. Only planning -> onboarding, only
  -- here, and a project already beyond it is left exactly as it is.
  update projects.projects set status = 'onboarding' where id = p_project_id and status = 'planning';

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
$function$;
