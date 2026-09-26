-- ═══════════════════════════════════════════════════════════════════════════
-- M2, and the gate it actually needs.
--
-- Finance §2, §5, §12-17; Impl §7.4. `docs/phase-4-gap-analysis.md` step 6.
--
-- ── two additive event emissions, on the live function bodies ────────────
--
-- `projects.submit_deliverable` and `projects.sync_deliverable_decision`
-- (both `20260813120001_deliverables.sql`, since evolved by later
-- migrations) are shared by every deliverable kind — design, prototype,
-- build, document — and have never emitted an event for ANY of them. Both
-- bodies below are `pg_get_functiondef` read back from a database with every
-- migration applied, with exactly one `perform core.emit_event(...)` call
-- added at the end of each, so nothing else about them can have drifted from
-- what is actually installed. Existing behaviour — the returned outcome, the
-- audit row, every guard — is untouched; the new event is generic across
-- every kind, not Phase-4-specific, because the functions themselves are.
--
-- ── Phase4Completed is a real state, reached by a real signal ────────────
--
-- Master's flow: the final prototype build reaching client approval closes
-- Task 2. `project.deliverable_decided` (new, above) fires for that decision
-- along with every other deliverable's; `projects.complete_phase_four` is
-- the door a handler calls after filtering to `kind = 'prototype'` and
-- `status = 'approved'` — the filtering lives in TypeScript
-- (`src/modules/projects/handlers.ts`) because SQL shared by every
-- deliverable kind must not know what Phase 4 is.
--
-- ── M2 issues an invoice; it does not verify a payment ────────────────────
--
-- Finance §12-17's hard rule, restated once more because it is the rule this
-- whole gate exists to hold: `Phase4Completed`, `M2InvoiceIssued`,
-- `PaymentSubmitted` and `ProofUploaded` must NOT open Phase 5.
-- `generateM2Invoice` (src/modules/finance/service.ts) only ever reaches
-- `finance.invoices.status = 'issued'`. Only `finance.verify_payment_submission`
-- — reached exclusively through a real signed-in Admin session, never a job,
-- never the service role — can move an invoice to `'paid'`. This migration
-- does not touch that function at all; it already is the hard gate the
-- Finance spec asks for, generalized to any milestone position since the day
-- it was written.
--
-- `projects.phase_five_gate_status` is read-only: it answers "is M2 verified"
-- for the Admin Panel (Master's own "CAN PHASE 5 START?" question) without
-- inventing a Phase 5 module to gate, since none exists yet.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── submit_deliverable: + project.deliverable_submitted ───────────────────

insert into core.event_types (type, description, canonical) values
  ('project.deliverable_submitted',
   'A deliverable of any kind (design/prototype/build/document) was submitted for review. Generic across kinds; a subscriber filters to the kind it cares about.',
   true),
  ('project.deliverable_decided',
   'A deliverable of any kind reached a settled decision (approved/changes_requested). Generic across kinds; Phase 4''s Task 2 completion (PROTO/Impl) subscribes and filters to kind=prototype, status=approved.',
   true),
  ('project.phase_four_completed',
   'Impl §7.4, Master step 39/40. Task 2 (UI design + prototype) is complete: the final prototype build reached client approval. Triggers Finance''s M2 (20%) invoice.',
   true)
on conflict (type) do nothing;

create or replace function projects.submit_deliverable(p_deliverable_id uuid, p_requested_by uuid DEFAULT NULL::uuid, p_summary text DEFAULT NULL::text)
 returns table(outcome text, request_id uuid, status text)
 language plpgsql
 set search_path to ''
as $function$
declare
  v_row      projects.deliverables;
  v_approval record;
  v_blocking int;
begin
  select d.* into v_row
    from projects.deliverables d
   where d.id = p_deliverable_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_row.status in ('approved', 'superseded') then
    return query select 'settled'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  if v_row.status = 'in_review' then
    return query select 'already_in_review'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  -- ARCHITECTURE.md §4.8. Checked under the same lock that will write the
  -- status, so a blocker raised while somebody was clicking submit still
  -- stops it.
  select count(*) into v_blocking from qa.blocking_defects(p_deliverable_id);

  if v_blocking > 0 then
    return query select 'blocked'::text, null::uuid, v_row.status;
    return;
  end if;

  select * into v_approval
    from approvals.request_approval(
      v_row.organization_id, 'deliverable', v_row.id,
      case when p_requested_by is null then 'system' else 'user' end,
      p_requested_by,
      coalesce(p_summary, v_row.kind || ' v' || v_row.version || ' — ' || v_row.title),
      jsonb_build_object(
        'kind', v_row.kind, 'version', v_row.version, 'title', v_row.title,
        'artifact_url', v_row.artifact_url, 'known_issues', v_row.known_issues
      ),
      null, 'client', null
    );

  if v_approval.outcome = 'no_policy' then
    return query select 'no_policy'::text, null::uuid, v_row.status;
    return;
  end if;

  update projects.deliverables
     set status = 'in_review',
         approval_request_id = v_approval.request_id
   where projects.deliverables.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'deliverable.submitted', 'deliverable', v_row.id,
    to_jsonb(v_row),
    jsonb_build_object('status', 'in_review', 'approval_request_id', v_approval.request_id)
  );

  -- ── the one addition: a generic, kind-agnostic event ────────────────────
  perform core.emit_event(
    v_row.organization_id, 'project.deliverable_submitted', 'deliverable', v_row.id,
    jsonb_build_object('kind', v_row.kind, 'version', v_row.version, 'projectId', v_row.project_id)
  );

  return query select 'submitted'::text, v_approval.request_id, 'in_review'::text;
end;
$function$;

-- ── sync_deliverable_decision: + project.deliverable_decided ─────────────

create or replace function projects.sync_deliverable_decision(p_deliverable_id uuid)
 returns text
 language plpgsql
 set search_path to ''
as $function$
declare
  v_row    projects.deliverables;
  v_state  text;
  v_status text;
begin
  select d.* into v_row
    from projects.deliverables d
   where d.id = p_deliverable_id
   for update;

  if v_row.id is null or v_row.approval_request_id is null then
    return coalesce(v_row.status, 'not_found');
  end if;

  select r.state into v_state
    from approvals.approval_requests r
   where r.id = v_row.approval_request_id;

  v_status := case v_state
    when 'approved' then 'approved'
    when 'rejected' then 'changes_requested'
    when 'changes_requested' then 'changes_requested'
    else null
  end;

  if v_status is null or v_status = v_row.status then
    return v_row.status;
  end if;

  update projects.deliverables
     set status = v_status
   where projects.deliverables.id = v_row.id;

  -- An approved version supersedes every earlier one of its kind. The old
  -- rows stay — that is the revision history — but they stop being live.
  if v_status = 'approved' then
    update projects.deliverables d
       set status = 'superseded'
     where d.project_id = v_row.project_id
       and d.kind = v_row.kind
       and d.version < v_row.version
       and d.status not in ('approved', 'superseded');
  end if;

  perform core.record_audit(
    v_row.organization_id,
    'deliverable.' || v_status,
    'deliverable',
    v_row.id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', v_status, 'approval_request_id', v_row.approval_request_id)
  );

  -- ── the one addition: a generic, kind-agnostic event ────────────────────
  perform core.emit_event(
    v_row.organization_id, 'project.deliverable_decided', 'deliverable', v_row.id,
    jsonb_build_object('kind', v_row.kind, 'version', v_row.version, 'projectId', v_row.project_id, 'status', v_status)
  );

  return v_status;
end;
$function$;

-- ── the door that closes Task 2 ───────────────────────────────────────────

create or replace function projects.complete_phase_four(
  p_project_id uuid
)
returns table (
  -- 'completed' | 'already_completed' | 'unknown_workspace' | 'stopped'
  -- | 'no_actor' | 'forbidden'
  outcome       text,
  phase_four_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_phase_four projects.phase_four;
begin
  -- The service role completes because the trigger is
  -- `project.deliverable_decided`, an event a job reacts to — the same shape
  -- every event-triggered door in this migration set uses.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select p4.* into v_phase_four
    from projects.phase_four p4
   where p4.project_id = p_project_id
   for update;

  if v_phase_four.id is null then
    return query select 'unknown_workspace'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_phase_four.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_phase_four.state = 'completed' then
    -- Master §22: a duplicate event answers with the fact that is already
    -- true, rather than failing or completing a second time.
    return query select 'already_completed'::text, v_phase_four.id; return;
  end if;

  if v_phase_four.state in ('scope_escalation', 'revision_limit_escalation') then
    -- A stopped workspace does not complete itself; a person already has to
    -- act on it, and completing it out from under them would hide that.
    return query select 'stopped'::text, null::uuid; return;
  end if;

  update projects.phase_four
     set state = 'completed', completed_at = now()
   where id = v_phase_four.id;

  perform core.record_audit(
    v_phase_four.organization_id, 'project.phase_four_completed', 'phase_four', v_phase_four.id, null,
    jsonb_build_object('projectId', p_project_id)
  );

  perform core.emit_event(
    v_phase_four.organization_id, 'project.phase_four_completed',
    'project', p_project_id,
    jsonb_build_object('projectId', p_project_id, 'phaseFourId', v_phase_four.id)
  );

  return query select 'completed'::text, v_phase_four.id;
end;
$$;

comment on function projects.complete_phase_four(uuid) is
  'Impl section 7.4, Master step 39/40. Closes Task 2 once the final prototype build is client-approved. Emits with subject_type=project (not phase_four), because generateM2Invoice and every other Finance reader keys on the PROJECT, not the workspace row.';

revoke all on function projects.complete_phase_four(uuid) from public, anon;
grant execute on function projects.complete_phase_four(uuid) to authenticated, service_role;

-- ── read-only: is Phase 5 actually eligible ───────────────────────────────

create or replace function projects.phase_five_gate_status(
  p_project_id uuid
)
returns table (
  -- 'verified' | 'invoice_issued' | 'no_m2_milestone' | 'not_ready'
  outcome          text,
  m2_invoice_id    uuid,
  m2_invoice_status text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    case
      when i.status = 'paid' then 'verified'
      when i.id is not null then 'invoice_issued'
      when m.id is null then 'no_m2_milestone'
      else 'not_ready'
    end,
    i.id,
    i.status
  from projects.milestones m
  left join finance.invoices i on i.milestone_id = m.id and i.status <> 'void'
  where m.project_id = p_project_id
    and m.position = 2
  limit 1;
$$;

comment on function projects.phase_five_gate_status(uuid) is
  'Master''s own Admin Panel question, answered directly: "CAN PHASE 5 START?" Reads whether M2''s invoice has actually been marked paid by finance.verify_payment_submission (the only door that can) — Phase4Completed, an issued invoice, a payment submission or a proof upload all answer anything but ''verified''. security invoker: relies on the caller''s own RLS, the same as every other read-only helper in this schema.';

revoke all on function projects.phase_five_gate_status(uuid) from public, anon;
grant execute on function projects.phase_five_gate_status(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
