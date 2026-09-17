-- ═══════════════════════════════════════════════════════════════════════════
-- Two or three, and not one more.
--
-- Master §7.5 and Designer §4.2 ask for the same bounded thing:
--
--   *"Figma Designer Agent creates 2-3 distinct, meaningful UI theme
--   directions. Do not create excessive variants purely to consume generation
--   capacity."*
--
-- and §18 names the cost risk it is guarding against — *"too many theme
-- options"* — with the control written as *"hard/default policy of 2-3
-- meaningful directions"*. Designer §5 repeats it as a prohibition: *"must not
-- generate 10-20 options when the locked requirement is approximately 2-3."*
--
-- **A policy a prompt states is a policy a model can decline to follow.** This
-- one is a row rule, so it holds against a retried job, a second agent, a
-- repair script and a future caller nobody has written yet.
--
-- ── the reuse key, and why it is a hash of inputs ───────────────────────
--
-- §18's first cost row is *"same visual regenerated repeatedly"*, controlled by
-- *"hash/version input; reuse existing artifact if unchanged"*. Designer §10
-- says the same as a responsibility: *"reuse unchanged results when input
-- context/version has not changed."*
--
-- So every theme option carries `source_context_version` — a hash over what a
-- designer would actually need to know before drawing anything:
--
--   the approved scope version, because that is what was sold;
--   the finalized screen baseline version, because that is what it must cover;
--   what the client already told us about platforms, design expectations and
--     existing assets.
--
-- That last one is **not a new column**. `crm.qualification_coverage` has
-- carried `platforms`, `design_expectations` and `existing_assets` since
-- 2026-08 as the client's own quoted words, one answer per area, with the quote
-- as evidence. PM §4.2's *"do not re-ask confirmed brand/theme/reference
-- preferences unnecessarily"* is satisfied by reading what Phase 1 already
-- heard, and Master §6's first cost-control line asks for exactly that reuse.
--
-- The hash is computed in SQL, deterministically. Master §6: *"use
-- deterministic code/rules for orchestration, state, comparison metadata and
-- storage; do not spend LLM tokens on deterministic tasks."* A context version
-- is comparison metadata.
--
-- ── project_type, and a granted decision that outranks a field name ─────
--
-- Designer §11's brief contract lists `project_type`. **There is no such field
-- in this repository and there is not going to be one.** ADM-73, granted
-- 2026-08-14: *"AgencyOS must NOT restrict projects to a small hardcoded list
-- of service categories… model WHAT THE CLIENT PROJECT IS and WHAT HAS BEEN
-- SOLD, rather than artificially limiting what the agency is capable of
-- selling."*
--
-- The mandate's precedence rule puts the Phase 3 PDFs above older
-- *specifications*. ADM-73 is not a specification — it is the owner's answer to
-- a question this system asked, and it answers the same question §11's field
-- would be asking. So the brief carries what the project IS, by reference to
-- the approved scope items that were sold, and no type enum is created.
-- Recorded as D-5 in the Phase 3 traceability matrix.
--
-- ── Figma: references are recorded, never claimed ──────────────────────
--
-- There is no Figma integration on this deployment and no credential for one.
-- Master §20 and Designer §24 both say what to do about that, in the same
-- words: *"if fully automated Figma creation is not supported… expose the
-- exact manual/assisted step instead of faking success."*
--
-- So every Figma column here is nullable and is filled in by a person who did
-- the work in Figma. `figma_linked_at` records when that happened and by whom.
-- **Nothing in this migration contacts Figma, and nothing claims to.** The
-- gate that refuses to share an unlinked option with a client belongs to the
-- unit that builds the client share, and is noted here so its absence is a
-- decision rather than an oversight.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the ceiling, configurable like the revision limit ───────────────────

alter table projects.phase_three
  add column if not exists theme_option_limit int not null default 3
    check (theme_option_limit between 1 and 5);

comment on column projects.phase_three.theme_option_limit is
  'Master section 18 - the hard policy of 2-3 meaningful directions, as a configurable column rather than a number inside a door. Capped at 5 rather than unbounded: section 18 names "too many theme options" as a cost risk and Designer section 5 forbids generating 10-20, so a limit a caller could set to 50 would not be a limit.';

-- ── the design context version ──────────────────────────────────────────

create or replace function projects.design_context_version(p_project_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  -- Deterministic, and deliberately so: a context version is comparison
  -- metadata, and Master §6 forbids spending model tokens on it.
  --
  -- `coalesce` on every part, because a NULL anywhere in a concatenation makes
  -- the whole string NULL — and a null hash would compare equal to another
  -- null hash, which is the reuse bug this function exists to prevent.
  select md5(
    coalesce((
      select sv.id::text || ':' || sv.version::text
        from projects.scope_versions sv
       where sv.project_id = p_project_id and sv.status = 'active'
       order by sv.version desc limit 1
    ), 'no-scope')
    || '|' ||
    coalesce((
      select sb.version::text || ':' || sb.screen_count::text
        from projects.screen_baselines sb
       where sb.project_id = p_project_id and sb.status = 'finalized'
       order by sb.version desc limit 1
    ), 'no-baseline')
    || '|' ||
    -- What the client already told us. Read from Phase 1's record rather than
    -- asked again (PM §4.2), and ordered so the hash is stable across reads.
    coalesce((
      select string_agg(qc.area || '=' || md5(qc.quote), ',' order by qc.area)
        from crm.qualification_coverage qc
        join crm.leads l on l.id = qc.lead_id
        join sales.opportunities o on o.lead_id = l.id
        join projects.projects p on p.opportunity_id = o.id
       where p.id = p_project_id
         and qc.area in ('platforms', 'design_expectations', 'existing_assets',
                         'service_type', 'target_users')
    ), 'no-coverage')
  );
$$;

comment on function projects.design_context_version(uuid) is
  'Master section 18 and Designer section 10 - the reuse key. A stable hash over the approved scope version, the finalized screen baseline and what the client already said about platforms, design expectations and existing assets. Deterministic SQL because section 6 forbids spending model tokens on comparison metadata. Every part is coalesced: a NULL anywhere would make the whole hash NULL, and two null hashes compare equal, which is the reuse bug this exists to prevent.';

revoke all on function projects.design_context_version(uuid) from public, anon;
grant execute on function projects.design_context_version(uuid) to authenticated, service_role;

-- ── Master §11's theme option ───────────────────────────────────────────

create table if not exists projects.theme_options (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  phase_three_id   uuid not null references projects.phase_three(id) on delete cascade,

  -- §11's option identity. The index is what the ceiling counts and what a
  -- retry collides on.
  option_index     int not null check (option_index between 1 and 5),
  name             text not null check (length(btrim(name)) between 1 and 120),

  -- §11 "description" and Designer §12 "visual_direction_summary". One column:
  -- two fields for one idea is two things to keep in step.
  direction_summary text not null check (length(btrim(direction_summary)) between 1 and 2000),

  -- Designer §6's theme dimensions, as the metadata §11 calls
  -- `design_direction_metadata`. jsonb because §6 lists ten dimensions and
  -- names none of them as required — a column per dimension would assert a
  -- completeness the specification does not ask for.
  direction_metadata jsonb not null default '{}'::jsonb,

  -- THE REUSE KEY (§18, Designer §10).
  source_context_version text not null check (length(btrim(source_context_version)) > 0),

  -- §11's generation/revision origin.
  origin           text not null default 'initial'
                     check (origin in ('initial', 'internal_review', 'admin_edit', 'client_revision')),
  revision_of      uuid references projects.theme_options(id) on delete set null,
  version          int not null default 1 check (version > 0),

  -- ── Figma, recorded and never claimed (Master §20, Designer §24) ──────
  figma_file_key   text,
  figma_page_id    text,
  figma_node_id    text,
  figma_version    text,
  figma_linked_at  timestamptz,
  figma_linked_by  uuid references core.users(id) on delete set null,

  -- §5: a preview is a SECONDARY review artifact and may never replace the
  -- node reference.
  preview_asset_url text,

  -- §11's three independent statuses. Three columns because §16's order is
  -- internal → Admin → client and a single status could not express "internally
  -- passed, waiting on Admin" without inventing a combined vocabulary.
  internal_review_status text not null default 'draft'
                     check (internal_review_status in ('draft', 'in_review', 'changes_required', 'passed')),
  admin_status     text not null default 'not_submitted'
                     check (admin_status in ('not_submitted', 'in_review', 'edit_requested', 'approved')),
  client_status    text not null default 'not_shared'
                     check (client_status in ('not_shared', 'shared', 'change_requested', 'selected', 'locked')),

  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- The idempotency §18 asks for: "retry causes new AI call → idempotent job +
  -- artifact reuse." Same project, same context version, same option index is
  -- the same option.
  unique (project_id, source_context_version, option_index),

  -- A Figma reference that is half-filled is worse than none: Phase 4 must be
  -- able to open the exact node, and a file key with no node is a file.
  constraint theme_options_figma_is_whole
    check (figma_file_key is null
           or (figma_node_id is not null and figma_linked_at is not null)),

  -- §16: "final selection cannot be overwritten silently." A locked option is
  -- the one the client chose, and it must have been chosen.
  constraint theme_options_locked_was_selected
    check (client_status <> 'locked' or admin_status = 'approved')
);

create index if not exists theme_options_project_idx
  on projects.theme_options (organization_id, project_id, source_context_version);

comment on table projects.theme_options is
  'Master section 11 and Designer section 12 - a UI theme direction. UNIQUE on (project, source_context_version, option_index) is section 18s idempotency: the same inputs and the same option index are the same option, so a retried job reuses rather than regenerates. Three separate status columns because section 16s order is internal then Admin then client, and one column could not say "internally passed, waiting on Admin" without inventing a combined vocabulary. Every Figma column is nullable and filled in by a person: there is no Figma integration on this deployment and section 20 says to expose the manual step rather than fake success.';

comment on column projects.theme_options.preview_asset_url is
  'Master section 5 - a SECONDARY review artifact. It may never replace the Figma node reference: section 5 is explicit that screenshots and generated images must not become the canonical design source, which is why theme_options_figma_is_whole constrains the node and not this.';

-- ── the ceiling, as a row rule ──────────────────────────────────────────

create or replace function projects.enforce_theme_option_ceiling()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_limit int;
  v_count int;
begin
  select p3.theme_option_limit into v_limit
    from projects.phase_three p3
   where p3.id = new.phase_three_id;

  select count(*) into v_count
    from projects.theme_options t
   where t.project_id = new.project_id
     and t.source_context_version = new.source_context_version
     and t.id is distinct from new.id;

  if v_count >= coalesce(v_limit, 3) then
    -- Master §18's control, and Designer §5's prohibition, at the row. A
    -- prompt asking for three is a request; this is the answer.
    raise exception
      'this project already has % theme directions for this design context; the policy is % (Master section 18)',
      v_count, coalesce(v_limit, 3)
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_theme_option_ceiling on projects.theme_options;
create trigger enforce_theme_option_ceiling
  before insert on projects.theme_options
  for each row execute function projects.enforce_theme_option_ceiling();

-- ── Master §12's colour option ──────────────────────────────────────────

create table if not exists projects.color_options (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  theme_option_id  uuid not null references projects.theme_options(id) on delete cascade,

  option_index     int not null check (option_index between 1 and 5),
  palette_name     text not null check (length(btrim(palette_name)) between 1 and 120),

  -- §12 and Designer §13's tokens. Named columns rather than a blob because
  -- Designer §4.3 asks for "reusable color tokens instead of only visual
  -- swatches", and Phase 4 has to read them without guessing a key spelling.
  -- Hex is validated: a token Phase 4 cannot parse is a token it will re-pick.
  primary_hex      text not null check (primary_hex ~* '^#[0-9a-f]{6}$'),
  secondary_hex    text check (secondary_hex is null or secondary_hex ~* '^#[0-9a-f]{6}$'),
  accent_hex       text check (accent_hex is null or accent_hex ~* '^#[0-9a-f]{6}$'),
  background_hex   text check (background_hex is null or background_hex ~* '^#[0-9a-f]{6}$'),
  surface_hex      text check (surface_hex is null or surface_hex ~* '^#[0-9a-f]{6}$'),
  text_primary_hex text check (text_primary_hex is null or text_primary_hex ~* '^#[0-9a-f]{6}$'),
  text_secondary_hex text check (text_secondary_hex is null or text_secondary_hex ~* '^#[0-9a-f]{6}$'),
  success_hex      text check (success_hex is null or success_hex ~* '^#[0-9a-f]{6}$'),
  warning_hex      text check (warning_hex is null or warning_hex ~* '^#[0-9a-f]{6}$'),
  error_hex        text check (error_hex is null or error_hex ~* '^#[0-9a-f]{6}$'),

  -- §13 "contrast/accessibility notes" and "brand constraint source". Prose,
  -- because Master §21's accessibility section says Phase 3 is explicitly NOT
  -- a WCAG certification and a computed score would claim one.
  contrast_notes   text,
  brand_source     text,

  preview_asset_url text,

  client_status    text not null default 'not_shared'
                     check (client_status in ('not_shared', 'shared', 'selected', 'locked')),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (theme_option_id, option_index)
);

create index if not exists color_options_theme_idx
  on projects.color_options (organization_id, theme_option_id);

comment on table projects.color_options is
  'Master section 12 and Designer section 13. Tokens as named validated columns rather than a blob, because Designer section 4.3 asks for reusable tokens rather than swatches and Phase 4 must read them without guessing a key spelling. Contrast notes are PROSE: Master section 21 says Phase 3 is not a WCAG certification, and a computed score would claim one.';

-- ── tenancy and RLS, as every table here carries them ───────────────────

drop trigger if exists org_match_theme_options_project on projects.theme_options;
create trigger org_match_theme_options_project
  before insert or update of project_id, organization_id on projects.theme_options
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_theme_options_phase on projects.theme_options;
create trigger org_match_theme_options_phase
  before insert or update of phase_three_id, organization_id on projects.theme_options
  for each row execute function core.enforce_parent_org('phase_three_id', 'projects.phase_three');

drop trigger if exists freeze_org_theme_options on projects.theme_options;
create trigger freeze_org_theme_options
  before update of organization_id on projects.theme_options
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_theme_options on projects.theme_options;
create trigger set_updated_at_theme_options
  before update on projects.theme_options
  for each row execute function core.set_updated_at();

drop trigger if exists org_match_color_options_theme on projects.color_options;
create trigger org_match_color_options_theme
  before insert or update of theme_option_id, organization_id on projects.color_options
  for each row execute function core.enforce_parent_org('theme_option_id', 'projects.theme_options');

drop trigger if exists freeze_org_color_options on projects.color_options;
create trigger freeze_org_color_options
  before update of organization_id on projects.color_options
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_color_options on projects.color_options;
create trigger set_updated_at_color_options
  before update on projects.color_options
  for each row execute function core.set_updated_at();

alter table projects.theme_options enable row level security;
alter table projects.theme_options force row level security;
alter table projects.color_options enable row level security;
alter table projects.color_options force row level security;

drop policy if exists theme_options_select on projects.theme_options;
create policy theme_options_select on projects.theme_options
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists color_options_select on projects.color_options;
create policy color_options_select on projects.color_options
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.theme_options to authenticated, service_role;
grant select on projects.color_options to authenticated, service_role;

-- ── the events Master §15 names ─────────────────────────────────────────

insert into core.event_types (type, description, canonical) values
  ('project.theme_options_generated',
   'Master section 15 ThemeOptionsGenerated - a set of UI theme directions exists for a design context version and is ready for internal review.',
   true),
  ('project.color_options_generated',
   'Master section 15 ColorOptionsGenerated - colour combinations are linked to a theme direction.',
   true)
on conflict (type) do nothing;

-- ── the doors ───────────────────────────────────────────────────────────

create or replace function projects.record_theme_option(
  p_project_id       uuid,
  p_option_index     int,
  p_name             text,
  p_direction_summary text,
  p_metadata         jsonb default '{}'::jsonb
)
returns table (
  -- 'recorded' | 'already_recorded' | 'limit_reached' | 'no_phase_three'
  -- | 'no_baseline' | 'no_actor' | 'forbidden'
  outcome         text,
  theme_option_id uuid,
  context_version text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_context  text;
  v_existing projects.theme_options;
  v_new      uuid;
  v_baseline int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::text; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.project_id = p_project_id
   for update;

  if v_phase3.id is null then
    return query select 'no_phase_three'::text, null::uuid, null::text; return;
  end if;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::uuid, null::text; return;
  end if;

  -- Designer §2's start condition: "screen list and screen-by-screen content
  -- baseline are sufficiently defined for theme work." A theme drawn against
  -- no agreed screens is a picture, not a direction.
  select count(*) into v_baseline
    from projects.screen_baselines sb
   where sb.project_id = p_project_id and sb.status = 'finalized';

  if v_baseline = 0 then
    return query select 'no_baseline'::text, null::uuid, null::text; return;
  end if;

  v_context := projects.design_context_version(p_project_id);

  -- §18's idempotency, answered before the insert so a replay gets the row
  -- rather than a constraint violation.
  select t.* into v_existing
    from projects.theme_options t
   where t.project_id = p_project_id
     and t.source_context_version = v_context
     and t.option_index = p_option_index;

  if v_existing.id is not null then
    return query select 'already_recorded'::text, v_existing.id, v_context; return;
  end if;

  begin
    insert into projects.theme_options (
      organization_id, project_id, phase_three_id, option_index, name,
      direction_summary, direction_metadata, source_context_version, created_by
    ) values (
      v_phase3.organization_id, p_project_id, v_phase3.id, p_option_index, btrim(p_name),
      btrim(p_direction_summary), coalesce(p_metadata, '{}'::jsonb), v_context, v_actor
    )
    returning id into v_new;
  exception
    when check_violation then
      -- The ceiling trigger. Answered rather than raised, because asking for a
      -- fourth direction is a policy refusal a caller should read, not a crash.
      return query select 'limit_reached'::text, null::uuid, v_context; return;
  end;

  perform core.record_audit(
    v_phase3.organization_id, 'project.theme_options_generated', 'theme_option', v_new, null,
    jsonb_build_object('projectId', p_project_id, 'optionIndex', p_option_index, 'contextVersion', v_context)
  );

  perform core.emit_event(
    v_phase3.organization_id, 'project.theme_options_generated', 'theme_option', v_new,
    jsonb_build_object('projectId', p_project_id, 'optionIndex', p_option_index, 'contextVersion', v_context)
  );

  return query select 'recorded'::text, v_new, v_context;
end;
$$;

comment on function projects.record_theme_option(uuid, int, text, text, jsonb) is
  'Master sections 7.5, 11 and 18. Records ONE theme direction against the current design context version, which is the reuse key: a replay with the same context and index answers already_recorded with the existing row rather than generating again. Refuses a fourth direction by policy (limit_reached), refuses theme work before a screen baseline is finalized (no_baseline), and creates no Figma artifact - there is no Figma integration on this deployment and section 20 says to expose the manual step rather than fake one.';

create or replace function projects.link_theme_figma(
  p_theme_option_id uuid,
  p_file_key        text,
  p_node_id         text,
  p_page_id         text default null,
  p_figma_version   text default null,
  p_preview_url     text default null
)
returns table (
  -- 'linked' | 'unknown_option' | 'incomplete_reference' | 'no_actor' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.theme_options;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  -- Refused on the ARGUMENTS, before the row is read: a half reference is a
  -- mistake about what was pasted, not about this option. Phase 4 must be able
  -- to open the exact node, and a file key with no node is a file.
  if p_file_key is null or btrim(p_file_key) = ''
     or p_node_id is null or btrim(p_node_id) = '' then
    return query select 'incomplete_reference'::text; return;
  end if;

  select t.* into v_row from projects.theme_options t where t.id = p_theme_option_id for update;
  if v_row.id is null then
    return query select 'unknown_option'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  update projects.theme_options
     set figma_file_key  = btrim(p_file_key),
         figma_node_id   = btrim(p_node_id),
         figma_page_id   = nullif(btrim(coalesce(p_page_id, '')), ''),
         figma_version   = nullif(btrim(coalesce(p_figma_version, '')), ''),
         preview_asset_url = nullif(btrim(coalesce(p_preview_url, '')), ''),
         figma_linked_at = now(),
         figma_linked_by = v_actor
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'theme_option.figma_linked', 'theme_option', v_row.id,
    jsonb_build_object('figmaFileKey', v_row.figma_file_key, 'figmaNodeId', v_row.figma_node_id),
    jsonb_build_object('figmaFileKey', btrim(p_file_key), 'figmaNodeId', btrim(p_node_id))
  );

  return query select 'linked'::text;
end;
$$;

comment on function projects.link_theme_figma(uuid, text, text, text, text, text) is
  'Master section 20 and Designer section 24 - the assisted step. THIS DOES NOT CONTACT FIGMA: there is no integration on this deployment, so a person does the work in Figma and records the canonical reference here, and figma_linked_by records who. A half reference is refused on the arguments, because Phase 4 must open the exact node and a file key with no node is a file. The audit carries the old reference as well as the new, so replacing a link is visible rather than silent.';

create or replace function projects.record_color_option(
  p_theme_option_id uuid,
  p_option_index    int,
  p_palette_name    text,
  p_primary_hex     text,
  p_tokens          jsonb default '{}'::jsonb,
  p_contrast_notes  text default null,
  p_brand_source    text default null
)
returns table (
  -- 'recorded' | 'already_recorded' | 'unknown_option' | 'bad_token'
  -- | 'no_actor' | 'forbidden'
  outcome         text,
  color_option_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_theme    projects.theme_options;
  v_existing projects.color_options;
  v_new      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select t.* into v_theme from projects.theme_options t where t.id = p_theme_option_id for update;
  if v_theme.id is null then
    return query select 'unknown_option'::text, null::uuid; return;
  end if;

  if v_theme.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select c.* into v_existing
    from projects.color_options c
   where c.theme_option_id = p_theme_option_id
     and c.option_index = p_option_index;

  if v_existing.id is not null then
    return query select 'already_recorded'::text, v_existing.id; return;
  end if;

  begin
    insert into projects.color_options (
      organization_id, theme_option_id, option_index, palette_name,
      primary_hex, secondary_hex, accent_hex, background_hex, surface_hex,
      text_primary_hex, text_secondary_hex, success_hex, warning_hex, error_hex,
      contrast_notes, brand_source
    ) values (
      v_theme.organization_id, p_theme_option_id, p_option_index, btrim(p_palette_name),
      btrim(p_primary_hex),
      nullif(btrim(coalesce(p_tokens->>'secondary', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'accent', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'background', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'surface', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'textPrimary', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'textSecondary', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'success', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'warning', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'error', '')), ''),
      nullif(btrim(coalesce(p_contrast_notes, '')), ''),
      nullif(btrim(coalesce(p_brand_source, '')), '')
    )
    returning id into v_new;
  exception
    when check_violation then
      -- A hex that is not a hex. Answered rather than raised: the caller
      -- mistyped a token, and Phase 4 reading an unparseable colour would
      -- re-pick it, which is the whole thing the token exists to prevent.
      return query select 'bad_token'::text, null::uuid; return;
  end;

  perform core.record_audit(
    v_theme.organization_id, 'project.color_options_generated', 'color_option', v_new, null,
    jsonb_build_object('themeOptionId', p_theme_option_id, 'optionIndex', p_option_index)
  );

  perform core.emit_event(
    v_theme.organization_id, 'project.color_options_generated', 'color_option', v_new,
    jsonb_build_object('themeOptionId', p_theme_option_id, 'optionIndex', p_option_index)
  );

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function projects.record_color_option(uuid, int, text, text, jsonb, text, text) is
  'Master section 12 and Designer section 13. One palette linked to one theme direction, idempotent on (theme, index). Tokens are validated hex: Phase 4 reading an unparseable colour would re-pick it, which is exactly what a token exists to prevent, so a malformed one is refused as bad_token rather than stored.';

revoke all on function projects.record_theme_option(uuid, int, text, text, jsonb) from public, anon;
revoke all on function projects.link_theme_figma(uuid, text, text, text, text, text) from public, anon;
revoke all on function projects.record_color_option(uuid, int, text, text, jsonb, text, text) from public, anon;
grant execute on function projects.record_theme_option(uuid, int, text, text, jsonb) to authenticated;
grant execute on function projects.link_theme_figma(uuid, text, text, text, text, text) to authenticated;
grant execute on function projects.record_color_option(uuid, int, text, text, jsonb, text, text) to authenticated;

notify pgrst, 'reload schema';
