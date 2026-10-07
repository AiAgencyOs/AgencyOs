-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 QA spec, "Creator != Validator": the Designer must not validate its own UI and the
-- Prototype Agent must not validate its own build.
--
-- Until now that rule lived only in TypeScript (src/modules/agents/verification.ts, applied by the
-- quality_assurance workflow). The two verdict doors admitted ANY signed-in writer, including the very
-- person who drafted the version or built the prototype - so a raw call to the door could pass one's own work.
--
-- A draft or build now records who produced it (`produced_by`: the signed-in person who called the draft/build door,
-- stamped by a trigger so no door body had to be rewritten; NULL when the AI workflow - the service role - produced it).
-- Both verdict doors refuse `self_review` when the caller is that same person.
--
-- What stays in TypeScript, honestly: agent-vs-agent independence (the ui_designer workflow and the quality_assurance
-- workflow both run as the service role, which the database cannot tell apart); that is `verification.ts`'s job.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.ui_versions        add column if not exists produced_by uuid references core.users(id) on delete set null;
alter table projects.prototype_artifacts add column if not exists produced_by uuid references core.users(id) on delete set null;

create or replace function projects.stamp_produced_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.produced_by is null then
    new.produced_by := (select auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists ui_versions_stamp_produced_by on projects.ui_versions;
create trigger ui_versions_stamp_produced_by before insert on projects.ui_versions
  for each row execute function projects.stamp_produced_by();
drop trigger if exists prototype_artifacts_stamp_produced_by on projects.prototype_artifacts;
create trigger prototype_artifacts_stamp_produced_by before insert on projects.prototype_artifacts
  for each row execute function projects.stamp_produced_by();

CREATE OR REPLACE FUNCTION projects.record_ui_version_qa_verdict(p_ui_version_id uuid, p_outcome text, p_findings jsonb)
 RETURNS TABLE(outcome text, ui_version_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid := (select auth.uid());
  v_version projects.ui_versions;
  v_org     uuid;
begin
  -- The service role reviews because the trigger is the quality_assurance
  -- WORKFLOW reacting to `project.ui_version_drafted` — the same shape every
  -- event-triggered door in this migration set uses. A person may also record
  -- one, which is why the actor path exists at all.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if p_outcome not in ('qa_pass', 'qa_changes_required') then
    return query select 'bad_outcome'::text, null::uuid; return;
  end if;

  select v.* into v_version
    from projects.ui_versions v
   where v.id = p_ui_version_id
   for update;

  if v_version.id is null then
    return query select 'unknown_version'::text, null::uuid; return;
  end if;

  v_org := v_version.organization_id;

  if v_actor is not null
     and (v_org is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- ADM-82 in the database: a person who produced this draft cannot review it.
  if v_actor is not null and v_actor is not distinct from v_version.produced_by then
    return query select 'self_review'::text, null::uuid; return;
  end if;

  if v_version.status <> 'draft' then
    -- Master §22's idempotent-replay shape: a redelivered
    -- `project.ui_version_drafted` event must not overwrite an existing
    -- verdict with a second, possibly different one.
    return query select 'already_reviewed'::text, v_version.id; return;
  end if;

  update projects.ui_versions
     set status = p_outcome,
         qa_findings = p_findings,
         qa_reviewed_at = now()
   where id = v_version.id;

  perform core.record_audit(
    v_org, 'project.ui_version_qa_reviewed', 'ui_version', v_version.id, null,
    jsonb_build_object('projectId', v_version.project_id, 'outcome', p_outcome)
  );

  perform core.emit_event(
    v_org, 'project.ui_version_qa_reviewed',
    'ui_version', v_version.id,
    jsonb_build_object('projectId', v_version.project_id, 'phaseFourId', v_version.phase_four_id, 'outcome', p_outcome)
  );

  return query select 'recorded'::text, v_version.id;
end;
$function$;

CREATE OR REPLACE FUNCTION projects.record_prototype_qa_verdict(p_prototype_artifact_id uuid, p_outcome text, p_findings jsonb)
 RETURNS TABLE(outcome text, prototype_artifact_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_artifact projects.prototype_artifacts;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if p_outcome not in ('qa_pass', 'qa_changes_required') then
    return query select 'bad_outcome'::text, null::uuid; return;
  end if;

  select a.* into v_artifact
    from projects.prototype_artifacts a
   where a.id = p_prototype_artifact_id
   for update;

  if v_artifact.id is null then
    return query select 'unknown_artifact'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_artifact.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- ADM-82 in the database: a person who produced this build cannot review it.
  if v_actor is not null and v_actor is not distinct from v_artifact.produced_by then
    return query select 'self_review'::text, null::uuid; return;
  end if;

  if v_artifact.qa_reviewed_at is not null then
    -- Master §22's idempotent-replay shape: a redelivered event must not
    -- overwrite an existing verdict with a second, possibly different one.
    return query select 'already_reviewed'::text, v_artifact.id; return;
  end if;

  update projects.prototype_artifacts
     set status = p_outcome,
         qa_findings = p_findings,
         qa_reviewed_at = now()
   where id = v_artifact.id;

  perform core.record_audit(
    v_artifact.organization_id, 'project.prototype_qa_reviewed', 'prototype_artifact', v_artifact.id, null,
    jsonb_build_object('projectId', v_artifact.project_id, 'outcome', p_outcome)
  );

  perform core.emit_event(
    v_artifact.organization_id, 'project.prototype_qa_reviewed',
    'prototype_artifact', v_artifact.id,
    jsonb_build_object('projectId', v_artifact.project_id, 'deliverableId', v_artifact.deliverable_id, 'outcome', p_outcome)
  );

  return query select 'recorded'::text, v_artifact.id;
end;
$function$;

revoke all on function projects.record_ui_version_qa_verdict(uuid, text, jsonb) from public, anon;
grant execute on function projects.record_ui_version_qa_verdict(uuid, text, jsonb) to authenticated, service_role;
revoke all on function projects.record_prototype_qa_verdict(uuid, text, jsonb) from public, anon;
grant execute on function projects.record_prototype_qa_verdict(uuid, text, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
