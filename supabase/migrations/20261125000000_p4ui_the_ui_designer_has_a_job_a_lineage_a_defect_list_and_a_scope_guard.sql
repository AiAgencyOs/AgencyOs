-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 UI Designer cluster (docs/phase-4-implementation-traceability.md, rows P4-UID-001..064; log: docs/phase-4-ui-prototype-gaps-log.md).
--
-- Task 2's UI half could draft, QA, Admin-review, client-review and lock a UI version, but four things it needed to be a CONDITIONAL agent
-- were not records anywhere:
--
--   * WHY the Designer woke up. designer-activation.ts holds the seven reasons and nine refusals, but only the initial run was recorded, and a
--     refusal left no trace at all. -> projects.p4ui_design_jobs (UIDesignJob) + projects.p4ui_request_design_job: every activation names a reason,
--     a source version, a change set and an idempotency key; every NON-activation (prototype bug, payment, an ambiguous rule...) is recorded as a
--     'refused' job that says who owns it instead, and an ambiguous rule opens a blocker and a clarification instead of a guess.
--   * HOW a version relates to the one before it. ui_versions has version/status/screens and nothing else. -> projects.p4ui_version_meta (parent,
--     activation reason, origin, changed screens, change summary, scope version, Figma references) derived deterministically from the two versions
--     (no model has to remember to say what it changed), and projects.p4ui_revisions (UIDesignRevision, append-only, with its evidence).
--   * WHAT a screen specifies beyond layout. -> projects.p4ui_screen_specs (UIScreenVersion: purpose, entry/exit, data, actions, validation, role
--     variants, responsive variants, the full UID 6.3 state list, the Figma node) and projects.p4ui_design_completeness (what is still missing).
--   * WHO may stop or restart the loop. -> projects.p4ui_design_blockers (UIDesignBlocker), projects.p4ui_qa_defects (DesignQADefectLink: defect ->
--     fix_ready -> verified, where only a QA verdict on the fix version can verify and the producer of the fix may not), projects.p4ui_feedback_routes
--     (a client's revision is classified BEFORE the Designer wakes; a scope change becomes a Change Request, not a redesign), projects.p4ui_post_lock_requests
--     (a locked UI is never overwritten; a change needs an Admin) and projects.p4ui_prototype_design_issues (a prototype CODE bug leaves the Designer
--     asleep; only a confirmed SOURCE-UI defect wakes it).
--
-- Nothing here approves anything. The Admin and client gates (request_ui_version_admin_review, share_ui_version_with_client,
-- record_ui_version_client_decision, lock_ui_version) are untouched; a decision that waives a human step takes a PERSON (auth.uid() not null), never
-- the service role. Figma is recorded as references and a capability state - never written: the write path needs credentials this repository does not
-- have, and figma_write_state can only say so ('not_attempted' / 'environment_missing' / 'manual_required').
--
-- Pattern: every table is org-scoped (enforce_parent_org per FK + freeze_organization_id), RLS = internal read only, no write policy; the doors are
-- SECURITY DEFINER and the only write path; names are prefixed p4ui_ so no other change can collide with them.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.ui_design_job_requested',
   'UID section 19 UIDesignJob. A conditional UI Designer activation was recorded with its reason, source version, change set and idempotency key. Nothing is drawn by this event; the draft/revise workflows do that.',
   true),
  ('project.ui_coverage_gap_confirmed',
   'UID section 20 UICoverageGapConfirmed. Coverage confirmed a screen or declared state missing from a UI version against the locked Phase 3 baseline; the Designer may be activated for it (reason missing_approved_ui).',
   true),
  ('project.ui_scope_change_approved',
   'UID section 20 ScopeChangeApprovedForUI. An approved Change Request (or an Admin-approved post-lock request) reached the UI workflow; the Designer may be activated for it (reason approved_scope_change).',
   true),
  ('project.prototype_design_issue_confirmed',
   'UID section 20 PrototypeDesignIssueConfirmed. A person confirmed the prototype stage proved the approved SOURCE UI itself defective (not a prototype code bug); the Designer may be re-activated (reason source_ui_design_defect).',
   true),
  ('project.ui_post_lock_revision_decided',
   'UID section 11/16. An Admin decided a request to change a LOCKED UI version. Approval allows a governed new version; it never edits the locked one.',
   true),
  ('project.ui_design_blocker_opened',
   'UID section 19 UIDesignBlocker. The UI Designer path stopped on a named blocker (ambiguity, missing baseline, missing asset, unavailable Figma, scope conflict) with an owner and a resume condition.',
   true)
on conflict (type) do nothing;

-- ── who is calling ──────────────────────────────────────────────────────────
-- 'person' = a signed-in writer of the row's organization; 'admin' = such a person who is an owner or ops_admin; 'service' = the runner;
-- 'forbidden' = a signed-in user of another organization or without write; 'no_actor' = nobody. Every p4ui door starts here.
create or replace function projects.p4ui_caller(p_org uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when (select auth.uid()) is not null then
      case
        when p_org is not distinct from (select core.current_organization_id()) and coalesce((select core.can_write()), false) then
          case when coalesce((select core.is_admin()), false) then 'admin' else 'person' end
        else 'forbidden'
      end
    when (select auth.role()) = 'service_role' then 'service'
    else 'no_actor'
  end
$$;
revoke all on function projects.p4ui_caller(uuid) from public, anon;
grant execute on function projects.p4ui_caller(uuid) to authenticated, service_role;

-- ── the Designer's activation record ────────────────────────────────────────
create table if not exists projects.p4ui_design_jobs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  phase_four_id         uuid not null references projects.phase_four(id) on delete cascade,
  -- one of designer-activation.ts's seven reasons; NULL only for a refused trigger (which is not a reason)
  activation_reason     text check (activation_reason in ('initial_phase_four', 'missing_approved_ui', 'design_qa_defect', 'admin_edit',
                                                          'client_visual_revision', 'approved_scope_change', 'source_ui_design_defect')),
  status                text not null default 'requested' check (status in ('requested', 'running', 'delivered', 'refused', 'blocked', 'cancelled')),
  source_ui_version_id  uuid references projects.ui_versions(id) on delete restrict,
  scope_version         int check (scope_version is null or scope_version > 0),
  change_set            jsonb not null default '[]'::jsonb check (jsonb_typeof(change_set) = 'array'),
  request_text          text check (request_text is null or length(btrim(request_text)) between 1 and 4000),
  evidence_id           uuid,
  idempotency_key       text not null check (length(idempotency_key) = 32),
  result_ui_version_id  uuid references projects.ui_versions(id) on delete restrict,
  refused_trigger       text,
  refusal_reason        text,
  route_to              text,
  requested_by          uuid references core.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint p4ui_design_jobs_idempotent unique (organization_id, idempotency_key),
  -- a refusal is a record with a trigger and an owner, never a reason; an activation always has a reason
  constraint p4ui_design_jobs_refusal_shape check ((status = 'refused') = (refused_trigger is not null)),
  constraint p4ui_design_jobs_reason_shape check ((status = 'refused') = (activation_reason is null)),
  constraint p4ui_design_jobs_refusal_names_owner check (status <> 'refused' or (refusal_reason is not null and route_to is not null)),
  constraint p4ui_design_jobs_delivery_shape check ((status = 'delivered') = (result_ui_version_id is not null))
);
comment on table projects.p4ui_design_jobs is
  'UID section 19 UIDesignJob: every conditional activation of the UI Designer (reason, source version, scope version, change set, idempotency key) and every REFUSED activation (who owns it instead). Written only by projects.p4ui_request_design_job / p4ui_complete_design_job.';
create index if not exists p4ui_design_jobs_project_idx on projects.p4ui_design_jobs (organization_id, project_id, created_at desc);

-- ── a version's lineage, derived ────────────────────────────────────────────
create table if not exists projects.p4ui_version_meta (
  ui_version_id         uuid primary key references projects.ui_versions(id) on delete cascade,
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  parent_ui_version_id  uuid references projects.ui_versions(id) on delete restrict,
  design_job_id         uuid references projects.p4ui_design_jobs(id) on delete set null,
  activation_reason     text not null check (activation_reason in ('initial_phase_four', 'missing_approved_ui', 'design_qa_defect', 'admin_edit',
                                                                   'client_visual_revision', 'approved_scope_change', 'source_ui_design_defect')),
  origin                text not null check (origin in ('initial', 'qa_defect', 'admin_edit', 'client_change', 'scope_change', 'source_ui_defect', 'coverage_gap')),
  scope_version         int check (scope_version is null or scope_version > 0),
  changed_screens       text[] not null default '{}',
  added_screens         text[] not null default '{}',
  removed_screens       text[] not null default '{}',
  content_changed       boolean not null default true,
  change_summary        text not null check (length(btrim(change_summary)) between 1 and 2000),
  -- Figma: references and a capability state, never a claim of having written. 'linked' needs a file reference.
  figma_state           text not null default 'manual_figma_required' check (figma_state in ('manual_figma_required', 'linked', 'unavailable')),
  figma_file_ref        text check (figma_file_ref is null or length(btrim(figma_file_ref)) between 1 and 300),
  figma_page_ref        text check (figma_page_ref is null or length(btrim(figma_page_ref)) between 1 and 300),
  figma_node_refs       jsonb not null default '{}'::jsonb check (jsonb_typeof(figma_node_refs) = 'object'),
  figma_preview_url     text check (figma_preview_url is null or figma_preview_url ~ '^https://'),
  figma_write_state     text not null default 'not_attempted' check (figma_write_state in ('not_attempted', 'environment_missing', 'manual_required')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint p4ui_version_meta_linked_has_a_file check (figma_state <> 'linked' or figma_file_ref is not null),
  constraint p4ui_version_meta_root_has_no_parent check ((origin = 'initial') = (parent_ui_version_id is null))
);
comment on table projects.p4ui_version_meta is
  'UID 12/13/19: a UI version''s parent, activation reason, origin, scope version, changed screens, change summary and Figma references. Derived by projects.p4ui_derive_version_meta from the two versions (so a model cannot forget to say what changed). Figma is recorded, never written: figma_write_state has no value that claims a write.';

-- ── a revision round, append-only ──────────────────────────────────────────
create table if not exists projects.p4ui_revisions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  phase_four_id        uuid not null references projects.phase_four(id) on delete cascade,
  from_ui_version_id   uuid not null references projects.ui_versions(id) on delete restrict,
  to_ui_version_id     uuid not null unique references projects.ui_versions(id) on delete restrict,
  design_job_id        uuid references projects.p4ui_design_jobs(id) on delete set null,
  origin               text not null check (origin in ('qa_defect', 'admin_edit', 'client_change', 'scope_change', 'source_ui_defect', 'coverage_gap')),
  evidence             jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  affected_screens     text[] not null default '{}',
  summary              text not null check (length(btrim(summary)) between 1 and 2000),
  created_at           timestamptz not null default now()
);
comment on table projects.p4ui_revisions is
  'UID section 19 UIDesignRevision: from/to version, origin, the evidence it came from (defect ids, the Admin decision note, the client''s own words), affected screens, summary. Append-only.';

-- ── per-screen specification (UIScreenVersion) ─────────────────────────────
create table if not exists projects.p4ui_screen_specs (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  ui_version_id      uuid not null references projects.ui_versions(id) on delete cascade,
  screen_key         text not null check (screen_key ~ '^[a-z][a-z0-9_.-]{1,62}$'),
  purpose            text check (purpose is null or length(btrim(purpose)) between 1 and 500),
  entry_points       text[] not null default '{}',
  exit_points        text[] not null default '{}',
  data_shown         text[] not null default '{}',
  actions            text[] not null default '{}',
  validation_rules   text[] not null default '{}',
  -- UID 6.3 states beyond the five the draft schema knows
  states             text[] not null default '{}',
  -- UID 6.4: only the platform variants the scope requires
  responsive_variants text[] not null default '{}',
  role_variants      jsonb not null default '[]'::jsonb check (jsonb_typeof(role_variants) = 'array'),
  tokens_used        text[] not null default '{}',
  node_ref           text check (node_ref is null or length(btrim(node_ref)) between 1 and 200),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint p4ui_screen_specs_one_per_screen unique (ui_version_id, screen_key),
  constraint p4ui_screen_specs_states_known check (states <@ array['default', 'empty', 'loading', 'error', 'success', 'hover', 'focus', 'disabled', 'selected',
    'validation_error', 'permission_denied', 'offline', 'overflow', 'partial', 'no_results', 'expired']::text[]),
  constraint p4ui_screen_specs_devices_known check (responsive_variants <@ array['mobile', 'tablet', 'desktop', 'ios', 'android']::text[])
);
comment on table projects.p4ui_screen_specs is
  'UID 6.2-6.4/19 UIScreenVersion: what a screen specifies beyond layout - purpose, entry/exit, data, actions, validation, role variants, platform variants, the full state list, token usage and the Figma node. Keyed by (ui_version_id, screen_key); the key must be one the version designs.';

-- ── blockers ───────────────────────────────────────────────────────────────
create table if not exists projects.p4ui_design_blockers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  phase_four_id     uuid not null references projects.phase_four(id) on delete cascade,
  ui_version_id     uuid references projects.ui_versions(id) on delete cascade,
  design_job_id     uuid references projects.p4ui_design_jobs(id) on delete set null,
  kind              text not null check (kind in ('ambiguity', 'baseline_missing', 'asset_missing', 'figma_unavailable', 'scope_conflict', 'locked_scope_conflict', 'usability_conflict')),
  owner_role        text not null check (owner_role in ('pm', 'admin', 'designer', 'client', 'owner')),
  reason            text not null check (length(btrim(reason)) between 1 and 500),
  resume_condition  text not null check (length(btrim(resume_condition)) between 1 and 500),
  status            text not null default 'open' check (status in ('open', 'resolved', 'cancelled')),
  stops_phase       boolean not null default false,
  resume_state      text,
  resolved_by       uuid references core.users(id) on delete set null,
  resolved_at       timestamptz,
  resolution_note   text check (resolution_note is null or length(btrim(resolution_note)) between 1 and 500),
  created_at        timestamptz not null default now(),
  constraint p4ui_design_blockers_resolved_shape check ((status = 'open') = (resolved_at is null))
);
comment on table projects.p4ui_design_blockers is
  'UID section 19 UIDesignBlocker: a named stop (ambiguity, missing baseline, missing asset, unavailable Figma, scope conflict) with an owner and a resume condition. Resolved only by a PERSON; resolving restores the workspace state it stopped.';

-- ── design QA defects (DesignQADefectLink) ─────────────────────────────────
create table if not exists projects.p4ui_qa_defects (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  ui_version_id        uuid not null references projects.ui_versions(id) on delete cascade,
  screen_key           text check (screen_key is null or screen_key ~ '^[a-z][a-z0-9_.-]{1,62}$'),
  category             text not null default 'other' check (category in ('missing_screen', 'missing_state', 'token', 'accessibility', 'content', 'other')),
  description          text not null check (length(btrim(description)) between 1 and 1000),
  severity             text not null default 'major' check (severity in ('minor', 'major', 'blocker')),
  status               text not null default 'open' check (status in ('open', 'fix_ready', 'verified', 'reopened', 'wont_fix')),
  fix_ui_version_id    uuid references projects.ui_versions(id) on delete restrict,
  fix_ready_by         uuid references core.users(id) on delete set null,
  fix_ready_at         timestamptz,
  verified_by          uuid references core.users(id) on delete set null,
  verified_at          timestamptz,
  retest_note          text check (retest_note is null or length(btrim(retest_note)) between 1 and 500),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint p4ui_qa_defects_fix_shape check ((status in ('fix_ready', 'verified')) = (fix_ui_version_id is not null)),
  constraint p4ui_qa_defects_verified_shape check ((status = 'verified') = (verified_at is not null))
);
comment on table projects.p4ui_qa_defects is
  'UID 7/19 DesignQADefectLink: a Design QA finding as a row (version, screen, category, severity) that the Designer''s new version marks fix_ready - a claim - and that only a QA verdict on that fix version, by someone other than the fix''s producer, can mark verified.';
create index if not exists p4ui_qa_defects_version_idx on projects.p4ui_qa_defects (ui_version_id, status);

-- ── client feedback is classified before the Designer wakes ────────────────
create table if not exists projects.p4ui_feedback_routes (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  ui_version_id        uuid not null unique references projects.ui_versions(id) on delete cascade,
  classification       text not null check (classification in ('CORRECTION', 'INCLUDED_REVISION', 'CLARIFICATION', 'POSSIBLE_SCOPE_CHANGE', 'DESIGN_DIRECTION_CHANGE', 'REJECTED_REQUEST')),
  route                text not null check (route in ('design_revision', 'clarification', 'change_request', 'escalation', 'none')),
  reasoning            text not null check (length(btrim(reasoning)) between 1 and 500),
  change_request_id    uuid references projects.change_requests(id) on delete set null,
  classified_by        uuid references core.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  constraint p4ui_feedback_routes_class_route check (
    (classification in ('CORRECTION', 'INCLUDED_REVISION') and route = 'design_revision')
    or (classification = 'CLARIFICATION' and route = 'clarification')
    or (classification = 'POSSIBLE_SCOPE_CHANGE' and route = 'change_request')
    or (classification = 'DESIGN_DIRECTION_CHANGE' and route = 'escalation')
    or (classification = 'REJECTED_REQUEST' and route = 'none'))
);
comment on table projects.p4ui_feedback_routes is
  'UID 9/11: where a client''s UI feedback goes once the PM has classified it. Only a correction or an included revision may activate the Designer; a scope change waits for a Change Request, a new direction escalates, a clarification asks.';

-- ── a locked UI is changed only by an Admin ────────────────────────────────
create table if not exists projects.p4ui_post_lock_requests (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  ui_version_id      uuid not null references projects.ui_versions(id) on delete restrict,
  kind               text not null check (kind in ('redesign', 'colour_change', 'component_change', 'other')),
  reason             text not null check (length(btrim(reason)) between 1 and 1000),
  status             text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  requested_by       uuid references core.users(id) on delete set null,
  decided_by         uuid references core.users(id) on delete set null,
  decided_at         timestamptz,
  decision_note      text check (decision_note is null or length(btrim(decision_note)) between 1 and 500),
  created_at         timestamptz not null default now(),
  constraint p4ui_post_lock_decided_shape check ((status = 'requested') = (decided_at is null)),
  constraint p4ui_post_lock_decided_by_a_person check (status = 'requested' or decided_by is not null)
);
comment on table projects.p4ui_post_lock_requests is
  'UID 11/16: a request to change a LOCKED UI version (redesign, colour). The locked row is never edited (freeze_locked_ui_version); an approved request lets p4ui_request_design_job open a governed NEW version. Decided only by a signed-in Admin.';

-- ── a prototype problem is a code bug until a person says the design is wrong ─
create table if not exists projects.p4ui_prototype_design_issues (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  prototype_artifact_id uuid not null references projects.prototype_artifacts(id) on delete cascade,
  ui_version_id         uuid not null references projects.ui_versions(id) on delete restrict,
  screen_key            text check (screen_key is null or screen_key ~ '^[a-z][a-z0-9_.-]{1,62}$'),
  description           text not null check (length(btrim(description)) between 1 and 1000),
  classification        text not null default 'unclassified' check (classification in ('unclassified', 'code_bug', 'source_ui_defect')),
  status                text not null default 'reported' check (status in ('reported', 'confirmed', 'dismissed')),
  reported_by           uuid references core.users(id) on delete set null,
  confirmed_by          uuid references core.users(id) on delete set null,
  confirmed_at          timestamptz,
  decision_note         text check (decision_note is null or length(btrim(decision_note)) between 1 and 500),
  created_at            timestamptz not null default now(),
  constraint p4ui_proto_issue_confirmed_shape check ((status = 'reported') = (confirmed_at is null)),
  constraint p4ui_proto_issue_confirm_means_source check (status <> 'confirmed' or classification = 'source_ui_defect'),
  constraint p4ui_proto_issue_dismiss_means_code check (status <> 'dismissed' or classification = 'code_bug')
);
comment on table projects.p4ui_prototype_design_issues is
  'UID 3/16/20: an issue raised against a prototype build. A code bug is dismissed (the Prototype Agent fixes it; the Designer stays inactive). Only a source-UI defect confirmed by a person emits PrototypeDesignIssueConfirmed and may re-activate the Designer.';

-- ── tenancy guards, per FK, and the org freeze (CI db:verify:tenancyguards) ──
do $$
declare
  g record;
  t text;
begin
  for g in
    select * from (values
      ('p4ui_design_jobs', 'project_id', 'projects.projects'),
      ('p4ui_design_jobs', 'phase_four_id', 'projects.phase_four'),
      ('p4ui_design_jobs', 'source_ui_version_id', 'projects.ui_versions'),
      ('p4ui_design_jobs', 'result_ui_version_id', 'projects.ui_versions'),
      ('p4ui_version_meta', 'ui_version_id', 'projects.ui_versions'),
      ('p4ui_version_meta', 'project_id', 'projects.projects'),
      ('p4ui_version_meta', 'parent_ui_version_id', 'projects.ui_versions'),
      ('p4ui_version_meta', 'design_job_id', 'projects.p4ui_design_jobs'),
      ('p4ui_revisions', 'project_id', 'projects.projects'),
      ('p4ui_revisions', 'phase_four_id', 'projects.phase_four'),
      ('p4ui_revisions', 'from_ui_version_id', 'projects.ui_versions'),
      ('p4ui_revisions', 'to_ui_version_id', 'projects.ui_versions'),
      ('p4ui_revisions', 'design_job_id', 'projects.p4ui_design_jobs'),
      ('p4ui_screen_specs', 'project_id', 'projects.projects'),
      ('p4ui_screen_specs', 'ui_version_id', 'projects.ui_versions'),
      ('p4ui_design_blockers', 'project_id', 'projects.projects'),
      ('p4ui_design_blockers', 'phase_four_id', 'projects.phase_four'),
      ('p4ui_design_blockers', 'ui_version_id', 'projects.ui_versions'),
      ('p4ui_design_blockers', 'design_job_id', 'projects.p4ui_design_jobs'),
      ('p4ui_qa_defects', 'project_id', 'projects.projects'),
      ('p4ui_qa_defects', 'ui_version_id', 'projects.ui_versions'),
      ('p4ui_qa_defects', 'fix_ui_version_id', 'projects.ui_versions'),
      ('p4ui_feedback_routes', 'project_id', 'projects.projects'),
      ('p4ui_feedback_routes', 'ui_version_id', 'projects.ui_versions'),
      ('p4ui_feedback_routes', 'change_request_id', 'projects.change_requests'),
      ('p4ui_post_lock_requests', 'project_id', 'projects.projects'),
      ('p4ui_post_lock_requests', 'ui_version_id', 'projects.ui_versions'),
      ('p4ui_prototype_design_issues', 'project_id', 'projects.projects'),
      ('p4ui_prototype_design_issues', 'prototype_artifact_id', 'projects.prototype_artifacts'),
      ('p4ui_prototype_design_issues', 'ui_version_id', 'projects.ui_versions')
    ) as x(tbl, col, parent)
  loop
    execute format(
      'create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)',
      g.tbl || '_parent_org_' || g.col, g.col, g.tbl, g.col, g.parent);
  end loop;

  foreach t in array array['p4ui_design_jobs', 'p4ui_version_meta', 'p4ui_revisions', 'p4ui_screen_specs', 'p4ui_design_blockers', 'p4ui_qa_defects',
                           'p4ui_feedback_routes', 'p4ui_post_lock_requests', 'p4ui_prototype_design_issues']
  loop
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || t, t);
    execute format('alter table projects.%I enable row level security', t);
    execute format('alter table projects.%I force row level security', t);
    execute format('create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))', t || '_select', t);
    execute format('grant select on projects.%I to authenticated, service_role', t);
  end loop;

  foreach t in array array['p4ui_design_jobs', 'p4ui_version_meta', 'p4ui_screen_specs', 'p4ui_qa_defects']
  loop
    execute format('create trigger %I before update on projects.%I for each row execute function core.set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;

-- append-only: a revision record is history
create or replace function projects.p4ui_refuse_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are append-only history', tg_table_name using errcode = 'restrict_violation';
end $$;
create trigger p4ui_revisions_append_only before update or delete on projects.p4ui_revisions
  for each row execute function projects.p4ui_refuse_change();

-- ═══ reads that decide: coverage, requirement trace, completeness ════════════
-- Mirrors handleReviewUIVersion's comparison exactly (baseline screens missing; a state the baseline declares that the version does not address)
create or replace function projects.p4ui_coverage_gaps(p_ui_version_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with v as (
    select x.screens, h.payload
      from projects.ui_versions x
      join projects.phase_three_handoffs h on h.id = x.source_phase_three_handoff_id
     where x.id = p_ui_version_id
  ),
  base as (
    select b.value as scr
      from v, jsonb_array_elements(coalesce(v.payload #> '{screenBaseline,screens}', '[]'::jsonb)) b(value)
     where b.value ->> 'screenKey' is not null
  ),
  drafted as (
    select d.value as scr from v, jsonb_array_elements(v.screens) d(value)
  ),
  missing as (
    select base.scr ->> 'screenKey' as k from base
     where not exists (select 1 from drafted where drafted.scr ->> 'screenKey' = base.scr ->> 'screenKey')
  ),
  gaps as (
    select base.scr ->> 'screenKey' as k, st.name as state_name
      from base
      join drafted on drafted.scr ->> 'screenKey' = base.scr ->> 'screenKey'
      cross join (values ('empty'), ('loading'), ('error'), ('success')) st(name)
     where (base.scr -> 'states' ->> st.name) = 'true'
       and not (coalesce(drafted.scr -> 'statesAddressed', '[]'::jsonb) ? st.name)
  )
  select jsonb_build_object(
    'missingScreens', coalesce((select jsonb_agg(k order by k) from missing), '[]'::jsonb),
    'stateGaps', coalesce((select jsonb_agg(jsonb_build_object('screenKey', k, 'state', state_name) order by k, state_name) from gaps), '[]'::jsonb))
$$;
revoke all on function projects.p4ui_coverage_gaps(uuid) from public, anon;
grant execute on function projects.p4ui_coverage_gaps(uuid) to authenticated, service_role;

-- UID 6.1: every screen maps to a requirement (a Phase 3 scope item), no orphan screens, no included scope item with no screen
create or replace function projects.p4ui_requirement_trace(p_ui_version_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with v as (select x.id, x.project_id, x.screens from projects.ui_versions x where x.id = p_ui_version_id),
  designed as (
    select d.value ->> 'screenKey' as screen_key from v, jsonb_array_elements(v.screens) d(value)
  ),
  mapped as (
    select dz.screen_key, si.id as scope_item_id, si.title
      from designed dz
      join v on true
      join projects.screens s on s.project_id = v.project_id and s.screen_key = dz.screen_key and s.status <> 'superseded'
      join projects.screen_scope_items m on m.screen_id = s.id
      join projects.scope_items si on si.id = m.scope_item_id
  ),
  included as (
    select si.id, si.title
      from v
      join projects.scope_versions sv on sv.project_id = v.project_id and sv.status = 'active'
      join projects.scope_items si on si.scope_version_id = sv.id and si.inclusion = 'included'
  )
  select jsonb_build_object(
    'screens', coalesce((select jsonb_agg(jsonb_build_object('screenKey', dz.screen_key,
        'requirements', coalesce((select jsonb_agg(m.title order by m.title) from mapped m where m.screen_key = dz.screen_key), '[]'::jsonb)) order by dz.screen_key) from designed dz), '[]'::jsonb),
    'orphanScreens', coalesce((select jsonb_agg(dz.screen_key order by dz.screen_key) from designed dz where not exists (select 1 from mapped m where m.screen_key = dz.screen_key)), '[]'::jsonb),
    'uncoveredRequirements', coalesce((select jsonb_agg(i.title order by i.title) from included i where not exists (select 1 from mapped m where m.scope_item_id = i.id)), '[]'::jsonb))
$$;
revoke all on function projects.p4ui_requirement_trace(uuid) from public, anon;
grant execute on function projects.p4ui_requirement_trace(uuid) to authenticated, service_role;

-- What a version still lacks: a spec per screen, the states the baseline requires, the platform variants the Phase 3 screen targets.
create or replace function projects.p4ui_design_completeness(p_ui_version_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with v as (
    select x.id, x.project_id, x.screens, h.payload
      from projects.ui_versions x join projects.phase_three_handoffs h on h.id = x.source_phase_three_handoff_id
     where x.id = p_ui_version_id
  ),
  designed as (
    select d.value ->> 'screenKey' as screen_key,
           array(select jsonb_array_elements_text(coalesce(d.value -> 'statesAddressed', '[]'::jsonb))) as drafted_states
      from v, jsonb_array_elements(v.screens) d(value)
  ),
  base as (
    select b.value ->> 'screenKey' as screen_key,
           array['default'] || array(select st.name from (values ('empty'), ('loading'), ('error'), ('success')) st(name) where (b.value -> 'states' ->> st.name) = 'true') as required_states
      from v, jsonb_array_elements(coalesce(v.payload #> '{screenBaseline,screens}', '[]'::jsonb)) b(value)
  ),
  rows_ as (
    select dz.screen_key,
           sp.id is not null as has_spec,
           array(select rs from unnest(coalesce(bs.required_states, array['default'])) rs
                  where not (rs = any (dz.drafted_states || coalesce(sp.states, '{}')))) as missing_states,
           array(select dev from unnest(coalesce(ps.device_targets, '{}')) dev
                  where dev in ('mobile', 'tablet', 'desktop', 'ios', 'android') and not (dev = any (coalesce(sp.responsive_variants, '{}')))) as missing_variants
      from designed dz
      left join base bs on bs.screen_key = dz.screen_key
      left join projects.p4ui_screen_specs sp on sp.ui_version_id = p_ui_version_id and sp.screen_key = dz.screen_key
      left join projects.screens ps on ps.project_id = (select project_id from v) and ps.screen_key = dz.screen_key
  )
  select jsonb_build_object(
    'screens', coalesce((select jsonb_agg(jsonb_build_object('screenKey', r.screen_key, 'hasSpec', r.has_spec,
        'missingStates', to_jsonb(r.missing_states), 'missingVariants', to_jsonb(r.missing_variants)) order by r.screen_key) from rows_ r), '[]'::jsonb),
    'complete', coalesce((select bool_and(r.has_spec and cardinality(r.missing_states) = 0 and cardinality(r.missing_variants) = 0) from rows_ r), false))
$$;
revoke all on function projects.p4ui_design_completeness(uuid) from public, anon;
grant execute on function projects.p4ui_design_completeness(uuid) to authenticated, service_role;

-- ═══ blockers ═══════════════════════════════════════════════════════════════
create or replace function projects.p4ui_open_design_blocker(
  p_phase_four_id uuid, p_kind text, p_owner_role text, p_reason text, p_resume_condition text,
  p_ui_version_id uuid default null, p_design_job_id uuid default null)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p4      projects.phase_four;
  v_scope   text;
  v_stops   boolean := p_kind in ('ambiguity', 'baseline_missing', 'scope_conflict', 'locked_scope_conflict');
  v_open    uuid;
  v_new     uuid;
begin
  select p4.* into v_p4 from projects.phase_four p4 where p4.id = p_phase_four_id for update;
  if v_p4.id is null then return query select 'unknown_workspace'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_p4.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('ambiguity', 'baseline_missing', 'asset_missing', 'figma_unavailable', 'scope_conflict', 'locked_scope_conflict', 'usability_conflict') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if p_owner_role is null or p_owner_role not in ('pm', 'admin', 'designer', 'client', 'owner') then return query select 'bad_owner'::text, null::uuid; return; end if;
  if coalesce(length(btrim(p_reason)), 0) = 0 or coalesce(length(btrim(p_resume_condition)), 0) = 0 then return query select 'needs_reason_and_resume_condition'::text, null::uuid; return; end if;
  if p_ui_version_id is not null and not exists (select 1 from projects.ui_versions u where u.id = p_ui_version_id and u.phase_four_id = v_p4.id) then
    return query select 'wrong_workspace'::text, null::uuid; return;
  end if;

  -- one open blocker per workspace + kind + version: a replayed event returns it
  select b.id into v_open from projects.p4ui_design_blockers b
   where b.phase_four_id = v_p4.id and b.kind = p_kind and b.status = 'open' and b.ui_version_id is not distinct from p_ui_version_id;
  if v_open is not null then return query select 'exists'::text, v_open; return; end if;

  insert into projects.p4ui_design_blockers (organization_id, project_id, phase_four_id, ui_version_id, design_job_id, kind, owner_role, reason,
                                             resume_condition, stops_phase, resume_state)
  values (v_p4.organization_id, v_p4.project_id, v_p4.id, p_ui_version_id, p_design_job_id, p_kind, p_owner_role, left(btrim(p_reason), 500),
          left(btrim(p_resume_condition), 500), v_stops,
          case when v_stops and v_p4.state not in ('blocked_requirement', 'scope_escalation', 'revision_limit_escalation') then v_p4.state end)
  returning id into v_new;

  if v_stops and v_p4.state not in ('blocked_requirement', 'scope_escalation', 'revision_limit_escalation', 'completed') then
    update projects.phase_four
       set state = case when p_kind in ('scope_conflict', 'locked_scope_conflict') then 'scope_escalation' else 'blocked_requirement' end,
           blocked_reason = left(btrim(p_reason), 500)
     where id = v_p4.id;
  end if;

  perform core.record_audit(v_p4.organization_id, 'ui_design.blocker_opened', 'p4ui_design_blocker', v_new, null,
    jsonb_build_object('projectId', v_p4.project_id, 'kind', p_kind, 'owner', p_owner_role, 'stopsPhase', v_stops));
  perform core.emit_event(v_p4.organization_id, 'project.ui_design_blocker_opened', 'p4ui_design_blocker', v_new,
    jsonb_build_object('projectId', v_p4.project_id, 'kind', p_kind, 'owner', p_owner_role));
  return query select 'opened'::text, v_new;
end $$;
revoke all on function projects.p4ui_open_design_blocker(uuid, text, text, text, text, uuid, uuid) from public, anon;
grant execute on function projects.p4ui_open_design_blocker(uuid, text, text, text, text, uuid, uuid) to authenticated, service_role;

-- A blocker is resumed by a person: the service role (an agent) cannot clear its own stop.
create or replace function projects.p4ui_resolve_design_blocker(p_blocker_id uuid, p_note text)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_b      projects.p4ui_design_blockers;
  v_scope  text;
  v_others int;
begin
  select b.* into v_b from projects.p4ui_design_blockers b where b.id = p_blocker_id for update;
  if v_b.id is null then return query select 'unknown_blocker'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_b.organization_id);
  if v_scope not in ('person', 'admin') then return query select case when v_scope = 'service' then 'person_required' else v_scope end, null::uuid; return; end if;
  if v_b.status <> 'open' then return query select 'already_resolved'::text, v_b.id; return; end if;
  if coalesce(length(btrim(p_note)), 0) = 0 then return query select 'needs_note'::text, null::uuid; return; end if;

  update projects.p4ui_design_blockers
     set status = 'resolved', resolved_by = (select auth.uid()), resolved_at = now(), resolution_note = left(btrim(p_note), 500)
   where id = v_b.id;

  select count(*) into v_others from projects.p4ui_design_blockers o
   where o.phase_four_id = v_b.phase_four_id and o.status = 'open' and o.stops_phase and o.id <> v_b.id;

  -- restore the state this blocker stopped, only when it was the last stop and the workspace is still in the state the stop put it in
  if v_b.stops_phase and v_others = 0 and v_b.resume_state is not null then
    update projects.phase_four set state = v_b.resume_state, blocked_reason = null
     where id = v_b.phase_four_id and state in ('blocked_requirement', 'scope_escalation');
  end if;

  perform core.record_audit(v_b.organization_id, 'ui_design.blocker_resolved', 'p4ui_design_blocker', v_b.id, null,
    jsonb_build_object('projectId', v_b.project_id, 'kind', v_b.kind));
  return query select 'resolved'::text, v_b.id;
end $$;
revoke all on function projects.p4ui_resolve_design_blocker(uuid, text) from public, anon;
grant execute on function projects.p4ui_resolve_design_blocker(uuid, text) to authenticated, service_role;

-- ═══ the activation door ════════════════════════════════════════════════════
create or replace function projects.p4ui_request_design_job(
  p_phase_four_id uuid, p_trigger text,
  p_source_ui_version_id uuid default null, p_request text default null,
  p_change_set jsonb default '[]'::jsonb, p_evidence_id uuid default null)
returns table (outcome text, ref_id uuid, route_to text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p4      projects.phase_four;
  v_scope   text;
  v_src     projects.ui_versions;
  v_latest  projects.ui_versions;
  v_norm    text := lower(regexp_replace(btrim(coalesce(p_request, '')), '\s+', ' ', 'g'));
  v_key     text;
  v_existing projects.p4ui_design_jobs;
  v_route   text;
  v_gaps    jsonb;
  v_scopev  int;
  v_new     uuid;
  v_reasons text[] := array['initial_phase_four', 'missing_approved_ui', 'design_qa_defect', 'admin_edit', 'client_visual_revision', 'approved_scope_change', 'source_ui_design_defect'];
  v_cr_ok   boolean;
  v_change  jsonb := coalesce(p_change_set, '[]'::jsonb);
begin
  select p4.* into v_p4 from projects.phase_four p4 where p4.id = p_phase_four_id for update;
  if v_p4.id is null then return query select 'unknown_workspace'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_p4.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  if jsonb_typeof(v_change) <> 'array' then return query select 'bad_change_set'::text, null::uuid, null::text; return; end if;
  if p_trigger is null or length(btrim(p_trigger)) = 0 then return query select 'needs_trigger'::text, null::uuid, null::text; return; end if;

  v_key := md5(concat_ws('|', v_p4.id::text, p_trigger, coalesce(p_source_ui_version_id::text, ''), v_norm, coalesce(p_evidence_id::text, '')));
  select j.* into v_existing from projects.p4ui_design_jobs j where j.organization_id = v_p4.organization_id and j.idempotency_key = v_key;
  if v_existing.id is not null then return query select 'exists'::text, v_existing.id, v_existing.route_to; return; end if;

  if p_source_ui_version_id is not null then
    select u.* into v_src from projects.ui_versions u where u.id = p_source_ui_version_id and u.phase_four_id = v_p4.id;
    if v_src.id is null then return query select 'wrong_workspace'::text, null::uuid, null::text; return; end if;
  end if;
  select u.* into v_latest from projects.ui_versions u where u.phase_four_id = v_p4.id order by u.version desc limit 1;

  -- 1. not a design condition at all: recorded as a refusal that says who owns it (UID 10 / 26), never silently dropped
  if not (p_trigger = any (v_reasons)) then
    v_route := case p_trigger
      when 'prototype_code_bug' then 'Prototype Agent fixes it'
      when 'backend_api_problem' then 'backend / Phase 5 owner'
      when 'payment_issue' then 'Finance'
      when 'communication_delivery_issue' then 'PM communication retry (never repeats the business transition)'
      when 'ambiguous_business_rule' then 'PM clarification: internal, PM, client, PM, the original workflow'
      when 'unapproved_new_feature' then 'Requirements / scope Change Request; the Designer activates only after it is approved'
      when 'duplicate_or_replayed_event' then 'nothing: the existing result is returned'
      when 'production_logic_problem' then 'Phase 5 development'
      when 'phase_five_coding_task' then 'Phase 5 development'
      else 'PM, to classify it' end;
    insert into projects.p4ui_design_jobs (organization_id, project_id, phase_four_id, status, source_ui_version_id, request_text, idempotency_key,
                                           refused_trigger, refusal_reason, route_to, requested_by)
    values (v_p4.organization_id, v_p4.project_id, v_p4.id, 'refused', v_src.id, nullif(left(btrim(coalesce(p_request, '')), 4000), ''), v_key, p_trigger,
            case when p_trigger = any (array['prototype_code_bug', 'backend_api_problem', 'payment_issue', 'communication_delivery_issue', 'ambiguous_business_rule',
                   'unapproved_new_feature', 'duplicate_or_replayed_event', 'production_logic_problem', 'phase_five_coding_task'])
                 then p_trigger || ' is not a design condition' else p_trigger || ' is not one of the valid activation conditions' end,
            v_route, (select auth.uid()))
    returning id into v_new;
    if p_trigger = 'ambiguous_business_rule' then
      insert into projects.clarification_requests (organization_id, project_id, ui_version_id, question)
      values (v_p4.organization_id, v_p4.project_id, v_src.id, left(coalesce(nullif(btrim(coalesce(p_request, '')), ''), 'A business rule the design depends on is ambiguous.'), 2000));
      perform projects.p4ui_open_design_blocker(v_p4.id, 'ambiguity', 'pm', coalesce(nullif(btrim(coalesce(p_request, '')), ''), 'A business rule the design depends on is ambiguous.'),
        'The PM obtains a clear answer from the client and a person resolves this blocker', v_src.id, v_new);
    end if;
    perform core.record_audit(v_p4.organization_id, 'ui_design.activation_refused', 'p4ui_design_job', v_new, null,
      jsonb_build_object('projectId', v_p4.project_id, 'trigger', p_trigger, 'routeTo', v_route));
    return query select 'refused'::text, v_new, v_route; return;
  end if;

  -- 2. the workspace is stopped
  if v_p4.state in ('completed', 'revision_limit_escalation') then return query select 'phase_stopped'::text, null::uuid, null::text; return; end if;
  if v_p4.state in ('scope_escalation', 'blocked_requirement') and p_trigger <> 'approved_scope_change' then
    return query select 'phase_blocked'::text, null::uuid, null::text; return;
  end if;

  -- 3. a locked UI is never overwritten: only an approved scope change or a confirmed source-UI defect may re-open it
  if v_latest.id is not null and v_latest.status = 'locked' and p_trigger not in ('approved_scope_change', 'source_ui_design_defect') then
    insert into projects.p4ui_design_jobs (organization_id, project_id, phase_four_id, status, source_ui_version_id, request_text, idempotency_key,
                                           refused_trigger, refusal_reason, route_to, requested_by)
    values (v_p4.organization_id, v_p4.project_id, v_p4.id, 'refused', v_latest.id, nullif(left(btrim(coalesce(p_request, '')), 4000), ''), v_key, 'locked_ui_overwrite',
            'the UI version is locked; "' || p_trigger || '" cannot change it', 'Admin: a post-lock revision request, or a Change Request', (select auth.uid()))
    returning id into v_new;
    perform core.record_audit(v_p4.organization_id, 'ui_design.activation_refused', 'p4ui_design_job', v_new, null,
      jsonb_build_object('projectId', v_p4.project_id, 'trigger', 'locked_ui_overwrite', 'attempted', p_trigger));
    return query select 'locked'::text, v_new, 'Admin: a post-lock revision request, or a Change Request'::text; return;
  end if;

  -- 4. each reason has its own precondition
  if p_trigger = 'initial_phase_four' then
    if v_latest.id is not null then return query select 'already_designed'::text, v_latest.id, null::text; return; end if;
    if v_p4.state not in ('task2_started', 'not_started') then return query select 'wrong_state'::text, null::uuid, null::text; return; end if;
    if jsonb_array_length(coalesce((select h.payload #> '{screenBaseline,screens}' from projects.phase_three_handoffs h where h.id = v_p4.phase_three_handoff_id), '[]'::jsonb)) = 0 then
      perform projects.p4ui_open_design_blocker(v_p4.id, 'baseline_missing', 'admin', 'The locked Phase 3 baseline names no screens to design.',
        'The Phase 3 screen baseline is repaired and a person resolves this blocker');
      return query select 'baseline_missing'::text, null::uuid, null::text; return;
    end if;
  elsif v_src.id is null then
    return query select 'needs_source_version'::text, null::uuid, null::text; return;
  elsif p_trigger = 'missing_approved_ui' then
    v_gaps := projects.p4ui_coverage_gaps(v_src.id);
    if jsonb_array_length(v_gaps -> 'missingScreens') = 0 and jsonb_array_length(v_gaps -> 'stateGaps') = 0 then
      return query select 'no_gap_confirmed'::text, null::uuid, null::text; return;
    end if;
    v_change := jsonb_build_array(v_gaps);
  elsif p_trigger = 'design_qa_defect' then
    if v_src.status <> 'qa_changes_required' or v_src.id <> v_latest.id then return query select 'not_returned'::text, null::uuid, null::text; return; end if;
  elsif p_trigger = 'admin_edit' then
    if v_src.status <> 'admin_edit' or v_src.id <> v_latest.id then return query select 'not_returned'::text, null::uuid, null::text; return; end if;
  elsif p_trigger = 'client_visual_revision' then
    if v_src.status <> 'client_change' or v_src.id <> v_latest.id then return query select 'not_returned'::text, null::uuid, null::text; return; end if;
    if not exists (select 1 from projects.p4ui_feedback_routes r where r.ui_version_id = v_src.id) then
      return query select 'classification_required'::text, null::uuid, 'PM: classify the client''s feedback first'::text; return;
    end if;
    if not exists (select 1 from projects.p4ui_feedback_routes r where r.ui_version_id = v_src.id and r.route = 'design_revision') then
      return query select 'not_a_design_revision'::text, null::uuid, (select r.route from projects.p4ui_feedback_routes r where r.ui_version_id = v_src.id); return;
    end if;
  elsif p_trigger = 'approved_scope_change' then
    -- an approved Change Request of this project, or an Admin-approved post-lock request for this version
    v_cr_ok := exists (select 1 from projects.change_requests c where c.id = p_evidence_id and c.project_id = v_p4.project_id and c.status in ('approved', 'implemented'))
            or exists (select 1 from projects.p4ui_post_lock_requests r where r.id = p_evidence_id and r.ui_version_id = v_src.id and r.status = 'approved');
    if not coalesce(v_cr_ok, false) then return query select 'no_approved_change'::text, null::uuid, 'Requirements: an approved Change Request first'::text; return; end if;
  elsif p_trigger = 'source_ui_design_defect' then
    if not exists (select 1 from projects.p4ui_prototype_design_issues i
                    where i.id = p_evidence_id and i.project_id = v_p4.project_id and i.status = 'confirmed' and i.classification = 'source_ui_defect' and i.ui_version_id = v_src.id) then
      return query select 'no_confirmed_issue'::text, null::uuid, 'Prototype QA: a person must confirm the source-UI defect first'::text; return;
    end if;
  end if;

  select max(sv.version) into v_scopev from projects.scope_versions sv where sv.project_id = v_p4.project_id and sv.status = 'active';

  insert into projects.p4ui_design_jobs (organization_id, project_id, phase_four_id, activation_reason, status, source_ui_version_id, scope_version, change_set,
                                         request_text, evidence_id, idempotency_key, requested_by)
  values (v_p4.organization_id, v_p4.project_id, v_p4.id, p_trigger, 'requested', v_src.id, v_scopev, v_change,
          nullif(left(btrim(coalesce(p_request, '')), 4000), ''), p_evidence_id, v_key, (select auth.uid()))
  returning id into v_new;

  perform core.record_audit(v_p4.organization_id, 'ui_design.job_requested', 'p4ui_design_job', v_new, null,
    jsonb_build_object('projectId', v_p4.project_id, 'reason', p_trigger, 'sourceUiVersionId', v_src.id, 'scopeVersion', v_scopev));
  perform core.emit_event(v_p4.organization_id, 'project.ui_design_job_requested', 'p4ui_design_job', v_new,
    jsonb_build_object('projectId', v_p4.project_id, 'reason', p_trigger));
  if p_trigger = 'missing_approved_ui' then
    perform core.emit_event(v_p4.organization_id, 'project.ui_coverage_gap_confirmed', 'p4ui_design_job', v_new,
      jsonb_build_object('projectId', v_p4.project_id, 'uiVersionId', v_src.id));
  elsif p_trigger = 'approved_scope_change' then
    perform core.emit_event(v_p4.organization_id, 'project.ui_scope_change_approved', 'p4ui_design_job', v_new,
      jsonb_build_object('projectId', v_p4.project_id, 'uiVersionId', v_src.id));
  end if;
  return query select 'requested'::text, v_new, null::text;
end $$;
revoke all on function projects.p4ui_request_design_job(uuid, text, uuid, text, jsonb, uuid) from public, anon;
grant execute on function projects.p4ui_request_design_job(uuid, text, uuid, text, jsonb, uuid) to authenticated, service_role;

-- ═══ lineage: derived, never remembered ════════════════════════════════════
create or replace function projects.p4ui_derive_version_meta(p_ui_version_id uuid, p_change_summary text default null, p_design_job_id uuid default null)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v       projects.ui_versions;
  v_parent  projects.ui_versions;
  v_job     projects.p4ui_design_jobs;
  v_scope   text;
  v_origin  text;
  v_reason  text;
  v_changed text[];
  v_added   text[];
  v_removed text[];
  v_changed_content boolean;
  v_summary text;
  v_evidence jsonb := '{}'::jsonb;
  v_scopev  int;
  v_decision record;
  v_defects jsonb;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  if exists (select 1 from projects.p4ui_version_meta m where m.ui_version_id = v_v.id) then return query select 'exists'::text, v_v.id, null::text; return; end if;

  if p_design_job_id is not null then
    select j.* into v_job from projects.p4ui_design_jobs j where j.id = p_design_job_id and j.phase_four_id = v_v.phase_four_id;
    if v_job.id is null then return query select 'unknown_job'::text, null::uuid, null::text; return; end if;
  end if;

  select u.* into v_parent from projects.ui_versions u where u.phase_four_id = v_v.phase_four_id and u.version < v_v.version order by u.version desc limit 1;

  if v_parent.id is not null then
    -- the parent's status when the child was made says why the child exists; a locked parent needs the job's reason
    v_origin := case v_parent.status
      when 'qa_changes_required' then 'qa_defect'
      when 'admin_edit' then 'admin_edit'
      when 'client_change' then 'client_change'
      when 'locked' then case when v_job.activation_reason = 'source_ui_design_defect' then 'source_ui_defect' else 'scope_change' end
      else case when v_job.activation_reason = 'missing_approved_ui' then 'coverage_gap' else 'client_change' end end;
    if v_job.activation_reason is not null then
      v_reason := v_job.activation_reason;
    else
      v_reason := case v_origin when 'qa_defect' then 'design_qa_defect' when 'admin_edit' then 'admin_edit' when 'client_change' then 'client_visual_revision'
                                when 'source_ui_defect' then 'source_ui_design_defect' when 'scope_change' then 'approved_scope_change' else 'missing_approved_ui' end;
    end if;

    with cur as (select e.value ->> 'screenKey' as k, e.value as body from jsonb_array_elements(v_v.screens) e(value)),
         prev as (select e.value ->> 'screenKey' as k, e.value as body from jsonb_array_elements(v_parent.screens) e(value))
    select coalesce(array_agg(cur.k order by cur.k) filter (where prev.k is not null and prev.body <> cur.body), '{}'),
           coalesce(array_agg(cur.k order by cur.k) filter (where prev.k is null), '{}')
      into v_changed, v_added
      from cur left join prev on prev.k = cur.k;
    select coalesce(array_agg(prev.k order by prev.k), '{}') into v_removed
      from (select e.value ->> 'screenKey' as k from jsonb_array_elements(v_parent.screens) e(value)) prev
     where not exists (select 1 from jsonb_array_elements(v_v.screens) e(value) where e.value ->> 'screenKey' = prev.k);
    v_changed_content := cardinality(v_changed) + cardinality(v_added) + cardinality(v_removed) > 0;

    if v_origin = 'qa_defect' then
      select coalesce(jsonb_agg(d.id order by d.created_at), '[]'::jsonb) into v_defects from projects.p4ui_qa_defects d where d.ui_version_id = v_parent.id and d.status in ('open', 'reopened');
      v_evidence := jsonb_build_object('defectIds', v_defects, 'qaFindings', v_parent.qa_findings);
      -- the fix is a CLAIM: the defects become fix_ready against this version, never verified by the Designer
      update projects.p4ui_qa_defects set status = 'fix_ready', fix_ui_version_id = v_v.id, fix_ready_by = (select auth.uid()), fix_ready_at = now()
       where ui_version_id = v_parent.id and status in ('open', 'reopened');
    elsif v_origin = 'admin_edit' then
      select r.decision_note, r.decided_at into v_decision from approvals.approval_requests r
       where r.organization_id = v_v.organization_id and r.subject_type = 'ui_version' and r.subject_id = v_parent.id and r.state <> 'pending'
       order by r.decided_at desc limit 1;
      v_evidence := jsonb_build_object('adminNote', v_decision.decision_note, 'decidedAt', v_decision.decided_at);
    elsif v_origin = 'client_change' then
      select d.client_words, d.evidence_ref, d.created_at into v_decision from projects.ui_version_client_decisions d
       where d.ui_version_id = v_parent.id and d.decision = 'change_requested' order by d.created_at desc limit 1;
      v_evidence := jsonb_build_object('clientWords', v_decision.client_words, 'evidenceRef', v_decision.evidence_ref, 'at', v_decision.created_at,
        'classification', (select r.classification from projects.p4ui_feedback_routes r where r.ui_version_id = v_parent.id));
    elsif v_job.id is not null then
      v_evidence := jsonb_build_object('designJobId', v_job.id, 'evidenceId', v_job.evidence_id);
    end if;
  else
    v_origin := 'initial'; v_reason := 'initial_phase_four';
    v_changed := '{}'; v_removed := '{}'; v_changed_content := true;
    select coalesce(array_agg(e.value ->> 'screenKey' order by e.value ->> 'screenKey'), '{}') into v_added from jsonb_array_elements(v_v.screens) e(value);
  end if;

  v_summary := coalesce(nullif(left(btrim(coalesce(p_change_summary, '')), 2000), ''),
    case when v_parent.id is null then 'Initial UI: ' || cardinality(v_added) || ' screen(s) designed from the locked Phase 3 baseline.'
         when not v_changed_content then 'No screen content changed from version ' || v_parent.version || '.'
         else 'From version ' || v_parent.version || ': changed ' || coalesce(nullif(array_to_string(v_changed, ', '), ''), 'none')
              || '; added ' || coalesce(nullif(array_to_string(v_added, ', '), ''), 'none')
              || '; removed ' || coalesce(nullif(array_to_string(v_removed, ', '), ''), 'none') || '.' end);

  select max(sv.version) into v_scopev from projects.scope_versions sv where sv.project_id = v_v.project_id and sv.status = 'active';

  insert into projects.p4ui_version_meta (ui_version_id, organization_id, project_id, parent_ui_version_id, design_job_id, activation_reason, origin, scope_version,
                                          changed_screens, added_screens, removed_screens, content_changed, change_summary)
  values (v_v.id, v_v.organization_id, v_v.project_id, v_parent.id, v_job.id, v_reason, v_origin, v_scopev, v_changed, v_added, v_removed, v_changed_content, v_summary);

  if v_parent.id is not null then
    insert into projects.p4ui_revisions (organization_id, project_id, phase_four_id, from_ui_version_id, to_ui_version_id, design_job_id, origin, evidence,
                                         affected_screens, summary)
    values (v_v.organization_id, v_v.project_id, v_v.phase_four_id, v_parent.id, v_v.id, v_job.id, v_origin, v_evidence,
            v_changed || v_added || v_removed, v_summary);
  end if;

  perform core.record_audit(v_v.organization_id, 'ui_design.version_lineage_recorded', 'ui_version', v_v.id, null,
    jsonb_build_object('projectId', v_v.project_id, 'origin', v_origin, 'reason', v_reason, 'contentChanged', v_changed_content));
  return query select case when v_changed_content then 'recorded' else 'no_content_change' end, v_v.id, v_summary;
end $$;
revoke all on function projects.p4ui_derive_version_meta(uuid, text, uuid) from public, anon;
grant execute on function projects.p4ui_derive_version_meta(uuid, text, uuid) to authenticated, service_role;

-- the job is delivered by the version it produced
create or replace function projects.p4ui_complete_design_job(p_job_id uuid, p_ui_version_id uuid)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_j     projects.p4ui_design_jobs;
  v_v     projects.ui_versions;
  v_src   projects.ui_versions;
  v_scope text;
begin
  select j.* into v_j from projects.p4ui_design_jobs j where j.id = p_job_id for update;
  if v_j.id is null then return query select 'unknown_job'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_j.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if v_j.status = 'delivered' then return query select 'already_delivered'::text, v_j.result_ui_version_id; return; end if;
  if v_j.status not in ('requested', 'running') then return query select 'not_open'::text, null::uuid; return; end if;
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id and u.phase_four_id = v_j.phase_four_id;
  if v_v.id is null then return query select 'wrong_workspace'::text, null::uuid; return; end if;
  if v_j.source_ui_version_id is not null then
    select u.* into v_src from projects.ui_versions u where u.id = v_j.source_ui_version_id;
    if v_v.version <= v_src.version then return query select 'not_a_newer_version'::text, null::uuid; return; end if;
  end if;
  update projects.p4ui_design_jobs set status = 'delivered', result_ui_version_id = v_v.id where id = v_j.id;
  perform core.record_audit(v_j.organization_id, 'ui_design.job_delivered', 'p4ui_design_job', v_j.id, null,
    jsonb_build_object('projectId', v_j.project_id, 'uiVersionId', v_v.id, 'reason', v_j.activation_reason));
  return query select 'delivered'::text, v_j.id;
end $$;
revoke all on function projects.p4ui_complete_design_job(uuid, uuid) from public, anon;
grant execute on function projects.p4ui_complete_design_job(uuid, uuid) to authenticated, service_role;

-- A governed NEW version for a re-opened LOCKED UI (approved scope change or confirmed source-UI defect). The locked row is untouched.
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

-- ═══ Figma references (recorded by a person or the plugin import; never written from here) ═══
create or replace function projects.p4ui_record_figma_refs(
  p_ui_version_id uuid, p_file_ref text, p_page_ref text default null, p_node_refs jsonb default '{}'::jsonb, p_preview_url text default null,
  p_replace_reason text default null)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v     projects.ui_versions;
  v_m     projects.p4ui_version_meta;
  v_scope text;
  v_bad   text;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope not in ('person', 'admin') then return query select case when v_scope = 'service' then 'person_required' else v_scope end, null::uuid; return; end if;
  select m.* into v_m from projects.p4ui_version_meta m where m.ui_version_id = v_v.id for update;
  if v_m.ui_version_id is null then return query select 'no_lineage_yet'::text, null::uuid; return; end if;
  if v_v.status = 'locked' then return query select 'locked'::text, null::uuid; return; end if;
  if coalesce(length(btrim(p_file_ref)), 0) = 0 then return query select 'needs_file_ref'::text, null::uuid; return; end if;
  if p_node_refs is null or jsonb_typeof(p_node_refs) <> 'object' then return query select 'bad_node_refs'::text, null::uuid; return; end if;
  -- a node reference may name only a screen this version designs
  select k into v_bad from jsonb_object_keys(p_node_refs) k
   where not exists (select 1 from jsonb_array_elements(v_v.screens) e(value) where e.value ->> 'screenKey' = k) limit 1;
  if v_bad is not null then return query select 'unknown_screen'::text, null::uuid; return; end if;
  -- no silent replace (UID 13): a different file reference needs a stated reason
  if v_m.figma_file_ref is not null and v_m.figma_file_ref <> btrim(p_file_ref) and coalesce(length(btrim(p_replace_reason)), 0) = 0 then
    return query select 'would_replace'::text, v_v.id; return;
  end if;
  update projects.p4ui_version_meta
     set figma_state = 'linked', figma_file_ref = btrim(p_file_ref), figma_page_ref = nullif(btrim(coalesce(p_page_ref, '')), ''),
         figma_node_refs = p_node_refs, figma_preview_url = nullif(btrim(coalesce(p_preview_url, '')), ''), figma_write_state = 'manual_required'
   where ui_version_id = v_v.id;
  perform core.record_audit(v_v.organization_id, 'ui_design.figma_refs_recorded', 'ui_version', v_v.id, null,
    jsonb_build_object('projectId', v_v.project_id, 'replaced', v_m.figma_file_ref is not null and v_m.figma_file_ref <> btrim(p_file_ref), 'reason', nullif(btrim(coalesce(p_replace_reason, '')), '')));
  return query select 'recorded'::text, v_v.id;
end $$;
revoke all on function projects.p4ui_record_figma_refs(uuid, text, text, jsonb, text, text) from public, anon;
grant execute on function projects.p4ui_record_figma_refs(uuid, text, text, jsonb, text, text) to authenticated, service_role;

-- when Figma cannot be reached or written, say so on the version (a blocker is opened when the design source is what is missing)
create or replace function projects.p4ui_mark_figma_unavailable(p_ui_version_id uuid, p_write_state text, p_reason text)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v     projects.ui_versions;
  v_scope text;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if p_write_state not in ('environment_missing', 'manual_required') then return query select 'bad_write_state'::text, null::uuid; return; end if;
  if coalesce(length(btrim(p_reason)), 0) = 0 then return query select 'needs_reason'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.p4ui_version_meta m where m.ui_version_id = v_v.id) then return query select 'no_lineage_yet'::text, null::uuid; return; end if;
  update projects.p4ui_version_meta set figma_write_state = p_write_state,
         figma_state = case when figma_state = 'linked' then 'linked' else 'unavailable' end
   where ui_version_id = v_v.id;
  perform projects.p4ui_open_design_blocker(v_v.phase_four_id, 'figma_unavailable', 'admin', left(btrim(p_reason), 500),
    'A person links the Figma file by hand, or Figma credentials are supplied', v_v.id);
  return query select 'recorded'::text, v_v.id;
end $$;
revoke all on function projects.p4ui_mark_figma_unavailable(uuid, text, text) from public, anon;
grant execute on function projects.p4ui_mark_figma_unavailable(uuid, text, text) to authenticated, service_role;

-- ═══ screen specs ═══════════════════════════════════════════════════════════
create or replace function projects.p4ui_record_screen_spec(p_ui_version_id uuid, p_screen_key text, p_spec jsonb)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v     projects.ui_versions;
  v_scope text;
  v_id    uuid;
  v_exist uuid;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then return query select 'bad_spec'::text, null::uuid; return; end if;
  -- only a screen this version designs: an invented key is refused (the same rule the draft workflow applies)
  if not exists (select 1 from jsonb_array_elements(v_v.screens) e(value) where e.value ->> 'screenKey' = p_screen_key) then
    return query select 'unknown_screen'::text, null::uuid; return;
  end if;
  -- insert-if-absent until the Admin sees it; overwrite only while it is a draft (a verified version is not rewritten under QA)
  if v_v.status not in ('draft', 'qa_review', 'qa_pass', 'qa_changes_required') then return query select 'version_past_design'::text, null::uuid; return; end if;
  select s.id into v_exist from projects.p4ui_screen_specs s where s.ui_version_id = v_v.id and s.screen_key = p_screen_key;
  if v_exist is not null and v_v.status <> 'draft' then return query select 'version_not_draft'::text, v_exist; return; end if;

  begin
    insert into projects.p4ui_screen_specs (organization_id, project_id, ui_version_id, screen_key, purpose, entry_points, exit_points, data_shown, actions, validation_rules,
                                            states, responsive_variants, role_variants, tokens_used, node_ref)
    values (v_v.organization_id, v_v.project_id, v_v.id, p_screen_key,
            nullif(left(btrim(coalesce(p_spec ->> 'purpose', '')), 500), ''),
            coalesce(array(select jsonb_array_elements_text(coalesce(p_spec -> 'entryPoints', '[]'::jsonb))), '{}'),
            coalesce(array(select jsonb_array_elements_text(coalesce(p_spec -> 'exitPoints', '[]'::jsonb))), '{}'),
            coalesce(array(select jsonb_array_elements_text(coalesce(p_spec -> 'dataShown', '[]'::jsonb))), '{}'),
            coalesce(array(select jsonb_array_elements_text(coalesce(p_spec -> 'actions', '[]'::jsonb))), '{}'),
            coalesce(array(select jsonb_array_elements_text(coalesce(p_spec -> 'validationRules', '[]'::jsonb))), '{}'),
            coalesce(array(select jsonb_array_elements_text(coalesce(p_spec -> 'states', '[]'::jsonb))), '{}'),
            coalesce(array(select jsonb_array_elements_text(coalesce(p_spec -> 'responsiveVariants', '[]'::jsonb))), '{}'),
            coalesce(p_spec -> 'roleVariants', '[]'::jsonb),
            coalesce(array(select jsonb_array_elements_text(coalesce(p_spec -> 'tokensUsed', '[]'::jsonb))), '{}'),
            nullif(btrim(coalesce(p_spec ->> 'nodeRef', '')), ''))
    on conflict (ui_version_id, screen_key) do update
      set purpose = excluded.purpose, entry_points = excluded.entry_points, exit_points = excluded.exit_points, data_shown = excluded.data_shown,
          actions = excluded.actions, validation_rules = excluded.validation_rules, states = excluded.states, responsive_variants = excluded.responsive_variants,
          role_variants = excluded.role_variants, tokens_used = excluded.tokens_used, node_ref = excluded.node_ref
    returning id into v_id;
  exception when check_violation or invalid_text_representation or invalid_parameter_value then
    return query select 'bad_spec'::text, null::uuid; return;
  end;
  return query select case when v_exist is null then 'recorded' else 'updated' end, v_id;
end $$;
revoke all on function projects.p4ui_record_screen_spec(uuid, text, jsonb) from public, anon;
grant execute on function projects.p4ui_record_screen_spec(uuid, text, jsonb) to authenticated, service_role;

-- ═══ Design QA defects: found, fix_ready (a claim), verified (only by a QA verdict) ═══
create or replace function projects.p4ui_open_qa_defect(p_ui_version_id uuid, p_screen_key text, p_category text, p_description text, p_severity text default 'major')
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v     projects.ui_versions;
  v_scope text;
  v_dup   uuid;
  v_new   uuid;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if p_category not in ('missing_screen', 'missing_state', 'token', 'accessibility', 'content', 'other') then return query select 'bad_category'::text, null::uuid; return; end if;
  if p_severity not in ('minor', 'major', 'blocker') then return query select 'bad_severity'::text, null::uuid; return; end if;
  if coalesce(length(btrim(p_description)), 0) = 0 then return query select 'needs_description'::text, null::uuid; return; end if;
  if p_screen_key is not null and not exists (select 1 from jsonb_array_elements(v_v.screens) e(value) where e.value ->> 'screenKey' = p_screen_key)
     and p_category <> 'missing_screen' then return query select 'unknown_screen'::text, null::uuid; return; end if;
  -- a replayed finding is the same defect
  select d.id into v_dup from projects.p4ui_qa_defects d
   where d.ui_version_id = v_v.id and d.screen_key is not distinct from p_screen_key and d.category = p_category and d.description = left(btrim(p_description), 1000);
  if v_dup is not null then return query select 'exists'::text, v_dup; return; end if;
  insert into projects.p4ui_qa_defects (organization_id, project_id, ui_version_id, screen_key, category, description, severity)
  values (v_v.organization_id, v_v.project_id, v_v.id, p_screen_key, p_category, left(btrim(p_description), 1000), p_severity) returning id into v_new;
  return query select 'opened'::text, v_new;
end $$;
revoke all on function projects.p4ui_open_qa_defect(uuid, text, text, text, text) from public, anon;
grant execute on function projects.p4ui_open_qa_defect(uuid, text, text, text, text) to authenticated, service_role;

-- Turns the verdict Design QA already stored (missingScreens / stateGaps) into defect rows. Idempotent.
create or replace function projects.p4ui_import_qa_findings(p_ui_version_id uuid)
returns table (outcome text, ref_id uuid, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v     projects.ui_versions;
  v_scope text;
  v_n     int := 0;
  k       text;
  g       text;
  r       record;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  if v_v.status <> 'qa_changes_required' or v_v.qa_findings is null then return query select 'nothing_to_import'::text, v_v.id, null::text; return; end if;
  if jsonb_typeof(v_v.qa_findings) = 'object' then
    for k in select jsonb_array_elements_text(coalesce(v_v.qa_findings -> 'missingScreens', '[]'::jsonb)) loop
      if not exists (select 1 from projects.p4ui_qa_defects d where d.ui_version_id = v_v.id and d.category = 'missing_screen' and d.screen_key = k) then
        insert into projects.p4ui_qa_defects (organization_id, project_id, ui_version_id, screen_key, category, description, severity)
        values (v_v.organization_id, v_v.project_id, v_v.id, k, 'missing_screen', 'The locked baseline screen ' || k || ' is not designed.', 'blocker');
        v_n := v_n + 1;
      end if;
    end loop;
    for g in select jsonb_array_elements_text(coalesce(v_v.qa_findings -> 'stateGaps', '[]'::jsonb)) loop
      if not exists (select 1 from projects.p4ui_qa_defects d where d.ui_version_id = v_v.id and d.category = 'missing_state' and d.description = left(g, 1000)) then
        insert into projects.p4ui_qa_defects (organization_id, project_id, ui_version_id, screen_key, category, description, severity)
        values (v_v.organization_id, v_v.project_id, v_v.id, nullif(split_part(g, ' ', 1), ''), 'missing_state', left(g, 1000), 'major');
        v_n := v_n + 1;
      end if;
    end loop;
  elsif jsonb_typeof(v_v.qa_findings) = 'array' then
    for r in select e.value as body from jsonb_array_elements(v_v.qa_findings) e(value) loop
      if not exists (select 1 from projects.p4ui_qa_defects d where d.ui_version_id = v_v.id and d.description = left(coalesce(r.body ->> 'defect', r.body #>> '{}'), 1000)) then
        insert into projects.p4ui_qa_defects (organization_id, project_id, ui_version_id, category, description)
        values (v_v.organization_id, v_v.project_id, v_v.id, 'other', left(coalesce(r.body ->> 'defect', r.body #>> '{}'), 1000));
        v_n := v_n + 1;
      end if;
    end loop;
  end if;
  return query select 'imported'::text, v_v.id, v_n::text;
end $$;
revoke all on function projects.p4ui_import_qa_findings(uuid) from public, anon;
grant execute on function projects.p4ui_import_qa_findings(uuid) to authenticated, service_role;

-- The retest. verified needs a QA verdict (qa_pass or beyond) on the FIX version, and the fix's producer cannot be the one who verifies it.
create or replace function projects.p4ui_record_defect_retest(p_defect_id uuid, p_passed boolean, p_note text default null)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d     projects.p4ui_qa_defects;
  v_fix   projects.ui_versions;
  v_scope text;
begin
  select d.* into v_d from projects.p4ui_qa_defects d where d.id = p_defect_id for update;
  if v_d.id is null then return query select 'unknown_defect'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_d.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if v_d.status <> 'fix_ready' then return query select 'not_fix_ready'::text, v_d.id; return; end if;
  select u.* into v_fix from projects.ui_versions u where u.id = v_d.fix_ui_version_id;
  -- the Designer's "fixed" is not a verdict: the fix version must have been through Design QA
  if v_fix.status in ('draft', 'qa_review') then return query select 'fix_not_reviewed_by_qa'::text, v_d.id; return; end if;
  if v_scope in ('person', 'admin') and v_fix.produced_by is not distinct from (select auth.uid()) then
    return query select 'self_review'::text, v_d.id; return;
  end if;
  if p_passed and v_fix.status = 'qa_changes_required' then return query select 'qa_failed_the_fix'::text, v_d.id; return; end if;
  update projects.p4ui_qa_defects
     set status = case when p_passed then 'verified' else 'reopened' end,
         verified_by = case when p_passed then (select auth.uid()) end,
         verified_at = case when p_passed then now() end,
         fix_ui_version_id = case when p_passed then fix_ui_version_id else null end,
         fix_ready_by = case when p_passed then fix_ready_by else null end,
         fix_ready_at = case when p_passed then fix_ready_at else null end,
         retest_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
   where id = v_d.id;
  perform core.record_audit(v_d.organization_id, case when p_passed then 'ui_design.defect_verified' else 'ui_design.defect_reopened' end, 'p4ui_qa_defect', v_d.id, null,
    jsonb_build_object('projectId', v_d.project_id, 'fixUiVersionId', v_d.fix_ui_version_id));
  return query select case when p_passed then 'verified' else 'reopened' end, v_d.id;
end $$;
revoke all on function projects.p4ui_record_defect_retest(uuid, boolean, text) from public, anon;
grant execute on function projects.p4ui_record_defect_retest(uuid, boolean, text) to authenticated, service_role;

-- ═══ the client's feedback is classified before the Designer wakes ═════════
create or replace function projects.p4ui_route_ui_feedback(p_ui_version_id uuid, p_classification text, p_reasoning text, p_change_request_id uuid default null)
returns table (outcome text, ref_id uuid, route text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v      projects.ui_versions;
  v_scope  text;
  v_route  text;
  v_cr     uuid := p_change_request_id;
  v_words  text;
  v_new    uuid;
  v_exist  projects.p4ui_feedback_routes;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id for update;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid, null::text; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid, null::text; return; end if;
  select r.* into v_exist from projects.p4ui_feedback_routes r where r.ui_version_id = v_v.id;
  if v_exist.id is not null then return query select 'already_routed'::text, v_exist.id, v_exist.route; return; end if;
  if v_v.status <> 'client_change' then return query select 'wrong_state'::text, null::uuid, null::text; return; end if;
  if p_classification is null or p_classification not in ('CORRECTION', 'INCLUDED_REVISION', 'CLARIFICATION', 'POSSIBLE_SCOPE_CHANGE', 'DESIGN_DIRECTION_CHANGE', 'REJECTED_REQUEST') then
    return query select 'bad_classification'::text, null::uuid, null::text; return;
  end if;
  if coalesce(length(btrim(p_reasoning)), 0) = 0 then return query select 'needs_reasoning'::text, null::uuid, null::text; return; end if;
  v_route := case p_classification when 'CORRECTION' then 'design_revision' when 'INCLUDED_REVISION' then 'design_revision' when 'CLARIFICATION' then 'clarification'
                                   when 'POSSIBLE_SCOPE_CHANGE' then 'change_request' when 'DESIGN_DIRECTION_CHANGE' then 'escalation' else 'none' end;
  if v_cr is not null and not exists (select 1 from projects.change_requests c where c.id = v_cr and c.project_id = v_v.project_id) then
    return query select 'unknown_change_request'::text, null::uuid, null::text; return;
  end if;

  select d.client_words into v_words from projects.ui_version_client_decisions d where d.ui_version_id = v_v.id and d.decision = 'change_requested' order by d.created_at desc limit 1;

  -- a scope change is not a redesign: a person with delivery rights opens the Change Request; an agent leaves it for one (submit_change_request refuses the service role)
  if v_route = 'change_request' and v_cr is null and v_scope in ('person', 'admin') then
    select s.change_request_id into v_cr from projects.submit_change_request(v_v.project_id, left(coalesce(v_words, p_reasoning), 4000), 'client', null) s where s.outcome = 'submitted';
  end if;

  insert into projects.p4ui_feedback_routes (organization_id, project_id, ui_version_id, classification, route, reasoning, change_request_id, classified_by)
  values (v_v.organization_id, v_v.project_id, v_v.id, p_classification, v_route, left(btrim(p_reasoning), 500), v_cr, (select auth.uid()))
  returning id into v_new;

  if v_route = 'clarification' then
    insert into projects.clarification_requests (organization_id, project_id, ui_version_id, question)
    values (v_v.organization_id, v_v.project_id, v_v.id, left(coalesce(v_words, p_reasoning), 2000));
    perform projects.p4ui_open_design_blocker(v_v.phase_four_id, 'ambiguity', 'pm', left(coalesce(v_words, p_reasoning), 500),
      'The PM gets the client''s answer and a person resolves this blocker', v_v.id);
  elsif v_route in ('change_request', 'escalation') then
    perform projects.p4ui_open_design_blocker(v_v.phase_four_id, 'scope_conflict', case when v_route = 'escalation' then 'admin' else 'pm' end,
      case when v_route = 'escalation' then 'The client asks for a new design direction: escalated, not redesigned.' else 'The client asks for something outside the agreed scope: a Change Request must be approved first.' end,
      case when v_route = 'escalation' then 'An Admin decides the direction change' else 'The Change Request is approved' end, v_v.id);
  end if;

  perform core.record_audit(v_v.organization_id, 'ui_design.feedback_routed', 'p4ui_feedback_route', v_new, null,
    jsonb_build_object('projectId', v_v.project_id, 'classification', p_classification, 'route', v_route));
  return query select 'routed'::text, v_new, v_route;
end $$;
revoke all on function projects.p4ui_route_ui_feedback(uuid, text, text, uuid) from public, anon;
grant execute on function projects.p4ui_route_ui_feedback(uuid, text, text, uuid) to authenticated, service_role;

-- ═══ a locked UI is changed only on an Admin's say ══════════════════════════
create or replace function projects.p4ui_request_post_lock_revision(p_ui_version_id uuid, p_kind text, p_reason text)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_v     projects.ui_versions;
  v_scope text;
  v_open  uuid;
  v_new   uuid;
begin
  select u.* into v_v from projects.ui_versions u where u.id = p_ui_version_id;
  if v_v.id is null then return query select 'unknown_version'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_v.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if v_v.status <> 'locked' then return query select 'not_locked'::text, null::uuid; return; end if;
  if p_kind not in ('redesign', 'colour_change', 'component_change', 'other') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if coalesce(length(btrim(p_reason)), 0) = 0 then return query select 'needs_reason'::text, null::uuid; return; end if;
  select r.id into v_open from projects.p4ui_post_lock_requests r where r.ui_version_id = v_v.id and r.status = 'requested';
  if v_open is not null then return query select 'exists'::text, v_open; return; end if;
  insert into projects.p4ui_post_lock_requests (organization_id, project_id, ui_version_id, kind, reason, requested_by)
  values (v_v.organization_id, v_v.project_id, v_v.id, p_kind, left(btrim(p_reason), 1000), (select auth.uid())) returning id into v_new;
  perform core.record_audit(v_v.organization_id, 'ui_design.post_lock_revision_requested', 'p4ui_post_lock_request', v_new, null,
    jsonb_build_object('projectId', v_v.project_id, 'kind', p_kind));
  return query select 'requested'::text, v_new;
end $$;
revoke all on function projects.p4ui_request_post_lock_revision(uuid, text, text) from public, anon;
grant execute on function projects.p4ui_request_post_lock_revision(uuid, text, text) to authenticated, service_role;

create or replace function projects.p4ui_decide_post_lock_revision(p_request_id uuid, p_approve boolean, p_note text)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r     projects.p4ui_post_lock_requests;
  v_scope text;
begin
  select r.* into v_r from projects.p4ui_post_lock_requests r where r.id = p_request_id for update;
  if v_r.id is null then return query select 'unknown_request'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_r.organization_id);
  -- an Admin decides: an agent (service role) or a member without the admin role cannot
  if v_scope <> 'admin' then return query select case when v_scope in ('person', 'service') then 'admin_required' else v_scope end, null::uuid; return; end if;
  if v_r.status <> 'requested' then return query select 'already_decided'::text, v_r.id; return; end if;
  if coalesce(length(btrim(p_note)), 0) = 0 then return query select 'needs_note'::text, null::uuid; return; end if;
  update projects.p4ui_post_lock_requests
     set status = case when p_approve then 'approved' else 'rejected' end, decided_by = (select auth.uid()), decided_at = now(), decision_note = left(btrim(p_note), 500)
   where id = v_r.id;
  perform core.record_audit(v_r.organization_id, 'ui_design.post_lock_revision_decided', 'p4ui_post_lock_request', v_r.id, null,
    jsonb_build_object('projectId', v_r.project_id, 'approved', p_approve));
  perform core.emit_event(v_r.organization_id, 'project.ui_post_lock_revision_decided', 'p4ui_post_lock_request', v_r.id,
    jsonb_build_object('projectId', v_r.project_id, 'approved', p_approve, 'uiVersionId', v_r.ui_version_id));
  return query select case when p_approve then 'approved' else 'rejected' end, v_r.id;
end $$;
revoke all on function projects.p4ui_decide_post_lock_revision(uuid, boolean, text) from public, anon;
grant execute on function projects.p4ui_decide_post_lock_revision(uuid, boolean, text) to authenticated, service_role;

-- ═══ the prototype stage: a code bug is not a design bug ═══════════════════
create or replace function projects.p4ui_report_prototype_issue(p_prototype_artifact_id uuid, p_screen_key text, p_description text)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_a     projects.prototype_artifacts;
  v_scope text;
  v_dup   uuid;
  v_new   uuid;
begin
  select a.* into v_a from projects.prototype_artifacts a where a.id = p_prototype_artifact_id;
  if v_a.id is null then return query select 'unknown_artifact'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_a.organization_id);
  if v_scope in ('no_actor', 'forbidden') then return query select v_scope, null::uuid; return; end if;
  if coalesce(length(btrim(p_description)), 0) = 0 then return query select 'needs_description'::text, null::uuid; return; end if;
  select i.id into v_dup from projects.p4ui_prototype_design_issues i
   where i.prototype_artifact_id = v_a.id and i.screen_key is not distinct from p_screen_key and i.description = left(btrim(p_description), 1000);
  if v_dup is not null then return query select 'exists'::text, v_dup; return; end if;
  insert into projects.p4ui_prototype_design_issues (organization_id, project_id, prototype_artifact_id, ui_version_id, screen_key, description, reported_by)
  values (v_a.organization_id, v_a.project_id, v_a.id, v_a.ui_version_id, p_screen_key, left(btrim(p_description), 1000), (select auth.uid())) returning id into v_new;
  return query select 'reported'::text, v_new;
end $$;
revoke all on function projects.p4ui_report_prototype_issue(uuid, text, text) from public, anon;
grant execute on function projects.p4ui_report_prototype_issue(uuid, text, text) to authenticated, service_role;

create or replace function projects.p4ui_confirm_prototype_design_issue(p_issue_id uuid, p_is_source_ui_defect boolean, p_note text)
returns table (outcome text, ref_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_i     projects.p4ui_prototype_design_issues;
  v_scope text;
begin
  select i.* into v_i from projects.p4ui_prototype_design_issues i where i.id = p_issue_id for update;
  if v_i.id is null then return query select 'unknown_issue'::text, null::uuid; return; end if;
  v_scope := projects.p4ui_caller(v_i.organization_id);
  -- classification is a judgement about the approved design: a person makes it, not the agent that built the prototype
  if v_scope not in ('person', 'admin') then return query select case when v_scope = 'service' then 'person_required' else v_scope end, null::uuid; return; end if;
  if v_i.status <> 'reported' then return query select 'already_decided'::text, v_i.id; return; end if;
  if coalesce(length(btrim(p_note)), 0) = 0 then return query select 'needs_note'::text, null::uuid; return; end if;
  update projects.p4ui_prototype_design_issues
     set classification = case when p_is_source_ui_defect then 'source_ui_defect' else 'code_bug' end,
         status = case when p_is_source_ui_defect then 'confirmed' else 'dismissed' end,
         confirmed_by = (select auth.uid()), confirmed_at = now(), decision_note = left(btrim(p_note), 500)
   where id = v_i.id;
  perform core.record_audit(v_i.organization_id,
    case when p_is_source_ui_defect then 'ui_design.prototype_issue_confirmed' else 'ui_design.designer_not_activated' end,
    'p4ui_prototype_design_issue', v_i.id, null,
    jsonb_build_object('projectId', v_i.project_id, 'classification', case when p_is_source_ui_defect then 'source_ui_defect' else 'code_bug' end,
                       'routeTo', case when p_is_source_ui_defect then 'UI Designer (via p4ui_request_design_job)' else 'Prototype Agent' end));
  if p_is_source_ui_defect then
    perform core.emit_event(v_i.organization_id, 'project.prototype_design_issue_confirmed', 'p4ui_prototype_design_issue', v_i.id,
      jsonb_build_object('projectId', v_i.project_id, 'uiVersionId', v_i.ui_version_id, 'screenKey', v_i.screen_key));
  end if;
  return query select case when p_is_source_ui_defect then 'confirmed' else 'dismissed_as_code_bug' end, v_i.id;
end $$;
revoke all on function projects.p4ui_confirm_prototype_design_issue(uuid, boolean, text) from public, anon;
grant execute on function projects.p4ui_confirm_prototype_design_issue(uuid, boolean, text) to authenticated, service_role;

notify pgrst, 'reload schema';
