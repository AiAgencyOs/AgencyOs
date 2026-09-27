-- ═══════════════════════════════════════════════════════════════════════════
-- The prototype gets its revision loop too.
--
-- Client Prototype Revision (PROTO §21; Master's locked objective:
-- "CLIENT REQUESTS REVISION ... CONTROLLED PROTOTYPE REVISION LOOP").
-- `20260923150000`'s own header built the FIRST build only; a
-- `changes_requested` decision on the `deliverables` row it reuses already
-- routes to `crm:announcePrototypeChangeRequested`, but nothing builds
-- round 2 — the identical shape `20260924100000` closed for the UI version
-- loop, one stage later.
--
-- ── why `prototype_artifacts.ui_version_id` needed to stop being unique ──
--
-- One artifact per LOCKED UI version was correct for a build that could
-- only ever happen once. A revision is a second BUILD against the SAME
-- locked UI (the client is reviewing a build defect or a change, not a new
-- design) — `unique (ui_version_id, deliverable_id)` replaces the old
-- `unique (ui_version_id)`: still refuses two artifacts claiming the same
-- deliverable, no longer refuses a second deliverable existing at all.
-- `deliverable_id` was already unique on its own, which is the real 1:1
-- identity here; the composite is kept so the column comment's own
-- "one per locked UI version" claim is corrected without deleting the
-- constraint a future reader would look for.
--
-- ── the door reuses `project.prototype_build_ready`, not a new event ─────
--
-- Prototype QA (`quality_assurance:reviewPrototypeBuild`) already subscribes
-- to it and reads the artifact by the id the event names — the same reuse
-- argument the UI version loop made for `project.ui_version_drafted`.
--
-- ── the limit is enforced here, exactly as the UI loop's door does ───────
--
-- `phase_four.prototype_revision_count`/`prototype_revision_limit` have
-- existed since `20260923100000` and gone unread until now.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.prototype_artifacts
  drop constraint if exists prototype_artifacts_ui_version_id_key,
  add constraint prototype_artifacts_ui_version_deliverable_key unique (ui_version_id, deliverable_id);

comment on column projects.prototype_artifacts.ui_version_id is
  'Which locked UI version this build is from. No longer unique alone (20260924110000): a prototype revision is a second build against the SAME locked UI, so this column repeats across rounds while deliverable_id stays the per-build identity.';

create or replace function projects.revise_prototype_build(
  p_ui_version_id uuid,
  p_screens       jsonb
)
returns table (
  -- 'revised' | 'already_revised' | 'revision_limit_reached'
  -- | 'unknown_version' | 'no_prior_build' | 'no_phase_four'
  -- | 'no_actor' | 'forbidden'
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
  -- Same shape `revise_ui_version` uses: the ui_prototype workflow, reacting
  -- to `project.deliverable_decided`, is the ordinary caller.
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

  -- Any status other than changes_requested means a round for this decision
  -- already exists — a replay of the same event must not build a second
  -- round for one client answer, the idempotent-replay shape Master §22
  -- names and `revise_ui_version` already applies one stage earlier.
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
      v_phase_four.organization_id, 'project.prototype_revision_limit_reached', 'phase_four', v_phase_four.id, null,
      jsonb_build_object('projectId', v_phase_four.project_id, 'prototypeRevisionCount', v_phase_four.prototype_revision_count, 'prototypeRevisionLimit', v_phase_four.prototype_revision_limit)
    );

    return query select 'revision_limit_reached'::text, null::uuid, null::uuid; return;
  end if;

  -- The existing door. No second "create a deliverable" mechanism, the same
  -- reuse `record_prototype_build` already established.
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

  -- Reuses the SAME event `record_prototype_build` emits for the first
  -- build. Prototype QA already subscribes to it and reads the artifact by
  -- the id this event names.
  perform core.emit_event(
    v_phase_four.organization_id, 'project.prototype_build_ready',
    'prototype_artifact', v_new,
    jsonb_build_object('projectId', v_version.project_id, 'uiVersionId', v_version.id, 'deliverableId', v_deliverable.deliverable_id)
  );

  return query select 'revised'::text, v_new, v_deliverable.deliverable_id;
end;
$$;

comment on function projects.revise_prototype_build(uuid, jsonb) is
  'Client Prototype Revision (PROTO section 21). Builds round N+1 for the locked UI version''s latest prototype whose deliverable is changes_requested, under the workspace''s own row lock. Enforces prototype_revision_limit here rather than only displaying it: a round past the limit moves the workspace to revision_limit_escalation and builds nothing. Reuses project.prototype_build_ready rather than a new event type, since Prototype QA already reads a build by the id an event names.';

revoke all on function projects.revise_prototype_build(uuid, jsonb) from public, anon;
grant execute on function projects.revise_prototype_build(uuid, jsonb) to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.prototype_revision_limit_reached',
   'Client Prototype Revision. A changes_requested decision on a prototype deliverable arrived after phase_four.prototype_revision_count already reached prototype_revision_limit. The workspace stops at revision_limit_escalation for human escalation rather than building another AI round.',
   true)
on conflict (type) do nothing;

notify pgrst, 'reload schema';
