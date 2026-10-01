-- "Generate period report" stores a dated snapshot (round 3, owner decision
-- Q-D2 of 2026-10-01: "'Generate period report' stores a dated snapshot that
-- 'Export history' lists", and the lock may refer to it).
--
-- THE SNAPSHOT. `finance.period_reports` holds one row per press of the
-- button: the period (half-open, the shape tax_period_locks and the tax page
-- use), a label, who generated it and when, and the FIGURES as they stood at
-- that moment, per currency: the issued invoices (not draft, not void) dated
-- inside the period with their taxable value, tax, total and money verified
-- against them, split GST / non-GST / unconfirmed by the project's active
-- billing profile, and the expenses incurred in the period.
--
-- The door computes those figures ITSELF, from the invoice and expense rows
-- under the caller's tenant. The caller supplies only the period and a label,
-- so a snapshot cannot carry a number the ledger did not hold. Append-only:
-- a later report of the same period is a new row with a later date, and the
-- history shows both.
--
-- THE LOCK MAY REFER TO IT. `finance.tax_period_locks.period_report_id` names
-- the snapshot a filed return was made from. `finance.lock_tax_period` gains an
-- optional fourth argument for it (the three-argument callers are unchanged)
-- and refuses a report that is not of exactly that period.
--
-- Written only by the doors; read by owner, ops admin and finance (the roles
-- that read the export history). Audited: finance.period_report_generated.
--
-- Additive and idempotent.

create table if not exists finance.period_reports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  period_start    date not null,
  period_end      date not null,
  period_label    text not null check (length(btrim(period_label)) between 1 and 120),
  invoice_count   integer not null default 0 check (invoice_count >= 0),
  snapshot        jsonb not null default '[]'::jsonb,
  generated_by    uuid references core.users(id) on delete set null,
  generated_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  constraint period_reports_period_is_a_period check (period_end > period_start),
  constraint period_reports_snapshot_is_a_list check (jsonb_typeof(snapshot) = 'array')
);

create index if not exists period_reports_org_idx on finance.period_reports (organization_id, generated_at desc);
create index if not exists period_reports_period_idx on finance.period_reports (organization_id, period_start, period_end, generated_at desc);

alter table finance.period_reports enable row level security;
alter table finance.period_reports force row level security;

drop policy if exists period_reports_select on finance.period_reports;
create policy period_reports_select on finance.period_reports
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and ((select core.is_admin()) or (select core.is_finance()))
  );

revoke all on finance.period_reports from public, anon;
revoke insert, update, delete on finance.period_reports from authenticated;
grant select on finance.period_reports to authenticated;
grant select, insert, update, delete on finance.period_reports to service_role;

drop trigger if exists freeze_org_period_reports on finance.period_reports;
create trigger freeze_org_period_reports
  before update of organization_id on finance.period_reports
  for each row execute function core.freeze_organization_id();

comment on table finance.period_reports is
  'Q-D2: one dated snapshot of a GST reporting period, taken when somebody pressed Generate period report: the issued invoices and expenses of the period as the ledger held them, per currency. Append-only; written only by finance.generate_period_report; a period lock may refer to one.';

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
  ), cur as (
    select currency from inv group by currency
    union
    select currency from exp
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
               'amount_minor', coalesce((select amount_minor from exp where exp.currency = c.currency), 0))
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
  'Q-D2: stores a dated snapshot of a reporting period (half-open, calendar days UTC): issued invoices and expenses per currency, computed here from the ledger, never supplied by the caller. Owner, ops admin or finance. Audits finance.period_report_generated.';

-- ── a lock may refer to the report it was filed from ─────────────────────

alter table finance.tax_period_locks add column if not exists period_report_id uuid references finance.period_reports(id) on delete set null;

drop trigger if exists org_match_tax_period_locks_report on finance.tax_period_locks;
create trigger org_match_tax_period_locks_report
  before insert or update of period_report_id, organization_id on finance.tax_period_locks
  for each row execute function core.enforce_parent_org('period_report_id', 'finance.period_reports');

comment on column finance.tax_period_locks.period_report_id is
  'Q-D2: the dated report snapshot the filed return was made from, when the person who locked the period named one. It must be of exactly this period.';

-- The three-argument door becomes the four-argument one; the old signature is
-- dropped so a call by name resolves to one function.
drop function if exists finance.lock_tax_period(date, date, text);

create or replace function finance.lock_tax_period(
  p_period_start date,
  p_period_end   date,
  p_note         text default null,
  p_report_id    uuid default null
)
returns table (outcome text, lock_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_id    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid;
    return;
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    return query select 'not_a_period'::text, null::uuid;
    return;
  end if;
  -- The report a lock refers to is of exactly this period, in this tenant.
  if p_report_id is not null and not exists (
       select 1 from finance.period_reports r
        where r.id = p_report_id and r.organization_id = v_org
          and r.period_start = p_period_start and r.period_end = p_period_end) then
    return query select 'report_mismatch'::text, null::uuid;
    return;
  end if;

  select id into v_id
    from finance.tax_period_locks
   where organization_id = v_org
     and period_start = p_period_start
     and period_end = p_period_end
     and unlocked_at is null;
  if v_id is not null then
    return query select 'already_locked'::text, v_id;
    return;
  end if;

  insert into finance.tax_period_locks (organization_id, period_start, period_end, locked_by, note, period_report_id)
  values (v_org, p_period_start, p_period_end, v_actor, nullif(btrim(p_note), ''), p_report_id)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'tax_period.locked', 'tax_period_lock', v_id, null,
    jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end, 'note', nullif(btrim(p_note), ''), 'period_report_id', p_report_id)
  );

  return query select 'locked'::text, v_id;
exception
  when unique_violation then
    -- Two people locked the same period at once; the first one's lock is the answer.
    select id into v_id
      from finance.tax_period_locks
     where organization_id = v_org and period_start = p_period_start and period_end = p_period_end and unlocked_at is null;
    return query select 'already_locked'::text, v_id;
end;
$$;

comment on function finance.lock_tax_period(date, date, text, uuid) is
  'SCR-056: locks a half-open reporting period after its return is filed. Owner/ops_admin via tax_period_locks_write; optionally names the dated report snapshot (Q-D2) the return was made from, which must be of exactly this period. Audits tax_period.locked in the same transaction.';

revoke all on function finance.lock_tax_period(date, date, text, uuid) from public, anon;
grant execute on function finance.lock_tax_period(date, date, text, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
