-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 truth states.
--
--  1. Integration health (Integration Agent spec): UNKNOWN / CONFIGURED / VERIFIED / DEGRADED / BLOCKED / DISABLED, per project.
--     CONFIGURED != VERIFIED and a MOCK success != a real integration. VERIFIED can be set only through an adapter-result door that the
--     service role holds (a person cannot type "verified"), never for a mock, and only with the evidence that proved it. (The acquisition
--     connectors already had this rule in crm.acquisition_integrations; project integrations - WhatsApp, payments, OTP, Firebase - did not.)
--  2. Conditional specialists (Mobile spec: NOT_REQUIRED for a web-only project; Refactor spec: NOT_REQUIRED unless an approved need exists):
--     a recorded state with a REQUIRED reason, written when Phase 5 starts, changed only through a door that keeps the reason.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.integration_connections (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  kind               text not null check (kind in ('whatsapp', 'email', 'sms_otp', 'oauth', 'firebase', 'payment', 'storage', 'maps', 'analytics', 'ai_api', 'other')),
  name               text not null check (length(btrim(name)) > 0),
  health             text not null default 'unknown' check (health in ('unknown', 'configured', 'verified', 'degraded', 'blocked', 'disabled')),
  is_mock            boolean not null default false,
  verification_evidence text,
  verified_at        timestamptz,
  verified_by_adapter text,
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (project_id, kind, name),
  -- a mock can never be verified; a verified connection names its evidence and its adapter
  check (not (is_mock and health = 'verified')),
  check (health <> 'verified' or (verification_evidence is not null and length(btrim(verification_evidence)) > 0 and verified_at is not null and verified_by_adapter is not null))
);

alter table projects.integration_connections enable row level security;
drop policy if exists integration_connections_read on projects.integration_connections;
create policy integration_connections_read on projects.integration_connections for select to authenticated
  using (organization_id = (select core.current_organization_id()));
grant select on projects.integration_connections to authenticated;
grant all on projects.integration_connections to service_role;
drop trigger if exists integration_connections_parent_org_project_id on projects.integration_connections;
create trigger integration_connections_parent_org_project_id before insert or update of project_id on projects.integration_connections
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists freeze_org_integration_connections on projects.integration_connections;
create trigger freeze_org_integration_connections before update of organization_id on projects.integration_connections for each row execute function core.freeze_organization_id();
drop trigger if exists integration_connections_updated_at on projects.integration_connections;
create trigger integration_connections_updated_at before update on projects.integration_connections for each row execute function core.set_updated_at();

-- only the sanctioned doors move health; a direct write cannot, and nothing a person does can reach 'verified'
create or replace function projects.integration_connections_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.health not in ('unknown', 'configured') then
      raise exception 'an integration is registered unknown or configured, never % at birth', new.health using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if new.health is distinct from old.health
     and coalesce(current_setting('projects.integration_sanctioned', true), '') <> 'on' then
    raise exception 'integration health moves only through the integration doors' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists integration_connections_guard on projects.integration_connections;
create trigger integration_connections_guard before insert or update on projects.integration_connections
  for each row execute function projects.integration_connections_guard();

create or replace function projects.register_integration(p_project_id uuid, p_kind text, p_name text, p_is_mock boolean default false)
returns table (outcome text, connection_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_new uuid;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  insert into projects.integration_connections (organization_id, project_id, kind, name, is_mock) values (v_org, p_project_id, p_kind, p_name, coalesce(p_is_mock, false))
    on conflict (project_id, kind, name) do nothing returning id into v_new;
  if v_new is null then
    select c.id into v_new from projects.integration_connections c where c.project_id = p_project_id and c.kind = p_kind and c.name = p_name;
    return query select 'already_registered'::text, v_new; return;
  end if;
  return query select 'registered'::text, v_new;
end $$;
revoke all on function projects.register_integration(uuid, text, text, boolean) from public, anon;
grant execute on function projects.register_integration(uuid, text, text, boolean) to authenticated;

-- a person may say what they did (configured) or what is wrong (blocked / degraded / disabled): never that it was verified
create or replace function projects.set_integration_state(p_connection_id uuid, p_health text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_row projects.integration_connections;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  if p_health not in ('configured', 'degraded', 'blocked', 'disabled', 'unknown') then
    return query select (case when p_health = 'verified' then 'only_an_adapter_verifies' else 'bad_state' end)::text; return;
  end if;
  select * into v_row from projects.integration_connections c where c.id = p_connection_id and c.organization_id = v_org for update;
  if v_row.id is null then return query select 'not_found'::text; return; end if;
  perform set_config('projects.integration_sanctioned', 'on', true);
  -- leaving verified (a change, a failure) drops the proof: the evidence described a connection that no longer exists
  update projects.integration_connections
     set health = p_health, note = coalesce(p_note, note),
         verification_evidence = case when p_health = 'verified' then verification_evidence else null end,
         verified_at = null, verified_by_adapter = null
   where id = v_row.id;
  perform core.record_audit(v_org, 'integration.state_set', 'integration_connection', v_row.id, jsonb_build_object('health', v_row.health), jsonb_build_object('health', p_health));
  return query select 'set'::text;
end $$;
revoke all on function projects.set_integration_state(uuid, text, text) from public, anon;
grant execute on function projects.set_integration_state(uuid, text, text) to authenticated;

-- the adapter's real result: the ONLY way to 'verified', held by the service role, never for a mock, never without evidence
create or replace function projects.record_integration_check(p_connection_id uuid, p_adapter text, p_ok boolean, p_evidence text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_row projects.integration_connections;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then
    return query select 'adapter_only'::text; return;
  end if;
  select * into v_row from projects.integration_connections c where c.id = p_connection_id for update;
  if v_row.id is null then return query select 'not_found'::text; return; end if;
  if p_adapter is null or length(btrim(p_adapter)) = 0 then return query select 'no_adapter'::text; return; end if;
  if v_row.is_mock then return query select 'mock_cannot_verify'::text; return; end if;
  if v_row.health in ('disabled', 'blocked') then return query select 'not_checkable'::text; return; end if;
  perform set_config('projects.integration_sanctioned', 'on', true);
  if p_ok then
    if p_evidence is null or length(btrim(p_evidence)) = 0 then return query select 'no_evidence'::text; return; end if;
    update projects.integration_connections set health = 'verified', verification_evidence = p_evidence, verified_at = now(), verified_by_adapter = p_adapter where id = v_row.id;
    return query select 'verified'::text; return;
  end if;
  update projects.integration_connections set health = 'degraded', verification_evidence = null, verified_at = null, verified_by_adapter = null, note = coalesce(p_evidence, note) where id = v_row.id;
  return query select 'degraded'::text;
end $$;
revoke all on function projects.record_integration_check(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function projects.record_integration_check(uuid, text, boolean, text) to service_role;

-- Conditional specialists
create table if not exists projects.phase_five_agent_state (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  phase_five_id    uuid not null references projects.phase_five(id) on delete cascade,
  agent_key        text not null,
  state            text not null check (state in ('required', 'not_required', 'active', 'blocked', 'complete')),
  reason           text,
  decided_by       uuid references core.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  unique (phase_five_id, agent_key),
  -- NOT_REQUIRED is a recorded decision with its reason; a blocked agent says why
  check (state not in ('not_required', 'blocked') or (reason is not null and length(btrim(reason)) > 0))
);
alter table projects.phase_five_agent_state enable row level security;
drop policy if exists phase_five_agent_state_read on projects.phase_five_agent_state;
create policy phase_five_agent_state_read on projects.phase_five_agent_state for select to authenticated
  using (organization_id = (select core.current_organization_id()));
grant select on projects.phase_five_agent_state to authenticated;
grant all on projects.phase_five_agent_state to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('phase_five_id', 'projects.phase_five')) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.phase_five_agent_state', 'phase_five_agent_state_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.phase_five_agent_state for each row execute function core.enforce_parent_org(%L, %L)',
                   'phase_five_agent_state_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_phase_five_agent_state on projects.phase_five_agent_state;
create trigger freeze_org_phase_five_agent_state before update of organization_id on projects.phase_five_agent_state for each row execute function core.freeze_organization_id();
drop trigger if exists phase_five_agent_state_updated_at on projects.phase_five_agent_state;
create trigger phase_five_agent_state_updated_at before update on projects.phase_five_agent_state for each row execute function core.set_updated_at();

create or replace function projects.set_phase_five_agent_state(p_project_id uuid, p_agent_key text, p_state text, p_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_row projects.phase_five_agent_state;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_state not in ('required', 'not_required', 'active', 'blocked', 'complete') then return query select 'bad_state'::text; return; end if;
  if p_state in ('not_required', 'blocked') and (p_reason is null or length(btrim(p_reason)) = 0) then return query select 'reason_required'::text; return; end if;
  select s.* into v_row from projects.phase_five_agent_state s where s.project_id = p_project_id and s.organization_id = v_org and s.agent_key = p_agent_key for update;
  if v_row.id is null then return query select 'not_found'::text; return; end if;
  update projects.phase_five_agent_state set state = p_state, reason = case when p_state in ('not_required', 'blocked') then p_reason else null end, decided_by = (select auth.uid()) where id = v_row.id;
  perform core.record_audit(v_org, 'phase_five.agent_state_set', 'phase_five_agent_state', v_row.id, jsonb_build_object('state', v_row.state), jsonb_build_object('state', p_state, 'agent', p_agent_key));
  return query select 'set'::text;
end $$;
revoke all on function projects.set_phase_five_agent_state(uuid, text, text, text) from public, anon;
grant execute on function projects.set_phase_five_agent_state(uuid, text, text, text) to authenticated;

CREATE OR REPLACE FUNCTION projects.start_phase_five(p_project_id uuid)
 RETURNS TABLE(outcome text, phase_five_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- Conditional specialists start as a RECORDED decision, never a silence: mobile is required only for a project recorded as mobile;
  -- refactor/performance only when an approved need exists (none at the start).
  insert into projects.phase_five_agent_state (organization_id, project_id, phase_five_id, agent_key, state, reason)
  select v_project.organization_id, v_project.id, v_new, t.agent_key, t.state, t.reason
    from (values
      ('mobile_developer',
       case when coalesce(v_project.project_type, '') || ' ' || coalesce(array_to_string(v_project.technology, ' '), '') ~* '(mobile|android|ios|flutter|react native)' then 'required' else 'not_required' end,
       case when coalesce(v_project.project_type, '') || ' ' || coalesce(array_to_string(v_project.technology, ' '), '') ~* '(mobile|android|ios|flutter|react native)' then null
            else 'The project is not recorded as a mobile project: no mobile screens, no mobile tasks, no device tests.' end),
      ('refactor_performance', 'not_required', 'No approved technical-debt item or measured performance problem exists at the start of development.'),
      ('frontend_developer', 'required', null), ('backend_developer', 'required', null), ('database_developer', 'required', null),
      ('integration', 'required', null), ('devops_build', 'required', null), ('test_automation', 'required', null),
      ('security_review', 'required', null), ('bug_fix', 'required', null), ('documentation', 'required', null)
    ) as t(agent_key, state, reason);

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
$function$;

revoke all on function projects.start_phase_five(uuid) from public, anon;
grant execute on function projects.start_phase_five(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
