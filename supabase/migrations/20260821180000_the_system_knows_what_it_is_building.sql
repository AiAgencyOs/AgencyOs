-- ═══════════════════════════════════════════════════════════════════════════
-- The system knows what it is supposed to build.
--
-- Document 11 is fourteen pages and had no tables. AgencyOS could record an
-- accepted requirement version, and from there `projects.modules`, `features`
-- and `tasks` each carry `requirement_version_id` — so work traces back to a
-- requirement. What did not exist is the thing in between: **a frozen
-- baseline, and a controlled way to change it.**
--
-- Doc 11 §1: *"The approved scope is the contract-like operational boundary
-- for project delivery. AI agents may interpret and execute the scope, but
-- they must not silently expand, reduce or rewrite it."* Nothing enforced
-- that, because there was no baseline to expand from.
--
-- This is the layer every delivery agent needs before it can be trusted to run
-- at all. Without it a UI designer designs whatever the last message said, and
-- a developer implements whatever the designer drew.
--
-- ── three tables, and one that is deliberately absent ─────────────────────
--
--   projects.scope_versions   an immutable baseline, one active per project
--   projects.scope_items      what is IN, what is OUT, what is optional
--   projects.change_requests  the only authorised way to move the baseline
--
-- There is **no price column on a change request.** Doc 11 §32 has the AI
-- prepare a calculation, and ADM-22 answers who may state the result: *"Every
-- price is quoted per client by a human."* A paid change therefore references
-- a `sales.proposals` row — the same versioned, approval-gated object every
-- other price in this system lives on. Putting an amount here would create a
-- second place a price can exist, and the second place is always the one that
-- escapes the approval engine.
--
-- ── what is NOT automated, and why that is not an omission ────────────────
--
-- Doc 11 §17 requires classification to follow *"deterministic rules/policy"*,
-- and §18 is explicit that **"'Small' must be a policy definition, not an
-- agent's personal judgment"** — a configured effort threshold, a revision
-- allowance, a free-change ceiling. Those are Admin values, and nobody has set
-- them. So the vocabulary and the state machine are here and the *automatic
-- classifier is not*: a request is classified by a person until the thresholds
-- exist. Inventing a threshold would be inventing the business rule the
-- document says must be configured.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the baseline ──────────────────────────────────────────────────────

create table if not exists projects.scope_versions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,

  version         int  not null check (version > 0),

  -- draft      — being assembled; may still be edited
  -- active     — the delivery baseline. Exactly one per project.
  -- superseded — an approved change moved past it. Read-only history.
  status          text not null default 'draft'
                    check (status in ('draft', 'active', 'superseded')),

  -- Freezing is what makes it a baseline rather than a note. Doc 11 §13:
  -- "Freeze means the active scope becomes the delivery baseline."
  frozen_at       timestamptz,

  -- What authorised this version to exist.
  source          text not null default 'onboarding'
                    check (source in ('onboarding', 'change_request', 'correction')),
  change_request_id uuid,

  -- The accepted requirements it was built from, where there are any. FK-less
  -- across schemas by the same reasoning sales.proposals uses for
  -- generated_by_run_id: projects should not take a hard dependency on crm.
  requirement_version_id uuid,

  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (project_id, version),

  -- A frozen version is one that has left draft. The pair moves together or
  -- the row is lying about itself.
  constraint scope_versions_frozen_is_not_draft
    check ((frozen_at is null) = (status = 'draft'))
);

-- One active baseline per project. Partial, so superseded history is unbounded.
create unique index if not exists scope_versions_one_active
  on projects.scope_versions (organization_id, project_id)
  where status = 'active';

create index if not exists scope_versions_project_idx
  on projects.scope_versions (project_id, version desc);

comment on table projects.scope_versions is
  'The delivery baseline (Doc 11 §13). Immutable once frozen; exactly one active per project, enforced by a partial unique index. A new version is created by an approved change request, never by editing this one - Doc 11 §29: "Old versions remain read-only history."';

-- ── 2. what is in it ─────────────────────────────────────────────────────

create table if not exists projects.scope_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  scope_version_id uuid not null references projects.scope_versions(id) on delete cascade,

  -- Optional link to the delivery unit. A scope item can exist before the
  -- feature that implements it, and an exclusion never has one.
  feature_id       uuid references projects.features(id) on delete set null,

  title            text not null check (length(trim(title)) > 0),
  detail           text,

  -- Doc 11 §10. EXCLUDED is the important one: an explicit exclusion is what
  -- stops a later conversation being read as an accidental commitment.
  inclusion        text not null default 'included'
                     check (inclusion in ('included', 'excluded', 'optional')),

  acceptance_criteria text,
  position         int not null default 0,

  created_at       timestamptz not null default now()
);

create index if not exists scope_items_version_idx
  on projects.scope_items (scope_version_id, position);

comment on table projects.scope_items is
  'One line of a scope version. `excluded` is recorded as deliberately as `included` (Doc 11 §10): an explicit exclusion is what prevents a later conversation being read as an accidental commitment.';

-- ── 3. the only authorised way to move the baseline ──────────────────────

create table if not exists projects.change_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- The baseline it was raised against. A request always argues with a
  -- specific version, never with "the scope".
  scope_version_id uuid not null references projects.scope_versions(id),

  source           text not null default 'client'
                     check (source in ('client', 'internal')),

  -- The client's own words, kept verbatim. Doc 11 §16 requires the original
  -- message as evidence; a summary is not evidence.
  requested        text not null check (length(trim(requested)) > 0),
  evidence_message_id uuid,

  -- Doc 11 §17's vocabulary, exactly. Null until somebody classifies it -
  -- there is no default, because a default is a guess about the client's
  -- request.
  classification   text
                     check (classification in (
                       'in_scope', 'free_change', 'paid_change',
                       'new_project', 'clarification', 'duplicate', 'rejected')),

  status           text not null default 'submitted'
                     check (status in (
                       'submitted', 'analysing', 'classified',
                       'pending_approval', 'approved', 'rejected',
                       'implemented', 'closed')),

  -- Impact, as Doc 11 §21 asks for it. Timeline in days because that is what a
  -- client is told; effort in hours because that is what is estimated.
  impact_notes     text,
  timeline_days    int check (timeline_days is null or timeline_days >= 0),
  effort_hours     numeric(8, 2) check (effort_hours is null or effort_hours >= 0),

  -- NO price column, deliberately. See the header: a paid change references a
  -- proposal, which is where every price in this system already lives and is
  -- approval-gated. FK-less across schemas, like requirement_version_id above.
  proposal_id      uuid,

  approval_request_id uuid,

  -- Set when an approved change produces the next baseline.
  resulting_scope_version_id uuid references projects.scope_versions(id),

  requested_by     uuid,
  decided_by       uuid,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A decision needs a classification. Approving something nobody classified
  -- is how "we'll just do it" becomes unpaid scope.
  constraint change_requests_decided_is_classified
    check (status not in ('approved', 'implemented', 'closed') or classification is not null),

  -- A paid change must name the proposal that prices it. This is the ADM-22
  -- boundary expressed as a constraint rather than as a convention.
  constraint change_requests_paid_names_a_proposal
    check (classification is distinct from 'paid_change'
           or status in ('submitted', 'analysing', 'classified', 'rejected')
           or proposal_id is not null)
);

create index if not exists change_requests_project_idx
  on projects.change_requests (project_id, created_at desc);

create index if not exists change_requests_open_idx
  on projects.change_requests (organization_id, status)
  where status not in ('closed', 'rejected');

comment on table projects.change_requests is
  'A request to move the delivery baseline (Doc 11 §16). Carries the client''s verbatim words as evidence, the version it argues with, and a classification from Doc 11 §17''s vocabulary - null until somebody classifies it, because a default would be a guess about the request. Has NO price column: a paid change names a sales.proposals row, so every price in AgencyOS stays on one approval-gated object (ADM-22).';

-- ── 4. a frozen baseline is read-only ────────────────────────────────────
--
-- The rule Doc 11 exists for. Without it, "scope version" is a label on a row
-- somebody can edit, which is worse than no baseline at all because it looks
-- authoritative.

create or replace function projects.refuse_frozen_scope_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'a frozen scope version is history and cannot be deleted (Doc 11 §29)'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  -- Leaving draft is the freeze itself, and superseding is how an approved
  -- change retires a baseline. Everything else about a frozen row is fixed.
  if old.status <> 'draft' then
    if new.status is distinct from old.status
       and not (old.status = 'active' and new.status = 'superseded') then
      raise exception 'a frozen scope version may only be superseded (Doc 11 §29)'
        using errcode = 'check_violation';
    end if;

    if new.version              is distinct from old.version
       or new.project_id        is distinct from old.project_id
       or new.frozen_at         is distinct from old.frozen_at
       or new.source            is distinct from old.source
       or new.change_request_id is distinct from old.change_request_id
       or new.requirement_version_id is distinct from old.requirement_version_id then
      raise exception 'a frozen scope version is immutable (Doc 11 §29); create a new version instead'
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists refuse_frozen_scope_edit on projects.scope_versions;
create trigger refuse_frozen_scope_edit
  before update or delete on projects.scope_versions
  for each row execute function projects.refuse_frozen_scope_edit();

-- The items are part of the version. A baseline whose lines can be edited is
-- not frozen, whatever the parent row says.
create or replace function projects.refuse_frozen_scope_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_scope  uuid;
begin
  v_scope := coalesce(new.scope_version_id, old.scope_version_id);

  select sv.status into v_status
    from projects.scope_versions sv
   where sv.id = v_scope;

  if v_status is not null and v_status <> 'draft' then
    raise exception 'the scope version is frozen; its items cannot be % (Doc 11 §29)', lower(tg_op)
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists refuse_frozen_scope_item on projects.scope_items;
create trigger refuse_frozen_scope_item
  before insert or update or delete on projects.scope_items
  for each row execute function projects.refuse_frozen_scope_item();

comment on function projects.refuse_frozen_scope_edit() is
  'A frozen scope version may only be superseded, never edited or deleted (Doc 11 §29). Freezing is the draft->active transition; everything after it is history.';

comment on function projects.refuse_frozen_scope_item() is
  'Scope items belong to their version. A baseline whose lines can still be edited is not frozen, whatever its parent row says.';

-- ── 5. tenancy, on the same pattern every other table here uses ──────────

alter table projects.scope_versions  enable row level security;
alter table projects.scope_items     enable row level security;
alter table projects.change_requests enable row level security;

alter table projects.scope_versions  force row level security;
alter table projects.scope_items     force row level security;
alter table projects.change_requests force row level security;

-- Internal staff read; nothing is end-user writable. Every write goes through
-- a service function, so a browser cannot move a baseline by PATCH.
--
-- Internal-only, the same shape `projects.tasks` uses. Doc 16 §8 does put
-- scope and change requests in the client portal, and that is a separate
-- change: it needs a `visibility` column and the portal read model, and
-- exposing a baseline to a client before either exists would be a guess about
-- what they should see.
drop policy if exists scope_versions_select on projects.scope_versions;
create policy scope_versions_select on projects.scope_versions
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists scope_items_select on projects.scope_items;
create policy scope_items_select on projects.scope_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists change_requests_select on projects.change_requests;
create policy change_requests_select on projects.change_requests
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- ── 6. tenancy guards, one per org-scoped foreign key ───────────────────
--
-- `core.enforce_parent_org` refuses a row whose parent belongs to another
-- organization, and `core.freeze_organization_id` refuses moving a row between
-- tenants after the fact. Both are required on every org-scoped FK — CI's
-- db:verify:tenancyguards enumerates the gaps and fails on any it finds, which
-- is how this convention stays a rule rather than a habit.

drop trigger if exists org_match_scope_versions_project_id on projects.scope_versions;
create trigger org_match_scope_versions_project_id
  before insert or update of project_id, organization_id on projects.scope_versions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_scope_items_scope_version_id on projects.scope_items;
create trigger org_match_scope_items_scope_version_id
  before insert or update of scope_version_id, organization_id on projects.scope_items
  for each row execute function core.enforce_parent_org('scope_version_id', 'projects.scope_versions');

drop trigger if exists org_match_scope_items_feature_id on projects.scope_items;
create trigger org_match_scope_items_feature_id
  before insert or update of feature_id, organization_id on projects.scope_items
  for each row execute function core.enforce_parent_org('feature_id', 'projects.features');

drop trigger if exists org_match_change_requests_project_id on projects.change_requests;
create trigger org_match_change_requests_project_id
  before insert or update of project_id, organization_id on projects.change_requests
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_change_requests_scope_version_id on projects.change_requests;
create trigger org_match_change_requests_scope_version_id
  before insert or update of scope_version_id, organization_id on projects.change_requests
  for each row execute function core.enforce_parent_org('scope_version_id', 'projects.scope_versions');

drop trigger if exists org_match_change_requests_resulting on projects.change_requests;
create trigger org_match_change_requests_resulting
  before insert or update of resulting_scope_version_id, organization_id on projects.change_requests
  for each row execute function core.enforce_parent_org('resulting_scope_version_id', 'projects.scope_versions');

drop trigger if exists freeze_org_scope_versions on projects.scope_versions;
create trigger freeze_org_scope_versions
  before update of organization_id on projects.scope_versions
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_scope_items on projects.scope_items;
create trigger freeze_org_scope_items
  before update of organization_id on projects.scope_items
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_change_requests on projects.change_requests;
create trigger freeze_org_change_requests
  before update of organization_id on projects.change_requests
  for each row execute function core.freeze_organization_id();

notify pgrst, 'reload schema';
