-- ═══════════════════════════════════════════════════════════════════════════
-- Money going back.
--
-- Gap G-005. `refund.issue` has been in the capability matrix since the first
-- day, resolving to owner and nothing else, and no code has ever used it. A
-- refund happened in a bank app and left no trace here, so the ledger has
-- always described money that arrived and never money that left.
--
-- ── three rules, none of them invented here ───────────────────────────────
--
-- **A refund needs an approval.** Directive §28 puts refunds in RED and §29
-- gives the Admin the decision. The engine already carries `refund` as a
-- subject type, and `approval_policies_money_floor` already refuses any refund
-- policy that names anybody below owner. `record_refund` will not write
-- without an approved request behind it, so the gate is structural rather than
-- a convention somebody follows.
--
-- **It cannot exceed what came in.** The D1 rule, one direction along:
-- computed under the invoice's lock, and refused rather than clamped. Two
-- concurrent refunds that each fit but together do not is exactly the race
-- that cost this repository its first finding.
--
-- **The invoice does not move.** `finance/schema.ts` has said since the first
-- day that "paid is terminal — money that came back is a refund, not a status
-- flip", so a refund is its own row and the invoice it refers to is untouched.
-- Net received is payments minus refunds, which is what a ledger is.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance.refunds (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  invoice_id          uuid not null references finance.invoices(id) on delete restrict,

  amount_minor        bigint not null check (amount_minor > 0),

  -- Required. A refund with no stated reason is an unexplained withdrawal from
  -- the business, and the person asking why will be asking months later.
  reason              text not null check (length(trim(reason)) > 0),

  status              text not null default 'requested' check (status in
                        ('requested', 'recorded', 'refused')),

  -- The approval that must exist, and must be approved, before any money is
  -- recorded as having left.
  approval_request_id uuid references approvals.approval_requests(id) on delete set null,

  -- How the money actually went back, and the idempotency key for it: the same
  -- shape finance.payments uses for money arriving.
  provider            text not null default 'manual',
  provider_refund_id  text,

  requested_by        uuid references core.users(id) on delete set null,
  recorded_by         uuid references core.users(id) on delete set null,
  recorded_at         timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Recorded means the money left, at a time, with a reference to find it by.
  constraint refunds_recorded_shape check (
    status <> 'recorded'
    or (recorded_at is not null and provider_refund_id is not null)
  )
);

comment on table finance.refunds is
  'Money going back to a client. Its own row rather than a change to the invoice, because finance/schema.ts has said since the first day that paid is terminal and money returned is a refund, not a status flip. Cannot be recorded without an approved approval behind it, and cannot exceed what came in.';

create unique index if not exists refunds_provider_key
  on finance.refunds (provider, provider_refund_id)
  where provider_refund_id is not null;

create index if not exists refunds_invoice_idx on finance.refunds (invoice_id, status);

drop trigger if exists set_updated_at on finance.refunds;
create trigger set_updated_at
  before update on finance.refunds
  for each row execute function core.set_updated_at();

alter table finance.refunds enable row level security;

-- Reading is the money tier: owner and ops_admin, the same set invoices admit.
drop policy if exists refunds_select on finance.refunds;
create policy refunds_select on finance.refunds
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  );

-- No write policy. Both paths are functions that check the approval
-- themselves — a direct write could record money as returned with no approval
-- behind it, which is the one thing this table exists to prevent.

/**
 * What has actually come in, net of what has gone back.
 *
 * Captured payments minus recorded refunds. The number a second refund must
 * fit inside.
 */
create or replace function finance.net_received_minor(p_invoice_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce((select sum(p.amount_minor) from finance.payments p
               where p.invoice_id = p_invoice_id and p.status = 'captured'), 0)
    - coalesce((select sum(r.amount_minor) from finance.refunds r
                 where r.invoice_id = p_invoice_id and r.status = 'recorded'), 0);
$$;

comment on function finance.net_received_minor(uuid) is
  'Captured payments minus recorded refunds: what the business is actually holding for this invoice, and the ceiling any further refund must fit inside.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Asking
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.request_refund(
  p_invoice_id   uuid,
  p_amount_minor bigint,
  p_reason       text,
  p_requested_by uuid default null
)
returns table (
  -- 'requested' | 'not_found' | 'non_positive' | 'exceeds_received' | 'no_policy'
  outcome      text,
  refund_id    uuid,
  request_id   uuid,
  net_received bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_invoice  finance.invoices;
  v_net      bigint;
  v_approval record;
  v_row      finance.refunds;
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    return query select 'non_positive'::text, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- The lock is taken here and held for the ceiling check, so two refunds
  -- requested at the same moment cannot both measure against the same balance.
  select i.* into v_invoice
    from finance.invoices i
   where i.id = p_invoice_id
   for update;

  if v_invoice.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  v_net := finance.net_received_minor(p_invoice_id)
    -- Requests that are not yet recorded still count against the ceiling.
    -- Otherwise three people each request the full amount, all three are
    -- approved, and the ceiling is only discovered on the third recording —
    -- after two owners have already said yes to money that is not there.
    - coalesce((select sum(r.amount_minor) from finance.refunds r
                 where r.invoice_id = p_invoice_id and r.status = 'requested'), 0);

  if p_amount_minor > v_net then
    -- Refused, never clamped. D1's rule: a caller asking for more than exists
    -- is told so, not quietly given less.
    return query select 'exceeds_received'::text, null::uuid, null::uuid, v_net;
    return;
  end if;

  select * into v_approval
    from approvals.request_approval(
      v_invoice.organization_id, 'refund', p_invoice_id,
      case when p_requested_by is null then 'system' else 'user' end,
      p_requested_by,
      'Refund of ' || p_amount_minor || ' minor units on ' || v_invoice.number || ' — ' || p_reason,
      jsonb_build_object('invoice', v_invoice.number, 'amount_minor', p_amount_minor, 'reason', p_reason),
      p_amount_minor,
      'internal',
      null
    );

  if v_approval.outcome = 'no_policy' then
    -- No policy means nobody is named to approve it, and the money floor means
    -- that policy can only ever name the owner. Refused rather than left
    -- pending against nobody.
    return query select 'no_policy'::text, null::uuid, null::uuid, v_net;
    return;
  end if;

  insert into finance.refunds (
    organization_id, invoice_id, amount_minor, reason, approval_request_id, requested_by
  )
  values (
    v_invoice.organization_id, p_invoice_id, p_amount_minor, p_reason,
    v_approval.request_id, p_requested_by
  )
  returning * into v_row;

  perform core.record_audit(
    v_invoice.organization_id, 'refund.requested', 'refund', v_row.id, null,
    jsonb_build_object('invoice_id', p_invoice_id, 'amount_minor', p_amount_minor,
                       'approval_request_id', v_approval.request_id)
  );

  return query select 'requested'::text, v_row.id, v_approval.request_id, v_net;
end;
$$;

comment on function finance.request_refund(uuid, bigint, text, uuid) is
  'Asks for a refund: refuses more than has actually come in — counting requests already waiting, so three approvals cannot be given for money that exists once — and raises the approval the directive requires. Nothing has left the business at this point.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Recording that it left
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.record_refund(
  p_refund_id          uuid,
  p_provider_refund_id text,
  p_recorded_by        uuid default null
)
returns table (
  -- 'recorded' | 'not_found' | 'not_approved' | 'already_recorded'
  -- | 'exceeds_received' | 'duplicate'
  outcome      text,
  refund_id    uuid,
  net_received bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row   finance.refunds;
  v_state text;
  v_net   bigint;
begin
  select r.* into v_row from finance.refunds r where r.id = p_refund_id for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::bigint;
    return;
  end if;

  if v_row.status = 'recorded' then
    return query select 'already_recorded'::text, v_row.id, null::bigint;
    return;
  end if;

  -- The gate. Not a convention: without an approved request behind it, no
  -- amount of calling this function moves anything.
  select a.state into v_state
    from approvals.approval_requests a
   where a.id = v_row.approval_request_id;

  if v_state is distinct from 'approved' then
    return query select 'not_approved'::text, v_row.id, null::bigint;
    return;
  end if;

  -- Re-checked here as well as at request time, and under the invoice's lock:
  -- a refund approved yesterday must still fit today, because another refund
  -- may have been recorded in between.
  perform 1 from finance.invoices i where i.id = v_row.invoice_id for update;
  v_net := finance.net_received_minor(v_row.invoice_id);

  if v_row.amount_minor > v_net then
    return query select 'exceeds_received'::text, v_row.id, v_net;
    return;
  end if;

  begin
    update finance.refunds
       set status = 'recorded',
           provider_refund_id = p_provider_refund_id,
           recorded_by = p_recorded_by,
           recorded_at = now()
     where finance.refunds.id = v_row.id
       and finance.refunds.status = 'requested';
  exception
    when unique_violation then
      -- refunds_provider_key. The same bank reference twice is one refund
      -- being recorded twice, which is the retry case rather than an error.
      return query select 'duplicate'::text, v_row.id, v_net;
      return;
  end;

  perform core.record_audit(
    v_row.organization_id, 'refund.recorded', 'refund', v_row.id,
    to_jsonb(v_row),
    jsonb_build_object('status', 'recorded', 'provider_refund_id', p_provider_refund_id,
                       'net_received_after', v_net - v_row.amount_minor)
  );

  return query select 'recorded'::text, v_row.id, v_net - v_row.amount_minor;
end;
$$;

comment on function finance.record_refund(uuid, text, uuid) is
  'Records that money left. Refuses without an approved approval behind it, re-checks the ceiling under the invoice lock because an approval from yesterday must still fit today, and treats the same bank reference twice as one refund rather than two. The invoice is deliberately untouched: paid is terminal.';

revoke all on function finance.net_received_minor(uuid) from public;
revoke all on function finance.request_refund(uuid, bigint, text, uuid) from public;
revoke all on function finance.record_refund(uuid, text, uuid) from public;

grant execute on function finance.net_received_minor(uuid) to authenticated, service_role;
grant execute on function finance.request_refund(uuid, bigint, text, uuid) to authenticated, service_role;
grant execute on function finance.record_refund(uuid, text, uuid) to authenticated, service_role;
grant select on finance.refunds to authenticated;
grant select, insert, update on finance.refunds to service_role;
