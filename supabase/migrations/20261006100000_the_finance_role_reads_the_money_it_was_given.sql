-- The finance role reads the whole of the money, not half of it (PDF gap W1).
--
-- G-314 (20260921120000) gave the `finance` role `invoice.read` and admitted it
-- to `finance.invoices`, `finance.payments` and `finance.expenses`. It stopped
-- there. Every OTHER table the finance screens read is gated on
-- `core.is_internal()`, a predicate that deliberately excludes `finance` (so
-- the role cannot read CRM or sales notes). The result, seen on the rendered
-- audit as the finance user:
--
--   /finance/tax      "0 receipts", every invoice "Unconfirmed" (no billing
--                     profile visible), a P&L that differs from the owner's;
--   /finance/payments no claims, no reconciliation, no bank lines;
--   /invoices/:id     no send history, no pay-into account, no refunds.
--
-- The figures changed with the role reading them. This widens exactly the
-- finance-schema tables those screens read, and nothing outside `finance`:
-- core.client_accounts, projects.* and crm.* stay closed to the role (Doc 09
-- §35, "necessary billing info, not unrestricted sales notes").
--
-- Read access only. Every write stays where it was (owner / ops_admin through
-- the sanctioned doors). Idempotent.

do $$
declare
  t text;
begin
  foreach t in array array[
    'receipts', 'payment_submissions', 'billing_profiles', 'payment_accounts',
    'bank_statement_lines', 'reconciliations', 'reconciliation_items',
    'tax_period_locks', 'invoice_sends'
  ] loop
    execute format('drop policy if exists %I on finance.%I', t || '_select', t);
    execute format(
      'create policy %I on finance.%I for select to authenticated using ('
      || 'organization_id = (select core.current_organization_id()) '
      || 'and ((select core.is_internal()) or (select core.is_finance())))',
      t || '_select', t
    );
  end loop;
end
$$;

-- Refunds were admin-only; the invoice page a finance user may open lists them.
drop policy if exists refunds_select on finance.refunds;
create policy refunds_select on finance.refunds
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and ((select core.is_admin()) or (select core.is_finance()))
  );

notify pgrst, 'reload schema';
