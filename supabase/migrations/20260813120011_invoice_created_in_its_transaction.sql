-- G-078 — invoice.created is published in the transaction that creates it.
--
-- Every other finance event — invoice.issued, invoice.voided, payment.recorded,
-- invoice.paid — has been written inside its own state change since D17.
-- `invoice.created` was the one caller left on the application path, for a
-- reason that was true when it was written: generateInvoiceFromMilestone had no
-- Postgres function behind it, so there was no transaction to join.
--
-- What that path actually did, in four separate transactions:
--
--   1. insert the invoice
--   2. insert its lines — and on failure, a hand-rolled compensating DELETE,
--      because an invoice with a total and no lines occupies the milestone's
--      one live slot and reads as a real bill
--   3. append the audit row
--   4. append the outbox row
--
-- Three ways to lose something, none of them visible afterwards. A compensating
-- DELETE is a rollback written by hand: it runs only if the process survives
-- long enough to run it, and if it fails there is nothing left to retry it. The
-- audit row and the event row are appended after the invoice has committed, so
-- a crash between them leaves a bill with no history and nothing downstream
-- ever told it exists.
--
-- The risk was rated P3 because nothing subscribes to invoice.created today, so
-- losing one loses a notification nobody reads. That is a statement about the
-- subscription catalog, not about the invoice — and the moment anything does
-- subscribe, the same code silently starts losing work. The audit row was never
-- covered by that argument at all: `audit.audit_log` is append-only by trigger,
-- so a row never written can never be repaired.
--
-- One statement now does all four, and the exception that used to need a
-- compensating DELETE rolls the invoice back for free.
--
-- Deliberately NOT moved into this function: which lines an invoice has, and
-- what its number is. `milestoneInvoiceLines` and `nextInvoiceNumber` are pure
-- TypeScript with tests against them, and re-deriving either in plpgsql would
-- put the same rule in two places — which is how regenerating a function from
-- the migration that introduced it silently reverted D16 during G-079's
-- verification. The caller computes them and passes them in; this function
-- decides nothing about money, it only writes atomically what it was handed.

-- ── the function ──────────────────────────────────────────────────────────

create or replace function finance.create_milestone_invoice(
  p_organization_id   uuid,
  p_client_account_id uuid,
  p_project_id        uuid,
  p_milestone_id      uuid,
  p_number            text,
  p_currency          char(3),
  p_subtotal_minor    bigint,
  p_tax_minor         bigint,
  p_total_minor       bigint,
  -- [{position, description, quantity, unit_price_minor, amount_minor,
  --   tax_rate_bp}, ...] — exactly what milestoneInvoiceLines() returned.
  p_lines             jsonb,
  -- Both genuinely optional, and last because a defaulted parameter must be.
  -- The caller omits them rather than passing null, which is the idiom
  -- finance.issue_invoice already uses for its own due date.
  p_due_at            timestamptz default null,
  p_notes             text default null
)
returns table (
  -- 'created'          the invoice, its lines, its audit row and its event all
  --                    committed together
  -- 'already_invoiced' this milestone already has a live invoice; its id and
  --                    number are returned, which is the answer rather than an
  --                    error, exactly as the application's pre-check answered
  -- 'number_taken'     the number collided with another invoice in this
  --                    organization. The caller holds the numbering rule, so it
  --                    retries with the next one
  -- 'no_lines'         refused: an invoice with a total and no lines is the
  --                    thing the compensating DELETE existed to prevent
  outcome    text,
  invoice_id uuid,
  number     text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_invoice_id  uuid;
  v_number      text;
  v_constraint  text;
begin
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
$$;

comment on function finance.create_milestone_invoice(
  uuid, uuid, uuid, uuid, text, char, bigint, bigint, bigint, jsonb, timestamptz, text
) is
  'Writes a milestone invoice, its lines, its audit row and its invoice.created event in one transaction (G-078). Replaces four separate application transactions and a hand-rolled compensating DELETE. Decides nothing about money: the lines and the invoice number are computed by the caller, which is where those rules are tested. SECURITY INVOKER, so RLS and the invoice.create capability still decide who may write.';

-- ── the table comment stops naming an exception that no longer exists ─────

comment on table core.outbox_events is
  'Transactional outbox. Every event is written in the same transaction as the state change it describes — invoice.created, invoice.issued, invoice.voided, payment.recorded, invoice.paid — so "state committed but event lost" cannot happen. G-078 was the last exception and closed with finance.create_milestone_invoice. Owners and ops admins may publish from a request; everything else writes under service_role.';
