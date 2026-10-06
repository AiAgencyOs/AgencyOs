-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 (Master QA) - P601 §3, §9, §10, §39: entry gate, the workspace's state machine, and the QA intake with its validation.
--
--   PHASE5 COMPLETED + M3 ADMIN VERIFIED -> PHASE 6 READY -> QA INTAKE VALIDATED -> plan -> testing -> ... 
--
-- projects.phase_six        one workspace per project; the states are P601 §39 verbatim
-- projects.qa_intakes       the exact Phase 5 build/commit/artifact/scope/UI the QA is about, validated; typed blockers with an owner and a resume condition
-- projects.start_phase_six  created WAITING_M3_VERIFIED at Phase5Completed; READY (once) when M3 is Admin-verified paid in full
-- projects.validate_qa_intake  rejects a missing/ambiguous build, an approval tied to a DIFFERENT build, stale scope/UI, a missing M3 gate;
--                           unverified integrations are listed as explicit external dependencies (never a silent skip)
-- Everything here is INTERNAL (a client reads none of it) and the QA never trusts Phase 5: it re-reads the rows.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.phase_six (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  phase_five_handoff_id uuid not null references projects.phase_five_handoffs(id) on delete restrict,
  state                 text not null default 'waiting_m3_verified' check (state in (
                          'waiting_m3_verified', 'ready', 'intake_validating', 'plan_ready', 'testing', 'defect_fix_loop',
                          'final_verification', 'admin_review', 'blocked', 'phase6_completed', 'm4_due', 'phase7_financially_ready')),
  blocked_reason        text,
  ready_at              timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (project_id),
  check (state <> 'blocked' or (blocked_reason is not null and length(btrim(blocked_reason)) > 0))
);

create table if not exists projects.qa_intakes (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references core.organizations(id) on delete cascade,
  project_id              uuid not null references projects.projects(id) on delete cascade,
  phase_six_id            uuid not null references projects.phase_six(id) on delete cascade,
  phase_five_handoff_id   uuid not null references projects.phase_five_handoffs(id) on delete restrict,
  build_deliverable_id    uuid not null references projects.deliverables(id) on delete restrict,
  commit_ref              text not null,
  artifact_sha256         text,
  scope_version_id        uuid references projects.scope_versions(id) on delete restrict,
  ui_version_id           uuid references projects.ui_versions(id) on delete restrict,
  status                  text not null default 'pending' check (status in (
                            'pending', 'validating', 'valid', 'blocked_build', 'blocked_scope', 'blocked_environment', 'blocked_external',
                            'blocked_finance', 'needs_clarification', 'stale')),
  blockers                jsonb not null default '[]'::jsonb check (jsonb_typeof(blockers) = 'array'),
  external_dependencies   jsonb not null default '[]'::jsonb check (jsonb_typeof(external_dependencies) = 'array'),
  m3_verified             boolean not null default false,
  validated_at            timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (project_id)
);

do $$
declare r record;
begin
  for r in select * from (values
    ('phase_six', 'project_id', 'projects.projects'), ('phase_six', 'phase_five_handoff_id', 'projects.phase_five_handoffs'),
    ('qa_intakes', 'project_id', 'projects.projects'), ('qa_intakes', 'phase_six_id', 'projects.phase_six'),
    ('qa_intakes', 'phase_five_handoff_id', 'projects.phase_five_handoffs'), ('qa_intakes', 'build_deliverable_id', 'projects.deliverables'),
    ('qa_intakes', 'scope_version_id', 'projects.scope_versions'), ('qa_intakes', 'ui_version_id', 'projects.ui_versions')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)',
                   r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['phase_six', 'qa_intakes']) as tbl loop
    execute format('alter table projects.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on projects.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('grant select on projects.%I to authenticated', r.tbl);
    execute format('grant all on projects.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_updated_at', r.tbl);
    execute format('create trigger %I before update on projects.%I for each row execute function core.set_updated_at()', r.tbl || '_updated_at', r.tbl);
  end loop;
end $$;

-- the intake is about ONE exact build: its identity never changes (a new commit is a stale intake and a new validation, not an edit)
create or replace function projects.qa_intakes_identity_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.build_deliverable_id is distinct from old.build_deliverable_id or new.commit_ref is distinct from old.commit_ref
     or new.phase_five_handoff_id is distinct from old.phase_five_handoff_id or new.project_id is distinct from old.project_id then
    raise exception 'a QA intake is about one exact Phase 5 build; its identity is never edited' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists qa_intakes_identity_frozen on projects.qa_intakes;
create trigger qa_intakes_identity_frozen before update on projects.qa_intakes for each row execute function projects.qa_intakes_identity_frozen();

insert into core.event_types (type, description, canonical) values
  ('project.phase_six_ready',
   'Phase 6 (Master QA) is READY: Phase 5 is complete, its frozen intake exists, and M3 was verified paid in full by an Admin. Emitted once.',
   true),
  ('project.qa_intake_validated',
   'The Phase 6 QA intake was validated against the exact Phase 5 build, scope and UI. Carries the status; the blockers are read from the row.',
   true)
on conflict (type) do nothing;

create or replace function projects.start_phase_six(p_project_id uuid)
returns table (outcome text, phase_six_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_project projects.projects;
  v_handoff projects.phase_five_handoffs;
  v_six projects.phase_six;
  v_m3 boolean;
  v_new uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  select p.* into v_project from projects.projects p where p.id = p_project_id and p.deleted_at is null for update;
  if v_project.id is null then return query select 'unknown_project'::text, null::uuid; return; end if;
  if v_actor is not null and (v_project.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select h.* into v_handoff from projects.phase_five_handoffs h where h.project_id = v_project.id;
  if v_handoff.id is null then return query select 'phase_five_incomplete'::text, null::uuid; return; end if;

  v_m3 := projects.m3_verified_paid(v_project.id);
  select s.* into v_six from projects.phase_six s where s.project_id = v_project.id;

  if v_six.id is null then
    insert into projects.phase_six (organization_id, project_id, phase_five_handoff_id, state, ready_at)
    values (v_project.organization_id, v_project.id, v_handoff.id, case when v_m3 then 'ready' else 'waiting_m3_verified' end, case when v_m3 then now() end)
    returning id into v_new;
    if v_m3 then
      perform core.record_audit(v_project.organization_id, 'project.phase_six_ready', 'phase_six', v_new, null, jsonb_build_object('projectId', v_project.id));
      perform core.emit_event(v_project.organization_id, 'project.phase_six_ready', 'phase_six', v_new, jsonb_build_object('projectId', v_project.id));
      return query select 'ready'::text, v_new; return;
    end if;
    return query select 'waiting_m3_verified'::text, v_new; return;
  end if;

  -- an existing workspace waiting for the money becomes READY exactly once, and only on a verified payment in full
  if v_six.state = 'waiting_m3_verified' and v_m3 then
    update projects.phase_six set state = 'ready', ready_at = now() where id = v_six.id;
    perform core.record_audit(v_project.organization_id, 'project.phase_six_ready', 'phase_six', v_six.id, null, jsonb_build_object('projectId', v_project.id));
    perform core.emit_event(v_project.organization_id, 'project.phase_six_ready', 'phase_six', v_six.id, jsonb_build_object('projectId', v_project.id));
    return query select 'ready'::text, v_six.id; return;
  end if;
  return query select case when v_six.state = 'waiting_m3_verified' then 'waiting_m3_verified' else 'already_started' end::text, v_six.id;
end $$;
revoke all on function projects.start_phase_six(uuid) from public, anon;
grant execute on function projects.start_phase_six(uuid) to authenticated, service_role;

create or replace function projects.validate_qa_intake(p_project_id uuid)
returns table (outcome text, status text, blockers jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_six projects.phase_six;
  v_h projects.phase_five_handoffs;
  v_base projects.development_baselines;
  v_intake projects.qa_intakes;
  v_blockers jsonb := '[]'::jsonb;
  v_external jsonb;
  v_status text := 'valid';
  v_latest record;
  v_commit text;
  v_hash text;
  v_scope uuid;
  v_ui_status text;
  v_m3 boolean;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::text, '[]'::jsonb; return;
  end if;
  select s.* into v_six from projects.phase_six s where s.project_id = p_project_id for update;
  if v_six.id is null then return query select 'no_workspace'::text, null::text, '[]'::jsonb; return; end if;
  if v_actor is not null and (v_six.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::text, '[]'::jsonb; return;
  end if;
  v_m3 := projects.m3_verified_paid(p_project_id);
  if v_six.state = 'waiting_m3_verified' or not v_m3 then
    return query select 'waiting_m3_verified'::text, 'blocked_finance'::text,
      jsonb_build_array(jsonb_build_object('type', 'finance', 'owner', 'admin', 'resumeCondition', 'An Admin verifies the M3 payment in full', 'detail', 'M3 is not verified paid'));
    return;
  end if;

  select h.* into v_h from projects.phase_five_handoffs h where h.id = v_six.phase_five_handoff_id;
  select b.* into v_base from projects.development_baselines b where b.project_id = p_project_id;

  -- the build the client approved must be THE build handed over, and its commit must still be the handed-over commit
  select d.id, d.version, dd.commit_ref into v_latest
    from projects.deliverables d left join projects.deliverable_details dd on dd.deliverable_id = d.id
   where d.project_id = p_project_id and d.kind = 'build' and d.status = 'approved' order by d.version desc limit 1;
  if v_latest.id is null then
    v_blockers := v_blockers || jsonb_build_object('type', 'build', 'owner', 'delivery_lead', 'resumeCondition', 'The client approves an exact build', 'detail', 'no client-approved build');
    v_status := 'blocked_build';
  elsif v_latest.id is distinct from v_h.final_build_deliverable_id then
    v_blockers := v_blockers || jsonb_build_object('type', 'build', 'owner', 'delivery_lead', 'resumeCondition', 'Hand over the build the client approved, or have the client approve this one', 'detail', 'the client approval is tied to a different build than the one handed over');
    v_status := 'blocked_build';
  end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_h.final_build_deliverable_id;
  if v_commit is distinct from v_h.final_commit_ref then
    v_blockers := v_blockers || jsonb_build_object('type', 'build', 'owner', 'delivery_lead', 'resumeCondition', 'Restore the handed-over commit or create a new release candidate', 'detail', 'the build''s commit no longer matches the handed-over commit');
    v_status := 'blocked_build';
  end if;
  select br.artifact_sha256 into v_hash from projects.build_runs br
   where br.deliverable_id = v_h.final_build_deliverable_id and br.commit_ref = v_h.final_commit_ref and br.status = 'succeeded' and br.artifact_sha256 is not null
   order by br.created_at desc limit 1;
  if v_hash is null then
    v_blockers := v_blockers || jsonb_build_object('type', 'build', 'owner', 'devops_build', 'resumeCondition', 'A successful build run with an artifact hash exists for the handed-over commit', 'detail', 'no verified artifact for the exact commit');
    v_status := 'blocked_build';
  end if;

  -- scope and UI must still be the ones the baseline locked
  select s.id into v_scope from projects.scope_versions s where s.project_id = p_project_id and s.status = 'active' order by s.version desc limit 1;
  if v_base.id is not null and v_scope is distinct from v_base.scope_version_id then
    v_blockers := v_blockers || jsonb_build_object('type', 'scope', 'owner', 'project_manager', 'resumeCondition', 'Re-baseline through an approved Change Request', 'detail', 'the active scope is no longer the scope Phase 5 built against');
    if v_status = 'valid' then v_status := 'blocked_scope'; end if;
  end if;
  if v_base.id is not null then
    select u.status into v_ui_status from projects.ui_versions u where u.id = v_base.ui_version_id;
    if v_ui_status is distinct from 'locked' then
      v_blockers := v_blockers || jsonb_build_object('type', 'scope', 'owner', 'ui_designer', 'resumeCondition', 'The approved UI is locked again', 'detail', 'the baseline UI version is no longer locked');
      if v_status = 'valid' then v_status := 'blocked_scope'; end if;
    end if;
  end if;

  -- unverified integrations are EXPLICIT external dependencies: tests that need them are BLOCKED with a reason, never silently skipped
  select coalesce(jsonb_agg(jsonb_build_object('type', 'external', 'name', c.name, 'kind', c.kind, 'health', c.health, 'mock', c.is_mock,
           'owner', 'admin', 'resumeCondition', 'Provide credentials and pass an adapter check', 'detail', c.name || ' is ' || c.health || ' and not verified') order by c.name), '[]'::jsonb)
    into v_external from projects.integration_connections c where c.project_id = p_project_id and c.health <> 'verified';

  insert into projects.qa_intakes (organization_id, project_id, phase_six_id, phase_five_handoff_id, build_deliverable_id, commit_ref, artifact_sha256, scope_version_id, ui_version_id,
                                   status, blockers, external_dependencies, m3_verified, validated_at)
  values (v_six.organization_id, p_project_id, v_six.id, v_h.id, v_h.final_build_deliverable_id, v_h.final_commit_ref, v_hash, v_base.scope_version_id, v_base.ui_version_id,
          v_status, v_blockers, v_external, v_m3, now())
  on conflict (project_id) do update
     set status = excluded.status, blockers = excluded.blockers, external_dependencies = excluded.external_dependencies,
         artifact_sha256 = excluded.artifact_sha256, m3_verified = excluded.m3_verified, validated_at = now();

  if v_status = 'valid' then
    update projects.phase_six set state = case when state in ('ready', 'blocked') then 'intake_validating' else state end, blocked_reason = null where id = v_six.id;
  else
    update projects.phase_six set state = 'blocked', blocked_reason = 'QA intake is ' || v_status || ': ' || (v_blockers->0->>'detail') where id = v_six.id and state in ('ready', 'intake_validating', 'blocked');
  end if;

  perform core.record_audit(v_six.organization_id, 'project.qa_intake_validated', 'phase_six', v_six.id, null, jsonb_build_object('projectId', p_project_id, 'status', v_status));
  perform core.emit_event(v_six.organization_id, 'project.qa_intake_validated', 'phase_six', v_six.id, jsonb_build_object('projectId', p_project_id, 'status', v_status));
  return query select 'validated'::text, v_status, v_blockers;
end $$;
revoke all on function projects.validate_qa_intake(uuid) from public, anon;
grant execute on function projects.validate_qa_intake(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
