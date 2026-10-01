-- The tenancy verifier (scripts/verify-tenancy-guards.mjs, section 0) found
-- four org-scoped foreign keys and one table the 2026-10-06 build streams
-- left unguarded: crm.announcements.milestone_id and .template_id,
-- crm.delivery_retry_reasons.original_id and .retry_id, and
-- projects.project_defaults.organization_id (re-tenantable). Same generated
-- guards every other org-scoped table carries. Idempotent.

drop trigger if exists org_match_announcements_milestone on crm.announcements;
create trigger org_match_announcements_milestone
  before insert or update of milestone_id, organization_id on crm.announcements
  for each row execute function core.enforce_parent_org('milestone_id', 'projects.milestones');

drop trigger if exists org_match_announcements_template on crm.announcements;
create trigger org_match_announcements_template
  before insert or update of template_id, organization_id on crm.announcements
  for each row execute function core.enforce_parent_org('template_id', 'crm.announcement_templates');

drop trigger if exists org_match_retry_reasons_original on crm.delivery_retry_reasons;
create trigger org_match_retry_reasons_original
  before insert or update of original_id, organization_id on crm.delivery_retry_reasons
  for each row execute function core.enforce_parent_org('original_id', 'crm.conversation_messages');

drop trigger if exists org_match_retry_reasons_retry on crm.delivery_retry_reasons;
create trigger org_match_retry_reasons_retry
  before insert or update of retry_id, organization_id on crm.delivery_retry_reasons
  for each row execute function core.enforce_parent_org('retry_id', 'crm.conversation_messages');

drop trigger if exists freeze_org_project_defaults on projects.project_defaults;
create trigger freeze_org_project_defaults
  before update of organization_id on projects.project_defaults
  for each row execute function core.freeze_organization_id();

notify pgrst, 'reload schema';
