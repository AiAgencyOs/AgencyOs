-- ═══════════════════════════════════════════════════════════════════════════
-- Admin review reuses the engine, the same way handover did.
--
-- Impl §7.2 (ADMIN_REVIEW), UID §18; Master's locked objective: "QA PASS
-- → ADMIN REVIEW → PM SHARE → CLIENT". `docs/phase-4-gap-analysis.md` step 3.
--
-- `20260813120003_handover.sql` already made this exact call once a client's
-- acceptance needed a mechanism: *"A handover is accepted by the client, which
-- is exactly what the engine's client audience is for, and adding a subject
-- beats inventing a second acceptance mechanism beside it."* A UI version's
-- Admin review is the identical shape one audience earlier — CONFIRM or EDIT,
-- by a role, on a snapshot, with a durable audit trail — so this migration
-- adds `ui_version` to the same two CHECK constraints `handover` was added to,
-- rather than building Phase 4 its own approval table.
--
-- ── CONFIRM/EDIT maps onto the engine's three-state decision, not four ────
--
-- Master's Admin UI Review section names exactly two actions: CONFIRM and
-- EDIT. `approvals.decide_approval` accepts three settled outcomes:
-- 'approved', 'rejected', 'changes_requested'. There is no fourth column for
-- "Admin rejected outright" in either vocabulary, and none is needed: EDIT is
-- the only "send it back" action Master describes, so `sync_ui_version_decision`
-- (below) maps BOTH 'rejected' and 'changes_requested' onto `admin_edit` —
-- collapsing a distinction the engine can express but this workflow does not
-- use, rather than inventing a UI-version-specific decision vocabulary.
--
-- ── who configures the policy is a manual step, same as every other subject ─
--
-- No policy row is seeded here, for the same reason none was seeded for
-- `handover`, `prototype` or `agent_action`: `approval_policies` is
-- per-organization data an owner sets through the Admin Panel
-- (`approvals.set_policy`), and seeding one here would be inventing what a
-- specific agency's Admin role should be. Until an owner configures a
-- `ui_version` policy, `request_ui_version_admin_review` answers `no_policy`
-- — a named, correct refusal (Master §26: do not fake completion), not a
-- silent default-open.
-- ═══════════════════════════════════════════════════════════════════════════

alter table approvals.approval_requests drop constraint if exists approval_requests_subject_type_check;
alter table approvals.approval_requests add constraint approval_requests_subject_type_check
  check (subject_type in ('proposal', 'deliverable', 'invoice', 'refund',
                          'scope_change', 'prototype', 'agent_action', 'ticket_plan',
                          'handover', 'ui_version'));

alter table approvals.approval_policies drop constraint if exists approval_policies_subject_type_check;
alter table approvals.approval_policies add constraint approval_policies_subject_type_check
  check (subject_type in ('proposal', 'deliverable', 'invoice', 'refund',
                          'scope_change', 'prototype', 'agent_action', 'ticket_plan',
                          'handover', 'ui_version'));

-- ── the door that raises the request ──────────────────────────────────────

create or replace function projects.request_ui_version_admin_review(
  p_ui_version_id uuid
)
returns table (
  -- 'requested' | 'already_requested' | 'no_policy' | 'wrong_state'
  -- | 'unknown_version' | 'no_actor' | 'forbidden'
  outcome       text,
  ui_version_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_version projects.ui_versions;
  v_approval record;
begin
  -- The service role requests review because the trigger is
  -- `project.ui_version_qa_reviewed`, an event a job reacts to — the same
  -- shape every other event-triggered door in this migration set uses.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select v.* into v_version
    from projects.ui_versions v
   where v.id = p_ui_version_id
   for update;

  if v_version.id is null then
    return query select 'unknown_version'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_version.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_version.status <> 'qa_pass' then
    -- Covers both a version that has not passed QA yet and a replay after
    -- review already started — Master §22's idempotent-replay shape, named.
    return query select 'wrong_state'::text, null::uuid; return;
  end if;

  select * into v_approval
    from approvals.request_approval(
      v_version.organization_id,
      'ui_version',
      v_version.id,
      'system',
      null,
      'Phase 4 UI version ready for Admin review',
      jsonb_build_object(
        'projectId', v_version.project_id,
        'phaseFourId', v_version.phase_four_id,
        'screenCount', jsonb_array_length(v_version.screens)
      ),
      null,
      'internal',
      null
    );

  if v_approval.outcome = 'no_policy' then
    return query select 'no_policy'::text, v_version.id; return;
  end if;

  -- 'requested' or 'already_pending' both mean a request now exists — the
  -- second is the identical idempotent-replay outcome the request door itself
  -- already names. Either way this workspace's version has entered review.
  update projects.ui_versions
     set status = 'admin_review'
   where id = v_version.id;

  return query select 'requested'::text, v_version.id;
end;
$$;

comment on function projects.request_ui_version_admin_review(uuid) is
  'Impl section 7.2, Master locked objective. Raises an internal-audience approval request for a qa_pass UI version, through the same engine handover reuses, and advances the version to admin_review. no_policy is a named refusal (Master section 26): an organization''s owner has not yet configured who reviews a ui_version, and this does not invent a default reviewer.';

revoke all on function projects.request_ui_version_admin_review(uuid) from public, anon;
grant execute on function projects.request_ui_version_admin_review(uuid) to authenticated, service_role;

-- ── the door that carries a settled decision back onto the version ───────

create or replace function projects.sync_ui_version_decision(
  p_ui_version_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_row    projects.ui_versions;
  v_state  text;
  v_status text;
begin
  select v.* into v_row
    from projects.ui_versions v
   where v.id = p_ui_version_id
   for update;

  if v_row.id is null then
    return 'not_found';
  end if;

  -- Called from a Server Action under a real staff session (the decision was
  -- already authorized by `approvals.decide_approval`'s own role check); this
  -- is the tenancy floor under that, the same shape every definer door in
  -- this migration set applies.
  if v_actor is not null
     and (v_row.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.is_internal()), false)) then
    return 'forbidden';
  end if;

  select r.state into v_state
    from approvals.approval_requests r
   where r.subject_type = 'ui_version'
     and r.subject_id    = v_row.id
   order by r.created_at desc
   limit 1;

  -- Master's Admin UI Review names two actions, CONFIRM and EDIT — see the
  -- migration header for why 'rejected' collapses onto the same target as
  -- 'changes_requested' rather than a third UI-version-specific status.
  v_status := case v_state
    when 'approved'           then 'admin_approved'
    when 'rejected'           then 'admin_edit'
    when 'changes_requested'  then 'admin_edit'
    else null
  end;

  if v_status is null or v_status = v_row.status then
    return coalesce(v_row.status, 'not_found');
  end if;

  update projects.ui_versions
     set status = v_status
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'project.ui_version_admin_reviewed', 'ui_version', v_row.id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', v_status)
  );

  perform core.emit_event(
    v_row.organization_id, 'project.ui_version_admin_reviewed',
    'ui_version', v_row.id,
    jsonb_build_object('projectId', v_row.project_id, 'phaseFourId', v_row.phase_four_id, 'status', v_status)
  );

  return v_status;
end;
$$;

comment on function projects.sync_ui_version_decision(uuid) is
  'Pulls a settled approval_requests row onto its ui_versions subject - the same PULL shape sync_deliverable_decision uses, not a trigger, so the approvals module still knows nothing about UI versions. admin_edit covers both rejected and changes_requested: Master''s Admin UI Review has only CONFIRM and EDIT, not a third outcome.';

revoke all on function projects.sync_ui_version_decision(uuid) from public, anon;
grant execute on function projects.sync_ui_version_decision(uuid) to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.ui_version_admin_reviewed',
   'Impl section 7.2. Admin confirmed (admin_approved) or asked for changes (admin_edit) on a Task 2 UI version, carried from a settled approvals.approval_requests decision.',
   true)
on conflict (type) do nothing;

notify pgrst, 'reload schema';
