-- ═══════════════════════════════════════════════════════════════════════════
-- P9-EV-05: PaymentOverdue. The Phase 9 sweep (finance.sweep_finance_exceptions) opens ONE overdue exception per overdue invoice (a unique index
-- allows one open overdue exception per invoice) and auto-closes it when the invoice stops being overdue. This migration emits
-- `finance.payment_overdue` from the row that opens, so the event fires once per opening, carries ids only, and cannot fire for an invoice the sweep
-- did not find overdue. It chases nobody: a reminder is still the existing reminder candidate list, re-checked at send; a person decides escalation.
-- ═══════════════════════════════════════════════════════════════════════════
insert into core.event_types (type, description, canonical) values
  ('finance.payment_overdue', 'An invoice is past its due date and an overdue exception was opened for it. It carries ids only; nothing was sent to the client.', true)
on conflict (type) do nothing;

create or replace function finance.emit_payment_overdue()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'overdue' and new.invoice_id is not null then
    perform core.emit_event(new.organization_id, 'finance.payment_overdue', 'invoice', new.invoice_id,
      jsonb_build_object('invoiceId', new.invoice_id, 'projectId', new.project_id, 'exceptionId', new.id));
  end if;
  return new;
end $$;
revoke all on function finance.emit_payment_overdue() from public, anon, authenticated;
drop trigger if exists finance_exceptions_payment_overdue_event on finance.finance_exceptions;
create trigger finance_exceptions_payment_overdue_event after insert on finance.finance_exceptions
  for each row execute function finance.emit_payment_overdue();
