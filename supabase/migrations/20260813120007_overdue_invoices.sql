-- ═══════════════════════════════════════════════════════════════════════════
-- An invoice whose date has passed says so.
--
-- Gap G-004. `overdue` has been in the invoice status vocabulary since the
-- schema was written, `INVOICE_TRANSITIONS` has admitted `issued → overdue`
-- and `partially_paid → overdue` since the first day, and nothing has ever
-- performed either. A due date passed and the invoice went on describing
-- itself as issued.
--
-- The rule is therefore not invented here — it is executed for the first
-- time. What was missing was somebody to run it, and the cron tick already
-- runs every minute.
--
-- ── what it will not do ───────────────────────────────────────────────────
--
-- It does not chase anybody. A payment reminder is a client-facing message,
-- which is YELLOW under directive §28 and needs the outbound policy ADM-09
-- settled beyond the channel itself. This marks state and stops.
--
-- It does not touch `paid` or `void`, which are terminal, and it does not
-- touch `draft` or `pending_approval`, which were never sent — an invoice
-- nobody has seen cannot be late.
--
-- It does not reverse itself. An overdue invoice that is then paid moves to
-- `paid` through the payment path, which already handles it; nothing here
-- walks a status backwards when a due date is edited, because that edit is a
-- deliberate act and the audit trail should show both.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.mark_overdue_invoices(p_limit int default 200)
returns table (invoice_id uuid, invoice_number text, organization_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row finance.invoices;
begin
  for v_row in
    select i.*
      from finance.invoices i
     where i.status in ('issued', 'partially_paid')
       and i.due_at is not null
       and i.due_at < now()
     order by i.due_at
     limit p_limit
     -- Two ticks overlapping must not both mark and both audit the same
     -- invoice. The second steps over a held row rather than waiting.
     for update skip locked
  loop
    update finance.invoices
       set status = 'overdue'
     where finance.invoices.id = v_row.id
       -- Restated under the lock: the status this decision was taken against
       -- is the status being written from. A payment landing in the same
       -- instant wins, and the invoice is paid rather than overdue.
       and finance.invoices.status in ('issued', 'partially_paid');

    if found then
      perform core.record_audit(
        v_row.organization_id,
        'invoice.overdue',
        'invoice',
        v_row.id,
        jsonb_build_object('status', v_row.status),
        jsonb_build_object('status', 'overdue', 'due_at', v_row.due_at)
      );

      invoice_id := v_row.id;
      invoice_number := v_row.number;
      organization_id := v_row.organization_id;
      return next;
    end if;
  end loop;
end;
$$;

comment on function finance.mark_overdue_invoices(int) is
  'Marks issued and partially paid invoices overdue once their due date has passed — the transition INVOICE_TRANSITIONS has admitted since the first day and nothing ever performed. Chases nobody: a payment reminder is client-facing and waits on the outbound policy. Never touches paid, void, or anything never sent.';

revoke all on function finance.mark_overdue_invoices(int) from public;
grant execute on function finance.mark_overdue_invoices(int) to service_role;
