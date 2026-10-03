-- Two tables added on 2026-10-03 were missed by the tenancy guards, and the
-- live verifier (scripts/verify-tenancy-guards.mjs, section 0) said so:
--
--   • sales.quotation_clauses — organization_id could be rewritten by a
--     privileged writer, moving a clause version to another tenant. The
--     organization is now frozen once written.
--   • crm.lead_files.carried_to_project_id — a lead's file link records the
--     project it was carried to; that project must belong to the same
--     organization as the row.
--
-- Same generated guards every other org-scoped table carries
-- (core.freeze_organization_id, core.enforce_parent_org). Idempotent.

drop trigger if exists freeze_org_quotation_clauses on sales.quotation_clauses;
create trigger freeze_org_quotation_clauses
  before update of organization_id on sales.quotation_clauses
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_lead_files_project on crm.lead_files;
create trigger org_match_lead_files_project
  before insert or update of carried_to_project_id, organization_id on crm.lead_files
  for each row execute function core.enforce_parent_org('carried_to_project_id', 'projects.projects');

notify pgrst, 'reload schema';
