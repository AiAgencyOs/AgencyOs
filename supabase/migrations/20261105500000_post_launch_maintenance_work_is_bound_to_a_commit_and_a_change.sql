-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 (part B): post-launch maintenance engineering, and the governance around it.
--
-- WHAT THIS IS: the deterministic records and doors for work done on a project AFTER launch. Phase 8's Developer spec says it in four rules:
--   * implement approved work only: a fix is tied to a defect, a covered maintenance ticket or a Change Request, never to "free scope";
--   * every change names the EXACT commit it is, and a different commit is different work (QA evidence and approvals never transfer);
--   * a fix is never the client's problem solved until an INDEPENDENT QA result exists on that commit ("developer self-report is not QA evidence");
--   * a release needs its own Admin approval, and the person who raised or built the change cannot be the one who approves it.
--
-- WHAT THIS IS NOT: nothing here deploys, merges, writes to GitHub, sends anything to a client, verifies a payment, or runs a model. "released" is a
-- fact a person records, with a deployment reference and smoke evidence, after the deployment happened somewhere else; AgencyOS asserts nothing
-- it did not see. No agent holds a door in this file except the one service-role proposal door at the bottom, and it writes drafts a person decides.
--
-- What is reused, not rebuilt:
--   * projects.maintenance_items            the ticket (Doc 18 section 6 coverage line): warranty/maintenance only; an out-of-scope request is a Change Request
--   * qa.defects + qa.unresolved_product_defects + qa.record_retest   the Phase 6 defect loop: a defect-linked fix needs the defect VERIFIED by an independent retest
--   * projects.change_requests (+ finance.invoices through invoice_id)  an enhancement needs an APPROVED change request, and a paid one needs its invoice PAID AND VERIFIED
--   * core.enforce_parent_org / core.freeze_organization_id / core.emit_event / core.record_audit
--
-- Deliberately absent, each with its reason:
--   * No SLA hours are invented. projects.maintenance_sla_policies is EMPTY until an Admin sets a policy; routing then reports the SLA as unknown
--     rather than making one up (20260821260000 declined SLA numbers for the same reason: no document makes a commitment).
--   * No price anywhere. A paid change is priced on sales.proposals; this file only READS whether its invoice was verified paid.
--   * No auto-release, no auto-merge, no auto-deploy: the approval is the end of what AgencyOS decides.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the work item ───────────────────────────────────────────────────────────
create table if not exists projects.maintenance_work_items (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  client_account_id        uuid not null references core.client_accounts(id) on delete restrict,
  project_id               uuid not null references projects.projects(id) on delete cascade,
  kind                     text not null check (kind in ('hotfix', 'patch', 'enhancement')),
  area                     text not null check (area in ('frontend', 'backend', 'database', 'mobile', 'integration', 'devops', 'dependency')),
  title                    text not null check (length(btrim(title)) > 0 and length(title) <= 300),
  description              text check (description is null or length(description) <= 4000),
  -- what authorizes the work. At least one is required; an enhancement needs the change request.
  ticket_id                uuid references projects.maintenance_items(id) on delete restrict,
  defect_id                uuid references qa.defects(id) on delete restrict,
  change_request_id        uuid references projects.change_requests(id) on delete restrict,
  emergency                boolean not null default false,
  emergency_authorized_by  uuid references core.users(id) on delete restrict,
  emergency_authorized_at  timestamptz,
  -- the author says the change touches auth / payments / migrations / secrets: a security QA result is then required
  sensitive                boolean not null default false,
  status                   text not null default 'open' check (status in ('open', 'fix_submitted', 'changes_requested', 'qa_passed', 'release_review', 'release_approved', 'released', 'cancelled')),
  commit_ref               text check (commit_ref is null or commit_ref ~ '^[0-9a-f]{40}$'),
  commit_submitted_by      uuid references core.users(id) on delete set null,
  commit_submitted_at      timestamptz,
  fix_summary              text check (fix_summary is null or length(fix_summary) <= 4000),
  rollback_plan            text check (rollback_plan is null or length(rollback_plan) <= 4000),
  rollback_owner           text check (rollback_owner is null or length(rollback_owner) <= 200),
  release_requested_by     uuid references core.users(id) on delete set null,
  release_requested_commit text check (release_requested_commit is null or release_requested_commit ~ '^[0-9a-f]{40}$'),
  approved_commit          text check (approved_commit is null or approved_commit ~ '^[0-9a-f]{40}$'),
  release_approved_by      uuid references core.users(id) on delete set null,
  release_approved_at      timestamptz,
  deployment_ref           text,
  smoke_evidence_ref       text,
  released_by              uuid references core.users(id) on delete set null,
  released_at              timestamptz,
  cancelled_reason         text,
  created_by               uuid not null references core.users(id) on delete restrict,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- never free scope
  constraint maintenance_work_is_authorized check (ticket_id is not null or defect_id is not null or change_request_id is not null),
  constraint maintenance_enhancement_has_a_change_request check (kind <> 'enhancement' or change_request_id is not null),
  constraint maintenance_emergency_is_authorized check (not emergency or (kind = 'hotfix' and emergency_authorized_by is not null and emergency_authorized_at is not null)),
  -- a submitted state always has its commit
  constraint maintenance_state_has_its_commit check (status in ('open', 'cancelled') or (commit_ref is not null and commit_submitted_by is not null)),
  constraint maintenance_approval_is_of_the_exact_commit check (status not in ('release_approved', 'released') or (approved_commit is not null and approved_commit = commit_ref and release_approved_by is not null)),
  constraint maintenance_release_is_evidenced check (status <> 'released' or (released_by is not null and released_at is not null and length(btrim(coalesce(deployment_ref, ''))) > 0 and length(btrim(coalesce(smoke_evidence_ref, ''))) > 0)),
  constraint maintenance_cancel_says_why check (status <> 'cancelled' or length(btrim(coalesce(cancelled_reason, ''))) > 0)
);
-- one LIVE work item per authorizing record: the same defect / change request / ticket cannot be worked twice at once
create unique index if not exists maintenance_work_one_live_per_defect on projects.maintenance_work_items (defect_id) where defect_id is not null and status not in ('released', 'cancelled');
create unique index if not exists maintenance_work_one_live_per_change_request on projects.maintenance_work_items (change_request_id) where change_request_id is not null and status not in ('released', 'cancelled');
create unique index if not exists maintenance_work_one_live_per_ticket on projects.maintenance_work_items (ticket_id) where ticket_id is not null and status not in ('released', 'cancelled');
create index if not exists maintenance_work_project_idx on projects.maintenance_work_items (project_id, created_at desc);

-- every commit ever submitted for an item: a different commit is a different change, and what was submitted before stays on the record
create table if not exists projects.maintenance_work_commits (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  work_item_id     uuid not null references projects.maintenance_work_items(id) on delete cascade,
  commit_ref       text not null check (commit_ref ~ '^[0-9a-f]{40}$'),
  summary          text not null check (length(btrim(summary)) > 0 and length(summary) <= 4000),
  submitted_by     uuid not null references core.users(id) on delete restrict,
  submitted_at     timestamptz not null default clock_timestamp(),
  unique (work_item_id, commit_ref)
);

-- post-launch QA results: INDEPENDENT of whoever submitted the commit, and about that exact commit only
create table if not exists projects.maintenance_qa_results (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  work_item_id     uuid not null references projects.maintenance_work_items(id) on delete cascade,
  category         text not null check (category in ('targeted', 'regression', 'security')),
  status           text not null check (status in ('pass', 'fail', 'blocked')),
  commit_ref       text not null check (commit_ref ~ '^[0-9a-f]{40}$'),
  evidence_ref     text,
  reason           text,
  defect_id        uuid references qa.defects(id) on delete set null,
  recorded_by      uuid not null references core.users(id) on delete restrict,
  recorded_at      timestamptz not null default clock_timestamp(),
  check (status <> 'pass' or length(btrim(coalesce(evidence_ref, ''))) > 0),
  check (status = 'pass' or length(btrim(coalesce(reason, ''))) > 0)
);
create index if not exists maintenance_qa_results_item_idx on projects.maintenance_qa_results (work_item_id, category, recorded_at desc);

-- the release decisions: requested, approved, rejected, withdrawn (a new commit withdraws a pending request)
create table if not exists projects.maintenance_release_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  work_item_id     uuid not null references projects.maintenance_work_items(id) on delete cascade,
  decision         text not null check (decision in ('requested', 'approved', 'rejected', 'withdrawn')),
  commit_ref       text not null check (commit_ref ~ '^[0-9a-f]{40}$'),
  note             text,
  decided_by       uuid references core.users(id) on delete restrict,
  decided_at       timestamptz not null default clock_timestamp(),
  check (decision <> 'rejected' or length(btrim(coalesce(note, ''))) > 0),
  check (decision = 'withdrawn' or decided_by is not null)
);

-- the SLA policy an Admin chooses. EMPTY until then. Versioned, append-only: the policy a decision was made under stays explainable.
create table if not exists projects.maintenance_sla_policies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  priority         text not null check (priority in ('p0', 'p1', 'p2', 'p3')),
  version          int not null check (version > 0),
  response_hours   int not null check (response_hours > 0),
  resolution_hours int not null check (resolution_hours >= response_hours),
  at_risk_percent  int check (at_risk_percent is null or at_risk_percent between 1 and 99),
  set_by           uuid not null references core.users(id) on delete restrict,
  created_at       timestamptz not null default clock_timestamp(),
  unique (organization_id, priority, version)
);

-- the Orchestrator's routing decisions for post-launch work: explained candidates, like projects.routing_decisions in Phase 5
create table if not exists projects.maintenance_routing_decisions (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references core.organizations(id) on delete cascade,
  work_item_id              uuid not null references projects.maintenance_work_items(id) on delete cascade,
  decision_key              text not null check (length(btrim(decision_key)) > 0),
  outcome                   text not null check (outcome in ('routed', 'held', 'refused', 'escalated')),
  priority                  text not null check (priority in ('p0', 'p1', 'p2', 'p3')),
  to_agent                  text check (to_agent is null or to_agent ~ '^[a-z_]+$'),
  reason                    text not null check (length(btrim(reason)) > 0),
  candidates                jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  sla                       jsonb not null default '{}'::jsonb check (jsonb_typeof(sla) = 'object'),
  requires_security_review  boolean not null default false,
  independent_qa            jsonb not null default '[]'::jsonb check (jsonb_typeof(independent_qa) = 'array'),
  policy_version            text,
  correlation_id            uuid,
  decided_by                uuid references core.users(id) on delete set null,
  decided_at                timestamptz not null default clock_timestamp(),
  unique (work_item_id, decision_key),
  check (outcome <> 'routed' or to_agent is not null)
);

-- who asked an agent to look at a work item (the person who may NOT accept what comes back), what the agent proposed, and the one decision on it
create table if not exists projects.maintenance_agent_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  work_item_id     uuid not null references projects.maintenance_work_items(id) on delete cascade,
  agent_key        text not null check (agent_key in ('bug_fix', 'regression_test')),
  requested_by     uuid not null references core.users(id) on delete restrict,
  created_at       timestamptz not null default clock_timestamp()
);

create table if not exists projects.maintenance_agent_proposals (
  id                          uuid primary key default gen_random_uuid(),
  organization_id             uuid not null references core.organizations(id) on delete cascade,
  work_item_id                uuid not null references projects.maintenance_work_items(id) on delete cascade,
  request_id                  uuid not null references projects.maintenance_agent_requests(id) on delete cascade,
  agent_key                   text not null check (agent_key in ('bug_fix', 'regression_test')),
  kind                        text not null check (kind in ('fix_plan', 'regression_plan')),
  summary                     text not null check (length(btrim(summary)) > 0 and length(summary) <= 2000),
  steps                       jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 20),
  risks                       jsonb not null default '[]'::jsonb check (jsonb_typeof(risks) = 'array' and jsonb_array_length(risks) <= 20),
  needs_scope_change          boolean not null default false,
  recommends_security_review  boolean not null default false,
  evidence_refs               text[] not null default '{}' check (cardinality(evidence_refs) <= 20),
  commit_ref                  text check (commit_ref is null or commit_ref ~ '^[0-9a-f]{40}$'),
  requested_by                uuid not null references core.users(id) on delete restrict,
  status                      text not null default 'proposed' check (status = 'proposed'),
  created_at                  timestamptz not null default clock_timestamp(),
  unique (request_id, kind),
  check ((agent_key = 'bug_fix') = (kind = 'fix_plan'))
);

create table if not exists projects.maintenance_agent_proposal_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  proposal_id      uuid not null unique references projects.maintenance_agent_proposals(id) on delete cascade,
  decision         text not null check (decision in ('accepted', 'rejected')),
  note             text,
  decided_by       uuid not null references core.users(id) on delete restrict,
  decided_at       timestamptz not null default clock_timestamp(),
  check (decision = 'accepted' or length(btrim(coalesce(note, ''))) > 0)
);

-- history that is never edited, never deleted
create or replace function projects.maintenance_history_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a % record is history and is never edited or deleted', tg_table_name using errcode = 'restrict_violation'; end $$;

-- ── tenancy, RLS, grants, append-only ──────────────────────────────────────
do $$
declare r record;
begin
  for r in select * from (values
    ('maintenance_work_items', 'project_id', 'projects.projects'), ('maintenance_work_items', 'client_account_id', 'core.client_accounts'),
    ('maintenance_work_items', 'ticket_id', 'projects.maintenance_items'), ('maintenance_work_items', 'defect_id', 'qa.defects'), ('maintenance_work_items', 'change_request_id', 'projects.change_requests'),
    ('maintenance_work_commits', 'work_item_id', 'projects.maintenance_work_items'), ('maintenance_qa_results', 'work_item_id', 'projects.maintenance_work_items'),
    ('maintenance_qa_results', 'defect_id', 'qa.defects'), ('maintenance_release_decisions', 'work_item_id', 'projects.maintenance_work_items'),
    ('maintenance_routing_decisions', 'work_item_id', 'projects.maintenance_work_items'), ('maintenance_agent_requests', 'work_item_id', 'projects.maintenance_work_items'),
    ('maintenance_agent_proposals', 'work_item_id', 'projects.maintenance_work_items'), ('maintenance_agent_proposals', 'request_id', 'projects.maintenance_agent_requests'),
    ('maintenance_agent_proposal_decisions', 'proposal_id', 'projects.maintenance_agent_proposals')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['maintenance_work_items', 'maintenance_work_commits', 'maintenance_qa_results', 'maintenance_release_decisions', 'maintenance_sla_policies',
                               'maintenance_routing_decisions', 'maintenance_agent_requests', 'maintenance_agent_proposals', 'maintenance_agent_proposal_decisions']) as tbl loop
    execute format('alter table projects.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on projects.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('revoke all on projects.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on projects.%I from authenticated', r.tbl);
    execute format('grant select on projects.%I to authenticated', r.tbl);
    execute format('grant all on projects.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
  -- history: never edited, never deleted
  for r in select unnest(array['maintenance_work_commits', 'maintenance_qa_results', 'maintenance_release_decisions', 'maintenance_sla_policies', 'maintenance_routing_decisions',
                               'maintenance_agent_requests', 'maintenance_agent_proposals', 'maintenance_agent_proposal_decisions']) as tbl loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_append_only', r.tbl);
    execute format('create trigger %I before update or delete on projects.%I for each row execute function projects.maintenance_history_append_only()', r.tbl || '_append_only', r.tbl);
  end loop;
end $$;
