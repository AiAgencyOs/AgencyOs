-- G-100 — an approved deliverable permits the bill.
--
-- ADM-13, in the Admin's words: **client approval makes the milestone invoice
-- raisable, not sent.**
--
-- Two mechanisms have run side by side and never touched. Money flowed on
-- payment — an invoice paid opens the next milestone. Approval flowed on
-- delivery — a version is approved by the client through the engine. Directive
-- §18's middle arrow, *UI_APPROVED → MILESTONE_PAYMENT_DUE*, existed in the
-- document and nowhere else.
--
-- ── the shape chosen, and the one refused ─────────────────────────────────
--
-- Shape B of `docs/decisions/g-100-approvals-and-payments.md`: approval
-- **permits** issuing. Not shape C, where approval releases the payment
-- automatically — the document argued against it and the Admin agreed. Every
-- other money path in this system requires a person, and the first exception
-- should be chosen deliberately rather than arrived at.
--
-- So drafting an invoice stays free. **Issuing** is the act that reaches the
-- client, and issuing is what waits. The same shape as the QA gate, which
-- refuses `submit_deliverable` rather than every write.
--
-- ── what this deliberately does not guarantee ─────────────────────────────
--
-- A milestone with no linked deliverable issues exactly as it does today. That
-- is the cost of a per-project mapping rather than a template, and it is the
-- honest one: the alternative is inventing which deliverable gates which
-- milestone for every project that already exists, and being wrong about some
-- of them silently. The guarantee is only as good as the linking somebody
-- remembers to do — which is why the column is visible on the milestone rather
-- than hidden in a join table.

alter table projects.milestones
  add column if not exists requires_deliverable_id uuid
    references projects.deliverables(id) on delete set null;

comment on column projects.milestones.requires_deliverable_id is
  'The deliverable whose client approval permits this milestone to be invoiced (G-100, ADM-13). Null means no gate - the milestone bills as it always did. On delete set null rather than cascade: losing the deliverable must not silently remove the gate without anybody noticing, and a null here is at least visible on the milestone.';

create index if not exists milestones_requires_deliverable_idx
  on projects.milestones (requires_deliverable_id)
  where requires_deliverable_id is not null;

-- ── the gate ──────────────────────────────────────────────────────────────
--
-- `finance.issue_invoice` carried forward **from its own latest definition**
-- with two marked additions, not regenerated — regenerating
-- `replace_payment_plan` from the migration that introduced it rather than the
-- one that last changed it is exactly how D16 was silently reverted.

create or replace function finance.issue_invoice(
  p_invoice_id uuid,
  p_due_at     timestamptz default null
)
returns table (
  -- 'issued' | 'not_found' | 'already_issued' | 'not_issuable' | 'no_amount'
  -- | 'no_items' | 'deliverable_not_approved' (G-100). The caller turns these into the same Result answers it
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
  v_gate      uuid;
  v_gate_state text;
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
$$;

