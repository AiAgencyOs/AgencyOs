-- ═══════════════════════════════════════════════════════════════════════════
-- Attractive, but incomplete.
--
-- Document 12 is fourteen pages about UI design and prototypes, and one
-- sentence in it says what the whole document is for. §9, of the screen
-- coverage matrix:
--
--   *"This matrix is one of the main controls preventing an AI designer from
--   producing attractive but incomplete work."*
--
-- `projects.deliverables` already versions a design, submits it for approval
-- and refuses a submission that carries a blocking defect. What it cannot do
-- is answer whether the design covers **what was agreed** — because a
-- deliverable is filed against a PROJECT, and the agreement lives in
-- `projects.scope_items`, and nothing joins them. So "the design is approved"
-- and "the design covers the scope" have been two unrelated facts.
--
-- That is exactly the failure §9 names. An AI designer given a project and
-- asked for screens will produce screens. Whether they are *the* screens is a
-- question no row could answer.
--
-- ── §8, as a table ───────────────────────────────────────────────────────
--
-- Doc 12 §8 lists eighteen fields a screen record should carry. Most are
-- descriptive and are stored as written. Six are NOT descriptive, because §9
-- flags on them, and those are structured:
--
--   user_role       §9 "flag missing role states"
--   the four states §9 "flag missing error/empty/loading states"
--   scope mapping   §9 "flag screens with no scope/feature mapping"
--
-- A field the matrix reasons about cannot be prose. The rest can.
--
-- ── the three rules that are mechanically true ───────────────────────────
--
-- §20 lists ten conditions for scope coverage before UI approval. Seven of
-- them are judgement — *"client-specific branding requirements satisfied"*,
-- *"no unresolved material placeholders"* — and nobody has configured what
-- they mean. Inventing thresholds for those would be inventing the business
-- rule, so they are **surfaced as flags and never block**.
--
-- Three are exact, and those are enforced:
--
--   1. **A screen may not be mapped to an excluded scope item.** §20:
--      *"Excluded features not accidentally designed as commitments."* Doc 11
--      §10 records an exclusion as deliberately as an inclusion precisely so a
--      later conversation cannot be read as an accidental commitment — and a
--      screen IS a later conversation. Designing the vendor portal the
--      quotation excluded is how it arrives unpaid.
--
--   2. **Every screen maps to at least one scope item.** §20: *"All screens
--      have feature/requirement mapping."* An unmapped screen is work nobody
--      agreed to pay for.
--
--   3. **Every INCLUDED scope item has at least one screen.** §20: *"All major
--      features represented."* This is the half that catches attractive-but-
--      incomplete, and the half a designer cannot self-assess.
--
-- ── enforced by trigger, and why not by editing the function ─────────────
--
-- `submit_deliverable` already exists and has already been redefined once, by
-- the QA migration, to refuse a submission carrying a blocking defect.
-- Re-emitting it a second time to add a third rule is how a branch gets
-- silently dropped — this repository has done exactly that once, and recorded
-- it. A row rule also binds every path that moves the row, not only today's
-- single caller.
--
-- ── and why it only fires when there is a baseline ───────────────────────
--
-- The gate is coverage OF THE SCOPE. A project with no frozen baseline has no
-- agreed scope to cover, so there is nothing for the rule to be true or false
-- about, and blocking there would mean blocking every design filed before the
-- scope was agreed — which is most early design work, and which no document
-- asks for. Doc 11 made the baseline the moment scope becomes real; this
-- treats it as exactly that moment.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.screens (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- Doc 12 §8 "Screen ID". A stable handle a prototype route and a QA case can
  -- both name, rather than a title somebody will reword.
  screen_key       text not null check (screen_key ~ '^[a-z][a-z0-9_.-]{1,62}$'),
  name             text not null check (length(trim(name)) > 0),

  -- §8 "User role". Structured because §9 flags missing role states, and a
  -- flag cannot be computed over prose.
  user_role        text not null check (length(trim(user_role)) > 0),

  purpose          text,
  entry_point      text,
  exit_action      text,
  required_data    text,
  actions          text,
  validation       text,

  -- §8's four states, and §9's "flag missing error/empty/loading states".
  -- Booleans rather than a jsonb blob: the matrix asks a yes/no question of
  -- each one, and a nullable jsonb key answers "unknown", which is the answer
  -- that lets incomplete work through.
  has_empty_state    boolean not null default false,
  has_loading_state  boolean not null default false,
  has_error_state    boolean not null default false,
  has_success_state  boolean not null default false,

  permission_behaviour text,
  responsive_behaviour text,
  accessibility_notes  text,

  -- Which design version this screen belongs to, when it belongs to one. Null
  -- while the inventory is being built, because §8 asks for the inventory
  -- BEFORE §14's quality gate and §15's approval.
  deliverable_id   uuid references projects.deliverables(id) on delete set null,

  status           text not null default 'draft'
                     check (status in ('draft', 'in_review', 'approved', 'superseded')),

  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- §9 "flag duplicate screens" — refused rather than flagged, because a
  -- duplicate ID is not a design judgement, it is two rows claiming one name.
  unique (project_id, screen_key)
);

create index if not exists screens_project_idx
  on projects.screens (project_id, screen_key);

comment on table projects.screens is
  'Doc 12 section 8''s screen inventory. Descriptive fields are stored as written; the six the coverage matrix reasons about - user_role and the four states - are structured, because a field section 9 flags on cannot be prose.';

-- ── the mapping §9 is built on ───────────────────────────────────────────
--
-- Doc 12 §9: *"Requirement → Feature → Screen(s) → Interaction(s) → Prototype
-- state → QA coverage."* The link that did not exist is the middle one. A
-- screen may cover several scope items and a scope item may need several
-- screens, so it is a join table rather than a column on either side.

create table if not exists projects.screen_scope_items (
  screen_id       uuid not null references projects.screens(id) on delete cascade,
  scope_item_id   uuid not null references projects.scope_items(id) on delete cascade,
  organization_id uuid not null references core.organizations(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (screen_id, scope_item_id)
);

comment on table projects.screen_scope_items is
  'Which agreed scope a screen covers (Doc 12 section 9). Without this link "the design is approved" and "the design covers the scope" are two unrelated facts, which is the attractive-but-incomplete failure section 9 exists to prevent.';

-- ── rule 1: an exclusion is not a design brief ───────────────────────────

create or replace function projects.refuse_excluded_screen_mapping()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_inclusion text;
  v_title     text;
begin
  select si.inclusion, si.title into v_inclusion, v_title
    from projects.scope_items si
   where si.id = new.scope_item_id;

  if v_inclusion = 'excluded' then
    raise exception
      'scope item "%" is excluded; designing it is how an exclusion becomes an accidental commitment (Doc 12 §20)',
      v_title
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists refuse_excluded_screen_mapping on projects.screen_scope_items;
create trigger refuse_excluded_screen_mapping
  before insert or update of scope_item_id on projects.screen_scope_items
  for each row execute function projects.refuse_excluded_screen_mapping();

-- ── the matrix itself ────────────────────────────────────────────────────
--
-- Side-effect free, so a screen can show the answer without pressing anything
-- — the same shape as `start_readiness`, `production_readiness` and
-- `requirement_coverage`. It reports every §9 flag; only three of them block,
-- and the function does not decide that. `blocking` says which.

create or replace function projects.ui_coverage(p_project_id uuid)
returns table (
  flag        text,
  blocking    boolean,
  subject_id  uuid,
  subject     text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with baseline as (
    select sv.id
      from projects.scope_versions sv
     where sv.project_id = p_project_id
       and sv.status = 'active'
     limit 1
  )
  -- §20 "All major features represented." Blocks.
  select 'included_scope_item_has_no_screen'::text, true, si.id, si.title
    from projects.scope_items si
    join baseline b on b.id = si.scope_version_id
   where si.inclusion = 'included'
     and not exists (
       select 1 from projects.screen_scope_items m
         join projects.screens s on s.id = m.screen_id
        where m.scope_item_id = si.id and s.project_id = p_project_id
     )

  union all
  -- §20 "All screens have feature/requirement mapping." Blocks.
  select 'screen_has_no_scope_mapping', true, s.id, s.name
    from projects.screens s
   where s.project_id = p_project_id
     and not exists (select 1 from projects.screen_scope_items m where m.screen_id = s.id)

  union all
  -- §9 "flag missing error/empty/loading states." Does NOT block: Doc 12 says
  -- flag, and which states a given screen genuinely needs is a judgement
  -- nobody has configured. Reported so it is visible, not guessed at.
  select 'screen_missing_states', false, s.id,
         s.name || ' — missing ' || array_to_string(array_remove(array[
           case when not s.has_empty_state   then 'empty'   end,
           case when not s.has_loading_state then 'loading' end,
           case when not s.has_error_state   then 'error'   end,
           case when not s.has_success_state then 'success' end
         ], null), ', ')
    from projects.screens s
   where s.project_id = p_project_id
     and not (s.has_empty_state and s.has_loading_state and s.has_error_state and s.has_success_state)

  union all
  -- §20 "Optional features": an optional scope item with no screen is worth
  -- seeing and is not a failure — it was agreed as optional.
  select 'optional_scope_item_has_no_screen', false, si.id, si.title
    from projects.scope_items si
    join baseline b on b.id = si.scope_version_id
   where si.inclusion = 'optional'
     and not exists (
       select 1 from projects.screen_scope_items m
         join projects.screens s on s.id = m.screen_id
        where m.scope_item_id = si.id and s.project_id = p_project_id
     )

  order by 2 desc, 1, 4;
$$;

comment on function projects.ui_coverage(uuid) is
  'Doc 12 section 9''s screen coverage matrix, as rows. Reports every flag the document names; `blocking` marks the three that are mechanically exact (Doc 12 section 20) and are refused by projects.refuse_uncovered_design. The rest are judgement nobody has configured - surfaced rather than guessed at, because inventing a threshold would be inventing the business rule.';

-- ── rule 2+3: a design cannot be reviewed while it misses the scope ──────
--
-- A trigger rather than a third redefinition of `submit_deliverable`. It fires
-- only for `design`, only on the move into `in_review`, and only when the
-- project has an active baseline — the moment Doc 11 made scope real.

create or replace function projects.refuse_uncovered_design()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_gaps  int;
  v_first text;
begin
  if new.kind <> 'design' or new.status <> 'in_review' or old.status = 'in_review' then
    return new;
  end if;

  if not exists (
    select 1 from projects.scope_versions sv
     where sv.project_id = new.project_id and sv.status = 'active'
  ) then
    -- No agreed scope, so there is nothing to cover. Blocking here would block
    -- every design filed before the scope is agreed, which is most early
    -- design work and which no document asks for.
    return new;
  end if;

  select count(*), min(c.subject)
    into v_gaps, v_first
    from projects.ui_coverage(new.project_id) c
   where c.blocking;

  if v_gaps > 0 then
    raise exception
      'the design does not cover the agreed scope: % blocking gap(s), first "%" (Doc 12 §20)',
      v_gaps, v_first
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists refuse_uncovered_design on projects.deliverables;
create trigger refuse_uncovered_design
  before update of status on projects.deliverables
  for each row execute function projects.refuse_uncovered_design();

comment on function projects.refuse_uncovered_design() is
  'Doc 12 section 9: "This matrix is one of the main controls preventing an AI designer from producing attractive but incomplete work." A trigger rather than a third redefinition of submit_deliverable - that function has been re-emitted once already and re-emitting is how a branch gets silently dropped. Fires only for design, only into in_review, and only when the project has an active scope baseline.';

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table projects.screens enable row level security;
alter table projects.screens force row level security;
alter table projects.screen_scope_items enable row level security;
alter table projects.screen_scope_items force row level security;

drop policy if exists screens_select on projects.screens;
create policy screens_select on projects.screens
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists screen_scope_items_select on projects.screen_scope_items;
create policy screen_scope_items_select on projects.screen_scope_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_screens_project on projects.screens;
create trigger org_match_screens_project
  before insert or update of project_id, organization_id on projects.screens
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_screens_deliverable on projects.screens;
create trigger org_match_screens_deliverable
  before insert or update of deliverable_id, organization_id on projects.screens
  for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');

drop trigger if exists freeze_org_screens on projects.screens;
create trigger freeze_org_screens
  before update of organization_id on projects.screens
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_screen_scope_items_screen on projects.screen_scope_items;
create trigger org_match_screen_scope_items_screen
  before insert or update of screen_id, organization_id on projects.screen_scope_items
  for each row execute function core.enforce_parent_org('screen_id', 'projects.screens');

drop trigger if exists org_match_screen_scope_items_item on projects.screen_scope_items;
create trigger org_match_screen_scope_items_item
  before insert or update of scope_item_id, organization_id on projects.screen_scope_items
  for each row execute function core.enforce_parent_org('scope_item_id', 'projects.scope_items');

drop trigger if exists freeze_org_screen_scope_items on projects.screen_scope_items;
create trigger freeze_org_screen_scope_items
  before update of organization_id on projects.screen_scope_items
  for each row execute function core.freeze_organization_id();

notify pgrst, 'reload schema';
