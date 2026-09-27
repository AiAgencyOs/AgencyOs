-- ═══════════════════════════════════════════════════════════════════════════
-- The escalation reuses the announcement it already had.
--
-- Both Phase 4 revision loops (`20260924100000`, `20260924110000`) stop
-- their workspace at `revision_limit_escalation` and call
-- `core.record_audit` for the moment — but neither calls `core.emit_event`,
-- so the ONE thing Master's "after limit: HUMAN ESCALATION" actually
-- requires — a person finding out — never happened. Worse: each declared
-- its OWN event type (`project.ui_revision_limit_reached`,
-- `project.prototype_revision_limit_reached`) that nothing ever subscribed
-- to, duplicating a mechanism that already existed and already worked:
-- Phase 3's `project.revision_limit_escalated`
-- (`crm:handleRevisionLimitEscalated`, live since G-309), which announces to
-- the internal channel from exactly this shape —
-- `{projectId, revisionCount, revisionLimit}`.
--
-- This `create or replace`s both doors to emit the EXISTING event instead of
-- their own dead ones. No new subscription, no new handler, no new schema —
-- `crm/schema.ts`'s own announcement text is generalized alongside this
-- migration (a phase-agnostic "a revision limit was reached" rather than a
-- Phase-3-only sentence) since it is now genuinely shared.
--
-- The two `event_types` rows this session inserted for the dead events stay
-- in `core.event_types` — a migration is not a place to delete a row a
-- later reader might expect a comment to explain — but nothing emits or
-- subscribes to them from this point on.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.revise_ui_version(
  p_phase_four_id uuid,
  p_screens       jsonb
)
returns table (
  outcome       text,
  ui_version_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_phase_four projects.phase_four;
  v_latest     projects.ui_versions;
  v_new        uuid;
  v_next_version int;
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

  if v_latest.status not in ('client_change', 'admin_edit') then
    return query select 'already_revised'::text, v_latest.id; return;
  end if;

  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'empty_screens'::text, null::uuid; return;
  end if;

  if v_phase_four.ui_revision_count >= v_phase_four.ui_revision_limit then
    update projects.phase_four
       set state = 'revision_limit_escalation',
           blocked_reason = format(
             'UI revision limit reached: %s round(s) already completed against a limit of %s. Human escalation required before another round.',
             v_phase_four.ui_revision_count, v_phase_four.ui_revision_limit
           )
     where id = v_phase_four.id;

    perform core.record_audit(
      v_phase_four.organization_id, 'project.revision_limit_escalated', 'phase_four', v_phase_four.id, null,
      jsonb_build_object('projectId', v_phase_four.project_id, 'revisionCount', v_phase_four.ui_revision_count, 'revisionLimit', v_phase_four.ui_revision_limit)
    );

    -- Reuses Phase 3's event and announcement (see migration header) rather
    -- than the dead `project.ui_revision_limit_reached` this session first
    -- declared and never wired.
    perform core.emit_event(
      v_phase_four.organization_id, 'project.revision_limit_escalated', 'phase_four', v_phase_four.id,
      jsonb_build_object('projectId', v_phase_four.project_id, 'revisionCount', v_phase_four.ui_revision_count, 'revisionLimit', v_phase_four.ui_revision_limit)
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
         ui_revision_count = ui_revision_count + 1
   where id = v_phase_four.id;

  perform core.record_audit(
    v_phase_four.organization_id, 'project.ui_version_drafted', 'ui_version', v_new, null,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id, 'version', v_next_version, 'revisionOf', v_latest.id)
  );

  perform core.emit_event(
    v_phase_four.organization_id, 'project.ui_version_drafted',
    'ui_version', v_new,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id)
  );

  return query select 'revised'::text, v_new;
end;
$$;

revoke all on function projects.revise_ui_version(uuid, jsonb) from public, anon;
grant execute on function projects.revise_ui_version(uuid, jsonb) to authenticated, service_role;

create or replace function projects.revise_prototype_build(
  p_ui_version_id uuid,
  p_screens       jsonb
)
returns table (
  outcome               text,
  prototype_artifact_id uuid,
  deliverable_id        uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := (select auth.uid());
  v_version     projects.ui_versions;
  v_phase_four  projects.phase_four;
  v_latest      record;
  v_deliverable record;
  v_new         uuid;
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

  select a.id as artifact_id, a.deliverable_id, d.status as deliverable_status
    into v_latest
    from projects.prototype_artifacts a
    join projects.deliverables d on d.id = a.deliverable_id
   where a.ui_version_id = v_version.id
   order by d.version desc
   limit 1;

  if v_latest.artifact_id is null then
    return query select 'no_prior_build'::text, null::uuid, null::uuid; return;
  end if;

  if v_latest.deliverable_status <> 'changes_requested' then
    return query select 'already_revised'::text, v_latest.artifact_id, v_latest.deliverable_id; return;
  end if;

  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'already_revised'::text, v_latest.artifact_id, v_latest.deliverable_id; return;
  end if;

  if v_phase_four.prototype_revision_count >= v_phase_four.prototype_revision_limit then
    update projects.phase_four
       set state = 'revision_limit_escalation',
           blocked_reason = format(
             'Prototype revision limit reached: %s round(s) already completed against a limit of %s. Human escalation required before another round.',
             v_phase_four.prototype_revision_count, v_phase_four.prototype_revision_limit
           )
     where id = v_phase_four.id;

    perform core.record_audit(
      v_phase_four.organization_id, 'project.revision_limit_escalated', 'phase_four', v_phase_four.id, null,
      jsonb_build_object('projectId', v_phase_four.project_id, 'revisionCount', v_phase_four.prototype_revision_count, 'revisionLimit', v_phase_four.prototype_revision_limit)
    );

    -- Reuses Phase 3's event and announcement (see migration header) rather
    -- than the dead `project.prototype_revision_limit_reached` this session
    -- first declared and never wired.
    perform core.emit_event(
      v_phase_four.organization_id, 'project.revision_limit_escalated', 'phase_four', v_phase_four.id,
      jsonb_build_object('projectId', v_phase_four.project_id, 'revisionCount', v_phase_four.prototype_revision_count, 'revisionLimit', v_phase_four.prototype_revision_limit)
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
         prototype_revision_count = prototype_revision_count + 1
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

  return query select 'revised'::text, v_new, v_deliverable.deliverable_id;
end;
$$;

revoke all on function projects.revise_prototype_build(uuid, jsonb) from public, anon;
grant execute on function projects.revise_prototype_build(uuid, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
