-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7 leftovers that are deterministic.
--
--   1. p7_failure_queue (P703 §14): a DERIVED read of what is wrong right now in Phase 7: a deployment that failed and was not followed by another, a validation
--      run that failed and was not followed by a pass, an open incident, an approval nobody decided past a stated age, a client action past its date. Nothing is
--      stored: the queue is always the current rows, and an item leaves it when its cause is gone.
--   2. create_draft_handover_package_for_validated (P707 §13, HO-08): when production is VALIDATED, a DRAFT handover package (version 1, items from the
--      contract deliverables checklist) is created if none exists. It is the runner's door: it never submits, approves or delivers anything, and with no
--      contract checklist it creates nothing and says so.
--   3. client_financial_statement* (P710 §10, FIN-05): FACTS for the client's own account: its invoices, the payments a person verified, and what is outstanding.
--      Client-safe SECURITY DEFINER reads that filter by the caller's client_account_id claim. They change no amount.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.handover_draft_created', 'Production was validated and a DRAFT handover package was created from the contract checklist. A person fills, reviews and delivers it; nothing was delivered.', true)
on conflict (type) do nothing;

-- ── 1. the Failure Queue ───────────────────────────────────────────────────
create or replace function projects.p7_failure_queue(p_organization_id uuid default null, p_stale_hours int default 24, p_now timestamptz default null)
returns table (kind text, project_id uuid, project_name text, subject_id uuid, since timestamptz, age_hours numeric, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_org uuid; v_now timestamptz := coalesce(p_now, clock_timestamp()); v_stale int := greatest(coalesce(p_stale_hours, 24), 1);
begin
  if v_service then v_org := p_organization_id;
  else
    if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) then return; end if;
    -- a signed-in person reads their OWN organization; the parameter is the service role's
    v_org := (select core.current_organization_id());
    if v_org is null then return; end if;
  end if;
  return query
  with q as (
    select 'deployment_failed'::text as k, d.project_id as pid, d.id as sid, coalesce(d.finished_at, d.updated_at) as s,
           'deployment attempt ' || d.attempt || ' failed' || coalesce(' (' || d.blocker_code || ')', '') as t, d.organization_id as o
      from projects.p7_deployments d
     where d.status = 'failed' and not exists (select 1 from projects.p7_deployments d2 where d2.project_id = d.project_id and d2.created_at > d.created_at)
    union all
    select 'validation_failed', r.project_id, r.id, coalesce(r.finished_at, r.started_at), r.kind || ' validation failed' || coalesce(': ' || left(r.summary, 160), ''), r.organization_id
      from projects.p7_validation_runs r
     where r.status = 'failed' and not exists (select 1 from projects.p7_validation_runs r2 where r2.deployment_id = r.deployment_id and r2.started_at > r.started_at and r2.status = 'passed')
    union all
    select 'incident_open', i.project_id, i.id, i.opened_at, i.severity || ' ' || i.incident_type || ' incident is ' || i.state, i.organization_id
      from projects.p7_incidents i where i.state <> 'closed'
    union all
    select 'approval_stale', p.project_id, p.id, p.updated_at, 'deployment plan v' || p.version || ' has waited for an Admin decision', p.organization_id
      from projects.p7_deployment_plans p where p.status = 'ready_for_approval' and p.updated_at < v_now - make_interval(hours => v_stale)
    union all
    select 'approval_stale', k.project_id, k.id, coalesce((select max(e.created_at) from core.outbox_events e where e.type = 'project.handover_admin_review_requested' and e.subject_id = k.id), k.created_at),
           'handover package v' || k.version || ' has waited for an Admin review', k.organization_id
      from projects.p7_handover_packages k
     where k.status = 'admin_review' and coalesce((select max(e.created_at) from core.outbox_events e where e.type = 'project.handover_admin_review_requested' and e.subject_id = k.id), k.created_at) < v_now - make_interval(hours => v_stale)
    union all
    select 'client_action_overdue', c.project_id, c.id, c.due_at, 'the client action "' || left(c.title, 120) || '" is past its date', c.organization_id
      from projects.p7c_client_action_requests c where c.status = 'open' and c.due_at < v_now
  )
  select q.k, q.pid, pr.name, q.sid, q.s, round(extract(epoch from (v_now - q.s)) / 3600.0, 1), q.t
    from q join projects.projects pr on pr.id = q.pid
   where (v_org is null or q.o = v_org)
   order by q.s, q.sid;
end $$;
revoke all on function projects.p7_failure_queue(uuid, int, timestamptz) from public, anon;
grant execute on function projects.p7_failure_queue(uuid, int, timestamptz) to authenticated, service_role;

-- ── 2. the automatic DRAFT handover package ────────────────────────────────
create or replace function projects.create_draft_handover_package_for_validated(p_organization_id uuid, p_phase_seven_id uuid)
returns table (outcome text, package_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_s projects.phase_seven; v_v record; v_existing uuid; v_new uuid; v_next int; c record;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_s from projects.phase_seven s where s.id = p_phase_seven_id and s.organization_id = p_organization_id for update;
  if v_s.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select p.id into v_existing from projects.p7_handover_packages p where p.project_id = v_s.project_id and p.status in ('draft', 'admin_review', 'changes_requested', 'approved', 'delivered');
  if v_existing is not null then return query select 'already_exists'::text, v_existing; return; end if;
  -- a package is for the exact PRODUCTION-VALIDATED release, read from the evidence and never from the event
  select * into v_v from projects.p7_production_validation(v_s.project_id);
  if v_v.deployment_id is null then return query select 'production_not_validated'::text, null::uuid; return; end if;
  if not projects.m4_verified_paid(v_s.project_id) then return query select 'm4_not_verified'::text, null::uuid; return; end if;
  -- the contractual list is a person's record: without it there is nothing to build the checklist from, and nothing is invented
  if not exists (select 1 from projects.p7_contract_deliverables d where d.project_id = v_s.project_id) then return query select 'contract_deliverables_missing'::text, null::uuid; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  select coalesce(max(version), 0) + 1 into v_next from projects.p7_handover_packages where project_id = v_s.project_id;
  insert into projects.p7_handover_packages (organization_id, project_id, phase_seven_id, version, deployment_id, validation_run_id, candidate_id, commit_ref, artifact_sha256)
  values (v_s.organization_id, v_s.project_id, v_s.id, v_next, v_v.deployment_id, v_v.run_id, v_s.candidate_id, v_s.commit_ref, v_s.artifact_sha256) returning id into v_new;
  insert into projects.p7_handover_items (organization_id, package_id, kind, label, required)
  select v_s.organization_id, v_new, k.kind, k.label, true from (values ('scope', 'Final approved scope'), ('release', 'Release / build / version'), ('production_url', 'Production URL and environment'),
         ('known_limitations', 'Known limitations'), ('support_warranty', 'Support and warranty terms'), ('emergency_contacts', 'Emergency and support contacts')) as k(kind, label);
  for c in select * from projects.p7_contract_deliverables d where d.project_id = v_s.project_id loop
    insert into projects.p7_handover_items (organization_id, package_id, kind, label, required, status, reason)
    values (v_s.organization_id, v_new, c.kind, c.label, c.required, case when c.required then 'pending' else 'not_required' end, case when c.required then null else c.exclusion_reason end);
  end loop;
  perform projects.p7_set_state(v_s.project_id, 'handover_preparing');
  perform core.record_audit(v_s.organization_id, 'handover_package.draft_created', 'handover_package', v_new, null, jsonb_build_object('projectId', v_s.project_id, 'version', v_next, 'deploymentId', v_v.deployment_id, 'automatic', true));
  perform core.emit_event(v_s.organization_id, 'project.handover_draft_created', 'handover_package', v_new, jsonb_build_object('projectId', v_s.project_id, 'version', v_next));
  return query select 'created'::text, v_new;
end $$;
revoke all on function projects.create_draft_handover_package_for_validated(uuid, uuid) from public, anon, authenticated;
grant execute on function projects.create_draft_handover_package_for_validated(uuid, uuid) to service_role;

-- the catch-up: a project that was validated before its contract checklist was recorded gets its draft once the checklist exists
create or replace function projects.sweep_draft_handover_packages(p_organization_id uuid default null, p_limit int default 100)
returns table (checked int, created int)
language plpgsql security definer set search_path = '' as $$
declare r record; v_checked int := 0; v_created int := 0; v_out text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0; return; end if;
  for r in
    select s.id, s.organization_id from projects.phase_seven s
     where s.state = 'production_validated' and (p_organization_id is null or s.organization_id = p_organization_id)
       and exists (select 1 from projects.p7_contract_deliverables d where d.project_id = s.project_id)
       and not exists (select 1 from projects.p7_handover_packages p where p.project_id = s.project_id and p.status in ('draft', 'admin_review', 'changes_requested', 'approved', 'delivered'))
     order by s.updated_at limit greatest(coalesce(p_limit, 100), 1)
  loop
    v_checked := v_checked + 1;
    select t.outcome into v_out from projects.create_draft_handover_package_for_validated(r.organization_id, r.id) t;
    if v_out = 'created' then v_created := v_created + 1; end if;
  end loop;
  return query select v_checked, v_created;
end $$;
revoke all on function projects.sweep_draft_handover_packages(uuid, int) from public, anon, authenticated;
grant execute on function projects.sweep_draft_handover_packages(uuid, int) to service_role;

-- ── 3. the client's financial statement: facts for the caller's own account ─
-- the caller's account, or null: only a client, only with an account claim. A draft or an invoice awaiting approval does not exist for the client.
create or replace function projects.p7c_statement_account()
returns uuid language sql stable security definer set search_path = '' as $$
  select case when coalesce((select core.is_client()), false) then (select core.current_client_account_id()) end
$$;
revoke all on function projects.p7c_statement_account() from public, anon, authenticated, service_role;

create or replace function projects.client_financial_statement(p_project_id uuid default null)
returns table (invoice_id uuid, number text, project_id uuid, project_name text, status text, currency text, total_minor bigint, verified_minor bigint, recorded_unverified_minor bigint, outstanding_minor bigint,
               issued_at timestamptz, due_at timestamptz, overdue boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_acct uuid := projects.p7c_statement_account(); v_org uuid := (select core.current_organization_id());
begin
  if v_acct is null or v_org is null then return; end if;
  if p_project_id is not null and projects.p7b_portal_project(p_project_id) is null then return; end if;
  return query
    select i.id, i.number, i.project_id, p.name, i.status, i.currency::text, i.total_minor, i.verified_minor, greatest(i.paid_minor - i.verified_minor, 0),
           case when i.status = 'void' then 0 else greatest(i.total_minor - i.verified_minor, 0) end,
           i.issued_at, i.due_at, (i.status in ('issued', 'partially_paid', 'overdue') and i.due_at is not null and i.due_at < clock_timestamp())
      from finance.invoices i left join projects.projects p on p.id = i.project_id
     where i.organization_id = v_org and i.client_account_id = v_acct and i.status not in ('draft', 'pending_approval')
       and (p_project_id is null or i.project_id = p_project_id)
       and (i.project_id is null or projects.p7b_portal_access(i.project_id) <> 'expired')
     order by i.issued_at, i.number;
end $$;
revoke all on function projects.client_financial_statement(uuid) from public, anon, service_role;
grant execute on function projects.client_financial_statement(uuid) to authenticated;

-- only payments a PERSON verified: a recorded claim nobody checked is not shown as money received
create or replace function projects.client_financial_statement_payments(p_project_id uuid default null)
returns table (payment_id uuid, invoice_number text, amount_minor bigint, currency text, verified_at timestamptz, receipt_number text)
language plpgsql stable security definer set search_path = '' as $$
declare v_acct uuid := projects.p7c_statement_account(); v_org uuid := (select core.current_organization_id());
begin
  if v_acct is null or v_org is null then return; end if;
  if p_project_id is not null and projects.p7b_portal_project(p_project_id) is null then return; end if;
  return query
    select y.id, i.number, y.amount_minor, y.currency::text, y.verified_at, r.number
      from finance.payments y join finance.invoices i on i.id = y.invoice_id left join finance.receipts r on r.payment_id = y.id
     where i.organization_id = v_org and y.organization_id = v_org and i.client_account_id = v_acct and i.status not in ('draft', 'pending_approval')
       and y.status = 'captured' and y.verified_at is not null and (p_project_id is null or i.project_id = p_project_id)
       and (i.project_id is null or projects.p7b_portal_access(i.project_id) <> 'expired')
     order by y.verified_at, y.id;
end $$;
revoke all on function projects.client_financial_statement_payments(uuid) from public, anon, service_role;
grant execute on function projects.client_financial_statement_payments(uuid) to authenticated;

create or replace function projects.client_financial_statement_totals(p_project_id uuid default null)
returns table (currency text, invoiced_minor bigint, verified_minor bigint, outstanding_minor bigint)
language sql stable security definer set search_path = '' as $$
  select s.currency, coalesce(sum(s.total_minor) filter (where s.status <> 'void'), 0)::bigint, coalesce(sum(s.verified_minor) filter (where s.status <> 'void'), 0)::bigint, coalesce(sum(s.outstanding_minor), 0)::bigint
    from projects.client_financial_statement(p_project_id) s group by s.currency order by s.currency
$$;
revoke all on function projects.client_financial_statement_totals(uuid) from public, anon, service_role;
grant execute on function projects.client_financial_statement_totals(uuid) to authenticated;

notify pgrst, 'reload schema';
