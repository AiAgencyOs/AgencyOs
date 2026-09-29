-- ═══════════════════════════════════════════════════════════════════════════
-- A design has activity, assets have states, and Git is written.
--
-- Decision: reversed by the owner on 2026-09-30 — Git writes (branch, review, merge) through governed doors
--
-- Bucket F, stream F-D (SCR-032–043). Everything here closes an element the
-- PDF names on the Design & Prototype and Development screens and the
-- element audit found PARTIAL or MISSING:
--
--   SCR-032  a design activity feed — the audit rows for design subjects,
--            read per project through projects.read_design_activity so a
--            delivery lead (who cannot read audit.audit_log) still sees
--            what happened on the design they are responsible for.
--   SCR-033  theme directions and colour variants a PERSON records beside
--            the generated ones (`source` = generated | recorded), through
--            the same ceiling-checked doors the agent uses.
--   SCR-034/035  screens carry device targets, a component list and a
--            responsive coverage matrix, and a person edits the four states
--            after creation (projects.set_screen_states).
--   SCR-038  design assets have a state (draft | approved), a version and
--            a parent; a person uploads one (the object lives in Supabase
--            Storage, bucket from SUPABASE_FILES_BUCKET), replaces it with a
--            new version, and marks it approved. The generated rows stay as
--            they were; the new columns are nullable for them and required
--            for an upload by CHECK.
--   SCR-037  a prototype artifact names its platform and is submitted to QA
--            by a person (qa_submitted_at), audited.
--   SCR-040  each plan deliverable gets its seven layers (frontend, backend,
--            database, apis, integrations, auth, business_logic) and an
--            execution order — in projects.plan_layers, a companion table,
--            because plan_deliverables is frozen once the plan is active and
--            the layers are Phase 5's work on an active plan.
--   SCR-041  task doors: start, ready_for_qa, submit_evidence,
--            reopen_from_defect — each a transition the task page offers
--            and the database checks, with projects.task_evidence as the
--            record a "done" points at.
--   SCR-039  a blocker escalation and a QA handoff are RECORDED
--            (projects.development_events); the handoff refuses while a
--            task is blocked or not yet in review.
--   SCR-042  projects.commit_links (task ↔ commit) and projects.git_actions
--            — the record of every write the panel makes to GitHub
--            (branch created, review submitted, merged, build triggered).
--            The write itself happens in src/lib/git/github-write.ts; this
--            table is what the panel can show afterwards, and the audit row
--            (git.branch_created | git.review_submitted | git.merged |
--            git.build_triggered) is written in the same transaction.
--   SCR-043  environments carry `readiness` (api_contract, migrations,
--            external_config — each ok/evidence/checked) and a promoted
--            build; promote_build is gated on the readiness checks and on
--            qa.release_gates(). repository_links learns the workflow file
--            a build trigger dispatches.
--
-- Every door is security invoker where the table has a write policy for the
-- roles it names, and security definer only where the neighbouring door
-- already is (theme/colour options, prototype artifacts) — with the same
-- explicit organisation and role checks that door makes. Every governed
-- write calls core.record_audit inside its own transaction.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. SCR-032 — design activity
-- ═══════════════════════════════════════════════════════════════════════════

-- The subjects Phase 3 and Phase 4 audit under, each mapped to its project.
-- security_invoker: audit_log's own policy decides for a direct reader.
create or replace view projects.design_activity
with (security_invoker = true) as
  select a.id,
         a.organization_id,
         s.project_id,
         a.action,
         a.subject_type,
         a.subject_id,
         a.actor_type,
         a.actor_id,
         a.after,
         a.created_at
    from audit.audit_log a
    join lateral (
      select t.project_id from projects.theme_options t where a.subject_type = 'theme_option' and t.id = a.subject_id
      union all
      select t.project_id from projects.color_options c join projects.theme_options t on t.id = c.theme_option_id
       where a.subject_type = 'color_option' and c.id = a.subject_id
      union all
      select d.project_id from projects.design_assets d where a.subject_type = 'design_asset' and d.id = a.subject_id
      union all
      select s.project_id from projects.screens s where a.subject_type = 'screen' and s.id = a.subject_id
      union all
      select b.project_id from projects.screen_baselines b where a.subject_type = 'screen_baseline' and b.id = a.subject_id
      union all
      select u.project_id from projects.ui_versions u where a.subject_type = 'ui_version' and u.id = a.subject_id
      union all
      select p.project_id from projects.phase_three p where a.subject_type = 'phase_three' and p.id = a.subject_id
      union all
      select h.project_id from projects.phase_three_handoffs h where a.subject_type = 'phase_three_handoff' and h.id = a.subject_id
      union all
      select pa.project_id from projects.prototype_artifacts pa where a.subject_type = 'prototype_artifact' and pa.id = a.subject_id
    ) s on true
   where a.subject_type in ('theme_option', 'color_option', 'design_asset', 'screen', 'screen_baseline',
                            'ui_version', 'phase_three', 'phase_three_handoff', 'prototype_artifact');

comment on view projects.design_activity is
  'SCR-032 — every audit row whose subject is a design artefact, joined to its project. security_invoker: audit_log''s policy (owner, ops_admin) decides for a direct read; the Design overview reads through projects.read_design_activity so every internal role sees its own project''s design history.';

grant select on projects.design_activity to authenticated, service_role;

-- The reader every internal role may use: scoped to the caller's own
-- organisation and refused outside it. security definer only so the view's
-- audit_log policy does not hide a delivery lead's own project from them.
create or replace function projects.read_design_activity(p_project_id uuid, p_limit int default 30)
returns table (
  id            bigint,
  project_id    uuid,
  action        text,
  subject_type  text,
  subject_id    uuid,
  actor_type    text,
  actor_id      uuid,
  actor_name    text,
  after         jsonb,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.project_id, a.action, a.subject_type, a.subject_id, a.actor_type, a.actor_id,
         u.full_name as actor_name, a.after, a.created_at
    from projects.design_activity a
    left join core.users u on u.id = a.actor_id
   where a.project_id = p_project_id
     and a.organization_id = (select core.current_organization_id())
     and coalesce((select core.is_internal()), false)
   order by a.created_at desc, a.id desc
   limit greatest(1, least(coalesce(p_limit, 30), 200));
$$;

comment on function projects.read_design_activity(uuid, int) is
  'SCR-032 — the design activity feed for one project, for any internal role of the same organisation. Reads only.';

revoke all on function projects.read_design_activity(uuid, int) from public, anon;
grant execute on function projects.read_design_activity(uuid, int) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. SCR-033 — directions and variants a person records
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.theme_options
  add column if not exists source text not null default 'generated'
    check (source in ('generated', 'recorded'));
alter table projects.color_options
  add column if not exists source text not null default 'generated'
    check (source in ('generated', 'recorded'));

comment on column projects.theme_options.source is
  'SCR-033 — generated by the design agent, or recorded by a person through projects.record_theme_direction. The ceiling (2–3, theme_option_limit) counts both.';
comment on column projects.color_options.source is
  'SCR-033 — generated by the design agent, or recorded by a person through projects.record_color_variant.';

-- A person's direction: the SAME door the agent uses (ceiling, baseline,
-- idempotency all decided there), then the source is written and audited.
create or replace function projects.record_theme_direction(
  p_project_id        uuid,
  p_option_index      int,
  p_name              text,
  p_direction_summary text
)
returns table (outcome text, theme_option_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  r       record;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null or v_org is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select * into r from projects.record_theme_option(p_project_id, p_option_index, p_name, p_direction_summary, '{}'::jsonb);
  if r.outcome is distinct from 'recorded' then
    return query select r.outcome, r.theme_option_id; return;
  end if;

  update projects.theme_options set source = 'recorded' where id = r.theme_option_id;

  perform core.record_audit(
    v_org, 'project.theme_direction_recorded', 'theme_option', r.theme_option_id, null,
    jsonb_build_object('projectId', p_project_id, 'optionIndex', p_option_index, 'name', btrim(p_name), 'source', 'recorded')
  );
  return query select 'recorded'::text, r.theme_option_id;
end;
$$;

comment on function projects.record_theme_direction(uuid, int, text, text) is
  'SCR-033 — a person records a theme direction beside the generated ones. Owner, ops_admin or delivery_lead; the ceiling and the finalized-baseline rule are projects.record_theme_option''s; audited project.theme_direction_recorded.';

revoke all on function projects.record_theme_direction(uuid, int, text, text) from public, anon;
grant execute on function projects.record_theme_direction(uuid, int, text, text) to authenticated, service_role;

create or replace function projects.record_color_variant(
  p_theme_option_id uuid,
  p_option_index    int,
  p_palette_name    text,
  p_primary_hex     text,
  p_secondary_hex   text default null,
  p_accent_hex      text default null,
  p_contrast_notes  text default null
)
returns table (outcome text, color_option_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_project uuid;
  v_tokens jsonb := '{}'::jsonb;
  r       record;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  select t.organization_id, t.project_id into v_org, v_project from projects.theme_options t where t.id = p_theme_option_id;
  if v_org is null then
    return query select 'unknown_option'::text, null::uuid; return;
  end if;
  if v_org is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if p_secondary_hex is not null then v_tokens := v_tokens || jsonb_build_object('secondary_hex', p_secondary_hex); end if;
  if p_accent_hex is not null then v_tokens := v_tokens || jsonb_build_object('accent_hex', p_accent_hex); end if;

  select * into r from projects.record_color_option(p_theme_option_id, p_option_index, p_palette_name, p_primary_hex, v_tokens, p_contrast_notes, null);
  if r.outcome is distinct from 'recorded' then
    return query select r.outcome, r.color_option_id; return;
  end if;

  update projects.color_options set source = 'recorded' where id = r.color_option_id;

  perform core.record_audit(
    v_org, 'project.color_variant_recorded', 'color_option', r.color_option_id, null,
    jsonb_build_object('projectId', v_project, 'themeOptionId', p_theme_option_id, 'optionIndex', p_option_index,
                       'paletteName', btrim(p_palette_name), 'source', 'recorded')
  );
  return query select 'recorded'::text, r.color_option_id;
end;
$$;

comment on function projects.record_color_variant(uuid, int, text, text, text, text, text) is
  'SCR-033 — a person records a colour variant against a theme direction. Owner, ops_admin or delivery_lead; hex validation is projects.record_color_option''s; audited project.color_variant_recorded.';

revoke all on function projects.record_color_variant(uuid, int, text, text, text, text, text) from public, anon;
grant execute on function projects.record_color_variant(uuid, int, text, text, text, text, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. SCR-034/035 — screen fields and the edit-states door
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.screens
  add column if not exists device_targets text[] not null default '{}'::text[],
  add column if not exists components text[] not null default '{}'::text[],
  add column if not exists responsive_coverage jsonb not null default '{}'::jsonb;

alter table projects.screens drop constraint if exists screens_responsive_coverage_is_object;
alter table projects.screens add constraint screens_responsive_coverage_is_object
  check (jsonb_typeof(responsive_coverage) = 'object');

comment on column projects.screens.device_targets is
  'SCR-035 — the devices this screen is designed for (e.g. mobile, tablet, desktop), as a list rather than prose so the inventory can filter on it.';
comment on column projects.screens.components is
  'SCR-035 — the components the screen is composed of, as a list.';
comment on column projects.screens.responsive_coverage is
  'SCR-034 — {"mobile": true, "tablet": false, "desktop": true}: which device targets have a drawn, checked layout. Only keys in device_targets mean anything; the page reports coverage as targets with true over all targets.';

-- user_role is the "role" SCR-035 names (it has existed since the inventory);
-- the door lets a person set it beside the states.
create or replace function projects.set_screen_states(
  p_screen_id           uuid,
  p_has_empty_state     boolean,
  p_has_loading_state   boolean,
  p_has_error_state     boolean,
  p_has_success_state   boolean,
  p_user_role           text default null,
  p_device_targets      text[] default null,
  p_components          text[] default null,
  p_responsive_coverage jsonb default null
)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_before projects.screens;
  v_after  projects.screens;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text; return;
  end if;

  select * into v_before from projects.screens s where s.id = p_screen_id for update;
  if v_before.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_before.status = 'superseded' then
    return query select 'superseded'::text; return;
  end if;
  if p_responsive_coverage is not null and jsonb_typeof(p_responsive_coverage) <> 'object' then
    return query select 'bad_coverage'::text; return;
  end if;

  update projects.screens s
     set has_empty_state     = p_has_empty_state,
         has_loading_state   = p_has_loading_state,
         has_error_state     = p_has_error_state,
         has_success_state   = p_has_success_state,
         user_role           = coalesce(nullif(btrim(p_user_role), ''), s.user_role),
         device_targets      = coalesce(p_device_targets, s.device_targets),
         components          = coalesce(p_components, s.components),
         responsive_coverage = coalesce(p_responsive_coverage, s.responsive_coverage)
   where s.id = p_screen_id
   returning s.* into v_after;

  perform core.record_audit(
    v_after.organization_id, 'project.screen_states_set', 'screen', p_screen_id,
    jsonb_build_object('hasEmptyState', v_before.has_empty_state, 'hasLoadingState', v_before.has_loading_state,
                       'hasErrorState', v_before.has_error_state, 'hasSuccessState', v_before.has_success_state,
                       'userRole', v_before.user_role, 'deviceTargets', to_jsonb(v_before.device_targets),
                       'components', to_jsonb(v_before.components), 'responsiveCoverage', v_before.responsive_coverage),
    jsonb_build_object('hasEmptyState', v_after.has_empty_state, 'hasLoadingState', v_after.has_loading_state,
                       'hasErrorState', v_after.has_error_state, 'hasSuccessState', v_after.has_success_state,
                       'userRole', v_after.user_role, 'deviceTargets', to_jsonb(v_after.device_targets),
                       'components', to_jsonb(v_after.components), 'responsiveCoverage', v_after.responsive_coverage)
  );
  return query select 'set'::text;
end;
$$;

comment on function projects.set_screen_states(uuid, boolean, boolean, boolean, boolean, text, text[], text[], jsonb) is
  'SCR-035 — a person edits a screen''s four states, role, device targets, components and responsive coverage after creation. Owner, ops_admin or delivery_lead (screens_update decides again); audited project.screen_states_set with before and after.';

revoke all on function projects.set_screen_states(uuid, boolean, boolean, boolean, boolean, text, text[], text[], jsonb) from public, anon;
grant execute on function projects.set_screen_states(uuid, boolean, boolean, boolean, boolean, text, text[], text[], jsonb) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. SCR-038 — design assets have a state, a version and a body in storage
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.design_assets
  add column if not exists origin          text not null default 'generated' check (origin in ('generated', 'uploaded')),
  add column if not exists status          text not null default 'draft' check (status in ('draft', 'approved')),
  add column if not exists version         int  not null default 1 check (version > 0),
  add column if not exists parent_asset_id uuid references projects.design_assets(id) on delete cascade,
  add column if not exists title           text,
  add column if not exists storage_path    text,
  add column if not exists size_bytes      bigint check (size_bytes is null or size_bytes >= 0),
  add column if not exists uploaded_by     uuid references core.users(id) on delete set null,
  add column if not exists approved_by     uuid references core.users(id) on delete set null,
  add column if not exists approved_at     timestamptz,
  add column if not exists updated_at      timestamptz not null default now();

-- A generated row keeps its prompt, image and model; an uploaded row has a
-- storage object instead. The NOT NULLs are relaxed and a CHECK says which
-- shape a row must have, so neither kind can be half-described.
alter table projects.design_assets alter column prompt drop not null;
alter table projects.design_assets alter column image_base64 drop not null;
alter table projects.design_assets alter column model drop not null;
alter table projects.design_assets alter column rights_note drop not null;
alter table projects.design_assets alter column media_type drop default;
alter table projects.design_assets drop constraint if exists design_assets_media_type_check;
alter table projects.design_assets add constraint design_assets_media_type_check
  check (media_type in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf'));

alter table projects.design_assets drop constraint if exists design_assets_shape_matches_origin;
alter table projects.design_assets add constraint design_assets_shape_matches_origin
  check (
    (origin = 'generated' and prompt is not null and image_base64 is not null and model is not null and rights_note is not null)
    or
    (origin = 'uploaded' and storage_path is not null and length(btrim(storage_path)) > 0 and title is not null and length(btrim(title)) > 0)
  );

create index if not exists design_assets_parent_idx
  on projects.design_assets (parent_asset_id, version desc) where parent_asset_id is not null;
create index if not exists design_assets_status_idx
  on projects.design_assets (organization_id, project_id, status);

comment on column projects.design_assets.status is
  'SCR-038 — draft until a person marks it approved through projects.mark_design_asset_approved. Approval is per version; a replacement starts as draft.';
comment on column projects.design_assets.parent_asset_id is
  'SCR-038 — the first version this one replaces. Null on a first version; versions of one family share a parent and count up.';
comment on column projects.design_assets.storage_path is
  'SCR-038 — for an uploaded asset, the object in the project-files bucket (<org>/<project>/design-assets/<id>/<version>-<name>). The body is never in this table.';

drop trigger if exists set_updated_at on projects.design_assets;
create trigger set_updated_at before update on projects.design_assets
  for each row execute function core.set_updated_at();

drop trigger if exists org_match_design_assets_parent on projects.design_assets;
create trigger org_match_design_assets_parent
  before insert or update of parent_asset_id, organization_id on projects.design_assets
  for each row execute function core.enforce_parent_org('parent_asset_id', 'projects.design_assets');

drop trigger if exists freeze_org_design_assets on projects.design_assets;
create trigger freeze_org_design_assets
  before update of organization_id on projects.design_assets
  for each row execute function core.freeze_organization_id();

-- Writes for the three doors below. Insert: an upload. Update: a status
-- change. Both by owner, ops_admin and delivery_lead — project.write's roles.
drop policy if exists design_assets_insert_upload on projects.design_assets;
create policy design_assets_insert_upload on projects.design_assets
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_manage_delivery())
              and origin = 'uploaded');

drop policy if exists design_assets_update on projects.design_assets;
create policy design_assets_update on projects.design_assets
  for update to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

grant insert, update on projects.design_assets to authenticated, service_role;

-- Upload (first version or replacement). The caller has already put the
-- object at p_storage_path; this records it and gives it a version.
create or replace function projects.record_uploaded_design_asset(
  p_project_id      uuid,
  p_kind            text,
  p_title           text,
  p_storage_path    text,
  p_media_type      text,
  p_size_bytes      bigint,
  p_parent_asset_id uuid default null
)
returns table (outcome text, asset_id uuid, version int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid;
  v_phase   uuid;
  v_parent  projects.design_assets;
  v_version int := 1;
  v_id      uuid;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null or v_org is distinct from (select core.current_organization_id()) then
    return query select 'not_found'::text, null::uuid, null::int; return;
  end if;
  select p3.id into v_phase from projects.phase_three p3 where p3.project_id = p_project_id;
  if v_phase is null then
    return query select 'no_phase_three'::text, null::uuid, null::int; return;
  end if;
  if p_kind not in ('illustration', 'reference', 'texture', 'mood_board', 'visual_asset') then
    return query select 'bad_kind'::text, null::uuid, null::int; return;
  end if;

  if p_parent_asset_id is not null then
    select * into v_parent from projects.design_assets d where d.id = p_parent_asset_id for update;
    if v_parent.id is null or v_parent.project_id is distinct from p_project_id then
      return query select 'parent_not_found'::text, null::uuid, null::int; return;
    end if;
    if v_parent.parent_asset_id is not null then
      return query select 'parent_is_a_version'::text, null::uuid, null::int; return;
    end if;
    select coalesce(max(d.version), 1) + 1 into v_version
      from projects.design_assets d
     where d.id = p_parent_asset_id or d.parent_asset_id = p_parent_asset_id;
  end if;

  insert into projects.design_assets (
    organization_id, project_id, phase_three_id, kind, origin, status, version, parent_asset_id,
    title, storage_path, media_type, size_bytes, uploaded_by,
    source_context_version, rights_note
  ) values (
    v_org, p_project_id, v_phase, p_kind, 'uploaded', 'draft', v_version, p_parent_asset_id,
    btrim(p_title), p_storage_path, p_media_type, p_size_bytes, v_actor,
    'upload:' || gen_random_uuid()::text,
    'Uploaded by a person; rights as the uploader holds them.'
  )
  returning id into v_id;

  perform core.record_audit(
    v_org, case when p_parent_asset_id is null then 'project.design_asset_uploaded' else 'project.design_asset_replaced' end,
    'design_asset', v_id, null,
    jsonb_build_object('projectId', p_project_id, 'kind', p_kind, 'title', btrim(p_title), 'version', v_version,
                       'parentAssetId', p_parent_asset_id, 'storagePath', p_storage_path)
  );
  return query select 'recorded'::text, v_id, v_version;
end;
$$;

comment on function projects.record_uploaded_design_asset(uuid, text, text, text, text, bigint, uuid) is
  'SCR-038 — records an uploaded design asset (first version, or a replacement when p_parent_asset_id names the first version). The object is already in storage; this is the row. Owner, ops_admin or delivery_lead; audited project.design_asset_uploaded / project.design_asset_replaced.';

revoke all on function projects.record_uploaded_design_asset(uuid, text, text, text, text, bigint, uuid) from public, anon;
grant execute on function projects.record_uploaded_design_asset(uuid, text, text, text, text, bigint, uuid) to authenticated, service_role;

create or replace function projects.mark_design_asset_approved(p_asset_id uuid)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.design_assets;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_row from projects.design_assets d where d.id = p_asset_id for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.status = 'approved' then
    return query select 'already_approved'::text; return;
  end if;

  update projects.design_assets
     set status = 'approved', approved_by = v_actor, approved_at = now()
   where id = p_asset_id;

  perform core.record_audit(
    v_row.organization_id, 'project.design_asset_approved', 'design_asset', p_asset_id,
    jsonb_build_object('status', v_row.status, 'version', v_row.version),
    jsonb_build_object('status', 'approved', 'version', v_row.version, 'projectId', v_row.project_id)
  );
  return query select 'approved'::text;
end;
$$;

comment on function projects.mark_design_asset_approved(uuid) is
  'SCR-038 — a person marks one asset version approved. Owner, ops_admin or delivery_lead; refuses already_approved so a repeat click writes no audit row; audited project.design_asset_approved.';

revoke all on function projects.mark_design_asset_approved(uuid) from public, anon;
grant execute on function projects.mark_design_asset_approved(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. SCR-037 — a prototype names its platform and is submitted to QA
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.prototype_artifacts
  add column if not exists platform text check (platform is null or platform in ('web', 'ios', 'android', 'desktop', 'cross_platform')),
  add column if not exists qa_submitted_at timestamptz,
  add column if not exists qa_submitted_by uuid references core.users(id) on delete set null;

comment on column projects.prototype_artifacts.platform is
  'SCR-037 — what the prototype is built for (web, iOS, Android, desktop, cross-platform), set by a person through projects.set_prototype_platform.';
comment on column projects.prototype_artifacts.qa_submitted_at is
  'SCR-037 — when a person submitted this build to QA (projects.submit_prototype_to_qa). Null until then. The QA verdict itself is qa_findings / qa_reviewed_at.';

-- Same security mode as record_prototype_build, with the same explicit checks.
create or replace function projects.set_prototype_platform(p_artifact_id uuid, p_platform text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.prototype_artifacts;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  select * into v_row from projects.prototype_artifacts a where a.id = p_artifact_id for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_platform not in ('web', 'ios', 'android', 'desktop', 'cross_platform') then
    return query select 'bad_platform'::text; return;
  end if;
  if v_row.platform is not distinct from p_platform then
    return query select 'unchanged'::text; return;
  end if;

  update projects.prototype_artifacts set platform = p_platform where id = p_artifact_id;

  perform core.record_audit(
    v_row.organization_id, 'project.prototype_platform_set', 'prototype_artifact', p_artifact_id,
    jsonb_build_object('platform', v_row.platform), jsonb_build_object('platform', p_platform, 'projectId', v_row.project_id)
  );
  return query select 'set'::text;
end;
$$;

comment on function projects.set_prototype_platform(uuid, text) is
  'SCR-037 — a person names the platform a prototype build targets. Owner, ops_admin or delivery_lead of the artifact''s organisation; audited project.prototype_platform_set.';

revoke all on function projects.set_prototype_platform(uuid, text) from public, anon;
grant execute on function projects.set_prototype_platform(uuid, text) to authenticated, service_role;

create or replace function projects.submit_prototype_to_qa(p_artifact_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.prototype_artifacts;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  select * into v_row from projects.prototype_artifacts a where a.id = p_artifact_id for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if v_row.qa_submitted_at is not null then
    return query select 'already_submitted'::text; return;
  end if;

  update projects.prototype_artifacts
     set qa_submitted_at = now(), qa_submitted_by = v_actor
   where id = p_artifact_id;

  perform core.record_audit(
    v_row.organization_id, 'project.prototype_submitted_to_qa', 'prototype_artifact', p_artifact_id, null,
    jsonb_build_object('projectId', v_row.project_id, 'uiVersionId', v_row.ui_version_id, 'deliverableId', v_row.deliverable_id)
  );
  return query select 'submitted'::text;
end;
$$;

comment on function projects.submit_prototype_to_qa(uuid) is
  'SCR-037 — a person hands a prototype build to QA. Once; a second submission is refused as already_submitted. Audited project.prototype_submitted_to_qa.';

revoke all on function projects.submit_prototype_to_qa(uuid) from public, anon;
grant execute on function projects.submit_prototype_to_qa(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. SCR-040 — the seven layers and the execution order, per deliverable
-- ═══════════════════════════════════════════════════════════════════════════

-- Only the seven layers, each an object with a status — a function rather
-- than an inline CHECK because a CHECK may not hold a subquery.
create or replace function projects.plan_layers_valid(p_layers jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_layers is not null
     and jsonb_typeof(p_layers) = 'object'
     and not exists (
       select 1 from jsonb_object_keys(p_layers) k
        where k not in ('frontend', 'backend', 'database', 'apis', 'integrations', 'auth', 'business_logic')
     )
     and not exists (
       select 1 from jsonb_each(p_layers) e
        where jsonb_typeof(e.value) <> 'object'
           or coalesce(e.value ->> 'status', '') not in ('planned', 'in_progress', 'done', 'not_applicable')
     );
$$;

comment on function projects.plan_layers_valid(jsonb) is
  'SCR-040 — true when a layers object names only the seven layers and gives each a status in planned | in_progress | done | not_applicable.';

create table if not exists projects.plan_layers (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  plan_deliverable_id uuid not null references projects.plan_deliverables(id) on delete cascade,

  -- {"frontend": {"status": "planned", "note": "..."}, ...} — only the seven
  -- keys, each with a status; enforced by projects.plan_layers_valid.
  layers              jsonb not null default '{}'::jsonb check (projects.plan_layers_valid(layers)),
  execution_order     int check (execution_order is null or execution_order between 1 and 999),

  updated_by          uuid references core.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (plan_deliverable_id)
);

create index if not exists plan_layers_org_idx on projects.plan_layers (organization_id, plan_deliverable_id);

comment on table projects.plan_layers is
  'SCR-040 — per plan deliverable, the seven implementation layers (frontend, backend, database, apis, integrations, auth, business_logic) each with a status and a note, and the execution order. A companion to plan_deliverables because that table freezes when the plan goes active and this is Phase 5''s work on it.';

drop trigger if exists set_updated_at on projects.plan_layers;
create trigger set_updated_at before update on projects.plan_layers
  for each row execute function core.set_updated_at();

alter table projects.plan_layers enable row level security;
alter table projects.plan_layers force row level security;

drop policy if exists plan_layers_select on projects.plan_layers;
create policy plan_layers_select on projects.plan_layers
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists plan_layers_write on projects.plan_layers;
create policy plan_layers_write on projects.plan_layers
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

grant select, insert, update, delete on projects.plan_layers to authenticated, service_role;

drop trigger if exists org_match_plan_layers_deliverable on projects.plan_layers;
create trigger org_match_plan_layers_deliverable
  before insert or update of plan_deliverable_id, organization_id on projects.plan_layers
  for each row execute function core.enforce_parent_org('plan_deliverable_id', 'projects.plan_deliverables');

drop trigger if exists freeze_org_plan_layers on projects.plan_layers;
create trigger freeze_org_plan_layers
  before update of organization_id on projects.plan_layers
  for each row execute function core.freeze_organization_id();

create or replace function projects.set_plan_layers(
  p_plan_deliverable_id uuid,
  p_layers              jsonb,
  p_execution_order     int default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_before jsonb;
  v_id     uuid;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select d.organization_id into v_org from projects.plan_deliverables d where d.id = p_plan_deliverable_id;
  if v_org is null or v_org is distinct from (select core.current_organization_id()) then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if p_layers is null or jsonb_typeof(p_layers) <> 'object' then
    return query select 'bad_layers'::text, null::uuid; return;
  end if;

  select to_jsonb(l) - 'organization_id' into v_before from projects.plan_layers l where l.plan_deliverable_id = p_plan_deliverable_id;

  begin
    insert into projects.plan_layers (organization_id, plan_deliverable_id, layers, execution_order, updated_by)
    values (v_org, p_plan_deliverable_id, p_layers, p_execution_order, v_actor)
    on conflict (plan_deliverable_id) do update
      set layers = excluded.layers, execution_order = excluded.execution_order, updated_by = excluded.updated_by
    returning projects.plan_layers.id into v_id;
  exception
    when check_violation then
      return query select 'bad_layers'::text, null::uuid; return;
  end;

  perform core.record_audit(
    v_org, 'project.plan_layers_set', 'plan_deliverable', p_plan_deliverable_id, v_before,
    jsonb_build_object('layers', p_layers, 'executionOrder', p_execution_order)
  );
  return query select 'set'::text, v_id;
end;
$$;

comment on function projects.set_plan_layers(uuid, jsonb, int) is
  'SCR-040 — a person records the seven layers and the execution order of one plan deliverable. Owner, ops_admin or delivery_lead; a layer outside the seven or a status outside planned/in_progress/done/not_applicable is refused as bad_layers; audited project.plan_layers_set.';

revoke all on function projects.set_plan_layers(uuid, jsonb, int) from public, anon;
grant execute on function projects.set_plan_layers(uuid, jsonb, int) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. SCR-041 — task doors and task evidence
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.tasks
  add column if not exists started_at      timestamptz,
  add column if not exists ready_for_qa_at timestamptz,
  add column if not exists reopened_count  int not null default 0 check (reopened_count >= 0);

comment on column projects.tasks.ready_for_qa_at is
  'SCR-041 — when the task was last marked ready for QA (projects.mark_task_ready_for_qa). Cleared when it is reopened from a defect. Handoff status on the task page is read from this and status.';

create table if not exists projects.task_evidence (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,

  kind             text not null default 'test' check (kind in ('test', 'implementation', 'review', 'other')),
  title            text not null check (length(btrim(title)) between 1 and 200),
  url              text check (url is null or length(btrim(url)) between 1 and 2000),
  note             text check (note is null or length(note) <= 4000),

  submitted_by     uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists task_evidence_task_idx on projects.task_evidence (task_id, created_at desc);
create index if not exists task_evidence_org_idx on projects.task_evidence (organization_id, created_at desc);

comment on table projects.task_evidence is
  'SCR-041 — what a task''s "done" points at: a test run link, a screenshot, a review note. A reference, never a blob (the project_files rule). Submitted through projects.submit_task_evidence, audited.';

drop trigger if exists set_updated_at on projects.task_evidence;
create trigger set_updated_at before update on projects.task_evidence
  for each row execute function core.set_updated_at();

alter table projects.task_evidence enable row level security;
alter table projects.task_evidence force row level security;

drop policy if exists task_evidence_select on projects.task_evidence;
create policy task_evidence_select on projects.task_evidence
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- The roles holding task.write: core.can_write() (owner, ops_admin,
-- delivery_lead, member) — the same policy projects.tasks itself has.
drop policy if exists task_evidence_write on projects.task_evidence;
create policy task_evidence_write on projects.task_evidence
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert, update, delete on projects.task_evidence to authenticated, service_role;

drop trigger if exists org_match_task_evidence_task on projects.task_evidence;
create trigger org_match_task_evidence_task
  before insert or update of task_id, organization_id on projects.task_evidence
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

drop trigger if exists freeze_org_task_evidence on projects.task_evidence;
create trigger freeze_org_task_evidence
  before update of organization_id on projects.task_evidence
  for each row execute function core.freeze_organization_id();

create or replace function projects.start_task(p_task_id uuid)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task projects.tasks;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_task.status <> 'todo' then
    return query select 'wrong_state'::text; return;
  end if;

  update projects.tasks set status = 'in_progress', started_at = coalesce(started_at, now()) where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.started', 'task', p_task_id,
    jsonb_build_object('status', v_task.status), jsonb_build_object('status', 'in_progress', 'projectId', v_task.project_id)
  );
  return query select 'started'::text;
end;
$$;

comment on function projects.start_task(uuid) is
  'SCR-041 — todo → in_progress. Any task.write role; refused wrong_state from any other status; audited task.started.';

revoke all on function projects.start_task(uuid) from public, anon;
grant execute on function projects.start_task(uuid) to authenticated, service_role;

create or replace function projects.mark_task_ready_for_qa(p_task_id uuid)
returns table (outcome text, evidence_count int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task     projects.tasks;
  v_evidence int;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::int; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null then
    return query select 'not_found'::text, null::int; return;
  end if;
  if v_task.status = 'blocked' then
    return query select 'blocked'::text, null::int; return;
  end if;
  if v_task.status <> 'in_progress' then
    return query select 'wrong_state'::text, null::int; return;
  end if;
  select count(*)::int into v_evidence from projects.task_evidence e where e.task_id = p_task_id;
  -- "Evidence required" (plan_deliverables.evidence_required) is the rule;
  -- a hand-off with nothing to point at is refused here, not on the QA tab.
  if v_evidence = 0 then
    return query select 'no_evidence'::text, 0; return;
  end if;

  update projects.tasks set status = 'in_review', ready_for_qa_at = now() where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.ready_for_qa', 'task', p_task_id,
    jsonb_build_object('status', v_task.status),
    jsonb_build_object('status', 'in_review', 'evidenceCount', v_evidence, 'projectId', v_task.project_id)
  );
  return query select 'ready'::text, v_evidence;
end;
$$;

comment on function projects.mark_task_ready_for_qa(uuid) is
  'SCR-041 — in_progress → in_review, only with at least one evidence row and never while blocked. Audited task.ready_for_qa with the evidence count.';

revoke all on function projects.mark_task_ready_for_qa(uuid) from public, anon;
grant execute on function projects.mark_task_ready_for_qa(uuid) to authenticated, service_role;

create or replace function projects.submit_task_evidence(
  p_task_id uuid,
  p_kind    text,
  p_title   text,
  p_url     text default null,
  p_note    text default null
)
returns table (outcome text, evidence_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_task  projects.tasks;
  v_id    uuid;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if p_kind not in ('test', 'implementation', 'review', 'other') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if nullif(btrim(coalesce(p_url, '')), '') is null and nullif(btrim(coalesce(p_note, '')), '') is null then
    return query select 'nothing_to_point_at'::text, null::uuid; return;
  end if;

  insert into projects.task_evidence (organization_id, task_id, kind, title, url, note, submitted_by)
  values (v_task.organization_id, p_task_id, p_kind, btrim(p_title), nullif(btrim(coalesce(p_url, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_task.organization_id, 'task.evidence_submitted', 'task', p_task_id, null,
    jsonb_build_object('evidenceId', v_id, 'kind', p_kind, 'title', btrim(p_title), 'url', nullif(btrim(coalesce(p_url, '')), ''), 'projectId', v_task.project_id)
  );
  return query select 'submitted'::text, v_id;
end;
$$;

comment on function projects.submit_task_evidence(uuid, text, text, text, text) is
  'SCR-041 — a person attaches evidence (a link and/or a note) to a task. A row with neither is refused: evidence points at something. Audited task.evidence_submitted.';

revoke all on function projects.submit_task_evidence(uuid, text, text, text, text) from public, anon;
grant execute on function projects.submit_task_evidence(uuid, text, text, text, text) to authenticated, service_role;

create or replace function projects.reopen_task_from_defect(p_task_id uuid, p_defect_id uuid)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_task   projects.tasks;
  v_defect qa.defects;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null then
    return query select 'not_found'::text; return;
  end if;
  select * into v_defect from qa.defects d where d.id = p_defect_id;
  if v_defect.id is null or v_defect.task_id is distinct from p_task_id then
    return query select 'defect_not_on_task'::text; return;
  end if;
  if v_defect.status <> 'open' then
    return query select 'defect_not_open'::text; return;
  end if;
  if v_task.status not in ('in_review', 'done') then
    return query select 'wrong_state'::text; return;
  end if;

  update projects.tasks
     set status = 'in_progress', completed_at = null, ready_for_qa_at = null, reopened_count = reopened_count + 1
   where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.reopened_from_defect', 'task', p_task_id,
    jsonb_build_object('status', v_task.status),
    jsonb_build_object('status', 'in_progress', 'defectId', p_defect_id, 'severity', v_defect.severity, 'projectId', v_task.project_id)
  );
  return query select 'reopened'::text;
end;
$$;

comment on function projects.reopen_task_from_defect(uuid, uuid) is
  'SCR-041 — in_review or done → in_progress, because an OPEN defect triaged against this task says the work is not done. Refuses a defect on another task or one already settled. Audited task.reopened_from_defect.';

revoke all on function projects.reopen_task_from_defect(uuid, uuid) from public, anon;
grant execute on function projects.reopen_task_from_defect(uuid, uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. SCR-039 — a blocker escalation and a QA handoff are recorded
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.development_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid references projects.tasks(id) on delete set null,

  kind             text not null check (kind in ('blocker_escalated', 'qa_handoff_started')),
  reason           text check (reason is null or length(reason) <= 4000),
  detail           jsonb not null default '{}'::jsonb,
  status           text not null default 'open' check (status in ('open', 'acknowledged', 'closed')),

  raised_by        uuid references core.users(id) on delete set null,
  acknowledged_by  uuid references core.users(id) on delete set null,
  acknowledged_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists development_events_project_idx on projects.development_events (organization_id, project_id, created_at desc);

comment on table projects.development_events is
  'SCR-039 — the record of a blocker escalated to the PM and of a QA handoff started, per project. A handoff is refused by projects.start_qa_handoff while a task is blocked or not yet in review; an escalation names its task and its reason.';

drop trigger if exists set_updated_at on projects.development_events;
create trigger set_updated_at before update on projects.development_events
  for each row execute function core.set_updated_at();

alter table projects.development_events enable row level security;
alter table projects.development_events force row level security;

drop policy if exists development_events_select on projects.development_events;
create policy development_events_select on projects.development_events
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists development_events_write on projects.development_events;
create policy development_events_write on projects.development_events
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert, update on projects.development_events to authenticated, service_role;

drop trigger if exists org_match_development_events_project on projects.development_events;
create trigger org_match_development_events_project
  before insert or update of project_id, organization_id on projects.development_events
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_development_events_task on projects.development_events;
create trigger org_match_development_events_task
  before insert or update of task_id, organization_id on projects.development_events
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

drop trigger if exists freeze_org_development_events on projects.development_events;
create trigger freeze_org_development_events
  before update of organization_id on projects.development_events
  for each row execute function core.freeze_organization_id();

create or replace function projects.escalate_blocker(p_task_id uuid, p_reason text)
returns table (outcome text, event_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_task  projects.tasks;
  v_id    uuid;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_task.status <> 'blocked' then
    return query select 'not_blocked'::text, null::uuid; return;
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    return query select 'no_reason'::text, null::uuid; return;
  end if;
  if exists (select 1 from projects.development_events e where e.task_id = p_task_id and e.kind = 'blocker_escalated' and e.status = 'open') then
    return query select 'already_open'::text, null::uuid; return;
  end if;

  insert into projects.development_events (organization_id, project_id, task_id, kind, reason, detail, raised_by)
  values (v_task.organization_id, v_task.project_id, p_task_id, 'blocker_escalated', btrim(p_reason),
          jsonb_build_object('blockedReason', v_task.blocked_reason, 'blockedAt', v_task.blocked_at), v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_task.organization_id, 'task.blocker_escalated', 'task', p_task_id, null,
    jsonb_build_object('eventId', v_id, 'reason', btrim(p_reason), 'projectId', v_task.project_id)
  );
  return query select 'escalated'::text, v_id;
end;
$$;

comment on function projects.escalate_blocker(uuid, text) is
  'SCR-039 — a blocked task is escalated to the PM with a reason, once while the escalation is open. Audited task.blocker_escalated.';

revoke all on function projects.escalate_blocker(uuid, text) from public, anon;
grant execute on function projects.escalate_blocker(uuid, text) to authenticated, service_role;

create or replace function projects.acknowledge_escalation(p_event_id uuid)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.development_events;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_row from projects.development_events e where e.id = p_event_id for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.status <> 'open' then
    return query select 'not_open'::text; return;
  end if;
  update projects.development_events set status = 'acknowledged', acknowledged_by = v_actor, acknowledged_at = now() where id = p_event_id;
  perform core.record_audit(
    v_row.organization_id, 'task.escalation_acknowledged', 'task', v_row.task_id,
    jsonb_build_object('status', 'open'), jsonb_build_object('status', 'acknowledged', 'eventId', p_event_id, 'projectId', v_row.project_id)
  );
  return query select 'acknowledged'::text;
end;
$$;

comment on function projects.acknowledge_escalation(uuid) is
  'SCR-039 — the PM (owner, ops_admin, delivery_lead) acknowledges an escalation. Audited task.escalation_acknowledged.';

revoke all on function projects.acknowledge_escalation(uuid) from public, anon;
grant execute on function projects.acknowledge_escalation(uuid) to authenticated, service_role;

create or replace function projects.start_qa_handoff(p_project_id uuid)
returns table (outcome text, event_id uuid, blocked int, not_ready int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor     uuid := (select auth.uid());
  v_org       uuid;
  v_blocked   int;
  v_not_ready int;
  v_id        uuid;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid, null::int, null::int; return;
  end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null then
    return query select 'not_found'::text, null::uuid, null::int, null::int; return;
  end if;

  select count(*) filter (where t.status = 'blocked')::int,
         count(*) filter (where t.status in ('todo', 'in_progress'))::int
    into v_blocked, v_not_ready
    from projects.tasks t where t.project_id = p_project_id;

  -- The gate: nothing blocked, nothing still being worked on.
  if v_blocked > 0 or v_not_ready > 0 then
    return query select 'gate_refused'::text, null::uuid, v_blocked, v_not_ready; return;
  end if;
  if exists (select 1 from projects.development_events e where e.project_id = p_project_id and e.kind = 'qa_handoff_started' and e.status = 'open') then
    return query select 'already_open'::text, null::uuid, 0, 0; return;
  end if;

  insert into projects.development_events (organization_id, project_id, kind, detail, raised_by)
  values (v_org, p_project_id, 'qa_handoff_started', jsonb_build_object('blocked', v_blocked, 'notReady', v_not_ready), v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'project.qa_handoff_started', 'project', p_project_id, null,
    jsonb_build_object('eventId', v_id)
  );
  return query select 'started'::text, v_id, 0, 0;
end;
$$;

comment on function projects.start_qa_handoff(uuid) is
  'SCR-039 — records that development handed the project to QA. Refused (gate_refused, with the counts) while any task is blocked or still todo/in_progress. Owner, ops_admin or delivery_lead; audited project.qa_handoff_started.';

revoke all on function projects.start_qa_handoff(uuid) from public, anon;
grant execute on function projects.start_qa_handoff(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. SCR-042 — commit links and the record of Git writes
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.commit_links (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,

  sha              text not null check (sha ~ '^[0-9a-f]{7,40}$'),
  url              text check (url is null or url ~ '^https://'),
  message          text check (message is null or length(message) <= 500),

  linked_by        uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (task_id, sha)
);

create index if not exists commit_links_project_idx on projects.commit_links (organization_id, project_id, created_at desc);

comment on table projects.commit_links is
  'SCR-042 — a commit a person linked to a task (sha, URL, first line). A link, never a mirror of the repository: what GitHub says about the commit is read on the page.';

drop trigger if exists set_updated_at on projects.commit_links;
create trigger set_updated_at before update on projects.commit_links
  for each row execute function core.set_updated_at();

alter table projects.commit_links enable row level security;
alter table projects.commit_links force row level security;

drop policy if exists commit_links_select on projects.commit_links;
create policy commit_links_select on projects.commit_links
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists commit_links_write on projects.commit_links;
create policy commit_links_write on projects.commit_links
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert, update, delete on projects.commit_links to authenticated, service_role;

drop trigger if exists org_match_commit_links_project on projects.commit_links;
create trigger org_match_commit_links_project
  before insert or update of project_id, organization_id on projects.commit_links
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_commit_links_task on projects.commit_links;
create trigger org_match_commit_links_task
  before insert or update of task_id, organization_id on projects.commit_links
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

drop trigger if exists freeze_org_commit_links on projects.commit_links;
create trigger freeze_org_commit_links
  before update of organization_id on projects.commit_links
  for each row execute function core.freeze_organization_id();

create or replace function projects.link_commit(
  p_task_id uuid,
  p_sha     text,
  p_url     text default null,
  p_message text default null
)
returns table (outcome text, link_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_task  projects.tasks;
  v_sha   text := lower(btrim(coalesce(p_sha, '')));
  v_id    uuid;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_sha !~ '^[0-9a-f]{7,40}$' then
    return query select 'bad_sha'::text, null::uuid; return;
  end if;
  select c.id into v_id from projects.commit_links c where c.task_id = p_task_id and c.sha = v_sha;
  if v_id is not null then
    return query select 'already_linked'::text, v_id; return;
  end if;

  insert into projects.commit_links (organization_id, project_id, task_id, sha, url, message, linked_by)
  values (v_task.organization_id, v_task.project_id, p_task_id, v_sha, nullif(btrim(coalesce(p_url, '')), ''), nullif(btrim(coalesce(p_message, '')), ''), v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_task.organization_id, 'git.commit_linked', 'task', p_task_id, null,
    jsonb_build_object('linkId', v_id, 'sha', v_sha, 'url', p_url, 'projectId', v_task.project_id)
  );
  return query select 'linked'::text, v_id;
end;
$$;

comment on function projects.link_commit(uuid, text, text, text) is
  'SCR-042 — links a commit to a task. Any task.write role; a repeat of the same sha answers already_linked; audited git.commit_linked.';

revoke all on function projects.link_commit(uuid, text, text, text) from public, anon;
grant execute on function projects.link_commit(uuid, text, text, text) to authenticated, service_role;

-- The record of each write the panel made to GitHub — Decision: reversed by
-- the owner on 2026-09-30. The write is done by src/lib/git/github-write.ts;
-- the row is written by projects.record_git_action from the service that
-- called it, in the same request, so the panel can list what it did.
create table if not exists projects.git_actions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid references projects.tasks(id) on delete set null,

  action           text not null check (action in ('branch_created', 'review_submitted', 'merged', 'build_triggered')),
  repository       text not null check (length(btrim(repository)) between 3 and 140),
  -- The branch name, the pull request number, or the workflow file.
  reference        text not null check (length(btrim(reference)) between 1 and 300),
  url              text check (url is null or url ~ '^https://'),
  detail           jsonb not null default '{}'::jsonb,

  actor_id         uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists git_actions_project_idx on projects.git_actions (organization_id, project_id, created_at desc);

comment on table projects.git_actions is
  'SCR-042/043 — every write the panel made to GitHub (Decision: reversed by the owner on 2026-09-30): a task branch created, a review submitted, a pull request merged, a build workflow dispatched. Written by projects.record_git_action after the GitHub call succeeded; audited git.branch_created | git.review_submitted | git.merged | git.build_triggered.';

drop trigger if exists set_updated_at on projects.git_actions;
create trigger set_updated_at before update on projects.git_actions
  for each row execute function core.set_updated_at();

alter table projects.git_actions enable row level security;
alter table projects.git_actions force row level security;

drop policy if exists git_actions_select on projects.git_actions;
create policy git_actions_select on projects.git_actions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- A branch is task work (can_write); a review, a merge and a build are
-- delivery management. The function below names the finer rule per action;
-- the policy admits the wider set so the function is the one that decides.
drop policy if exists git_actions_insert on projects.git_actions;
create policy git_actions_insert on projects.git_actions
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert on projects.git_actions to authenticated, service_role;

drop trigger if exists org_match_git_actions_project on projects.git_actions;
create trigger org_match_git_actions_project
  before insert or update of project_id, organization_id on projects.git_actions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_git_actions_task on projects.git_actions;
create trigger org_match_git_actions_task
  before insert or update of task_id, organization_id on projects.git_actions
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

drop trigger if exists freeze_org_git_actions on projects.git_actions;
create trigger freeze_org_git_actions
  before update of organization_id on projects.git_actions
  for each row execute function core.freeze_organization_id();

create or replace function projects.record_git_action(
  p_project_id uuid,
  p_action     text,
  p_repository text,
  p_reference  text,
  p_url        text default null,
  p_detail     jsonb default '{}'::jsonb,
  p_task_id    uuid default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_id    uuid;
begin
  if p_action not in ('branch_created', 'review_submitted', 'merged', 'build_triggered') then
    return query select 'bad_action'::text, null::uuid; return;
  end if;
  -- branch: task.write roles; review, merge, build: project.write roles.
  if p_action = 'branch_created' then
    if not coalesce((select core.can_write()), false) then
      return query select 'forbidden'::text, null::uuid; return;
    end if;
  elsif not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null or v_org is distinct from (select core.current_organization_id()) then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  insert into projects.git_actions (organization_id, project_id, task_id, action, repository, reference, url, detail, actor_id)
  values (v_org, p_project_id, p_task_id, p_action, btrim(p_repository), btrim(p_reference), p_url, coalesce(p_detail, '{}'::jsonb), v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'git.' || p_action, 'git_action', v_id, null,
    jsonb_build_object('projectId', p_project_id, 'taskId', p_task_id, 'repository', btrim(p_repository),
                       'reference', btrim(p_reference), 'url', p_url, 'detail', coalesce(p_detail, '{}'::jsonb))
  );
  return query select 'recorded'::text, v_id;
end;
$$;

comment on function projects.record_git_action(uuid, text, text, text, text, jsonb, uuid) is
  'SCR-042/043 — records one write the panel made to GitHub, after GitHub accepted it. branch_created by any task.write role; review_submitted, merged and build_triggered by owner, ops_admin or delivery_lead. Audited git.<action>.';

revoke all on function projects.record_git_action(uuid, text, text, text, text, jsonb, uuid) from public, anon;
grant execute on function projects.record_git_action(uuid, text, text, text, text, jsonb, uuid) to authenticated, service_role;

-- The workflow file a build trigger dispatches (GitHub Actions
-- workflow_dispatch). Null means "record only".
alter table projects.repository_links
  add column if not exists workflow_file text
    check (workflow_file is null or workflow_file ~ '^[A-Za-z0-9._-]{1,120}\.ya?ml$');

comment on column projects.repository_links.workflow_file is
  'SCR-043 — the GitHub Actions workflow file (under .github/workflows/) a build trigger dispatches. Null: a build trigger is recorded and nothing is dispatched.';

create or replace function projects.set_repository_workflow(p_project_id uuid, p_workflow_file text)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row  projects.repository_links;
  v_file text := nullif(btrim(coalesce(p_workflow_file, '')), '');
begin
  if coalesce((select core.current_user_role()), '') not in ('owner', 'ops_admin', 'delivery_lead') then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_row from projects.repository_links l where l.project_id = p_project_id for update;
  if v_row.id is null then
    return query select 'not_linked'::text; return;
  end if;
  if v_file is not null and v_file !~ '^[A-Za-z0-9._-]{1,120}\.ya?ml$' then
    return query select 'bad_file'::text; return;
  end if;
  if v_row.workflow_file is not distinct from v_file then
    return query select 'unchanged'::text; return;
  end if;
  update projects.repository_links set workflow_file = v_file where id = v_row.id;
  perform core.record_audit(
    v_row.organization_id, 'repository.workflow_set', 'repository_link', v_row.id,
    jsonb_build_object('workflowFile', v_row.workflow_file), jsonb_build_object('workflowFile', v_file, 'projectId', p_project_id)
  );
  return query select 'set'::text;
end;
$$;

comment on function projects.set_repository_workflow(uuid, text) is
  'SCR-043 — names (or clears) the workflow file a build trigger dispatches. Owner, ops_admin or delivery_lead; audited repository.workflow_set.';

revoke all on function projects.set_repository_workflow(uuid, text) from public, anon;
grant execute on function projects.set_repository_workflow(uuid, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. SCR-043 — environment readiness and promotion
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.environments
  add column if not exists readiness         jsonb not null default '{}'::jsonb,
  add column if not exists promoted_build_id uuid references projects.deliverables(id) on delete set null,
  add column if not exists promoted_at       timestamptz,
  add column if not exists promoted_by       uuid references core.users(id) on delete set null;

alter table projects.environments drop constraint if exists environments_readiness_is_object;
alter table projects.environments add constraint environments_readiness_is_object
  check (jsonb_typeof(readiness) = 'object');

comment on column projects.environments.readiness is
  'SCR-043 — {"api_contract": {"ok": true, "evidence_url": ..., "note": ..., "checked_at": ..., "checked_by": ...}, "migrations": {...}, "external_config": {...}}. Each key is one check a person recorded through projects.record_environment_check; a missing key is a check nobody has run.';
comment on column projects.environments.promoted_build_id is
  'SCR-043 — the build deliverable promoted to this environment through projects.promote_build, which refuses while a readiness check is missing or failed or a release gate is red.';

drop trigger if exists org_match_environments_build on projects.environments;
create trigger org_match_environments_build
  before insert or update of promoted_build_id, organization_id on projects.environments
  for each row execute function core.enforce_parent_org('promoted_build_id', 'projects.deliverables');

create or replace function projects.record_environment_check(
  p_environment_id uuid,
  p_check          text,
  p_ok             boolean,
  p_evidence_url   text default null,
  p_note           text default null
)
returns table (outcome text, readiness jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.environments;
  v_entry jsonb;
  v_after jsonb;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::jsonb; return;
  end if;
  if p_check not in ('api_contract', 'migrations', 'external_config') then
    return query select 'bad_check'::text, null::jsonb; return;
  end if;
  select * into v_row from projects.environments e where e.id = p_environment_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::jsonb; return;
  end if;
  if p_evidence_url is not null and btrim(p_evidence_url) <> '' and p_evidence_url !~ '^https://' then
    return query select 'bad_evidence'::text, null::jsonb; return;
  end if;

  v_entry := jsonb_build_object(
    'ok', p_ok,
    'evidence_url', nullif(btrim(coalesce(p_evidence_url, '')), ''),
    'note', nullif(btrim(coalesce(p_note, '')), ''),
    'checked_at', now(),
    'checked_by', v_actor
  );
  v_after := v_row.readiness || jsonb_build_object(p_check, v_entry);

  update projects.environments set readiness = v_after where id = p_environment_id;

  perform core.record_audit(
    v_row.organization_id, 'environment.check_recorded', 'environment', p_environment_id,
    jsonb_build_object('check', p_check, 'before', v_row.readiness -> p_check),
    jsonb_build_object('check', p_check, 'after', v_entry, 'projectId', v_row.project_id)
  );
  return query select 'recorded'::text, v_after;
end;
$$;

comment on function projects.record_environment_check(uuid, text, boolean, text, text) is
  'SCR-043 — a person records the result of one readiness check (api_contract, migrations, external_config) on an environment, with an evidence link. Owner, ops_admin or delivery_lead; audited environment.check_recorded.';

revoke all on function projects.record_environment_check(uuid, text, boolean, text, text) from public, anon;
grant execute on function projects.record_environment_check(uuid, text, boolean, text, text) to authenticated, service_role;

create or replace function projects.promote_build(p_environment_id uuid, p_deliverable_id uuid)
returns table (outcome text, detail text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_env     projects.environments;
  v_build   projects.deliverables;
  v_missing text[];
  v_failed  text[];
  v_red     text[];
  v_check   text;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::text; return;
  end if;
  select * into v_env from projects.environments e where e.id = p_environment_id for update;
  if v_env.id is null then
    return query select 'not_found'::text, null::text; return;
  end if;
  select * into v_build from projects.deliverables d where d.id = p_deliverable_id;
  if v_build.id is null or v_build.project_id is distinct from v_env.project_id or v_build.kind <> 'build' then
    return query select 'not_a_build'::text, null::text; return;
  end if;
  if v_build.status = 'superseded' then
    return query select 'superseded'::text, null::text; return;
  end if;

  -- The three readiness checks, each recorded and ok.
  foreach v_check in array array['api_contract', 'migrations', 'external_config'] loop
    if v_env.readiness -> v_check is null then
      v_missing := array_append(v_missing, v_check);
    elsif coalesce((v_env.readiness -> v_check ->> 'ok')::boolean, false) = false then
      v_failed := array_append(v_failed, v_check);
    end if;
  end loop;
  if coalesce(array_length(v_missing, 1), 0) > 0 or coalesce(array_length(v_failed, 1), 0) > 0 then
    return query select 'readiness_refused'::text,
      concat_ws('; ',
        case when coalesce(array_length(v_missing, 1), 0) > 0 then 'not checked: ' || array_to_string(v_missing, ', ') end,
        case when coalesce(array_length(v_failed, 1), 0) > 0 then 'failed: ' || array_to_string(v_failed, ', ') end);
    return;
  end if;

  -- The release gates: any 'fail' refuses; for production, 'undecided' does too.
  select array_agg(g.gate || ' ' || g.state order by g.gate) into v_red
    from qa.release_gates(v_env.project_id) g
   where g.state = 'fail' or (v_env.kind = 'production' and g.state = 'undecided');
  if coalesce(array_length(v_red, 1), 0) > 0 then
    return query select 'gates_refused'::text, array_to_string(v_red, ', '); return;
  end if;

  if v_env.promoted_build_id is not distinct from p_deliverable_id then
    return query select 'already_promoted'::text, null::text; return;
  end if;

  update projects.environments
     set promoted_build_id = p_deliverable_id, promoted_at = now(), promoted_by = v_actor
   where id = p_environment_id;

  perform core.record_audit(
    v_env.organization_id, 'environment.build_promoted', 'environment', p_environment_id,
    jsonb_build_object('promotedBuildId', v_env.promoted_build_id),
    jsonb_build_object('promotedBuildId', p_deliverable_id, 'buildVersion', v_build.version, 'kind', v_env.kind, 'projectId', v_env.project_id)
  );
  return query select 'promoted'::text, null::text;
end;
$$;

comment on function projects.promote_build(uuid, uuid) is
  'SCR-043 — promotes a build deliverable to an environment. Refuses readiness_refused while any of the three checks is missing or failed, and gates_refused while qa.release_gates() has a fail (or, for production, an undecided). Owner, ops_admin or delivery_lead; audited environment.build_promoted.';

revoke all on function projects.promote_build(uuid, uuid) from public, anon;
grant execute on function projects.promote_build(uuid, uuid) to authenticated, service_role;

-- PostgREST learns the new functions and columns.
notify pgrst, 'reload schema';
