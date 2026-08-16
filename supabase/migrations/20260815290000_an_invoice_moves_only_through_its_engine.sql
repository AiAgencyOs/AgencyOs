-- ═══════════════════════════════════════════════════════════════════════════
-- An invoice's state and money move only through the finance engine, never by a
-- direct write.
--
-- finance.invoices carries the billing state machine (draft → issued →
-- partially_paid/paid/overdue → void) and the money columns the payment engine
-- maintains (verified_minor, paid_minor, total_minor, …). Every legitimate
-- mutation goes through a finance function — create_milestone_invoice,
-- issue_invoice, record_manual_payment, verify_payment, mark_overdue_invoices,
-- void_invoice — and the application never writes the table directly. Those
-- functions carry the real rules: issue_invoice enforces **G-100** (the linked
-- deliverable must be `approved` before a client is billed, ADM-13); the
-- reconcile/verify functions drive `status = paid` and `verified_minor` from
-- confirmed payments (ADM-04), under a lock.
--
-- But the functions are `SECURITY INVOKER`, so they run with the caller's
-- privileges, and `invoices_write` RLS admits owner/ops_admin with UPDATE/INSERT
-- granted to `authenticated`. A raw PATCH therefore has *exactly the same*
-- privileges as issue_invoice — so the gate inside the function is advisory, not
-- a boundary. Proven live: an ops_admin PATCHing `finance.invoices` over the
-- Data API can set `draft → issued` (bypassing G-100 — billing for un-approved
-- work) and `→ paid` with `paid_minor` (a fabricated payment the money engine
-- never confirmed).
--
-- The fix gives the sanctioned path a capability a direct write cannot forge,
-- WITHOUT moving any money logic into a trigger. Each finance function that
-- writes the table sets a transaction-scoped marker as its first statement
-- (`set_config('finance.sanctioned_write', 'on', true)`), and a guard trigger
-- refuses any invoice write that does not carry it. `SECURITY DEFINER` was
-- rejected because these functions rely on RLS for tenant isolation (none checks
-- the caller's org in-body), so making them run as the owner would open a
-- cross-tenant hole unless org checks were bolted onto each — reworking
-- money-critical logic, which this deliberately avoids. Server-side callers with
-- no end-user identity (the service role, cron, migrations) are unrestricted, as
-- they are trusted infrastructure and not the Data-API attack surface; only an
-- authenticated end-user's *direct* write is refused. So the five user-callable
-- functions remain the only way an end-user changes an invoice, and the rules
-- they hold (G-100, the payment lock) can no longer be walked around.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.invoices_write_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- A sanctioned finance function marks its writes with a transaction-scoped
  -- flag (set_config … , is_local => true) that a direct Data-API write cannot set.
  if current_setting('finance.sanctioned_write', true) = 'on' then
    -- Single-use within the transaction: consume the flag so a LATER write in the
    -- same DB transaction cannot inherit it. is_local keeps the flag set until the
    -- transaction ends, and each PostgREST request is its own transaction — so
    -- this is not a Data-API bypass — but consuming it also closes the latent
    -- server-side path where a future function calls a sanctioned finance
    -- function and then writes finance.invoices raw in the same transaction. Each
    -- of the five sanctioned writers touches exactly ONE invoice row per call
    -- (the service-role-only batch sweep mark_overdue_invoices does not use this
    -- flag — it is admitted by the identity-less branch below), so consuming here
    -- never blocks a function's own write. If a future writer needs to touch more
    -- than one invoice row under one flag, it must set the flag again per row.
    perform set_config('finance.sanctioned_write', 'off', true);
    return new;
  end if;

  -- No end-user identity → the service role, cron, a migration, psql. Trusted
  -- server-side infrastructure, not the Data-API surface this guard defends;
  -- forging a JWT with no sub would itself require the JWT secret, i.e. full
  -- compromise, at which point a service-role token is already available.
  if (select auth.uid()) is null then
    return new;
  end if;

  raise exception
    'finance.invoices is written only through its finance functions '
    '(create_milestone_invoice, issue_invoice, record_manual_payment, '
    'verify_payment, mark_overdue_invoices, void_invoice), not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function finance.invoices_write_is_sanctioned() is
  'Refuses any authenticated end-user write to finance.invoices that did not come through a finance function. The functions mark their writes with the transaction-scoped finance.sanctioned_write flag (set_config with is_local); a direct PATCH/INSERT over the Data API cannot set it and is refused, so issue_invoice''s G-100 gate and the payment engine''s lock cannot be walked around. The service role and other identity-less server-side callers are unrestricted.';

drop trigger if exists invoices_write_is_sanctioned on finance.invoices;
create trigger invoices_write_is_sanctioned
  before insert or update on finance.invoices
  for each row execute function finance.invoices_write_is_sanctioned();

-- The sanctioned writers declare the capability by setting the transaction-local
-- flag as their first statement. It is set at runtime with `set_config(…, true)`
-- rather than the function's `SET` clause because the migration role is not a
-- superuser and a custom (namespaced) parameter cannot be pinned onto a function
-- by a non-superuser — but any role may set it at runtime. Each function below is
-- its CURRENT definition, reproduced VERBATIM from the catalog, with only that one
-- line inserted as the first statement of the body — the same verbatim-plus-one
-- shape 20260815180000 used to fix verify_payment, and deliberately NOT a
-- hand-rewrite (a hand-rewrite is what shifted a seq base in an earlier
-- regeneration). `mark_overdue_invoices` is intentionally absent: it is granted
-- only to the service role, whose writes the guard already allows.
--
-- MAINTENANCE: any future CREATE OR REPLACE of one of these five functions MUST
-- keep the `set_config('finance.sanctioned_write', 'on', true)` line, or an
-- authenticated caller's legitimate invoice write through it will be refused.
-- tests/finance-sanctioned-write.test.ts pins this.

-- ── create_milestone_invoice: verbatim, + the one-line capability declaration ──
CREATE OR REPLACE FUNCTION finance.create_milestone_invoice(p_organization_id uuid, p_client_account_id uuid, p_project_id uuid, p_milestone_id uuid, p_number text, p_currency character, p_subtotal_minor bigint, p_tax_minor bigint, p_total_minor bigint, p_lines jsonb, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notes text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, invoice_id uuid, number text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_invoice_id  uuid;
  v_number      text;
  v_constraint  text;
begin
  -- Declare the sanctioned-write capability the invoices guard checks
  -- (finance.invoices_write_is_sanctioned, 20260815290000). Transaction-scoped;
  -- a direct Data-API write cannot set it.
  perform set_config('finance.sanctioned_write', 'on', true);
  -- ── 1. an invoice with no lines is refused before anything is written ────
  --
  -- The old path could not check this: it inserted the invoice first and found
  -- out afterwards, which is why it needed a DELETE to undo itself.
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return query select 'no_lines'::text, null::uuid, null::text;
    return;
  end if;

  -- ── 2. the invoice ───────────────────────────────────────────────────────
  --
  -- No read-then-decide. Both refusals below come from an index rejecting the
  -- write, so a request that arrives between a check and its insert cannot slip
  -- through the gap — the shape D1, D2 and D4 all were.
  begin
    insert into finance.invoices (
      organization_id, client_account_id, project_id, milestone_id,
      number, status, currency,
      subtotal_minor, tax_minor, total_minor,
      due_at, notes
    )
    values (
      p_organization_id, p_client_account_id, p_project_id, p_milestone_id,
      p_number, 'draft', p_currency,
      p_subtotal_minor, p_tax_minor, p_total_minor,
      p_due_at, p_notes
    )
    returning id into v_invoice_id;
  exception
    when unique_violation then
      -- Two indexes can raise this and they mean opposite things, so the
      -- constraint name decides. Answering the wrong one would either bill a
      -- milestone twice or refuse a numbering retry that would have succeeded.
      --
      -- Read from the diagnostics rather than matched out of SQLERRM: the
      -- message is prose, and prose is translated. A server running under a
      -- non-English lc_messages would fall through to 'number_taken' forever
      -- and the caller would exhaust its five attempts on a milestone that was
      -- already invoiced — a bug that appears only on somebody else's machine.
      get stacked diagnostics v_constraint = constraint_name;

      if v_constraint = 'invoices_milestone_live_key' then
        select i.id, i.number
          into v_invoice_id, v_number
          from finance.invoices i
         where i.milestone_id = p_milestone_id
           and i.status <> 'void'
         limit 1;

        return query select 'already_invoiced'::text, v_invoice_id, v_number;
        return;
      end if;

      return query select 'number_taken'::text, null::uuid, null::text;
      return;
  end;

  -- ── 3. its lines ─────────────────────────────────────────────────────────
  --
  -- A failure here — a quantity of zero, a negative price, a malformed row —
  -- raises, and the invoice inserted a moment ago goes with it. That is the
  -- compensating DELETE, done by the database, and it cannot be skipped by a
  -- process that died before it got there.
  insert into finance.invoice_items (
    organization_id, invoice_id, position, description,
    quantity, unit_price_minor, amount_minor, tax_rate_bp
  )
  select
    p_organization_id,
    v_invoice_id,
    (line->>'position')::int,
    line->>'description',
    (line->>'quantity')::numeric,
    (line->>'unit_price_minor')::bigint,
    (line->>'amount_minor')::bigint,
    (line->>'tax_rate_bp')::int
  from jsonb_array_elements(p_lines) as line;

  -- ── 4. the history, and the announcement ─────────────────────────────────
  --
  -- Both inside this transaction. The audit row matters more than the event:
  -- audit.audit_log is append-only by trigger, so one never written can never
  -- be repaired afterwards.
  perform core.record_audit(
    p_organization_id,
    'invoice.created',
    'invoice',
    v_invoice_id,
    null,
    jsonb_build_object(
      'number', p_number,
      'milestoneId', p_milestone_id,
      'projectId', p_project_id,
      'clientAccountId', p_client_account_id,
      'totalMinor', p_total_minor,
      'currency', p_currency
    )
  );

  perform core.emit_event(
    p_organization_id,
    'invoice.created',
    'invoice',
    v_invoice_id,
    jsonb_build_object(
      'number', p_number,
      'milestoneId', p_milestone_id,
      'projectId', p_project_id,
      'totalMinor', p_total_minor,
      'currency', p_currency
    )
  );

  return query select 'created'::text, v_invoice_id, p_number;
end;
$function$;

-- ── issue_invoice: verbatim, + the one-line capability declaration ──
CREATE OR REPLACE FUNCTION finance.issue_invoice(p_invoice_id uuid, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(outcome text, invoice_status text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_status    text;
  v_total     bigint;
  v_org       uuid;
  v_currency  char(3);
  v_number    text;
  v_client    uuid;
  v_project   uuid;
  v_milestone uuid;
  v_gate      uuid;
  v_gate_state text;
begin
  -- Declare the sanctioned-write capability the invoices guard checks
  -- (finance.invoices_write_is_sanctioned, 20260815290000). Transaction-scoped;
  -- a direct Data-API write cannot set it.
  perform set_config('finance.sanctioned_write', 'on', true);
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

  -- ── 2b. the deliverable this milestone waits on (G-100, ADM-13) ──────────
  --
  -- "Client approval makes the milestone invoice raisable, not sent." Drafting
  -- stays free; **issuing** is the act that reaches the client, and it is the
  -- one that waits. That is the same shape as the QA gate, which refuses
  -- submit_deliverable rather than every write.
  --
  -- Read under the invoice's lock with everything else, so an approval that
  -- lands between a caller's check and this write cannot be missed.
  --
  -- A milestone with no linked deliverable issues exactly as before. That is
  -- the honest cost of a per-project mapping rather than a template: the
  -- guarantee is only as good as the linking somebody remembers to do, and
  -- pretending otherwise would mean inventing which deliverable gates which
  -- milestone for every project that already exists.
  if v_milestone is not null then
    select m.requires_deliverable_id into v_gate
      from projects.milestones m
     where m.id = v_milestone;

    if v_gate is not null then
      select d.status into v_gate_state
        from projects.deliverables d
       where d.id = v_gate;

      if v_gate_state is distinct from 'approved' then
        return query select 'deliverable_not_approved'::text, v_status;
        return;
      end if;
    end if;
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

  -- ── 5. the audit row, in the same transaction as the write (G-079) ────────
  --
  -- `before` is the status read under the lock above, not the one a caller
  -- read a request earlier. Those differ exactly when it matters.
  perform core.record_audit(
    v_org, 'invoice.issued', 'invoice', p_invoice_id,
    jsonb_build_object('status', v_status),
    jsonb_build_object('status', 'issued')
  );

  -- ── 6. and the event, in the same transaction as both (D17) ───────────────
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
$function$;

-- ── void_invoice: verbatim, + the one-line capability declaration ──
CREATE OR REPLACE FUNCTION finance.void_invoice(p_invoice_id uuid, p_note text)
 RETURNS TABLE(outcome text, invoice_status text, captured_minor bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_status    text;
  v_notes     text;
  v_captured  bigint;
  v_org       uuid;
  v_number    text;
  v_milestone uuid;
begin
  -- Declare the sanctioned-write capability the invoices guard checks
  -- (finance.invoices_write_is_sanctioned, 20260815290000). Transaction-scoped;
  -- a direct Data-API write cannot set it.
  perform set_config('finance.sanctioned_write', 'on', true);
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

  -- ── 5. the audit row, in the same transaction as the write (G-079) ────────
  --
  -- `before` is the status read under the lock above, not the one a caller
  -- read a request earlier. Those differ exactly when it matters.
  perform core.record_audit(
    v_org, 'invoice.voided', 'invoice', p_invoice_id,
    jsonb_build_object('status', v_status),
    jsonb_build_object('status', 'void', 'reason', p_note)
  );

  -- ── 6. and the event, in the same transaction as both (D17) ───────────────
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
$function$;

-- ── verify_payment: verbatim, + the one-line capability declaration ──
CREATE OR REPLACE FUNCTION finance.verify_payment(p_payment_id uuid, p_verified_by uuid)
 RETURNS TABLE(outcome text, invoice_id uuid, verified_after_minor bigint, status_after text, unlocked_milestone_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
begin
  -- Declare the sanctioned-write capability the invoices guard checks
  -- (finance.invoices_write_is_sanctioned, 20260815290000). Transaction-scoped;
  -- a direct Data-API write cannot set it.
  perform set_config('finance.sanctioned_write', 'on', true);
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
  -- reading the same bank statement should not fight. This is the fast path
  -- for a payment already verified when we first read it; the race-safe guard
  -- is the conditional write in step 4, because THIS read was taken before the
  -- lock and a concurrent confirmation could have landed since.
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
    return query select 'already_verified'::text, v_invoice,
                        finance.net_verified_minor(v_invoice), v_status, null::uuid;
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
$function$;

-- ── record_manual_payment: verbatim, + the one-line capability declaration ──
CREATE OR REPLACE FUNCTION finance.record_manual_payment(p_invoice_id uuid, p_provider_payment_id text, p_amount_minor bigint, p_captured_at timestamp with time zone, p_method text)
 RETURNS TABLE(outcome text, payment_id uuid, captured_before_minor bigint, invoice_status text, paid_after_minor bigint, status_after text, unlocked_milestone_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  -- Declare the sanctioned-write capability the invoices guard checks
  -- (finance.invoices_write_is_sanctioned, 20260815290000). Transaction-scoped;
  -- a direct Data-API write cannot set it.
  perform set_config('finance.sanctioned_write', 'on', true);
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
$function$;

