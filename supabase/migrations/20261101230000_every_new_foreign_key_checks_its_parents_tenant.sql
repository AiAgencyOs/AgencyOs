-- CI (db:verify:tenancyguards) found two organization-scoped foreign keys added by Phase 5/6 without the org-consistency guard:
-- projects.tasks.baseline_id and qa.defects.duplicate_of. A child may only point at a parent of its own tenant.
drop trigger if exists tasks_parent_org_baseline_id on projects.tasks;
create trigger tasks_parent_org_baseline_id before insert or update of baseline_id on projects.tasks
  for each row execute function core.enforce_parent_org('baseline_id', 'projects.development_baselines');
drop trigger if exists defects_parent_org_duplicate_of on qa.defects;
create trigger defects_parent_org_duplicate_of before insert or update of duplicate_of on qa.defects
  for each row execute function core.enforce_parent_org('duplicate_of', 'qa.defects');
notify pgrst, 'reload schema';
