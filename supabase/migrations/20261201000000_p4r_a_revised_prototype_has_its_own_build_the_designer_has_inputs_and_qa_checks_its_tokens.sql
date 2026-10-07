-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 UI Designer and Prototype, round 4 (docs/phase-4-ui-prototype-round4-log.md). Every object is named p4r_ and every one is additive, except the
-- two revision doors at the end, which keep their signature and return shape and gain one refusal (`no_content_change`).
--
--   1. p4r_plan_revision_build        The revised-prototype gap. `revise_prototype_build` creates a NEW artifact (and deliverable) for the same locked UI
--                                     version, but the p4ui build is planned only when the UI version locks, so the revised artifact was never attached
--                                     to a p4ui build and `p4ui_record_build_revision` could not fire for a real revision. This door plans the revision
--                                     build from the build that was sent back, inheriting its plan and its (already passed) input validation, supersedes
--                                     the sent-back build, and leaves it `building` for `p4ui_attach_build_artifact`. It decides no gate.
--   2. p4r_design_inputs              Designer planning and brand inputs (P4-UID-015/016): brand assets, accessibility targets, device targets and a
--                                     planning note, recorded by a PERSON per Phase 4 workspace. A named brand asset that is neither a stored asset nor an
--                                     approved placeholder opens a design `asset_missing` blocker (P4-UID-057).
--   3. p4r_check_token_consistency    Design QA token-consistency check (P4-UID-021): every token a screen spec says it uses must exist in the frozen
--                                     Phase 3 handoff (colors / tokens) and no raw value (hex, px) stands in for one; each finding is a `token` QA defect.
--   4. p4r_prototype_state_report     Prototype state vocabulary check (P4-PROTO-010/066/097/072): states, responsive variants, input validation and deep
--                                     links of the exact build against the locked UI. A report, not a gate.
--   5. p4r_follow_build_state         phase_four.state follows the build into prototype_review / prototype_locked (P4-PROTO-028). It reflects a real
--                                     build state; the build state itself is still enforced by `p4ui_enforce_build_transition`.
--   6. revise_ui_version / p4ui_start_governed_revision   refuse a revision whose screens equal the version it revises (P4-UID-054).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the revision build ────────────────────────────────────────────────────
create or replace function projects.p4r_plan_revision_build(p_prototype_artifact_id uuid)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_a     projects.prototype_artifacts;
  v_pa    projects.prototype_artifacts;
  v_prev  projects.p4ui_prototype_builds;
  v_scope text;
  v_have  uuid;
  v_new   uuid;
  v_n     int;
  v_ver   int;
  v_pver  int;
begin
  select a.* into v_a from projects.prototype_artifacts a where a.id = p_prototype_artifact_id;
  if v_a.id is null then return query select 'unknown_artifact'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_a.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;

  select b.id into v_have from projects.p4ui_prototype_builds b where b.prototype_artifact_id = v_a.id;
  if v_have is not null then return query select 'already_attached'::text, v_have, null::text; return; end if;

  select b.* into v_prev from projects.p4ui_prototype_builds b where b.ui_version_id = v_a.ui_version_id order by b.build_number desc limit 1 for update;
  if v_prev.id is null then return query select 'no_prior_build'::text, null::uuid, null::text; return; end if;

  -- bring the prior build up to the real gates first: the sync is idempotent and only reflects rows that already exist
  begin
    perform projects.p4ui_sync_build_status(v_prev.id);
  exception when check_violation then
    null;
  end;
  select b.* into v_prev from projects.p4ui_prototype_builds b where b.id = v_prev.id;

  if v_prev.prototype_artifact_id is null then return query select 'prior_build_has_no_artifact'::text, v_prev.id, v_prev.status; return; end if;
  if v_prev.status not in ('qa_changes_required', 'changes_requested', 'superseded') then
    return query select 'prior_build_not_sent_back'::text, v_prev.id, v_prev.status; return;
  end if;
  select pa.* into v_pa from projects.prototype_artifacts pa where pa.id = v_prev.prototype_artifact_id;
  select d.version into v_ver from projects.deliverables d where d.id = v_a.deliverable_id;
  select d.version into v_pver from projects.deliverables d where d.id = v_pa.deliverable_id;
  if coalesce(v_ver, 0) <= coalesce(v_pver, 0) then return query select 'not_a_later_artifact'::text, v_prev.id, null::text; return; end if;

  v_n := v_prev.build_number + 1;
  -- The plan is the prior build's plan and the UI version is the same locked one, so input validation already passed for it (a build only carries an artifact
  -- after it reached `building`): the revision build inherits that rather than re-opening blockers a person has already resolved.
  insert into projects.p4ui_prototype_builds (organization_id, project_id, phase_four_id, ui_version_id, build_number, revision_of_build_id, platform, build_mode, environment,
      mock_policy, routes, components, mock_sources, interactions, critical_flows, exclusions, required_assets, limitations, simulated_integrations, test_instructions,
      design_source_state, figma_file_ref, figma_node_refs, planned_by)
  values (v_prev.organization_id, v_prev.project_id, v_prev.phase_four_id, v_prev.ui_version_id, v_n, v_prev.id, v_prev.platform, v_prev.build_mode, v_prev.environment,
      v_prev.mock_policy, v_prev.routes, v_prev.components, v_prev.mock_sources, v_prev.interactions, v_prev.critical_flows, v_prev.exclusions, v_prev.required_assets,
      v_prev.limitations, v_prev.simulated_integrations, v_prev.test_instructions, v_prev.design_source_state, v_prev.figma_file_ref, v_prev.figma_node_refs, (select auth.uid()))
  returning id into v_new;
  update projects.p4ui_prototype_builds set status = 'input_validation' where id = v_new;
  update projects.p4ui_prototype_builds set status = 'building' where id = v_new;

  insert into projects.p4ui_test_data (organization_id, project_id, build_id, name, purpose, payload, edge_case)
  select t.organization_id, t.project_id, v_new, t.name, t.purpose, t.payload, t.edge_case from projects.p4ui_test_data t where t.build_id = v_prev.id;

  if v_prev.status in ('qa_changes_required', 'changes_requested') then
    update projects.p4ui_prototype_builds set status = 'superseded' where id = v_prev.id;
  end if;

  perform core.record_audit(v_prev.organization_id, 'prototype.revision_build_planned', 'p4ui_prototype_build', v_new, null,
    jsonb_build_object('projectId', v_prev.project_id, 'uiVersionId', v_prev.ui_version_id, 'buildNumber', v_n, 'revisionOf', v_prev.id, 'artifactId', v_a.id));
  return query select 'planned'::text, v_new, v_n::text;
end $$;
revoke all on function projects.p4r_plan_revision_build(uuid) from public, anon;
grant execute on function projects.p4r_plan_revision_build(uuid) to authenticated, service_role;
comment on function projects.p4r_plan_revision_build(uuid) is
  'A revised prototype artifact (revise_prototype_build) gets its own p4ui build: the sent-back build''s plan is inherited, the sent-back build is superseded, and the new build is left `building` for p4ui_attach_build_artifact. Decides no gate.';

-- ── 2. the Designer''s planning and brand inputs ───────────────────────────────
create table if not exists projects.p4r_design_inputs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  phase_four_id         uuid not null references projects.phase_four(id) on delete cascade,
  brand_assets          jsonb not null default '[]'::jsonb check (jsonb_typeof(brand_assets) = 'array' and jsonb_array_length(brand_assets) <= 30),
  accessibility_targets text[] not null default '{}'
                          check (accessibility_targets <@ array['wcag_a', 'wcag_aa', 'wcag_aaa', 'keyboard_only', 'screen_reader', 'reduced_motion', 'high_contrast']::text[]),
  device_targets        text[] not null default '{}' check (device_targets <@ array['mobile', 'tablet', 'desktop', 'ios', 'android']::text[]),
  planning_note         text check (planning_note is null or length(btrim(planning_note)) between 1 and 2000),
  revision              int not null default 1 check (revision > 0),
  recorded_by           uuid references core.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint p4r_design_inputs_one_per_workspace unique (phase_four_id)
);
comment on table projects.p4r_design_inputs is
  'UID section 5 input contract (P4-UID-015/016): the brand assets, accessibility and device targets and planning note the Designer is given, recorded by a person per Phase 4 workspace. The scope version and change set are on every design job (p4ui_design_jobs); the locked direction is the Phase 3 handoff.';
create trigger p4r_design_inputs_po_project_id before insert or update of project_id on projects.p4r_design_inputs
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger p4r_design_inputs_po_phase_four_id before insert or update of phase_four_id on projects.p4r_design_inputs
  for each row execute function core.enforce_parent_org('phase_four_id', 'projects.phase_four');
create trigger freeze_org_p4r_design_inputs before update of organization_id on projects.p4r_design_inputs
  for each row execute function core.freeze_organization_id();
create trigger p4r_design_inputs_updated_at before update on projects.p4r_design_inputs
  for each row execute function core.set_updated_at();
alter table projects.p4r_design_inputs enable row level security;
alter table projects.p4r_design_inputs force row level security;
create policy p4r_design_inputs_select on projects.p4r_design_inputs for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
grant select on projects.p4r_design_inputs to authenticated, service_role;

create or replace function projects.p4r_record_design_inputs(p_phase_four_id uuid, p_brand_assets jsonb, p_accessibility text[], p_devices text[], p_planning_note text)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p4      projects.phase_four;
  v_scope   text;
  v_assets  jsonb := coalesce(p_brand_assets, '[]'::jsonb);
  v_a       record;
  v_missing int := 0;
  v_id      uuid;
begin
  select p4.* into v_p4 from projects.phase_four p4 where p4.id = p_phase_four_id for update;
  if v_p4.id is null then return query select 'unknown_workspace'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_p4.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  -- the inputs are what the team tells the Designer: a person states them, an agent does not invent them
  if v_scope = 'service' then return query select 'person_required'::text, null::uuid, null::text; return; end if;
  if jsonb_typeof(v_assets) <> 'array' or jsonb_array_length(v_assets) > 30 then return query select 'bad_brand_assets'::text, null::uuid, null::text; return; end if;
  for v_a in select e.value as body from jsonb_array_elements(v_assets) e(value) loop
    if jsonb_typeof(v_a.body) <> 'object' or coalesce(length(btrim(v_a.body ->> 'name')), 0) = 0 then
      return query select 'bad_brand_assets'::text, null::uuid, 'every brand asset needs a name'; return;
    end if;
  end loop;

  begin
    insert into projects.p4r_design_inputs (organization_id, project_id, phase_four_id, brand_assets, accessibility_targets, device_targets, planning_note, recorded_by)
    values (v_p4.organization_id, v_p4.project_id, v_p4.id, v_assets, coalesce(p_accessibility, '{}'), coalesce(p_devices, '{}'),
            nullif(left(btrim(coalesce(p_planning_note, '')), 2000), ''), (select auth.uid()))
    on conflict (phase_four_id) do update
      set brand_assets = excluded.brand_assets, accessibility_targets = excluded.accessibility_targets, device_targets = excluded.device_targets,
          planning_note = excluded.planning_note, recorded_by = excluded.recorded_by, revision = projects.p4r_design_inputs.revision + 1
    returning id into v_id;
  exception when check_violation then
    return query select 'bad_inputs'::text, null::uuid, null::text; return;
  end;

  -- UID 24: an asset the Designer is told about but that does not exist (and has no approved placeholder) is a named stop with an owner, not a guess
  for v_a in select e.value as body from jsonb_array_elements(v_assets) e(value) loop
    if not coalesce((v_a.body ->> 'placeholderApproved')::boolean, false)
       and not exists (select 1 from projects.design_assets d where d.id::text = v_a.body ->> 'assetId' and d.project_id = v_p4.project_id) then
      v_missing := v_missing + 1;
      perform projects.p4ui_open_design_blocker(v_p4.id, 'asset_missing', 'designer',
        'Brand asset "' || left(btrim(v_a.body ->> 'name'), 120) || '" is not available and no approved placeholder is named.',
        'The asset is supplied, or an approved placeholder is named in the design inputs');
    end if;
  end loop;

  perform core.record_audit(v_p4.organization_id, 'ui_design.inputs_recorded', 'p4r_design_inputs', v_id, null,
    jsonb_build_object('projectId', v_p4.project_id, 'brandAssets', jsonb_array_length(v_assets), 'missingAssets', v_missing));
  return query select 'recorded'::text, v_id, v_missing::text;
end $$;
revoke all on function projects.p4r_record_design_inputs(uuid, jsonb, text[], text[], text) from public, anon;
grant execute on function projects.p4r_record_design_inputs(uuid, jsonb, text[], text[], text) to authenticated, service_role;

-- ── 3. Design QA: token consistency ───────────────────────────────────────────
create or replace function projects.p4r_check_token_consistency(p_ui_version_id uuid)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v       projects.ui_versions;
  v_scope   text;
  v_payload jsonb;
  v_colors  jsonb;
  v_tokens  jsonb;
  r         record;
  v_norm    text;
  v_role    text;
  v_key     text;
  v_why     text;
  v_bad     int := 0;
  v_specs   int := 0;
  v_o       text;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  select h.payload into v_payload from projects.phase_four p4 join projects.phase_three_handoffs h on h.id = p4.phase_three_handoff_id where p4.id = v_v.phase_four_id;
  v_colors := v_payload -> 'colors';
  v_tokens := v_payload -> 'tokens';
  if v_colors is null and v_tokens is null then return query select 'no_token_source'::text, null::uuid, 'the frozen Phase 3 handoff carries no colors or tokens to check against'; return; end if;

  for r in select s.screen_key, t.token from projects.p4ui_screen_specs s cross join lateral unnest(s.tokens_used) as t(token) where s.ui_version_id = v_v.id loop
    v_specs := v_specs + 1;
    v_norm := lower(btrim(r.token));
    v_why := null;
    if v_norm ~ '^#[0-9a-f]{3,8}$' or v_norm ~ '^-?[0-9.]+(px|rem|em|pt)$' then
      v_why := 'is a raw value, not a token: a second design system';
    elsif v_norm ~ '^color\.' then
      v_role := regexp_replace(substr(v_norm, 7), '[^a-z]', '', 'g');
      v_key := case v_role when 'primary' then 'primaryHex' when 'secondary' then 'secondaryHex' when 'accent' then 'accentHex' when 'background' then 'backgroundHex'
                           when 'surface' then 'surfaceHex' when 'textprimary' then 'textPrimaryHex' when 'textsecondary' then 'textSecondaryHex'
                           when 'success' then 'successHex' when 'warning' then 'warningHex' when 'error' then 'errorHex' else null end;
      if v_key is null then v_why := 'is not a colour token of the locked direction';
      elsif coalesce(v_colors ->> v_key, '') = '' then v_why := 'names a colour the locked direction does not define';
      end if;
    else
      v_key := case
        when v_norm ~ '^(typography|font|type)\.(heading|headings|title)' then 'fontFamilyHeading'
        when v_norm ~ '^(typography|font|type)\.(body|text)' then 'fontFamilyBody'
        when v_norm ~ '^(typography|font|type)\.(scale|ratio)' then 'typeScaleRatio'
        when v_norm ~ '^spacing(\.|$)' then 'baseSpacingPx'
        when v_norm ~ '^radius(\.|$)' then 'radiusStyle'
        when v_norm ~ '^(elevation|shadow)(\.|$)' then 'elevationStyle'
        when v_norm ~ '^border(\.|$)' then 'borderStyle'
        when v_norm ~ '^icon(s)?(\.|$)' then 'iconTreatment'
        when v_norm ~ '^(navigation|nav)(\.|$)' then 'navigationStyle'
        when v_norm ~ '^button(\.|$)' then 'buttonTreatment'
        when v_norm ~ '^card(\.|$)' then 'cardTreatment'
        else null end;
      if v_key is null then v_why := 'is not a token of the locked direction';
      elsif coalesce(v_tokens ->> v_key, '') = '' then v_why := 'names a primitive the locked direction does not define';
      end if;
    end if;
    if v_why is not null then
      select o.outcome into v_o from projects.p4ui_open_qa_defect(v_v.id, r.screen_key, 'token', 'Token "' || left(btrim(r.token), 80) || '" ' || v_why || '.', 'major') o;
      if v_o in ('opened', 'exists') then v_bad := v_bad + 1; end if;
    end if;
  end loop;
  if v_specs = 0 then return query select 'no_specs'::text, null::uuid, 'no screen spec names any token yet'; return; end if;
  return query select case when v_bad = 0 then 'consistent' else 'inconsistent' end, v_v.id, v_bad::text;
end $$;
revoke all on function projects.p4r_check_token_consistency(uuid) from public, anon;
grant execute on function projects.p4r_check_token_consistency(uuid) to authenticated, service_role;

-- ── 4. the prototype state / responsive / validation / deep-link report ──────────
create or replace function projects.p4r_prototype_state_report(p_build_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b      projects.p4ui_prototype_builds;
  v_a      projects.prototype_artifacts;
  v_v      projects.ui_versions;
  v_scope  text;
  v_rows   jsonb := '[]'::jsonb;
  v_links  jsonb := '[]'::jsonb;
  r        record;
  v_art    jsonb;
  v_exp    text[];
  v_expr   text[];
  v_pres   text[];
  v_presr  text[];
  v_mst    text[];
  v_mresp  text[];
  v_unval  int;
  v_tstates int := 0;
  v_tresp  int := 0;
  v_tunval int := 0;
  v_seen   text[] := '{}';
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id;
  if v_b.id is null then return jsonb_build_object('outcome', 'unknown_build'); end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return jsonb_build_object('outcome', v_scope); end if;
  if v_b.prototype_artifact_id is null then return jsonb_build_object('outcome', 'no_artifact'); end if;
  select a.* into v_a from projects.prototype_artifacts a where a.id = v_b.prototype_artifact_id;
  select u.* into v_v from projects.ui_versions u where u.id = v_b.ui_version_id;

  for r in select d.value as scr from jsonb_array_elements(v_v.screens) d(value) loop
    select e.value into v_art from jsonb_array_elements(v_a.screens) e(value) where e.value ->> 'screenKey' = r.scr ->> 'screenKey';
    continue when v_art is null;  -- a missing screen is the coverage record's finding, not this report's
    select coalesce(array(select jsonb_array_elements_text(coalesce(r.scr -> 'statesAddressed', '[]'::jsonb))), '{}') into v_exp;
    select coalesce(array_agg(distinct x), '{}') into v_exp
      from unnest(v_exp || coalesce((select s.states from projects.p4ui_screen_specs s where s.ui_version_id = v_v.id and s.screen_key = r.scr ->> 'screenKey'), '{}')) x
     where x <> 'default';
    select coalesce(s.responsive_variants, '{}') into v_expr from (select 1) one
      left join projects.p4ui_screen_specs s on s.ui_version_id = v_v.id and s.screen_key = r.scr ->> 'screenKey';
    v_pres := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(v_art -> 'states') = 'array' then v_art -> 'states' else '[]'::jsonb end)), '{}');
    v_presr := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(v_art -> 'responsiveVariants') = 'array' then v_art -> 'responsiveVariants' else '[]'::jsonb end)), '{}');
    select coalesce(array(select x from unnest(v_exp) x where not (x = any (v_pres))), '{}') into v_mst;
    select coalesce(array(select x from unnest(v_expr) x where not (x = any (v_presr))), '{}') into v_mresp;
    -- an input on a screen whose spec states validation rules must say what it validates
    select count(*) into v_unval from jsonb_array_elements(v_art -> 'elements') el(value)
     where el.value ->> 'type' = 'input' and coalesce(el.value ->> 'validation', '') = ''
       and exists (select 1 from projects.p4ui_screen_specs s where s.ui_version_id = v_v.id and s.screen_key = r.scr ->> 'screenKey' and cardinality(s.validation_rules) > 0);
    v_tstates := v_tstates + cardinality(v_mst);
    v_tresp := v_tresp + cardinality(v_mresp);
    v_tunval := v_tunval + v_unval;
    v_rows := v_rows || jsonb_build_object('screenKey', r.scr ->> 'screenKey', 'missingStates', to_jsonb(v_mst), 'missingResponsive', to_jsonb(v_mresp), 'inputsWithoutValidation', v_unval);
  end loop;

  -- deep links: every planned route resolves to a screen of this build, starts with "/", and appears once
  for r in select e.value as rt from jsonb_array_elements(v_b.routes) e(value) loop
    if not exists (select 1 from jsonb_array_elements(v_a.screens) s(value) where s.value ->> 'screenKey' = r.rt ->> 'screenKey') then
      v_links := v_links || jsonb_build_object('route', r.rt ->> 'route', 'problem', 'names a screen the build does not contain');
    elsif coalesce(r.rt ->> 'route', '') !~ '^/' then
      v_links := v_links || jsonb_build_object('route', r.rt ->> 'route', 'problem', 'is not an absolute route');
    elsif (r.rt ->> 'route') = any (v_seen) then
      v_links := v_links || jsonb_build_object('route', r.rt ->> 'route', 'problem', 'is used by more than one screen');
    end if;
    v_seen := v_seen || coalesce(r.rt ->> 'route', '');
  end loop;

  return jsonb_build_object('outcome', 'report', 'screens', v_rows, 'missingStates', v_tstates, 'missingResponsive', v_tresp,
                            'inputsWithoutValidation', v_tunval, 'deepLinkProblems', v_links);
end $$;
revoke all on function projects.p4r_prototype_state_report(uuid) from public, anon;
grant execute on function projects.p4r_prototype_state_report(uuid) to authenticated, service_role;

-- ── 5. phase_four.state follows the build ──────────────────────────────────────
create or replace function projects.p4r_follow_build_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  -- only ever FROM a working state: a stop (scope / revision-limit escalation, blocked requirement) and a completed workspace are never overwritten here
  if new.status = 'client_review' then
    update projects.phase_four set state = 'prototype_review' where id = new.phase_four_id and state in ('ui_locked', 'prototype_build');
  elsif new.status = 'locked' then
    update projects.phase_four set state = 'prototype_locked' where id = new.phase_four_id and state in ('ui_locked', 'prototype_build', 'prototype_review');
  end if;
  return new;
end $$;
revoke all on function projects.p4r_follow_build_state() from public, anon;
create trigger p4r_prototype_builds_follow_state after update of status on projects.p4ui_prototype_builds
  for each row execute function projects.p4r_follow_build_state();

-- ═══ P4-UID-054: a revision with no screen content change is refused at the door ═══
CREATE OR REPLACE FUNCTION projects.revise_ui_version(p_phase_four_id uuid, p_screens jsonb)
 RETURNS TABLE(outcome text, ui_version_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor      uuid := (select auth.uid());
  v_phase_four projects.phase_four;
  v_latest     projects.ui_versions;
  v_new        uuid;
  v_next_version int;
  v_is_qa      boolean;
  v_count      int;
  v_limit      int;
  v_what       text;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select p4.* into v_phase_four
    from projects.phase_four p4
   where p4.id = p_phase_four_id
   for update;

  if v_phase_four.id is null then
    return query select 'unknown_workspace'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_phase_four.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select v.* into v_latest
    from projects.ui_versions v
   where v.phase_four_id = v_phase_four.id
   order by v.version desc
   limit 1;

  if v_latest.id is null then
    return query select 'no_prior_version'::text, null::uuid; return;
  end if;

  -- A version Design QA sent back (qa_changes_required) is fixed by the Designer: Designer's FIXED is not VERIFIED -
  -- the fix is a NEW version that goes through Design QA again from scratch, and the old verdict never transfers.
  if v_latest.status not in ('client_change', 'admin_edit', 'qa_changes_required') then
    return query select 'already_revised'::text, v_latest.id; return;
  end if;

  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'empty_screens'::text, null::uuid; return;
  end if;

  -- P4-UID-054: a revision that changes no screen content is not a new version. Refused at the door, before any round is counted.
  if p_screens = v_latest.screens then
    return query select 'no_content_change'::text, v_latest.id; return;
  end if;

  v_is_qa := v_latest.status = 'qa_changes_required';
  v_count := case when v_is_qa then v_phase_four.ui_qa_fix_count else v_phase_four.ui_revision_count end;
  v_limit := case when v_is_qa then v_phase_four.ui_qa_fix_limit else v_phase_four.ui_revision_limit end;
  v_what  := case when v_is_qa then 'UI Design QA fix' else 'UI revision' end;

  if v_count >= v_limit then
    update projects.phase_four
       set state = 'revision_limit_escalation',
           blocked_reason = format(
             '%s limit reached: %s round(s) already completed against a limit of %s. Human escalation required before another round.',
             v_what, v_count, v_limit
           )
     where id = v_phase_four.id;

    perform core.record_audit(
      v_phase_four.organization_id, 'project.revision_limit_escalated', 'phase_four', v_phase_four.id, null,
      jsonb_build_object('projectId', v_phase_four.project_id, 'revisionCount', v_count, 'revisionLimit', v_limit)
    );

    -- Reuses Phase 3's event and announcement (see migration header) rather
    -- than the dead `project.ui_revision_limit_reached` this session first
    -- declared and never wired.
    perform core.emit_event(
      v_phase_four.organization_id, 'project.revision_limit_escalated', 'phase_four', v_phase_four.id,
      jsonb_build_object('projectId', v_phase_four.project_id, 'revisionCount', v_count, 'revisionLimit', v_limit)
    );

    return query select 'revision_limit_reached'::text, null::uuid; return;
  end if;

  v_next_version := v_latest.version + 1;

  insert into projects.ui_versions (
    organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, screens
  ) values (
    v_phase_four.organization_id, v_phase_four.project_id, v_phase_four.id,
    v_latest.source_phase_three_handoff_id, v_next_version, p_screens
  )
  returning id into v_new;

  update projects.phase_four
     set state = 'ui_design',
         ui_revision_count = ui_revision_count + case when v_is_qa then 0 else 1 end,
         ui_qa_fix_count   = ui_qa_fix_count   + case when v_is_qa then 1 else 0 end
   where id = v_phase_four.id;

  perform core.record_audit(
    v_phase_four.organization_id, 'project.ui_version_drafted', 'ui_version', v_new, null,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id, 'version', v_next_version, 'revisionOf', v_latest.id, 'reason', case when v_is_qa then 'qa_defect' else 'revision' end)
  );

  perform core.emit_event(
    v_phase_four.organization_id, 'project.ui_version_drafted',
    'ui_version', v_new,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id)
  );

  return query select 'revised'::text, v_new;
end;
$function$;

create or replace function projects.p4ui_start_governed_revision(p_job_id uuid, p_screens jsonb)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_j      projects.p4ui_design_jobs;
  v_src    projects.ui_versions;
  v_latest projects.ui_versions;
  v_scope  text;
  v_new    uuid;
begin
  select j.* into v_j from projects.p4ui_design_jobs j where j.id = p_job_id for update;
  if v_j.id is null then return query select 'unknown_job'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_j.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if v_j.status = 'delivered' then return query select 'already_delivered'::text, v_j.result_ui_version_id; return; end if;
  if v_j.status <> 'requested' or v_j.activation_reason not in ('approved_scope_change', 'source_ui_design_defect') then
    return query select 'not_a_post_lock_job'::text, null::uuid; return;
  end if;
  select u.* into v_src from projects.ui_versions u where u.id = v_j.source_ui_version_id;
  select u.* into v_latest from projects.ui_versions u where u.phase_four_id = v_j.phase_four_id order by u.version desc limit 1;
  if v_src.status <> 'locked' or v_latest.id <> v_src.id then return query select 'source_not_the_locked_latest'::text, null::uuid; return; end if;
  if exists (select 1 from projects.phase_five f where f.phase_four_id = v_j.phase_four_id) then
    return query select 'phase_five_started'::text, null::uuid; return;
  end if;
  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'empty_screens'::text, null::uuid; return;
  end if;

  if p_screens = v_src.screens then return query select 'no_content_change'::text, v_src.id; return; end if;

  insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, screens)
  values (v_j.organization_id, v_j.project_id, v_j.phase_four_id, v_src.source_phase_three_handoff_id, v_src.version + 1, p_screens)
  returning id into v_new;
  update projects.phase_four set state = 'ui_design', blocked_reason = null where id = v_j.phase_four_id and state not in ('completed');
  perform projects.p4ui_complete_design_job(v_j.id, v_new);
  perform projects.p4ui_derive_version_meta(v_new, null, v_j.id);
  perform core.record_audit(v_j.organization_id, 'project.ui_version_drafted', 'ui_version', v_new, null,
    jsonb_build_object('projectId', v_j.project_id, 'phaseFourId', v_j.phase_four_id, 'version', v_src.version + 1, 'revisionOf', v_src.id, 'reason', v_j.activation_reason));
  -- the existing event: Design QA reviews it from scratch, exactly like any other draft
  perform core.emit_event(v_j.organization_id, 'project.ui_version_drafted', 'ui_version', v_new,
    jsonb_build_object('projectId', v_j.project_id, 'phaseFourId', v_j.phase_four_id));
  return query select 'revised'::text, v_new;
end $$;
revoke all on function projects.p4ui_start_governed_revision(uuid, jsonb) from public, anon;
grant execute on function projects.p4ui_start_governed_revision(uuid, jsonb) to authenticated, service_role;

revoke all on function projects.revise_ui_version(uuid, jsonb) from public, anon;
grant execute on function projects.revise_ui_version(uuid, jsonb) to authenticated, service_role;
