-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 Prototype cluster (docs/phase-4-implementation-traceability.md, rows P4-PROTO-*; log: docs/phase-4-ui-prototype-gaps-log.md).
--
-- The prototype REUSES projects.deliverables (kind 'prototype') + projects.prototype_artifacts for the artifact and its client lifecycle, and that stays.
-- What it lacked is the record AROUND a build, which PROTO sections 10-17 call for and which was only prompt text or a JSON blob in qa_findings:
--
--   * projects.p4ui_prototype_builds - PrototypeBuild: the plan (platform, build mode, environment, routes, components, mock sources, interactions,
--     limitations, simulated integrations, exclusions) recorded BEFORE review, and the PLANNED..LOCKED state machine. A build is a row from the moment it is
--     planned, so a failed or blocked build is a FAILED/BLOCKED row, never silence and never a fake BUILD_READY. The states after QA (qa_pass, admin_approved,
--     client_review, locked, changes_requested) can only be entered when the artifact/deliverable rows really are in that state (trigger), so the Prototype
--     Agent cannot move its own build past a gate.
--   * projects.p4ui_route_coverage - PrototypeRouteCoverage: per screen covered / missing / extra placeholder / broken navigation target / missing states.
--   * projects.p4ui_test_data - PrototypeTestData: mock data, flagged mock, refused if it holds a secret-shaped value.
--   * projects.p4ui_artifact_records - ArtifactRecord: kind, storage ref, sha256, access policy, upload status. A native package (apk/ipa/desktop) is
--     environment_missing unless a PERSON attaches one with a storage ref and hash: an agent can never mark one uploaded.
--   * projects.p4ui_prototype_blockers - PrototypeBlocker: platform missing, credential missing (external), asset missing, production-logic request, scope change.
--   * projects.p4ui_prototype_revisions - PrototypeRevision (append-only): from/to build, origin (QA defect / Admin edit / client change), evidence, summary.
--   * projects.p4ui_prototype_feedback_routes - a client's prototype feedback is classified before a revision is built; a possible scope change stops at
--     scope_escalation instead of being implemented.
--   * projects.p4ui_qa_handoffs - the immutable QA handoff package (build, source UI, URL, platform/env, coverage, flows, limitations, test instructions).
--   * projects.p4ui_prototype_client_notice - the client-safe label ("simulated data, not production") and limitations.
--
-- Nothing here approves, verifies payment or submits for review: qa_pass comes from record_prototype_qa_verdict, admin approval from decide_prototype_admin,
-- the client decision from the approvals engine. This file only RECORDS and REFLECTS them.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.prototype_build_blocked',
   'PROTO section 17 PrototypeBlocker. A prototype build stopped on a named blocker (platform or credential missing, asset missing, production-logic request, scope change) with an owner and a resume condition. No build exists until a person resolves it.',
   true)
on conflict (type) do nothing;

create table if not exists projects.p4ui_prototype_builds (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references core.organizations(id) on delete cascade,
  project_id              uuid not null references projects.projects(id) on delete cascade,
  phase_four_id           uuid not null references projects.phase_four(id) on delete cascade,
  ui_version_id           uuid not null references projects.ui_versions(id) on delete restrict,
  build_number            int not null check (build_number > 0),
  revision_of_build_id    uuid references projects.p4ui_prototype_builds(id) on delete restrict,
  prototype_artifact_id   uuid references projects.prototype_artifacts(id) on delete restrict,
  status                  text not null default 'planned' check (status in ('planned', 'input_validation', 'blocked', 'building', 'build_ready', 'failed', 'qa_review',
                            'qa_changes_required', 'qa_pass', 'admin_approved', 'client_review', 'changes_requested', 'locked', 'superseded')),
  platform                text check (platform is null or platform in ('web', 'ios', 'android', 'desktop', 'cross_platform')),
  build_mode              text not null default 'in_app_preview' check (build_mode in ('in_app_preview', 'hosted_web', 'native_package')),
  environment             text not null default 'review' check (environment in ('review', 'staging', 'client_test', 'local')),
  mock_policy             text not null default 'static_mock' check (mock_policy in ('static_mock', 'seeded_mock', 'none')),
  -- the plan, recorded before review (PROTO 10.2)
  routes                  jsonb not null default '[]'::jsonb check (jsonb_typeof(routes) = 'array'),
  components              text[] not null default '{}',
  mock_sources            text[] not null default '{}',
  interactions            jsonb not null default '[]'::jsonb check (jsonb_typeof(interactions) = 'array'),
  critical_flows          jsonb not null default '[]'::jsonb check (jsonb_typeof(critical_flows) = 'array'),
  exclusions              text[] not null default '{}',
  required_assets         jsonb not null default '[]'::jsonb check (jsonb_typeof(required_assets) = 'array'),
  limitations             text[] not null default '{}',
  simulated_integrations  text[] not null default '{}',
  test_instructions       text check (test_instructions is null or length(btrim(test_instructions)) between 1 and 2000),
  design_source_state     text not null default 'stored_screens' check (design_source_state in ('stored_screens', 'figma_unavailable')),
  figma_file_ref          text,
  figma_node_refs         jsonb not null default '{}'::jsonb check (jsonb_typeof(figma_node_refs) = 'object'),
  self_check              jsonb,
  failure_reason          text check (failure_reason is null or length(btrim(failure_reason)) between 1 and 1000),
  build_log               jsonb not null default '[]'::jsonb check (jsonb_typeof(build_log) = 'array'),
  planned_by              uuid references core.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint p4ui_builds_number_unique unique (ui_version_id, build_number),
  constraint p4ui_builds_failed_says_why check (status <> 'failed' or failure_reason is not null),
  constraint p4ui_builds_ready_has_an_artifact check (status not in ('build_ready', 'qa_review', 'qa_pass', 'qa_changes_required', 'admin_approved', 'client_review', 'changes_requested', 'locked')
                                                      or prototype_artifact_id is not null)
);
comment on table projects.p4ui_prototype_builds is
  'PROTO 10.2/10.6/11/12 PrototypeBuild: the plan recorded before review and the PLANNED..LOCKED state machine. A failed or blocked build is a row with a reason, never a fake BUILD_READY. Post-QA states are entered only when the artifact/deliverable rows are really there (trigger).';
create unique index if not exists p4ui_builds_one_active_per_ui_version on projects.p4ui_prototype_builds (ui_version_id)
  where status not in ('failed', 'superseded', 'qa_changes_required', 'changes_requested');
create index if not exists p4ui_builds_project_idx on projects.p4ui_prototype_builds (organization_id, project_id, created_at desc);

create table if not exists projects.p4ui_route_coverage (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  build_id         uuid not null references projects.p4ui_prototype_builds(id) on delete cascade,
  screen_key       text not null check (screen_key ~ '^[a-z][a-z0-9_.-]{1,62}$'),
  coverage         text not null check (coverage in ('covered', 'missing', 'extra_placeholder', 'broken_target', 'states_missing', 'no_controls')),
  detail           text,
  states_expected  text[] not null default '{}',
  states_present   text[] not null default '{}',
  computed_at      timestamptz not null default now(),
  constraint p4ui_route_coverage_one unique (build_id, screen_key)
);
comment on table projects.p4ui_route_coverage is 'PROTO 12 PrototypeRouteCoverage: per screen of the exact build, computed by projects.p4ui_compute_route_coverage from the locked UI version and the artifact (never typed in).';

create table if not exists projects.p4ui_test_data (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  build_id         uuid not null references projects.p4ui_prototype_builds(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 120),
  purpose          text check (purpose is null or length(btrim(purpose)) between 1 and 300),
  payload          jsonb not null check (jsonb_typeof(payload) in ('object', 'array')),
  edge_case        boolean not null default false,
  is_mock          boolean not null default true check (is_mock),
  created_at       timestamptz not null default now(),
  constraint p4ui_test_data_no_secret check (payload::text !~* '(sk_live_[0-9a-z]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.|(password|passwd|secret|api[_-]?key)"?\s*[:=]\s*"?[^"\s,}]{8,})'),
  constraint p4ui_test_data_unique_name unique (build_id, name)
);
comment on table projects.p4ui_test_data is 'PROTO 7/12 PrototypeTestData: mock data kept apart from production data (is_mock is a constant true), edge cases flagged, refused if it holds a secret-shaped value.';

create table if not exists projects.p4ui_artifact_records (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  build_id         uuid not null references projects.p4ui_prototype_builds(id) on delete cascade,
  kind             text not null check (kind in ('preview_route', 'hosted_url', 'android_apk', 'ios_package', 'desktop_package', 'evidence', 'log')),
  storage_ref      text check (storage_ref is null or length(btrim(storage_ref)) between 1 and 500),
  sha256           text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  access_policy    text not null default 'internal' check (access_policy in ('internal', 'client_after_approval')),
  upload_status    text not null default 'pending' check (upload_status in ('pending', 'uploaded', 'failed', 'environment_missing')),
  failure_reason   text check (failure_reason is null or length(btrim(failure_reason)) between 1 and 500),
  recorded_by      uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  -- an uploaded artifact has somewhere to live; a native package also has a hash. Nothing else can say "uploaded".
  constraint p4ui_artifact_uploaded_has_a_home check (upload_status <> 'uploaded' or storage_ref is not null),
  constraint p4ui_artifact_native_needs_hash check (kind not in ('android_apk', 'ios_package', 'desktop_package') or upload_status <> 'uploaded' or sha256 is not null),
  constraint p4ui_artifact_failed_says_why check (upload_status not in ('failed', 'environment_missing') or failure_reason is not null),
  constraint p4ui_artifact_one_per_kind unique (build_id, kind, storage_ref)
);
comment on table projects.p4ui_artifact_records is 'PROTO 12/14 ArtifactRecord. A native package is environment_missing unless a person attaches it with a storage ref and sha256; an upload failure is a row, and the build is not share-eligible.';

create table if not exists projects.p4ui_prototype_blockers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  phase_four_id     uuid not null references projects.phase_four(id) on delete cascade,
  build_id          uuid references projects.p4ui_prototype_builds(id) on delete cascade,
  ui_version_id     uuid not null references projects.ui_versions(id) on delete restrict,
  kind              text not null check (kind in ('platform_missing', 'credential_missing', 'tooling_missing', 'asset_missing', 'production_logic_request', 'design_source_unavailable',
                                                  'build_failure', 'scope_change')),
  external          boolean not null default false,
  owner_role        text not null check (owner_role in ('pm', 'admin', 'prototype_agent', 'designer', 'client', 'owner')),
  reason            text not null check (length(btrim(reason)) between 1 and 500),
  resume_condition  text not null check (length(btrim(resume_condition)) between 1 and 500),
  affected_screens  text[] not null default '{}',
  status            text not null default 'open' check (status in ('open', 'resolved', 'cancelled')),
  resolved_by       uuid references core.users(id) on delete set null,
  resolved_at       timestamptz,
  resolution_note   text check (resolution_note is null or length(btrim(resolution_note)) between 1 and 500),
  created_at        timestamptz not null default now(),
  constraint p4ui_proto_blockers_resolved_shape check ((status = 'open') = (resolved_at is null))
);
comment on table projects.p4ui_prototype_blockers is 'PROTO 12/17/22 PrototypeBlocker: a named stop with an owner and a resume condition; external=true marks one only an owner-held credential or account can clear (APK/iOS signing, hosting). Resolved only by a person.';
create index if not exists p4ui_proto_blockers_build_idx on projects.p4ui_prototype_blockers (build_id, status);

create table if not exists projects.p4ui_prototype_revisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  from_build_id    uuid not null references projects.p4ui_prototype_builds(id) on delete restrict,
  to_build_id      uuid not null unique references projects.p4ui_prototype_builds(id) on delete restrict,
  origin           text not null check (origin in ('qa_defect', 'admin_edit', 'client_change')),
  evidence         jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  summary          text not null check (length(btrim(summary)) between 1 and 2000),
  created_at       timestamptz not null default now()
);
comment on table projects.p4ui_prototype_revisions is 'PROTO 12/13 PrototypeRevision: from/to build, origin (QA / Admin / client), the evidence, a summary. Append-only.';

create table if not exists projects.p4ui_prototype_feedback_routes (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  deliverable_id    uuid not null unique references projects.deliverables(id) on delete cascade,
  classification    text not null check (classification in ('CORRECTION', 'INCLUDED_REVISION', 'CLARIFICATION', 'POSSIBLE_SCOPE_CHANGE', 'DESIGN_DIRECTION_CHANGE', 'REJECTED_REQUEST')),
  route             text not null check (route in ('prototype_revision', 'clarification', 'change_request', 'escalation', 'none')),
  reasoning         text not null check (length(btrim(reasoning)) between 1 and 500),
  classified_by     uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint p4ui_proto_routes_class_route check (
    (classification in ('CORRECTION', 'INCLUDED_REVISION') and route = 'prototype_revision')
    or (classification = 'CLARIFICATION' and route = 'clarification')
    or (classification = 'POSSIBLE_SCOPE_CHANGE' and route = 'change_request')
    or (classification = 'DESIGN_DIRECTION_CHANGE' and route = 'escalation')
    or (classification = 'REJECTED_REQUEST' and route = 'none'))
);
comment on table projects.p4ui_prototype_feedback_routes is 'PROTO 10.10/T022-T023: where a client''s prototype feedback goes once classified. Only a correction or an included revision may be built; a new feature is not implemented in the prototype.';

create table if not exists projects.p4ui_qa_handoffs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  build_id         uuid not null unique references projects.p4ui_prototype_builds(id) on delete cascade,
  package          jsonb not null check (jsonb_typeof(package) = 'object'),
  assembled_by     uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
comment on table projects.p4ui_qa_handoffs is 'PROTO 10.7/14: the QA handoff package, assembled from the stored rows of the exact build and immutable once written.';

-- tenancy guards + RLS
do $$
declare
  g record;
  t text;
begin
  for g in
    select * from (values
      ('p4ui_prototype_builds', 'project_id', 'projects.projects'),
      ('p4ui_prototype_builds', 'phase_four_id', 'projects.phase_four'),
      ('p4ui_prototype_builds', 'ui_version_id', 'projects.ui_versions'),
      ('p4ui_prototype_builds', 'revision_of_build_id', 'projects.p4ui_prototype_builds'),
      ('p4ui_prototype_builds', 'prototype_artifact_id', 'projects.prototype_artifacts'),
      ('p4ui_route_coverage', 'project_id', 'projects.projects'),
      ('p4ui_route_coverage', 'build_id', 'projects.p4ui_prototype_builds'),
      ('p4ui_test_data', 'project_id', 'projects.projects'),
      ('p4ui_test_data', 'build_id', 'projects.p4ui_prototype_builds'),
      ('p4ui_artifact_records', 'project_id', 'projects.projects'),
      ('p4ui_artifact_records', 'build_id', 'projects.p4ui_prototype_builds'),
      ('p4ui_prototype_blockers', 'project_id', 'projects.projects'),
      ('p4ui_prototype_blockers', 'phase_four_id', 'projects.phase_four'),
      ('p4ui_prototype_blockers', 'build_id', 'projects.p4ui_prototype_builds'),
      ('p4ui_prototype_blockers', 'ui_version_id', 'projects.ui_versions'),
      ('p4ui_prototype_revisions', 'project_id', 'projects.projects'),
      ('p4ui_prototype_revisions', 'from_build_id', 'projects.p4ui_prototype_builds'),
      ('p4ui_prototype_revisions', 'to_build_id', 'projects.p4ui_prototype_builds'),
      ('p4ui_prototype_feedback_routes', 'project_id', 'projects.projects'),
      ('p4ui_prototype_feedback_routes', 'deliverable_id', 'projects.deliverables'),
      ('p4ui_qa_handoffs', 'project_id', 'projects.projects'),
      ('p4ui_qa_handoffs', 'build_id', 'projects.p4ui_prototype_builds')
    ) as x(tbl, col, parent)
  loop
    execute format(
      'create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)',
      left(g.tbl || '_po_' || g.col, 63), g.col, g.tbl, g.col, g.parent);
  end loop;

  foreach t in array array['p4ui_prototype_builds', 'p4ui_route_coverage', 'p4ui_test_data', 'p4ui_artifact_records', 'p4ui_prototype_blockers',
                           'p4ui_prototype_revisions', 'p4ui_prototype_feedback_routes', 'p4ui_qa_handoffs']
  loop
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || t, t);
    execute format('alter table projects.%I enable row level security', t);
    execute format('alter table projects.%I force row level security', t);
    execute format('create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))', t || '_select', t);
    execute format('grant select on projects.%I to authenticated, service_role', t);
  end loop;
end $$;

create trigger p4ui_prototype_builds_updated_at before update on projects.p4ui_prototype_builds for each row execute function core.set_updated_at();
create trigger p4ui_prototype_revisions_append_only before update or delete on projects.p4ui_prototype_revisions for each row execute function projects.p4ui_refuse_change();
create trigger p4ui_qa_handoffs_immutable before update or delete on projects.p4ui_qa_handoffs for each row execute function projects.p4ui_refuse_change();

-- ── the state machine: legal edges, and the post-QA states need the real rows behind them ─────
create or replace function projects.p4ui_enforce_build_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ok     boolean;
  v_art    projects.prototype_artifacts;
  v_del    projects.deliverables;
  v_admin  text;
begin
  if new.status is not distinct from old.status then return new; end if;
  v_ok := case old.status
    when 'planned' then new.status in ('input_validation', 'blocked', 'failed')
    when 'input_validation' then new.status in ('building', 'blocked', 'failed')
    when 'blocked' then new.status in ('input_validation', 'failed')
    when 'building' then new.status in ('build_ready', 'failed', 'blocked')
    when 'build_ready' then new.status in ('qa_review', 'superseded')
    when 'qa_review' then new.status in ('qa_pass', 'qa_changes_required')
    when 'qa_pass' then new.status in ('admin_approved', 'changes_requested', 'superseded', 'qa_changes_required')
    when 'admin_approved' then new.status in ('client_review', 'changes_requested', 'superseded')
    when 'client_review' then new.status in ('locked', 'changes_requested', 'superseded')
    when 'qa_changes_required' then new.status in ('superseded')
    when 'changes_requested' then new.status in ('superseded')
    else false end;
  if not v_ok then
    raise exception 'a prototype build cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;

  if new.status in ('qa_pass', 'qa_changes_required', 'admin_approved', 'client_review', 'changes_requested', 'locked') then
    select a.* into v_art from projects.prototype_artifacts a where a.id = new.prototype_artifact_id;
    select d.* into v_del from projects.deliverables d where d.id = v_art.deliverable_id;
    select dd.admin_status into v_admin from projects.deliverable_details dd where dd.deliverable_id = v_art.deliverable_id;
    if new.status = 'qa_pass' and v_art.status is distinct from 'qa_pass' then
      raise exception 'a build is qa_pass only when Prototype QA recorded a pass on its artifact' using errcode = 'check_violation';
    elsif new.status = 'qa_changes_required' and v_art.status is distinct from 'qa_changes_required' then
      raise exception 'a build is qa_changes_required only when Prototype QA recorded it on its artifact' using errcode = 'check_violation';
    elsif new.status = 'admin_approved' and v_admin is distinct from 'approved' then
      raise exception 'a build is admin_approved only when an Admin approved its deliverable' using errcode = 'check_violation';
    elsif new.status = 'client_review' and v_del.status is distinct from 'in_review' then
      raise exception 'a build is in client_review only when its deliverable was submitted' using errcode = 'check_violation';
    elsif new.status = 'locked' and v_del.status is distinct from 'approved' then
      raise exception 'a build is locked only when its deliverable was approved' using errcode = 'check_violation';
    elsif new.status = 'changes_requested' and v_del.status is distinct from 'changes_requested' and v_admin is distinct from 'changes_required' then
      raise exception 'a build is changes_requested only when a reviewer asked for changes' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger p4ui_prototype_builds_transition before update of status on projects.p4ui_prototype_builds
  for each row execute function projects.p4ui_enforce_build_transition();

-- ═══ blockers ═════════════════════════════════════════════════════════════
create or replace function projects.p4ui_open_prototype_blocker(
  p_ui_version_id uuid, p_kind text, p_owner_role text, p_reason text, p_resume_condition text,
  p_build_id uuid default null, p_external boolean default false, p_affected_screens text[] default '{}')
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v     projects.ui_versions;
  v_b     projects.p4ui_prototype_builds;
  v_scope text;
  v_open  uuid;
  v_new   uuid;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('platform_missing', 'credential_missing', 'tooling_missing', 'asset_missing', 'production_logic_request', 'design_source_unavailable', 'build_failure', 'scope_change') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if p_owner_role is null or p_owner_role not in ('pm', 'admin', 'prototype_agent', 'designer', 'client', 'owner') then return query select 'bad_owner'::text, null::uuid; return; end if;
  if coalesce(length(btrim(p_reason)), 0) = 0 or coalesce(length(btrim(p_resume_condition)), 0) = 0 then return query select 'needs_reason_and_resume_condition'::text, null::uuid; return; end if;
  if p_build_id is not null then
    select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id and b.ui_version_id = v_v.id;
    if v_b.id is null then return query select 'wrong_build'::text, null::uuid; return; end if;
  end if;
  select k.id into v_open from projects.p4ui_prototype_blockers k
   where k.ui_version_id = v_v.id and k.kind = p_kind and k.status = 'open' and k.build_id is not distinct from p_build_id and k.reason = left(btrim(p_reason), 500);
  if v_open is not null then return query select 'exists'::text, v_open; return; end if;
  insert into projects.p4ui_prototype_blockers (organization_id, project_id, phase_four_id, build_id, ui_version_id, kind, external, owner_role, reason, resume_condition, affected_screens)
  values (v_v.organization_id, v_v.project_id, v_v.phase_four_id, p_build_id, v_v.id, p_kind, coalesce(p_external, false), p_owner_role, left(btrim(p_reason), 500),
          left(btrim(p_resume_condition), 500), coalesce(p_affected_screens, '{}')) returning id into v_new;
  perform core.record_audit(v_v.organization_id, 'prototype.blocker_opened', 'p4ui_prototype_blocker', v_new, null,
    jsonb_build_object('projectId', v_v.project_id, 'kind', p_kind, 'external', coalesce(p_external, false), 'buildId', p_build_id));
  perform core.emit_event(v_v.organization_id, 'project.prototype_build_blocked', 'p4ui_prototype_blocker', v_new,
    jsonb_build_object('projectId', v_v.project_id, 'kind', p_kind, 'owner', p_owner_role));
  return query select 'opened'::text, v_new;
end $$;
revoke all on function projects.p4ui_open_prototype_blocker(uuid, text, text, text, text, uuid, boolean, text[]) from public, anon;
grant execute on function projects.p4ui_open_prototype_blocker(uuid, text, text, text, text, uuid, boolean, text[]) to authenticated, service_role;

create or replace function projects.p4ui_resolve_prototype_blocker(p_blocker_id uuid, p_note text)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_k     projects.p4ui_prototype_blockers;
  v_scope text;
begin
  select k.* into v_k from projects.p4ui_prototype_blockers k where k.id = p_blocker_id for update;
  if v_k.id is null then return query select 'unknown_blocker'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_k.organization_id);
  if v_scope not in ('person', 'admin') then return query select case when v_scope = 'service' then 'person_required' else v_scope end, null::uuid; return; end if;
  -- a credential or account only the owner holds is cleared by the owner/Admin, not by any member
  if v_k.external and v_scope <> 'admin' then return query select 'admin_required'::text, null::uuid; return; end if;
  if v_k.status <> 'open' then return query select 'already_resolved'::text, v_k.id; return; end if;
  if coalesce(length(btrim(p_note)), 0) = 0 then return query select 'needs_note'::text, null::uuid; return; end if;
  update projects.p4ui_prototype_blockers set status = 'resolved', resolved_by = (select auth.uid()), resolved_at = now(), resolution_note = left(btrim(p_note), 500) where id = v_k.id;
  -- a build that stopped at 'blocked' goes back to input validation once nothing else holds it
  if v_k.build_id is not null and not exists (select 1 from projects.p4ui_prototype_blockers o where o.build_id = v_k.build_id and o.status = 'open' and o.id <> v_k.id) then
    update projects.p4ui_prototype_builds set status = 'input_validation' where id = v_k.build_id and status = 'blocked';
  end if;
  -- a resolved scope question lets the Prototype stage continue where it stopped
  if v_k.kind = 'scope_change' and not exists (select 1 from projects.p4ui_prototype_blockers o where o.phase_four_id = v_k.phase_four_id and o.kind = 'scope_change' and o.status = 'open' and o.id <> v_k.id) then
    update projects.phase_four set state = 'prototype_build', blocked_reason = null where id = v_k.phase_four_id and state = 'scope_escalation';
  end if;
  perform core.record_audit(v_k.organization_id, 'prototype.blocker_resolved', 'p4ui_prototype_blocker', v_k.id, null, jsonb_build_object('projectId', v_k.project_id, 'kind', v_k.kind));
  return query select 'resolved'::text, v_k.id;
end $$;
revoke all on function projects.p4ui_resolve_prototype_blocker(uuid, text) from public, anon;
grant execute on function projects.p4ui_resolve_prototype_blocker(uuid, text) to authenticated, service_role;

-- ═══ the plan ═════════════════════════════════════════════════════════════
create or replace function projects.p4ui_plan_prototype_build(p_ui_version_id uuid, p_platform text, p_build_mode text, p_environment text, p_plan jsonb)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v      projects.ui_versions;
  v_scope  text;
  v_prev   projects.p4ui_prototype_builds;
  v_active projects.p4ui_prototype_builds;
  v_n      int;
  v_new    uuid;
  v_meta   projects.p4ui_version_meta;
  v_plan   jsonb := coalesce(p_plan, '{}'::jsonb);
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id for update;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  -- PROTO T002-T004: draft, QA-failed and Admin-approved-but-not-client-approved UI are all refused, by name
  if v_v.status <> 'locked' then return query select 'ui_not_locked'::text, null::uuid, v_v.status; return; end if;
  if jsonb_typeof(v_plan) <> 'object' then return query select 'bad_plan'::text, null::uuid, null::text; return; end if;
  if p_build_mode is null or p_build_mode not in ('in_app_preview', 'hosted_web', 'native_package') then return query select 'bad_build_mode'::text, null::uuid, null::text; return; end if;
  if p_environment is null or p_environment not in ('review', 'staging', 'client_test', 'local') then return query select 'bad_environment'::text, null::uuid, null::text; return; end if;
  if p_platform is not null and p_platform not in ('web', 'ios', 'android', 'desktop', 'cross_platform') then return query select 'bad_platform'::text, null::uuid, null::text; return; end if;

  select b.* into v_active from projects.p4ui_prototype_builds b
   where b.ui_version_id = v_v.id and b.status not in ('failed', 'superseded', 'qa_changes_required', 'changes_requested') order by b.build_number desc limit 1;
  if v_active.id is not null then return query select 'exists'::text, v_active.id, v_active.status; return; end if;

  select b.* into v_prev from projects.p4ui_prototype_builds b where b.ui_version_id = v_v.id order by b.build_number desc limit 1;
  v_n := coalesce(v_prev.build_number, 0) + 1;
  -- the build before this one, if it was sent back, is superseded by this round
  if v_prev.id is not null and v_prev.status in ('qa_changes_required', 'changes_requested') then
    update projects.p4ui_prototype_builds set status = 'superseded' where id = v_prev.id;
  end if;

  select m.* into v_meta from projects.p4ui_version_meta m where m.ui_version_id = v_v.id;

  begin
    insert into projects.p4ui_prototype_builds (organization_id, project_id, phase_four_id, ui_version_id, build_number, revision_of_build_id, platform, build_mode, environment,
        mock_policy, routes, components, mock_sources, interactions, critical_flows, exclusions, required_assets, limitations, simulated_integrations, test_instructions,
        design_source_state, figma_file_ref, figma_node_refs, planned_by)
    values (v_v.organization_id, v_v.project_id, v_v.phase_four_id, v_v.id, v_n, v_prev.id, p_platform, p_build_mode, p_environment,
        coalesce(v_plan ->> 'mockPolicy', 'static_mock'),
        coalesce(v_plan -> 'routes', '[]'::jsonb),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_plan -> 'components', '[]'::jsonb))), '{}'),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_plan -> 'mockSources', '[]'::jsonb))), '{}'),
        coalesce(v_plan -> 'interactions', '[]'::jsonb),
        coalesce(v_plan -> 'criticalFlows', '[]'::jsonb),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_plan -> 'exclusions', '[]'::jsonb))), '{}'),
        coalesce(v_plan -> 'requiredAssets', '[]'::jsonb),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_plan -> 'limitations', '[]'::jsonb))), '{}'),
        coalesce(array(select jsonb_array_elements_text(coalesce(v_plan -> 'simulatedIntegrations', '[]'::jsonb))), '{}'),
        nullif(left(btrim(coalesce(v_plan ->> 'testInstructions', '')), 2000), ''),
        case when v_meta.figma_state = 'unavailable' then 'figma_unavailable' else 'stored_screens' end,
        v_meta.figma_file_ref, coalesce(v_meta.figma_node_refs, '{}'::jsonb), (select auth.uid()))
    returning id into v_new;
  exception when check_violation or invalid_text_representation then
    return query select 'bad_plan'::text, null::uuid, null::text; return;
  end;

  perform core.record_audit(v_v.organization_id, 'prototype.build_planned', 'p4ui_prototype_build', v_new, null,
    jsonb_build_object('projectId', v_v.project_id, 'uiVersionId', v_v.id, 'buildNumber', v_n, 'platform', p_platform, 'buildMode', p_build_mode));
  return query select 'planned'::text, v_new, v_n::text;
end $$;
revoke all on function projects.p4ui_plan_prototype_build(uuid, text, text, text, jsonb) from public, anon;
grant execute on function projects.p4ui_plan_prototype_build(uuid, text, text, text, jsonb) to authenticated, service_role;

-- ── input validation: locked UI, screens, platform, assets, blockers; nothing is inferred ─────
create or replace function projects.p4ui_validate_build_inputs(p_build_id uuid)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b      projects.p4ui_prototype_builds;
  v_v      projects.ui_versions;
  v_scope  text;
  v_asset  record;
  v_missing int := 0;
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id for update;
  if v_b.id is null then return query select 'unknown_build'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  if v_b.status not in ('planned', 'input_validation') then return query select 'not_validatable'::text, v_b.id, v_b.status; return; end if;
  select u.* into v_v from projects.ui_versions u where u.id = v_b.ui_version_id;
  if v_b.status = 'planned' then update projects.p4ui_prototype_builds set status = 'input_validation' where id = v_b.id; end if;

  if v_v.status <> 'locked' or jsonb_array_length(v_v.screens) = 0 then
    update projects.p4ui_prototype_builds set status = 'failed', failure_reason = 'the source UI version is not locked or names no screens' where id = v_b.id;
    return query select 'failed'::text, v_b.id, 'source UI not locked'; return;
  end if;
  if v_b.platform is null then
    perform projects.p4ui_open_prototype_blocker(v_v.id, 'platform_missing', 'pm', 'No target platform was named for this prototype.', 'The PM or Admin names the platform and a person resolves this blocker', v_b.id);
  end if;
  if v_b.build_mode = 'native_package' then
    perform projects.p4ui_open_prototype_blocker(v_v.id, 'credential_missing', 'owner',
      'A native package needs signing and distribution accounts (Apple / Google) that this environment does not have.',
      'The owner provides the accounts and credentials, or the build stays an in-app preview', v_b.id, true);
  end if;
  -- assets: each required asset must exist for this project, or the plan must say an approved placeholder stands in
  for v_asset in select a.value as body from jsonb_array_elements(v_b.required_assets) a(value) loop
    if not coalesce((v_asset.body ->> 'placeholderApproved')::boolean, false)
       and not exists (select 1 from projects.design_assets d where d.id::text = v_asset.body ->> 'assetId' and d.project_id = v_b.project_id) then
      v_missing := v_missing + 1;
      perform projects.p4ui_open_prototype_blocker(v_v.id, 'asset_missing', 'designer',
        'Required asset "' || coalesce(v_asset.body ->> 'name', 'unnamed') || '" is not available and no approved placeholder is named.',
        'The asset is supplied, or an approved placeholder is named in a new plan', v_b.id, false,
        coalesce(array(select jsonb_array_elements_text(coalesce(v_asset.body -> 'screens', '[]'::jsonb))), '{}'));
    end if;
  end loop;
  if v_b.design_source_state = 'figma_unavailable' then
    perform projects.p4ui_open_prototype_blocker(v_v.id, 'design_source_unavailable', 'admin',
      'The Figma source is unavailable; the build would rely on stored screens only.', 'A person confirms the stored screens are sufficient, or links Figma', v_b.id);
  end if;

  if exists (select 1 from projects.p4ui_prototype_blockers k where k.build_id = v_b.id and k.status = 'open') then
    update projects.p4ui_prototype_builds set status = 'blocked' where id = v_b.id;
    return query select 'blocked'::text, v_b.id, (select string_agg(k.kind, ',' order by k.kind) from projects.p4ui_prototype_blockers k where k.build_id = v_b.id and k.status = 'open'); return;
  end if;
  update projects.p4ui_prototype_builds set status = 'building' where id = v_b.id;
  return query select 'ready'::text, v_b.id, null::text;
end $$;
revoke all on function projects.p4ui_validate_build_inputs(uuid) from public, anon;
grant execute on function projects.p4ui_validate_build_inputs(uuid) to authenticated, service_role;

-- ── route coverage: computed from the locked UI and the artifact, stored for the Admin view ─────
create or replace function projects.p4ui_compute_route_coverage(p_build_id uuid)
returns table (outcome text, ref_id uuid, detail text)
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
  v_keys   text[];
  r        record;
  v_bad    int := 0;
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id for update;
  if v_b.id is null then return query select 'unknown_build'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  if v_b.prototype_artifact_id is null then return query select 'no_artifact'::text, v_b.id, null::text; return; end if;
  if v_b.status not in ('building', 'build_ready') then return query select 'coverage_is_final'::text, v_b.id, v_b.status; return; end if;
  select a.* into v_a from projects.prototype_artifacts a where a.id = v_b.prototype_artifact_id;
  select u.* into v_v from projects.ui_versions u where u.id = v_b.ui_version_id;
  select coalesce(array_agg(e.value ->> 'screenKey'), '{}') into v_keys from jsonb_array_elements(v_a.screens) e(value);

  delete from projects.p4ui_route_coverage where build_id = v_b.id;
  for r in
    select d.value as scr from jsonb_array_elements(v_v.screens) d(value)
  loop
    if not ((r.scr ->> 'screenKey') = any (v_keys)) then
      insert into projects.p4ui_route_coverage (organization_id, project_id, build_id, screen_key, coverage, detail, states_expected)
      values (v_b.organization_id, v_b.project_id, v_b.id, r.scr ->> 'screenKey', 'missing', 'the locked UI designs this screen; the build does not contain it',
              coalesce(array(select jsonb_array_elements_text(coalesce(r.scr -> 'statesAddressed', '[]'::jsonb))), '{}'));
      v_bad := v_bad + 1;
    end if;
  end loop;
  for r in
    select e.value as scr from jsonb_array_elements(v_a.screens) e(value)
  loop
    if not exists (select 1 from jsonb_array_elements(v_v.screens) d(value) where d.value ->> 'screenKey' = r.scr ->> 'screenKey') then
      insert into projects.p4ui_route_coverage (organization_id, project_id, build_id, screen_key, coverage, detail)
      values (v_b.organization_id, v_b.project_id, v_b.id, r.scr ->> 'screenKey', 'extra_placeholder', 'the build contains a screen the approved UI does not have')
      on conflict (build_id, screen_key) do nothing;
      v_bad := v_bad + 1;
    else
      declare
        v_target text;
        v_broken text[] := '{}';
        v_expected text[];
      begin
        select coalesce(array_agg(distinct x ->> 'navigatesTo'), '{}') into v_broken
          from jsonb_array_elements(r.scr -> 'elements') x
         where x ->> 'navigatesTo' is not null and not ((x ->> 'navigatesTo') = any (v_keys));
        select coalesce(array(select jsonb_array_elements_text(coalesce(d.value -> 'statesAddressed', '[]'::jsonb))), '{}') into v_expected
          from jsonb_array_elements(v_v.screens) d(value) where d.value ->> 'screenKey' = r.scr ->> 'screenKey';
        if cardinality(v_broken) > 0 then
          insert into projects.p4ui_route_coverage (organization_id, project_id, build_id, screen_key, coverage, detail, states_expected)
          values (v_b.organization_id, v_b.project_id, v_b.id, r.scr ->> 'screenKey', 'broken_target', 'navigation to ' || array_to_string(v_broken, ', ') || ' resolves to no screen in this build', v_expected);
          v_bad := v_bad + 1;
        elsif not exists (select 1 from jsonb_array_elements(r.scr -> 'elements') x where x ->> 'type' in ('button', 'link', 'input')) and
              exists (select 1 from jsonb_array_elements(v_v.screens) d(value) where d.value ->> 'screenKey' = r.scr ->> 'screenKey' and (d.value -> 'keyComponents') is not null and jsonb_array_length(d.value -> 'keyComponents') > 0) and
              jsonb_array_length(v_a.screens) > 1 then
          insert into projects.p4ui_route_coverage (organization_id, project_id, build_id, screen_key, coverage, detail, states_expected)
          values (v_b.organization_id, v_b.project_id, v_b.id, r.scr ->> 'screenKey', 'no_controls', 'the screen has no interactive control: a decorative screen demonstrates nothing', v_expected);
          v_bad := v_bad + 1;
        else
          insert into projects.p4ui_route_coverage (organization_id, project_id, build_id, screen_key, coverage, states_expected)
          values (v_b.organization_id, v_b.project_id, v_b.id, r.scr ->> 'screenKey', 'covered', v_expected);
        end if;
      end;
    end if;
  end loop;
  return query select case when v_bad = 0 then 'complete' else 'gaps' end, v_b.id, v_bad::text;
end $$;
revoke all on function projects.p4ui_compute_route_coverage(uuid) from public, anon;
grant execute on function projects.p4ui_compute_route_coverage(uuid) to authenticated, service_role;

-- ── the artifact arrives: self-check, then BUILD_READY (only if the self-check holds) ─────
create or replace function projects.p4ui_attach_build_artifact(p_build_id uuid, p_prototype_artifact_id uuid)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b      projects.p4ui_prototype_builds;
  v_a      projects.prototype_artifacts;
  v_scope  text;
  v_cov    record;
  v_gaps   int;
  v_check  jsonb;
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id for update;
  if v_b.id is null then return query select 'unknown_build'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  if v_b.status = 'build_ready' and v_b.prototype_artifact_id = p_prototype_artifact_id then return query select 'already_attached'::text, v_b.id, null::text; return; end if;
  if v_b.status <> 'building' then return query select 'not_building'::text, v_b.id, v_b.status; return; end if;
  select a.* into v_a from projects.prototype_artifacts a where a.id = p_prototype_artifact_id;
  if v_a.id is null then return query select 'unknown_artifact'::text, null::uuid, null::text; return; end if;
  -- PROTO 8: the artifact must come from the exact locked UI version this build was planned against
  if v_a.ui_version_id <> v_b.ui_version_id then return query select 'artifact_from_another_ui_version'::text, null::uuid, null::text; return; end if;
  if exists (select 1 from projects.p4ui_prototype_builds o where o.prototype_artifact_id = v_a.id and o.id <> v_b.id) then
    return query select 'artifact_already_attached'::text, null::uuid, null::text; return;
  end if;

  update projects.p4ui_prototype_builds set prototype_artifact_id = v_a.id where id = v_b.id;
  select * into v_cov from projects.p4ui_compute_route_coverage(v_b.id);
  select count(*) into v_gaps from projects.p4ui_route_coverage c where c.build_id = v_b.id and c.coverage <> 'covered';
  v_check := jsonb_build_object('coverageGaps', v_gaps,
    'openBlockers', (select count(*) from projects.p4ui_prototype_blockers k where k.build_id = v_b.id and k.status = 'open'),
    'limitationsStated', cardinality(v_b.limitations) > 0,
    'checkedAt', now());
  update projects.p4ui_prototype_builds set self_check = v_check where id = v_b.id;

  -- a self-check that finds a broken build does not call it BUILD_READY (PROTO T015)
  if v_gaps > 0 then
    update projects.p4ui_prototype_builds set status = 'failed', failure_reason = 'self-check found ' || v_gaps || ' coverage gap(s): see the route coverage' where id = v_b.id;
    perform projects.p4ui_open_prototype_blocker(v_b.ui_version_id, 'build_failure', 'prototype_agent', 'The build failed its own coverage self-check (' || v_gaps || ' gap(s)).',
      'The Prototype Agent builds a corrected round', v_b.id);
    return query select 'self_check_failed'::text, v_b.id, v_gaps::text; return;
  end if;
  update projects.p4ui_prototype_builds set status = 'build_ready' where id = v_b.id;
  perform core.record_audit(v_b.organization_id, 'prototype.build_ready', 'p4ui_prototype_build', v_b.id, null,
    jsonb_build_object('projectId', v_b.project_id, 'uiVersionId', v_b.ui_version_id, 'artifactId', v_a.id));
  return query select 'build_ready'::text, v_b.id, null::text;
end $$;
revoke all on function projects.p4ui_attach_build_artifact(uuid, uuid) from public, anon;
grant execute on function projects.p4ui_attach_build_artifact(uuid, uuid) to authenticated, service_role;

create or replace function projects.p4ui_fail_build(p_build_id uuid, p_reason text, p_log jsonb default '[]'::jsonb)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b     projects.p4ui_prototype_builds;
  v_scope text;
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id for update;
  if v_b.id is null then return query select 'unknown_build'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if v_b.status = 'failed' then return query select 'already_failed'::text, v_b.id; return; end if;
  if v_b.status not in ('planned', 'input_validation', 'building', 'blocked') then return query select 'not_failable'::text, v_b.id; return; end if;
  if coalesce(length(btrim(p_reason)), 0) = 0 then return query select 'needs_reason'::text, null::uuid; return; end if;
  update projects.p4ui_prototype_builds set status = 'failed', failure_reason = left(btrim(p_reason), 1000),
         build_log = case when jsonb_typeof(p_log) = 'array' then p_log else '[]'::jsonb end where id = v_b.id;
  perform projects.p4ui_open_prototype_blocker(v_b.ui_version_id, 'build_failure', 'prototype_agent', left(btrim(p_reason), 500), 'A corrected round is planned and built', v_b.id);
  perform core.record_audit(v_b.organization_id, 'prototype.build_failed', 'p4ui_prototype_build', v_b.id, null, jsonb_build_object('projectId', v_b.project_id));
  return query select 'failed'::text, v_b.id;
end $$;
revoke all on function projects.p4ui_fail_build(uuid, text, jsonb) from public, anon;
grant execute on function projects.p4ui_fail_build(uuid, text, jsonb) to authenticated, service_role;

-- ═══ test data and artifact records ═══════════════════════════════════════
create or replace function projects.p4ui_record_test_data(p_build_id uuid, p_name text, p_payload jsonb, p_edge_case boolean default false, p_purpose text default null)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b     projects.p4ui_prototype_builds;
  v_scope text;
  v_new   uuid;
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id;
  if v_b.id is null then return query select 'unknown_build'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if v_b.status not in ('planned', 'input_validation', 'building', 'build_ready') then return query select 'build_past_editing'::text, null::uuid; return; end if;
  if p_payload is null or jsonb_typeof(p_payload) not in ('object', 'array') then return query select 'bad_payload'::text, null::uuid; return; end if;
  if coalesce(length(btrim(p_name)), 0) = 0 then return query select 'needs_name'::text, null::uuid; return; end if;
  begin
    insert into projects.p4ui_test_data (organization_id, project_id, build_id, name, purpose, payload, edge_case)
    values (v_b.organization_id, v_b.project_id, v_b.id, left(btrim(p_name), 120), nullif(left(btrim(coalesce(p_purpose, '')), 300), ''), p_payload, coalesce(p_edge_case, false))
    returning id into v_new;
  exception
    when check_violation then return query select 'secret_detected'::text, null::uuid; return;
    when unique_violation then return query select 'exists'::text, (select t.id from projects.p4ui_test_data t where t.build_id = v_b.id and t.name = left(btrim(p_name), 120)); return;
  end;
  return query select 'recorded'::text, v_new;
end $$;
revoke all on function projects.p4ui_record_test_data(uuid, text, jsonb, boolean, text) from public, anon;
grant execute on function projects.p4ui_record_test_data(uuid, text, jsonb, boolean, text) to authenticated, service_role;

create or replace function projects.p4ui_record_build_artifact(p_build_id uuid, p_kind text, p_storage_ref text, p_sha256 text, p_upload_status text, p_failure text default null)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b      projects.p4ui_prototype_builds;
  v_scope  text;
  v_status text := p_upload_status;
  v_fail   text := p_failure;
  v_new    uuid;
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id;
  if v_b.id is null then return query select 'unknown_build'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('preview_route', 'hosted_url', 'android_apk', 'ios_package', 'desktop_package', 'evidence', 'log') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_upload_status is null or p_upload_status not in ('pending', 'uploaded', 'failed', 'environment_missing') then return query select 'bad_status'::text, null::uuid; return; end if;
  -- a native package cannot be claimed uploaded by an agent: it becomes environment_missing and an external blocker is opened instead of an invented success
  if p_kind in ('android_apk', 'ios_package', 'desktop_package') and (v_scope = 'service' or (v_status = 'uploaded' and (p_sha256 is null or p_storage_ref is null))) then
    v_status := 'environment_missing';
    v_fail := coalesce(nullif(btrim(coalesce(v_fail, '')), ''), 'no signing or distribution credentials in this environment; a person must attach the package');
    perform projects.p4ui_open_prototype_blocker(v_b.ui_version_id, 'credential_missing', 'owner', 'The ' || p_kind || ' needs signing/distribution accounts that are not available here.',
      'The owner supplies the accounts, or a person attaches a built package with its sha256', v_b.id, true);
  end if;
  if v_status = 'failed' and coalesce(length(btrim(v_fail)), 0) = 0 then return query select 'needs_failure_reason'::text, null::uuid; return; end if;
  if v_b.status in ('locked', 'superseded', 'failed') then return query select 'build_closed'::text, null::uuid; return; end if;
  begin
    insert into projects.p4ui_artifact_records (organization_id, project_id, build_id, kind, storage_ref, sha256, access_policy, upload_status, failure_reason, recorded_by)
    values (v_b.organization_id, v_b.project_id, v_b.id, p_kind, nullif(btrim(coalesce(p_storage_ref, '')), ''), p_sha256,
            case when p_kind in ('preview_route', 'hosted_url') then 'client_after_approval' else 'internal' end, v_status, nullif(left(btrim(coalesce(v_fail, '')), 500), ''), (select auth.uid()))
    returning id into v_new;
  exception
    when check_violation then return query select 'bad_artifact'::text, null::uuid; return;
    when unique_violation then
      -- the same artifact again: a retry replaces a failed or pending attempt; an uploaded one is left as it is
      update projects.p4ui_artifact_records set upload_status = v_status, sha256 = coalesce(p_sha256, sha256), failure_reason = nullif(left(btrim(coalesce(v_fail, '')), 500), ''), recorded_by = (select auth.uid())
       where build_id = v_b.id and kind = p_kind and storage_ref is not distinct from nullif(btrim(coalesce(p_storage_ref, '')), '') and upload_status in ('failed', 'pending')
       returning id into v_new;
      if v_new is null then return query select 'exists'::text, null::uuid; return; end if;
  end;
  return query select case when v_status = 'environment_missing' then 'environment_missing' else 'recorded' end, v_new;
end $$;
revoke all on function projects.p4ui_record_build_artifact(uuid, text, text, text, text, text) from public, anon;
grant execute on function projects.p4ui_record_build_artifact(uuid, text, text, text, text, text) to authenticated, service_role;

-- production-logic or new-feature requests become blockers, never invented behaviour
create or replace function projects.p4ui_report_prototype_request(p_build_id uuid, p_kind text, p_text text)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b projects.p4ui_prototype_builds;
  r   record;
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id;
  if v_b.id is null then return query select 'unknown_build'::text, null::uuid; return; end if;
  if p_kind not in ('production_logic', 'new_feature') then return query select 'bad_kind'::text, null::uuid; return; end if;
  select * into r from projects.p4ui_open_prototype_blocker(v_b.ui_version_id, case when p_kind = 'production_logic' then 'production_logic_request' else 'scope_change' end,
    case when p_kind = 'production_logic' then 'pm' else 'pm' end,
    coalesce(nullif(btrim(coalesce(p_text, '')), ''), 'A request was made that the prototype must not implement.'),
    case when p_kind = 'production_logic' then 'Handled in Phase 5 development; the prototype keeps its simulated behaviour' else 'An approved Change Request, then a new UI version' end, v_b.id);
  return query select r.outcome, r.ref_id;
end $$;
revoke all on function projects.p4ui_report_prototype_request(uuid, text, text) from public, anon;
grant execute on function projects.p4ui_report_prototype_request(uuid, text, text) to authenticated, service_role;

-- ═══ QA handoff package (immutable) ═══════════════════════════════════════
create or replace function projects.p4ui_assemble_qa_handoff(p_build_id uuid)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b     projects.p4ui_prototype_builds;
  v_scope text;
  v_pkg   jsonb;
  v_new   uuid;
  v_ex    uuid;
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id for update;
  if v_b.id is null then return query select 'unknown_build'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  select h.id into v_ex from projects.p4ui_qa_handoffs h where h.build_id = v_b.id;
  if v_ex is not null then return query select 'exists'::text, v_ex, null::text; return; end if;
  if v_b.status <> 'build_ready' then return query select 'not_build_ready'::text, null::uuid, v_b.status; return; end if;
  if exists (select 1 from projects.p4ui_prototype_blockers k where k.build_id = v_b.id and k.status = 'open') then return query select 'open_blockers'::text, null::uuid, null::text; return; end if;
  if cardinality(v_b.limitations) = 0 then return query select 'limitations_not_stated'::text, null::uuid, 'state what this prototype does not do, even if it is "nothing beyond the approved UI"'; return; end if;
  if not exists (select 1 from projects.p4ui_route_coverage c where c.build_id = v_b.id) then return query select 'no_coverage'::text, null::uuid, null::text; return; end if;
  if exists (select 1 from projects.p4ui_artifact_records a where a.build_id = v_b.id and a.upload_status = 'failed'
               and not exists (select 1 from projects.p4ui_artifact_records u where u.build_id = a.build_id and u.kind = a.kind and u.upload_status = 'uploaded')) then
    return query select 'artifact_upload_failed'::text, null::uuid, null::text; return;
  end if;

  v_pkg := jsonb_build_object(
    'buildId', v_b.id, 'buildNumber', v_b.build_number, 'sourceUiVersionId', v_b.ui_version_id, 'prototypeArtifactId', v_b.prototype_artifact_id,
    'platform', v_b.platform, 'environment', v_b.environment, 'buildMode', v_b.build_mode,
    'coverage', coalesce((select jsonb_agg(jsonb_build_object('screenKey', c.screen_key, 'coverage', c.coverage) order by c.screen_key) from projects.p4ui_route_coverage c where c.build_id = v_b.id), '[]'::jsonb),
    'criticalFlows', v_b.critical_flows, 'limitations', to_jsonb(v_b.limitations), 'simulatedIntegrations', to_jsonb(v_b.simulated_integrations),
    'testInstructions', v_b.test_instructions, 'mockSources', to_jsonb(v_b.mock_sources),
    'testData', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'edgeCase', t.edge_case) order by t.name) from projects.p4ui_test_data t where t.build_id = v_b.id), '[]'::jsonb),
    'artifacts', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'uploadStatus', a.upload_status, 'sha256', a.sha256) order by a.kind) from projects.p4ui_artifact_records a where a.build_id = v_b.id), '[]'::jsonb),
    'selfCheck', v_b.self_check, 'buildLog', v_b.build_log);
  insert into projects.p4ui_qa_handoffs (organization_id, project_id, build_id, package, assembled_by) values (v_b.organization_id, v_b.project_id, v_b.id, v_pkg, (select auth.uid())) returning id into v_new;
  update projects.p4ui_prototype_builds set status = 'qa_review' where id = v_b.id;
  perform core.record_audit(v_b.organization_id, 'prototype.qa_handoff_assembled', 'p4ui_prototype_build', v_b.id, null, jsonb_build_object('projectId', v_b.project_id));
  return query select 'assembled'::text, v_new, null::text;
end $$;
revoke all on function projects.p4ui_assemble_qa_handoff(uuid) from public, anon;
grant execute on function projects.p4ui_assemble_qa_handoff(uuid) to authenticated, service_role;

-- ═══ the build follows the real gates: it reflects, it never decides ═══════
create or replace function projects.p4ui_sync_build_status(p_build_id uuid)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b      projects.p4ui_prototype_builds;
  v_a      projects.prototype_artifacts;
  v_del    projects.deliverables;
  v_admin  text;
  v_target text;
  v_path   text[] := array['build_ready', 'qa_review', 'qa_pass', 'admin_approved', 'client_review', 'locked'];
  v_i      int;
  v_j      int;
  v_scope  text;
begin
  select b.* into v_b from projects.p4ui_prototype_builds b where b.id = p_build_id for update;
  if v_b.id is null then return query select 'unknown_build'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  if v_b.prototype_artifact_id is null or v_b.status in ('planned', 'input_validation', 'blocked', 'building', 'failed', 'superseded', 'locked') then
    return query select 'nothing_to_sync'::text, v_b.id, v_b.status; return;
  end if;
  select a.* into v_a from projects.prototype_artifacts a where a.id = v_b.prototype_artifact_id;
  select d.* into v_del from projects.deliverables d where d.id = v_a.deliverable_id;
  select dd.admin_status into v_admin from projects.deliverable_details dd where dd.deliverable_id = v_a.deliverable_id;

  v_target := case
    when v_del.status = 'approved' then 'locked'
    when v_del.status = 'superseded' then 'superseded'
    when v_del.status = 'changes_requested' or v_admin = 'changes_required' then 'changes_requested'
    when v_del.status = 'in_review' then 'client_review'
    when v_admin = 'approved' and v_a.status = 'qa_pass' then 'admin_approved'
    when v_a.status = 'qa_pass' then 'qa_pass'
    when v_a.status = 'qa_changes_required' then 'qa_changes_required'
    else v_b.status end;
  if v_target = v_b.status then return query select 'unchanged'::text, v_b.id, v_b.status; return; end if;

  v_i := array_position(v_path, v_b.status);
  if v_target in ('qa_changes_required', 'changes_requested', 'superseded') then
    -- walk forward only as far as the real rows support (each step is a gate the trigger re-checks), then take the sideways edge
    for k in (coalesce(v_i, 0) + 1)..array_length(v_path, 1) loop
      exit when v_path[k] in ('client_review', 'locked');
      exit when v_path[k] = 'qa_pass' and v_a.status is distinct from 'qa_pass';
      exit when v_path[k] = 'admin_approved' and v_admin is distinct from 'approved';
      exit when v_target = 'qa_changes_required' and v_path[k] = 'qa_pass';
      exit when v_target = 'superseded' and v_path[k] = 'qa_review';
      update projects.p4ui_prototype_builds set status = v_path[k] where id = v_b.id;
    end loop;
    update projects.p4ui_prototype_builds set status = v_target where id = v_b.id;
  else
    v_j := array_position(v_path, v_target);
    if v_i is null or v_j is null or v_j <= v_i then return query select 'unchanged'::text, v_b.id, v_b.status; return; end if;
    for k in (v_i + 1)..v_j loop
      update projects.p4ui_prototype_builds set status = v_path[k] where id = v_b.id;
    end loop;
  end if;
  return query select 'synced'::text, v_b.id, v_target;
end $$;
revoke all on function projects.p4ui_sync_build_status(uuid) from public, anon;
grant execute on function projects.p4ui_sync_build_status(uuid) to authenticated, service_role;

-- ═══ revisions: origin and evidence, derived ══════════════════════════════
create or replace function projects.p4ui_record_build_revision(p_to_build_id uuid, p_summary text default null)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_to     projects.p4ui_prototype_builds;
  v_from   projects.p4ui_prototype_builds;
  v_a      projects.prototype_artifacts;
  v_fa     projects.prototype_artifacts;
  v_dd     projects.deliverable_details;
  v_route  projects.p4ui_prototype_feedback_routes;
  v_req    record;
  v_origin text;
  v_ev     jsonb;
  v_new    uuid;
  v_scope  text;
  v_sum    text;
begin
  select b.* into v_to from projects.p4ui_prototype_builds b where b.id = p_to_build_id;
  if v_to.id is null then return query select 'unknown_build'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_to.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  if v_to.revision_of_build_id is null then return query select 'not_a_revision'::text, null::uuid, null::text; return; end if;
  if exists (select 1 from projects.p4ui_prototype_revisions r where r.to_build_id = v_to.id) then return query select 'exists'::text, v_to.id, null::text; return; end if;
  select b.* into v_from from projects.p4ui_prototype_builds b where b.id = v_to.revision_of_build_id;
  select a.* into v_fa from projects.prototype_artifacts a where a.id = v_from.prototype_artifact_id;
  select dd.* into v_dd from projects.deliverable_details dd where dd.deliverable_id = v_fa.deliverable_id;

  if v_from.status = 'qa_changes_required' or (v_fa.status = 'qa_changes_required') then
    v_origin := 'qa_defect'; v_ev := jsonb_build_object('qaFindings', v_fa.qa_findings);
  elsif v_dd.admin_status = 'changes_required' then
    v_origin := 'admin_edit'; v_ev := jsonb_build_object('adminNote', v_dd.admin_note);
  else
    -- a client round: the PM must have classified it as a correction or an included revision first
    select r.* into v_route from projects.p4ui_prototype_feedback_routes r where r.deliverable_id = v_fa.deliverable_id;
    if v_route.id is null then return query select 'classification_required'::text, null::uuid, null::text; return; end if;
    if v_route.route <> 'prototype_revision' then return query select 'not_a_prototype_revision'::text, null::uuid, v_route.route; return; end if;
    select ar.decision_note, ar.evidence_ref into v_req from approvals.approval_requests ar
     where ar.organization_id = v_to.organization_id and ar.subject_type = 'deliverable' and ar.subject_id = v_fa.deliverable_id and ar.state <> 'pending' order by ar.decided_at desc limit 1;
    v_origin := 'client_change';
    v_ev := jsonb_build_object('clientWords', v_req.decision_note, 'evidenceRef', v_req.evidence_ref, 'classification', v_route.classification);
  end if;
  v_sum := coalesce(nullif(left(btrim(coalesce(p_summary, '')), 2000), ''), 'Build ' || v_to.build_number || ' revises build ' || v_from.build_number || ' (' || v_origin || ').');
  insert into projects.p4ui_prototype_revisions (organization_id, project_id, from_build_id, to_build_id, origin, evidence, summary)
  values (v_to.organization_id, v_to.project_id, v_from.id, v_to.id, v_origin, v_ev, v_sum) returning id into v_new;
  return query select 'recorded'::text, v_new, v_origin;
end $$;
revoke all on function projects.p4ui_record_build_revision(uuid, text) from public, anon;
grant execute on function projects.p4ui_record_build_revision(uuid, text) to authenticated, service_role;

create or replace function projects.p4ui_route_prototype_feedback(p_deliverable_id uuid, p_classification text, p_reasoning text)
returns table (outcome text, ref_id uuid, route text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d      projects.deliverables;
  v_a      projects.prototype_artifacts;
  v_scope  text;
  v_route  text;
  v_new    uuid;
  v_ex     projects.p4ui_prototype_feedback_routes;
  v_p4     projects.phase_four;
begin
  select d.* into v_d from projects.deliverables d where d.id = p_deliverable_id and d.kind = 'prototype';
  if v_d.id is null then return query select 'unknown_deliverable'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_d.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  select r.* into v_ex from projects.p4ui_prototype_feedback_routes r where r.deliverable_id = v_d.id;
  if v_ex.id is not null then return query select 'already_routed'::text, v_ex.id, v_ex.route; return; end if;
  if v_d.status <> 'changes_requested' then return query select 'wrong_state'::text, null::uuid, null::text; return; end if;
  if p_classification is null or p_classification not in ('CORRECTION', 'INCLUDED_REVISION', 'CLARIFICATION', 'POSSIBLE_SCOPE_CHANGE', 'DESIGN_DIRECTION_CHANGE', 'REJECTED_REQUEST') then
    return query select 'bad_classification'::text, null::uuid, null::text; return;
  end if;
  if coalesce(length(btrim(p_reasoning)), 0) = 0 then return query select 'needs_reasoning'::text, null::uuid, null::text; return; end if;
  v_route := case p_classification when 'CORRECTION' then 'prototype_revision' when 'INCLUDED_REVISION' then 'prototype_revision' when 'CLARIFICATION' then 'clarification'
                                   when 'POSSIBLE_SCOPE_CHANGE' then 'change_request' when 'DESIGN_DIRECTION_CHANGE' then 'escalation' else 'none' end;
  insert into projects.p4ui_prototype_feedback_routes (organization_id, project_id, deliverable_id, classification, route, reasoning, classified_by)
  values (v_d.organization_id, v_d.project_id, v_d.id, p_classification, v_route, left(btrim(p_reasoning), 500), (select auth.uid())) returning id into v_new;
  if v_route in ('change_request', 'escalation', 'clarification') then
    select a.* into v_a from projects.prototype_artifacts a where a.deliverable_id = v_d.id;
    select p4.* into v_p4 from projects.phase_four p4 where p4.project_id = v_d.project_id for update;
    if v_a.id is not null then
      perform projects.p4ui_open_prototype_blocker(v_a.ui_version_id, 'scope_change', 'pm',
        case v_route when 'change_request' then 'The client asks for something outside the agreed scope: a Change Request must be approved first.'
                     when 'escalation' then 'The client asks for a new design direction: escalated, not implemented in the prototype.'
                     else 'The client''s prototype feedback is unclear and needs clarification.' end,
        'The Change Request is approved / the Admin decides / the client answers, and a person resolves this blocker');
    end if;
    if v_route in ('change_request', 'escalation') and v_p4.id is not null and v_p4.state not in ('completed', 'scope_escalation', 'revision_limit_escalation') then
      update projects.phase_four set state = 'scope_escalation',
             blocked_reason = case v_route when 'change_request' then 'A prototype change request is outside the agreed scope: Change Request required.' else 'The client asks for a new design direction: escalated.' end
       where id = v_p4.id;
    end if;
  end if;
  perform core.record_audit(v_d.organization_id, 'prototype.feedback_routed', 'p4ui_prototype_feedback_route', v_new, null,
    jsonb_build_object('projectId', v_d.project_id, 'classification', p_classification, 'route', v_route));
  return query select 'routed'::text, v_new, v_route;
end $$;
revoke all on function projects.p4ui_route_prototype_feedback(uuid, text, text) from public, anon;
grant execute on function projects.p4ui_route_prototype_feedback(uuid, text, text) to authenticated, service_role;

-- ═══ reads ═════════════════════════════════════════════════════════════════
-- share-eligible: the artifact is QA-passed, nothing is open, no artifact record failed, limitations are stated. A reason for every "no".
create or replace function projects.p4ui_build_share_eligibility(p_build_id uuid)
returns table (eligible boolean, reasons text[])
language sql
stable
security invoker
set search_path = ''
as $$
  with b as (select x.* from projects.p4ui_prototype_builds x where x.id = p_build_id)
  select coalesce(cardinality(r.reasons), 1) = 0, coalesce(r.reasons, array['unknown build'])
    from (
      select array_remove(array[
        case when b.status not in ('qa_pass', 'admin_approved') then 'the build has not passed Prototype QA (status ' || b.status || ')' end,
        case when exists (select 1 from projects.p4ui_prototype_blockers k where k.build_id = b.id and k.status = 'open') then 'a prototype blocker is open' end,
        case when exists (select 1 from projects.p4ui_artifact_records a where a.build_id = b.id and a.upload_status in ('failed', 'pending') and a.kind in ('preview_route', 'hosted_url')
                           and not exists (select 1 from projects.p4ui_artifact_records u where u.build_id = a.build_id and u.kind = a.kind and u.upload_status = 'uploaded')) then 'an artifact upload failed or is pending' end,
        case when cardinality(b.limitations) = 0 then 'known limitations are not stated' end
      ], null) as reasons from b
    ) r
$$;
revoke all on function projects.p4ui_build_share_eligibility(uuid) from public, anon;
grant execute on function projects.p4ui_build_share_eligibility(uuid) to authenticated, service_role;

-- Client-safe: the label and the limitations, only once the deliverable is out of draft and only for that client (or staff). No internals.
create or replace function projects.p4ui_prototype_client_notice(p_deliverable_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d   projects.deliverables;
  v_b   projects.p4ui_prototype_builds;
  v_org uuid := (select core.current_organization_id());
begin
  select d.* into v_d from projects.deliverables d where d.id = p_deliverable_id and d.kind = 'prototype';
  if v_d.id is null or v_d.organization_id is distinct from v_org then return null; end if;
  if not coalesce((select core.is_internal()), false) then
    if v_d.status = 'draft' then return null; end if;
    if not exists (select 1 from projects.projects p where p.id = v_d.project_id and p.client_account_id = (select core.current_client_account_id())) then return null; end if;
  end if;
  select b.* into v_b from projects.p4ui_prototype_builds b join projects.prototype_artifacts a on a.id = b.prototype_artifact_id where a.deliverable_id = v_d.id;
  return jsonb_build_object(
    'label', 'Interactive preview with simulated data and a simulated sign-in. It is not the finished product and nothing here is real.',
    'limitations', coalesce(to_jsonb(v_b.limitations), '[]'::jsonb),
    'simulated', coalesce(to_jsonb(v_b.simulated_integrations), '[]'::jsonb),
    'platform', v_b.platform);
end $$;
revoke all on function projects.p4ui_prototype_client_notice(uuid) from public, anon;
grant execute on function projects.p4ui_prototype_client_notice(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
