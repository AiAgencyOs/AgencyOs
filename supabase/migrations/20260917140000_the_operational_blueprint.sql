-- ═══════════════════════════════════════════════════════════════════════════
-- The operational blueprint.
--
-- Project Planning Agent §1, §4, §7–§9, §11, §15; Master §5.7.
--
-- ── the boundary this whole file exists to hold ──────────────────────────
--
-- The specification's first locked line: *"this agent plans the project
-- lifecycle operationally. It does NOT decide how developers should code a
-- feature, design database tables, implement APIs, choose algorithms, or
-- create the Phase 5 master development checklist."* §6 tabulates the split
-- and §5 lists thirteen things this agent must not do.
--
-- That boundary is kept **by what this schema cannot hold**. There is no
-- column for a table, an endpoint, a framework, a library, a repository or a
-- coding task, and no amount of good intentions is needed to keep them out —
-- there is nowhere to put them. A Development Planning Agent, when Phase 5
-- builds one, gets its own tables.
--
-- ── what already exists, and why none of it is this ──────────────────────
--
--   * `projects.scope_versions` / `scope_items` — the APPROVED SCOPE. This
--     plan reads it and must never modify it (§5).
--   * `projects.deliverables` — despite the name, a QA artifact: a versioned
--     submission with an `artifact_url`, a `changelog` and an
--     `approval_request_id`. It records a thing that was DELIVERED. §8's
--     register records a thing that is PLANNED, and overloading one row with
--     both would make "status" mean two different things.
--   * `projects.milestones` — a PAYMENT milestone (ADM-105's 30/20/30/20).
--     §7 asks for an operational milestone map AND a finance milestone map,
--     separately, precisely because they are not the same thing.
--
-- ── three rules made structural ──────────────────────────────────────────
--
-- **1. It cannot invent a deliverable.** §4.1: *"read the accepted scope
-- without silently adding features"* and *"preserve quotation/scope
-- references for traceability."* So every deliverable carries a real
-- reference to a `scope_item` or a `proposal_item` — a CHECK, not a
-- convention. A deliverable with no approved source cannot be stored.
--
-- **2. It cannot promise a date it has no basis for.** §4.3: *"represent
-- target start/end windows or durations without inventing guarantees"*; §11:
-- *"do not compress the timeline merely to satisfy a requested date without
-- evidence."* So a window may be written only with a `timing_basis` saying
-- where it came from — a constraint, so a confident-looking date with no
-- justification is unstorable.
--
-- **3. "The agent says it is done" is not evidence.** §4.6 says so in those
-- words. `evidence_required` is NOT NULL on every deliverable, and the plan
-- cannot be finalised without at least one deliverable.
--
-- ── versioned, and never silently rewritten ──────────────────────────────
--
-- §4.8: *"do not silently rewrite historical plans"*, and track *"why a
-- version changed and which approved source caused the change."* A finalised
-- plan and everything hanging off it are frozen; a change drafts the next
-- version, which must say why.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.plan_drafted',
   'Project Planning section 15 - a new version of the operational blueprint has been opened as a draft. Nothing downstream may read it yet, because a draft is not a plan. NOTE - an event description must contain no semicolon. tests/event-vocabulary.test.ts matches a declaration statement up to the first one, so a semicolon here makes every later tuple in the same insert invisible to the check.',
   true),
  ('project.plan_activated',
   'Project Planning section 15 - a version of the operational blueprint has been finalised and is now the live plan. The pre-kickoff readiness gate reads this.',
   true)
on conflict (type) do nothing;

-- ── the plan ─────────────────────────────────────────────────────────────

create table if not exists projects.project_plans (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  version          int not null check (version > 0),

  -- A draft is not a plan. Only `active` is the live blueprint, and only one
  -- per project — the partial index below, for the same reason the billing
  -- profile has one: two live answers is the ambiguity.
  status           text not null default 'draft' check (status in ('draft', 'active', 'superseded')),

  -- §7: "approved project objective/summary" and "approved scope
  -- snapshot/reference". The scope version is a REFERENCE, never a copy — it
  -- is already versioned and frozen, and a second copy would drift from it.
  scope_version_id uuid references projects.scope_versions(id) on delete restrict,
  objective        text,

  -- §4.8: "track why a version changed and which approved source caused the
  -- change." Required from version 2 onward — the first version needs no
  -- justification for existing, and every later one does.
  change_reason    text,
  constraint project_plans_change_reason_from_v2 check (
    version = 1 or change_reason is not null
  ),

  activated_at     timestamptz,
  activated_by     uuid references core.users(id) on delete set null,
  constraint project_plans_activation_shape check (
    (status in ('active', 'superseded')) = (activated_at is not null)
  ),

  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (project_id, version)
);

create unique index if not exists project_plans_one_active
  on projects.project_plans (project_id) where status = 'active';

-- And one draft at a time: two people drafting version 4 in parallel is two
-- plans that will each think they are next.
create unique index if not exists project_plans_one_draft
  on projects.project_plans (project_id) where status = 'draft';

comment on table projects.project_plans is
  'Project Planning section 15 - the versioned operational blueprint. Operational, never technical: section 5 forbids this agent from designing tables, APIs, frameworks or coding tasks, and this schema holds that boundary by having nowhere to put them. A Development Planning Agent gets its own tables when Phase 5 builds one.';

-- ── §8's deliverables register ───────────────────────────────────────────

create table if not exists projects.plan_deliverables (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references projects.project_plans(id) on delete cascade,

  position         int not null default 0,
  name             text not null check (length(btrim(name)) between 1 and 300),

  -- §4.1's traceability, as a reference rather than a sentence. One of the two
  -- must be present: a deliverable this agent thought of is a feature it
  -- added, and §5 forbids modifying approved scope.
  scope_item_id    uuid references projects.scope_items(id) on delete restrict,
  proposal_item_id uuid references sales.proposal_items(id) on delete restrict,
  constraint plan_deliverables_has_approved_source check (
    scope_item_id is not null or proposal_item_id is not null
  ),

  -- §8: "AgencyOS phase that produces/validates it".
  --
  -- The vocabulary is only what these four locked documents actually name:
  -- phase_2 is this one, phase_3 is what it hands to, and phases 4, 5, 6 and 7
  -- are named by ADM-105's milestone triggers (UI prototype approval,
  -- development completion, testing completion) and Finance section 7's 100%
  -- gate. No phase beyond 7 is listed, because no document in this set names
  -- one and inventing a phase would be inventing a lifecycle.
  applicable_phase text not null check (applicable_phase in (
    'phase_2', 'phase_3', 'phase_4', 'phase_5', 'phase_6', 'phase_7', 'not_applicable'
  )),

  -- §8: "responsible agent/team role". Free text: the agency's roles are its
  -- own, and a closed list here would be this migration deciding them.
  owner_role       text,

  -- §4.6, in its own words: "do not equate 'agent says done' with completion."
  -- Not null, so a deliverable cannot be planned without saying what would
  -- prove it.
  readiness_criteria text not null check (length(btrim(readiness_criteria)) > 0),
  evidence_required  text not null check (length(btrim(evidence_required)) > 0),

  status           text not null default 'planned' check (status in
                     ('planned', 'blocked', 'ready', 'complete', 'not_applicable')),

  -- §4.1: "flag ambiguity instead of guessing." A deliverable read out of an
  -- unclear scope item is stored WITH the doubt attached rather than resolved
  -- into confidence — the clarification workflow (section 10) picks these up.
  ambiguity_note   text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists plan_deliverables_plan_idx
  on projects.plan_deliverables (plan_id, position);

comment on table projects.plan_deliverables is
  'Project Planning section 8. Every row references an approved scope item or proposal item - a CHECK, not a convention - because section 4.1 says to read the accepted scope without silently adding features, and a deliverable with no approved source is a feature this agent invented.';

comment on column projects.plan_deliverables.evidence_required is
  'Project Planning section 4.6: "do not equate agent says done with completion." Not null, so a deliverable cannot be planned without saying what would prove it.';

-- ── §9's dependency register ─────────────────────────────────────────────

create table if not exists projects.plan_dependencies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references projects.project_plans(id) on delete cascade,

  -- §9's six types, exactly. "Dependencies should be explicit objects, not
  -- buried in prose" — which is what this table is.
  kind             text not null check (kind in (
    'client_information', 'client_access', 'external_service',
    'internal_output', 'human_approval', 'finance'
  )),

  description      text not null check (length(btrim(description)) > 0),

  -- §4.4: "mark each dependency with needed-by phase/date/window, owner and
  -- status."
  needed_by_phase  text not null check (needed_by_phase in (
    'phase_2', 'phase_3', 'phase_4', 'phase_5', 'phase_6', 'phase_7'
  )),
  needed_by_window_start date,
  needed_by_window_end   date,

  -- Rule 2, structural. §4.3 and §11: a window without a stated basis is a
  -- guarantee this agent invented, and §5 forbids promising dates that are not
  -- supported by approved commitments or planning assumptions.
  timing_basis     text,
  constraint plan_dependencies_dates_need_a_basis check (
    (needed_by_window_start is null and needed_by_window_end is null)
    or (timing_basis is not null and length(btrim(timing_basis)) > 0)
  ),
  constraint plan_dependencies_window_is_ordered check (
    needed_by_window_start is null or needed_by_window_end is null
    or needed_by_window_end >= needed_by_window_start
  ),

  -- §4.4: "ask PM to collect client-side items; Planning Agent should not take
  -- over client communication." So the row names who acts, and the Planning
  -- Agent is never the answer for a client-facing one.
  owner_role       text not null check (length(btrim(owner_role)) > 0),
  constraint plan_dependencies_client_items_are_pms check (
    kind not in ('client_information', 'client_access') or owner_role = 'project_manager'
  ),

  status           text not null default 'pending' check (status in
                     ('pending', 'requested', 'received', 'blocked', 'not_applicable')),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists plan_dependencies_plan_idx
  on projects.plan_dependencies (plan_id, kind);

comment on table projects.plan_dependencies is
  'Project Planning section 9 - the six dependency types as explicit objects rather than prose. A client-side dependency is always owned by project_manager, enforced: section 4.4 says the Planning Agent must not take over client communication, and a row naming it as the owner of a client request would be exactly that.';

comment on constraint plan_dependencies_dates_need_a_basis on projects.plan_dependencies is
  'Project Planning section 4.3 and section 11 - a target window may be written only with a stated basis. A confident-looking date with no justification is a guarantee this agent invented, which section 5 forbids.';

-- ── §4.7 and §7's risk and assumption registers ──────────────────────────
--
-- One table with a kind, because both are the same shape — a statement, an
-- owner, a status — and two tables would be two sets of triggers and policies
-- to keep honest. The CLARIFICATION register is deliberately NOT here: §10
-- makes it a workflow with its own resolution path, and folding a thing that
-- gets answered in with things that do not would flatten the difference.

create table if not exists projects.plan_notes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references projects.project_plans(id) on delete cascade,

  kind             text not null check (kind in ('risk', 'assumption')),
  statement        text not null check (length(btrim(statement)) > 0),

  -- §4.7: "assign owner/escalation path where known." Where known — so
  -- nullable, because inventing an owner is worse than recording none.
  owner_role       text,
  escalation_path  text,

  status           text not null default 'open' check (status in ('open', 'mitigated', 'accepted', 'closed')),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists plan_notes_plan_idx
  on projects.plan_notes (plan_id, kind);

comment on table projects.plan_notes is
  'Project Planning section 4.7 and section 7 - the risk and assumption registers. The clarification register is deliberately elsewhere: section 10 makes it a workflow with a resolution path, and a thing that gets answered does not share a table with a thing that does not.';

-- ── a finalised plan is a record ─────────────────────────────────────────

create or replace function projects.freeze_active_plan()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'superseded' then
    raise exception 'a superseded plan is the history section 4.8 forbids rewriting'
      using errcode = 'check_violation';
  end if;
  -- An active plan may only be superseded. Everything else is a new version.
  if old.status = 'active'
     and (new.objective is distinct from old.objective
          or new.scope_version_id is distinct from old.scope_version_id
          or new.version is distinct from old.version) then
    raise exception 'a live plan changes by drafting the next version, never by editing this one'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_active_plan on projects.project_plans;
create trigger freeze_active_plan
  before update on projects.project_plans
  for each row execute function projects.freeze_active_plan();

-- The children too: a plan whose deliverables can be rewritten after it went
-- live is a plan that says whatever somebody needs it to have said.
create or replace function projects.refuse_write_to_settled_plan()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_plan   uuid := coalesce(new.plan_id, old.plan_id);
begin
  select p.status into v_status from projects.project_plans p where p.id = v_plan;
  if v_status is distinct from 'draft' then
    raise exception 'plan % is % — its registers change by drafting the next version', v_plan, coalesce(v_status, 'missing')
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists refuse_write_to_settled_plan_deliverables on projects.plan_deliverables;
create trigger refuse_write_to_settled_plan_deliverables
  before insert or update or delete on projects.plan_deliverables
  for each row execute function projects.refuse_write_to_settled_plan();

drop trigger if exists refuse_write_to_settled_plan_dependencies on projects.plan_dependencies;
create trigger refuse_write_to_settled_plan_dependencies
  before insert or update or delete on projects.plan_dependencies
  for each row execute function projects.refuse_write_to_settled_plan();

drop trigger if exists refuse_write_to_settled_plan_notes on projects.plan_notes;
create trigger refuse_write_to_settled_plan_notes
  before insert or update or delete on projects.plan_notes
  for each row execute function projects.refuse_write_to_settled_plan();

-- ── tenancy ──────────────────────────────────────────────────────────────

-- Written out rather than looped. A `do $$ ... execute format(...)` block is
-- shorter and invisible: `check-record` counts `alter table X enable row level
-- security` statements to know how many tables are protected, and it read four
-- of these as unprotected because the statements did not exist until runtime.
-- A control a static check cannot see is a control nobody can audit.

alter table projects.project_plans enable row level security;
alter table projects.project_plans force row level security;
alter table projects.plan_deliverables enable row level security;
alter table projects.plan_deliverables force row level security;
alter table projects.plan_dependencies enable row level security;
alter table projects.plan_dependencies force row level security;
alter table projects.plan_notes enable row level security;
alter table projects.plan_notes force row level security;

drop policy if exists project_plans_select on projects.project_plans;
create policy project_plans_select on projects.project_plans
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists plan_deliverables_select on projects.plan_deliverables;
create policy plan_deliverables_select on projects.plan_deliverables
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists plan_dependencies_select on projects.plan_dependencies;
create policy plan_dependencies_select on projects.plan_dependencies
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists plan_notes_select on projects.plan_notes;
create policy plan_notes_select on projects.plan_notes
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists freeze_org_project_plans on projects.project_plans;
create trigger freeze_org_project_plans
  before update of organization_id on projects.project_plans
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_plan_deliverables on projects.plan_deliverables;
create trigger freeze_org_plan_deliverables
  before update of organization_id on projects.plan_deliverables
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_plan_dependencies on projects.plan_dependencies;
create trigger freeze_org_plan_dependencies
  before update of organization_id on projects.plan_dependencies
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_plan_notes on projects.plan_notes;
create trigger freeze_org_plan_notes
  before update of organization_id on projects.plan_notes
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_project_plans on projects.project_plans;
create trigger set_updated_at_project_plans
  before update on projects.project_plans
  for each row execute function core.set_updated_at();

drop trigger if exists set_updated_at_plan_deliverables on projects.plan_deliverables;
create trigger set_updated_at_plan_deliverables
  before update on projects.plan_deliverables
  for each row execute function core.set_updated_at();

drop trigger if exists set_updated_at_plan_dependencies on projects.plan_dependencies;
create trigger set_updated_at_plan_dependencies
  before update on projects.plan_dependencies
  for each row execute function core.set_updated_at();

drop trigger if exists set_updated_at_plan_notes on projects.plan_notes;
create trigger set_updated_at_plan_notes
  before update on projects.plan_notes
  for each row execute function core.set_updated_at();

drop trigger if exists org_match_project_plans_project on projects.project_plans;
create trigger org_match_project_plans_project
  before insert or update of project_id, organization_id on projects.project_plans
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_plan_deliverables_plan on projects.plan_deliverables;
create trigger org_match_plan_deliverables_plan
  before insert or update of plan_id, organization_id on projects.plan_deliverables
  for each row execute function core.enforce_parent_org('plan_id', 'projects.project_plans');

drop trigger if exists org_match_plan_dependencies_plan on projects.plan_dependencies;
create trigger org_match_plan_dependencies_plan
  before insert or update of plan_id, organization_id on projects.plan_dependencies
  for each row execute function core.enforce_parent_org('plan_id', 'projects.project_plans');

-- The three references that reach OUTSIDE this plan's own tables. CI caught
-- these missing: a plan in one organization could have referenced another
-- organization's scope version, scope item or quotation line, which is the
-- exact cross-tenant leak `enforce_parent_org` exists to make impossible.
-- Every org-scoped foreign key needs one, not just the obvious parent.

drop trigger if exists org_match_project_plans_scope on projects.project_plans;
create trigger org_match_project_plans_scope
  before insert or update of scope_version_id, organization_id on projects.project_plans
  for each row execute function core.enforce_parent_org('scope_version_id', 'projects.scope_versions');

drop trigger if exists org_match_plan_deliverables_scope_item on projects.plan_deliverables;
create trigger org_match_plan_deliverables_scope_item
  before insert or update of scope_item_id, organization_id on projects.plan_deliverables
  for each row execute function core.enforce_parent_org('scope_item_id', 'projects.scope_items');

drop trigger if exists org_match_plan_deliverables_proposal_item on projects.plan_deliverables;
create trigger org_match_plan_deliverables_proposal_item
  before insert or update of proposal_item_id, organization_id on projects.plan_deliverables
  for each row execute function core.enforce_parent_org('proposal_item_id', 'sales.proposal_items');

drop trigger if exists org_match_plan_notes_plan on projects.plan_notes;
create trigger org_match_plan_notes_plan
  before insert or update of plan_id, organization_id on projects.plan_notes
  for each row execute function core.enforce_parent_org('plan_id', 'projects.project_plans');

grant select on projects.project_plans, projects.plan_deliverables,
               projects.plan_dependencies, projects.plan_notes to authenticated;
grant select, insert, update, delete on projects.project_plans, projects.plan_deliverables,
               projects.plan_dependencies, projects.plan_notes to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- The doors
-- ═══════════════════════════════════════════════════════════════════════════

-- ── open a draft ─────────────────────────────────────────────────────────
--
-- §2's start conditions, and its idempotency: "duplicate planning trigger for
-- the same project/version is protected by idempotency." The one-draft index
-- and the project lock do that together.

create or replace function projects.draft_project_plan(
  p_project_id uuid,
  p_objective text default null,
  p_change_reason text default null
)
returns table (
  -- 'drafted' | 'already_drafting' | 'no_scope' | 'unknown_project'
  -- | 'needs_reason' | 'no_actor' | 'forbidden'
  outcome text,
  plan_id uuid,
  version int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_scope   projects.scope_versions;
  v_live    projects.project_plans;
  v_draft   projects.project_plans;
  v_version int;
  v_new     uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::int; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid, null::int; return;
  end if;

  if v_actor is not null
     and (v_project.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;

  select pp.* into v_draft from projects.project_plans pp
   where pp.project_id = v_project.id and pp.status = 'draft';
  if v_draft.id is not null then
    return query select 'already_drafting'::text, v_draft.id, v_draft.version; return;
  end if;

  select pp.* into v_live from projects.project_plans pp
   where pp.project_id = v_project.id and pp.status = 'active';

  v_version := coalesce(v_live.version, 0) + 1;

  -- §4.8: a second version says why it exists.
  if v_version > 1 and coalesce(btrim(p_change_reason), '') = '' then
    return query select 'needs_reason'::text, null::uuid, null::int; return;
  end if;

  -- §3: the approved scope is an INPUT. A plan drafted with no approved scope
  -- would be a plan of things nobody agreed to — §4.1's whole prohibition.
  select sv.* into v_scope
    from projects.scope_versions sv
   where sv.project_id = v_project.id and sv.status <> 'draft'
   order by sv.version desc
   limit 1;
  if v_scope.id is null then
    return query select 'no_scope'::text, null::uuid, null::int; return;
  end if;

  insert into projects.project_plans (
    organization_id, project_id, version, status, scope_version_id, objective, change_reason, created_by
  ) values (
    v_project.organization_id, v_project.id, v_version, 'draft', v_scope.id,
    coalesce(nullif(btrim(coalesce(p_objective, '')), ''), v_live.objective),
    nullif(btrim(coalesce(p_change_reason, '')), ''),
    v_actor
  )
  returning id into v_new;

  perform core.emit_event(
    v_project.organization_id, 'project.plan_drafted', 'project', v_project.id,
    jsonb_build_object('plan_id', v_new, 'version', v_version, 'scope_version_id', v_scope.id),
    null
  );

  return query select 'drafted'::text, v_new, v_version;
end;
$$;

comment on function projects.draft_project_plan(uuid, text, text) is
  'Project Planning section 2 and section 15 - open the next version of the operational blueprint. Refuses a project with no approved scope version: a plan drafted without one is a plan of things nobody agreed to.';

-- ── finalise it ──────────────────────────────────────────────────────────

create or replace function projects.activate_project_plan(p_plan_id uuid)
returns table (
  -- 'activated' | 'not_draft' | 'no_deliverables' | 'unknown_plan'
  -- | 'needs_person' | 'forbidden'
  outcome text,
  version int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_count int;
begin
  -- A person finalises a plan. §12: "actual phase transition authority remains
  -- with AgencyOS workflow/policy and responsible agents" — and a blueprint
  -- going live is what the pre-kickoff gate reads, so somebody owns it.
  if v_actor is null then
    return query select 'needs_person'::text, null::int; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::int; return;
  end if;

  if v_plan.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::int; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, v_plan.version; return;
  end if;

  -- §7 requires a deliverables register. An empty plan that reads `active`
  -- would satisfy the pre-kickoff gate while containing nothing.
  select count(*) into v_count from projects.plan_deliverables d where d.plan_id = v_plan.id;
  if v_count = 0 then
    return query select 'no_deliverables'::text, v_plan.version; return;
  end if;

  update projects.project_plans
     set status = 'superseded'
   where project_id = v_plan.project_id and status = 'active';

  update projects.project_plans
     set status = 'active', activated_at = now(), activated_by = v_actor
   where id = v_plan.id;

  perform core.emit_event(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('plan_id', v_plan.id, 'version', v_plan.version, 'deliverables', v_count),
    null
  );

  perform core.record_audit(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'active', 'plan_id', v_plan.id, 'version', v_plan.version, 'activated_by', v_actor),
    null
  );

  return query select 'activated'::text, v_plan.version;
end;
$$;

comment on function projects.activate_project_plan(uuid) is
  'Project Planning section 15 - make a draft the live blueprint. Refuses a plan with no deliverables: an empty plan reading active would satisfy the pre-kickoff gate while containing nothing.';

-- ── fill the registers ───────────────────────────────────────────────────
--
-- Three doors rather than three sets of RLS write policies, because that is
-- how every write in this repository reaches a table: the checks live in one
-- place, the caller is identified once, and `invoker writes without a policy`
-- stays at zero. The constraints above still do the refusing — these doors do
-- not repeat them, they just make the tables reachable by a person.
--
-- Each refuses a plan that is not a draft BEFORE it writes, so a caller gets a
-- named answer rather than a trigger's exception.

create or replace function projects.add_plan_deliverable(
  p_plan_id uuid,
  p_name text,
  p_applicable_phase text,
  p_readiness_criteria text,
  p_evidence_required text,
  p_scope_item_id uuid default null,
  p_proposal_item_id uuid default null,
  p_owner_role text default null,
  p_ambiguity_note text default null,
  p_position int default 0
)
returns table (
  -- 'added' | 'not_draft' | 'unknown_plan' | 'no_approved_source'
  -- | 'needs_person' | 'forbidden'
  outcome text,
  deliverable_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_new   uuid;
begin
  -- §4.1, at the door as well as in the constraint: a deliverable with no
  -- approved source is a feature this agent invented, and the caller is told
  -- so by name rather than by a constraint violation.
  if p_scope_item_id is null and p_proposal_item_id is null then
    return query select 'no_approved_source'::text, null::uuid; return;
  end if;

  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  insert into projects.plan_deliverables (
    organization_id, plan_id, position, name, scope_item_id, proposal_item_id,
    applicable_phase, owner_role, readiness_criteria, evidence_required, ambiguity_note
  ) values (
    v_plan.organization_id, v_plan.id, coalesce(p_position, 0), p_name,
    p_scope_item_id, p_proposal_item_id, p_applicable_phase, p_owner_role,
    p_readiness_criteria, p_evidence_required, nullif(btrim(coalesce(p_ambiguity_note, '')), '')
  )
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$$;

comment on function projects.add_plan_deliverable(uuid, text, text, text, text, uuid, uuid, text, text, int) is
  'Project Planning section 8. Refuses a deliverable with no approved scope or proposal source by name - the same rule the table CHECK enforces, said in words a caller can act on.';

create or replace function projects.add_plan_dependency(
  p_plan_id uuid,
  p_kind text,
  p_description text,
  p_needed_by_phase text,
  p_owner_role text,
  p_window_start date default null,
  p_window_end date default null,
  p_timing_basis text default null
)
returns table (
  -- 'added' | 'not_draft' | 'unknown_plan' | 'dates_need_a_basis'
  -- | 'client_items_are_pms' | 'needs_person' | 'forbidden'
  outcome text,
  dependency_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_new   uuid;
begin
  -- §4.3 and §11, refused before the lock and by name: a window with no
  -- stated basis is a guarantee nobody can defend.
  if (p_window_start is not null or p_window_end is not null)
     and coalesce(btrim(coalesce(p_timing_basis, '')), '') = '' then
    return query select 'dates_need_a_basis'::text, null::uuid; return;
  end if;

  -- §4.4: the Planning Agent does not take over client communication.
  if p_kind in ('client_information', 'client_access') and p_owner_role is distinct from 'project_manager' then
    return query select 'client_items_are_pms'::text, null::uuid; return;
  end if;

  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  insert into projects.plan_dependencies (
    organization_id, plan_id, kind, description, needed_by_phase,
    needed_by_window_start, needed_by_window_end, timing_basis, owner_role
  ) values (
    v_plan.organization_id, v_plan.id, p_kind, p_description, p_needed_by_phase,
    p_window_start, p_window_end, nullif(btrim(coalesce(p_timing_basis, '')), ''), p_owner_role
  )
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$$;

comment on function projects.add_plan_dependency(uuid, text, text, text, text, date, date, text) is
  'Project Planning section 9. Refuses a dated window with no stated basis and a client-side dependency owned by anyone but the PM - both by name, both also enforced as constraints.';

create or replace function projects.add_plan_note(
  p_plan_id uuid,
  p_kind text,
  p_statement text,
  p_owner_role text default null,
  p_escalation_path text default null
)
returns table (
  -- 'added' | 'not_draft' | 'unknown_plan' | 'needs_person' | 'forbidden'
  outcome text,
  note_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_new   uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  insert into projects.plan_notes (organization_id, plan_id, kind, statement, owner_role, escalation_path)
  values (v_plan.organization_id, v_plan.id, p_kind, p_statement,
          nullif(btrim(coalesce(p_owner_role, '')), ''),
          nullif(btrim(coalesce(p_escalation_path, '')), ''))
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$$;

comment on function projects.add_plan_note(uuid, text, text, text, text) is
  'Project Planning section 4.7 - the risk and assumption registers. Owner and escalation path are nullable because section 4.7 says "where known", and inventing an owner is worse than recording none.';

revoke all on function projects.draft_project_plan(uuid, text, text) from public;
revoke all on function projects.activate_project_plan(uuid) from public;

grant execute on function projects.draft_project_plan(uuid, text, text) to authenticated, service_role;
grant execute on function projects.activate_project_plan(uuid) to authenticated;
revoke all on function projects.add_plan_deliverable(uuid, text, text, text, text, uuid, uuid, text, text, int) from public;
revoke all on function projects.add_plan_dependency(uuid, text, text, text, text, date, date, text) from public;
revoke all on function projects.add_plan_note(uuid, text, text, text, text) from public;
grant execute on function projects.add_plan_deliverable(uuid, text, text, text, text, uuid, uuid, text, text, int) to authenticated, service_role;
grant execute on function projects.add_plan_dependency(uuid, text, text, text, text, date, date, text) to authenticated, service_role;
grant execute on function projects.add_plan_note(uuid, text, text, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
