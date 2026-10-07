-- ═══════════════════════════════════════════════════════════════════════════
-- P4-PM-008 / P4-PM-023 / P4-PM-024 (traceability: docs/phase-4-implementation-traceability.md).
--
-- Phase 4 PM spec section 10 names fifteen PM states (READY_TO_START ... READY_FOR_TASK3, BLOCKED) and requires BLOCKED to expose the exact blocker, owner and
-- resume condition. `projects.phase_four.state` is only ever written as task2_started / ui_design / prototype_build / completed / a stop state, so the review
-- and waiting positions were never visible, and the Admin Panel badge was stale during review.
--
-- This adds a READ, not a second state column: a column would be one more thing to keep in step with the UI-version row, the prototype row, the deliverable
-- and the M2 gate - which already decide the answer. `projects.phase_four_pm_state(project)` derives the spec state from those rows each time it is asked,
-- so it cannot disagree with them. Internal staff only (it names blockers and owners). Writes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.phase_four_pm_state(p_project_id uuid)
returns table (pm_state text, owner text, blocker text, resume_condition text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org   uuid := (select core.current_organization_id());
  v_p4    projects.phase_four;
  v_ui    projects.ui_versions;
  v_locked boolean;
  v_proto projects.prototype_artifacts;
  v_dstat text;
  v_admin text;
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return; end if;

  select f.* into v_p4 from projects.phase_four f where f.project_id = p_project_id and f.organization_id = v_org;
  if v_p4.id is null then
    return query select 'READY_TO_START'::text, 'project_manager'::text, null::text, 'The PM validates the locked Phase 3 baseline and starts Task 2'::text; return;
  end if;

  if v_p4.state in ('blocked_requirement', 'scope_escalation', 'revision_limit_escalation') then
    return query select 'BLOCKED'::text, 'admin'::text, coalesce(v_p4.blocked_reason, v_p4.state), 'A person decides continuation, scope or commercial handling; nothing resumes automatically'::text; return;
  end if;

  if v_p4.state = 'completed' then
    if coalesce((select projects.m2_verified_paid(p_project_id)), false) then
      return query select 'READY_FOR_TASK3'::text, 'project_manager'::text, null::text, 'M2 payment is verified by an Admin; the next phase may start'::text;
    else
      return query select 'WAITING_M2'::text, 'finance'::text, null::text, 'An Admin verifies the M2 payment; the PM only communicates status'::text;
    end if;
    return;
  end if;

  select u.* into v_ui from projects.ui_versions u where u.phase_four_id = v_p4.id order by u.version desc limit 1;
  select exists (select 1 from projects.ui_versions u where u.phase_four_id = v_p4.id and u.status = 'locked') into v_locked;

  if not v_locked then
    if v_ui.id is null then
      return query select 'WAITING_DESIGN'::text, 'ui_designer'::text, null::text, 'The Designer drafts the complete UI'::text; return;
    end if;
    case v_ui.status
      when 'draft', 'qa_review' then
        return query select 'WAITING_QA'::text, 'quality_assurance'::text, null::text, 'Design QA reviews the exact version; nothing is shared with the client before it passes'::text;
      when 'qa_changes_required', 'admin_edit' then
        return query select 'WAITING_DESIGN'::text, 'ui_designer'::text, null::text, 'The Designer applies the returned changes as the next version'::text;
      when 'qa_pass', 'admin_review' then
        return query select 'WAITING_ADMIN'::text, 'admin'::text, null::text, 'The Admin confirms or edits the QA-passed version'::text;
      when 'admin_approved' then
        return query select 'WAITING_CLIENT_UI'::text, 'project_manager'::text, null::text, 'The PM shares the exact Admin-approved version with the client'::text;
      when 'client_review' then
        return query select 'WAITING_CLIENT_UI'::text, 'client'::text, null::text, 'The client decides on the exact version; follow up according to policy'::text;
      when 'client_change' then
        return query select 'UI_REVISION'::text, 'ui_designer'::text, null::text, 'The Designer drafts the next round from the client''s requested change'::text;
      when 'client_approved' then
        return query select 'WAITING_CLIENT_UI'::text, 'admin'::text, 'The client approved the exact version; the lock is not yet recorded'::text, 'The approved version is locked'::text;
      else
        return query select 'BLOCKED'::text, 'admin'::text, ('unrecognised UI version status ' || v_ui.status)::text, 'Inspect the UI version'::text;
    end case;
    return;
  end if;

  -- the UI is locked: the prototype stage
  select a.* into v_proto from projects.prototype_artifacts a where a.project_id = p_project_id and a.organization_id = v_org order by a.created_at desc, a.id desc limit 1;
  if v_proto.id is null then
    return query select 'WAITING_PROTOTYPE'::text, 'ui_prototype'::text, null::text, 'The Prototype Agent builds from the exact locked UI version'::text; return;
  end if;
  select d.status into v_dstat from projects.deliverables d where d.id = v_proto.deliverable_id;
  select dd.admin_status into v_admin from projects.deliverable_details dd where dd.deliverable_id = v_proto.deliverable_id;

  if v_dstat = 'approved' then
    return query select 'READY_TO_COMPLETE'::text, 'project_manager'::text, null::text, 'The PM validates the final client approval and the definition of done'::text;
  elsif v_dstat = 'changes_requested' then
    return query select 'PROTOTYPE_REVISION'::text, 'ui_prototype'::text, null::text, 'The Prototype Agent builds the next round from the client''s requested change'::text;
  elsif v_dstat = 'in_review' then
    return query select 'WAITING_CLIENT_PROTOTYPE'::text, 'client'::text, null::text, 'The client decides on the exact build'::text;
  elsif v_proto.status = 'draft' then
    return query select 'WAITING_PROTOTYPE_QA'::text, 'quality_assurance'::text, null::text, 'Prototype QA validates the exact build; nothing is shared before it passes'::text;
  elsif v_proto.status = 'qa_changes_required' or v_admin = 'changes_required' then
    return query select 'WAITING_PROTOTYPE'::text, 'ui_prototype'::text, null::text, 'The Prototype Agent applies the returned changes as the next build'::text;
  else
    return query select 'WAITING_ADMIN_PROTOTYPE'::text, 'admin'::text, null::text, 'The Admin confirms or edits the QA-passed build before it can reach the client'::text;
  end if;
end $$;
revoke all on function projects.phase_four_pm_state(uuid) from public, anon, service_role;
grant execute on function projects.phase_four_pm_state(uuid) to authenticated;
comment on function projects.phase_four_pm_state(uuid) is
  'Phase 4 PM spec section 10: the fifteen PM states, DERIVED from the UI version, prototype, deliverable and M2 gate rows each time it is asked (never stored, so it cannot go stale). BLOCKED carries the exact blocker, owner and resume condition. Internal staff only.';

notify pgrst, 'reload schema';
