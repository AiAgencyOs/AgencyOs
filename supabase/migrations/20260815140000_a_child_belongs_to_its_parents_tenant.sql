-- ═══════════════════════════════════════════════════════════════════════════
-- A child belongs to its parent's tenant.
--
-- A foreign key proves the parent EXISTS. It does not prove the child and the
-- parent belong to the same organization. Every org-scoped table carries its
-- own organization_id, and nothing checked it against the org of the row it
-- points at — so a service-role insert (the four sanctioned call sites, which
-- bypass RLS) could write a child claiming organization A while its parent
-- lives in organization B. Proven reachable: a crm.lead_activities row with
-- organization_id = A and lead_id pointing at organization B's lead was
-- accepted. RLS scopes READS by org, so such a graft then leaks one tenant's
-- data into another's view of any query that joins on the foreign key.
--
-- This closes it structurally, at the one layer a service-role write cannot
-- skip: a BEFORE trigger on every org-scoped child, for every foreign key
-- whose parent is also org-scoped, asserting the child's organization_id
-- equals the parent's. 62 relationships across 32 tables, all found from the
-- live catalogue rather than by hand.
--
-- ── why one function, applied per foreign key ─────────────────────────────
--
-- The 62 relationships are uniform where it matters: every foreign key is a
-- single column, none is DEFERRABLE (so the parent already exists when the
-- child's BEFORE trigger runs), and every org-scoped parent's organization_id
-- is NOT NULL (so the comparison is never three-valued). One SECURITY DEFINER
-- function reads the child's foreign-key value and the parent table from its
-- trigger arguments, looks the parent's org up by primary key, and refuses a
-- mismatch. Each trigger names its own column and parent, so the rule is
-- legible per relationship while the logic lives in one place.
--
-- ── what it deliberately allows ──────────────────────────────────────────
--
--   • A NULL foreign key — a nullable or a just-nulled (ON DELETE SET NULL)
--     reference has no parent to match, so the check is skipped. This is what
--     lets a legitimate cascade through: deleting a parent that sets the
--     child's fk to null fires this trigger with a null fk, and it passes.
--   • A parent that does not exist — the foreign-key constraint itself refuses
--     that; this trigger does not duplicate it, it returns and lets the FK
--     speak.
--   • A DELETE — removing a child grafts nothing, so DELETE is not guarded
--     here (the tables that must resist deletion have their own guards).
--
-- Fires on INSERT and on UPDATE OF the foreign key or organization_id, because
-- a reparent (moving the fk to a different-org parent) and a re-tenant
-- (changing the child's own org) are two of the three ways a mismatch appears
-- after creation.
--
-- ── the third way, and why organization_id is frozen ──────────────────────
--
-- The child-side triggers cannot see the third: changing the PARENT's
-- organization_id. When a parent is re-tenanted, its existing children keep
-- the old org and become mismatched, and nothing on the child fires. A child
-- trigger cannot close a parent-side move.
--
-- So the invariant is completed from the other end: organization_id is
-- IMMUTABLE on every org-scoped table (audit.audit_log excepted — it is
-- already fully append-only). A row never changes tenant. Nothing in the
-- application or the SQL layer updates organization_id — it is set once at
-- insert and read forever after — so freezing it forbids only the forgery.
-- With the column frozen, both re-tenant moves (parent's and child's own)
-- become impossible, and the child→parent triggers above close creation and
-- reparenting; together the invariant holds no matter which side is written.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.freeze_organization_id()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception
      'tenancy: %.%.organization_id is immutable — a row does not change tenant (was %, tried %)',
      tg_table_schema, tg_table_name, old.organization_id, new.organization_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function core.freeze_organization_id() is
  'Refuses any change to a row''s organization_id. A row never changes tenant; nothing in the application or SQL layer updates organization_id, so this forbids only a forgery. Closes the parent-side re-tenant that a child-side org-match trigger cannot see: re-tenanting a parent would otherwise orphan its children into a cross-tenant mismatch.';

create or replace function core.enforce_parent_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fk_col   text := tg_argv[0];
  v_parent   text := tg_argv[1];  -- 'schema.table'
  v_fk       uuid;
  v_parent_org uuid;
begin
  v_fk := (to_jsonb(new) ->> v_fk_col)::uuid;

  -- A null reference has no parent to match. Nullable columns and the null a
  -- SET NULL cascade writes both land here; skipping them is what keeps a
  -- legitimate parent deletion from being refused.
  if v_fk is null then
    return new;
  end if;

  execute format('select organization_id from %s where id = $1', v_parent)
    into v_parent_org using v_fk;

  -- The parent does not exist yet. The foreign-key constraint will refuse it;
  -- this trigger does not re-raise, it defers to the FK.
  if v_parent_org is null then
    return new;
  end if;

  -- Every org-scoped parent's organization_id is NOT NULL and the child's is
  -- NOT NULL, so this comparison is total — no three-valued escape.
  if v_parent_org <> new.organization_id then
    raise exception
      'tenancy: %.% names organization % but its % (%) belongs to organization %',
      tg_table_schema, tg_table_name, new.organization_id, v_fk_col, v_fk, v_parent_org
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function core.enforce_parent_org() is
  'Refuses an org-scoped child row whose organization_id does not match the organization of the parent named by its foreign key (tg_argv: fk column, parent table). A foreign key proves the parent exists; this proves they share a tenant. Skips a null fk (nullable or SET-NULL cascade) and a not-yet-existent parent (the FK refuses that). Applied per foreign key to every org-scoped child whose parent is also org-scoped.';

-- The one hand-written predecessor becomes redundant: enforce_follow_up_send_tenancy
-- checked exactly this for crm.follow_up_sends.sequence_id. Dropped so the
-- uniform pattern is the only one, and re-covered by the generated trigger below.
drop trigger if exists enforce_follow_up_send_tenancy on crm.follow_up_sends;
drop function if exists crm.enforce_follow_up_send_tenancy();

-- ── completeness, kept honest over time ───────────────────────────────────
--
-- The triggers below were generated from the live catalogue. A table added
-- LATER with an org-scoped foreign key and no guard would silently reopen the
-- graft. This function lists exactly those — every org-scoped foreign key
-- whose parent is org-scoped and which has no `org_match_%` trigger — so the
-- verify script can assert the list is empty rather than trusting the
-- generation stayed current.

create or replace function core.unguarded_org_fks()
returns table (child text, fk_column text, parent text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.conrelid::regclass::text,
         a.attname::text,
         c.confrelid::regclass::text
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.contype = 'f'
     and array_length(c.conkey, 1) = 1
     and a.attname <> 'organization_id'
     and exists (select 1 from pg_attribute oa
                  where oa.attrelid = c.conrelid and oa.attname = 'organization_id' and not oa.attisdropped)
     and exists (select 1 from pg_attribute pa
                  where pa.attrelid = c.confrelid and pa.attname = 'organization_id' and not pa.attisdropped)
     and not exists (
       -- Matched by FUNCTION and ARGUMENT, not by a reconstructed trigger name:
       -- a name would be brittle to identifier quoting and the 63-byte
       -- truncation Postgres applies silently. The fk column is the trigger's
       -- first argument, visible in its definition.
       select 1 from pg_trigger t
        where t.tgrelid = c.conrelid
          and not t.tgisinternal
          and t.tgfoid = 'core.enforce_parent_org'::regproc
          and pg_get_triggerdef(t.oid) like '%enforce_parent_org(''' || a.attname || '''%'
     );
$$;

comment on function core.unguarded_org_fks() is
  'Every org-scoped foreign key (to an org-scoped parent) that has no org-consistency guard. Empty when the tenancy guards are complete; a row here is a table added without a guard, reopening the cross-tenant graft. Matched by function+argument rather than trigger name (robust to identifier quoting and 63-byte truncation). Asserted empty by scripts/verify-tenancy-guards.mjs.';

revoke all on function core.unguarded_org_fks() from public;
grant execute on function core.unguarded_org_fks() to service_role;

-- The companion completeness check for the freeze: org-scoped tables whose
-- organization_id is not immutable. audit.audit_log is exempt (already fully
-- append-only via its no-update trigger).
create or replace function core.unfrozen_org_tables()
returns table (org_table text)
language sql
stable
security definer
set search_path = ''
as $$
  select (n.nspname || '.' || c.relname)::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
   where c.relkind = 'r'
     and n.nspname in ('core','crm','sales','projects','finance','qa','ai','approvals','audit')
     and (n.nspname, c.relname) <> ('audit', 'audit_log')
     and not exists (
       select 1 from pg_trigger t
        where t.tgrelid = c.oid
          and not t.tgisinternal
          and t.tgfoid = 'core.freeze_organization_id'::regproc
     )
   order by 1;
$$;

comment on function core.unfrozen_org_tables() is
  'Every org-scoped table (audit.audit_log excepted) whose organization_id is not frozen against UPDATE. Empty when the immutability is complete; a row is a table that can be re-tenanted, orphaning its children. Asserted empty by scripts/verify-tenancy-guards.mjs.';

revoke all on function core.unfrozen_org_tables() from public;
grant execute on function core.unfrozen_org_tables() to service_role;

-- ── the generated triggers, one per org-scoped foreign key ────────────────

drop trigger if exists org_match_agent_steps_run_id on ai.agent_steps;
create trigger org_match_agent_steps_run_id
  before insert or update of run_id, organization_id on ai.agent_steps
  for each row execute function core.enforce_parent_org('run_id', 'ai.agent_runs');

drop trigger if exists org_match_handoffs_project_id on ai.handoffs;
create trigger org_match_handoffs_project_id
  before insert or update of project_id, organization_id on ai.handoffs
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_approval_requests_client_contact_id on approvals.approval_requests;
create trigger org_match_approval_requests_client_contact_id
  before insert or update of client_contact_id, organization_id on approvals.approval_requests
  for each row execute function core.enforce_parent_org('client_contact_id', 'crm.contacts');

drop trigger if exists org_match_approval_requests_escalated_from on approvals.approval_requests;
create trigger org_match_approval_requests_escalated_from
  before insert or update of escalated_from, organization_id on approvals.approval_requests
  for each row execute function core.enforce_parent_org('escalated_from', 'approvals.approval_requests');

drop trigger if exists org_match_approval_requests_policy_id on approvals.approval_requests;
create trigger org_match_approval_requests_policy_id
  before insert or update of policy_id, organization_id on approvals.approval_requests
  for each row execute function core.enforce_parent_org('policy_id', 'approvals.approval_policies');

drop trigger if exists org_match_client_users_client_account_id on core.client_users;
create trigger org_match_client_users_client_account_id
  before insert or update of client_account_id, organization_id on core.client_users
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_communication_consent_contact_id on crm.communication_consent;
create trigger org_match_communication_consent_contact_id
  before insert or update of contact_id, organization_id on crm.communication_consent
  for each row execute function core.enforce_parent_org('contact_id', 'crm.contacts');

drop trigger if exists org_match_contacts_client_account_id on crm.contacts;
create trigger org_match_contacts_client_account_id
  before insert or update of client_account_id, organization_id on crm.contacts
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_conversation_messages_conversation_id on crm.conversation_messages;
create trigger org_match_conversation_messages_conversation_id
  before insert or update of conversation_id, organization_id on crm.conversation_messages
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists org_match_conversations_contact_id on crm.conversations;
create trigger org_match_conversations_contact_id
  before insert or update of contact_id, organization_id on crm.conversations
  for each row execute function core.enforce_parent_org('contact_id', 'crm.contacts');

drop trigger if exists org_match_conversations_lead_id on crm.conversations;
create trigger org_match_conversations_lead_id
  before insert or update of lead_id, organization_id on crm.conversations
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

drop trigger if exists org_match_conversations_project_id on crm.conversations;
create trigger org_match_conversations_project_id
  before insert or update of project_id, organization_id on crm.conversations
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_follow_up_sends_message_id on crm.follow_up_sends;
create trigger org_match_follow_up_sends_message_id
  before insert or update of message_id, organization_id on crm.follow_up_sends
  for each row execute function core.enforce_parent_org('message_id', 'crm.conversation_messages');

drop trigger if exists org_match_follow_up_sends_sequence_id on crm.follow_up_sends;
create trigger org_match_follow_up_sends_sequence_id
  before insert or update of sequence_id, organization_id on crm.follow_up_sends
  for each row execute function core.enforce_parent_org('sequence_id', 'crm.follow_up_sequences');

drop trigger if exists org_match_follow_up_sequences_contact_id on crm.follow_up_sequences;
create trigger org_match_follow_up_sequences_contact_id
  before insert or update of contact_id, organization_id on crm.follow_up_sequences
  for each row execute function core.enforce_parent_org('contact_id', 'crm.contacts');

drop trigger if exists org_match_follow_up_sequences_conversation_id on crm.follow_up_sequences;
create trigger org_match_follow_up_sequences_conversation_id
  before insert or update of conversation_id, organization_id on crm.follow_up_sequences
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists org_match_lead_activities_lead_id on crm.lead_activities;
create trigger org_match_lead_activities_lead_id
  before insert or update of lead_id, organization_id on crm.lead_activities
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

drop trigger if exists org_match_leads_contact_id on crm.leads;
create trigger org_match_leads_contact_id
  before insert or update of contact_id, organization_id on crm.leads
  for each row execute function core.enforce_parent_org('contact_id', 'crm.contacts');

drop trigger if exists org_match_requirement_versions_conversation_id on crm.requirement_versions;
create trigger org_match_requirement_versions_conversation_id
  before insert or update of conversation_id, organization_id on crm.requirement_versions
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists org_match_invoice_items_invoice_id on finance.invoice_items;
create trigger org_match_invoice_items_invoice_id
  before insert or update of invoice_id, organization_id on finance.invoice_items
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

drop trigger if exists org_match_invoices_client_account_id on finance.invoices;
create trigger org_match_invoices_client_account_id
  before insert or update of client_account_id, organization_id on finance.invoices
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_invoices_milestone_id on finance.invoices;
create trigger org_match_invoices_milestone_id
  before insert or update of milestone_id, organization_id on finance.invoices
  for each row execute function core.enforce_parent_org('milestone_id', 'projects.milestones');

drop trigger if exists org_match_invoices_project_id on finance.invoices;
create trigger org_match_invoices_project_id
  before insert or update of project_id, organization_id on finance.invoices
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_payments_invoice_id on finance.payments;
create trigger org_match_payments_invoice_id
  before insert or update of invoice_id, organization_id on finance.payments
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

drop trigger if exists org_match_refunds_approval_request_id on finance.refunds;
create trigger org_match_refunds_approval_request_id
  before insert or update of approval_request_id, organization_id on finance.refunds
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');

drop trigger if exists org_match_refunds_invoice_id on finance.refunds;
create trigger org_match_refunds_invoice_id
  before insert or update of invoice_id, organization_id on finance.refunds
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

drop trigger if exists org_match_deliverables_approval_request_id on projects.deliverables;
create trigger org_match_deliverables_approval_request_id
  before insert or update of approval_request_id, organization_id on projects.deliverables
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');

drop trigger if exists org_match_deliverables_module_id on projects.deliverables;
create trigger org_match_deliverables_module_id
  before insert or update of module_id, organization_id on projects.deliverables
  for each row execute function core.enforce_parent_org('module_id', 'projects.modules');

drop trigger if exists org_match_deliverables_project_id on projects.deliverables;
create trigger org_match_deliverables_project_id
  before insert or update of project_id, organization_id on projects.deliverables
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_features_module_id on projects.features;
create trigger org_match_features_module_id
  before insert or update of module_id, organization_id on projects.features
  for each row execute function core.enforce_parent_org('module_id', 'projects.modules');

drop trigger if exists org_match_features_project_id on projects.features;
create trigger org_match_features_project_id
  before insert or update of project_id, organization_id on projects.features
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_features_requirement_version_id on projects.features;
create trigger org_match_features_requirement_version_id
  before insert or update of requirement_version_id, organization_id on projects.features
  for each row execute function core.enforce_parent_org('requirement_version_id', 'crm.requirement_versions');

drop trigger if exists org_match_handover_items_handover_id on projects.handover_items;
create trigger org_match_handover_items_handover_id
  before insert or update of handover_id, organization_id on projects.handover_items
  for each row execute function core.enforce_parent_org('handover_id', 'projects.handovers');

drop trigger if exists org_match_handovers_approval_request_id on projects.handovers;
create trigger org_match_handovers_approval_request_id
  before insert or update of approval_request_id, organization_id on projects.handovers
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');

drop trigger if exists org_match_handovers_project_id on projects.handovers;
create trigger org_match_handovers_project_id
  before insert or update of project_id, organization_id on projects.handovers
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_maintenance_items_client_account_id on projects.maintenance_items;
create trigger org_match_maintenance_items_client_account_id
  before insert or update of client_account_id, organization_id on projects.maintenance_items
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_maintenance_items_project_id on projects.maintenance_items;
create trigger org_match_maintenance_items_project_id
  before insert or update of project_id, organization_id on projects.maintenance_items
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_milestones_project_id on projects.milestones;
create trigger org_match_milestones_project_id
  before insert or update of project_id, organization_id on projects.milestones
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_milestones_requires_deliverable_id on projects.milestones;
create trigger org_match_milestones_requires_deliverable_id
  before insert or update of requires_deliverable_id, organization_id on projects.milestones
  for each row execute function core.enforce_parent_org('requires_deliverable_id', 'projects.deliverables');

drop trigger if exists org_match_modules_project_id on projects.modules;
create trigger org_match_modules_project_id
  before insert or update of project_id, organization_id on projects.modules
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_modules_requirement_version_id on projects.modules;
create trigger org_match_modules_requirement_version_id
  before insert or update of requirement_version_id, organization_id on projects.modules
  for each row execute function core.enforce_parent_org('requirement_version_id', 'crm.requirement_versions');

drop trigger if exists org_match_onboarding_items_project_id on projects.onboarding_items;
create trigger org_match_onboarding_items_project_id
  before insert or update of project_id, organization_id on projects.onboarding_items
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_projects_client_account_id on projects.projects;
create trigger org_match_projects_client_account_id
  before insert or update of client_account_id, organization_id on projects.projects
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_projects_opportunity_id on projects.projects;
create trigger org_match_projects_opportunity_id
  before insert or update of opportunity_id, organization_id on projects.projects
  for each row execute function core.enforce_parent_org('opportunity_id', 'sales.opportunities');

drop trigger if exists org_match_projects_proposal_id on projects.projects;
create trigger org_match_projects_proposal_id
  before insert or update of proposal_id, organization_id on projects.projects
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');

drop trigger if exists org_match_tasks_feature_id on projects.tasks;
create trigger org_match_tasks_feature_id
  before insert or update of feature_id, organization_id on projects.tasks
  for each row execute function core.enforce_parent_org('feature_id', 'projects.features');

drop trigger if exists org_match_tasks_milestone_id on projects.tasks;
create trigger org_match_tasks_milestone_id
  before insert or update of milestone_id, organization_id on projects.tasks
  for each row execute function core.enforce_parent_org('milestone_id', 'projects.milestones');

drop trigger if exists org_match_tasks_module_id on projects.tasks;
create trigger org_match_tasks_module_id
  before insert or update of module_id, organization_id on projects.tasks
  for each row execute function core.enforce_parent_org('module_id', 'projects.modules');

drop trigger if exists org_match_tasks_project_id on projects.tasks;
create trigger org_match_tasks_project_id
  before insert or update of project_id, organization_id on projects.tasks
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_tasks_requirement_version_id on projects.tasks;
create trigger org_match_tasks_requirement_version_id
  before insert or update of requirement_version_id, organization_id on projects.tasks
  for each row execute function core.enforce_parent_org('requirement_version_id', 'crm.requirement_versions');

drop trigger if exists org_match_defects_deliverable_id on qa.defects;
create trigger org_match_defects_deliverable_id
  before insert or update of deliverable_id, organization_id on qa.defects
  for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');

drop trigger if exists org_match_defects_project_id on qa.defects;
create trigger org_match_defects_project_id
  before insert or update of project_id, organization_id on qa.defects
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_opportunities_client_account_id on sales.opportunities;
create trigger org_match_opportunities_client_account_id
  before insert or update of client_account_id, organization_id on sales.opportunities
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_opportunities_lead_id on sales.opportunities;
create trigger org_match_opportunities_lead_id
  before insert or update of lead_id, organization_id on sales.opportunities
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

drop trigger if exists org_match_proposal_items_proposal_id on sales.proposal_items;
create trigger org_match_proposal_items_proposal_id
  before insert or update of proposal_id, organization_id on sales.proposal_items
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');

drop trigger if exists org_match_proposals_approval_request_id on sales.proposals;
create trigger org_match_proposals_approval_request_id
  before insert or update of approval_request_id, organization_id on sales.proposals
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');

drop trigger if exists org_match_proposals_conversation_id on sales.proposals;
create trigger org_match_proposals_conversation_id
  before insert or update of conversation_id, organization_id on sales.proposals
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists org_match_proposals_opportunity_id on sales.proposals;
create trigger org_match_proposals_opportunity_id
  before insert or update of opportunity_id, organization_id on sales.proposals
  for each row execute function core.enforce_parent_org('opportunity_id', 'sales.opportunities');

drop trigger if exists org_match_proposals_requirement_version_id on sales.proposals;
create trigger org_match_proposals_requirement_version_id
  before insert or update of requirement_version_id, organization_id on sales.proposals
  for each row execute function core.enforce_parent_org('requirement_version_id', 'crm.requirement_versions');

drop trigger if exists org_match_proposals_responded_by_contact_id on sales.proposals;
create trigger org_match_proposals_responded_by_contact_id
  before insert or update of responded_by_contact_id, organization_id on sales.proposals
  for each row execute function core.enforce_parent_org('responded_by_contact_id', 'crm.contacts');

drop trigger if exists org_match_upsell_signals_client_account_id on sales.upsell_signals;
create trigger org_match_upsell_signals_client_account_id
  before insert or update of client_account_id, organization_id on sales.upsell_signals
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_upsell_signals_project_id on sales.upsell_signals;
create trigger org_match_upsell_signals_project_id
  before insert or update of project_id, organization_id on sales.upsell_signals
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

-- generated 62 triggers across 32 child tables

-- ── organization_id is frozen on every org-scoped table ──────────────────

drop trigger if exists freeze_org_agent_runs on ai.agent_runs;
create trigger freeze_org_agent_runs
  before update of organization_id on ai.agent_runs
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_agent_steps on ai.agent_steps;
create trigger freeze_org_agent_steps
  before update of organization_id on ai.agent_steps
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_cost_ledger on ai.cost_ledger;
create trigger freeze_org_cost_ledger
  before update of organization_id on ai.cost_ledger
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_handoffs on ai.handoffs;
create trigger freeze_org_handoffs
  before update of organization_id on ai.handoffs
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_models on ai.models;
create trigger freeze_org_models
  before update of organization_id on ai.models
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_routing_policies on ai.routing_policies;
create trigger freeze_org_routing_policies
  before update of organization_id on ai.routing_policies
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_approval_policies on approvals.approval_policies;
create trigger freeze_org_approval_policies
  before update of organization_id on approvals.approval_policies
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_approval_requests on approvals.approval_requests;
create trigger freeze_org_approval_requests
  before update of organization_id on approvals.approval_requests
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_client_accounts on core.client_accounts;
create trigger freeze_org_client_accounts
  before update of organization_id on core.client_accounts
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_client_users on core.client_users;
create trigger freeze_org_client_users
  before update of organization_id on core.client_users
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_jobs on core.jobs;
create trigger freeze_org_jobs
  before update of organization_id on core.jobs
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_memberships on core.memberships;
create trigger freeze_org_memberships
  before update of organization_id on core.memberships
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_outbox_events on core.outbox_events;
create trigger freeze_org_outbox_events
  before update of organization_id on core.outbox_events
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_communication_consent on crm.communication_consent;
create trigger freeze_org_communication_consent
  before update of organization_id on crm.communication_consent
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_contacts on crm.contacts;
create trigger freeze_org_contacts
  before update of organization_id on crm.contacts
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_conversation_messages on crm.conversation_messages;
create trigger freeze_org_conversation_messages
  before update of organization_id on crm.conversation_messages
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_conversations on crm.conversations;
create trigger freeze_org_conversations
  before update of organization_id on crm.conversations
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_follow_up_sends on crm.follow_up_sends;
create trigger freeze_org_follow_up_sends
  before update of organization_id on crm.follow_up_sends
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_follow_up_sequences on crm.follow_up_sequences;
create trigger freeze_org_follow_up_sequences
  before update of organization_id on crm.follow_up_sequences
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_lead_activities on crm.lead_activities;
create trigger freeze_org_lead_activities
  before update of organization_id on crm.lead_activities
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_leads on crm.leads;
create trigger freeze_org_leads
  before update of organization_id on crm.leads
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_portfolio_items on crm.portfolio_items;
create trigger freeze_org_portfolio_items
  before update of organization_id on crm.portfolio_items
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_requirement_versions on crm.requirement_versions;
create trigger freeze_org_requirement_versions
  before update of organization_id on crm.requirement_versions
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_invoice_items on finance.invoice_items;
create trigger freeze_org_invoice_items
  before update of organization_id on finance.invoice_items
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_invoices on finance.invoices;
create trigger freeze_org_invoices
  before update of organization_id on finance.invoices
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_payments on finance.payments;
create trigger freeze_org_payments
  before update of organization_id on finance.payments
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_refunds on finance.refunds;
create trigger freeze_org_refunds
  before update of organization_id on finance.refunds
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_deliverables on projects.deliverables;
create trigger freeze_org_deliverables
  before update of organization_id on projects.deliverables
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_features on projects.features;
create trigger freeze_org_features
  before update of organization_id on projects.features
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_handover_items on projects.handover_items;
create trigger freeze_org_handover_items
  before update of organization_id on projects.handover_items
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_handovers on projects.handovers;
create trigger freeze_org_handovers
  before update of organization_id on projects.handovers
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_maintenance_items on projects.maintenance_items;
create trigger freeze_org_maintenance_items
  before update of organization_id on projects.maintenance_items
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_milestones on projects.milestones;
create trigger freeze_org_milestones
  before update of organization_id on projects.milestones
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_modules on projects.modules;
create trigger freeze_org_modules
  before update of organization_id on projects.modules
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_onboarding_baseline on projects.onboarding_baseline;
create trigger freeze_org_onboarding_baseline
  before update of organization_id on projects.onboarding_baseline
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_onboarding_items on projects.onboarding_items;
create trigger freeze_org_onboarding_items
  before update of organization_id on projects.onboarding_items
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_projects on projects.projects;
create trigger freeze_org_projects
  before update of organization_id on projects.projects
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_tasks on projects.tasks;
create trigger freeze_org_tasks
  before update of organization_id on projects.tasks
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_defects on qa.defects;
create trigger freeze_org_defects
  before update of organization_id on qa.defects
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_opportunities on sales.opportunities;
create trigger freeze_org_opportunities
  before update of organization_id on sales.opportunities
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_proposal_items on sales.proposal_items;
create trigger freeze_org_proposal_items
  before update of organization_id on sales.proposal_items
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_proposals on sales.proposals;
create trigger freeze_org_proposals
  before update of organization_id on sales.proposals
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_upsell_signals on sales.upsell_signals;
create trigger freeze_org_upsell_signals
  before update of organization_id on sales.upsell_signals
  for each row execute function core.freeze_organization_id();

-- 43 freeze triggers (audit.audit_log excluded: already fully immutable)
