-- CI (db:verify:tenancyguards): finance.maintenance_billing_proposals.client_account_id is an organization-scoped foreign key (Phase 8B) with no
-- org-consistency guard. A proposal may only name a client account of its own tenant.
drop trigger if exists maintenance_billing_proposals_parent_org_client on finance.maintenance_billing_proposals;
create trigger maintenance_billing_proposals_parent_org_client before insert or update of client_account_id on finance.maintenance_billing_proposals
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');
notify pgrst, 'reload schema';
