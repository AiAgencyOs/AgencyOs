-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 Prototype spec, "ADMIN PROTOTYPE REVIEW": Admin EDIT -> PROTOTYPE AGENT -> QA -> ADMIN AGAIN. Never ADMIN EDIT -> CLIENT.
--
-- Found by the E2E walk: projects.decide_prototype_admin recorded admin_status = 'changes_required' and stopped. No event, no subscriber,
-- and revise_prototype_build only accepted a reviewer's changes_requested or a QA failure - so an Admin's prototype EDIT was a dead end
-- (E2E steps 26-27). The decision now emits `project.prototype_admin_decided`; revise_prototype_build accepts an Admin EDIT as a way
-- back to the Prototype Agent, counted on the same prototype revision budget as the client loop (Master names no separate one),
-- and the Admin-rejected build's deliverable is superseded - it was never shown to the client.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.prototype_admin_decided',
   'The Admin decided a prototype build (approved or changes_required). A changes_required decision sends the build back to the Prototype Agent for a new build; it is never shown to the client.',
   true)
on conflict (type) do nothing;

CREATE OR REPLACE FUNCTION projects.revise_prototype_build(p_ui_version_id uuid, p_screens jsonb)
 RETURNS TABLE(outcome text, prototype_artifact_id uuid, deliverable_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor       uuid := (select auth.uid());
  v_version     projects.ui_versions;
  v_phase_four  projects.phase_four;
  v_latest      record;
  v_deliverable record;
  v_new         uuid;
  v_is_qa       boolean;
  v_count       int;
  v_limit       int;
  v_what        text;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;

  select v.* into v_version
    from projects.ui_versions v
   where v.id = p_ui_version_id
   for update;

  if v_version.id is null then
    return query select 'unknown_version'::text, null::uuid, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_version.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  select p4.* into v_phase_four
    from projects.phase_four p4
   where p4.id = v_version.phase_four_id
   for update;

  if v_phase_four.id is null then
    return query select 'no_phase_four'::text, null::uuid, null::uuid; return;
  end if;

  select a.id as artifact_id, a.deliverable_id, d.status as deliverable_status, a.status as artifact_status, dd.admin_status as admin_status
    into v_latest
    from projects.prototype_artifacts a
    join projects.deliverables d on d.id = a.deliverable_id
    left join projects.deliverable_details dd on dd.deliverable_id = a.deliverable_id
   where a.ui_version_id = v_version.id
   order by d.version desc
   limit 1;

  if v_latest.artifact_id is null then
    return query select 'no_prior_build'::text, null::uuid, null::uuid; return;
  end if;

  -- A build Prototype QA sent back (qa_changes_required) is fixed by the Prototype Agent; FIXED is not VERIFIED - the fix is a
  -- NEW build that is QA'd from scratch, and the old build's verdict never transfers.
  -- Three ways back to the Prototype Agent: the client/reviewer's changes_requested, Prototype QA's qa_changes_required, and the Admin's
  -- own EDIT (deliverable_details.admin_status = 'changes_required') - which never reaches the client.
  if v_latest.deliverable_status <> 'changes_requested'
     and v_latest.artifact_status is distinct from 'qa_changes_required'
     and v_latest.admin_status is distinct from 'changes_required' then
    return query select 'already_revised'::text, v_latest.artifact_id, v_latest.deliverable_id; return;
  end if;

  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'already_revised'::text, v_latest.artifact_id, v_latest.deliverable_id; return;
  end if;

  v_is_qa := v_latest.artifact_status is not distinct from 'qa_changes_required' and v_latest.deliverable_status <> 'changes_requested' and v_latest.admin_status is distinct from 'changes_required';
  v_count := case when v_is_qa then v_phase_four.prototype_qa_fix_count else v_phase_four.prototype_revision_count end;
  v_limit := case when v_is_qa then v_phase_four.prototype_qa_fix_limit else v_phase_four.prototype_revision_limit end;
  v_what  := case when v_is_qa then 'Prototype QA fix' else 'Prototype revision' end;

  if v_count >= v_limit then
    update projects.phase_four
       set state = 'revision_limit_escalation',
           blocked_reason = format(
             '%s limit reached: %s round(s) already completed against a limit of %s. Human escalation required before another round.',
             v_what, v_count, v_limit
           )
     where id = v_phase_four.id;

    perform core.record_audit(
      v_phase_four.organization_id, 'project.revision_limit_escalated', 'phase_four', v_phase_four.id, null,
      jsonb_build_object('projectId', v_phase_four.project_id, 'revisionCount', v_count, 'revisionLimit', v_limit)
    );

    -- Reuses Phase 3's event and announcement (see migration header) rather
    -- than the dead `project.prototype_revision_limit_reached` this session
    -- first declared and never wired.
    perform core.emit_event(
      v_phase_four.organization_id, 'project.revision_limit_escalated', 'phase_four', v_phase_four.id,
      jsonb_build_object('projectId', v_phase_four.project_id, 'revisionCount', v_count, 'revisionLimit', v_limit)
    );

    return query select 'revision_limit_reached'::text, null::uuid, null::uuid; return;
  end if;

  select * into v_deliverable
    from projects.add_deliverable(
      v_version.project_id,
      'prototype',
      'Prototype build',
      '/projects/' || v_version.project_id || '/prototype/preview/' || v_version.id,
      null,
      null,
      null
    );

  if v_deliverable.outcome <> 'created' then
    return query select 'already_revised'::text, v_latest.artifact_id, v_latest.deliverable_id; return;
  end if;

  insert into projects.prototype_artifacts (
    organization_id, project_id, ui_version_id, deliverable_id, screens
  ) values (
    v_version.organization_id, v_version.project_id, v_version.id, v_deliverable.deliverable_id, p_screens
  )
  returning id into v_new;

  update projects.phase_four
     set state = 'prototype_build',
         prototype_revision_count = prototype_revision_count + case when v_is_qa then 0 else 1 end,
         prototype_qa_fix_count   = prototype_qa_fix_count   + case when v_is_qa then 1 else 0 end
   where id = v_phase_four.id;

  perform core.record_audit(
    v_phase_four.organization_id, 'project.prototype_build_ready', 'prototype_artifact', v_new, null,
    jsonb_build_object('projectId', v_version.project_id, 'uiVersionId', v_version.id, 'deliverableId', v_deliverable.deliverable_id, 'revisionOf', v_latest.artifact_id)
  );

  perform core.emit_event(
    v_phase_four.organization_id, 'project.prototype_build_ready',
    'prototype_artifact', v_new,
    jsonb_build_object('projectId', v_version.project_id, 'uiVersionId', v_version.id, 'deliverableId', v_deliverable.deliverable_id)
  );

  -- The QA-failed build was never shown to anyone; its deliverable row is replaced, not left dangling as a draft.
  if v_is_qa or v_latest.admin_status is not distinct from 'changes_required' then
    update projects.deliverables set status = 'superseded' where id = v_latest.deliverable_id and status = 'draft';
  end if;

  return query select 'revised'::text, v_new, v_deliverable.deliverable_id;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.decide_prototype_admin(p_deliverable_id uuid, p_decision text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.deliverables;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  -- Admin confirm/edit is the Admin's (owner, ops admin): the delivery lead
  -- who built it does not approve their own build.
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if p_decision not in ('approved', 'changes_required') then
    return query select 'bad_decision'::text; return;
  end if;
  if p_decision = 'changes_required' and v_note is null then
    return query select 'note_required'::text; return;
  end if;
  if v_note is not null and length(v_note) > 1000 then
    return query select 'too_long'::text; return;
  end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.kind <> 'prototype' then
    return query select 'wrong_kind'::text; return;
  end if;

  insert into projects.deliverable_details as dd (deliverable_id, organization_id, project_id, admin_status, admin_decided_by, admin_decided_at, admin_note)
  values (v_row.id, v_org, v_row.project_id, p_decision, v_actor, now(), v_note)
  on conflict (deliverable_id) do update
    set admin_status = excluded.admin_status, admin_decided_by = excluded.admin_decided_by,
        admin_decided_at = excluded.admin_decided_at, admin_note = excluded.admin_note, updated_at = now();

  perform core.record_audit(v_org, 'deliverable.prototype_admin_decided', 'deliverable', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'decision', p_decision, 'noted', v_note is not null));
  -- ADMIN EDIT -> PROTOTYPE AGENT -> QA -> ADMIN AGAIN: the decision is a fact the Prototype Agent's revision workflow acts on. Never ADMIN EDIT -> CLIENT.
  perform core.emit_event(v_org, 'project.prototype_admin_decided', 'deliverable', v_row.id,
    jsonb_build_object('projectId', v_row.project_id, 'deliverableId', v_row.id, 'decision', p_decision));

  return query select 'decided'::text;
end;
$function$;

revoke all on function projects.revise_prototype_build(uuid, jsonb) from public, anon;
grant execute on function projects.revise_prototype_build(uuid, jsonb) to authenticated, service_role;
revoke all on function projects.decide_prototype_admin(uuid, text, text) from public, anon;
grant execute on function projects.decide_prototype_admin(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
