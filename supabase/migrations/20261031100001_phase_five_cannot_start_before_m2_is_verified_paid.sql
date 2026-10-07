-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 Finance spec, "PHASE 5 GATE": Phase4Completed, InvoiceIssued, PaymentSubmitted,
-- ProofUploaded and FinanceMatchRecommended do NOT open Phase 5; only M2PaymentVerified does,
-- and it is "server/workflow enforcement required, not UI-only".
--
-- Until now the gate stopped Phase 5 COMPLETION (projects.phase_readiness → 'M2 not verified paid')
-- but not Phase 5 START: a development task (one attached to a module or a feature) could be moved
-- to in_progress on an unpaid M2. This closes that at the one door that starts a task.
--
-- Second defect found by the audit: projects.phase_five_gate_status (the Admin Panel's "CAN PHASE 5
-- START?" answer) said 'verified' on invoice.status = 'paid' alone, while projects.m2_verified_paid
-- (the real gate) also requires verified_minor >= total_minor. Two readers of one fact disagreed;
-- the panel could say yes while the gate said no. It now delegates to the gate.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.start_task(p_task_id uuid)
returns table (outcome text, detail text)
language plpgsql
set search_path = ''
as $$
declare
  v_task  projects.tasks;
  v_check record;
  v_role  text;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null then
    return query select 'not_found'::text, null::text; return;
  end if;
  v_role := projects.project_role_refusal(v_task.project_id, v_task.assignee_id);
  if v_role is not null then
    return query select v_role, null::text; return;
  end if;
  if v_task.status <> 'todo' or v_task.archived_at is not null then
    return query select 'wrong_state'::text, null::text; return;
  end if;

  -- Phase 5 gate: development work starts only on a verified-paid M2.
  if (v_task.module_id is not null or v_task.feature_id is not null)
     and not projects.m2_verified_paid(v_task.project_id) then
    return query select 'm2_not_verified'::text,
      'Phase 5 cannot start: the M2 payment is not verified paid. A client saying paid, a proof upload, a submission or a match recommendation does not open it; only an Admin verifying the payment does.'::text;
    return;
  end if;

  select * into v_check from projects.task_start_check(p_task_id);
  if not v_check.requirement_ok then
    return query select 'no_requirement'::text, v_check.reason; return;
  end if;
  if v_check.open_dependencies > 0 then
    return query select 'dependencies_open'::text, v_check.reason; return;
  end if;

  update projects.tasks set status = 'in_progress', started_at = coalesce(started_at, now()) where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.started', 'task', p_task_id,
    jsonb_build_object('status', v_task.status), jsonb_build_object('status', 'in_progress', 'projectId', v_task.project_id)
  );
  return query select 'started'::text, null::text;
end;
$$;

comment on function projects.start_task(uuid) is
  'todo → in_progress. Refused: wrong_state, m2_not_verified (a development task, i.e. one attached to a module or feature, while projects.m2_verified_paid is false: the Phase 5 start gate), no_requirement, dependencies_open; audited task.started.';

revoke all on function projects.start_task(uuid) from public, anon;
grant execute on function projects.start_task(uuid) to authenticated, service_role;

create or replace function projects.phase_five_gate_status(p_project_id uuid)
returns table (outcome text, m2_invoice_id uuid, m2_invoice_status text)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    case
      when projects.m2_verified_paid(p_project_id) then 'verified'
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

revoke all on function projects.phase_five_gate_status(uuid) from public, anon;
grant execute on function projects.phase_five_gate_status(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
