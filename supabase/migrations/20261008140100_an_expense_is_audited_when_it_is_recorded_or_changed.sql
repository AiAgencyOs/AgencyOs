-- SCR-055 checklist: "Every significant action writes an activity/audit event."
--
-- Recording an expense and correcting one were direct writes to
-- finance.expenses (the owner and ops admin hold the table's own write
-- policy), and nothing wrote an audit row for either: `audit.audit_log` held
-- six expense-CATEGORY entries and no expense entry. A cost that moves a
-- project's margin could be added, changed or re-pointed at another project
-- with no history of who did it or what it said before.
--
-- A trigger, as G-093 decided for business rows (it covers every path into
-- the table, including PostgREST and psql, and a row never written can never
-- be written later because the log is append-only). It records the fields a
-- margin depends on, before and after, and whether a receipt is attached; it
-- never records the receipt's storage path or link. A change that touches no
-- business column (the updated_at stamp) records nothing.
--
-- INSERT and UPDATE only, like audit.record_row_change: no path deletes an
-- expense, and an organization's cascade delete must not try to write a row
-- about a tenant that is going away. Additive and idempotent.

create or replace function finance.audit_expense_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
  v_after  jsonb;
begin
  v_after := jsonb_build_object(
    'project_id', new.project_id,
    'category', new.category,
    'vendor', new.vendor,
    'description', new.description,
    'amount_minor', new.amount_minor,
    'currency', new.currency,
    'incurred_on', new.incurred_on,
    'has_receipt', (new.receipt_url is not null or new.receipt_storage_path is not null)
  );

  if tg_op = 'UPDATE' then
    v_before := jsonb_build_object(
      'project_id', old.project_id,
      'category', old.category,
      'vendor', old.vendor,
      'description', old.description,
      'amount_minor', old.amount_minor,
      'currency', old.currency,
      'incurred_on', old.incurred_on,
      'has_receipt', (old.receipt_url is not null or old.receipt_storage_path is not null)
    );
    -- Nothing a person would call a change (a receipt replaced by another of
    -- the same kind is not a margin change either): stay silent.
    if v_before = v_after
       and old.receipt_url is not distinct from new.receipt_url
       and old.receipt_storage_path is not distinct from new.receipt_storage_path then
      return null;
    end if;
  end if;

  perform core.record_audit(
    new.organization_id,
    case when tg_op = 'INSERT' then 'finance.expense_recorded' else 'finance.expense_updated' end,
    'expense',
    new.id,
    v_before,
    v_after
  );
  return null;
end;
$$;

comment on function finance.audit_expense_change() is
  'Writes finance.expense_recorded / finance.expense_updated to audit.audit_log from the transaction that changed finance.expenses (SCR-055), with the margin-relevant fields before and after. INSERT and UPDATE only; silent on a change that touches no business column.';

revoke all on function finance.audit_expense_change() from public, anon, authenticated;

drop trigger if exists audit_expense_change on finance.expenses;
create trigger audit_expense_change
  after insert or update on finance.expenses
  for each row execute function finance.audit_expense_change();
