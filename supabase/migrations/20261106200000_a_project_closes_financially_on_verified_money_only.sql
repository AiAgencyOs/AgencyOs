-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9 - part 2: the financial close of a PROJECT, computed in SQL from verified money only.
--
-- The financial close (spec "Financial Close Responsibilities", plan WS7):
--   ALL PROJECT FINANCE RECORDS -> contract / invoiced / VERIFIED collected -> refunds / waivers -> open exceptions and disputes
--   -> reconciliation state -> outstanding balance -> ZERO BALANCE or AUTHORIZED EXCEPTION -> FINANCIAL_CLOSE or BLOCKED.
--
--   * finance.project_close_position(project)   - ONE read: per milestone (M1..Mn, by position) planned / invoiced / collected / refunded / net verified /
--       waived / outstanding / overdue / unverified, an aging split, margin (verified net - expenses - AI cost - time cost, the same cash-basis definition
--       as the report) and the list of BLOCKERS with a reason each. UNVERIFIED MONEY IS NEVER REVENUE: a claim, a submission or a captured-but-unverified
--       payment appears only on its own "unverified" line and is itself a blocker. A waiver is its own line; it is not cash.
--   * finance.evaluate_project_close(project)   - records that evaluation (append-only), for a person or the runner. It changes nothing else.
--   * finance.close_project_finances(project)   - a person in Finance / Admin (never the runner) closes the project's finances. It re-evaluates INSIDE the
--       door under the invoice locks. Refused (and the attempt recorded) while ANY blocker stands; a non-zero balance closes only against an APPROVED
--       close exception (requested by one person, approved by an Admin who is not that person) that still covers the balance. The close is a frozen
--       snapshot: append-only, one per project. It does NOT mark the project complete - Phase 7 still owns QA, production validation, handover and the
--       client's acceptance.
--   * after a close the project's milestone plan and milestone invoices are not reopened: new work is a change request or a new project (Phase 8).
--   * `project.financially_closed` is emitted once, so the PM is told and Phase 7 can read the fact (finance.project_is_financially_closed).
--
-- Nothing here verifies a payment, edits an invoice or amount, records a refund, or messages a client.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.financially_closed',
   'A Finance person or Admin closed the project''s finances: every milestone invoiced, no unverified money, no open blocking exception, and a zero balance or an approved close exception. It is NOT project completion; Phase 7 still owns QA, handover and client acceptance.', true)
on conflict (type) do nothing;

-- ── the invoice rows the close reads (service/definer use only) ──
create or replace function finance.phase9_invoice_rows(p_project_id uuid)
returns table (invoice_id uuid, invoice_number text, milestone_id uuid, status text, total_minor bigint, tax_minor bigint, due_at timestamptz,
               collected_minor bigint, refunded_minor bigint, unverified_minor bigint, waived_minor bigint, verified_net_minor bigint, outstanding_minor bigint)
language sql stable security definer set search_path = '' as $$
  select i.id, i.number, i.milestone_id, i.status, i.total_minor::bigint, i.tax_minor::bigint, i.due_at,
         c.collected, r.refunded, u.unverified, finance.invoice_waived_minor(i.id),
         greatest(c.collected - r.refunded, 0)::bigint, finance.invoice_outstanding_minor(i.id)
    from finance.invoices i
    cross join lateral (select coalesce(sum(p.amount_minor), 0)::bigint as collected from finance.payments p where p.invoice_id = i.id and p.status = 'captured' and p.verified_at is not null) c
    cross join lateral (select coalesce(sum(f.amount_minor), 0)::bigint as refunded from finance.refunds f where f.invoice_id = i.id and f.status = 'recorded') r
    cross join lateral (select coalesce(sum(p.amount_minor), 0)::bigint as unverified from finance.payments p where p.invoice_id = i.id and p.status = 'captured' and p.verified_at is null) u
   where i.project_id = p_project_id and i.status not in ('draft', 'pending_approval', 'void')
$$;
revoke all on function finance.phase9_invoice_rows(uuid) from public, anon, authenticated;
grant execute on function finance.phase9_invoice_rows(uuid) to service_role;

-- ── the position, with no authorization of its own (definer doors call it) ──
create or replace function finance.phase9_compute_position(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_p projects.projects; v_org uuid;
  v_ms jsonb; v_unassigned jsonb; v_aging jsonb; v_b jsonb := '[]'::jsonb; v_result text;
  v_contract bigint; v_invoiced bigint; v_collected bigint; v_refunded bigint; v_vnet bigint; v_waived bigint; v_out bigint; v_overdue bigint; v_unv bigint;
  v_exp bigint; v_ai bigint; v_time bigint; v_uncosted numeric; v_margin bigint; v_pct numeric;
  v_n_ms int; v_n_inv int; r record;
begin
  select * into v_p from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_p.id is null then return null; end if;
  v_org := v_p.organization_id;

  select coalesce(sum(m.amount_minor), 0), count(*) into v_contract, v_n_ms from projects.milestones m where m.project_id = p_project_id;
  select count(*) into v_n_inv from finance.invoices i where i.project_id = p_project_id and i.status <> 'void';

  select coalesce(sum(x.total_minor), 0), coalesce(sum(x.collected_minor), 0), coalesce(sum(x.refunded_minor), 0), coalesce(sum(x.verified_net_minor), 0),
         coalesce(sum(x.waived_minor), 0), coalesce(sum(x.outstanding_minor), 0), coalesce(sum(x.unverified_minor), 0),
         coalesce(sum(x.outstanding_minor) filter (where x.due_at is not null and x.due_at < now()), 0)
    into v_invoiced, v_collected, v_refunded, v_vnet, v_waived, v_out, v_unv, v_overdue
    from finance.phase9_invoice_rows(p_project_id) x;

  select coalesce(sum(e.amount_minor), 0) into v_exp from finance.expenses e where e.project_id = p_project_id and e.organization_id = v_org;
  select coalesce(sum(a.cost_minor), 0) into v_ai from ai.agent_runs a where a.project_id = p_project_id and a.organization_id = v_org;
  select coalesce(sum(t.cost_minor), 0), coalesce(sum(t.hours) filter (where t.rate_missing), 0) into v_time, v_uncosted from projects.time_log_costs t where t.project_id = p_project_id;
  v_margin := v_vnet - (v_exp + v_ai + v_time);
  v_pct := case when v_vnet > 0 then round((v_margin::numeric / v_vnet) * 100, 1) else null end;

  -- per milestone, by position (M1..Mn)
  select coalesce(jsonb_agg(jsonb_build_object(
           'milestoneId', q.id, 'name', q.name, 'position', q.position, 'operationalStatus', q.status, 'plannedMinor', q.amount_minor,
           'invoiced', q.n_inv, 'invoicedMinor', q.invoiced, 'collectedMinor', q.collected, 'refundedMinor', q.refunded, 'verifiedNetMinor', q.vnet,
           'waivedMinor', q.waived, 'outstandingMinor', q.outstanding, 'overdueMinor', q.overdue, 'unverifiedMinor', q.unv) order by q.position, q.created_at), '[]'::jsonb)
    into v_ms
    from (select m.id, m.name, m.position, m.status, m.amount_minor, m.created_at,
                 count(x.invoice_id) as n_inv, coalesce(sum(x.total_minor), 0) as invoiced, coalesce(sum(x.collected_minor), 0) as collected, coalesce(sum(x.refunded_minor), 0) as refunded,
                 coalesce(sum(x.verified_net_minor), 0) as vnet, coalesce(sum(x.waived_minor), 0) as waived, coalesce(sum(x.outstanding_minor), 0) as outstanding,
                 coalesce(sum(x.outstanding_minor) filter (where x.due_at is not null and x.due_at < now()), 0) as overdue, coalesce(sum(x.unverified_minor), 0) as unv
            from projects.milestones m
            left join finance.phase9_invoice_rows(p_project_id) x on x.milestone_id = m.id
           where m.project_id = p_project_id group by m.id) q;

  -- invoices that belong to no milestone (change requests, services, renewals)
  select jsonb_build_object('name', 'Not tied to a milestone', 'invoiced', count(*), 'invoicedMinor', coalesce(sum(x.total_minor), 0), 'collectedMinor', coalesce(sum(x.collected_minor), 0),
           'refundedMinor', coalesce(sum(x.refunded_minor), 0), 'verifiedNetMinor', coalesce(sum(x.verified_net_minor), 0), 'waivedMinor', coalesce(sum(x.waived_minor), 0),
           'outstandingMinor', coalesce(sum(x.outstanding_minor), 0), 'unverifiedMinor', coalesce(sum(x.unverified_minor), 0))
    into v_unassigned from finance.phase9_invoice_rows(p_project_id) x where x.milestone_id is null;

  -- aging of what is still owed
  select jsonb_build_object(
           'current', coalesce(sum(x.outstanding_minor) filter (where x.due_at is null or x.due_at >= now()), 0),
           'days1to30', coalesce(sum(x.outstanding_minor) filter (where x.due_at < now() and now() - x.due_at <= interval '30 days'), 0),
           'days31to60', coalesce(sum(x.outstanding_minor) filter (where now() - x.due_at > interval '30 days' and now() - x.due_at <= interval '60 days'), 0),
           'days61to90', coalesce(sum(x.outstanding_minor) filter (where now() - x.due_at > interval '60 days' and now() - x.due_at <= interval '90 days'), 0),
           'over90', coalesce(sum(x.outstanding_minor) filter (where now() - x.due_at > interval '90 days'), 0))
    into v_aging from finance.phase9_invoice_rows(p_project_id) x where x.outstanding_minor > 0;

  -- ── the blockers, each with its reason ──
  if v_n_ms = 0 and v_n_inv = 0 then
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'no_financial_record', 'reason', 'The project has no milestone and no invoice, so what was agreed cannot be reconstructed.', 'waivable', false));
  end if;
  for r in select m.id, m.name from projects.milestones m
            where m.project_id = p_project_id and m.amount_minor > 0
              and not exists (select 1 from finance.invoices i where i.milestone_id = m.id and i.status not in ('draft', 'pending_approval', 'void')) loop
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'milestone_not_invoiced', 'reason', 'Milestone "' || r.name || '" has no issued invoice.', 'ref', r.id, 'waivable', false));
  end loop;
  for r in select i.id, i.number from finance.invoices i where i.project_id = p_project_id and i.status in ('draft', 'pending_approval') loop
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'invoice_not_issued', 'reason', 'Invoice ' || r.number || ' is still a draft or awaiting approval.', 'ref', r.id, 'waivable', false));
  end loop;
  if v_unv > 0 then
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'unverified_money', 'reason', 'Payments are recorded but not verified by a person; unverified money is not revenue and cannot close a project.', 'amountMinor', v_unv, 'waivable', false));
  end if;
  for r in select s.id, i.number, s.status from finance.payment_submissions s join finance.invoices i on i.id = s.invoice_id
            where i.project_id = p_project_id and s.status in ('pending_verification', 'evidence_requested', 'mismatch', 'partially_verified') loop
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'payment_submission_unresolved', 'reason', 'A payment submission on invoice ' || r.number || ' is ' || r.status || '.', 'ref', r.id, 'waivable', false));
  end loop;
  for r in select x.invoice_id, x.invoice_number, x.verified_net_minor, x.total_minor from finance.phase9_invoice_rows(p_project_id) x where x.collected_minor - x.refunded_minor > x.total_minor loop
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'overpayment', 'reason', 'Invoice ' || r.invoice_number || ' holds more verified money than it is for.', 'ref', r.invoice_id, 'waivable', false));
  end loop;
  for r in select f.id, f.kind, f.reason from finance.finance_exceptions f
            where f.organization_id = v_org and f.state = 'open' and f.blocking
              and (f.project_id = p_project_id or f.invoice_id in (select i.id from finance.invoices i where i.project_id = p_project_id)) loop
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'open_exception', 'reason', 'Open ' || replace(r.kind, '_', ' ') || ': ' || r.reason, 'ref', r.id, 'kind', r.kind, 'waivable', false));
  end loop;
  for r in select w.id, i.number from finance.waivers w join finance.invoices i on i.id = w.invoice_id where i.project_id = p_project_id and w.status = 'requested' loop
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'waiver_pending', 'reason', 'A waiver on invoice ' || r.number || ' is waiting for an Admin.', 'ref', r.id, 'waivable', false));
  end loop;
  for r in select f.id, i.number from finance.refunds f join finance.invoices i on i.id = f.invoice_id where i.project_id = p_project_id and f.status = 'requested' loop
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'refund_pending', 'reason', 'A refund on invoice ' || r.number || ' is requested and not yet recorded.', 'ref', r.id, 'waivable', false));
  end loop;
  for r in select distinct rc.id from finance.reconciliation_items ri join finance.reconciliations rc on rc.id = ri.reconciliation_id
             join finance.payments p on p.id = ri.payment_id join finance.invoices i on i.id = p.invoice_id
            where i.project_id = p_project_id and rc.status = 'open' and ri.finding <> 'matched' loop
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'reconciliation_open', 'reason', 'An open reconciliation holds an unmatched, duplicate or discrepant item for one of this project''s payments.', 'ref', r.id, 'waivable', false));
  end loop;
  if v_out > 0 then
    v_b := v_b || jsonb_build_array(jsonb_build_object('code', 'outstanding_balance', 'reason', 'A balance is still owed after verified money and approved waivers.', 'amountMinor', v_out, 'waivable', true));
  end if;

  v_result := case
    when jsonb_array_length(v_b) = 0 then 'clear'
    when not exists (select 1 from jsonb_array_elements(v_b) e where (e ->> 'waivable')::boolean is not true) then 'outstanding_only'
    else 'blocked' end;

  return jsonb_build_object(
    'projectId', p_project_id, 'projectName', v_p.name, 'currency', v_p.currency, 'evaluatedAt', now(), 'result', v_result,
    'totals', jsonb_build_object('contractMinor', v_contract, 'invoicedMinor', v_invoiced, 'collectedMinor', v_collected, 'refundedMinor', v_refunded, 'verifiedNetMinor', v_vnet,
        'waivedMinor', v_waived, 'outstandingMinor', v_out, 'overdueMinor', v_overdue, 'unverifiedMinor', v_unv, 'expensesMinor', v_exp, 'aiCostMinor', v_ai, 'timeCostMinor', v_time,
        'uncostedHours', v_uncosted, 'marginMinor', v_margin, 'marginPercent', v_pct, 'marginBasis', 'cash-basis estimate: verified revenue - (expenses + AI cost + time cost); waived value and unverified money are not revenue'),
    'milestones', v_ms, 'notTiedToAMilestone', coalesce(v_unassigned, '{}'::jsonb), 'aging', coalesce(v_aging, jsonb_build_object('current', 0, 'days1to30', 0, 'days31to60', 0, 'days61to90', 0, 'over90', 0)),
    'blockers', v_b);
end $$;
revoke all on function finance.phase9_compute_position(uuid) from public, anon, authenticated;
grant execute on function finance.phase9_compute_position(uuid) to service_role;

-- ── the read a person (or the runner) uses ──
create or replace function finance.project_close_position(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_org uuid;
begin
  if v_kind = 'none' then return null; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return null; end if;
  if v_kind <> 'service' and v_org is distinct from (select core.current_organization_id()) then return null; end if;
  return finance.phase9_compute_position(p_project_id);
end $$;
revoke all on function finance.project_close_position(uuid) from public, anon;
grant execute on function finance.project_close_position(uuid) to authenticated, service_role;

-- ── the evaluations (every one kept) ──
create table if not exists finance.financial_close_evaluations (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  project_id          uuid not null references projects.projects(id) on delete restrict,
  result              text not null check (result in ('clear', 'outstanding_only', 'blocked')),
  contract_minor      bigint not null,
  invoiced_minor      bigint not null,
  verified_net_minor  bigint not null,
  waived_minor        bigint not null,
  outstanding_minor   bigint not null,
  unverified_minor    bigint not null,
  expenses_minor      bigint not null,
  margin_minor        bigint not null,
  blockers            jsonb not null check (jsonb_typeof(blockers) = 'array'),
  position            jsonb not null,
  evaluated_by        uuid references core.users(id) on delete set null,
  evaluated_by_system boolean not null default false,
  created_at          timestamptz not null default clock_timestamp()
);
create index if not exists financial_close_evaluations_project_idx on finance.financial_close_evaluations (project_id, created_at desc);

-- ── a close exception: a non-zero balance may close only against one an Admin approved ──
create table if not exists finance.close_exceptions (
  id                           uuid primary key default gen_random_uuid(),
  organization_id              uuid not null references core.organizations(id) on delete cascade,
  project_id                   uuid not null references projects.projects(id) on delete restrict,
  reason                       text not null check (length(btrim(reason)) between 1 and 1000),
  outstanding_at_request_minor bigint not null check (outstanding_at_request_minor > 0),
  status                       text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  requested_by                 uuid not null references core.users(id) on delete restrict,
  requested_at                 timestamptz not null default clock_timestamp(),
  decided_by                   uuid references core.users(id) on delete restrict,
  decided_at                   timestamptz,
  decision_note                text,
  check ((status = 'requested') = (decided_at is null and decided_by is null)),
  check (status = 'requested' or (decision_note is not null and length(btrim(decision_note)) > 0)),
  check (decided_by is null or decided_by <> requested_by)
);
create unique index if not exists close_exceptions_one_pending_per_project on finance.close_exceptions (project_id) where status = 'requested';

create or replace function finance.close_exceptions_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a close exception is history and is never deleted' using errcode = 'restrict_violation'; end if;
  if old.status <> 'requested' then raise exception 'a decided close exception is history and is never edited' using errcode = 'restrict_violation'; end if;
  if (new.id, new.organization_id, new.project_id, new.reason, new.outstanding_at_request_minor, new.requested_by, new.requested_at)
     is distinct from (old.id, old.organization_id, old.project_id, old.reason, old.outstanding_at_request_minor, old.requested_by, old.requested_at) then
    raise exception 'a requested close exception is decided, never rewritten' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists close_exceptions_guard on finance.close_exceptions;
create trigger close_exceptions_guard before update or delete on finance.close_exceptions for each row execute function finance.close_exceptions_guard();

-- ── the close itself: frozen, one per project ──
create table if not exists finance.project_financial_closes (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null unique references projects.projects(id) on delete restrict,
  evaluation_id      uuid not null references finance.financial_close_evaluations(id) on delete restrict,
  mode               text not null check (mode in ('zero_balance', 'approved_exception')),
  close_exception_id uuid references finance.close_exceptions(id) on delete restrict,
  closed_by          uuid not null references core.users(id) on delete restrict,
  closed_at          timestamptz not null default clock_timestamp(),
  note               text check (note is null or length(note) <= 1000),
  snapshot           jsonb not null,
  check ((mode = 'approved_exception') = (close_exception_id is not null))
);

do $$
declare r record;
begin
  for r in select * from (values
    ('financial_close_evaluations', 'project_id', 'projects.projects'),
    ('close_exceptions', 'project_id', 'projects.projects'),
    ('project_financial_closes', 'project_id', 'projects.projects'), ('project_financial_closes', 'evaluation_id', 'finance.financial_close_evaluations'), ('project_financial_closes', 'close_exception_id', 'finance.close_exceptions')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on finance.%I', 'org_match_' || r.tbl || '_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I, organization_id on finance.%I for each row execute function core.enforce_parent_org(%L, %L)', 'org_match_' || r.tbl || '_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['financial_close_evaluations', 'close_exceptions', 'project_financial_closes']) as tbl loop
    execute format('alter table finance.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on finance.%I', r.tbl || '_select', r.tbl);
    execute format($p$create policy %I on finance.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and ((select core.is_admin()) or (select core.is_finance())))$p$, r.tbl || '_select', r.tbl);
    execute format('revoke all on finance.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on finance.%I from authenticated', r.tbl);
    execute format('grant select on finance.%I to authenticated', r.tbl);
    execute format('grant all on finance.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on finance.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on finance.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
  -- an evaluation and a close are history
  for r in select unnest(array['financial_close_evaluations', 'project_financial_closes']) as tbl loop
    execute format('drop trigger if exists %I on finance.%I', r.tbl || '_append_only', r.tbl);
    execute format('create trigger %I before update or delete on finance.%I for each row execute function finance.phase9_history_append_only()', r.tbl || '_append_only', r.tbl);
  end loop;
end $$;

-- ── record an evaluation ──
create or replace function finance.evaluate_project_close(p_project_id uuid)
returns table (outcome text, evaluation_id uuid, result text, blocker_count integer)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid; v_pos jsonb; v_id uuid;
begin
  if v_kind = 'none' then return query select 'not_authorized'::text, null::uuid, null::text, null::integer; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null or (v_kind <> 'service' and v_org is distinct from (select core.current_organization_id())) then return query select 'not_found'::text, null::uuid, null::text, null::integer; return; end if;
  v_pos := finance.phase9_compute_position(p_project_id);
  insert into finance.financial_close_evaluations (organization_id, project_id, result, contract_minor, invoiced_minor, verified_net_minor, waived_minor, outstanding_minor, unverified_minor, expenses_minor, margin_minor, blockers, position, evaluated_by, evaluated_by_system)
  values (v_org, p_project_id, v_pos ->> 'result', (v_pos -> 'totals' ->> 'contractMinor')::bigint, (v_pos -> 'totals' ->> 'invoicedMinor')::bigint, (v_pos -> 'totals' ->> 'verifiedNetMinor')::bigint,
          (v_pos -> 'totals' ->> 'waivedMinor')::bigint, (v_pos -> 'totals' ->> 'outstandingMinor')::bigint, (v_pos -> 'totals' ->> 'unverifiedMinor')::bigint,
          (v_pos -> 'totals' ->> 'expensesMinor')::bigint, (v_pos -> 'totals' ->> 'marginMinor')::bigint, v_pos -> 'blockers', v_pos, v_actor, v_actor is null)
  returning id into v_id;
  return query select 'evaluated'::text, v_id, v_pos ->> 'result', jsonb_array_length(v_pos -> 'blockers');
end $$;
revoke all on function finance.evaluate_project_close(uuid) from public, anon;
grant execute on function finance.evaluate_project_close(uuid) to authenticated, service_role;

-- ── a close exception: asked by one person, decided by an Admin who is not that person ──
create or replace function finance.request_close_exception(p_project_id uuid, p_reason text)
returns table (outcome text, close_exception_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid; v_pos jsonb; v_out bigint; v_id uuid;
begin
  if v_kind not in ('admin', 'finance') then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 1000 then return query select 'reason_required'::text, null::uuid; return; end if;
  if finance.phase9_has_secret(p_reason) then return query select 'secret_in_text'::text, null::uuid; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null for update;
  if v_org is null or v_org is distinct from (select core.current_organization_id()) then return query select 'not_found'::text, null::uuid; return; end if;
  if exists (select 1 from finance.project_financial_closes c where c.project_id = p_project_id) then return query select 'already_closed'::text, null::uuid; return; end if;
  v_pos := finance.phase9_compute_position(p_project_id);
  v_out := (v_pos -> 'totals' ->> 'outstandingMinor')::bigint;
  if v_out <= 0 then return query select 'nothing_to_except'::text, null::uuid; return; end if;
  -- an exception covers a balance and nothing else: any other blocker must be fixed, not excused
  if v_pos ->> 'result' <> 'outstanding_only' then return query select 'other_blockers_stand'::text, null::uuid; return; end if;
  begin
    insert into finance.close_exceptions (organization_id, project_id, reason, outstanding_at_request_minor, requested_by) values (v_org, p_project_id, btrim(p_reason), v_out, v_actor) returning id into v_id;
  exception when unique_violation then return query select 'already_pending'::text, null::uuid; return;
  end;
  perform core.record_audit(v_org, 'finance.close_exception_requested', 'close_exception', v_id, null, jsonb_build_object('projectId', p_project_id, 'outstandingMinor', v_out));
  return query select 'requested'::text, v_id;
end $$;
revoke all on function finance.request_close_exception(uuid, text) from public, anon;
grant execute on function finance.request_close_exception(uuid, text) to authenticated;

create or replace function finance.decide_close_exception(p_close_exception_id uuid, p_decision text, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_e finance.close_exceptions;
begin
  if v_kind <> 'admin' then return query select 'not_authorized'::text; return; end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then return query select 'bad_decision'::text; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 or length(p_note) > 1000 then return query select 'reason_required'::text; return; end if;
  if finance.phase9_has_secret(p_note) then return query select 'secret_in_text'::text; return; end if;
  select * into v_e from finance.close_exceptions x where x.id = p_close_exception_id and x.organization_id = (select core.current_organization_id()) for update;
  if v_e.id is null then return query select 'not_found'::text; return; end if;
  if v_e.status <> 'requested' then return query select 'already_decided'::text; return; end if;
  if v_e.requested_by = v_actor then return query select 'self_approval'::text; return; end if;
  update finance.close_exceptions set status = p_decision, decided_by = v_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note) where id = v_e.id;
  perform core.record_audit(v_e.organization_id, 'finance.close_exception_' || p_decision, 'close_exception', v_e.id, null, jsonb_build_object('projectId', v_e.project_id, 'outstandingMinor', v_e.outstanding_at_request_minor));
  return query select p_decision;
end $$;
revoke all on function finance.decide_close_exception(uuid, text, text) from public, anon;
grant execute on function finance.decide_close_exception(uuid, text, text) to authenticated;

-- ── close the project's finances ──
create or replace function finance.close_project_finances(p_project_id uuid, p_note text default null)
returns table (outcome text, close_id uuid, mode text, evaluation_id uuid, blockers jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid; v_pos jsonb; v_eval uuid; v_result text; v_out bigint; v_exc finance.close_exceptions; v_mode text; v_close uuid;
begin
  -- a person closes a project's finances; the runner never does
  if v_kind not in ('admin', 'finance') then return query select 'not_authorized'::text, null::uuid, null::text, null::uuid, null::jsonb; return; end if;
  if p_note is not null and (length(p_note) > 1000 or finance.phase9_has_secret(p_note)) then return query select 'bad_input'::text, null::uuid, null::text, null::uuid, null::jsonb; return; end if;
  -- the project row serialises two closers; the invoice rows serialise a close against a verification in flight
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null for update;
  if v_org is null or v_org is distinct from (select core.current_organization_id()) then return query select 'not_found'::text, null::uuid, null::text, null::uuid, null::jsonb; return; end if;
  select c.id, c.mode, c.evaluation_id into v_close, v_mode, v_eval from finance.project_financial_closes c where c.project_id = p_project_id;
  if v_close is not null then return query select 'already_closed'::text, v_close, v_mode, v_eval, null::jsonb; return; end if;
  perform 1 from finance.invoices i where i.project_id = p_project_id order by i.id for update;

  v_pos := finance.phase9_compute_position(p_project_id);
  v_result := v_pos ->> 'result'; v_out := (v_pos -> 'totals' ->> 'outstandingMinor')::bigint;
  insert into finance.financial_close_evaluations (organization_id, project_id, result, contract_minor, invoiced_minor, verified_net_minor, waived_minor, outstanding_minor, unverified_minor, expenses_minor, margin_minor, blockers, position, evaluated_by, evaluated_by_system)
  values (v_org, p_project_id, v_result, (v_pos -> 'totals' ->> 'contractMinor')::bigint, (v_pos -> 'totals' ->> 'invoicedMinor')::bigint, (v_pos -> 'totals' ->> 'verifiedNetMinor')::bigint,
          (v_pos -> 'totals' ->> 'waivedMinor')::bigint, v_out, (v_pos -> 'totals' ->> 'unverifiedMinor')::bigint, (v_pos -> 'totals' ->> 'expensesMinor')::bigint,
          (v_pos -> 'totals' ->> 'marginMinor')::bigint, v_pos -> 'blockers', v_pos, v_actor, false) returning id into v_eval;

  if v_result = 'blocked' then return query select 'blocked'::text, null::uuid, null::text, v_eval, v_pos -> 'blockers'; return; end if;
  if v_result = 'clear' then
    v_mode := 'zero_balance';
  else
    -- a balance remains: only an APPROVED exception that still covers it lets the close through
    select * into v_exc from finance.close_exceptions x where x.project_id = p_project_id and x.status = 'approved' and x.outstanding_at_request_minor >= v_out order by x.decided_at desc limit 1;
    if v_exc.id is null then return query select 'balance_needs_an_approved_exception'::text, null::uuid, null::text, v_eval, v_pos -> 'blockers'; return; end if;
    v_mode := 'approved_exception';
  end if;

  insert into finance.project_financial_closes (organization_id, project_id, evaluation_id, mode, close_exception_id, closed_by, note, snapshot)
  values (v_org, p_project_id, v_eval, v_mode, v_exc.id, v_actor, nullif(btrim(coalesce(p_note, '')), ''), v_pos) returning id into v_close;
  perform core.record_audit(v_org, 'finance.project_financially_closed', 'project', p_project_id, null, jsonb_build_object('mode', v_mode, 'closeId', v_close, 'evaluationId', v_eval, 'outstandingMinor', v_out));
  perform core.emit_event(v_org, 'project.financially_closed', 'project', p_project_id, jsonb_build_object('projectId', p_project_id, 'mode', v_mode));
  return query select 'closed'::text, v_close, v_mode, v_eval, '[]'::jsonb;
end $$;
revoke all on function finance.close_project_finances(uuid, text) from public, anon;
grant execute on function finance.close_project_finances(uuid, text) to authenticated;

-- ── the fact Phase 7 (and the PM) may read: closed or not, nothing more ──
create or replace function finance.project_is_financially_closed(p_project_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return false; end if;
  if (select auth.uid()) is null then
    if coalesce((select auth.role()), '') <> 'service_role' then return false; end if;
  elsif v_org is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false) then
    return false;
  end if;
  return exists (select 1 from finance.project_financial_closes c where c.project_id = p_project_id);
end $$;
revoke all on function finance.project_is_financially_closed(uuid) from public, anon;
grant execute on function finance.project_is_financially_closed(uuid) to authenticated, service_role;

-- ── after a close the historical plan is not reopened (only a project that entered the close is affected) ──
create or replace function finance.closed_project_refuses_milestone_invoice()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.project_id is not null and new.milestone_id is not null and exists (select 1 from finance.project_financial_closes c where c.project_id = new.project_id) then
    raise exception 'the project is financially closed: a closed milestone is not invoiced again; new work is a change request or a new project' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists zz_phase9_closed_project_refuses_milestone_invoice on finance.invoices;
create trigger zz_phase9_closed_project_refuses_milestone_invoice before insert on finance.invoices for each row execute function finance.closed_project_refuses_milestone_invoice();

create or replace function finance.closed_project_refuses_plan_change()
returns trigger language plpgsql set search_path = '' as $$
declare v_project uuid := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
begin
  if exists (select 1 from finance.project_financial_closes c where c.project_id = v_project)
     and (tg_op in ('INSERT', 'DELETE') or (new.amount_minor, new.payment_percent) is distinct from (old.amount_minor, old.payment_percent)) then
    raise exception 'the project is financially closed: its milestone plan is history; new work is a change request or a new project' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists zz_phase9_closed_project_refuses_plan_change on projects.milestones;
create trigger zz_phase9_closed_project_refuses_plan_change before insert or update or delete on projects.milestones for each row execute function finance.closed_project_refuses_plan_change();

notify pgrst, 'reload schema';
