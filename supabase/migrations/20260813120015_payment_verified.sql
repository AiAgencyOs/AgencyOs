-- G-007 and G-006 — received is not verified.
--
-- ADM-04, in the Admin's words: a client saying "I paid" is a claim. Somebody
-- records it; the **owner or an ops admin confirms it against the bank**, and
-- only then is it money. Only verified money unlocks the next milestone.
--
-- Until now recording a payment did all of it in one step: the ledger row, the
-- invoice total, the status, and — when the total was covered — `invoice.paid`,
-- which opens the next milestone. So a client's claim, typed in by whoever was
-- reading WhatsApp, moved delivery forward on its own.
--
-- ── what changes, precisely ───────────────────────────────────────────────
--
-- Two numbers on the invoice instead of one:
--
--   `paid_minor`      what has been **recorded**. Unchanged in meaning, so
--                     every constraint and every reader that depends on it —
--                     `invoices_paid_not_over_total`, the overpayment refusal,
--                     the refund ceiling — is unchanged.
--   `verified_minor`  what has been **confirmed**. New, and always a subset.
--
-- `status = 'paid'` and the `invoice.paid` event now follow `verified_minor`.
-- Recording a payment can no longer produce either. That is the whole finding:
-- the event that unlocks delivery is now published by the act of a person who
-- looked at a bank statement.
--
-- ── why the ceiling still counts recorded money ───────────────────────────
--
-- The overpayment refusal compares against `paid_minor`, not `verified_minor`,
-- and deliberately: otherwise ten unverified receipts could be recorded
-- against one invoice because none of them counted yet. What may not exceed
-- the invoice is what has been *claimed*, and verification only decides what
-- has been *believed*.

-- ── 1. a payment can be confirmed ─────────────────────────────────────────

alter table finance.payments
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references core.users(id) on delete set null;

comment on column finance.payments.verified_at is
  'When somebody confirmed this money actually arrived (ADM-04). Null means recorded but not confirmed - a claim, not a fact.';

comment on column finance.payments.verified_by is
  'Who confirmed it. Owner or ops admin, per ADM-04. Null while unverified.';

-- A verification names somebody. A row that says money was confirmed but not
-- by whom is the small lie audit.audit_log exists to prevent.
alter table finance.payments drop constraint if exists payments_verified_together;
alter table finance.payments add constraint payments_verified_together
  check ((verified_at is null) = (verified_by is null));

create index if not exists payments_unverified_idx
  on finance.payments (organization_id, invoice_id)
  where verified_at is null and status = 'captured';

comment on index finance.payments_unverified_idx is
  'Money recorded and not yet confirmed - the queue somebody works through against a bank statement.';

-- ── 2. and the invoice carries both numbers ───────────────────────────────

alter table finance.invoices
  add column if not exists verified_minor bigint not null default 0 check (verified_minor >= 0);

comment on column finance.invoices.verified_minor is
  'Confirmed money (ADM-04). Always a subset of paid_minor, which is what has been recorded. status = paid and the invoice.paid event follow this number, not paid_minor.';

alter table finance.invoices drop constraint if exists invoices_verified_not_over_paid;
alter table finance.invoices add constraint invoices_verified_not_over_paid
  check (verified_minor <= paid_minor);

-- Everything recorded before this migration was recorded under the old rule,
-- where recording *was* confirming. Rewriting that history as unverified would
-- claim a distinction nobody was offered at the time; treating it as verified
-- keeps every existing invoice saying what it said yesterday.
update finance.invoices set verified_minor = paid_minor where paid_minor > 0;

update finance.payments
   set verified_at = coalesce(captured_at, created_at),
       verified_by = null
 where status = 'captured' and verified_at is null;

-- The backfill above writes verified_at with no verified_by, which the
-- constraint added later would refuse. It is added after, and the historical
-- rows are exempted by naming what they are: confirmed under the old rule, by
-- nobody in particular, because nobody was asked.
alter table finance.payments drop constraint if exists payments_verified_together;
alter table finance.payments add constraint payments_verified_together
  check (verified_at is null or verified_by is not null or created_at < '2026-08-14');

comment on constraint payments_verified_together on finance.payments is
  'A verification names somebody. Rows created before 2026-08-14 are exempt: they were recorded when recording was confirming, and inventing a verifier for them would be a worse lie than the hole.';

-- ── 3. what has actually been confirmed ───────────────────────────────────

create or replace function finance.net_verified_minor(p_invoice_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce((select sum(p.amount_minor) from finance.payments p
               where p.invoice_id = p_invoice_id
                 and p.status = 'captured'
                 and p.verified_at is not null), 0)
    - coalesce((select sum(r.amount_minor) from finance.refunds r
                 where r.invoice_id = p_invoice_id and r.status = 'recorded'), 0);
$$;

comment on function finance.net_verified_minor(uuid) is
  'Confirmed money less refunds (ADM-04). The sibling of net_received_minor, which counts everything recorded. This is the number that decides whether an invoice is paid and whether the next milestone opens.';

revoke all on function finance.net_verified_minor(uuid) from public, anon;
grant execute on function finance.net_verified_minor(uuid) to authenticated, service_role;

-- ── 4. recording money is not confirming it ───────────────────────────────
--
-- The function D1, D4, D8, G-008, G-079 and D17 all landed in, carried forward
-- **from its own latest definition** rather than regenerated from an earlier
-- one — which is precisely how regenerating `replace_payment_plan` silently
-- reverted D16 during G-079's verification. Everything below except the three
-- marked edits is byte-identical to 20260812120010.

create or replace function finance.record_manual_payment(
  p_invoice_id          uuid,
  p_provider_payment_id text,
  p_amount_minor        bigint,
  p_captured_at         timestamptz,
  -- The one field the audit row needs that this function cannot derive: how
  -- the money arrived. Required rather than defaulted, so a caller that omits
  -- it fails to type-check rather than writing a history with a hole in it.
  p_method              text
)
returns table (
  -- 'recorded' | 'not_found' | 'not_payable' | 'non_positive' | 'overpayment'
  -- | 'duplicate'. Unchanged from D1; the caller's wording is unchanged too.
  outcome               text,
  payment_id            uuid,
  -- The captured sum *before* this payment, read under the lock.
  captured_before_minor bigint,
  -- The invoice's status before this payment, read under the same lock.
  invoice_status        text,
  -- What the invoice now holds, written in this same statement. The caller
  -- reports these rather than reading them back, because a second read could
  -- only be taken after the lock was released — which is the defect.
  paid_after_minor      bigint,
  status_after          text,
  -- The milestone the invoice.paid event named, derived and published inside
  -- this transaction. Returned so the caller can answer with it rather than
  -- computing a second, later answer of its own.
  unlocked_milestone_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org       uuid;
  v_status    text;
  v_total     bigint;
  v_currency  char(3);
  v_number    text;
  v_client    uuid;
  v_project   uuid;
  v_milestone uuid;
  v_captured  bigint;
  v_payment   uuid;
  v_after     bigint;
  v_new       text;
  v_unlocked  uuid;
begin
  -- ── 1. take the lock, and read the invoice through it ────────────────────
  select i.organization_id, i.status, i.total_minor, i.currency,
         i.number, i.client_account_id, i.project_id, i.milestone_id
    into v_org, v_status, v_total, v_currency,
         v_number, v_client, v_project, v_milestone
    from finance.invoices i
   where i.id = p_invoice_id
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text,
                        null::bigint, null::text, null::uuid;
    return;
  end if;

  -- ── 2. the same refusals the application already made ────────────────────
  --
  -- The statuses are finance/schema.ts PAYABLE_INVOICE_STATUSES.
  if v_status not in ('issued', 'partially_paid', 'overdue') then
    return query select 'not_payable'::text, null::uuid, null::bigint, v_status,
                        null::bigint, null::text, null::uuid;
    return;
  end if;

  if p_amount_minor is null or p_amount_minor <= 0 then
    return query select 'non_positive'::text, null::uuid, null::bigint, v_status,
                        null::bigint, null::text, null::uuid;
    return;
  end if;

  -- ── 3. the ledger, read inside the lock ──────────────────────────────────
  select coalesce(sum(p.amount_minor), 0)
    into v_captured
    from finance.payments p
   where p.invoice_id = p_invoice_id
     and p.status = 'captured';

  if v_captured + p_amount_minor > v_total then
    return query select 'overpayment'::text, null::uuid, v_captured, v_status,
                        null::bigint, null::text, null::uuid;
    return;
  end if;

  -- ── 4. the write ─────────────────────────────────────────────────────────
  begin
    insert into finance.payments (
      organization_id, invoice_id, provider, provider_payment_id,
      amount_minor, currency, status, captured_at
    )
    values (
      v_org, p_invoice_id, 'manual', p_provider_payment_id,
      p_amount_minor, v_currency, 'captured', p_captured_at
    )
    returning id into v_payment;
  exception
    when unique_violation then
      return query select 'duplicate'::text, null::uuid, v_captured, v_status,
                          null::bigint, null::text, null::uuid;
      return;
  end;

  -- ── 5. and the total it changes, in the same breath ──────────────────────
  --
  -- Derived from the sum that was read under this lock plus the amount just
  -- inserted, rather than by re-reading: the row is locked, so nothing can
  -- have changed it, and re-reading would only invite the question of what to
  -- do if the second read disagreed with the first.
  v_after := v_captured + p_amount_minor;

  -- G-007: 'paid' is gone from this branch. Recording money is a claim being
  -- written down; an invoice becomes paid when somebody confirms the money
  -- arrived, which is finance.verify_payment. An invoice covered by recorded
  -- but unconfirmed receipts sits at partially_paid, which is exactly what it
  -- is.
  v_new := case
             when v_after > 0 then 'partially_paid'
             else v_status
           end;

  -- paid_at is not written here any more, for the same reason: it is the
  -- moment the invoice was settled, and recording a claim does not settle one.
  update finance.invoices
     set paid_minor = v_after,
         status     = v_new
   where id = p_invoice_id;

  -- ── 6. the audit row, in the same transaction as the money (G-079) ───────
  --
  -- `before` is the sum read under the lock, not the total a caller read a
  -- request earlier — under a concurrent receipt those are different numbers,
  -- and only one of them is what this payment was actually applied to.
  --
  -- `method` is the single field this function cannot derive: it is what the
  -- human says happened, so it arrives as an argument.
  perform core.record_audit(
    v_org, 'payment.recorded', 'invoice', p_invoice_id,
    jsonb_build_object('paidMinor', v_captured, 'status', v_status),
    jsonb_build_object(
      'paidMinor',   v_after,
      'status',      v_new,
      'amountMinor', p_amount_minor,
      'method',      p_method,
      'reference',   p_provider_payment_id,
      'provider',    'manual'
    )
  );

  -- ── 7. and the events, in the same transaction as all of it (D17) ────────
  --
  -- Below the write on purpose. next_unlocked_milestone answers "the first
  -- priced milestone with no paid invoice", which only becomes the milestone
  -- this payment unlocked once the UPDATE above is visible — before it, the
  -- answer is the milestone being paid for right now.
  perform core.emit_event(
    v_org, 'payment.recorded', 'invoice', p_invoice_id,
    jsonb_build_object(
      'provider',    'manual',
      'amountMinor', p_amount_minor,
      'currency',    v_currency,
      'paidMinor',   v_after,
      'totalMinor',  v_total
    )
  );

  -- The invoice.paid branch that stood here published the event that opens the
  -- next milestone. It has moved to finance.verify_payment (G-007): delivery is
  -- now advanced by somebody who looked at a bank statement, not by whoever
  -- typed in what a client said. v_unlocked stays in the result and stays null
  -- from this path, because this path no longer unlocks anything.

  return query select 'recorded'::text, v_payment, v_captured, v_status,
                      v_after, v_new, v_unlocked;
end;
$$;


-- ── 5. confirming it ──────────────────────────────────────────────────────
--
-- The other half. This is where an invoice becomes paid and where the event
-- that opens the next milestone is published — by a person who checked, which
-- is the entire point of ADM-04.
--
-- The invoice is locked first and everything is decided under that lock, for
-- the reason D1, D2, D4 and D20 all were: a status read before the lock is a
-- status another request can change before the write lands.

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
  unlocked_milestone_id uuid
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
begin
  -- ── 1. the payment, and the invoice it belongs to ───────────────────────
  select p.invoice_id, p.status, p.verified_at, p.amount_minor
    into v_invoice, v_pay_status, v_verified, v_amount
    from finance.payments p
   where p.id = p_payment_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text, null::uuid;
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
    return query select 'not_found'::text, null::uuid, null::bigint, null::text, null::uuid;
    return;
  end if;

  -- ── 3. the refusals, restated under the lock ────────────────────────────
  --
  -- Confirming a payment twice is the answer, not an error — two people
  -- reading the same bank statement should not fight — but it must not write a
  -- second history entry or publish a second unlock.
  if v_verified is not null then
    return query select 'already_verified'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid;
    return;
  end if;

  -- Money that failed or was never captured is not money to confirm.
  if v_pay_status <> 'captured' then
    return query select 'not_captured'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid;
    return;
  end if;

  -- ── 4. the confirmation ─────────────────────────────────────────────────
  v_before := finance.net_verified_minor(v_invoice);

  update finance.payments
     set verified_at = now(),
         verified_by = p_verified_by,
         updated_at  = now()
   where id = p_payment_id;

  -- Floored at zero, and not as a convenience. The refund ceiling is checked
  -- against *received* money (net_received_minor), so refunding more than has
  -- been confirmed is legitimate — and it makes net_verified_minor negative.
  -- A negative cache would trip invoices_verified_not_over_paid mid-write and
  -- raise, turning a legal refund into a broken verification. Zero is honest
  -- here: it says no confirmed money remains, and the refund ledger keeps the
  -- arithmetic that produced it.
  v_after := greatest(v_before + v_amount, 0);

  v_new := case
             when v_after >= v_total then 'paid'
             else v_status
           end;

  update finance.invoices
     set verified_minor = v_after,
         status         = v_new,
         paid_at        = case when v_new = 'paid' then coalesce(paid_at, now()) else paid_at end
   where id = v_invoice;

  -- ── 5. the history, in the same transaction (G-079) ─────────────────────
  perform core.record_audit(
    v_org, 'payment.verified', 'invoice', v_invoice,
    jsonb_build_object('verifiedMinor', v_before, 'status', v_status),
    jsonb_build_object(
      'verifiedMinor', v_after,
      'status',        v_new,
      'amountMinor',   v_amount,
      'paymentId',     p_payment_id,
      'verifiedBy',    p_verified_by
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

  return query select 'verified'::text, v_invoice, v_after, v_new, v_unlocked;
end;
$$;

comment on function finance.verify_payment(uuid, uuid) is
  'Confirms that recorded money actually arrived (ADM-04, G-007). This is where an invoice becomes paid and where invoice.paid - the event that opens the next milestone - is published, so delivery advances on somebody having checked a bank statement rather than on a client saying they paid. Decides under the invoice row lock, the shape D1, D2, D4 and D20 all were. Verifying twice is answered, not raised, and writes no second history. SECURITY INVOKER: finance RLS still decides who may touch the invoice.';

revoke all on function finance.verify_payment(uuid, uuid) from public, anon;
grant execute on function finance.verify_payment(uuid, uuid) to authenticated, service_role;
