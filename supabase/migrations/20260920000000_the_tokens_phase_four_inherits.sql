-- ═══════════════════════════════════════════════════════════════════════════
-- The tokens Phase 4 inherits.
--
-- Designer §4.5, §19, §23. §23 asks for a `DesignTokenSet` carrying
-- *"typography/color/spacing/surface primitives + version"*, and §19 says what
-- it is for:
--
--   *"Phase 4 receives design tokens/primitives **rather than recreating
--   them**."*
--
-- ── the boundary is the schema having nowhere to cross it ─────────────
--
-- §4.5 states the scope twice, once as an instruction and once as a
-- prohibition:
--
--   *"Define **only the Phase 3 level** of visual primitives needed to
--   communicate the direction."*
--   *"**Do not overbuild the complete production design system** if Phase 3
--   does not require it."*
--
-- So every primitive §4.5 names is a **named column**, and there is no jsonb
-- catch-all. That is the whole boundary, and it is deliberate: a `tokens
-- jsonb` column is exactly where a complete production design system arrives
-- — one component at a time, each addition reasonable on its own, and nothing
-- ever refuses. A column per primitive cannot absorb a component variant
-- matrix, a breakpoint system or a motion spec, because there is nowhere to
-- put one.
--
-- Same doctrine as G-256's plan schema and G-277's workspace: the rule is held
-- by the shape, not by whoever is writing next.
--
-- ── colour is NOT here, and that is the reuse rule ────────────────────
--
-- §23's list says *"typography/color/spacing/surface"*, and this table has no
-- colour in it. That is not an omission.
--
-- `projects.color_options` already holds the palette as named, validated hex
-- tokens — §4.3's *"define reusable color tokens instead of only visual
-- swatches"*, built in G-279. Copying them here would create two places a
-- palette can disagree with itself, and §10's first cost-control line is
-- *"reuse approved components, tokens and brand assets."*
--
-- So a token set **references its theme**, whose colour options are the colour
-- tokens. The handoff assembles both.
--
-- ── and it is not `src/ui/tokens.ts` (decision D-3) ───────────────────
--
-- That file is **AgencyOS's own product theme**. A client's direction is per
-- client per theme option, and reusing the product's tokens as a client's
-- palette is the *"same visual branding"* mistake the master flow names. They
-- share a word and nothing else.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.design_token_sets (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- §23: "per client per theme option." A direction's primitives are part of
  -- the direction, not of the project.
  theme_option_id  uuid not null references projects.theme_options(id) on delete cascade,

  version          int not null default 1 check (version > 0),
  status           text not null default 'draft' check (status in ('draft', 'final')),

  -- ── §4.5's list, one named column each ───────────────────────────────
  --
  -- "typography style, color tokens, surfaces, buttons, cards, spacing feel,
  -- border/radius/shadow style, icon treatment and key navigation style."
  -- Colour is absent on purpose; see above.

  font_family_heading text check (font_family_heading is null or length(btrim(font_family_heading)) between 1 and 120),
  font_family_body    text check (font_family_body is null or length(btrim(font_family_body)) between 1 and 120),

  -- §4.5 says "typography STYLE" and "spacing FEEL" — a direction, not a
  -- production spec. A ratio and a base unit say what a reviewer needs and
  -- cannot become a full type scale table.
  type_scale_ratio    numeric(4, 3) check (type_scale_ratio is null or type_scale_ratio between 1.000 and 2.000),
  base_spacing_px     int check (base_spacing_px is null or base_spacing_px between 2 and 16),

  radius_style        text check (radius_style is null or radius_style in ('sharp', 'soft', 'rounded', 'pill')),
  elevation_style     text check (elevation_style is null or elevation_style in ('flat', 'subtle', 'layered')),
  border_style        text check (border_style is null or border_style in ('none', 'hairline', 'defined')),
  icon_treatment      text check (icon_treatment is null or icon_treatment in ('outline', 'filled', 'duotone', 'mixed')),
  navigation_style    text check (navigation_style is null or navigation_style in ('top_bar', 'side_nav', 'bottom_tabs', 'hybrid')),

  -- §4.5's "buttons, cards" — the shape they take, in one sentence each.
  -- Deliberately prose and deliberately short: a Phase 3 primitive is a
  -- direction a reviewer can judge, not a component specification.
  button_treatment    text check (button_treatment is null or length(btrim(button_treatment)) between 1 and 300),
  card_treatment      text check (card_treatment is null or length(btrim(card_treatment)) between 1 and 300),

  notes               text check (notes is null or length(btrim(notes)) between 1 and 1000),

  created_by       uuid references core.users(id) on delete set null,
  finalized_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (theme_option_id, version),

  constraint design_token_sets_final_is_dated
    check (status <> 'final' or finalized_at is not null),

  -- A set that says nothing communicates no direction, and §19 would hand
  -- Phase 4 an empty object to "inherit". At least one primitive, or it is not
  -- a token set.
  constraint design_token_sets_says_something
    check (num_nonnulls(font_family_heading, font_family_body, type_scale_ratio,
                        base_spacing_px, radius_style, elevation_style, border_style,
                        icon_treatment, navigation_style, button_treatment, card_treatment) > 0)
);

comment on table projects.design_token_sets is
  'Designer section 23 DesignTokenSet, at section 4.5''s scope and no further. EVERY PRIMITIVE IS A NAMED COLUMN AND THERE IS NO JSONB CATCH-ALL - that is the boundary section 4.5 asks for, held by the shape rather than by whoever writes next: a tokens jsonb column is exactly where a complete production design system arrives, one reasonable addition at a time. COLOUR IS DELIBERATELY ABSENT: projects.color_options already holds the palette as named validated hex tokens, and copying them here would create two places a palette can disagree with itself. Not to be confused with src/ui/tokens.ts, which is AgencyOS''s own product theme (decision D-3).';

comment on column projects.design_token_sets.type_scale_ratio is
  'Section 4.5 says typography STYLE and spacing FEEL - a direction a reviewer can judge, not a production spec. A ratio and a base unit carry that and cannot grow into a full type scale table.';

create index if not exists design_token_sets_theme_idx
  on projects.design_token_sets (theme_option_id, version desc);

create trigger design_token_sets_parent_org_project
  before insert or update of project_id on projects.design_token_sets
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

create trigger design_token_sets_parent_org_theme
  before insert or update of theme_option_id on projects.design_token_sets
  for each row execute function core.enforce_parent_org('theme_option_id', 'projects.theme_options');

create trigger freeze_org_design_token_sets
  before update of organization_id on projects.design_token_sets
  for each row execute function core.freeze_organization_id();

create trigger design_token_sets_updated_at
  before update on projects.design_token_sets
  for each row execute function core.set_updated_at();

-- §19: Phase 4 inherits these. A finalized set that could still change would
-- make the handoff a promise rather than a record — the same rule the screen
-- baseline and the share already carry.
create or replace function projects.freeze_final_token_set()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'final' then
    raise exception 'a finalized design token set is what Phase 4 inherits; draft the next version instead';
  end if;
  return new;
end;
$$;

create trigger freeze_final_token_set
  before update on projects.design_token_sets
  for each row execute function projects.freeze_final_token_set();

alter table projects.design_token_sets enable row level security;
alter table projects.design_token_sets force row level security;

drop policy if exists design_token_sets_select on projects.design_token_sets;
create policy design_token_sets_select on projects.design_token_sets
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.design_token_sets to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.design_tokens_finalized',
   'Designer section 19. A theme direction''s Phase 3 primitives were finalized. Phase 4 inherits them rather than recreating them.',
   true)
on conflict (type) do nothing;

-- ── the doors ───────────────────────────────────────────────────────────

create or replace function projects.record_design_token_set(
  p_theme_option_id  uuid,
  p_font_family_heading text default null,
  p_font_family_body text default null,
  p_type_scale_ratio numeric default null,
  p_base_spacing_px  int default null,
  p_radius_style     text default null,
  p_elevation_style  text default null,
  p_border_style     text default null,
  p_icon_treatment   text default null,
  p_navigation_style text default null,
  p_button_treatment text default null,
  p_card_treatment   text default null,
  p_notes            text default null
)
returns table (
  -- 'recorded' | 'no_actor' | 'forbidden' | 'unknown_theme'
  -- | 'says_nothing' | 'already_final'
  outcome text,
  token_set_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_theme projects.theme_options;
  v_prev  projects.design_token_sets;
  v_id    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  -- Argument-only: a set that says nothing communicates no direction, and the
  -- row rule refuses it anyway — but a named refusal is readable.
  if num_nonnulls(
       nullif(btrim(coalesce(p_font_family_heading, '')), ''),
       nullif(btrim(coalesce(p_font_family_body, '')), ''),
       p_type_scale_ratio, p_base_spacing_px,
       nullif(btrim(coalesce(p_radius_style, '')), ''),
       nullif(btrim(coalesce(p_elevation_style, '')), ''),
       nullif(btrim(coalesce(p_border_style, '')), ''),
       nullif(btrim(coalesce(p_icon_treatment, '')), ''),
       nullif(btrim(coalesce(p_navigation_style, '')), ''),
       nullif(btrim(coalesce(p_button_treatment, '')), ''),
       nullif(btrim(coalesce(p_card_treatment, '')), '')) = 0 then
    return query select 'says_nothing'::text, null::uuid; return;
  end if;

  select t.* into v_theme from projects.theme_options t where t.id = p_theme_option_id;
  if v_theme.id is null then
    return query select 'unknown_theme'::text, null::uuid; return;
  end if;

  if v_theme.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- One draft per direction, edited until it is finalized. A finalized set is
  -- superseded by a NEW version rather than reopened.
  select s.id into v_id
    from projects.design_token_sets s
   where s.theme_option_id = p_theme_option_id
     and s.status = 'draft'
   order by s.version desc
   limit 1;

  -- ── null means UNCHANGED, and a new version inherits ─────────────────
  --
  -- Found by driving this: a version that started blank lost every primitive
  -- the previous one carried. Somebody changing the radius would silently drop
  -- the typography — the opposite of §19's *"reusable components created in
  -- Phase 3 are preserved"* and of §10's reuse line.
  --
  -- So the door OVERLAYS: an argument left null leaves that primitive as it
  -- was, and a new version starts from the last finalized one. The cost is
  -- that this door cannot clear a primitive back to null, only change one —
  -- the right trade where accidental loss is silent and correction is a
  -- second call.
  select s.* into v_prev
    from projects.design_token_sets s
   where s.theme_option_id = p_theme_option_id
   order by s.version desc
   limit 1;

  if v_id is null then
    insert into projects.design_token_sets (
      organization_id, project_id, theme_option_id, version,
      font_family_heading, font_family_body, type_scale_ratio, base_spacing_px,
      radius_style, elevation_style, border_style, icon_treatment, navigation_style,
      button_treatment, card_treatment, notes, created_by
    ) values (
      v_theme.organization_id, v_theme.project_id, p_theme_option_id,
      coalesce((select max(s2.version) + 1 from projects.design_token_sets s2
                 where s2.theme_option_id = p_theme_option_id), 1),
      coalesce(nullif(btrim(coalesce(p_font_family_heading, '')), ''), v_prev.font_family_heading),
      coalesce(nullif(btrim(coalesce(p_font_family_body, '')), ''), v_prev.font_family_body),
      coalesce(p_type_scale_ratio, v_prev.type_scale_ratio),
      coalesce(p_base_spacing_px, v_prev.base_spacing_px),
      coalesce(nullif(btrim(coalesce(p_radius_style, '')), ''), v_prev.radius_style),
      coalesce(nullif(btrim(coalesce(p_elevation_style, '')), ''), v_prev.elevation_style),
      coalesce(nullif(btrim(coalesce(p_border_style, '')), ''), v_prev.border_style),
      coalesce(nullif(btrim(coalesce(p_icon_treatment, '')), ''), v_prev.icon_treatment),
      coalesce(nullif(btrim(coalesce(p_navigation_style, '')), ''), v_prev.navigation_style),
      coalesce(nullif(btrim(coalesce(p_button_treatment, '')), ''), v_prev.button_treatment),
      coalesce(nullif(btrim(coalesce(p_card_treatment, '')), ''), v_prev.card_treatment),
      coalesce(nullif(btrim(coalesce(p_notes, '')), ''), v_prev.notes), v_actor
    )
    returning id into v_id;
  else
    update projects.design_token_sets set
      font_family_heading = coalesce(nullif(btrim(coalesce(p_font_family_heading, '')), ''), font_family_heading),
      font_family_body    = coalesce(nullif(btrim(coalesce(p_font_family_body, '')), ''), font_family_body),
      type_scale_ratio    = coalesce(p_type_scale_ratio, type_scale_ratio),
      base_spacing_px     = coalesce(p_base_spacing_px, base_spacing_px),
      radius_style        = coalesce(nullif(btrim(coalesce(p_radius_style, '')), ''), radius_style),
      elevation_style     = coalesce(nullif(btrim(coalesce(p_elevation_style, '')), ''), elevation_style),
      border_style        = coalesce(nullif(btrim(coalesce(p_border_style, '')), ''), border_style),
      icon_treatment      = coalesce(nullif(btrim(coalesce(p_icon_treatment, '')), ''), icon_treatment),
      navigation_style    = coalesce(nullif(btrim(coalesce(p_navigation_style, '')), ''), navigation_style),
      button_treatment    = coalesce(nullif(btrim(coalesce(p_button_treatment, '')), ''), button_treatment),
      card_treatment      = coalesce(nullif(btrim(coalesce(p_card_treatment, '')), ''), card_treatment),
      notes               = coalesce(nullif(btrim(coalesce(p_notes, '')), ''), notes)
    where id = v_id;
  end if;

  perform core.record_audit(
    v_theme.organization_id, 'design_token_set.recorded', 'design_token_set', v_id, null,
    jsonb_build_object('projectId', v_theme.project_id, 'themeOptionId', p_theme_option_id)
  );

  return query select 'recorded'::text, v_id;
end;
$$;

comment on function projects.record_design_token_set(uuid, text, text, numeric, int, text, text, text, text, text, text, text, text) is
  'Designer sections 4.5 and 23. Records or edits the DRAFT primitives for one theme direction. NULL MEANS UNCHANGED and a new version inherits the last finalized one - found by DRIVING it, because a version that started blank silently dropped every primitive the previous one carried, which is the opposite of section 19''s "reusable components created in Phase 3 are preserved". The cost is that this door cannot clear a primitive back to null, only change one. Every argument is one of section 4.5''s named primitives and there is no free-form structure, which is the boundary that section states twice. Colour is not among them: projects.color_options holds the palette already.';

revoke all on function projects.record_design_token_set(uuid, text, text, numeric, int, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function projects.record_design_token_set(uuid, text, text, numeric, int, text, text, text, text, text, text, text, text) to authenticated;

create or replace function projects.finalize_design_token_set(
  p_theme_option_id uuid
)
returns table (
  -- 'finalized' | 'no_actor' | 'forbidden' | 'unknown_theme' | 'no_draft'
  -- | 'already_final'
  outcome text,
  token_set_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_theme projects.theme_options;
  v_set   projects.design_token_sets;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select t.* into v_theme from projects.theme_options t where t.id = p_theme_option_id;
  if v_theme.id is null then
    return query select 'unknown_theme'::text, null::uuid; return;
  end if;

  if v_theme.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select s.* into v_set
    from projects.design_token_sets s
   where s.theme_option_id = p_theme_option_id
   order by s.version desc
   limit 1
   for update;

  if v_set.id is null then
    return query select 'no_draft'::text, null::uuid; return;
  end if;

  if v_set.status = 'final' then
    return query select 'already_final'::text, v_set.id; return;
  end if;

  update projects.design_token_sets
     set status = 'final', finalized_at = now()
   where id = v_set.id;

  perform core.record_audit(
    v_theme.organization_id, 'design_token_set.finalized', 'design_token_set', v_set.id, null,
    jsonb_build_object('projectId', v_theme.project_id, 'themeOptionId', p_theme_option_id,
                       'version', v_set.version)
  );

  perform core.emit_event(
    v_theme.organization_id, 'project.design_tokens_finalized',
    'design_token_set', v_set.id,
    jsonb_build_object('projectId', v_theme.project_id, 'themeOptionId', p_theme_option_id)
  );

  return query select 'finalized'::text, v_set.id;
end;
$$;

comment on function projects.finalize_design_token_set(uuid) is
  'Designer section 19. Freezes a direction''s primitives so Phase 4 inherits a record rather than a promise. A finalized set is superseded by a NEW version, never reopened - the same rule the screen baseline and the client share already carry.';

revoke all on function projects.finalize_design_token_set(uuid) from public, anon;
grant execute on function projects.finalize_design_token_set(uuid) to authenticated;

-- ── §19: the handoff carries them, so Phase 4 does not recreate them ────
--
-- `lock_phase_three_direction` is replaced rather than extended by a second
-- door: the handoff payload is one snapshot and assembling it in two places
-- would let the halves disagree about which moment they froze.
--
-- **And `phase_four_ready` now requires the token set as well as the Figma
-- artifact.** That is a deliberate change to G-285's rule, not a side effect.
-- §19 says Phase 4 *receives* tokens rather than recreating them; a handoff
-- marked ready without them would be a claim that Phase 4 has what it needs,
-- made about a phase that would have to invent the primitives itself. The
-- readiness note already names what is missing and now names both.

create or replace function projects.lock_phase_three_direction(
  p_phase_three_id uuid
)
returns table (
  outcome    text,
  handoff_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_decision projects.client_design_decisions;
  v_theme    projects.theme_options;
  v_color    projects.color_options;
  v_baseline projects.screen_baselines;
  v_tokens   projects.design_token_sets;
  v_ready    boolean;
  v_missing  text[] := '{}';
  v_note     text;
  v_new      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.id = p_phase_three_id
   for update;

  if v_phase3.id is null then
    return query select 'unknown_phase'::text, null::uuid; return;
  end if;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if exists (select 1 from projects.phase_three_handoffs h
              where h.phase_three_id = v_phase3.id) then
    return query select 'already_locked'::text, null::uuid; return;
  end if;

  if v_phase3.state in ('blocked_requirement', 'scope_escalation', 'revision_limit_escalation') then
    return query select 'blocked'::text, null::uuid; return;
  end if;

  select d.* into v_decision
    from projects.client_design_decisions d
   where d.phase_three_id = v_phase3.id
     and d.decision = 'final_confirmed'
   order by d.created_at desc
   limit 1;

  if v_decision.id is null then
    return query select 'not_confirmed'::text, null::uuid; return;
  end if;

  select t.* into v_theme from projects.theme_options t
   where t.id = v_decision.selected_theme_option_id;
  select c.* into v_color from projects.color_options c
   where c.id = v_decision.selected_color_option_id;

  if v_theme.admin_status <> 'approved' then
    return query select 'theme_not_approved'::text, null::uuid; return;
  end if;

  select b.* into v_baseline
    from projects.screen_baselines b
   where b.project_id = v_phase3.project_id
     and b.status = 'finalized'
   order by b.version desc
   limit 1;

  if v_baseline.id is null then
    return query select 'no_screen_baseline'::text, null::uuid; return;
  end if;

  -- §19's primitives, if they were finalized.
  select s.* into v_tokens
    from projects.design_token_sets s
   where s.theme_option_id = v_theme.id
     and s.status = 'final'
   order by s.version desc
   limit 1;

  -- Readiness: both of the things Phase 4 would otherwise have to invent.
  -- `array_append`, not `||`. Postgres reads `text[] || text` as an array
  -- literal cast and refuses the sentence — a defect that only exists on the
  -- NOT-ready path, so the ready path passed while this raised. Found by
  -- driving the negative case; no regex over this file would have seen it.
  if v_theme.figma_node_id is null then
    v_missing := array_append(v_missing,
      'the canonical Figma artifact: the selected theme has no Figma node reference');
  end if;
  if v_tokens.id is null then
    v_missing := array_append(v_missing,
      'the design token set: no Phase 3 primitives were finalized for the selected direction');
  end if;

  v_ready := array_length(v_missing, 1) is null;
  v_note  := case when v_ready then null else
    'Locked without ' || array_to_string(v_missing, '; and ')
    || '. Phase 4 would have to recreate what is missing, which Designer section 19 exists to prevent, so it stays blocked until it exists.'
  end;

  insert into projects.phase_three_handoffs (
    organization_id, project_id, phase_three_id, screen_baseline_id,
    theme_option_id, color_option_id, client_decision_id,
    figma_file_key, figma_node_id, figma_version,
    payload, phase_four_ready, readiness_note, locked_by
  ) values (
    v_phase3.organization_id, v_phase3.project_id, v_phase3.id, v_baseline.id,
    v_theme.id, v_color.id, v_decision.id,
    v_theme.figma_file_key, v_theme.figma_node_id, v_theme.figma_version,
    jsonb_build_object(
      'screenBaseline', jsonb_build_object(
        'id', v_baseline.id, 'version', v_baseline.version,
        'screenCount', v_baseline.screen_count, 'screens', v_baseline.screens),
      'theme', jsonb_build_object(
        'id', v_theme.id, 'name', v_theme.name, 'version', v_theme.version,
        'directionSummary', v_theme.direction_summary,
        'directionMetadata', v_theme.direction_metadata,
        'figmaFileKey', v_theme.figma_file_key, 'figmaNodeId', v_theme.figma_node_id,
        'figmaVersion', v_theme.figma_version, 'previewAssetUrl', v_theme.preview_asset_url),
      'colors', jsonb_build_object(
        'id', v_color.id, 'paletteName', v_color.palette_name,
        'primaryHex', v_color.primary_hex, 'secondaryHex', v_color.secondary_hex,
        'accentHex', v_color.accent_hex, 'backgroundHex', v_color.background_hex,
        'surfaceHex', v_color.surface_hex, 'textPrimaryHex', v_color.text_primary_hex,
        'textSecondaryHex', v_color.text_secondary_hex, 'successHex', v_color.success_hex,
        'warningHex', v_color.warning_hex, 'errorHex', v_color.error_hex,
        'contrastNotes', v_color.contrast_notes),
      -- §19: "Phase 4 receives design tokens/primitives rather than recreating
      -- them." Null when none were finalized, which is also why the handoff is
      -- not ready.
      'tokens', case when v_tokens.id is null then null else jsonb_build_object(
        'id', v_tokens.id, 'version', v_tokens.version,
        'fontFamilyHeading', v_tokens.font_family_heading,
        'fontFamilyBody', v_tokens.font_family_body,
        'typeScaleRatio', v_tokens.type_scale_ratio,
        'baseSpacingPx', v_tokens.base_spacing_px,
        'radiusStyle', v_tokens.radius_style,
        'elevationStyle', v_tokens.elevation_style,
        'borderStyle', v_tokens.border_style,
        'iconTreatment', v_tokens.icon_treatment,
        'navigationStyle', v_tokens.navigation_style,
        'buttonTreatment', v_tokens.button_treatment,
        'cardTreatment', v_tokens.card_treatment,
        'notes', v_tokens.notes) end,
      'approvalEvidence', jsonb_build_object(
        'clientDecisionId', v_decision.id, 'clientWords', v_decision.client_words,
        'evidenceRef', v_decision.evidence_ref, 'confirmedAt', v_decision.created_at),
      'revisionRounds', v_phase3.client_revision_count),
    v_ready, v_note, v_actor
  )
  returning id into v_new;

  update projects.theme_options set client_status = 'locked' where id = v_theme.id;
  update projects.color_options set client_status = 'locked' where id = v_color.id;

  update projects.phase_three
     set state = 'completed', completed_at = now()
   where id = v_phase3.id;

  perform core.record_audit(
    v_phase3.organization_id, 'phase_three.locked', 'phase_three_handoff', v_new, null,
    jsonb_build_object('projectId', v_phase3.project_id, 'themeOptionId', v_theme.id,
                       'colorOptionId', v_color.id, 'phaseFourReady', v_ready)
  );

  perform core.emit_event(
    v_phase3.organization_id, 'project.phase_three_completed',
    'phase_three_handoff', v_new,
    jsonb_build_object('projectId', v_phase3.project_id, 'phaseFourReady', v_ready)
  );

  if v_ready then
    perform core.emit_event(
      v_phase3.organization_id, 'project.phase_four_ready',
      'phase_three_handoff', v_new,
      jsonb_build_object('projectId', v_phase3.project_id, 'handoffId', v_new)
    );
    return query select 'locked'::text, v_new; return;
  end if;

  return query select 'locked_not_ready'::text, v_new;
end;
$$;

comment on function projects.lock_phase_three_direction(uuid) is
  'Master sections 7.11, 7.12 and 16; PM section 4.10; Designer sections 4.9 and 19. IT TAKES NO ARGUMENT ABOUT WHAT TO LOCK: it reads the final_confirmed client_design_decisions row, so a caller cannot lock something the client never confirmed. Validates section 7.12''s list with a NAMED refusal each. PHASE 4 READINESS REQUIRES BOTH the canonical Figma artifact AND a finalized design token set (G-292 raised this from Figma alone): section 19 says Phase 4 RECEIVES tokens rather than recreating them, so a handoff marked ready without them would claim Phase 4 has what it needs while leaving it to invent the primitives. The note names everything missing, not the first thing. Phase 3 still COMPLETES either way, because the client did confirm - collapsing those two facts would be the faked completion Designer section 26 forbids.';

revoke all on function projects.lock_phase_three_direction(uuid) from public, anon;
grant execute on function projects.lock_phase_three_direction(uuid) to authenticated;

notify pgrst, 'reload schema';
