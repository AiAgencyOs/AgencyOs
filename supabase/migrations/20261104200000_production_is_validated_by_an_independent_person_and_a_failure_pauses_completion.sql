-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7, part 2: production validation, incidents, rollback, the change-after-Phase-6 rule.   Spec: P701 §8-§9, P704 §9-§11, P705, P706.
--
--   projects.p7_validation_runs / p7_validation_checks   smoke + live-journey checks with truth states passed / failed / not_tested; a pass needs evidence;
--                                                        recorded by an INDEPENDENT person (never the deployment's actor, never a service-role agent);
--                                                        a run is tied to the exact deployment (and so to the exact candidate commit)
--   projects.p7_incidents / p7_incident_events           typed, severity-tracked, deduplicated (one canonical incident per deployment+type while open); closes only
--                                                        after a PASSED re-validation tied to it, plus a review (root cause, corrective actions)
--   projects.p7_rollback_decisions                       a rollback is a decision by an Admin with a NAMED target; an irreversible migration is never rolled back blind
--   projects.p7_change_records                           a code change after Phase 6 voids production validation and needs a NEW approved candidate with every
--                                                        Phase 6 hard gate satisfied (rebind); a config-only change needs a re-smoke of the SAME candidate
--   record_deployment_progress                           the service-role runner door that moves a deployment (started / succeeded / failed / rolled back / recovered)
--
-- A failed production check PAUSES COMPLETION (phase_seven.completion_paused) and only a verified recovery lifts it. Deployment success alone is
-- `succeeded_pending_validation`; ProductionValidated is established here, by QA/Release evidence, never by the deployment claim.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.p7_incidents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  phase_seven_id   uuid not null references projects.phase_seven(id) on delete cascade,
  deployment_id    uuid not null references projects.p7_deployments(id) on delete restrict,
  candidate_id     uuid not null references qa.release_candidates(id) on delete restrict,
  commit_ref       text not null,
  incident_type    text not null check (incident_type in ('deployment_failure', 'config_failure', 'migration_failure', 'runtime_failure', 'security_incident', 'provider_outage', 'data_integrity_risk', 'monitoring_failure')),
  severity         text not null check (severity in ('sev1', 'sev2', 'sev3')),
  state            text not null default 'open' check (state in ('open', 'contained', 'recovering', 'recovered_pending_validation', 'closed')),
  recovery_path    text not null default 'unclassified' check (recovery_path in ('unclassified', 'config', 'code', 'provider', 'rollback')),
  impact           text check (not projects.p7_has_secret(impact)),
  root_cause       text check (not projects.p7_has_secret(root_cause)),
  timeline_summary text check (not projects.p7_has_secret(timeline_summary)),
  corrective_actions text check (not projects.p7_has_secret(corrective_actions)),
  opened_by        uuid references core.users(id) on delete set null,
  opened_at        timestamptz not null default clock_timestamp(),
  reviewed_by      uuid references core.users(id) on delete set null,
  closed_at        timestamptz,
  check (state <> 'closed' or (closed_at is not null and reviewed_by is not null and length(btrim(coalesce(root_cause, ''))) > 0 and length(btrim(coalesce(corrective_actions, ''))) > 0))
);
create unique index if not exists p7_incidents_one_open on projects.p7_incidents (deployment_id, incident_type) where state <> 'closed';

create table if not exists projects.p7_incident_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  incident_id      uuid not null references projects.p7_incidents(id) on delete cascade,
  kind             text not null check (kind in ('signal', 'containment', 'classification', 'rollback_decision', 'recovery', 'validation', 'review', 'note')),
  actor_user       uuid references core.users(id) on delete set null,
  note             text check (not projects.p7_has_secret(note)),
  evidence_ref     text check (not projects.p7_has_secret(evidence_ref)),
  created_at       timestamptz not null default clock_timestamp()
);

create table if not exists projects.p7_rollback_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  incident_id      uuid not null references projects.p7_incidents(id) on delete cascade,
  deployment_id    uuid not null references projects.p7_deployments(id) on delete restrict,
  target_ref       text not null check (length(btrim(target_ref)) > 0 and not projects.p7_has_secret(target_ref)),
  risk             text not null check (length(btrim(risk)) > 0 and not projects.p7_has_secret(risk)),
  irreversible_migration_acknowledged boolean not null default false,
  decision         text not null check (decision in ('approve', 'reject')),
  reason           text check (not projects.p7_has_secret(reason)),
  decided_by       uuid not null references core.users(id) on delete restrict,
  decided_at       timestamptz not null default clock_timestamp(),
  executed_at      timestamptz,
  check (decision = 'approve' or (reason is not null and length(btrim(reason)) > 0))
);

create table if not exists projects.p7_change_records (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references core.organizations(id) on delete cascade,
  project_id             uuid not null references projects.projects(id) on delete cascade,
  kind                   text not null check (kind in ('code_change', 'config_only')),
  description            text not null check (length(btrim(description)) > 0 and not projects.p7_has_secret(description)),
  affected_categories    text[] not null default '{}',
  from_candidate_id      uuid not null references qa.release_candidates(id) on delete restrict,
  status                 text not null default 'open' check (status in ('open', 'revalidated')),
  resulting_candidate_id uuid references qa.release_candidates(id) on delete restrict,
  opened_by              uuid references core.users(id) on delete set null,
  opened_at              timestamptz not null default clock_timestamp(),
  closed_at              timestamptz,
  check (status = 'open' or closed_at is not null)
);

create table if not exists projects.p7_validation_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  deployment_id    uuid not null references projects.p7_deployments(id) on delete restrict,
  candidate_id     uuid not null references qa.release_candidates(id) on delete restrict,
  commit_ref       text not null,
  kind             text not null check (kind in ('smoke', 'live_journey', 'post_rollback', 'post_recovery')),
  incident_id      uuid references projects.p7_incidents(id) on delete restrict,
  status           text not null default 'running' check (status in ('running', 'passed', 'failed', 'blocked')),
  started_by       uuid not null references core.users(id) on delete restrict,
  started_at       timestamptz not null default clock_timestamp(),
  finished_at      timestamptz,
  summary          text check (not projects.p7_has_secret(summary)),
  check (status = 'running' or finished_at is not null)
);
create unique index if not exists p7_validation_one_running on projects.p7_validation_runs (deployment_id, kind) where status = 'running';

create table if not exists projects.p7_validation_checks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  run_id           uuid not null references projects.p7_validation_runs(id) on delete cascade,
  check_key        text not null check (check_key in ('app_starts', 'critical_routes', 'authentication', 'core_api', 'database', 'primary_workflow', 'external_integrations',
                                                      'monitoring_logging', 'no_critical_runtime_error', 'assets')),
  required         boolean not null default true,
  truth            text not null check (truth in ('passed', 'failed', 'not_tested')),
  evidence_ref     text check (not projects.p7_has_secret(evidence_ref)),
  detail           text check (not projects.p7_has_secret(detail)),
  recorded_by      uuid references core.users(id) on delete set null,
  recorded_at      timestamptz not null default clock_timestamp(),
  unique (run_id, check_key),
  -- a pass is evidence, not an assertion
  check (truth <> 'passed' or (evidence_ref is not null and length(btrim(evidence_ref)) > 0)),
  check (truth = 'passed' or (detail is not null and length(btrim(detail)) > 0))
);

-- a finished run, a rollback decision's identity and an incident's identity do not change
create or replace function projects.p7_validation_run_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a production validation run is evidence and is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception 'a validation run is written through its door' using errcode = 'restrict_violation'; end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'running' then raise exception 'a finished validation run is never edited' using errcode = 'restrict_violation'; end if;
    if new.deployment_id is distinct from old.deployment_id or new.commit_ref is distinct from old.commit_ref or new.candidate_id is distinct from old.candidate_id or new.kind is distinct from old.kind then
      raise exception 'a validation run is about one exact deployment' using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists p7_validation_run_guard on projects.p7_validation_runs;
create trigger p7_validation_run_guard before insert or update or delete on projects.p7_validation_runs for each row execute function projects.p7_validation_run_guard();

create or replace function projects.p7_validation_check_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_status text;
begin
  if tg_op = 'DELETE' then raise exception 'a validation check is evidence and is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception 'a validation check is written through its door' using errcode = 'restrict_violation'; end if;
  select r.status into v_status from projects.p7_validation_runs r where r.id = coalesce(new.run_id, old.run_id);
  if v_status is distinct from 'running' then raise exception 'the checks of a finished validation run are never edited' using errcode = 'restrict_violation'; end if;
  return new;
end $$;
drop trigger if exists p7_validation_check_guard on projects.p7_validation_checks;
create trigger p7_validation_check_guard before insert or update or delete on projects.p7_validation_checks for each row execute function projects.p7_validation_check_guard();

create or replace function projects.p7_incident_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'an incident is history and is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception 'an incident changes through its doors, never by a direct statement' using errcode = 'restrict_violation'; end if;
  if tg_op = 'UPDATE' then
    if old.state = 'closed' then raise exception 'a closed incident is never edited: history is not rewritten' using errcode = 'restrict_violation'; end if;
    if new.deployment_id is distinct from old.deployment_id or new.incident_type is distinct from old.incident_type or new.commit_ref is distinct from old.commit_ref or new.opened_at is distinct from old.opened_at then
      raise exception 'an incident keeps what it was raised about' using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists p7_incident_guard on projects.p7_incidents;
create trigger p7_incident_guard before insert or update or delete on projects.p7_incidents for each row execute function projects.p7_incident_guard();

create or replace function projects.p7_rollback_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a rollback decision is history and is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception 'a rollback decision is written through its door' using errcode = 'restrict_violation'; end if;
  if tg_op = 'UPDATE' and (new.target_ref is distinct from old.target_ref or new.decision is distinct from old.decision or new.decided_by is distinct from old.decided_by
                           or new.deployment_id is distinct from old.deployment_id or old.executed_at is not null) then
    raise exception 'a rollback decision is as it was decided; only its execution is recorded, once' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p7_rollback_guard on projects.p7_rollback_decisions;
create trigger p7_rollback_guard before insert or update or delete on projects.p7_rollback_decisions for each row execute function projects.p7_rollback_guard();

create or replace function projects.p7_change_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a production change record is history and is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception 'a change record is written through its door' using errcode = 'restrict_violation'; end if;
  if tg_op = 'UPDATE' and (old.status <> 'open' or new.kind is distinct from old.kind or new.description is distinct from old.description or new.from_candidate_id is distinct from old.from_candidate_id) then
    raise exception 'a closed change record is history' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p7_change_guard on projects.p7_change_records;
create trigger p7_change_guard before insert or update or delete on projects.p7_change_records for each row execute function projects.p7_change_guard();

do $$
declare t text;
begin
  for t in select unnest(array['p7_incidents', 'p7_incident_events', 'p7_rollback_decisions', 'p7_change_records', 'p7_validation_runs', 'p7_validation_checks']) loop
    perform projects.p7_harden('projects', t);
  end loop;
  perform projects.p7_guard_fk('p7_incidents', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_incidents', 'phase_seven_id', 'projects.phase_seven');
  perform projects.p7_guard_fk('p7_incidents', 'deployment_id', 'projects.p7_deployments');
  perform projects.p7_guard_fk('p7_incidents', 'candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('p7_incident_events', 'incident_id', 'projects.p7_incidents');
  perform projects.p7_guard_fk('p7_rollback_decisions', 'incident_id', 'projects.p7_incidents');
  perform projects.p7_guard_fk('p7_rollback_decisions', 'deployment_id', 'projects.p7_deployments');
  perform projects.p7_guard_fk('p7_change_records', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_change_records', 'from_candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('p7_change_records', 'resulting_candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('p7_validation_runs', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_validation_runs', 'deployment_id', 'projects.p7_deployments');
  perform projects.p7_guard_fk('p7_validation_runs', 'candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('p7_validation_runs', 'incident_id', 'projects.p7_incidents');
  perform projects.p7_guard_fk('p7_validation_checks', 'run_id', 'projects.p7_validation_runs');
  execute 'drop trigger if exists p7_incident_events_append_only on projects.p7_incident_events';
  execute 'create trigger p7_incident_events_append_only before insert or update or delete on projects.p7_incident_events for each row execute function projects.p7_append_only()';
end $$;

insert into core.event_types (type, description, canonical) values
  ('project.production_validated', 'ProductionValidated: QA/Release evidence shows the exact deployed candidate passed its required smoke and live checks, with no open incident. A deployment claim never produces this.', true),
  ('project.production_validation_failed', 'DeploymentValidationFailed: a required production check failed. An incident was raised and completion is paused.', true),
  ('project.deployment_incident_raised', 'A production incident was raised for a deployment (typed, with a severity). Completion is paused until verified recovery.', true),
  ('project.deployment_incident_closed', 'A production incident was closed after a passed re-validation and a review.', true),
  ('project.production_code_change_required', 'A production fix needs a code change: a new build, affected Phase 6 revalidation and a new approved candidate are required before any redeploy.', true)
on conflict (type) do nothing;

-- ── the late-bound blocker request_deployment asks about ───────────────────
create or replace function projects.p7_deploy_blocker(p_project_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when exists (select 1 from projects.p7_incidents i where i.project_id = p_project_id and i.state <> 'closed' and i.severity = 'sev1')
              then 'an open critical incident stops further deploy actions until an Admin decides' end
$$;
revoke all on function projects.p7_deploy_blocker(uuid) from public, anon, authenticated;
grant execute on function projects.p7_deploy_blocker(uuid) to service_role;

-- ── incidents ──────────────────────────────────────────────────────────────
create or replace function projects.p7_incident_event(p_incident_id uuid, p_org uuid, p_kind text, p_actor uuid, p_note text, p_evidence text default null)
returns void language sql set search_path = '' as $$
  insert into projects.p7_incident_events (organization_id, incident_id, kind, actor_user, note, evidence_ref) values (p_org, p_incident_id, p_kind, p_actor, p_note, p_evidence)
$$;
revoke all on function projects.p7_incident_event(uuid, uuid, text, uuid, text, text) from public, anon, authenticated, service_role;

-- one canonical incident per deployment and type while it is open; a duplicate signal is recorded on it, never as a second incident. Completion pauses at once.
create or replace function projects.p7_open_incident(p_deployment_id uuid, p_type text, p_severity text, p_impact text, p_note text, p_actor uuid)
returns uuid language plpgsql set search_path = '' as $$
declare v_d projects.p7_deployments; v_i uuid;
begin
  select * into v_d from projects.p7_deployments d where d.id = p_deployment_id;
  select i.id into v_i from projects.p7_incidents i where i.deployment_id = p_deployment_id and i.incident_type = p_type and i.state <> 'closed';
  if v_i is not null then
    perform projects.p7_incident_event(v_i, v_d.organization_id, 'signal', p_actor, 'a duplicate signal was recorded on the existing incident: ' || coalesce(p_note, ''));
    return v_i;
  end if;
  insert into projects.p7_incidents (organization_id, project_id, phase_seven_id, deployment_id, candidate_id, commit_ref, incident_type, severity, state, impact, opened_by)
  values (v_d.organization_id, v_d.project_id, v_d.phase_seven_id, v_d.id, v_d.candidate_id, v_d.commit_ref, p_type, p_severity, case when p_severity = 'sev1' then 'contained' else 'open' end, p_impact, p_actor)
  returning id into v_i;
  perform projects.p7_incident_event(v_i, v_d.organization_id, 'signal', p_actor, p_note);
  if p_severity = 'sev1' then
    perform projects.p7_incident_event(v_i, v_d.organization_id, 'containment', p_actor, 'completion and handover are paused and further deploy actions are stopped until an Admin decides');
  end if;
  update projects.phase_seven set completion_paused = true, paused_reason = 'a production incident is open: ' || p_type where id = v_d.phase_seven_id;
  perform core.record_audit(v_d.organization_id, 'incident.opened', 'incident', v_i, null, jsonb_build_object('projectId', v_d.project_id, 'type', p_type, 'severity', p_severity, 'deploymentId', v_d.id));
  perform core.emit_event(v_d.organization_id, 'project.deployment_incident_raised', 'incident', v_i, jsonb_build_object('projectId', v_d.project_id, 'severity', p_severity));
  return v_i;
end $$;
revoke all on function projects.p7_open_incident(uuid, text, text, text, text, uuid) from public, anon, authenticated, service_role;

-- a person raises an incident the runner cannot see (security, data integrity, provider outage, monitoring blind spot)
create or replace function projects.raise_incident(p_deployment_id uuid, p_type text, p_severity text, p_impact text, p_note text)
returns table (outcome text, incident_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d projects.p7_deployments; v_i uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_d from projects.p7_deployments d where d.id = p_deployment_id and d.organization_id = v_org;
  if v_d.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if p_type not in ('deployment_failure', 'config_failure', 'migration_failure', 'runtime_failure', 'security_incident', 'provider_outage', 'data_integrity_risk', 'monitoring_failure') then return query select 'bad_type'::text, null::uuid; return; end if;
  if p_severity not in ('sev1', 'sev2', 'sev3') then return query select 'bad_severity'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_impact) or projects.p7_has_secret(p_note) then return query select 'contains_secret'::text, null::uuid; return; end if;
  -- the highest urgency is not optional for a data or security risk
  perform set_config('projects.p7_door', 'on', true);
  v_i := projects.p7_open_incident(p_deployment_id, p_type, case when p_type in ('security_incident', 'data_integrity_risk') then 'sev1' else p_severity end, p_impact, p_note, v_actor);
  return query select 'raised'::text, v_i;
end $$;
revoke all on function projects.raise_incident(uuid, text, text, text, text) from public, anon;
grant execute on function projects.raise_incident(uuid, text, text, text, text) to authenticated;

create or replace function projects.classify_incident(p_incident_id uuid, p_path text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.p7_incidents;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_path not in ('config', 'code', 'provider', 'rollback') then return query select 'bad_path'::text; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_i from projects.p7_incidents i where i.id = p_incident_id and i.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text; return; end if;
  if v_i.state = 'closed' then return query select 'already_closed'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_incidents set recovery_path = p_path, state = case when state = 'open' then 'recovering' else state end where id = p_incident_id;
  perform projects.p7_incident_event(p_incident_id, v_org, 'classification', v_actor, 'recovery path: ' || p_path || coalesce(' - ' || p_note, ''));
  -- a code defect never goes back through a deploy retry: it opens a change record and needs a new candidate
  if p_path = 'code' and not exists (select 1 from projects.p7_change_records c where c.project_id = v_i.project_id and c.status = 'open' and c.kind = 'code_change') then
    insert into projects.p7_change_records (organization_id, project_id, kind, description, from_candidate_id, opened_by)
    values (v_org, v_i.project_id, 'code_change', 'production incident requires a code change: ' || coalesce(nullif(btrim(p_note), ''), v_i.incident_type), v_i.candidate_id, v_actor);
    update projects.p7_deployment_plans set status = 'superseded' where project_id = v_i.project_id and status in ('draft', 'ready_for_approval', 'approved');
    perform core.emit_event(v_org, 'project.production_code_change_required', 'incident', p_incident_id, jsonb_build_object('projectId', v_i.project_id));
  end if;
  return query select 'classified'::text;
end $$;
revoke all on function projects.classify_incident(uuid, text, text) from public, anon;
grant execute on function projects.classify_incident(uuid, text, text) to authenticated;

create or replace function projects.record_incident_action(p_incident_id uuid, p_kind text, p_note text, p_evidence_ref text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.p7_incidents;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_kind not in ('containment', 'note', 'signal', 'recovery') then return query select 'bad_kind'::text; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(p_note) or projects.p7_has_secret(p_evidence_ref) then return query select 'contains_secret'::text; return; end if;
  select * into v_i from projects.p7_incidents i where i.id = p_incident_id and i.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text; return; end if;
  if v_i.state = 'closed' then return query select 'already_closed'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  perform projects.p7_incident_event(p_incident_id, v_org, p_kind, v_actor, p_note, p_evidence_ref);
  if p_kind = 'containment' and v_i.state = 'open' then update projects.p7_incidents set state = 'contained' where id = p_incident_id; end if;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_incident_action(uuid, text, text, text) from public, anon;
grant execute on function projects.record_incident_action(uuid, text, text, text) to authenticated;

-- ── a rollback is decided by an Admin, with a named target ─────────────────
create or replace function projects.decide_rollback(p_incident_id uuid, p_target_ref text, p_risk text, p_decision text, p_reason text default null, p_irreversible_acknowledged boolean default false)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.p7_incidents; v_d projects.p7_deployments; v_plan projects.p7_deployment_plans; v_irrev boolean;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('approve', 'reject') then return query select 'bad_decision'::text; return; end if;
  if projects.p7_has_secret(p_target_ref) or projects.p7_has_secret(p_risk) or projects.p7_has_secret(p_reason) then return query select 'contains_secret'::text; return; end if;
  select * into v_i from projects.p7_incidents i where i.id = p_incident_id and i.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text; return; end if;
  if v_i.state = 'closed' then return query select 'already_closed'::text; return; end if;
  if p_risk is null or length(btrim(p_risk)) = 0 then return query select 'risk_required'::text; return; end if;
  if p_decision = 'reject' and (p_reason is null or length(btrim(p_reason)) = 0) then return query select 'reason_required'::text; return; end if;
  if p_decision = 'approve' and (p_target_ref is null or length(btrim(p_target_ref)) = 0) then return query select 'target_unknown'::text; return; end if;
  select * into v_d from projects.p7_deployments d where d.id = v_i.deployment_id;
  select * into v_plan from projects.p7_deployment_plans p where p.id = v_d.plan_id;
  v_irrev := exists (select 1 from jsonb_array_elements(coalesce(v_plan.migration_plan -> 'steps', '[]'::jsonb)) s where (s ->> 'reversible') = 'false');
  -- no blind rollback of an irreversible migration: the Admin acknowledges the data implication first
  if p_decision = 'approve' and v_irrev and not coalesce(p_irreversible_acknowledged, false) then return query select 'irreversible_migration_needs_acknowledgement'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_rollback_decisions (organization_id, incident_id, deployment_id, target_ref, risk, irreversible_migration_acknowledged, decision, reason, decided_by)
  values (v_org, p_incident_id, v_d.id, coalesce(btrim(p_target_ref), '-'), btrim(p_risk), coalesce(p_irreversible_acknowledged, false), p_decision, p_reason, v_actor);
  if p_decision = 'approve' then update projects.p7_incidents set recovery_path = 'rollback', state = case when state = 'open' then 'recovering' else state end where id = p_incident_id; end if;
  perform projects.p7_incident_event(p_incident_id, v_org, 'rollback_decision', v_actor, p_decision || ' rollback to ' || coalesce(btrim(p_target_ref), '(no target)') || ': ' || btrim(p_risk));
  perform core.record_audit(v_org, 'rollback.' || p_decision, 'incident', p_incident_id, null, jsonb_build_object('deploymentId', v_d.id, 'target', p_target_ref));
  return query select case p_decision when 'approve' then 'approved' else 'rejected' end::text;
end $$;
revoke all on function projects.decide_rollback(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function projects.decide_rollback(uuid, text, text, text, text, boolean) to authenticated;

-- ── the runner moves a deployment (service role only) ──────────────────────
create or replace function projects.record_deployment_progress(p_deployment_id uuid, p_to_status text, p_evidence_ref text default null, p_note text default null,
                                                               p_actor_user uuid default null, p_deployed_artifact_sha256 text default null, p_executor text default 'runner',
                                                               p_incident_type text default 'deployment_failure')
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_d projects.p7_deployments; v_inc projects.p7_incidents; v_rb projects.p7_rollback_decisions; v_ok boolean;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return query select 'runner_only'::text; return; end if;
  if p_to_status not in ('started', 'succeeded_pending_validation', 'failed', 'rolled_back', 'recovered_pending_validation') then return query select 'bad_status'::text; return; end if;
  if projects.p7_has_secret(p_evidence_ref) or projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_d from projects.p7_deployments d where d.id = p_deployment_id for update;
  if v_d.id is null then return query select 'not_found'::text; return; end if;
  -- a duplicate command callback is a no-op, not a second transition
  if v_d.status = p_to_status then return query select 'already_recorded'::text; return; end if;
  v_ok := (v_d.status, p_to_status) in (('approved', 'started'), ('started', 'succeeded_pending_validation'), ('started', 'failed'), ('started', 'rolled_back'),
            ('succeeded_pending_validation', 'rolled_back'), ('failed', 'rolled_back'), ('failed', 'recovered_pending_validation'), ('recovered_pending_validation', 'rolled_back'));
  if not v_ok then return query select 'bad_transition'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);

  if p_to_status = 'started' then
    -- the approval is checked AGAIN at the moment of execution: a changed candidate, a superseded plan or a stale build voids it
    if not projects.p7_deployment_approved(v_d.plan_id) then return query select 'approval_no_longer_valid'::text; return; end if;
    if p_executor not in ('runner', 'manual') then return query select 'bad_executor'::text; return; end if;
    if p_deployed_artifact_sha256 is not null and p_deployed_artifact_sha256 is distinct from v_d.artifact_sha256 then return query select 'wrong_artifact'::text; return; end if;
    update projects.p7_deployments set status = 'started', executor = p_executor, actor_user = p_actor_user, started_at = clock_timestamp(), blocker_code = null where id = p_deployment_id;
    perform projects.p7_set_state(v_d.project_id, 'deploying');
    perform core.emit_event(v_d.organization_id, 'project.deployment_started', 'deployment', p_deployment_id, jsonb_build_object('projectId', v_d.project_id));

  elsif p_to_status = 'succeeded_pending_validation' then
    -- success is pending live validation, and it names the artifact that actually went out: it must be the candidate's, byte for byte
    if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 then return query select 'evidence_required'::text; return; end if;
    if p_deployed_artifact_sha256 is null or p_deployed_artifact_sha256 is distinct from v_d.artifact_sha256 then return query select 'wrong_artifact'::text; return; end if;
    update projects.p7_deployments set status = 'succeeded_pending_validation', deployed_artifact_sha256 = p_deployed_artifact_sha256, evidence_ref = p_evidence_ref, note = coalesce(p_note, note),
           finished_at = clock_timestamp(), actor_user = coalesce(p_actor_user, actor_user) where id = p_deployment_id;
    perform projects.p7_set_state(v_d.project_id, 'post_deployment_validation');
    perform core.emit_event(v_d.organization_id, 'project.deployment_succeeded', 'deployment', p_deployment_id, jsonb_build_object('projectId', v_d.project_id));

  elsif p_to_status = 'failed' then
    if p_note is null or length(btrim(p_note)) = 0 then return query select 'reason_required'::text; return; end if;
    if p_incident_type not in ('deployment_failure', 'config_failure', 'migration_failure', 'provider_outage') then return query select 'bad_incident_type'::text; return; end if;
    update projects.p7_deployments set status = 'failed', note = p_note, evidence_ref = coalesce(p_evidence_ref, evidence_ref), finished_at = clock_timestamp(), actor_user = coalesce(p_actor_user, actor_user) where id = p_deployment_id;
    perform projects.p7_open_incident(p_deployment_id, p_incident_type, 'sev2', 'production deployment failed; the previous version keeps serving', p_note, null);
    perform projects.p7_set_state(v_d.project_id, 'deployment_failed');
    perform core.emit_event(v_d.organization_id, 'project.deployment_failed', 'deployment', p_deployment_id, jsonb_build_object('projectId', v_d.project_id));

  elsif p_to_status = 'rolled_back' then
    -- controlled, not blind: an Admin approved this rollback, with a named target, for an incident on THIS deployment, and it runs once
    select rd.* into v_rb from projects.p7_rollback_decisions rd where rd.deployment_id = p_deployment_id and rd.decision = 'approve' and rd.executed_at is null order by rd.decided_at desc limit 1;
    if v_rb.id is null then return query select 'rollback_not_approved'::text; return; end if;
    if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 then return query select 'evidence_required'::text; return; end if;
    update projects.p7_rollback_decisions set executed_at = clock_timestamp() where id = v_rb.id;
    update projects.p7_deployments set status = 'rolled_back', evidence_ref = p_evidence_ref, note = coalesce(p_note, note), finished_at = clock_timestamp(), actor_user = coalesce(p_actor_user, actor_user) where id = p_deployment_id;
    perform projects.p7_incident_event(v_rb.incident_id, v_d.organization_id, 'recovery', null, 'rolled back to ' || v_rb.target_ref, p_evidence_ref);
    perform projects.p7_set_state(v_d.project_id, 'rollback_in_progress');

  elsif p_to_status = 'recovered_pending_validation' then
    -- a config / provider recovery of the SAME candidate. A code defect never takes this path: it needs a new approved candidate.
    select * into v_inc from projects.p7_incidents i where i.deployment_id = p_deployment_id and i.state <> 'closed' order by i.opened_at desc limit 1;
    if v_inc.id is null then return query select 'no_open_incident'::text; return; end if;
    if v_inc.recovery_path not in ('config', 'provider') then return query select 'incident_path_is_not_config_recovery'::text; return; end if;
    if exists (select 1 from projects.p7_change_records c where c.project_id = v_d.project_id and c.status = 'open' and c.kind = 'code_change') then return query select 'code_change_open'::text; return; end if;
    if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 then return query select 'evidence_required'::text; return; end if;
    if p_deployed_artifact_sha256 is null or p_deployed_artifact_sha256 is distinct from v_d.artifact_sha256 then return query select 'wrong_artifact'::text; return; end if;
    update projects.p7_deployments set status = 'recovered_pending_validation', deployed_artifact_sha256 = p_deployed_artifact_sha256, evidence_ref = p_evidence_ref, note = coalesce(p_note, note),
           finished_at = clock_timestamp(), actor_user = coalesce(p_actor_user, actor_user) where id = p_deployment_id;
    update projects.p7_incidents set state = 'recovered_pending_validation' where id = v_inc.id;
    perform projects.p7_incident_event(v_inc.id, v_d.organization_id, 'recovery', null, 'configuration recovery applied to the same candidate; it must be re-validated', p_evidence_ref);
    perform projects.p7_set_state(v_d.project_id, 'post_deployment_validation');
  end if;
  perform projects.p7_deployment_event(p_deployment_id, v_d.organization_id, 'transition', v_d.status, p_to_status, p_actor_user, p_evidence_ref, p_note, null);
  perform core.record_audit(v_d.organization_id, 'deployment.' || p_to_status, 'deployment', p_deployment_id, null, jsonb_build_object('projectId', v_d.project_id, 'from', v_d.status, 'commit', v_d.commit_ref));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_deployment_progress(uuid, text, text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function projects.record_deployment_progress(uuid, text, text, text, uuid, text, text, text) to service_role;

-- ── production validation ──────────────────────────────────────────────────
-- ProductionValidated is a derived fact over rows: the latest deployment of the CURRENT candidate is awaiting validation, a passed run exists for it after it finished,
-- the candidate is still the Admin-approved one, and nothing is open (no incident, no code change, completion not paused).
create or replace function projects.p7_production_validation(p_project_id uuid)
returns table (deployment_id uuid, run_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_s projects.phase_seven; v_d projects.p7_deployments; v_r uuid;
begin
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id;
  if v_s.id is null then return; end if;
  if not v_service and (v_actor is null or v_s.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;
  select * into v_d from projects.p7_deployments d where d.project_id = p_project_id order by d.created_at desc, d.attempt desc limit 1;
  if v_d.id is null or v_d.status not in ('succeeded_pending_validation', 'recovered_pending_validation') then return; end if;
  if v_d.candidate_id is distinct from v_s.candidate_id or v_d.commit_ref is distinct from v_s.commit_ref or not projects.p7_candidate_ok(p_project_id, v_s.candidate_id) then return; end if;
  if v_s.completion_paused then return; end if;
  if exists (select 1 from projects.p7_incidents i where i.project_id = p_project_id and i.state <> 'closed') then return; end if;
  if exists (select 1 from projects.p7_change_records c where c.project_id = p_project_id and c.status = 'open') then return; end if;
  select r.id into v_r from projects.p7_validation_runs r
   where r.deployment_id = v_d.id and r.status = 'passed' and r.kind in ('smoke', 'live_journey', 'post_recovery') and r.finished_at >= v_d.finished_at and r.commit_ref = v_d.commit_ref
   order by r.finished_at desc limit 1;
  if v_r is null then return; end if;
  return query select v_d.id, v_r;
end $$;
revoke all on function projects.p7_production_validation(uuid) from public, anon;
grant execute on function projects.p7_production_validation(uuid) to authenticated, service_role;

create or replace function projects.p7_refresh_validated(p_project_id uuid)
returns boolean language plpgsql set search_path = '' as $$
declare v_s projects.phase_seven; v_v record;
begin
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id;
  select * into v_v from projects.p7_production_validation(p_project_id);
  if v_v.deployment_id is null then return false; end if;
  if v_s.state in ('deploying', 'post_deployment_validation', 'deployment_failed', 'rollback_in_progress', 'deployment_planning', 'waiting_deployment_approval') then
    update projects.phase_seven set state = 'production_validated' where id = v_s.id;
    perform core.record_audit(v_s.organization_id, 'project.production_validated', 'phase_seven', v_s.id, null, jsonb_build_object('projectId', p_project_id, 'deploymentId', v_v.deployment_id, 'runId', v_v.run_id));
    perform core.emit_event(v_s.organization_id, 'project.production_validated', 'phase_seven', v_s.id, jsonb_build_object('projectId', p_project_id, 'deploymentId', v_v.deployment_id));
  end if;
  return true;
end $$;
revoke all on function projects.p7_refresh_validated(uuid) from public, anon, authenticated, service_role;

create or replace function projects.open_validation_run(p_deployment_id uuid, p_kind text, p_incident_id uuid default null)
returns table (outcome text, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d projects.p7_deployments; v_run uuid; v_inc projects.p7_incidents;
begin
  -- a person records production validation; a deploy runner / agent holding the service role cannot, so a deployment claim is never validation
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind not in ('smoke', 'live_journey', 'post_rollback', 'post_recovery') then return query select 'bad_kind'::text, null::uuid; return; end if;
  select * into v_d from projects.p7_deployments d where d.id = p_deployment_id and d.organization_id = v_org for update;
  if v_d.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if p_kind = 'post_rollback' then
    if v_d.status <> 'rolled_back' then return query select 'deployment_not_rolled_back'::text, null::uuid; return; end if;
  elsif p_kind = 'post_recovery' then
    if v_d.status <> 'recovered_pending_validation' then return query select 'deployment_not_recovered'::text, null::uuid; return; end if;
  elsif v_d.status not in ('succeeded_pending_validation', 'recovered_pending_validation') then
    return query select 'deployment_not_awaiting_validation'::text, null::uuid; return;
  end if;
  -- independence: whoever executed the deployment does not validate it
  if v_d.actor_user is not distinct from v_actor or exists (select 1 from projects.p7_deployment_events e where e.deployment_id = v_d.id and e.actor_user = v_actor) then
    return query select 'not_independent'::text, null::uuid; return;
  end if;
  if p_kind <> 'post_rollback' and not projects.p7_candidate_ok(v_d.project_id, v_d.candidate_id) then return query select 'candidate_not_current'::text, null::uuid; return; end if;
  if p_incident_id is not null then
    select * into v_inc from projects.p7_incidents i where i.id = p_incident_id and i.organization_id = v_org;
    if v_inc.id is null or v_inc.project_id is distinct from v_d.project_id then return query select 'incident_not_found'::text, null::uuid; return; end if;
  end if;
  select r.id into v_run from projects.p7_validation_runs r where r.deployment_id = p_deployment_id and r.kind = p_kind and r.status = 'running';
  if v_run is not null then return query select 'already_running'::text, v_run; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_validation_runs (organization_id, project_id, deployment_id, candidate_id, commit_ref, kind, incident_id, started_by)
  values (v_org, v_d.project_id, v_d.id, v_d.candidate_id, v_d.commit_ref, p_kind, p_incident_id, v_actor) returning id into v_run;
  return query select 'opened'::text, v_run;
end $$;
revoke all on function projects.open_validation_run(uuid, text, uuid) from public, anon;
grant execute on function projects.open_validation_run(uuid, text, uuid) to authenticated;

create or replace function projects.record_validation_check(p_run_id uuid, p_check_key text, p_truth text, p_evidence_ref text default null, p_detail text default null, p_required boolean default true)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_run projects.p7_validation_runs;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_truth not in ('passed', 'failed', 'not_tested') then return query select 'bad_truth'::text; return; end if;
  if p_check_key not in ('app_starts', 'critical_routes', 'authentication', 'core_api', 'database', 'primary_workflow', 'external_integrations', 'monitoring_logging', 'no_critical_runtime_error', 'assets') then return query select 'bad_check'::text; return; end if;
  if projects.p7_has_secret(p_evidence_ref) or projects.p7_has_secret(p_detail) then return query select 'contains_secret'::text; return; end if;
  select * into v_run from projects.p7_validation_runs r where r.id = p_run_id and r.organization_id = v_org for update;
  if v_run.id is null then return query select 'not_found'::text; return; end if;
  if v_run.status <> 'running' then return query select 'run_finished'::text; return; end if;
  if exists (select 1 from projects.p7_deployments d where d.id = v_run.deployment_id and d.actor_user = v_actor)
     or exists (select 1 from projects.p7_deployment_events e where e.deployment_id = v_run.deployment_id and e.actor_user = v_actor) then
    return query select 'not_independent'::text; return;
  end if;
  if p_truth = 'passed' and (p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0) then return query select 'evidence_required'::text; return; end if;
  if p_truth <> 'passed' and (p_detail is null or length(btrim(p_detail)) = 0) then return query select 'detail_required'::text; return; end if;
  -- the eight core checks are always required; only the two "where applicable" ones may be marked optional
  if not p_required and p_check_key not in ('external_integrations', 'assets') then return query select 'core_check_is_required'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_validation_checks (organization_id, run_id, check_key, required, truth, evidence_ref, detail, recorded_by)
  values (v_org, p_run_id, p_check_key, p_required, p_truth, p_evidence_ref, p_detail, v_actor)
  on conflict (run_id, check_key) do update set required = excluded.required, truth = excluded.truth, evidence_ref = excluded.evidence_ref, detail = excluded.detail, recorded_by = excluded.recorded_by, recorded_at = clock_timestamp();
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_validation_check(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function projects.record_validation_check(uuid, text, text, text, text, boolean) to authenticated;

create or replace function projects.finish_validation_run(p_run_id uuid, p_summary text default null)
returns table (outcome text, status text, missing text[])
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_run projects.p7_validation_runs; v_d projects.p7_deployments;
  v_core text[] := array['app_starts', 'critical_routes', 'authentication', 'core_api', 'database', 'primary_workflow', 'monitoring_logging', 'no_critical_runtime_error'];
  v_missing text[]; v_failed text[]; v_status text; k text; v_refreshed boolean;
begin
  if v_actor is null then return query select 'no_actor'::text, null::text, '{}'::text[]; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::text, '{}'::text[]; return; end if;
  if projects.p7_has_secret(p_summary) then return query select 'contains_secret'::text, null::text, '{}'::text[]; return; end if;
  select * into v_run from projects.p7_validation_runs r where r.id = p_run_id and r.organization_id = v_org for update;
  if v_run.id is null then return query select 'not_found'::text, null::text, '{}'::text[]; return; end if;
  if v_run.status <> 'running' then return query select 'already_finished'::text, v_run.status, '{}'::text[]; return; end if;
  select * into v_d from projects.p7_deployments d where d.id = v_run.deployment_id;
  -- required = the eight core checks, plus any optional one recorded as required; an unrecorded or not_tested required check leaves validation BLOCKED
  select coalesce(array_agg(x order by x), '{}') into v_missing from (
    select unnest(v_core) as x
    union select c.check_key from projects.p7_validation_checks c where c.run_id = p_run_id and c.required) req
   where not exists (select 1 from projects.p7_validation_checks c where c.run_id = p_run_id and c.check_key = req.x and c.truth = 'passed');
  select coalesce(array_agg(c.check_key order by c.check_key), '{}') into v_failed from projects.p7_validation_checks c where c.run_id = p_run_id and c.required and c.truth = 'failed';
  v_status := case when cardinality(v_failed) > 0 then 'failed' when cardinality(v_missing) > 0 then 'blocked' else 'passed' end;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_validation_runs set status = v_status, finished_at = clock_timestamp(), summary = p_summary where id = p_run_id;

  if v_status = 'failed' then
    -- a failed required check pauses completion and raises ONE canonical incident (a failed re-validation leaves the existing incident open)
    perform projects.p7_open_incident(v_d.id, 'runtime_failure', 'sev2', 'a required production check failed: ' || array_to_string(v_failed, ', '), 'validation run failed: ' || array_to_string(v_failed, ', '), v_actor);
    if v_run.incident_id is not null then perform projects.p7_incident_event(v_run.incident_id, v_org, 'validation', v_actor, 'the ' || v_run.kind || ' run FAILED: ' || array_to_string(v_failed, ', ')); end if;
    perform core.emit_event(v_org, 'project.production_validation_failed', 'deployment', v_d.id, jsonb_build_object('projectId', v_run.project_id));
  elsif v_status = 'passed' then
    if v_run.incident_id is not null then perform projects.p7_incident_event(v_run.incident_id, v_org, 'validation', v_actor, 'the ' || v_run.kind || ' run PASSED on the exact deployment'); end if;
    -- a config-only change is revalidated by this same-candidate re-smoke
    update projects.p7_change_records set status = 'revalidated', closed_at = clock_timestamp() where project_id = v_run.project_id and status = 'open' and kind = 'config_only' and opened_at <= v_run.started_at;
    v_refreshed := projects.p7_refresh_validated(v_run.project_id);
  end if;
  perform core.record_audit(v_org, 'validation_run.' || v_status, 'validation_run', p_run_id, null, jsonb_build_object('projectId', v_run.project_id, 'deploymentId', v_d.id, 'kind', v_run.kind, 'commit', v_run.commit_ref));
  return query select 'finished'::text, v_status, case when v_status = 'blocked' then v_missing else '{}'::text[] end;
end $$;
revoke all on function projects.finish_validation_run(uuid, text) from public, anon;
grant execute on function projects.finish_validation_run(uuid, text) to authenticated;

-- ── close an incident: only after verified recovery, and a review ──────────
create or replace function projects.close_incident(p_incident_id uuid, p_root_cause text, p_timeline_summary text, p_corrective_actions text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.p7_incidents; v_ok boolean; v_open int; v_refreshed boolean;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_root_cause is null or length(btrim(p_root_cause)) = 0 or p_corrective_actions is null or length(btrim(p_corrective_actions)) = 0 then return query select 'review_required'::text; return; end if;
  if projects.p7_has_secret(p_root_cause) or projects.p7_has_secret(p_timeline_summary) or projects.p7_has_secret(p_corrective_actions) then return query select 'contains_secret'::text; return; end if;
  select * into v_i from projects.p7_incidents i where i.id = p_incident_id and i.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text; return; end if;
  if v_i.state = 'closed' then return query select 'already_closed'::text; return; end if;
  if v_i.recovery_path = 'unclassified' then return query select 'not_classified'::text; return; end if;
  -- verified recovery = a PASSED re-validation run tied to this incident, finished after it was raised; a code fix is proven on a NEW commit
  v_ok := exists (
    select 1 from projects.p7_validation_runs r join projects.p7_deployments d on d.id = r.deployment_id
     where r.incident_id = p_incident_id and r.status = 'passed' and r.finished_at > v_i.opened_at
       and ((v_i.recovery_path = 'rollback' and r.kind = 'post_rollback')
         or (v_i.recovery_path in ('config', 'provider') and r.kind in ('post_recovery', 'smoke', 'live_journey'))
         or (v_i.recovery_path = 'code' and r.kind in ('smoke', 'live_journey') and r.commit_ref is distinct from v_i.commit_ref)));
  if not v_ok then return query select 'recovery_not_verified'::text; return; end if;
  if v_i.recovery_path = 'code' and exists (select 1 from projects.p7_change_records c where c.project_id = v_i.project_id and c.status = 'open' and c.kind = 'code_change') then return query select 'code_change_open'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_incidents set state = 'closed', closed_at = clock_timestamp(), reviewed_by = v_actor, root_cause = p_root_cause, timeline_summary = p_timeline_summary, corrective_actions = p_corrective_actions where id = p_incident_id;
  perform projects.p7_incident_event(p_incident_id, v_org, 'review', v_actor, 'closed after verified recovery: ' || btrim(p_root_cause));
  select count(*) into v_open from projects.p7_incidents i where i.project_id = v_i.project_id and i.state <> 'closed';
  if v_open = 0 then
    update projects.phase_seven set completion_paused = false, paused_reason = null where id = v_i.phase_seven_id;
    -- after a rollback the candidate is not in production: the next step is a new deployment of the approved plan
    if v_i.recovery_path = 'rollback' then perform projects.p7_set_state(v_i.project_id, 'deployment_planning'); end if;
  end if;
  perform core.record_audit(v_org, 'incident.closed', 'incident', p_incident_id, null, jsonb_build_object('projectId', v_i.project_id, 'path', v_i.recovery_path));
  perform core.emit_event(v_org, 'project.deployment_incident_closed', 'incident', p_incident_id, jsonb_build_object('projectId', v_i.project_id));
  v_refreshed := projects.p7_refresh_validated(v_i.project_id);
  return query select 'closed'::text;
end $$;
revoke all on function projects.close_incident(uuid, text, text, text) from public, anon;
grant execute on function projects.close_incident(uuid, text, text, text) to authenticated;

-- ── the change-after-Phase-6 rule ──────────────────────────────────────────
create or replace function projects.record_production_change(p_project_id uuid, p_kind text, p_description text, p_affected_categories text[] default '{}')
returns table (outcome text, change_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_s projects.phase_seven; v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind not in ('code_change', 'config_only') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_description is null or length(btrim(p_description)) = 0 then return query select 'description_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_description) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if exists (select 1 from unnest(coalesce(p_affected_categories, '{}')) c where c not in ('functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression')) then return query select 'bad_category'::text, null::uuid; return; end if;
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = v_org for update;
  if v_s.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_s.state in ('completed', 'phase8_ready') then return query select 'project_completed'::text, null::uuid; return; end if;
  if exists (select 1 from projects.p7_change_records c where c.project_id = p_project_id and c.status = 'open') then return query select 'change_already_open'::text, null::uuid; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_change_records (organization_id, project_id, kind, description, affected_categories, from_candidate_id, opened_by)
  values (v_org, p_project_id, p_kind, p_description, coalesce(p_affected_categories, '{}'), v_s.candidate_id, v_actor) returning id into v_new;
  if p_kind = 'code_change' then
    -- the approved candidate no longer describes what will run: plans are voided, completion is paused, and a new governed candidate is required
    update projects.p7_deployment_plans set status = 'superseded' where project_id = p_project_id and status in ('draft', 'ready_for_approval', 'approved');
    update projects.phase_seven set completion_paused = true, paused_reason = 'a code change after Phase 6 needs a new build and affected Phase 6 revalidation' where id = v_s.id;
    perform projects.p7_set_state(p_project_id, 'deployment_planning');
    perform core.emit_event(v_org, 'project.production_code_change_required', 'phase_seven', v_s.id, jsonb_build_object('projectId', p_project_id));
  end if;
  perform core.record_audit(v_org, 'production_change.recorded', 'change_record', v_new, null, jsonb_build_object('projectId', p_project_id, 'kind', p_kind));
  return query select 'recorded'::text, v_new;
end $$;
revoke all on function projects.record_production_change(uuid, text, text, text[]) from public, anon;
grant execute on function projects.record_production_change(uuid, text, text, text[]) to authenticated;

-- the new candidate: approved by an Admin, still the build's commit, and EVERY Phase 6 hard gate satisfied on its own commit now
create or replace function projects.rebind_phase_seven_candidate(p_project_id uuid)
returns table (outcome text, candidate_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_s projects.phase_seven; v_c qa.release_candidates; v_gaps int; v_open int;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text, null::uuid; return; end if;
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id for update;
  if v_s.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_actor is not null and (v_s.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_manage_delivery()), false)) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if v_s.state in ('completed', 'phase8_ready') then return query select 'project_completed'::text, null::uuid; return; end if;
  select * into v_c from qa.release_candidates c where c.project_id = p_project_id and c.status = 'approved';
  if v_c.id is null then return query select 'no_approved_candidate'::text, null::uuid; return; end if;
  if v_c.id = v_s.candidate_id then return query select 'unchanged'::text, v_c.id; return; end if;
  if v_c.commit_ref = v_s.commit_ref then return query select 'same_commit'::text, v_c.id; return; end if;
  if not projects.p7_candidate_ok(p_project_id, v_c.id) then return query select 'candidate_not_current'::text, v_c.id; return; end if;
  select count(*) into v_gaps from qa.evaluate_hard_gates(v_c.id) g where not g.satisfied;
  if v_gaps > 0 then return query select 'not_revalidated'::text, v_c.id; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_deployment_plans set status = 'superseded' where project_id = p_project_id and status in ('draft', 'ready_for_approval', 'approved');
  update projects.p7_change_records set status = 'revalidated', resulting_candidate_id = v_c.id, closed_at = clock_timestamp() where project_id = p_project_id and status = 'open' and kind = 'code_change';
  update projects.phase_seven set candidate_id = v_c.id, commit_ref = v_c.commit_ref, artifact_sha256 = v_c.artifact_sha256, state = case when state in ('waiting_phase6') then 'phase7_ready' else 'deployment_planning' end,
         blocked_reason = null where id = v_s.id;
  perform core.record_audit(v_s.organization_id, 'phase_seven.candidate_rebound', 'phase_seven', v_s.id, jsonb_build_object('commit', v_s.commit_ref), jsonb_build_object('commit', v_c.commit_ref, 'candidateId', v_c.id));
  return query select 'rebound'::text, v_c.id;
end $$;
revoke all on function projects.rebind_phase_seven_candidate(uuid) from public, anon;
grant execute on function projects.rebind_phase_seven_candidate(uuid) to authenticated, service_role;

create or replace function projects.record_known_limitation(p_project_id uuid, p_title text, p_detail text default null, p_source text default 'manual')
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_title is null or length(btrim(p_title)) = 0 then return query select 'title_required'::text; return; end if;
  if p_source not in ('production_validation', 'handover', 'manual') then return query select 'bad_source'::text; return; end if;
  if projects.p7_has_secret(p_title) or projects.p7_has_secret(p_detail) then return query select 'contains_secret'::text; return; end if;
  if not exists (select 1 from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = v_org) then return query select 'not_found'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_known_limitations (organization_id, project_id, title, detail, source, created_by) values (v_org, p_project_id, btrim(p_title), p_detail, p_source, v_actor)
  on conflict (project_id, title) do nothing;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_known_limitation(uuid, text, text, text) from public, anon;
grant execute on function projects.record_known_limitation(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';
