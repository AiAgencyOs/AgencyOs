-- Two org-scoped foreign keys missing the tenancy guard `node
-- scripts/verify-tenancy-guards.mjs` checks for, found while verifying an
-- unrelated migration on a fresh local instance and worth closing rather
-- than leaving for the next person to trip over:
--
--   1. finance.receipts.invoice_id and .payment_id (added by
--      20260928130000_a_payment_gets_its_own_receipt.sql) — a foreign key
--      proves the parent exists; it does not prove the receipt and the
--      invoice/payment it evidences share an organization. The table also
--      has no `freeze_organization_id` trigger, so its own organization_id
--      could be re-tenanted after the fact.
--
--   2. projects.ui_version_client_decisions.conversation_id (added by
--      20260923140000_the_client_confirms_the_locked_ui.sql) — that
--      migration guarded project_id and ui_version_id but missed this third,
--      nullable FK to crm.conversations. The table's own
--      freeze_organization_id trigger already exists and is untouched here.
--
-- Same idiom as every other org-scoped child table: `core.enforce_parent_org`
-- and `core.freeze_organization_id`, both defined once in
-- 20260815140000_a_child_belongs_to_its_parents_tenant.sql.

drop trigger if exists org_match_receipts_invoice on finance.receipts;
create trigger org_match_receipts_invoice
  before insert or update of invoice_id, organization_id on finance.receipts
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

drop trigger if exists org_match_receipts_payment on finance.receipts;
create trigger org_match_receipts_payment
  before insert or update of payment_id, organization_id on finance.receipts
  for each row execute function core.enforce_parent_org('payment_id', 'finance.payments');

drop trigger if exists freeze_org_receipts on finance.receipts;
create trigger freeze_org_receipts
  before update of organization_id on finance.receipts
  for each row execute function core.freeze_organization_id();

drop trigger if exists ui_version_client_decisions_parent_org_conversation
  on projects.ui_version_client_decisions;
create trigger ui_version_client_decisions_parent_org_conversation
  before insert or update of conversation_id, organization_id on projects.ui_version_client_decisions
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');
