-- ═══════════════════════════════════════════════════════════════════════════
-- Two tenancy-guard gaps, found by the live catalogue scan
-- (core.unguarded_org_fks / core.unfrozen_org_tables), not by reading source.
--
-- 1. projects.ui_version_client_decisions (20260923140000) guards its
--    project_id and ui_version_id foreign keys but not conversation_id, which
--    points at crm.conversations — also org-scoped. A service-role insert
--    could record a client decision in one org's project citing another
--    org's conversation as evidence. Predates every recent Phase 4/finance
--    change: reproducible against 106c008, the commit PR #523 branched from.
--
-- 2. finance.receipts (20260928130000) has no tenancy guards at all: neither
--    the org-match triggers for its invoice_id/payment_id foreign keys nor
--    the organization_id freeze. Same class of gap, introduced when the
--    table was added — the generator that keeps the baseline migration
--    current only ran once, at 20260815140000; every table added afterward
--    must carry its own triggers, and this one did not.
--
-- Both were invisible to every regex-based review because the tables and
-- their RLS policies are otherwise complete — this is a missing trigger, not
-- a missing column or a missing policy. Only the live catalogue scan in
-- scripts/verify-tenancy-guards.mjs (core.unguarded_org_fks /
-- core.unfrozen_org_tables) catches it, which is exactly why that check
-- exists.
-- ═══════════════════════════════════════════════════════════════════════════

drop trigger if exists org_match_ui_version_client_decisions_conversation_id on projects.ui_version_client_decisions;
create trigger org_match_ui_version_client_decisions_conversation_id
  before insert or update of conversation_id, organization_id on projects.ui_version_client_decisions
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists org_match_receipts_invoice_id on finance.receipts;
create trigger org_match_receipts_invoice_id
  before insert or update of invoice_id, organization_id on finance.receipts
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

drop trigger if exists org_match_receipts_payment_id on finance.receipts;
create trigger org_match_receipts_payment_id
  before insert or update of payment_id, organization_id on finance.receipts
  for each row execute function core.enforce_parent_org('payment_id', 'finance.payments');

drop trigger if exists freeze_org_receipts on finance.receipts;
create trigger freeze_org_receipts
  before update of organization_id on finance.receipts
  for each row execute function core.freeze_organization_id();
