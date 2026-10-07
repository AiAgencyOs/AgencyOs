-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 UI Designer §Design-QA defect flow / QAP §Prototype-QA defect flow:
--
--   QA DEFECT -> DESIGNER FIX -> FIX_READY -> QA RETEST -> VERIFIED
--   (a "fixed" claim by the Designer / Prototype Agent is NOT verification)
--
-- Found by the audit: a UI version or prototype build QA sent back as qa_changes_required was a DEAD END. Only a client
-- change or an Admin edit could produce the next round; nothing fixed a QA defect. Master E2E steps 6-8 and 23-25 could not run.
--
-- A QA-defect fix is a NEW version / NEW build (never a mutation), reaching QA again from scratch - the old verdict is never
-- inherited. It has its OWN counter and limit: a QA defect is not the client asking for a revision, so it must not consume the client's
-- 2-3 revision rounds, but it must still be bounded ("do not continue unlimited AI generation") - at the limit the workspace stops
-- at revision_limit_escalation, exactly like the client loop, through the same reused event and announcement.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.phase_four
  add column if not exists ui_qa_fix_count           int not null default 0 check (ui_qa_fix_count >= 0),
  add column if not exists ui_qa_fix_limit           int not null default 3 check (ui_qa_fix_limit >= 0),
  add column if not exists prototype_qa_fix_count    int not null default 0 check (prototype_qa_fix_count >= 0),
  add column if not exists prototype_qa_fix_limit    int not null default 3 check (prototype_qa_fix_limit >= 0);

CREATE OR REPLACE FUNCTION projects.revise_ui_version(p_phase_four_id uuid, p_screens jsonb)
 RETURNS TABLE(outcome text, ui_version_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor      uuid := (select auth.uid());
  v_phase_four projects.phase_four;
  v_latest     projects.ui_versions;
  v_new        uuid;
  v_next_version int;
  v_is_qa      boolean;
  v_count      int;
  v_limit      int;
  v_what       text;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select p4.* into v_phase_four
    from projects.phase_four p4
   where p4.id = p_phase_four_id
   for update;

  if v_phase_four.id is null then
    return query select 'unknown_workspace'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_phase_four.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select v.* into v_latest
    from projects.ui_versions v
   where v.phase_four_id = v_phase_four.id
   order by v.version desc
   limit 1;

  if v_latest.id is null then
    return query select 'no_prior_version'::text, null::uuid; return;
  end if;

  -- A version Design QA sent back (qa_changes_required) is fixed by the Designer: Designer's FIXED is not VERIFIED -
  -- the fix is a NEW version that goes through Design QA again from scratch, and the old verdict never transfers.
  if v_latest.status not in ('client_change', 'admin_edit', 'qa_changes_required') then
    return query select 'already_revised'::text, v_latest.id; return;
  end if;

  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'empty_screens'::text, null::uuid; return;
  end if;

  v_is_qa := v_latest.status = 'qa_changes_required';
  v_count := case when v_is_qa then v_phase_four.ui_qa_fix_count else v_phase_four.ui_revision_count end;
  v_limit := case when v_is_qa then v_phase_four.ui_qa_fix_limit else v_phase_four.ui_revision_limit end;
  v_what  := case when v_is_qa then 'UI Design QA fix' else 'UI revision' end;

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
    -- than the dead `project.ui_revision_limit_reached` this session first
    -- declared and never wired.
    perform core.emit_event(
      v_phase_four.organization_id, 'project.revision_limit_escalated', 'phase_four', v_phase_four.id,
      jsonb_build_object('projectId', v_phase_four.project_id, 'revisionCount', v_count, 'revisionLimit', v_limit)
    );

    return query select 'revision_limit_reached'::text, null::uuid; return;
  end if;

  v_next_version := v_latest.version + 1;

  insert into projects.ui_versions (
    organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, screens
  ) values (
    v_phase_four.organization_id, v_phase_four.project_id, v_phase_four.id,
    v_latest.source_phase_three_handoff_id, v_next_version, p_screens
  )
  returning id into v_new;

  update projects.phase_four
     set state = 'ui_design',
         ui_revision_count = ui_revision_count + case when v_is_qa then 0 else 1 end,
         ui_qa_fix_count   = ui_qa_fix_count   + case when v_is_qa then 1 else 0 end
   where id = v_phase_four.id;

  perform core.record_audit(
    v_phase_four.organization_id, 'project.ui_version_drafted', 'ui_version', v_new, null,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id, 'version', v_next_version, 'revisionOf', v_latest.id, 'reason', case when v_is_qa then 'qa_defect' else 'revision' end)
  );

  perform core.emit_event(
    v_phase_four.organization_id, 'project.ui_version_drafted',
    'ui_version', v_new,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id)
  );

  return query select 'revised'::text, v_new;
end;
$function$;

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

  select a.id as artifact_id, a.deliverable_id, d.status as deliverable_status, a.status as artifact_status
    into v_latest
    from projects.prototype_artifacts a
    join projects.deliverables d on d.id = a.deliverable_id
   where a.ui_version_id = v_version.id
   order by d.version desc
   limit 1;

  if v_latest.artifact_id is null then
    return query select 'no_prior_build'::text, null::uuid, null::uuid; return;
  end if;

  -- A build Prototype QA sent back (qa_changes_required) is fixed by the Prototype Agent; FIXED is not VERIFIED - the fix is a
  -- NEW build that is QA'd from scratch, and the old build's verdict never transfers.
  if v_latest.deliverable_status <> 'changes_requested' and v_latest.artifact_status is distinct from 'qa_changes_required' then
    return query select 'already_revised'::text, v_latest.artifact_id, v_latest.deliverable_id; return;
  end if;

  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'already_revised'::text, v_latest.artifact_id, v_latest.deliverable_id; return;
  end if;

  v_is_qa := v_latest.artifact_status is not distinct from 'qa_changes_required' and v_latest.deliverable_status <> 'changes_requested';
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
  if v_is_qa then
    update projects.deliverables set status = 'superseded' where id = v_latest.deliverable_id and status = 'draft';
  end if;

  return query select 'revised'::text, v_new, v_deliverable.deliverable_id;
end;
$function$;

revoke all on function projects.revise_ui_version(uuid, jsonb) from public, anon;
grant execute on function projects.revise_ui_version(uuid, jsonb) to authenticated, service_role;
revoke all on function projects.revise_prototype_build(uuid, jsonb) from public, anon;
grant execute on function projects.revise_prototype_build(uuid, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
