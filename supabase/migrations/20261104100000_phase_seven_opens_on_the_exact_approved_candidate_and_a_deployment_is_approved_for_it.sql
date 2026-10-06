-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7 (Production Launch & Handover), part 1: the workspace, the deployment plan, the Admin deployment approval and the deployment RECORD.
-- Spec: P701 §5-§7, §13-§17; P704 (Deployment Agent); P703 §7 (dependencies); P702 (PM7 events).
--
--   projects.phase_seven            the durable workspace + state machine. It exists only after Phase6Completed (a phase_six_handoffs row); it is READY
--                                   only when the EXACT Phase 6 approved candidate is still current AND M4 is Admin-verified paid in full
--   projects.p7_deployment_plans    the plan: environment, exact candidate commit + artifact hash (RESOLVED from the Phase 6 intake, never typed), migration plan,
--                                   rollback strategy/target/owner, monitoring plan. Secrets/config are READINESS REFERENCES BY NAME ONLY (no value column exists)
--   projects.p7_readiness_items     env / config-ref / secret-ref / migration / rollback / monitoring / manual-external steps, each with evidence when ready
--   projects.p7_deployment_approvals  append-only Admin decisions bound to the exact commit + artifact; creator != approver; a changed candidate voids the approval
--   projects.p7_deployments         the deployment RECORD (requested/approved/started/succeeded_pending_validation/failed/rolled_back/recovered_pending_validation).
--                                   Written ONLY by service-role runner doors. THE REAL EXECUTOR (production credentials) IS AN OWNER BINDING AND IS NOT BUILT: the
--                                   not-configured executor records an honest blocker (record_deployment_blocker), it never writes a success.
--
-- A NEW rule applies only to projects that have a phase_seven row: legacy verifiers complete phases on projects that never entered this pipeline.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── helpers shared by Phase 7 ─────────────────────────────────────────────
-- true when the text carries something that looks like a secret VALUE (the same families the build log mask already knows)
create or replace function projects.p7_has_secret(p_text text)
returns boolean language sql immutable set search_path = '' as $$
  select p_text is not null and p_text is distinct from projects.mask_secrets(p_text)
$$;
revoke all on function projects.p7_has_secret(text) from public, anon;
grant execute on function projects.p7_has_secret(text) to authenticated, service_role;

-- a Phase 7 row is written by a Phase 7 door, never by a raw statement (the doors set this flag for their own transaction)
create or replace function projects.p7_door_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception '% is production history and is never deleted', tg_table_name using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then
    raise exception '% is written through its Phase 7 door, never by a direct statement', tg_table_name using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create or replace function projects.p7_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then raise exception 'a % row is history and is never edited or deleted', tg_table_name using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then
    raise exception '% is written through its Phase 7 door, never by a direct statement', tg_table_name using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

-- the uniform table hardening: RLS, internal-only read, no write grant to authenticated, frozen tenant
create or replace function projects.p7_harden(p_schema text, p_table text)
returns void language plpgsql set search_path = '' as $$
begin
  execute format('alter table %I.%I enable row level security', p_schema, p_table);
  execute format('drop policy if exists %I on %I.%I', p_table || '_read', p_schema, p_table);
  execute format($p$create policy %I on %I.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, p_table || '_read', p_schema, p_table);
  execute format('revoke all on %I.%I from public, anon', p_schema, p_table);
  execute format('revoke insert, update, delete on %I.%I from authenticated', p_schema, p_table);
  execute format('grant select on %I.%I to authenticated', p_schema, p_table);
  execute format('grant all on %I.%I to service_role', p_schema, p_table);
  execute format('drop trigger if exists %I on %I.%I', 'freeze_org_' || p_table, p_schema, p_table);
  execute format('create trigger %I before update of organization_id on %I.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || p_table, p_schema, p_table);
end $$;
revoke all on function projects.p7_harden(text, text) from public, anon, authenticated, service_role;

create or replace function projects.p7_guard_fk(p_table text, p_col text, p_parent text)
returns void language plpgsql set search_path = '' as $$
begin
  execute format('drop trigger if exists %I on projects.%I', p_table || '_parent_org_' || p_col, p_table);
  execute format('create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)', p_table || '_parent_org_' || p_col, p_col, p_table, p_col, p_parent);
end $$;
revoke all on function projects.p7_guard_fk(text, text, text) from public, anon, authenticated, service_role;

-- ── the workspace ──────────────────────────────────────────────────────────
create table if not exists projects.phase_seven (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  project_id               uuid not null references projects.projects(id) on delete cascade,
  phase_six_handoff_id     uuid not null references projects.phase_six_handoffs(id) on delete restrict,
  candidate_id             uuid not null references qa.release_candidates(id) on delete restrict,
  commit_ref               text not null check (length(btrim(commit_ref)) > 0),
  artifact_sha256          text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  state                    text not null default 'waiting_m4_verification' check (state in (
                             'waiting_phase6', 'waiting_m4_verification', 'phase7_ready', 'deployment_planning', 'waiting_deployment_approval', 'deploying',
                             'post_deployment_validation', 'production_validated', 'deployment_failed', 'rollback_in_progress', 'handover_preparing',
                             'admin_handover_review', 'handover_ready', 'client_handover_review', 'client_action_required', 'client_accepted',
                             'completion_validation', 'completed', 'phase8_ready')),
  blocked_reason           text,
  -- a failed production check pauses completion; only a verified recovery lifts it
  completion_paused        boolean not null default false,
  paused_reason            text,
  client_acceptance_required boolean not null default true,
  acceptance_waiver_reason text,
  acceptance_waived_by     uuid references core.users(id) on delete set null,
  ready_at                 timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (project_id),
  check (not completion_paused or (paused_reason is not null and length(btrim(paused_reason)) > 0)),
  check (client_acceptance_required or (acceptance_waiver_reason is not null and length(btrim(acceptance_waiver_reason)) > 0 and acceptance_waived_by is not null))
);

-- an exact candidate is stored once per project and changes only through the rebind door
create or replace function projects.phase_seven_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a Phase 7 workspace is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then
    raise exception 'a Phase 7 workspace changes through its doors, never by a direct statement' using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' then
    if new.project_id is distinct from old.project_id or new.phase_six_handoff_id is distinct from old.phase_six_handoff_id then
      raise exception 'a Phase 7 workspace is bound to its project and its Phase 6 intake' using errcode = 'restrict_violation';
    end if;
    if old.state in ('completed', 'phase8_ready') and (new.state is distinct from old.state and not (old.state = 'completed' and new.state = 'phase8_ready')) then
      raise exception 'a completed project does not return to production work' using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists phase_seven_guard on projects.phase_seven;
create trigger phase_seven_guard before insert or update or delete on projects.phase_seven for each row execute function projects.phase_seven_guard();
drop trigger if exists phase_seven_updated_at on projects.phase_seven;
create trigger phase_seven_updated_at before update on projects.phase_seven for each row execute function core.set_updated_at();

-- ── known limitations (Phase 6 intake + anything production finds); the handover must disclose every one ──
create table if not exists projects.p7_known_limitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  title            text not null check (length(btrim(title)) > 0 and not projects.p7_has_secret(title)),
  detail           text check (not projects.p7_has_secret(detail)),
  source           text not null check (source in ('phase6_intake', 'production_validation', 'handover', 'manual')),
  blocking         boolean not null default false check (not blocking),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (project_id, title)
);

-- ── the deployment plan ────────────────────────────────────────────────────
create table if not exists projects.p7_deployment_plans (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  project_id          uuid not null references projects.projects(id) on delete cascade,
  phase_seven_id      uuid not null references projects.phase_seven(id) on delete cascade,
  candidate_id        uuid not null references qa.release_candidates(id) on delete restrict,
  version             int not null check (version > 0),
  status              text not null default 'draft' check (status in ('draft', 'ready_for_approval', 'approved', 'rejected', 'superseded')),
  commit_ref          text not null check (length(btrim(commit_ref)) > 0),
  artifact_sha256     text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  environment         text not null check (environment in ('production')),
  target_ref          text not null check (length(btrim(target_ref)) > 0 and not projects.p7_has_secret(target_ref)),
  migration_plan      jsonb not null check (jsonb_typeof(migration_plan) = 'object' and not projects.p7_has_secret(migration_plan::text)),
  rollback_strategy   text check (not projects.p7_has_secret(rollback_strategy)),
  rollback_target_ref text check (not projects.p7_has_secret(rollback_target_ref)),
  rollback_owner      text check (not projects.p7_has_secret(rollback_owner)),
  monitoring_plan     text check (not projects.p7_has_secret(monitoring_plan)),
  maintenance_window  text check (not projects.p7_has_secret(maintenance_window)),
  no_config_required  boolean not null default false,
  created_by          uuid references core.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (project_id, version)
);
create unique index if not exists p7_plans_one_live on projects.p7_deployment_plans (project_id) where status in ('draft', 'ready_for_approval', 'approved');

-- the plan's identity (candidate, commit, artifact, environment) is fixed; after it leaves draft its content is as it was approved
create or replace function projects.p7_plan_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_h projects.phase_seven;
begin
  if tg_op = 'DELETE' then raise exception 'a deployment plan is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then
    raise exception 'a deployment plan changes through its doors, never by a direct statement' using errcode = 'restrict_violation';
  end if;
  if tg_op = 'INSERT' then
    -- THE EXACT CANDIDATE: the plan names the commit and artifact the Phase 7 workspace is bound to (the Phase 6 approved candidate), nothing else
    select * into v_h from projects.phase_seven s where s.id = new.phase_seven_id;
    if v_h.id is null or new.candidate_id is distinct from v_h.candidate_id or new.commit_ref is distinct from v_h.commit_ref or new.artifact_sha256 is distinct from v_h.artifact_sha256 then
      raise exception 'a deployment plan carries exactly the Phase 6 approved candidate''s commit and artifact' using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if new.candidate_id is distinct from old.candidate_id or new.commit_ref is distinct from old.commit_ref or new.artifact_sha256 is distinct from old.artifact_sha256
     or new.version is distinct from old.version or new.project_id is distinct from old.project_id then
    raise exception 'a deployment plan is for one exact candidate: a different commit is a new plan' using errcode = 'restrict_violation';
  end if;
  if old.status in ('approved', 'rejected', 'superseded') and (new.status is distinct from old.status and not (old.status = 'approved' and new.status = 'superseded')) then
    raise exception 'a decided deployment plan is only ever superseded' using errcode = 'restrict_violation';
  end if;
  if old.status <> 'draft' and (new.environment is distinct from old.environment or new.target_ref is distinct from old.target_ref or new.migration_plan is distinct from old.migration_plan
     or new.rollback_strategy is distinct from old.rollback_strategy or new.rollback_target_ref is distinct from old.rollback_target_ref or new.rollback_owner is distinct from old.rollback_owner
     or new.monitoring_plan is distinct from old.monitoring_plan or new.maintenance_window is distinct from old.maintenance_window or new.no_config_required is distinct from old.no_config_required) then
    raise exception 'a plan sent for approval is not edited: it is approved as it is, or sent back to draft by the Admin' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p7_plan_guard on projects.p7_deployment_plans;
create trigger p7_plan_guard before insert or update or delete on projects.p7_deployment_plans for each row execute function projects.p7_plan_guard();
drop trigger if exists p7_plans_updated_at on projects.p7_deployment_plans;
create trigger p7_plans_updated_at before update on projects.p7_deployment_plans for each row execute function core.set_updated_at();

-- readiness is a REFERENCE BY NAME. There is no column that could hold a secret value, and the free-text columns refuse anything shaped like one.
create table if not exists projects.p7_readiness_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references projects.p7_deployment_plans(id) on delete cascade,
  kind             text not null check (kind in ('environment', 'config_ref', 'secret_ref', 'migration', 'rollback', 'monitoring', 'external_dependency',
                                                 'manual_dns', 'manual_store', 'manual_signing', 'manual_account', 'manual_other')),
  name             text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_.:/ -]{1,100}$' and not projects.p7_has_secret(name)),
  status           text not null default 'pending' check (status in ('pending', 'ready', 'not_ready', 'blocked_manual_external')),
  owner            text check (not projects.p7_has_secret(owner)),
  instruction      text check (not projects.p7_has_secret(instruction)),
  evidence_ref     text check (not projects.p7_has_secret(evidence_ref)),
  note             text check (not projects.p7_has_secret(note)),
  recorded_by      uuid references core.users(id) on delete set null,
  recorded_at      timestamptz not null default now(),
  unique (plan_id, kind, name),
  check (status <> 'ready' or (evidence_ref is not null and length(btrim(evidence_ref)) > 0)),
  check (kind not like 'manual\_%' or (instruction is not null and length(btrim(instruction)) > 0))
);

create table if not exists projects.p7_deployment_approvals (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references core.organizations(id) on delete cascade,
  project_id             uuid not null references projects.projects(id) on delete cascade,
  plan_id                uuid not null references projects.p7_deployment_plans(id) on delete cascade,
  candidate_id           uuid not null references qa.release_candidates(id) on delete restrict,
  commit_ref             text not null,
  artifact_sha256        text not null,
  decision               text not null check (decision in ('approve', 'reject', 'request_changes')),
  note                   text check (not projects.p7_has_secret(note)),
  acknowledged_destructive boolean not null default false,
  decided_by             uuid not null references core.users(id) on delete restrict,
  decided_at             timestamptz not null default clock_timestamp(),
  check (decision = 'approve' or (note is not null and length(btrim(note)) > 0))
);

-- ── the deployment record ──────────────────────────────────────────────────
create table if not exists projects.p7_deployments (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  project_id               uuid not null references projects.projects(id) on delete cascade,
  phase_seven_id           uuid not null references projects.phase_seven(id) on delete cascade,
  plan_id                  uuid not null references projects.p7_deployment_plans(id) on delete restrict,
  candidate_id             uuid not null references qa.release_candidates(id) on delete restrict,
  commit_ref               text not null,
  artifact_sha256          text not null,
  environment              text not null,
  attempt                  int not null check (attempt > 0),
  idempotency_key          text not null check (length(btrim(idempotency_key)) > 0 and length(idempotency_key) <= 200),
  status                   text not null default 'requested' check (status in ('requested', 'approved', 'started', 'succeeded_pending_validation', 'failed', 'rolled_back', 'recovered_pending_validation')),
  executor                 text not null default 'not_configured' check (executor in ('not_configured', 'runner', 'manual')),
  deployed_artifact_sha256 text check (deployed_artifact_sha256 is null or deployed_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  actor_user               uuid references core.users(id) on delete set null,
  evidence_ref             text check (not projects.p7_has_secret(evidence_ref)),
  note                     text check (not projects.p7_has_secret(note)),
  blocker_code             text check (blocker_code ~ '^[a-z_]+$'),
  requested_at             timestamptz not null default clock_timestamp(),
  started_at               timestamptz,
  finished_at              timestamptz,
  created_at               timestamptz not null default clock_timestamp(),
  updated_at               timestamptz not null default now(),
  unique (plan_id, idempotency_key),
  unique (plan_id, attempt),
  check (status not in ('succeeded_pending_validation', 'recovered_pending_validation') or (deployed_artifact_sha256 is not null and deployed_artifact_sha256 = artifact_sha256))
);
create unique index if not exists p7_deployments_one_active on projects.p7_deployments (plan_id) where status in ('requested', 'approved', 'started');

create table if not exists projects.p7_deployment_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  deployment_id    uuid not null references projects.p7_deployments(id) on delete cascade,
  kind             text not null check (kind in ('transition', 'blocker', 'note')),
  from_status      text,
  to_status        text,
  blocker_code     text check (blocker_code ~ '^[a-z_]+$'),
  actor_user       uuid references core.users(id) on delete set null,
  evidence_ref     text check (not projects.p7_has_secret(evidence_ref)),
  note             text check (not projects.p7_has_secret(note)),
  created_at       timestamptz not null default clock_timestamp()
);
create index if not exists p7_deployment_events_idx on projects.p7_deployment_events (deployment_id, created_at);

create or replace function projects.p7_deployment_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a deployment record is production history and is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then
    raise exception 'a deployment record is written by the service-role runner door, never by a direct statement' using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' and (new.candidate_id is distinct from old.candidate_id or new.commit_ref is distinct from old.commit_ref or new.artifact_sha256 is distinct from old.artifact_sha256
     or new.plan_id is distinct from old.plan_id or new.environment is distinct from old.environment or new.project_id is distinct from old.project_id or new.attempt is distinct from old.attempt) then
    raise exception 'a deployment record names one exact candidate, plan and environment, and keeps them' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p7_deployment_guard on projects.p7_deployments;
create trigger p7_deployment_guard before insert or update or delete on projects.p7_deployments for each row execute function projects.p7_deployment_guard();
drop trigger if exists p7_deployments_updated_at on projects.p7_deployments;
create trigger p7_deployments_updated_at before update on projects.p7_deployments for each row execute function core.set_updated_at();

do $$
declare t text;
begin
  for t in select unnest(array['phase_seven', 'p7_known_limitations', 'p7_deployment_plans', 'p7_readiness_items', 'p7_deployment_approvals', 'p7_deployments', 'p7_deployment_events']) loop
    perform projects.p7_harden('projects', t);
  end loop;
  perform projects.p7_guard_fk('phase_seven', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('phase_seven', 'phase_six_handoff_id', 'projects.phase_six_handoffs');
  perform projects.p7_guard_fk('phase_seven', 'candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('p7_known_limitations', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_deployment_plans', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_deployment_plans', 'phase_seven_id', 'projects.phase_seven');
  perform projects.p7_guard_fk('p7_deployment_plans', 'candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('p7_readiness_items', 'plan_id', 'projects.p7_deployment_plans');
  perform projects.p7_guard_fk('p7_deployment_approvals', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_deployment_approvals', 'plan_id', 'projects.p7_deployment_plans');
  perform projects.p7_guard_fk('p7_deployment_approvals', 'candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('p7_deployments', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_deployments', 'phase_seven_id', 'projects.phase_seven');
  perform projects.p7_guard_fk('p7_deployments', 'plan_id', 'projects.p7_deployment_plans');
  perform projects.p7_guard_fk('p7_deployments', 'candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('p7_deployment_events', 'deployment_id', 'projects.p7_deployments');
  for t in select unnest(array['p7_deployment_approvals', 'p7_deployment_events']) loop
    execute format('drop trigger if exists %I on projects.%I', t || '_append_only', t);
    execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p7_append_only()', t || '_append_only', t);
  end loop;
  for t in select unnest(array['p7_known_limitations', 'p7_readiness_items']) loop
    execute format('drop trigger if exists %I on projects.%I', t || '_door_only', t);
    execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p7_door_only()', t || '_door_only', t);
  end loop;
end $$;

insert into core.event_types (type, description, canonical) values
  ('project.phase_seven_ready', 'Phase 7 (Production Launch & Handover) is READY: Phase 6 completed, the exact Admin-approved candidate is still current, and M4 was verified paid in full. Emitted once.', true),
  ('project.deployment_approval_requested', 'A deployment plan for the exact Phase 6 candidate passed every pre-deployment gate and waits for an Admin.', true),
  ('project.deployment_approved', 'An Admin approved deployment of the exact candidate commit and artifact. Approval is not deployment: the runner records the deployment, and success needs live validation.', true),
  ('project.deployment_started', 'A deployment of the exact approved candidate was started by the runner.', true),
  ('project.deployment_succeeded', 'A deployment of the exact candidate reported success and awaits live validation. It is NOT production validation and not project completion.', true),
  ('project.deployment_failed', 'A deployment failed. An incident was opened and completion is paused.', true)
on conflict (type) do nothing;

-- ── the exact candidate resolver ───────────────────────────────────────────
-- is this candidate still the Admin-approved one AND still the build's commit? (a source change after approval makes it stale)
create or replace function projects.p7_candidate_ok(p_project_id uuid, p_candidate_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from qa.release_candidates c join projects.deliverable_details dd on dd.deliverable_id = c.build_deliverable_id
     where c.id = p_candidate_id and c.project_id = p_project_id and c.status = 'approved' and dd.commit_ref = c.commit_ref)
$$;
revoke all on function projects.p7_candidate_ok(uuid, uuid) from public, anon;
grant execute on function projects.p7_candidate_ok(uuid, uuid) to service_role;

-- a small internal state setter; the caller has already set projects.p7_door
create or replace function projects.p7_set_state(p_project_id uuid, p_state text)
returns void language sql set search_path = '' as $$
  update projects.phase_seven set state = p_state where project_id = p_project_id and state not in ('completed', 'phase8_ready')
$$;
revoke all on function projects.p7_set_state(uuid, text) from public, anon, authenticated, service_role;

-- ── open Phase 7 (the entry gate) ──────────────────────────────────────────
create or replace function projects.open_phase_seven(p_project_id uuid)
returns table (outcome text, phase_seven_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_project projects.projects; v_h projects.phase_six_handoffs; v_p projects.phase_seven; v_m4 boolean; v_ok boolean; v_state text; v_new uuid;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text, null::uuid; return; end if;
  select p.* into v_project from projects.projects p where p.id = p_project_id and p.deleted_at is null for update;
  if v_project.id is null then return query select 'unknown_project'::text, null::uuid; return; end if;
  if v_actor is not null and (v_project.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select * into v_h from projects.phase_six_handoffs h where h.project_id = p_project_id;
  if v_h.id is null then return query select 'phase_six_incomplete'::text, null::uuid; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  v_m4 := projects.m4_verified_paid(p_project_id);
  v_ok := projects.p7_candidate_ok(p_project_id, v_h.candidate_id);
  v_state := case when not v_ok then 'waiting_phase6' when not v_m4 then 'waiting_m4_verification' else 'phase7_ready' end;
  select * into v_p from projects.phase_seven s where s.project_id = p_project_id for update;
  if v_p.id is null then
    insert into projects.phase_seven (organization_id, project_id, phase_six_handoff_id, candidate_id, commit_ref, artifact_sha256, state, ready_at, blocked_reason)
    values (v_project.organization_id, p_project_id, v_h.id, v_h.candidate_id, v_h.commit_ref, v_h.artifact_sha256, v_state, case when v_state = 'phase7_ready' then now() end,
            case v_state when 'waiting_phase6' then 'The Phase 6 approved candidate is no longer current: a new governed candidate is needed.' end)
    returning id into v_new;
    -- the Phase 6 intake's known limitations are carried, so the handover cannot silently omit them
    insert into projects.p7_known_limitations (organization_id, project_id, title, source)
      select v_project.organization_id, p_project_id, left(btrim(coalesce(case jsonb_typeof(e) when 'string' then e #>> '{}' else coalesce(e ->> 'title', e ->> 'limitation', e::text) end, '')), 300), 'phase6_intake'
        from jsonb_array_elements(coalesce(v_h.payload -> 'knownLimitations', '[]'::jsonb)) e
       where length(btrim(coalesce(case jsonb_typeof(e) when 'string' then e #>> '{}' else coalesce(e ->> 'title', e ->> 'limitation', e::text) end, ''))) > 0
         and not projects.p7_has_secret(case jsonb_typeof(e) when 'string' then e #>> '{}' else coalesce(e ->> 'title', e ->> 'limitation', e::text) end)
      on conflict (project_id, title) do nothing;
    perform core.record_audit(v_project.organization_id, 'project.phase_seven_opened', 'phase_seven', v_new, null, jsonb_build_object('projectId', p_project_id, 'state', v_state, 'commit', v_h.commit_ref));
    if v_state = 'phase7_ready' then
      perform core.emit_event(v_project.organization_id, 'project.phase_seven_ready', 'phase_seven', v_new, jsonb_build_object('projectId', p_project_id));
      return query select 'ready'::text, v_new; return;
    end if;
    return query select case v_state when 'waiting_phase6' then 'candidate_not_current' else 'waiting_m4_verification' end::text, v_new; return;
  end if;
  if v_p.state in ('waiting_phase6', 'waiting_m4_verification') then
    if v_state = 'phase7_ready' then
      update projects.phase_seven set state = 'phase7_ready', ready_at = now(), blocked_reason = null where id = v_p.id;
      perform core.record_audit(v_project.organization_id, 'project.phase_seven_ready', 'phase_seven', v_p.id, null, jsonb_build_object('projectId', p_project_id));
      perform core.emit_event(v_project.organization_id, 'project.phase_seven_ready', 'phase_seven', v_p.id, jsonb_build_object('projectId', p_project_id));
      return query select 'ready'::text, v_p.id; return;
    end if;
    update projects.phase_seven set state = v_state where id = v_p.id and state <> v_state;
    return query select case v_state when 'waiting_phase6' then 'candidate_not_current' else 'waiting_m4_verification' end::text, v_p.id; return;
  end if;
  return query select 'already_started'::text, v_p.id;
end $$;
revoke all on function projects.open_phase_seven(uuid) from public, anon;
grant execute on function projects.open_phase_seven(uuid) to authenticated, service_role;

-- ── the migration plan validator ───────────────────────────────────────────
-- ordered steps with a stated reversibility, or an explicit "none" with its reason. Returns the problem, or null when valid.
create or replace function projects.p7_migration_plan_problem(p_plan jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare s jsonb; prev int := 0; n int; rev_all boolean := true;
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then return 'the migration plan is an object'; end if;
  if (p_plan ->> 'none') = 'true' then
    if length(btrim(coalesce(p_plan ->> 'reason', ''))) = 0 then return 'a plan with no migration says why'; end if;
    return null;
  end if;
  if jsonb_typeof(p_plan -> 'steps') <> 'array' or jsonb_array_length(p_plan -> 'steps') = 0 then return 'the migration plan lists its steps in order, or says "none" with a reason'; end if;
  for s in select * from jsonb_array_elements(p_plan -> 'steps') loop
    if jsonb_typeof(s) <> 'object' or length(btrim(coalesce(s ->> 'name', ''))) = 0 then return 'every migration step has a name'; end if;
    begin n := (s ->> 'order')::int; exception when others then return 'every migration step has an integer order'; end;
    if n is null or n <= prev then return 'migration steps run in strictly ascending order'; end if;
    prev := n;
    if (s ->> 'reversible') is null or (s ->> 'reversible') not in ('true', 'false') then return 'every migration step says whether it is reversible'; end if;
    if (s ->> 'reversible') = 'false' then rev_all := false; end if;
  end loop;
  if not rev_all and (p_plan ->> 'backupRequired') is distinct from 'true' then return 'an irreversible migration step requires a backup (backupRequired)'; end if;
  return null;
end $$;
revoke all on function projects.p7_migration_plan_problem(jsonb) from public, anon;
grant execute on function projects.p7_migration_plan_problem(jsonb) to authenticated, service_role;

-- ── the deployment plan door ───────────────────────────────────────────────
create or replace function projects.create_deployment_plan(p_project_id uuid, p_target_ref text, p_migration_plan jsonb, p_rollback_strategy text default null,
                                                           p_rollback_target_ref text default null, p_rollback_owner text default null, p_monitoring_plan text default null,
                                                           p_maintenance_window text default null, p_no_config_required boolean default false)
returns table (outcome text, plan_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_s projects.phase_seven; v_c qa.release_candidates; v_next int; v_new uuid; v_problem text;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = v_org for update;
  if v_s.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  -- THE ENTRY GATE: a plan exists only for a READY Phase 7 (M4 verified + the exact candidate still current)
  if v_s.state in ('waiting_phase6', 'waiting_m4_verification') then return query select 'phase_seven_not_ready'::text, null::uuid; return; end if;
  if v_s.state in ('completed', 'phase8_ready') then return query select 'project_completed'::text, null::uuid; return; end if;
  if not projects.p7_candidate_ok(p_project_id, v_s.candidate_id) then return query select 'candidate_not_current'::text, null::uuid; return; end if;
  -- a production code change needs a NEW approved candidate first (late-bound: the change records are defined with the validation tables)
  if exists (select 1 from projects.p7_change_records c where c.project_id = p_project_id and c.status = 'open' and c.kind = 'code_change') then return query select 'code_change_open'::text, null::uuid; return; end if;
  if exists (select 1 from projects.p7_deployments d where d.plan_id in (select id from projects.p7_deployment_plans where project_id = p_project_id) and d.status in ('requested', 'approved', 'started')) then
    return query select 'deployment_in_progress'::text, null::uuid; return;
  end if;
  if p_target_ref is null or length(btrim(p_target_ref)) = 0 then return query select 'target_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_target_ref) or projects.p7_has_secret(p_rollback_strategy) or projects.p7_has_secret(p_rollback_target_ref) or projects.p7_has_secret(p_rollback_owner)
     or projects.p7_has_secret(p_monitoring_plan) or projects.p7_has_secret(p_maintenance_window) or projects.p7_has_secret(p_migration_plan::text) then
    return query select 'contains_secret'::text, null::uuid; return;
  end if;
  v_problem := projects.p7_migration_plan_problem(p_migration_plan);
  if v_problem is not null then return query select 'bad_migration_plan'::text, null::uuid; return; end if;
  select * into v_c from qa.release_candidates c where c.id = v_s.candidate_id;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_deployment_plans set status = 'superseded' where project_id = p_project_id and status in ('draft', 'ready_for_approval', 'approved');
  select coalesce(max(version), 0) + 1 into v_next from projects.p7_deployment_plans where project_id = p_project_id;
  insert into projects.p7_deployment_plans (organization_id, project_id, phase_seven_id, candidate_id, version, commit_ref, artifact_sha256, environment, target_ref, migration_plan,
                                            rollback_strategy, rollback_target_ref, rollback_owner, monitoring_plan, maintenance_window, no_config_required, created_by)
  values (v_org, p_project_id, v_s.id, v_s.candidate_id, v_next, v_s.commit_ref, v_s.artifact_sha256, 'production', btrim(p_target_ref), p_migration_plan,
          coalesce(nullif(btrim(p_rollback_strategy), ''), nullif(btrim(v_c.rollback_plan), '')), nullif(btrim(p_rollback_target_ref), ''),
          coalesce(nullif(btrim(p_rollback_owner), ''), nullif(btrim(v_c.rollback_owner), '')), coalesce(nullif(btrim(p_monitoring_plan), ''), nullif(btrim(v_c.observability_notes), '')),
          nullif(btrim(p_maintenance_window), ''), coalesce(p_no_config_required, false), v_actor)
  returning id into v_new;
  perform projects.p7_set_state(p_project_id, 'deployment_planning');
  perform core.record_audit(v_org, 'deployment_plan.created', 'deployment_plan', v_new, null, jsonb_build_object('projectId', p_project_id, 'version', v_next, 'commit', v_s.commit_ref, 'artifact', v_s.artifact_sha256));
  return query select 'created'::text, v_new;
end $$;
revoke all on function projects.create_deployment_plan(uuid, text, jsonb, text, text, text, text, text, boolean) from public, anon;
grant execute on function projects.create_deployment_plan(uuid, text, jsonb, text, text, text, text, text, boolean) to authenticated;

-- ── readiness items (by NAME only) ─────────────────────────────────────────
create or replace function projects.record_readiness_item(p_plan_id uuid, p_kind text, p_name text, p_status text, p_evidence_ref text default null,
                                                          p_owner text default null, p_instruction text default null, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.p7_deployment_plans;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_plan from projects.p7_deployment_plans p where p.id = p_plan_id and p.organization_id = v_org for update;
  if v_plan.id is null then return query select 'not_found'::text; return; end if;
  if v_plan.status <> 'draft' then return query select 'plan_frozen'::text; return; end if;
  if p_status not in ('pending', 'ready', 'not_ready', 'blocked_manual_external') then return query select 'bad_status'::text; return; end if;
  if p_kind is null or p_kind not in ('environment', 'config_ref', 'secret_ref', 'migration', 'rollback', 'monitoring', 'external_dependency', 'manual_dns', 'manual_store', 'manual_signing', 'manual_account', 'manual_other') then
    return query select 'bad_kind'::text; return;
  end if;
  if p_name is null or p_name !~ '^[A-Za-z_][A-Za-z0-9_.:/ -]{1,100}$' then return query select 'bad_name'::text; return; end if;
  if projects.p7_has_secret(p_name) or projects.p7_has_secret(p_evidence_ref) or projects.p7_has_secret(p_owner) or projects.p7_has_secret(p_instruction) or projects.p7_has_secret(p_note) then
    return query select 'contains_secret'::text; return;
  end if;
  if p_status = 'ready' and (p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0) then return query select 'evidence_required'::text; return; end if;
  if p_kind like 'manual\_%' and (p_instruction is null or length(btrim(p_instruction)) = 0) then return query select 'instruction_required'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_readiness_items (organization_id, plan_id, kind, name, status, owner, instruction, evidence_ref, note, recorded_by)
  values (v_org, p_plan_id, p_kind, btrim(p_name), p_status, p_owner, p_instruction, p_evidence_ref, p_note, v_actor)
  on conflict (plan_id, kind, name) do update set status = excluded.status, owner = excluded.owner, instruction = excluded.instruction, evidence_ref = excluded.evidence_ref,
         note = excluded.note, recorded_by = excluded.recorded_by, recorded_at = now();
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_readiness_item(uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function projects.record_readiness_item(uuid, text, text, text, text, text, text, text) to authenticated;

-- ── the deployment gate (P701 §7), read from rows ──────────────────────────
create or replace function projects.deployment_gate(p_plan_id uuid)
returns table (gate text, satisfied boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_plan projects.p7_deployment_plans; v_s projects.phase_seven; v_n int; v_bad int; v_ready int; v_problem text;
begin
  select * into v_plan from projects.p7_deployment_plans p where p.id = p_plan_id;
  if v_plan.id is null then return; end if;
  if not v_service and (v_actor is null or v_plan.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;
  select * into v_s from projects.phase_seven s where s.id = v_plan.phase_seven_id;

  gate := 'exact_candidate';
  satisfied := projects.p7_candidate_ok(v_plan.project_id, v_plan.candidate_id) and v_plan.candidate_id = v_s.candidate_id and v_plan.commit_ref = v_s.commit_ref and v_plan.artifact_sha256 = v_s.artifact_sha256;
  detail := case when satisfied then 'the plan carries the exact Admin-approved Phase 6 candidate, which is still the build''s commit' else 'the plan is not for the current Admin-approved candidate (a source change or a new candidate voids it)' end;
  return next;

  gate := 'm4_verified'; satisfied := projects.m4_verified_paid(v_plan.project_id);
  detail := case when satisfied then 'M4 is verified paid in full by an Admin' else 'M4 is not verified paid (an invoice, a claim or a proof is not verification)' end;
  return next;

  select count(*) into v_n from qa.unresolved_product_defects(v_plan.project_id) u where u.s_level <= 1;
  gate := 'no_release_blocker'; satisfied := v_n = 0;
  detail := case when satisfied then 'no unresolved S0/S1 product defect' else format('%s unresolved S0/S1 product defect(s)', v_n) end;
  return next;

  select count(*) filter (where status = 'ready'), count(*) filter (where status <> 'ready') into v_ready, v_bad from projects.p7_readiness_items i where i.plan_id = p_plan_id and i.kind = 'environment';
  gate := 'environment_ready'; satisfied := length(btrim(coalesce(v_plan.target_ref, ''))) > 0 and v_ready > 0 and v_bad = 0;
  detail := case when satisfied then 'the production target is named and its environment checks are ready with evidence' else 'the environment has no ready check with evidence, or a check is not ready' end;
  return next;

  select count(*) filter (where status = 'ready'), count(*) filter (where status <> 'ready') into v_ready, v_bad from projects.p7_readiness_items i where i.plan_id = p_plan_id and i.kind in ('config_ref', 'secret_ref');
  gate := 'config_ready'; satisfied := v_bad = 0 and (v_ready > 0 or v_plan.no_config_required);
  detail := case when satisfied then 'every configuration and secret reference (by name) is ready' when v_bad > 0 then format('%s config/secret reference(s) not ready', v_bad) else 'no configuration/secret reference is listed (or the plan does not say none is required)' end;
  return next;

  v_problem := projects.p7_migration_plan_problem(v_plan.migration_plan);
  select count(*) filter (where status = 'ready'), count(*) filter (where status <> 'ready') into v_ready, v_bad from projects.p7_readiness_items i where i.plan_id = p_plan_id and i.kind = 'migration';
  gate := 'migration_ready';
  satisfied := v_problem is null and v_bad = 0 and (coalesce((v_plan.migration_plan ->> 'none'), 'false') = 'true' or v_ready > 0);
  detail := case when v_problem is not null then v_problem when v_bad > 0 then format('%s migration check(s) not ready', v_bad)
                 when satisfied then 'the migration plan is ordered and its checks are ready' else 'the migration plan has no ready ordering/dependency check' end;
  return next;

  select count(*) filter (where status <> 'ready') into v_bad from projects.p7_readiness_items i where i.plan_id = p_plan_id and i.kind = 'rollback';
  gate := 'rollback_ready';
  satisfied := v_bad = 0 and length(btrim(coalesce(v_plan.rollback_strategy, ''))) > 0 and length(btrim(coalesce(v_plan.rollback_target_ref, ''))) > 0 and length(btrim(coalesce(v_plan.rollback_owner, ''))) > 0;
  detail := case when satisfied then 'a rollback strategy, a named target and an owner exist' else 'the rollback strategy, target or owner is missing, or a rollback check is not ready (an unknown target is a block)' end;
  return next;

  select count(*) filter (where status = 'ready'), count(*) filter (where status <> 'ready') into v_ready, v_bad from projects.p7_readiness_items i where i.plan_id = p_plan_id and i.kind = 'monitoring';
  gate := 'monitoring_ready'; satisfied := length(btrim(coalesce(v_plan.monitoring_plan, ''))) > 0 and v_ready > 0 and v_bad = 0;
  detail := case when satisfied then 'a monitoring plan exists and its endpoints are checked ready' else 'no monitoring plan, or no ready monitoring check' end;
  return next;

  select count(*) filter (where status <> 'ready') into v_bad from projects.p7_readiness_items i where i.plan_id = p_plan_id and (i.kind like 'manual\_%' or i.kind = 'external_dependency');
  gate := 'manual_external_steps'; satisfied := v_bad = 0;
  detail := case when satisfied then 'every manual external step (DNS, store, signing, account) and external dependency has evidence' else format('%s manual external step(s) are not done (BLOCKED_MANUAL_EXTERNAL)', v_bad) end;
  return next;
end $$;
revoke all on function projects.deployment_gate(uuid) from public, anon;
grant execute on function projects.deployment_gate(uuid) to authenticated, service_role;

-- ── ask for approval, decide ───────────────────────────────────────────────
create or replace function projects.request_deployment_approval(p_plan_id uuid)
returns table (outcome text, missing text[])
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.p7_deployment_plans; v_missing text[];
begin
  if v_actor is null then return query select 'no_actor'::text, '{}'::text[]; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, '{}'::text[]; return; end if;
  select * into v_plan from projects.p7_deployment_plans p where p.id = p_plan_id and p.organization_id = v_org for update;
  if v_plan.id is null then return query select 'not_found'::text, '{}'::text[]; return; end if;
  if v_plan.status = 'ready_for_approval' then return query select 'already_requested'::text, '{}'::text[]; return; end if;
  if v_plan.status <> 'draft' then return query select 'wrong_state'::text, '{}'::text[]; return; end if;
  select coalesce(array_agg(g.gate || ': ' || g.detail order by g.gate), '{}') into v_missing from projects.deployment_gate(p_plan_id) g where not g.satisfied;
  if cardinality(v_missing) > 0 then return query select 'not_ready'::text, v_missing; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_deployment_plans set status = 'ready_for_approval' where id = p_plan_id;
  perform projects.p7_set_state(v_plan.project_id, 'waiting_deployment_approval');
  perform core.record_audit(v_org, 'deployment_plan.approval_requested', 'deployment_plan', p_plan_id, null, jsonb_build_object('projectId', v_plan.project_id, 'commit', v_plan.commit_ref));
  perform core.emit_event(v_org, 'project.deployment_approval_requested', 'deployment_plan', p_plan_id, jsonb_build_object('projectId', v_plan.project_id, 'version', v_plan.version));
  return query select 'requested'::text, '{}'::text[];
end $$;
revoke all on function projects.request_deployment_approval(uuid) from public, anon;
grant execute on function projects.request_deployment_approval(uuid) to authenticated;

create or replace function projects.decide_deployment_plan(p_plan_id uuid, p_decision text, p_note text default null, p_ack_destructive boolean default false)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.p7_deployment_plans;
  v_missing int; v_destructive boolean;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  -- an Admin decides, never an agent and never a delivery lead
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('approve', 'reject', 'request_changes') then return query select 'bad_decision'::text; return; end if;
  if p_decision <> 'approve' and (p_note is null or length(btrim(p_note)) = 0) then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_plan from projects.p7_deployment_plans p where p.id = p_plan_id and p.organization_id = v_org for update;
  if v_plan.id is null then return query select 'not_found'::text; return; end if;
  if v_plan.status <> 'ready_for_approval' then return query select 'wrong_state'::text; return; end if;
  -- the person who built the plan does not approve it
  if v_plan.created_by is not distinct from v_actor then return query select 'creator_cannot_approve'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  if p_decision = 'approve' then
    -- the gates are re-read NOW: a candidate that changed since the request is not approved
    select count(*) into v_missing from projects.deployment_gate(p_plan_id) g where not g.satisfied;
    if v_missing > 0 then return query select 'gate_not_satisfied'::text; return; end if;
    v_destructive := exists (select 1 from jsonb_array_elements(coalesce(v_plan.migration_plan -> 'steps', '[]'::jsonb)) s where (s ->> 'destructive') = 'true' or (s ->> 'reversible') = 'false');
    if v_destructive and not coalesce(p_ack_destructive, false) then return query select 'destructive_ack_required'::text; return; end if;
    insert into projects.p7_deployment_approvals (organization_id, project_id, plan_id, candidate_id, commit_ref, artifact_sha256, decision, note, acknowledged_destructive, decided_by)
    values (v_org, v_plan.project_id, p_plan_id, v_plan.candidate_id, v_plan.commit_ref, v_plan.artifact_sha256, 'approve', p_note, coalesce(p_ack_destructive, false), v_actor);
    update projects.p7_deployment_plans set status = 'approved' where id = p_plan_id;
    perform core.record_audit(v_org, 'deployment_plan.approved', 'deployment_plan', p_plan_id, null, jsonb_build_object('projectId', v_plan.project_id, 'commit', v_plan.commit_ref, 'artifact', v_plan.artifact_sha256));
    perform core.emit_event(v_org, 'project.deployment_approved', 'deployment_plan', p_plan_id, jsonb_build_object('projectId', v_plan.project_id, 'version', v_plan.version));
    return query select 'approved'::text; return;
  end if;
  insert into projects.p7_deployment_approvals (organization_id, project_id, plan_id, candidate_id, commit_ref, artifact_sha256, decision, note, decided_by)
  values (v_org, v_plan.project_id, p_plan_id, v_plan.candidate_id, v_plan.commit_ref, v_plan.artifact_sha256, p_decision, p_note, v_actor);
  update projects.p7_deployment_plans set status = case p_decision when 'reject' then 'rejected' else 'draft' end where id = p_plan_id;
  perform projects.p7_set_state(v_plan.project_id, 'deployment_planning');
  perform core.record_audit(v_org, 'deployment_plan.' || p_decision, 'deployment_plan', p_plan_id, null, jsonb_build_object('projectId', v_plan.project_id));
  return query select case p_decision when 'reject' then 'rejected' else 'sent_back' end::text;
end $$;
revoke all on function projects.decide_deployment_plan(uuid, text, text, boolean) from public, anon;
grant execute on function projects.decide_deployment_plan(uuid, text, text, boolean) to authenticated;

-- is the approval still good? it names the exact commit + artifact, and the candidate must still be the current Admin-approved one
create or replace function projects.p7_deployment_approved(p_plan_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from projects.p7_deployment_plans p
      join projects.phase_seven s on s.id = p.phase_seven_id
      join projects.p7_deployment_approvals a on a.plan_id = p.id and a.decision = 'approve' and a.commit_ref = p.commit_ref and a.artifact_sha256 = p.artifact_sha256 and a.candidate_id = p.candidate_id
     where p.id = p_plan_id and p.status = 'approved' and p.candidate_id = s.candidate_id and p.commit_ref = s.commit_ref and p.artifact_sha256 = s.artifact_sha256
       and projects.p7_candidate_ok(p.project_id, p.candidate_id)
       and (coalesce((select auth.role()), '') = 'service_role' or (p.organization_id = (select core.current_organization_id()) and coalesce((select core.is_internal()), false))))
$$;
revoke all on function projects.p7_deployment_approved(uuid) from public, anon;
grant execute on function projects.p7_deployment_approved(uuid) to authenticated, service_role;

-- ── the runner doors (service role only): a deployment is RECORDED, never fabricated ──
create or replace function projects.p7_deployment_event(p_deployment_id uuid, p_org uuid, p_kind text, p_from text, p_to text, p_actor uuid, p_evidence text, p_note text, p_blocker text)
returns void language sql set search_path = '' as $$
  insert into projects.p7_deployment_events (organization_id, deployment_id, kind, from_status, to_status, actor_user, evidence_ref, note, blocker_code)
  values (p_org, p_deployment_id, p_kind, p_from, p_to, p_actor, p_evidence, p_note, p_blocker)
$$;
revoke all on function projects.p7_deployment_event(uuid, uuid, text, text, text, uuid, text, text, text) from public, anon, authenticated, service_role;

create or replace function projects.request_deployment(p_plan_id uuid, p_idempotency_key text)
returns table (outcome text, deployment_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_plan projects.p7_deployment_plans; v_d projects.p7_deployments; v_new uuid; v_attempt int;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return query select 'runner_only'::text, null::uuid; return; end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then return query select 'key_required'::text, null::uuid; return; end if;
  select * into v_plan from projects.p7_deployment_plans p where p.id = p_plan_id for update;
  if v_plan.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select * into v_d from projects.p7_deployments d where d.plan_id = p_plan_id and d.idempotency_key = p_idempotency_key;
  if v_d.id is not null then return query select 'already_requested'::text, v_d.id; return; end if;
  -- a duplicate request while one is live, or after a deployment that is still awaiting validation, creates no second deployment
  select * into v_d from projects.p7_deployments d where d.plan_id = p_plan_id and d.status in ('requested', 'approved', 'started', 'succeeded_pending_validation', 'recovered_pending_validation') order by d.attempt desc limit 1;
  if v_d.id is not null then return query select case when v_d.status in ('succeeded_pending_validation', 'recovered_pending_validation') then 'already_deployed' else 'deployment_in_progress' end::text, v_d.id; return; end if;
  if not projects.p7_deployment_approved(p_plan_id) then return query select 'not_approved'::text, null::uuid; return; end if;
  -- an open critical incident stops further deploy actions until an Admin decides (late-bound: defined with the incident tables)
  if projects.p7_deploy_blocker(v_plan.project_id) is not null then return query select 'incident_containment'::text, null::uuid; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  select coalesce(max(attempt), 0) + 1 into v_attempt from projects.p7_deployments where plan_id = p_plan_id;
  insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key, status)
  values (v_plan.organization_id, v_plan.project_id, v_plan.phase_seven_id, p_plan_id, v_plan.candidate_id, v_plan.commit_ref, v_plan.artifact_sha256, v_plan.environment, v_attempt, p_idempotency_key, 'requested')
  returning id into v_new;
  perform projects.p7_deployment_event(v_new, v_plan.organization_id, 'transition', null, 'requested', null, null, null, null);
  update projects.p7_deployments set status = 'approved' where id = v_new;
  perform projects.p7_deployment_event(v_new, v_plan.organization_id, 'transition', 'requested', 'approved', null, null, 'the Admin approval for this exact commit and artifact was verified', null);
  perform core.record_audit(v_plan.organization_id, 'deployment.requested', 'deployment', v_new, null, jsonb_build_object('projectId', v_plan.project_id, 'planId', p_plan_id, 'commit', v_plan.commit_ref, 'attempt', v_attempt));
  return query select 'requested'::text, v_new;
end $$;
revoke all on function projects.request_deployment(uuid, text) from public, anon, authenticated;
grant execute on function projects.request_deployment(uuid, text) to service_role;

-- the honest blocker: the executor is not configured / a credential is missing / a manual step is pending. The status does NOT move.
create or replace function projects.record_deployment_blocker(p_deployment_id uuid, p_code text, p_detail text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_d projects.p7_deployments;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return query select 'runner_only'::text; return; end if;
  if p_code is null or p_code !~ '^[a-z_]+$' then return query select 'bad_code'::text; return; end if;
  if projects.p7_has_secret(p_detail) then return query select 'contains_secret'::text; return; end if;
  select * into v_d from projects.p7_deployments d where d.id = p_deployment_id for update;
  if v_d.id is null then return query select 'not_found'::text; return; end if;
  if v_d.status <> 'approved' then return query select 'wrong_state'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_deployments set blocker_code = p_code, note = p_detail where id = p_deployment_id;
  perform projects.p7_deployment_event(p_deployment_id, v_d.organization_id, 'blocker', v_d.status, v_d.status, null, null, p_detail, p_code);
  return query select 'blocked'::text;
end $$;
revoke all on function projects.record_deployment_blocker(uuid, text, text) from public, anon, authenticated;
grant execute on function projects.record_deployment_blocker(uuid, text, text) to service_role;

notify pgrst, 'reload schema';
