-- ═══════════════════════════════════════════════════════════════════════════
-- The revision loop client_change asked for.
--
-- UI Client Revision Rule (UID §4); Master's locked objective: "CLIENT
-- REQUESTS REVISION ... CONTROLLED UI REVISION LOOP." `20260923140000`'s own
-- header named this gap explicitly: a `change_requested` decision moves a UI
-- version to `client_change` and stops there. This migration is that loop.
--
-- ── why `ui_versions` needed a schema change, not just a new door ────────
--
-- `ui_versions` carried `unique (phase_four_id)` — one draft per workspace,
-- because the loop did not exist yet. A second round is a second ROW: the
-- first version stays exactly as reviewed (its own QA findings, admin
-- decision and client words untouched), and the workspace gains a new
-- `draft` row at `version = previous + 1`. `unique (phase_four_id, version)`
-- replaces it — still refuses two rows claiming the same round, but no
-- longer refuses a second round existing at all.
--
-- Two read sites assumed "one row per workspace" under the old constraint
-- and are updated alongside this migration: `readPhaseFourOverview`
-- (src/modules/projects/queries.ts) now reads the latest version by
-- `order by version desc limit 1`, and nothing else in the codebase filters
-- `ui_versions` by `phase_four_id` alone — every job/handler reads a specific
-- version by its own `id`, carried in the event that woke it.
--
-- ── the door reuses `project.ui_version_drafted`, not a new event type ────
--
-- A revision's screens are drafted the same way the first version's were;
-- Design QA (`quality_assurance:reviewUIVersion`) already subscribes to
-- `project.ui_version_drafted` and reads the version by the id the event
-- names, not by "the workspace's only version" — it needs no change to
-- pick up a round-2 draft.
--
-- ── the revision limit is enforced in the door, not just displayed ───────
--
-- `phase_four.ui_revision_count`/`ui_revision_limit` have existed since
-- `20260923100000` and gone unread until now. This door increments the
-- count on every accepted revision and refuses a round past the limit,
-- moving the workspace to `revision_limit_escalation` (a stop state
-- `phase_four`'s own constraint already requires a `blocked_reason` for) —
-- Master's "after limit: HUMAN ESCALATION. Do not continue unlimited AI
-- generation," enforced at the one door capable of starting another round.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.ui_versions
  drop constraint if exists ui_versions_phase_four_id_key,
  add constraint ui_versions_phase_four_id_version_key unique (phase_four_id, version);

create or replace function projects.revise_ui_version(
  p_phase_four_id uuid,
  p_screens       jsonb
)
returns table (
  -- 'revised' | 'already_revised' | 'revision_limit_reached'
  -- | 'unknown_workspace' | 'no_prior_version'
  -- | 'empty_screens' | 'no_actor' | 'forbidden'
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
  -- Same shape `record_ui_version_draft` uses: the ui_designer workflow,
  -- reacting to `project.ui_version_client_decided`, is the ordinary caller.
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

  -- The ordinary path is client_change. Any other status on the latest
  -- version means a round for this client answer already exists — a replay
  -- of the same decision event must not draft a second round for one
  -- client answer, the idempotent-replay shape Master §22 names.
  if v_latest.status <> 'client_change' then
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
      v_phase_four.organization_id, 'project.ui_revision_limit_reached', 'phase_four', v_phase_four.id, null,
      jsonb_build_object('projectId', v_phase_four.project_id, 'uiRevisionCount', v_phase_four.ui_revision_count, 'uiRevisionLimit', v_phase_four.ui_revision_limit)
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

  -- Reuses the SAME event `record_ui_version_draft` emits for a version's
  -- first draft. Design QA already subscribes to it and reads the version
  -- by the id this event names, not by "the workspace's only version" — no
  -- new subscription is needed for a round-2+ draft to be reviewed.
  perform core.emit_event(
    v_phase_four.organization_id, 'project.ui_version_drafted',
    'ui_version', v_new,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id)
  );

  return query select 'revised'::text, v_new;
end;
$$;

comment on function projects.revise_ui_version(uuid, jsonb) is
  'UI Client Revision Rule (UID section 4). Drafts round N+1 for a workspace whose latest UI version is client_change, under the workspace''s own row lock. Enforces ui_revision_limit here rather than only displaying it: a round past the limit moves the workspace to revision_limit_escalation and drafts nothing (Master: "after limit: HUMAN ESCALATION"). Reuses project.ui_version_drafted rather than a new event type, since Design QA already reads a version by the id an event names.';

revoke all on function projects.revise_ui_version(uuid, jsonb) from public, anon;
grant execute on function projects.revise_ui_version(uuid, jsonb) to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.ui_revision_limit_reached',
   'UI Client Revision Rule. A client_change decision arrived after phase_four.ui_revision_count already reached ui_revision_limit. The workspace stops at revision_limit_escalation for human escalation rather than drafting another AI round.',
   true)
on conflict (type) do nothing;

notify pgrst, 'reload schema';
