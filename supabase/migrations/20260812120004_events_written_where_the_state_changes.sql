-- ═══════════════════════════════════════════════════════════════════════════
-- The outbox becomes the transactional outbox it is documented to be.
--
-- Audit finding D17. `core.outbox_events` has carried this comment since
-- migration 002:
--
--     'Events are written in the same transaction as the state change they
--      describe, so "state committed but event lost" cannot happen.'
--
-- It could happen, and nothing stopped it. emitEvent (src/lib/events/index.ts)
-- opens its own client and issues a standalone PostgREST INSERT *after* the
-- state change has already committed, in a separate transaction over a
-- separate connection. Its own doc comment describes the failure mode as
-- costing "an event that never fires, which is visible in the outbox and
-- replayable" — but an INSERT that failed leaves no row, so there is nothing
-- in the outbox to see and nothing to replay. The event is simply gone.
--
-- What that costs, concretely. `invoice.paid` is the only subscribed event in
-- the catalog. Losing one means the client has paid an invoice in full, the
-- payment and the invoice total are correctly written, and the milestone that
-- payment was gating never opens — with no job queued, no error surfaced, and
-- no record anywhere that something was supposed to happen. The runbook has no
-- entry for it because nothing observable indicates it occurred.
--
-- Four of the five events are emitted immediately after a Postgres function
-- that already owns a transaction and already writes its state change inside
-- it. Using that transaction costs one INSERT and closes the gap completely:
-- the event and the state change become the same commit, so neither can be
-- observed without the other.
--
-- ── Why not a reconciler ──────────────────────────────────────────────────
--
-- The alternative was to leave the emit where it is and add a sweep that finds
-- committed state with no matching event. It was rejected on three counts. It
-- needs a rule per event type saying which state implies which event, which is
-- a second definition of when each event fires. It cannot distinguish "never
-- written" from "written, dispatched and pruned". And it converts a property
-- that can simply be true into a periodic sweep with a detection window, for
-- strictly more code than the INSERT it avoids.
--
-- ── The one real cost, stated plainly ─────────────────────────────────────
--
-- `invoice.paid` carries `unlockedMilestoneId`, computed today by
-- nextUnlockedMilestone in finance/schema.ts. Writing the event inside the
-- transaction means deriving that value here — and finance/service.ts says, at
-- nextUnlockedMilestoneForProject, that a second implementation of this rule
-- would be "a second definition of when a client has paid far enough to
-- proceed — the sort of duplication that stays consistent right up until it
-- matters."
--
-- That objection is real and is accepted rather than waved away, for three
-- reasons:
--
--   1. The rule collapses to a predicate, not an algorithm. nextUnlockedMilestone
--      returns priced[paidThrough], and paidThrough is the length of the leading
--      run of paid milestones — so the answer is exactly *the first priced
--      milestone, by position, that has no paid invoice*. One ORDER BY and one
--      NOT EXISTS. tests/outbox-transactional.test.ts runs both definitions over
--      the same fixtures and asserts they agree.
--
--   2. This copy is never the arbiter. handleInvoicePaid re-derives the answer
--      through the TypeScript rule and invoicePaidVerdict compares the payload's
--      claim against it, refusing when they disagree. A drift between the two is
--      caught at handling time and fails closed; it cannot open a milestone.
--
--   3. The value cannot be computed before the payment instead. "Next" means the
--      first priced milestone with no paid invoice, so before this payment
--      commits that is the milestone being paid for now — the answer is off by
--      one until the UPDATE lands. It has to be derived after the write, which
--      inside the transaction means here.
--
-- ── What is NOT fixed by this migration ───────────────────────────────────
--
-- `invoice.created` still emits from TypeScript, because
-- generateInvoiceFromMilestone has no Postgres function behind it — it inserts
-- the invoice, inserts the items, and hand-rolls a compensating DELETE when the
-- second fails. Moving that into a function is a larger change than this
-- finding, and it is recorded as G-078 rather than quietly bundled here. The
-- event has no subscriber, so losing one loses a notification nobody reads;
-- that is a smaller loss than a stranded milestone, not no loss.
--
-- recordAudit has the same shape as emitEvent and is likewise still a separate
-- request. It is a separate finding (G-079) and not addressed here.
--
-- No schema change: no table, column, index or constraint is added, altered or
-- dropped.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The append, as one place rather than four ────────────────────────────────
--
-- SECURITY INVOKER, so the outbox_insert policy from migration 014 still
-- decides. It admits owner and ops_admin stamping their own organization with
-- published_at null, which is exactly the set that reaches the finance
-- functions; the service role bypasses RLS as it does everywhere else. No new
-- privilege is created by this function — it can insert precisely what its
-- caller could already have inserted through PostgREST.
create or replace function core.emit_event(
  p_organization_id uuid,
  p_type            text,
  p_subject_type    text,
  p_subject_id      uuid,
  p_payload         jsonb default '{}'::jsonb,
  p_correlation_id  uuid default null
)
returns bigint
language sql
volatile
security invoker
set search_path = ''
as $$
  insert into core.outbox_events (
    organization_id, type, subject_type, subject_id, payload, correlation_id
  )
  values (
    p_organization_id, p_type, p_subject_type, p_subject_id,
    coalesce(p_payload, '{}'::jsonb), p_correlation_id
  )
  returning id;
$$;

comment on function core.emit_event(uuid, text, text, uuid, jsonb, uuid) is
  'Appends one row to core.outbox_events from inside a caller''s transaction, so the event commits with the state change it describes. SECURITY INVOKER: outbox_insert still decides who may publish and into which organization.';

revoke all on function core.emit_event(uuid, text, text, uuid, jsonb, uuid)
  from public, anon;
grant execute on function core.emit_event(uuid, text, text, uuid, jsonb, uuid)
  to authenticated, service_role;

-- ── The milestone a payment has just unlocked ────────────────────────────────
--
-- The SQL statement of nextUnlockedMilestone (finance/schema.ts): the first
-- priced milestone, in plan order, with no paid invoice against it. See the
-- header for why this second statement of the rule is accepted and how it is
-- kept honest.
--
-- Void invoices need no exclusion here, unlike billingEntries: that function
-- drops them so a withdrawn bill does not present as a live status, but the
-- only status this asks about is 'paid', and a paid invoice is by construction
-- not void.
--
-- SECURITY DEFINER, taking the organization explicitly, for the reason
-- finance.blocking_invoice_number does: under INVOKER the answer would be
-- computed over whatever rows the caller's policies admit, so a narrower role
-- would silently get a *different* milestone rather than an error. A rule that
-- changes its answer with the reader is not a rule. The caller's organization
-- is still checked, so a signed-in user cannot read across tenants; the null
-- branch is the service role, which has no claim and scopes by hand.
create or replace function finance.next_unlocked_milestone(
  p_project_id      uuid,
  p_organization_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
    from projects.milestones m
   where m.project_id = p_project_id
     and m.organization_id = p_organization_id
     and m.payment_percent is not null
     and not exists (
           select 1
             from finance.invoices i
            where i.milestone_id = m.id
              and i.organization_id = p_organization_id
              and i.status = 'paid'
         )
     and (core.current_organization_id() is null
          or core.current_organization_id() = p_organization_id)
   -- id breaks a tie only if two milestones share a position, which
   -- projects.replace_payment_plan never writes. The TypeScript sort is stable
   -- on input order there, so the two could name different milestones — and the
   -- verdict compares them and refuses, which is the safe direction.
   order by m.position, m.id
   limit 1;
$$;

comment on function finance.next_unlocked_milestone(uuid, uuid) is
  'The first priced milestone on a project with no paid invoice against it — the SQL statement of nextUnlockedMilestone in finance/schema.ts, used to fill the invoice.paid payload inside the paying transaction. Advisory: handleInvoicePaid re-derives the same answer and refuses on disagreement.';

revoke all on function finance.next_unlocked_milestone(uuid, uuid)
  from public, anon;
grant execute on function finance.next_unlocked_milestone(uuid, uuid)
  to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- record_manual_payment — now publishes payment.recorded and invoice.paid
--
-- Unchanged from 20260811120006 except for the locked read, which now also
-- carries the fields the payloads need, and step 6. Every refusal still writes
-- nothing and now also publishes nothing, which is the same statement.
--
-- Dropped rather than replaced: the RETURNS TABLE column list is part of the
-- return type, so adding unlocked_milestone_id to it is a change CREATE OR
-- REPLACE refuses (42P13). The grants below are re-issued for the same reason
-- — a dropped function takes its privileges with it.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists finance.record_manual_payment(uuid, text, bigint, timestamptz);

create or replace function finance.record_manual_payment(
  p_invoice_id          uuid,
  p_provider_payment_id text,
  p_amount_minor        bigint,
  p_captured_at         timestamptz
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

  v_new := case
             when v_after >= v_total then 'paid'
             when v_after > 0        then 'partially_paid'
             else v_status
           end;

  update finance.invoices
     set paid_minor = v_after,
         status     = v_new,
         paid_at    = case when v_new = 'paid' then coalesce(paid_at, p_captured_at)
                           else paid_at end
   where id = p_invoice_id;

  -- ── 6. and the events, in the same transaction as both (D17) ─────────────
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

  if v_new = 'paid' then
    if v_project is not null then
      v_unlocked := finance.next_unlocked_milestone(v_project, v_org);
    end if;

    perform core.emit_event(
      v_org, 'invoice.paid', 'invoice', p_invoice_id,
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

  return query select 'recorded'::text, v_payment, v_captured, v_status,
                      v_after, v_new, v_unlocked;
end;
$$;

comment on function finance.record_manual_payment(uuid, text, bigint, timestamptz) is
  'Records one manual payment, updates the invoice total, and publishes payment.recorded (and invoice.paid when the invoice is covered) — all in one statement, serialised on that invoice. Locks the invoice before summing captured payments, so two concurrent receipts cannot both pass the overpayment check, cannot leave paid_minor disagreeing with the ledger, and cannot commit a payment whose event was lost. Refuses rather than clamps; writes and publishes nothing on refusal.';

revoke all on function finance.record_manual_payment(uuid, text, bigint, timestamptz)
  from public, anon;
grant execute on function finance.record_manual_payment(uuid, text, bigint, timestamptz)
  to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- issue_invoice — now publishes invoice.issued
--
-- Unchanged from 20260811120005 except for the locked read, which now also
-- carries the payload fields, and step 5.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.issue_invoice(
  p_invoice_id uuid,
  p_due_at     timestamptz default null
)
returns table (
  -- 'issued' | 'not_found' | 'already_issued' | 'not_issuable' | 'no_amount'
  -- | 'no_items'. The caller turns these into the same Result answers it
  -- always returned; the wording lives in the application.
  outcome        text,
  -- The status read *under the lock*. The caller audits it as the "before"
  -- state and quotes it back in a refusal, so neither can be made wrong by a
  -- write that landed after the caller's own read.
  invoice_status text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_status    text;
  v_total     bigint;
  v_org       uuid;
  v_currency  char(3);
  v_number    text;
  v_client    uuid;
  v_project   uuid;
  v_milestone uuid;
begin
  -- ── 1. take the lock, and read the invoice through it ────────────────────
  select i.status, i.total_minor, i.organization_id, i.currency,
         i.number, i.client_account_id, i.project_id, i.milestone_id
    into v_status, v_total, v_org, v_currency,
         v_number, v_client, v_project, v_milestone
    from finance.invoices i
   where i.id = p_invoice_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- ── 2. the same refusals the application already made ────────────────────
  --
  -- Restated here because a check that ran before the lock is a check that
  -- could have been true when it ran and false by the time it mattered.
  --
  -- Issuing an invoice that is already issued is the answer, not an error, and
  -- it is answered here rather than from the caller's earlier read: an invoice
  -- that was voided a moment ago must not be reported as successfully issued.
  if v_status = 'issued' then
    return query select 'already_issued'::text, v_status;
    return;
  end if;

  -- The statuses whose INVOICE_TRANSITIONS include 'issued' (finance/schema.ts).
  -- 'pending_approval' has no writer in the application yet; it is listed
  -- because the state machine admits it, not because it is reachable today.
  if v_status not in ('draft', 'pending_approval') then
    return query select 'not_issuable'::text, v_status;
    return;
  end if;

  if v_total <= 0 then
    return query select 'no_amount'::text, v_status;
    return;
  end if;

  -- ── 3. the line items, locked as they are read ───────────────────────────
  --
  -- A bill with a total and no lines is not a bill. Locking the rows is what
  -- makes the answer still true at the write below. `for share` rather than
  -- `for key share` because invoice_items_write is `for all`; `perform` rather
  -- than `select … limit 1` because a LIMIT under a row lock can lose its one
  -- chosen tuple to a concurrent delete and report an empty table that is not.
  perform 1
     from finance.invoice_items it
    where it.invoice_id = p_invoice_id
      for share;

  if not found then
    return query select 'no_items'::text, v_status;
    return;
  end if;

  -- ── 4. the write ─────────────────────────────────────────────────────────
  --
  -- coalesce leaves an existing due date alone when the caller supplied none,
  -- which is what the optional `dueOn` has always meant. clock_timestamp(),
  -- not now(): now() is fixed when the transaction begins, which under
  -- contention is before the lock is granted.
  update finance.invoices
     set status    = 'issued',
         issued_at = clock_timestamp(),
         due_at    = coalesce(p_due_at, due_at)
   where id = p_invoice_id;

  -- ── 5. and the event, in the same transaction (D17) ──────────────────────
  perform core.emit_event(
    v_org, 'invoice.issued', 'invoice', p_invoice_id,
    jsonb_build_object(
      'number',          v_number,
      'clientAccountId', v_client,
      'projectId',       v_project,
      'milestoneId',     v_milestone,
      'totalMinor',      v_total,
      'currency',        v_currency
    )
  );

  return query select 'issued'::text, v_status;
end;
$$;

comment on function finance.issue_invoice(uuid, timestamptz) is
  'Issues one invoice and publishes invoice.issued in the same transaction, serialised on that invoice. Locks the invoice row before deciding and its line items while it counts them, so neither a void nor a payment landing mid-issue can be written over. Refuses rather than issues; writes and publishes nothing on refusal.';

revoke all on function finance.issue_invoice(uuid, timestamptz)
  from public, anon;
grant execute on function finance.issue_invoice(uuid, timestamptz)
  to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- void_invoice — now publishes invoice.voided
--
-- Unchanged from 20260811120004 except for the locked read and step 5. The
-- reason travels in the payload as it always did; it is p_note, the same text
-- appended to the notes.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.void_invoice(
  p_invoice_id uuid,
  p_note       text
)
returns table (
  -- 'voided' | 'not_found' | 'already_void' | 'not_voidable' | 'has_payments'.
  outcome        text,
  -- The status read *under the lock*. The caller audits it as the "before"
  -- state and quotes it back in the refusal.
  invoice_status text,
  -- The captured sum, read under the same lock. Zero on the path that voids —
  -- which is the whole point.
  captured_minor bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_status    text;
  v_notes     text;
  v_captured  bigint;
  v_org       uuid;
  v_number    text;
  v_milestone uuid;
begin
  -- ── 1. take the lock, and read the invoice through it ────────────────────
  --
  -- Everything below is decided from this row, including the notes the void
  -- appends to. Reading them here rather than trusting the caller's earlier
  -- copy is what stops a concurrent note from being silently dropped.
  select i.status, i.notes, i.organization_id, i.number, i.milestone_id
    into v_status, v_notes, v_org, v_number, v_milestone
    from finance.invoices i
   where i.id = p_invoice_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text, null::bigint;
    return;
  end if;

  -- ── 2. the same refusals the application already made ────────────────────
  --
  -- Voiding an invoice that is already void is the answer, not an error: the
  -- caller asked for a state the invoice is already in.
  if v_status = 'void' then
    return query select 'already_void'::text, v_status, null::bigint;
    return;
  end if;

  -- The statuses whose INVOICE_TRANSITIONS include 'void' (finance/schema.ts).
  -- Only 'paid' is missing from this list, and deliberately: money that came
  -- back is a refund, not a status flip.
  if v_status not in ('draft', 'pending_approval', 'issued', 'partially_paid', 'overdue') then
    return query select 'not_voidable'::text, v_status, null::bigint;
    return;
  end if;

  -- ── 3. the ledger, read inside the lock ──────────────────────────────────
  --
  -- The payment rows are the ledger; invoices.paid_minor is a cached sum of
  -- them. Summing here rather than trusting the cache means a stale or
  -- un-reconciled paid_minor cannot let a void through.
  select coalesce(sum(p.amount_minor), 0)
    into v_captured
    from finance.payments p
   where p.invoice_id = p_invoice_id
     and p.status = 'captured';

  if v_captured > 0 then
    return query select 'has_payments'::text, v_status, v_captured;
    return;
  end if;

  -- ── 4. the write ─────────────────────────────────────────────────────────
  --
  -- Same transaction, same lock. The reason is appended to the notes read
  -- above; concat_ws drops a null or empty existing note rather than leaving a
  -- leading blank line.
  update finance.invoices
     set status = 'void',
         notes  = concat_ws(chr(10), nullif(v_notes, ''), p_note)
   where id = p_invoice_id;

  -- ── 5. and the event, in the same transaction (D17) ──────────────────────
  perform core.emit_event(
    v_org, 'invoice.voided', 'invoice', p_invoice_id,
    jsonb_build_object(
      'number',      v_number,
      'milestoneId', v_milestone,
      'reason',      p_note
    )
  );

  return query select 'voided'::text, v_status, 0::bigint;
end;
$$;

comment on function finance.void_invoice(uuid, text) is
  'Withdraws one invoice and publishes invoice.voided in the same transaction, serialised on that invoice. Locks the invoice row before summing captured payments, so a payment landing mid-void cannot be voided over. Refuses rather than voids when money is present; writes and publishes nothing on refusal.';

revoke all on function finance.void_invoice(uuid, text)
  from public, anon;
grant execute on function finance.void_invoice(uuid, text)
  to authenticated, service_role;

-- ── The table comment stops overclaiming ────────────────────────────────────
--
-- Migration 002 asserted the property outright; migration 014 softened it to
-- "alongside" without saying what was true. Now it holds for every event a
-- Postgres function publishes, and does not for invoice.created, so the
-- comment says exactly that rather than a version of it.
comment on table core.outbox_events is
  'Transactional outbox. Every event published by a finance function — invoice.issued, invoice.voided, payment.recorded, invoice.paid — is written in the same transaction as the state change it describes, so "state committed but event lost" cannot happen for those. invoice.created is still appended from the application after its insert commits (G-078). Owners and ops admins may publish from a request; everything else writes under service_role.';
