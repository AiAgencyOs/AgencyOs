-- ═══════════════════════════════════════════════════════════════════════════
-- P4-PM-STATE: what is Task 2 waiting on right now, answered by reading the
-- rows that already exist rather than keeping a second state machine in sync
-- with them.
--
-- PM §10 (the PM Agent spec, consulted directly because the traceability
-- doc's own note for this row was "None found" — too thin to act on) names
-- 15 PM waiting/ready states: READY_TO_START, WAITING_DESIGN, WAITING_QA,
-- WAITING_ADMIN, WAITING_CLIENT_UI, UI_REVISION, WAITING_PROTOTYPE,
-- WAITING_PROTOTYPE_QA, WAITING_ADMIN_PROTOTYPE, WAITING_CLIENT_PROTOTYPE,
-- PROTOTYPE_REVISION, READY_TO_COMPLETE, WAITING_M2, READY_FOR_TASK3, BLOCKED.
--
-- ── why this is a VIEW-shaped function, not a new persisted column ────────
--
-- `projects.phase_four.state` already carries a macro-stage enum
-- (`20260923100000`) that DECLARES waiting_client/waiting_admin/
-- waiting_designer/waiting_prototype/blocked_requirement/scope_escalation as
-- valid values — but a grep of every door that writes this column
-- (`20260923110000`, `20260923160000`, `20260924100000`/`110000`/`120000`/
-- `140000`) shows only `ui_design`, `revision_limit_escalation` and
-- `completed` are ever actually written. The other declared waiting values
-- have sat unused since the table was created — exactly the
-- declared-but-never-reached gap this repository's audit history calls out
-- elsewhere (`ui_versions.status`'s own `qa_review` value has the identical
-- shape). Adding a SECOND enum column and trying to keep both in sync across
-- every door in `ui_versions`, `prototype_artifacts` and `deliverables` would
-- be the two-sources-of-drift problem Phase 3's design-token migration
-- explicitly refused to create, and would need touching doors that are
-- already live-verified and working.
--
-- What Task 2 needs to answer "what is the PM Agent waiting on" is fully
-- derivable, right now, from facts three tables already hold:
--   - `projects.phase_four.state` (workspace macro-stage / stop states)
--   - `projects.ui_versions.status` (the UI review lifecycle, 20260928100000's
--     own transition graph)
--   - `projects.prototype_artifacts.status` + `projects.deliverables.status`
--     (the prototype review lifecycle)
--   - `projects.phase_five_gate_status()` (the M2 finance gate, already a
--     read-only derivation over `finance.invoices`/`projects.milestones`)
-- This function is the SAME kind of read-only derivation `phase_five_gate_
-- status` already is for its own narrower question — not a new source of
-- truth, a new READ of the existing ones.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.pm_waiting_state(
  p_project_id uuid
)
returns table (
  -- One of PM §10's 15 named states.
  state                   text,
  detail                  text,
  ui_version_id           uuid,
  prototype_deliverable_id uuid
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_phase_four   projects.phase_four;
  v_ui_version   projects.ui_versions;
  v_prototype    projects.prototype_artifacts;
  v_deliverable  projects.deliverables;
  v_gate         record;
begin
  select * into v_phase_four
    from projects.phase_four
   where project_id = p_project_id;

  if v_phase_four.id is null then
    return query select
      'READY_TO_START'::text,
      'Task 2 has not started for this project yet — validate the Phase 3 baseline and send the Task 2 start message.'::text,
      null::uuid, null::uuid;
    return;
  end if;

  -- Stop states: Master §16/§17's "the workflow halts here" rule is
  -- authoritative over anything derivable from the version/deliverable rows
  -- below, because a stopped workspace does not keep advancing them.
  if v_phase_four.state in ('scope_escalation', 'revision_limit_escalation', 'blocked_requirement') then
    return query select
      'BLOCKED'::text,
      coalesce(v_phase_four.blocked_reason, 'Task 2 is blocked; no reason was recorded.'),
      null::uuid, null::uuid;
    return;
  end if;

  if v_phase_four.state = 'completed' then
    select * into v_gate from projects.phase_five_gate_status(p_project_id);

    if v_gate.outcome = 'verified' then
      return query select
        'READY_FOR_TASK3'::text,
        'M2 has been Admin-verified as paid — Phase 5 / Task 3 may start.'::text,
        null::uuid, null::uuid;
    else
      return query select
        'WAITING_M2'::text,
        case v_gate.outcome
          when 'invoice_issued' then 'Task 2 is complete; the M2 invoice has been issued and is awaiting Admin payment verification.'
          when 'no_m2_milestone' then 'Task 2 is complete; this project has no M2 milestone on its payment plan.'
          else 'Task 2 is complete; the M2 invoice has not been generated yet.'
        end,
        null::uuid, null::uuid;
    end if;
    return;
  end if;

  -- The latest UI version round (20260928100000: revisions are new rows,
  -- never a mutated one) is the current stage's own source of truth.
  select * into v_ui_version
    from projects.ui_versions
   where phase_four_id = v_phase_four.id
   order by version desc
   limit 1;

  if v_ui_version.id is null then
    return query select
      'WAITING_DESIGN'::text,
      'The UI Designer has not drafted a UI version yet.'::text,
      null::uuid, null::uuid;
    return;
  end if;

  case v_ui_version.status
    when 'draft' then
      return query select 'WAITING_QA'::text,
        'A UI version has been drafted; Design QA has not recorded a verdict yet.'::text,
        v_ui_version.id, null::uuid;
    when 'qa_changes_required' then
      return query select 'UI_REVISION'::text,
        format('Design QA requested changes (round %s of %s); waiting for the redraft.', v_phase_four.ui_revision_count, v_phase_four.ui_revision_limit),
        v_ui_version.id, null::uuid;
    when 'qa_pass' then
      return query select 'WAITING_ADMIN'::text,
        'Design QA passed; waiting for Admin review to be raised.'::text,
        v_ui_version.id, null::uuid;
    when 'admin_review' then
      return query select 'WAITING_ADMIN'::text,
        'Waiting for an Admin decision on this UI version.'::text,
        v_ui_version.id, null::uuid;
    when 'admin_edit' then
      return query select 'UI_REVISION'::text,
        format('Admin requested edits (round %s of %s); waiting for the redraft.', v_phase_four.ui_revision_count, v_phase_four.ui_revision_limit),
        v_ui_version.id, null::uuid;
    when 'admin_approved' then
      return query select 'WAITING_CLIENT_UI'::text,
        'Admin-approved; waiting for the PM to share it with the client.'::text,
        v_ui_version.id, null::uuid;
    when 'client_review' then
      return query select 'WAITING_CLIENT_UI'::text,
        'Shared with the client; waiting for their decision.'::text,
        v_ui_version.id, null::uuid;
    when 'client_change' then
      return query select 'UI_REVISION'::text,
        format('The client requested changes (round %s of %s); waiting for the redraft.', v_phase_four.ui_revision_count, v_phase_four.ui_revision_limit),
        v_ui_version.id, null::uuid;
    when 'client_approved' then
      return query select 'WAITING_ADMIN'::text,
        'The client approved this UI version; waiting for Admin to lock it.'::text,
        v_ui_version.id, null::uuid;
    when 'locked' then
      -- The UI stage is done; fall through to the prototype stage below.
      null;
    else
      return query select 'BLOCKED'::text,
        format('UI version %s is in an unrecognized status (%s).', v_ui_version.id, v_ui_version.status),
        v_ui_version.id, null::uuid;
      return;
  end case;

  if v_ui_version.status <> 'locked' then
    return;
  end if;

  -- prototype_artifacts carries no version column of its own (the round
  -- number lives on the linked deliverables row); ordering by created_at is
  -- equivalent, since revise_prototype_build always INSERTs the next round
  -- rather than mutating the previous one (20260924110000).
  select pa.* into v_prototype
    from projects.prototype_artifacts pa
   where pa.ui_version_id = v_ui_version.id
   order by pa.created_at desc
   limit 1;

  if v_prototype.id is null then
    return query select
      'WAITING_PROTOTYPE'::text,
      'The UI version is locked; the Prototype Agent has not built a prototype yet.'::text,
      v_ui_version.id, null::uuid;
    return;
  end if;

  select * into v_deliverable
    from projects.deliverables
   where id = v_prototype.deliverable_id;

  case v_prototype.status
    when 'draft' then
      return query select 'WAITING_PROTOTYPE_QA'::text,
        'A prototype build exists; Prototype QA has not recorded a verdict yet.'::text,
        v_ui_version.id, v_prototype.deliverable_id;
    when 'qa_changes_required' then
      return query select 'PROTOTYPE_REVISION'::text,
        format('Prototype QA requested changes (round %s of %s); waiting for the rebuild.', v_phase_four.prototype_revision_count, v_phase_four.prototype_revision_limit),
        v_ui_version.id, v_prototype.deliverable_id;
    when 'qa_pass' then
      case coalesce(v_deliverable.status, 'draft')
        when 'draft' then
          return query select 'WAITING_ADMIN_PROTOTYPE'::text,
            'Prototype QA passed; waiting for Admin to submit it for client review.'::text,
            v_ui_version.id, v_prototype.deliverable_id;
        when 'in_review' then
          return query select 'WAITING_CLIENT_PROTOTYPE'::text,
            'Submitted for review; waiting for the client''s decision.'::text,
            v_ui_version.id, v_prototype.deliverable_id;
        when 'changes_requested' then
          return query select 'PROTOTYPE_REVISION'::text,
            format('The client requested changes (round %s of %s); waiting for the rebuild.', v_phase_four.prototype_revision_count, v_phase_four.prototype_revision_limit),
            v_ui_version.id, v_prototype.deliverable_id;
        when 'approved' then
          return query select 'READY_TO_COMPLETE'::text,
            'The client approved the final prototype; Task 2 is completing.'::text,
            v_ui_version.id, v_prototype.deliverable_id;
        else
          return query select 'BLOCKED'::text,
            format('Deliverable %s is in an unrecognized status (%s).', v_deliverable.id, v_deliverable.status),
            v_ui_version.id, v_prototype.deliverable_id;
      end case;
    else
      return query select 'BLOCKED'::text,
        format('Prototype artifact %s is in an unrecognized status (%s).', v_prototype.id, v_prototype.status),
        v_ui_version.id, v_prototype.deliverable_id;
  end case;
end;
$$;

comment on function projects.pm_waiting_state(uuid) is
  'P4-PM-STATE. Read-only derivation of PM §10''s 15 named waiting/ready states from the real rows in phase_four/ui_versions/prototype_artifacts/deliverables plus phase_five_gate_status() for the M2 arm — no new persisted state machine, the same choice phase_five_gate_status already made for its own narrower question. security invoker: relies on the caller''s own RLS, exactly like phase_five_gate_status.';

revoke all on function projects.pm_waiting_state(uuid) from public, anon;
grant execute on function projects.pm_waiting_state(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
