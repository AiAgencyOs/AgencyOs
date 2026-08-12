-- ═══════════════════════════════════════════════════════════════════════════
-- The audit row is written by the statement it describes.
--
-- Gap G-079, and D17's shape one table along. `recordAudit` opens its own
-- client and inserts into `audit.audit_log` in a separate transaction, after
-- the state change has already committed. Its doc comment defends that
-- honestly — "an audit write that fails should not roll back the business
-- change it describes" — and the trade it names is real. What it does not say
-- is the cost: `audit.audit_log` is append-only by trigger, so a row that was
-- never written cannot be written later. A payment can commit with no history,
-- permanently, and nothing anywhere will ever notice.
--
-- Four of the sixteen call sites sit beside a Postgres function that already
-- owns a transaction, so for those the trade is not necessary at all: the audit
-- row and the state change become one commit and neither can be observed
-- without the other. `core.record_audit` is the same shape as
-- `core.emit_event` from D17, and for the same reason.
--
-- ── What this does NOT cover, and why ─────────────────────────────────────
--
-- The other twelve are a different problem wearing the same clothes. They are
-- ordinary two-statement service writes — `setLeadStatus`, `createOpportunity`,
-- `createProject` and the rest — with no function to be inside. Moving them
-- would mean putting every module's writes into Postgres functions, which is a
-- far larger change than this gap describes and one that should be argued on
-- its own merits rather than smuggled in behind it. They are recorded as G-093.
--
-- ── The actor ─────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER, so `audit_log_insert` still decides: it admits a row only
-- when `actor_id = auth.uid()`, which is precisely the rule that stops a caller
-- attributing an action to somebody else. Keeping the insert under the caller's
-- own policy is what preserves that.
--
-- `actor_type` follows the actor rather than being asserted: `auth.uid()` is
-- null for the service role, and calling that a `user` action with a null id
-- would be a small lie told in the one table that exists to be believed. The
-- table's own vocabulary already has the word for it.
--
-- ── One signature change ──────────────────────────────────────────────────
--
-- `finance.record_manual_payment` gains `p_method`, because the audit row
-- carries how the money arrived and that is caller intent the function cannot
-- derive. Required rather than defaulted: a caller that omits it should fail to
-- type-check, not write a history with a hole. The four-argument signature is
-- dropped rather than left as an overload, for the reason G-082 gives.
--
-- Every function body below is the current one with the audit call inserted —
-- generated from the migration that defines it rather than retyped, so the only
-- difference is the insertion.
--
-- No schema change: no table, column, index or constraint is added, altered or
-- dropped.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── The append, as one place rather than four ────────────────────────────────
create or replace function core.record_audit(
  p_organization_id uuid,
  p_action          text,
  p_subject_type    text,
  p_subject_id      uuid,
  p_before          jsonb default null,
  p_after           jsonb default null,
  p_correlation_id  uuid default null
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action,
    subject_type, subject_id, before, after, correlation_id
  )
  values (
    p_organization_id,
    case when (select auth.uid()) is null then 'system' else 'user' end,
    (select auth.uid()),
    p_action, p_subject_type, p_subject_id,
    p_before, p_after, p_correlation_id
  );
$$;

comment on function core.record_audit(uuid, text, text, uuid, jsonb, jsonb, uuid) is
  'Appends one row to audit.audit_log from inside a caller''s transaction, so the history commits with the change it describes. SECURITY INVOKER: audit_log_insert still decides, which is what keeps a caller from attributing an action to somebody else. actor_type follows the actor — ''system'' when there is no auth.uid(), rather than calling the service role a user.';

revoke all on function core.record_audit(uuid, text, text, uuid, jsonb, jsonb, uuid)
  from public, anon;
grant execute on function core.record_audit(uuid, text, text, uuid, jsonb, jsonb, uuid)
  to authenticated, service_role;

drop function if exists finance.record_manual_payment(uuid, text, bigint, timestamptz);

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
$$;

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
$$;

create or replace function projects.replace_payment_plan(
  p_project_id uuid,
  p_milestones jsonb
)
returns table (
  outcome        text,
  milestone_count int,
  blocking_number text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org      uuid;
  v_currency char(3);
  v_budget   bigint;
  v_blocking text;
  v_met      int;
  v_count    int;
begin
  select p.organization_id, p.currency, p.budget_minor
    into v_org, v_currency, v_budget
    from projects.projects p
   where p.id = p_project_id
     and p.deleted_at is null
     for update;

  if not found then
    return query select 'not_found'::text, null::int, null::text;
    return;
  end if;

  perform 1
     from projects.milestones m
    where m.project_id = p_project_id
      for update;

  select count(*)
    into v_met
    from projects.milestones m
   where m.project_id = p_project_id
     and m.payment_percent is not null
     and m.status = 'met';

  if v_met > 0 then
    return query select 'met'::text, null::int, null::text;
    return;
  end if;

  -- Through the definer helper, so the answer does not depend on whether this
  -- particular role may read the invoice book (audit D16). Still read after
  -- the lock above, which is what makes it true at the write below.
  v_blocking := finance.blocking_invoice_number(p_project_id, v_org);

  if v_blocking is not null then
    return query select 'billed'::text, null::int, v_blocking;
    return;
  end if;

  delete from projects.milestones m
   where m.project_id = p_project_id
     and m.payment_percent is not null;

  insert into projects.milestones (
    organization_id, project_id, name, position,
    payment_percent, amount_minor, currency, due_on
  )
  select v_org,
         p_project_id,
         item.value ->> 'name',
         (item.ordinality - 1)::int,
         (item.value ->> 'percent')::numeric,
         (item.value ->> 'amountMinor')::bigint,
         v_currency,
         nullif(item.value ->> 'dueOn', '')::date
    from jsonb_array_elements(p_milestones) with ordinality as item(value, ordinality);

  get diagnostics v_count = row_count;

  -- ── the audit row, in the same transaction as the plan (G-079) ───────────
  --
  -- No `before`: the previous plan was deleted above and this function never
  -- read it. Recording an empty object would assert there was nothing there,
  -- which is a different claim from not knowing. Null says the second.
  --
  -- The budget comes from the locked read, so it is the figure the milestone
  -- amounts were actually resolved against.
  perform core.record_audit(
    v_org, 'project.payment_plan_configured', 'project', p_project_id,
    null::jsonb,
    jsonb_build_object('items', p_milestones, 'budgetMinor', v_budget)
  );

  return query select 'replaced'::text, v_count, null::text;
end;
$$;

comment on function finance.record_manual_payment(uuid, text, bigint, timestamptz, text) is
  'Records one manual payment, updates the invoice total, writes the audit row and publishes payment.recorded (and invoice.paid when the invoice is covered) — all in one statement, serialised on that invoice. Refuses rather than clamps; writes, audits and publishes nothing on refusal.';

revoke all on function finance.record_manual_payment(uuid, text, bigint, timestamptz, text)
  from public, anon;
grant execute on function finance.record_manual_payment(uuid, text, bigint, timestamptz, text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
