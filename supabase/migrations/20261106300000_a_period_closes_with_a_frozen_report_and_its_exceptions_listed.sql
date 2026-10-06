-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9 - part 3: a financial PERIOD closes with a frozen report.
--
-- Plan WS6 / spec §10: "close the period only when required exceptions are resolved or formally documented"; reporting from authoritative records.
--
--   * finance.period_close_preview(start, end) - the report as it stands, computed in SQL from the books. Half-open [start, end), like reconciliation.
--       Cash is what was VERIFIED in the period (finance.payments.verified_at); refunds are the recorded ones; a waiver is reported on its own line and is
--       never cash received; unverified payments are listed apart and are never revenue. Per project: invoiced / collected / refunded / expensed / margin.
--       Profit and loss at the organization level is the same cash basis the overview uses: verified received - refunds - expenses.
--   * finance.close_period(start, end, label, acknowledgement) - a Finance person or Admin freezes that report. It lists every exception still standing
--       WITH ITS REASON; if any stands, the person must write the acknowledgement that formally documents it. The row is append-only: a closed period's
--       report is never edited, so "what the period looked like when it closed" is reconstructable forever.
--   * a closed period cannot overlap another closed period (a door check under a per-organization lock AND a trigger), and an EXPENSE dated inside a
--       closed period can no longer be added, changed or deleted (a trigger on finance.expenses that only ever fires for a period that entered the close;
--       an organization that never closes one is untouched).
--
-- Verifying a payment, recording a refund and deciding a waiver are timestamped when they happen, so nothing already inside a closed period can move.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance.period_closes (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  period_start       date not null,
  period_end         date not null,
  label              text not null check (length(btrim(label)) between 1 and 120),
  report             jsonb not null,
  invoiced_minor     bigint not null,
  collected_minor    bigint not null,
  refunded_minor     bigint not null,
  waived_minor       bigint not null,
  expensed_minor     bigint not null,
  net_minor          bigint not null,
  exceptions         jsonb not null check (jsonb_typeof(exceptions) = 'array'),
  acknowledgement    text check (acknowledgement is null or length(btrim(acknowledgement)) between 1 and 2000),
  closed_by          uuid not null references core.users(id) on delete restrict,
  closed_at          timestamptz not null default clock_timestamp(),
  check (period_end > period_start),
  -- standing exceptions must be formally documented
  check (jsonb_array_length(exceptions) = 0 or acknowledgement is not null),
  unique (organization_id, period_start, period_end)
);

create or replace function finance.period_closes_no_overlap()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from finance.period_closes c
              where c.organization_id = new.organization_id and c.id <> new.id and daterange(c.period_start, c.period_end) && daterange(new.period_start, new.period_end)) then
    raise exception 'a closed period may not overlap another closed period' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists period_closes_no_overlap on finance.period_closes;
create trigger period_closes_no_overlap before insert on finance.period_closes for each row execute function finance.period_closes_no_overlap();
drop trigger if exists period_closes_append_only on finance.period_closes;
create trigger period_closes_append_only before update or delete on finance.period_closes for each row execute function finance.phase9_history_append_only();

alter table finance.period_closes enable row level security;
drop policy if exists period_closes_select on finance.period_closes;
create policy period_closes_select on finance.period_closes for select to authenticated
  using (organization_id = (select core.current_organization_id()) and ((select core.is_admin()) or (select core.is_finance())));
revoke all on finance.period_closes from public, anon;
revoke insert, update, delete on finance.period_closes from authenticated;
grant select on finance.period_closes to authenticated;
grant all on finance.period_closes to service_role;
drop trigger if exists freeze_org_period_closes on finance.period_closes;
create trigger freeze_org_period_closes before update of organization_id on finance.period_closes for each row execute function core.freeze_organization_id();

-- ── the report itself ──
create or replace function finance.phase9_period_position(p_org uuid, p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from timestamptz := p_start::timestamp at time zone 'UTC'; v_to timestamptz := p_end::timestamp at time zone 'UTC';
  v_inv bigint; v_inv_n int; v_col bigint; v_ref bigint; v_wai bigint; v_exp bigint; v_unv bigint; v_projects jsonb; v_ex jsonb := '[]'::jsonb; r record;
begin
  select coalesce(sum(i.total_minor), 0), count(*) into v_inv, v_inv_n from finance.invoices i
   where i.organization_id = p_org and i.status not in ('draft', 'pending_approval', 'void') and i.issued_at >= v_from and i.issued_at < v_to;
  select coalesce(sum(p.amount_minor), 0) into v_col from finance.payments p
   where p.organization_id = p_org and p.status = 'captured' and p.verified_at is not null and p.verified_at >= v_from and p.verified_at < v_to;
  select coalesce(sum(f.amount_minor), 0) into v_ref from finance.refunds f where f.organization_id = p_org and f.status = 'recorded' and f.recorded_at >= v_from and f.recorded_at < v_to;
  select coalesce(sum(w.amount_minor), 0) into v_wai from finance.waivers w where w.organization_id = p_org and w.status = 'approved' and w.decided_at >= v_from and w.decided_at < v_to;
  select coalesce(sum(e.amount_minor), 0) into v_exp from finance.expenses e where e.organization_id = p_org and e.incurred_on >= p_start and e.incurred_on < p_end;
  select coalesce(sum(p.amount_minor), 0) into v_unv from finance.payments p
   where p.organization_id = p_org and p.status = 'captured' and p.verified_at is null and p.created_at < v_to;

  select coalesce(jsonb_agg(jsonb_build_object('projectId', t.project_id, 'projectName', t.name, 'invoicedMinor', t.invoiced, 'collectedMinor', t.collected, 'refundedMinor', t.refunded,
                                               'expensedMinor', t.expensed, 'marginMinor', t.collected - t.refunded - t.expensed) order by t.name), '[]'::jsonb) into v_projects
    from (select pr.id as project_id, pr.name,
                 coalesce((select sum(i.total_minor) from finance.invoices i where i.project_id = pr.id and i.status not in ('draft', 'pending_approval', 'void') and i.issued_at >= v_from and i.issued_at < v_to), 0) as invoiced,
                 coalesce((select sum(p.amount_minor) from finance.payments p join finance.invoices i on i.id = p.invoice_id where i.project_id = pr.id and p.status = 'captured' and p.verified_at >= v_from and p.verified_at < v_to), 0) as collected,
                 coalesce((select sum(f.amount_minor) from finance.refunds f join finance.invoices i on i.id = f.invoice_id where i.project_id = pr.id and f.status = 'recorded' and f.recorded_at >= v_from and f.recorded_at < v_to), 0) as refunded,
                 coalesce((select sum(e.amount_minor) from finance.expenses e where e.project_id = pr.id and e.incurred_on >= p_start and e.incurred_on < p_end), 0) as expensed
            from projects.projects pr where pr.organization_id = p_org and pr.deleted_at is null) t
   where t.invoiced <> 0 or t.collected <> 0 or t.refunded <> 0 or t.expensed <> 0;

  -- the exceptions standing now, each with its reason
  for r in select f.id, f.kind, f.reason, f.blocking from finance.finance_exceptions f where f.organization_id = p_org and f.state = 'open' and f.opened_at < v_to loop
    v_ex := v_ex || jsonb_build_array(jsonb_build_object('source', 'finance_exception', 'ref', r.id, 'kind', r.kind, 'blocking', r.blocking, 'reason', r.reason));
  end loop;
  for r in select s.id, i.number, s.status from finance.payment_submissions s join finance.invoices i on i.id = s.invoice_id
            where s.organization_id = p_org and s.submitted_at < v_to and s.status in ('pending_verification', 'evidence_requested', 'mismatch', 'partially_verified') loop
    v_ex := v_ex || jsonb_build_array(jsonb_build_object('source', 'payment_submission', 'ref', r.id, 'kind', 'unresolved_submission', 'blocking', true, 'reason', 'A payment submission on invoice ' || r.number || ' is ' || r.status || '.'));
  end loop;
  if v_unv > 0 then
    v_ex := v_ex || jsonb_build_array(jsonb_build_object('source', 'payments', 'kind', 'unverified_money', 'blocking', true, 'amountMinor', v_unv, 'reason', 'Payments are recorded but not verified; they are not counted as received.'));
  end if;
  for r in select w.id, i.number from finance.waivers w join finance.invoices i on i.id = w.invoice_id where w.organization_id = p_org and w.status = 'requested' loop
    v_ex := v_ex || jsonb_build_array(jsonb_build_object('source', 'waiver', 'ref', r.id, 'kind', 'waiver_pending', 'blocking', true, 'reason', 'A waiver on invoice ' || r.number || ' is waiting for an Admin.'));
  end loop;
  for r in select f.id, i.number from finance.refunds f join finance.invoices i on i.id = f.invoice_id where f.organization_id = p_org and f.status = 'requested' loop
    v_ex := v_ex || jsonb_build_array(jsonb_build_object('source', 'refund', 'ref', r.id, 'kind', 'refund_pending', 'blocking', true, 'reason', 'A refund on invoice ' || r.number || ' is requested and not yet recorded.'));
  end loop;
  for r in select rc.id from finance.reconciliations rc where rc.organization_id = p_org and rc.status = 'open' and rc.period_start < p_end and rc.period_end > p_start loop
    v_ex := v_ex || jsonb_build_array(jsonb_build_object('source', 'reconciliation', 'ref', r.id, 'kind', 'reconciliation_open', 'blocking', true, 'reason', 'A bank reconciliation overlapping this period is still open.'));
  end loop;

  return jsonb_build_object(
    'periodStart', p_start, 'periodEnd', p_end, 'basis', 'cash basis on VERIFIED money: collected = payments a person verified in the period; waived value and unverified money are not revenue',
    'invoiced', jsonb_build_object('count', v_inv_n, 'minor', v_inv),
    'collectedMinor', v_col, 'refundedMinor', v_ref, 'waivedMinor', v_wai, 'expensedMinor', v_exp, 'unverifiedMinor', v_unv,
    'profitAndLoss', jsonb_build_object('revenueMinor', v_col - v_ref, 'expensesMinor', v_exp, 'netMinor', v_col - v_ref - v_exp),
    'projects', v_projects, 'exceptions', v_ex);
end $$;
revoke all on function finance.phase9_period_position(uuid, date, date) from public, anon, authenticated;
grant execute on function finance.phase9_period_position(uuid, date, date) to service_role;

create or replace function finance.period_close_preview(p_period_start date, p_period_end date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if finance.phase9_caller_kind() not in ('admin', 'finance') or p_period_start is null or p_period_end is null or p_period_end <= p_period_start then return null; end if;
  return finance.phase9_period_position((select core.current_organization_id()), p_period_start, p_period_end);
end $$;
revoke all on function finance.period_close_preview(date, date) from public, anon;
grant execute on function finance.period_close_preview(date, date) to authenticated;

create or replace function finance.close_period(p_period_start date, p_period_end date, p_label text, p_acknowledgement text default null)
returns table (outcome text, period_close_id uuid, exception_count integer)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid := (select core.current_organization_id()); v_rep jsonb; v_ex jsonb; v_id uuid; v_ack text := nullif(btrim(coalesce(p_acknowledgement, '')), '');
begin
  if v_kind not in ('admin', 'finance') or v_org is null then return query select 'not_authorized'::text, null::uuid, null::integer; return; end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then return query select 'bad_period'::text, null::uuid, null::integer; return; end if;
  if p_label is null or length(btrim(p_label)) = 0 or length(p_label) > 120 or (v_ack is not null and (length(v_ack) > 2000 or finance.phase9_has_secret(v_ack))) then return query select 'bad_input'::text, null::uuid, null::integer; return; end if;
  -- a period that has not finished cannot be frozen
  if p_period_end > current_date + 1 then return query select 'period_not_ended'::text, null::uuid, null::integer; return; end if;
  perform pg_advisory_xact_lock(hashtextextended('finance.period_close:' || v_org::text, 0));
  if exists (select 1 from finance.period_closes c where c.organization_id = v_org and daterange(c.period_start, c.period_end) && daterange(p_period_start, p_period_end)) then
    return query select 'overlaps_a_closed_period'::text, null::uuid, null::integer; return;
  end if;
  v_rep := finance.phase9_period_position(v_org, p_period_start, p_period_end);
  v_ex := v_rep -> 'exceptions';
  if jsonb_array_length(v_ex) > 0 and v_ack is null then return query select 'exceptions_not_acknowledged'::text, null::uuid, jsonb_array_length(v_ex); return; end if;
  insert into finance.period_closes (organization_id, period_start, period_end, label, report, invoiced_minor, collected_minor, refunded_minor, waived_minor, expensed_minor, net_minor, exceptions, acknowledgement, closed_by)
  values (v_org, p_period_start, p_period_end, btrim(p_label), v_rep, (v_rep -> 'invoiced' ->> 'minor')::bigint, (v_rep ->> 'collectedMinor')::bigint, (v_rep ->> 'refundedMinor')::bigint,
          (v_rep ->> 'waivedMinor')::bigint, (v_rep ->> 'expensedMinor')::bigint, (v_rep -> 'profitAndLoss' ->> 'netMinor')::bigint, v_ex, v_ack, v_actor)
  returning id into v_id;
  perform core.record_audit(v_org, 'finance.period_closed', 'period_close', v_id, null, jsonb_build_object('periodStart', p_period_start, 'periodEnd', p_period_end, 'exceptions', jsonb_array_length(v_ex)));
  return query select 'closed'::text, v_id, jsonb_array_length(v_ex);
end $$;
revoke all on function finance.close_period(date, date, text, text) from public, anon;
grant execute on function finance.close_period(date, date, text, text) to authenticated;

-- ── an expense inside a closed period is history ──
create or replace function finance.closed_period_refuses_expense_change()
returns trigger language plpgsql set search_path = '' as $$
declare v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (select 1 from finance.period_closes c where c.organization_id = v_org and daterange(c.period_start, c.period_end) @> old.incurred_on) then
    raise exception 'an expense dated inside a closed financial period is history and cannot be changed' using errcode = 'check_violation';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (select 1 from finance.period_closes c where c.organization_id = v_org and daterange(c.period_start, c.period_end) @> new.incurred_on) then
    raise exception 'an expense cannot be dated inside a closed financial period' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists zz_phase9_closed_period_refuses_expense_change on finance.expenses;
create trigger zz_phase9_closed_period_refuses_expense_change before insert or update or delete on finance.expenses for each row execute function finance.closed_period_refuses_expense_change();

notify pgrst, 'reload schema';
