-- ═══════════════════════════════════════════════════════════════════════════
-- R3-2 (owner, round 3b, 2026-10-01): "The period report snapshot also holds
-- payments received and the profit-and-loss figures."
--
-- Per currency the snapshot now also carries, computed here from the ledger
-- (the caller still supplies only the period and a label):
--
--   payments         count / received_minor: captured payments a person VERIFIED
--                    (verified_at inside the period - the verified basis of
--                    finance/verified-basis.ts), refunded_minor: refunds recorded
--                    in the period, net_received_minor = received - refunded.
--   profit_and_loss  revenue_minor = net_received_minor (cash basis, verified),
--                    expenses_minor = the period's expenses,
--                    net_minor = revenue - expenses.
--
-- Older snapshots keep their shape; readers treat the new keys as optional.
-- Same signature, security and audit as before. Additive and idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.generate_period_report(
  p_period_start date,
  p_period_end   date,
  p_label        text default null
)
returns table (outcome text, id uuid, invoice_count integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_label text := left(coalesce(nullif(btrim(p_label), ''), p_period_start::text || ' to ' || p_period_end::text), 120);
  v_from  timestamptz;
  v_to    timestamptz;
  v_snap  jsonb;
  v_count integer;
  v_id    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid, 0; return;
  end if;
  if not (coalesce((select core.is_admin()), false) or coalesce((select core.is_finance()), false)) then
    return query select 'forbidden'::text, null::uuid, 0; return;
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    return query select 'not_a_period'::text, null::uuid, 0; return;
  end if;

  -- The tax page's window: calendar days, UTC, half-open.
  v_from := p_period_start::timestamp at time zone 'UTC';
  v_to   := p_period_end::timestamp at time zone 'UTC';

  with inv as (
    select i.currency::text as currency,
           i.subtotal_minor, i.tax_minor, i.total_minor,
           least(i.verified_minor, i.total_minor) as paid_minor,
           coalesce(bp.mode, 'unconfirmed') as mode
      from finance.invoices i
      left join lateral (
        select b.mode from finance.billing_profiles b
         where b.project_id = i.project_id and b.status = 'active'
         order by b.created_at desc limit 1
      ) bp on true
     where i.organization_id = v_org
       and i.status not in ('draft', 'void')
       and i.issued_at >= v_from and i.issued_at < v_to
  ), exp as (
    select e.currency::text as currency, count(*) as n, coalesce(sum(e.amount_minor), 0) as amount_minor
      from finance.expenses e
     where e.organization_id = v_org
       and e.incurred_on >= p_period_start and e.incurred_on < p_period_end
     group by e.currency
  ), pay as (
    -- R3-2, verified basis: captured payments a person verified, by the day of
    -- verification, inside the period (the basis of finance/verified-basis.ts).
    select p.currency::text as currency, count(*) as n, coalesce(sum(p.amount_minor), 0) as amount_minor
      from finance.payments p
     where p.organization_id = v_org
       and p.status = 'captured'
       and p.verified_at is not null
       and p.verified_at >= v_from and p.verified_at < v_to
     group by p.currency
  ), ref as (
    -- ... less refunds recorded in the period (net_verified_minor deducts them).
    select i.currency::text as currency, count(*) as n, coalesce(sum(r.amount_minor), 0) as amount_minor
      from finance.refunds r
      join finance.invoices i on i.id = r.invoice_id
     where r.organization_id = v_org
       and r.status = 'recorded'
       and r.recorded_at >= v_from and r.recorded_at < v_to
     group by i.currency
  ), cur as (
    select currency from inv group by currency
    union
    select currency from exp
    union
    select currency from pay
    union
    select currency from ref
  ), agg as (
    select c.currency,
           jsonb_build_object(
             'currency', c.currency,
             'invoices', jsonb_build_object(
               'count', (select count(*) from inv where inv.currency = c.currency),
               'subtotal_minor', (select coalesce(sum(subtotal_minor), 0) from inv where inv.currency = c.currency),
               'tax_minor', (select coalesce(sum(tax_minor), 0) from inv where inv.currency = c.currency),
               'total_minor', (select coalesce(sum(total_minor), 0) from inv where inv.currency = c.currency),
               'paid_minor', (select coalesce(sum(paid_minor), 0) from inv where inv.currency = c.currency)),
             'by_mode', (
               select coalesce(jsonb_object_agg(m.mode, jsonb_build_object(
                        'count', m.n, 'subtotal_minor', m.subtotal, 'tax_minor', m.tax, 'total_minor', m.total)), '{}'::jsonb)
                 from (select mode, count(*) n, sum(subtotal_minor) subtotal, sum(tax_minor) tax, sum(total_minor) total
                         from inv where inv.currency = c.currency group by mode) m),
             'expenses', jsonb_build_object(
               'count', coalesce((select n from exp where exp.currency = c.currency), 0),
               'amount_minor', coalesce((select amount_minor from exp where exp.currency = c.currency), 0)),
             'payments', jsonb_build_object(
               'count', coalesce((select n from pay where pay.currency = c.currency), 0),
               'received_minor', coalesce((select amount_minor from pay where pay.currency = c.currency), 0),
               'refunded_minor', coalesce((select amount_minor from ref where ref.currency = c.currency), 0),
               'net_received_minor', coalesce((select amount_minor from pay where pay.currency = c.currency), 0)
                                     - coalesce((select amount_minor from ref where ref.currency = c.currency), 0)),
             'profit_and_loss', jsonb_build_object(
               'revenue_minor', coalesce((select amount_minor from pay where pay.currency = c.currency), 0)
                                - coalesce((select amount_minor from ref where ref.currency = c.currency), 0),
               'expenses_minor', coalesce((select amount_minor from exp where exp.currency = c.currency), 0),
               'net_minor', coalesce((select amount_minor from pay where pay.currency = c.currency), 0)
                            - coalesce((select amount_minor from ref where ref.currency = c.currency), 0)
                            - coalesce((select amount_minor from exp where exp.currency = c.currency), 0))
           ) as figures
      from cur c
  )
  select coalesce(jsonb_agg(agg.figures order by agg.currency), '[]'::jsonb),
         coalesce((select count(*) from inv), 0)
    into v_snap, v_count
    from agg;

  insert into finance.period_reports (organization_id, period_start, period_end, period_label, invoice_count, snapshot, generated_by)
  values (v_org, p_period_start, p_period_end, v_label, v_count, v_snap, v_actor)
  returning finance.period_reports.id into v_id;

  perform core.record_audit(
    v_org, 'finance.period_report_generated', 'period_report', v_id, null,
    jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'label', v_label, 'invoices', v_count)
  );

  return query select 'generated'::text, v_id, v_count;
end;
$$;

revoke all on function finance.generate_period_report(date, date, text) from public, anon;
grant execute on function finance.generate_period_report(date, date, text) to authenticated, service_role;

comment on function finance.generate_period_report(date, date, text) is
  'Q-D2 + R3-2: stores a dated snapshot of a reporting period (half-open, calendar days UTC): issued invoices, expenses, verified payments received and the profit-and-loss figures (revenue, expenses, net) per currency, computed here from the ledger, never supplied by the caller. Owner, ops admin or finance. Audits finance.period_report_generated.';

notify pgrst, 'reload schema';
