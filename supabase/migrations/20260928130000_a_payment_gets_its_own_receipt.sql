-- Phase 4 Finance Agent spec §14: a Receipt entity — "a unique auditable
-- receipt number, referencing payment/invoice/amount/method/date, generated
-- only after Admin-verified payment." Until now the closest analog was the
-- `payment.verified` audit-log entry and the `invoice.paid` event — real, but
-- neither is the dedicated, numbered document the spec names, and neither
-- survives a query scoped to "receipts for this client."
--
-- Generated inside `finance.verify_payment` itself, in the same transaction
-- and under the same invoice row lock that confirmation already takes — a
-- receipt for money that was not actually confirmed in this exact call would
-- be a document about something that did not happen. One receipt per
-- verified PAYMENT, not per invoice: a partially-paid invoice's first
-- confirmed installment gets its own receipt the moment it is confirmed, not
-- only when the invoice finally reaches `paid`.

create table if not exists finance.receipts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  invoice_id       uuid not null references finance.invoices(id) on delete restrict,

  -- One receipt per payment, ever — verify_payment's own idempotent-write
  -- guard (verified_at set only once) means this door is reached at most once
  -- per payment id in the first place, but the unique constraint is the real
  -- guarantee, not the caller's discipline.
  payment_id       uuid not null unique references finance.payments(id) on delete restrict,

  number           text not null,
  amount_minor     bigint not null check (amount_minor > 0),
  currency         char(3) not null,

  issued_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  constraint receipts_number_key unique (organization_id, number)
);

comment on table finance.receipts is
  'Finance Agent spec §14. One row per verified payment, generated only by finance.verify_payment under the invoice row lock it already holds. Never generated for a claim that was only recorded (finance.payment_submissions) or a payment only captured (finance.payments with verified_at still null) — verifying is not paying, and a receipt is evidence that a person confirmed money actually arrived (ADM-04, G-007), not that a claim was made.';

alter table finance.receipts enable row level security;
alter table finance.receipts force row level security;

-- Internal-only for now, same posture finance.payments/invoices started
-- with — a client-facing receipt view is real, separate frontend work.
drop policy if exists receipts_select on finance.receipts;
create policy receipts_select on finance.receipts
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- finance.verify_payment is SECURITY INVOKER — it runs as whichever
-- authenticated internal user called it, so the receipt it inserts under the
-- invoice lock needs a policy of its own, or the insert silently touches zero
-- rows regardless of what the function decided.
drop policy if exists receipts_insert on finance.receipts;
create policy receipts_insert on finance.receipts
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select, insert on finance.receipts to authenticated;
grant select, insert on finance.receipts to service_role;

-- A six-character code over an alphabet with the characters people misread on
-- a phone removed — the exact shape approvals.new_reference() already uses
-- for approval_requests.reference, kept local to this schema rather than
-- reaching across schemas for a one-line function.
create or replace function finance.new_receipt_reference()
returns text
language sql
volatile
security invoker
set search_path = ''
as $$
  select 'RCPT-' || string_agg(
    substr('ABCDEFGHJKMNPQRSTVWXYZ23456789', 1 + floor(random() * 29)::int, 1),
    ''
  )
  from generate_series(1, 6);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- finance.verify_payment gains receipt generation — carried forward from its
-- true live definition (20260815290000_an_invoice_moves_only_through_its_
-- engine.sql — NOT 20260815180000, an earlier definition the sanctioned-write
-- capability line was later added on top of), with ONE further addition,
-- marked below.
-- Everything else is the live text, not a regeneration.
-- ═══════════════════════════════════════════════════════════════════════════

-- Postgres refuses `create or replace` when the OUT parameter shape changes
-- (adding receipt_id/receipt_number here) — drop first, matching Postgres's
-- own requirement, not a stylistic choice.
drop function if exists finance.verify_payment(uuid, uuid);

create or replace function finance.verify_payment(
  p_payment_id  uuid,
  p_verified_by uuid
)
returns table (
  -- 'verified' | 'not_found' | 'already_verified' | 'not_captured'
  outcome               text,
  invoice_id            uuid,
  -- Confirmed money after this verification, computed under the lock.
  verified_after_minor  bigint,
  status_after          text,
  -- The milestone this verification opened, derived and published inside this
  -- transaction. Null unless the invoice became covered.
  unlocked_milestone_id uuid,
  -- [Finance Agent spec §14 addition] The receipt this verification just
  -- created — null on every branch but the one that actually confirms money
  -- for the first time.
  receipt_id            uuid,
  receipt_number        text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_invoice   uuid;
  v_org       uuid;
  v_status    text;
  v_total     bigint;
  v_currency  char(3);
  v_number    text;
  v_client    uuid;
  v_project   uuid;
  v_milestone uuid;
  v_pay_status text;
  v_verified  timestamptz;
  v_amount    bigint;
  v_before    bigint;
  v_after     bigint;
  v_new       text;
  v_unlocked  uuid;
  v_rows      int;
  v_receipt_id     uuid;
  v_receipt_number text;
  v_attempt        int;
begin
  -- Declare the sanctioned-write capability finance.payments_update_is_
  -- sanctioned() and finance.invoices_write_is_sanctioned() check
  -- (20260815290000/300000). Transaction-scoped; a direct Data-API write
  -- cannot set it. MISSING FROM THIS MIGRATION'S FIRST DRAFT — caught by
  -- verifying against a real scratch Postgres before this ever reached
  -- production: the true live verify_payment (20260815290000, not
  -- 20260815180000 — a later migration silently carried it forward with an
  -- UPPERCASE `CREATE OR REPLACE` that an earlier lowercase-only grep missed)
  -- already had this line, and dropping it would have broken every
  -- authenticated (non-service-role) payment verification in production.
  perform set_config('finance.sanctioned_write', 'on', true);

  -- ── 1. the payment, and the invoice it belongs to ───────────────────────
  select p.invoice_id, p.status, p.verified_at, p.amount_minor
    into v_invoice, v_pay_status, v_verified, v_amount
    from finance.payments p
   where p.id = p_payment_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- ── 2. the lock, and the invoice read through it ────────────────────────
  select i.organization_id, i.status, i.total_minor, i.currency,
         i.number, i.client_account_id, i.project_id, i.milestone_id
    into v_org, v_status, v_total, v_currency, v_number, v_client, v_project, v_milestone
    from finance.invoices i
   where i.id = v_invoice
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- ── 3. the refusals, restated under the lock ────────────────────────────
  --
  -- Confirming a payment twice is the answer, not an error — two people
  -- reading the same bank statement should not fight. This is the fast path
  -- for a payment already verified when we first read it; the race-safe guard
  -- is the conditional write in step 4, because THIS read was taken before the
  -- lock and a concurrent confirmation could have landed since.
  if v_verified is not null then
    select r.id, r.number into v_receipt_id, v_receipt_number
      from finance.receipts r where r.payment_id = p_payment_id;
    return query select 'already_verified'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid,
                        v_receipt_id, v_receipt_number;
    return;
  end if;

  -- Money that failed or was never captured is not money to confirm.
  if v_pay_status <> 'captured' then
    return query select 'not_captured'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid,
                        null::uuid, null::text;
    return;
  end if;

  -- ── 4. the confirmation, idempotent under the lock ──────────────────────
  --
  -- The write is the guard. `verified_at` is set only WHERE it is still null,
  -- so a payment a concurrent caller confirmed between step 1's pre-lock read
  -- and this line updates zero rows — and that zero IS the already-verified
  -- answer, written once, with no second history entry and no second unlock.
  v_before := finance.net_verified_minor(v_invoice);

  update finance.payments
     set verified_at = now(),
         verified_by = p_verified_by,
         updated_at  = now()
   where id = p_payment_id
     and verified_at is null;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    select r.id, r.number into v_receipt_id, v_receipt_number
      from finance.receipts r where r.payment_id = p_payment_id;
    return query select 'already_verified'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid,
                        v_receipt_id, v_receipt_number;
    return;
  end if;

  -- A full re-sum over the verified rows, NOT `v_before + v_amount`. The delta
  -- double-counts a payment a concurrent confirmation already folded into
  -- net_verified_minor; the sum counts each verified payment exactly once.
  -- Floored at zero, and not as a convenience: the refund ceiling is checked
  -- against *received* money (net_received_minor), so refunding more than has
  -- been confirmed is legitimate and makes net_verified_minor negative. A
  -- negative cache would trip invoices_verified_not_over_paid mid-write; zero
  -- is the honest floor, and the refund ledger keeps the arithmetic.
  v_after := greatest(finance.net_verified_minor(v_invoice), 0);

  v_new := case
             when v_after >= v_total then 'paid'
             else v_status
           end;

  update finance.invoices
     set verified_minor = v_after,
         status         = v_new,
         paid_at        = case when v_new = 'paid' then coalesce(paid_at, now()) else paid_at end
   where id = v_invoice;

  -- [Finance Agent spec §14 addition] The receipt, under the same lock,
  -- retrying on a reference collision the same way approvals.request_approval
  -- already retries its own reference — this table's own unique constraint is
  -- the actual guarantee, this loop is just not failing the whole
  -- verification over a one-in-a-billion collision.
  for v_attempt in 1..5 loop
    v_receipt_number := finance.new_receipt_reference();
    begin
      insert into finance.receipts (organization_id, invoice_id, payment_id, number, amount_minor, currency)
      values (v_org, v_invoice, p_payment_id, v_receipt_number, v_amount, v_currency)
      returning id into v_receipt_id;
      exit;
    exception
      when unique_violation then
        v_receipt_id := null;
        continue;
    end;
  end loop;

  -- ── 5. the history, in the same transaction (G-079) ─────────────────────
  perform core.record_audit(
    v_org, 'payment.verified', 'invoice', v_invoice,
    jsonb_build_object('verifiedMinor', v_before, 'status', v_status),
    jsonb_build_object(
      'verifiedMinor', v_after,
      'status',        v_new,
      'amountMinor',   v_amount,
      'paymentId',     p_payment_id,
      'verifiedBy',    p_verified_by,
      'receiptId',     v_receipt_id,
      'receiptNumber', v_receipt_number
    )
  );

  -- ── 6. and the event that opens the next milestone (D17) ────────────────
  --
  -- Below the write, because next_unlocked_milestone answers "the first priced
  -- milestone with no paid invoice" — which is the milestone being paid for
  -- right now until the UPDATE above is visible.
  if v_new = 'paid' then
    if v_project is not null then
      v_unlocked := finance.next_unlocked_milestone(v_project, v_org);
    end if;

    perform core.emit_event(
      v_org, 'invoice.paid', 'invoice', v_invoice,
      jsonb_build_object(
        'number',              v_number,
        'clientAccountId',     v_client,
        'projectId',           v_project,
        'milestoneId',         v_milestone,
        'unlockedMilestoneId', v_unlocked,
        'paidMinor',           v_after,
        'currency',            v_currency
      )
    );
  end if;

  return query select 'verified'::text, v_invoice, v_after, v_new, v_unlocked, v_receipt_id, v_receipt_number;
end;
$$;

comment on function finance.verify_payment(uuid, uuid) is
  'Confirms that recorded money actually arrived (ADM-04, G-007). This is where an invoice becomes paid and where invoice.paid - the event that opens the next milestone - is published, so delivery advances on somebody having checked a bank statement rather than on a client saying they paid. Decides under the invoice row lock. Verifying twice is answered, not raised, and writes no second history: the confirming write is conditional on verified_at still being null, so a concurrent double-confirmation of the same payment cannot double-count it, and the confirmed total is a full re-sum rather than a delta. Finance Agent spec §14: generates the payment''s receipt in the same transaction, once, under the same lock. SECURITY INVOKER: finance RLS still decides who may touch the invoice.';

revoke all on function finance.verify_payment(uuid, uuid) from public, anon;
grant execute on function finance.verify_payment(uuid, uuid) to authenticated, service_role;

revoke all on function finance.new_receipt_reference() from public, anon;
grant execute on function finance.new_receipt_reference() to service_role;
