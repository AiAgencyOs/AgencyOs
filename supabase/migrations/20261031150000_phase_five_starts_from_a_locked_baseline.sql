-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 Master Flow: PHASE 4 COMPLETE + M2 ADMIN VERIFIED -> PHASE 5 READY -> LOAD THE EXACT CLIENT-APPROVED PHASE 4
-- UI / PROTOTYPE -> LOCK DEVELOPMENT BASELINE -> LOAD APPROVED SCOPE -> PLAN.
--
-- Until now Phase 5 had only a start gate on M2 (20261031100000) and nothing to build against: no workspace, and no record of WHICH
-- locked UI version, WHICH approved prototype build and WHICH scope version development is building. "Latest design" is exactly what
-- the spec forbids. This adds:
--   projects.phase_five              one workspace per project (the Phase5Ready / Task3Started fact)
--   projects.development_baselines   the exact refs, locked once, never edited (a changed scope is a Change Request + a new baseline)
--   projects.start_phase_five        the entry guard: phase 4 complete, a LOCKED UI version, an APPROVED prototype build, an ACTIVE
--                                    scope version, M2 verified paid. Idempotent; emits project.phase_five_started.
--   projects.start_task              a development task starts only against a locked baseline (for projects that run the pipeline)
-- Reuses ui_versions, prototype_artifacts, deliverables, scope_versions, repositories: no parallel copies.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.phase_five (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  phase_four_id    uuid not null references projects.phase_four(id) on delete restrict,
  state            text not null default 'baseline_locked'
                     check (state in ('baseline_locked', 'in_development', 'integration', 'admin_review', 'client_testing',
                                      'final_approved', 'completed', 'blocked')),
  blocked_reason   text,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id),
  check (state <> 'blocked' or (blocked_reason is not null and length(btrim(blocked_reason)) > 0))
);

create table if not exists projects.development_baselines (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  project_id               uuid not null references projects.projects(id) on delete cascade,
  phase_five_id            uuid not null references projects.phase_five(id) on delete cascade,
  ui_version_id            uuid not null references projects.ui_versions(id) on delete restrict,
  prototype_artifact_id    uuid not null references projects.prototype_artifacts(id) on delete restrict,
  prototype_deliverable_id uuid not null references projects.deliverables(id) on delete restrict,
  scope_version_id         uuid not null references projects.scope_versions(id) on delete restrict,
  repository_id            uuid references projects.repositories(id) on delete set null,
  base_commit              text,
  technical_stack          text,
  locked_at                timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  unique (phase_five_id)
);

create index if not exists development_baselines_project_idx on projects.development_baselines (project_id);

alter table projects.phase_five enable row level security;
alter table projects.development_baselines enable row level security;

-- Readable by the organization's members; written ONLY through the doors (no write policy).
drop policy if exists phase_five_read on projects.phase_five;
create policy phase_five_read on projects.phase_five for select to authenticated
  using (organization_id = (select core.current_organization_id()));
drop policy if exists development_baselines_read on projects.development_baselines;
create policy development_baselines_read on projects.development_baselines for select to authenticated
  using (organization_id = (select core.current_organization_id()));
grant select on projects.phase_five, projects.development_baselines to authenticated;
grant all on projects.phase_five, projects.development_baselines to service_role;

-- A baseline is a fact: once locked, no field changes. (It is never deleted from under the work built on it either: tasks.baseline_id
-- is ON DELETE RESTRICT.)
create or replace function projects.freeze_development_baseline()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'a locked development baseline is never edited: a changed scope is a Change Request and a new baseline' using errcode = 'restrict_violation';
end $$;
drop trigger if exists development_baselines_freeze on projects.development_baselines;
create trigger development_baselines_freeze before update on projects.development_baselines
  for each row execute function projects.freeze_development_baseline();

-- Tenancy: every parent a row names must belong to the row's organization (the repository's canonical guards), and the organization is immutable.
do $$
declare r record;
begin
  for r in select * from (values
    ('phase_five',           'project_id',               'projects.projects'),
    ('phase_five',           'phase_four_id',            'projects.phase_four'),
    ('development_baselines','project_id',               'projects.projects'),
    ('development_baselines','phase_five_id',            'projects.phase_five'),
    ('development_baselines','ui_version_id',            'projects.ui_versions'),
    ('development_baselines','prototype_artifact_id',    'projects.prototype_artifacts'),
    ('development_baselines','prototype_deliverable_id', 'projects.deliverables'),
    ('development_baselines','scope_version_id',         'projects.scope_versions'),
    ('development_baselines','repository_id',            'projects.repositories')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)',
                   r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_phase_five on projects.phase_five;
create trigger freeze_org_phase_five before update of organization_id on projects.phase_five for each row execute function core.freeze_organization_id();
drop trigger if exists freeze_org_development_baselines on projects.development_baselines;
create trigger freeze_org_development_baselines before update of organization_id on projects.development_baselines for each row execute function core.freeze_organization_id();
drop trigger if exists phase_five_updated_at on projects.phase_five;
create trigger phase_five_updated_at before update on projects.phase_five for each row execute function core.set_updated_at();

insert into core.event_types (type, description, canonical) values
  ('project.phase_five_started',
   'Phase 5 (Task 3, full development) is ready and its development baseline is locked: Phase 4 complete, M2 verified paid, the exact locked UI version, approved prototype build and active scope version recorded. Facts, not authority.',
   true)
on conflict (type) do nothing;

create or replace function projects.start_phase_five(p_project_id uuid)
returns table (outcome text, phase_five_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_project  projects.projects;
  v_existing projects.phase_five;
  v_p4       projects.phase_four;
  v_ui       projects.ui_versions;
  v_proto    record;
  v_scope    projects.scope_versions;
  v_repo     projects.repositories;
  v_new      uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid; return;
  end if;
  if v_actor is not null
     and (v_project.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select f.* into v_existing from projects.phase_five f where f.project_id = v_project.id;
  if v_existing.id is not null then
    return query select 'already_started'::text, v_existing.id; return;
  end if;

  select p4.* into v_p4 from projects.phase_four p4 where p4.project_id = v_project.id;
  if v_p4.id is null or v_p4.state <> 'completed' then
    return query select 'phase_four_incomplete'::text, null::uuid; return;
  end if;

  -- M2PaymentVerified is the ONLY financial opener; Phase4Completed, an issued invoice, a submission or a match recommendation are not.
  if not projects.m2_verified_paid(v_project.id) then
    return query select 'm2_not_verified'::text, null::uuid; return;
  end if;

  select v.* into v_ui from projects.ui_versions v where v.phase_four_id = v_p4.id and v.status = 'locked' order by v.version desc limit 1;
  if v_ui.id is null then
    return query select 'no_locked_ui'::text, null::uuid; return;
  end if;

  select a.id as artifact_id, a.deliverable_id into v_proto
    from projects.prototype_artifacts a
    join projects.deliverables d on d.id = a.deliverable_id
   where a.ui_version_id = v_ui.id and d.kind = 'prototype' and d.status = 'approved'
   order by d.version desc limit 1;
  if v_proto.artifact_id is null then
    return query select 'no_approved_prototype'::text, null::uuid; return;
  end if;

  select s.* into v_scope from projects.scope_versions s where s.project_id = v_project.id and s.status = 'active' order by s.version desc limit 1;
  if v_scope.id is null then
    return query select 'no_active_scope'::text, null::uuid; return;
  end if;

  -- the repository, when one is linked, is part of the baseline; its absence is recorded as null, never invented
  select r.* into v_repo from projects.repositories r where r.project_id = v_project.id order by r.created_at limit 1;

  insert into projects.phase_five (organization_id, project_id, phase_four_id)
    values (v_project.organization_id, v_project.id, v_p4.id)
    returning id into v_new;

  insert into projects.development_baselines (
    organization_id, project_id, phase_five_id, ui_version_id, prototype_artifact_id, prototype_deliverable_id,
    scope_version_id, repository_id
  ) values (
    v_project.organization_id, v_project.id, v_new, v_ui.id, v_proto.artifact_id, v_proto.deliverable_id,
    v_scope.id, v_repo.id
  );

  perform core.record_audit(
    v_project.organization_id, 'project.phase_five_started', 'phase_five', v_new, null,
    jsonb_build_object('projectId', v_project.id, 'uiVersionId', v_ui.id, 'prototypeArtifactId', v_proto.artifact_id, 'scopeVersionId', v_scope.id)
  );
  perform core.emit_event(
    v_project.organization_id, 'project.phase_five_started', 'phase_five', v_new,
    jsonb_build_object('projectId', v_project.id, 'uiVersionId', v_ui.id, 'prototypeArtifactId', v_proto.artifact_id, 'scopeVersionId', v_scope.id)
  );

  return query select 'started'::text, v_new;
end;
$$;

comment on function projects.start_phase_five(uuid) is
  'Phase 5 entry guard + baseline lock. Refuses phase_four_incomplete / m2_not_verified / no_locked_ui / no_approved_prototype / no_active_scope; idempotent (already_started).';
revoke all on function projects.start_phase_five(uuid) from public, anon;
grant execute on function projects.start_phase_five(uuid) to authenticated, service_role;

-- a development task starts only against a locked baseline, and is stamped with it
alter table projects.tasks add column if not exists baseline_id uuid references projects.development_baselines(id) on delete restrict;

create or replace function projects.start_task(p_task_id uuid)
returns table (outcome text, detail text)
language plpgsql
set search_path = ''
as $$
declare
  v_task  projects.tasks;
  v_check record;
  v_role  text;
  v_base  uuid;
begin
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;
  if v_task.id is null then
    return query select 'not_found'::text, null::text; return;
  end if;
  v_role := projects.project_role_refusal(v_task.project_id, v_task.assignee_id);
  if v_role is not null then
    return query select v_role, null::text; return;
  end if;
  if v_task.status <> 'todo' or v_task.archived_at is not null then
    return query select 'wrong_state'::text, null::text; return;
  end if;

  if (v_task.module_id is not null or v_task.feature_id is not null) then
    -- Phase 5 gate 1: M2 verified paid.
    if not projects.m2_verified_paid(v_task.project_id) then
      return query select 'm2_not_verified'::text,
        'Phase 5 cannot start: the M2 payment is not verified paid. A client saying paid, a proof upload, a submission or a match recommendation does not open it; only an Admin verifying the payment does.'::text;
      return;
    end if;
    -- Phase 5 gate 2: a locked development baseline (for a project that ran the Phase 3/4 pipeline).
    if exists (select 1 from projects.phase_four p4 where p4.project_id = v_task.project_id) then
      select b.id into v_base from projects.development_baselines b where b.project_id = v_task.project_id;
      if v_base is null then
        return query select 'no_baseline'::text,
          'Phase 5 has no locked development baseline yet: development builds against the exact approved UI, prototype and scope, never "the latest design".'::text;
        return;
      end if;
    end if;
  end if;

  select * into v_check from projects.task_start_check(p_task_id);
  if not v_check.requirement_ok then
    return query select 'no_requirement'::text, v_check.reason; return;
  end if;
  if v_check.open_dependencies > 0 then
    return query select 'dependencies_open'::text, v_check.reason; return;
  end if;

  update projects.tasks set status = 'in_progress', started_at = coalesce(started_at, now()), baseline_id = coalesce(baseline_id, v_base)
   where id = p_task_id;

  perform core.record_audit(
    v_task.organization_id, 'task.started', 'task', p_task_id,
    jsonb_build_object('status', v_task.status), jsonb_build_object('status', 'in_progress', 'projectId', v_task.project_id, 'baselineId', v_base)
  );
  return query select 'started'::text, null::text;
end;
$$;

comment on function projects.start_task(uuid) is
  'todo -> in_progress. Refused: wrong_state, m2_not_verified, no_baseline (a development task needs the locked Phase 5 baseline), no_requirement, dependencies_open; audited task.started; stamps the task with its baseline.';
revoke all on function projects.start_task(uuid) from public, anon;
grant execute on function projects.start_task(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
