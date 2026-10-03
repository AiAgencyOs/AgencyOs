-- Two tables shipped without the tenancy guards every other org-scoped table
-- carries. `npm run db:verify:tenancyguards` names them:
--
--   finance.receipts                       invoice_id, payment_id, and no freeze
--   projects.ui_version_client_decisions   conversation_id
--
-- Without the guard a write that names a parent in ANOTHER organization is
-- accepted (RLS only constrains the row's own organization_id, not the
-- parent it points at), and without the freeze an UPDATE can re-tenant a row.
-- Same triggers, same functions, as every sibling table. Additive: no data
-- changes, nothing existing is refused retroactively.

create trigger receipts_parent_org_invoice
  before insert or update of invoice_id on finance.receipts
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

create trigger receipts_parent_org_payment
  before insert or update of payment_id on finance.receipts
  for each row execute function core.enforce_parent_org('payment_id', 'finance.payments');

create trigger receipts_freeze_org
  before update of organization_id on finance.receipts
  for each row execute function core.freeze_organization_id();

create trigger ui_version_client_decisions_parent_org_conversation
  before insert or update of conversation_id on projects.ui_version_client_decisions
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');
