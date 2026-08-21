-- ═══════════════════════════════════════════════════════════════════════════
-- What to test, said out loud, before anybody tests it.
--
-- Document 14 §1: *"QA is an independent verification layer. A developer
-- agent's claim that code is complete is never sufficient evidence."* The
-- repository has `qa.test_runs` and `qa.defects` — the *results* of testing —
-- and nothing that says what was supposed to be tested. So a run of 40 passing
-- tests and a run of 4 read the same: green.
--
-- §5 asks for a test plan, and §3 says what it must be built from: *"QA tests
-- the approved baseline, not an agent's interpretation of what the project was
-- supposed to be."* That is the whole design here. A plan is written against
-- one frozen `projects.scope_versions` row and its items, by foreign key, so a
-- plan cannot name a feature nobody agreed to — the same control the screen
-- coverage matrix uses one schema over, for the same reason.
--
-- ── what the plan may NOT say, and why each absence is a rule ─────────────
--
-- §16, of performance: *"Targets must be project-specific; AI must not invent
-- universal thresholds."* So there is no column for a latency, a payload size
-- or a load figure. The plan may say performance must be tested on the
-- checkout journey; it cannot say it must answer in 200ms.
--
-- §14, of severity: *"Exact thresholds are Admin-configurable."* No column for
-- one.
--
-- §19, of the readiness score: *"The scoring model and weights are
-- configurable in the Admin Policy Engine."* No score, and no band from §20 —
-- ADM-88 already refused a numeric lead score on this same reasoning, and a
-- readiness number invented here would be the same defect wearing a QA badge.
--
-- §21, of the hard gates: they are deterministic policy, and this is a draft.
-- Nothing here passes, fails, blocks or releases anything. There is no column
-- a verdict could go in.
--
-- Which is what makes the plan safe for an agent to write at all. It is
-- ADM-61 §2 `draft` work — internal, reviewable, and acting on nothing. The
-- one thing QA is uniquely entitled to do, verify another agent's work, is
-- untouched by this and stays where it lives, in `ai.agent_verifiers`.

create table if not exists qa.test_plans (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,

  -- The baseline this plan is about, and the reason §3 holds mechanically. A
  -- plan belongs to ONE frozen scope version; when the scope changes the plan
  -- is out of date by construction rather than by somebody noticing.
  scope_version_id  uuid not null references projects.scope_versions(id) on delete cascade,

  drafted_by_agent  text references ai.agents(key),
  drafted_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),

  constraint test_plans_has_an_author check (
    drafted_by_agent is not null or drafted_by is not null
  )
);

-- One plan per baseline. A second plan for the same scope version is not a
-- revision, it is two answers to one question — and §22's release candidate
-- has to name exactly one.
create unique index if not exists test_plans_one_per_scope_version
  on qa.test_plans (scope_version_id);

create table if not exists qa.test_plan_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references qa.test_plans(id) on delete cascade,

  -- By key, not by name. §3 again: an item the model invented has no row here
  -- to point at, so it cannot be planned for.
  scope_item_id    uuid not null references projects.scope_items(id) on delete cascade,

  -- §6's eleven categories, and only those. "360 QA = FUNCTIONAL + UI + API +
  -- DATABASE + INTEGRATION + E2E + REGRESSION + SECURITY + PERFORMANCE +
  -- COMPATIBILITY + DEPLOYMENT/SMOKE."
  category         text not null check (category in (
    'functional', 'ui', 'api', 'database', 'integration', 'e2e',
    'regression', 'security', 'performance', 'compatibility', 'smoke'
  )),

  -- §6: *"Not every category has identical depth on every project; mandatory
  -- categories derive from project type, technology, scope and risk."* The
  -- reason is required because "why this category, for this item" is the only
  -- part a human reviewing the plan can actually check.
  reason           text not null check (length(btrim(reason)) between 1 and 600),

  -- §6: *"Critical paths receive higher testing priority."* A flag, not a
  -- ranking — there is no score here to be wrong about.
  critical_path    boolean not null default false,

  created_at       timestamptz not null default now()
);

create unique index if not exists test_plan_items_one_row_per_category
  on qa.test_plan_items (plan_id, scope_item_id, category);

comment on table qa.test_plans is
  'Document 14 section 5. What a project is to be tested for, written against one frozen scope version so section 3 holds by foreign key: "QA tests the approved baseline, not an agent''s interpretation." Carries no readiness score (section 19), no performance target (section 16), no severity threshold (section 14) and no gate verdict (section 21) - each of those is Admin-configurable policy or a deterministic decision, and none of them is a draft.';

comment on table qa.test_plan_items is
  'One row per (scope item, testing category) the plan calls for, with the reason it applies. The category list is Document 14 section 6''s eleven and no others; the scope item is a foreign key, so a feature nobody agreed to cannot be planned for.';

comment on column qa.test_plan_items.critical_path is
  'Document 14 section 6: "Critical paths receive higher testing priority." A flag rather than a rank, because a priority number here would be a threshold nobody configured.';

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table qa.test_plans enable row level security;
alter table qa.test_plans force row level security;
alter table qa.test_plan_items enable row level security;
alter table qa.test_plan_items force row level security;

drop policy if exists test_plans_select on qa.test_plans;
create policy test_plans_select on qa.test_plans
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists test_plan_items_select on qa.test_plan_items;
create policy test_plan_items_select on qa.test_plan_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_test_plans_project on qa.test_plans;
create trigger org_match_test_plans_project
  before insert or update of project_id, organization_id on qa.test_plans
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_test_plans_scope on qa.test_plans;
create trigger org_match_test_plans_scope
  before insert or update of scope_version_id, organization_id on qa.test_plans
  for each row execute function core.enforce_parent_org('scope_version_id', 'projects.scope_versions');

drop trigger if exists freeze_org_test_plans on qa.test_plans;
create trigger freeze_org_test_plans
  before update of organization_id on qa.test_plans
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_test_plan_items_plan on qa.test_plan_items;
create trigger org_match_test_plan_items_plan
  before insert or update of plan_id, organization_id on qa.test_plan_items
  for each row execute function core.enforce_parent_org('plan_id', 'qa.test_plans');

drop trigger if exists org_match_test_plan_items_scope_item on qa.test_plan_items;
create trigger org_match_test_plan_items_scope_item
  before insert or update of scope_item_id, organization_id on qa.test_plan_items
  for each row execute function core.enforce_parent_org('scope_item_id', 'projects.scope_items');

drop trigger if exists freeze_org_test_plan_items on qa.test_plan_items;
create trigger freeze_org_test_plan_items
  before update of organization_id on qa.test_plan_items
  for each row execute function core.freeze_organization_id();

-- ── and the agent that drafts them ───────────────────────────────────────
--
-- ADM-82 defined `quality_assurance` and withheld its implementation; PR #262
-- installed the row disabled, because it is the independent verifier every
-- other agent's completion contract depends on and turning it on without work
-- to do would have been a flag with nothing behind it.
--
-- This is the work. Drafting a plan is not verifying anything — the verifier
-- binding in `ai.agent_verifiers` is untouched, and `mayVerify` still names
-- this agent alone.

update ai.agents
   set enabled = true,
       disabled_reason = null
 where key = 'quality_assurance';

-- Read by staff, written by the runner. No UPDATE and no DELETE for anybody:
-- a plan belongs to one frozen baseline, so "revise the plan" is a new
-- baseline's plan, and editing this one in place would silently change what a
-- finished test run was measured against.
grant select on qa.test_plans to authenticated;
grant select, insert on qa.test_plans to service_role;
grant select on qa.test_plan_items to authenticated;
grant select, insert on qa.test_plan_items to service_role;

notify pgrst, 'reload schema';
