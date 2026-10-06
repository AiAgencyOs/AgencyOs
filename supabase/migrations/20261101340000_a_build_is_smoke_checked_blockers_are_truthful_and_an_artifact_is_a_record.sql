-- DevOps/Build spec (P509 §17, §22, §23, §31): launch/smoke verification with a truth state (never fabricated), build blockers that open by
-- themselves when the environment, toolchain or signing is the problem, and an artifact record beyond a bare hash.

create table if not exists projects.build_smoke_checks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  deliverable_id   uuid not null references projects.deliverables(id) on delete restrict,
  commit_ref       text not null check (length(btrim(commit_ref)) > 0),
  result           text not null check (result in ('passed', 'failed', 'not_tested', 'blocked')),
  checks           jsonb not null default '[]'::jsonb check (jsonb_typeof(checks) = 'array'),
  device_target    text,
  reason           text,
  evidence_url     text check (evidence_url is null or evidence_url ~ '^https://'),
  recorded_by      uuid references core.users(id) on delete set null,
  -- clock_timestamp, not now(): two verdicts in one transaction are still ordered
  created_at       timestamptz not null default clock_timestamp(),
  -- a result that is not a pass says WHY; a pass names what it rests on
  check (result in ('passed', 'failed') or (reason is not null and length(btrim(reason)) > 0)),
  check (result <> 'passed' or (evidence_url is not null and jsonb_array_length(checks) > 0))
);
create index if not exists build_smoke_checks_build_idx on projects.build_smoke_checks (deliverable_id, created_at desc);

create table if not exists projects.build_blockers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  deliverable_id    uuid not null references projects.deliverables(id) on delete cascade,
  blocker_type      text not null check (blocker_type in ('environment_missing', 'toolchain_incompatible', 'signing_failed', 'credential_missing', 'other')),
  owner             text not null default 'owner' check (owner in ('owner', 'admin', 'developer', 'client')),
  resume_condition  text not null check (length(btrim(resume_condition)) > 0),
  detail            text,
  status            text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by       uuid references core.users(id) on delete set null,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  check (status = 'open' or resolved_at is not null)
);
create unique index if not exists build_blockers_open_key on projects.build_blockers (deliverable_id, blocker_type) where status = 'open';

create table if not exists projects.build_artifacts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  build_run_id     uuid not null unique references projects.build_runs(id) on delete restrict,
  artifact_type    text not null check (artifact_type in ('web_bundle', 'container_image', 'apk', 'aab', 'ipa', 'archive', 'other')),
  platform         text,
  size_bytes       bigint check (size_bytes is null or size_bytes >= 0),
  storage_ref      text not null check (length(btrim(storage_ref)) > 0),
  -- a simulator-only or unsigned artifact is never presented as distributable
  distributable    boolean not null default true,
  limitation       text,
  created_at       timestamptz not null default now(),
  check (distributable or (limitation is not null and length(btrim(limitation)) > 0))
);

do $m$
declare t text;
begin
  foreach t in array array['build_smoke_checks', 'build_blockers', 'build_artifacts'] loop
    execute format('alter table projects.%I enable row level security', t);
    execute format('drop policy if exists %I on projects.%I', t || '_read', t);
    execute format('create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))', t || '_read', t);
    execute format('revoke all on projects.%I from public, anon', t);
    execute format('revoke insert, update, delete on projects.%I from authenticated', t);
    execute format('grant select on projects.%I to authenticated', t);
    execute format('grant all on projects.%I to service_role', t);
    execute format('drop trigger if exists %I on projects.%I', t || '_parent_org_project', t);
    execute format('create trigger %I before insert or update of project_id on projects.%I for each row execute function core.enforce_parent_org(%L, %L)', t || '_parent_org_project', t, 'project_id', 'projects.projects');
    execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || t, t);
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || t, t);
  end loop;
end $m$;
create trigger build_smoke_checks_parent_org_deliverable before insert or update of deliverable_id on projects.build_smoke_checks for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');
create trigger build_blockers_parent_org_deliverable before insert or update of deliverable_id on projects.build_blockers for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');
create trigger build_artifacts_parent_org_run before insert or update of build_run_id on projects.build_artifacts for each row execute function core.enforce_parent_org('build_run_id', 'projects.build_runs');

create or replace function projects.build_facts_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a smoke check and an artifact record are facts: they are never rewritten' using errcode = 'restrict_violation'; end $$;
create trigger build_smoke_checks_append_only before update or delete on projects.build_smoke_checks for each row execute function projects.build_facts_append_only();
create trigger build_artifacts_append_only before update or delete on projects.build_artifacts for each row execute function projects.build_facts_append_only();

-- smoke: a person records NOT_TESTED / BLOCKED / FAILED with a reason, or a pass with its evidence; the runner (service role) records any of them
create or replace function projects.record_smoke_check(p_deliverable_id uuid, p_result text, p_checks jsonb default '[]', p_device_target text default null, p_reason text default null, p_evidence_url text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_row projects.deliverables; v_commit text;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text; return; end if;
  if v_actor is not null and not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  if p_result not in ('passed', 'failed', 'not_tested', 'blocked') then return query select 'bad_result'::text; return; end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id;
  if v_row.id is null or (v_actor is not null and v_row.organization_id is distinct from (select core.current_organization_id())) then return query select 'not_found'::text; return; end if;
  if v_row.kind <> 'build' then return query select 'wrong_kind'::text; return; end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_row.id;
  if nullif(btrim(coalesce(v_commit, '')), '') is null then return query select 'no_commit'::text; return; end if;
  if p_result = 'passed' and (p_evidence_url is null or p_evidence_url !~ '^https://' or jsonb_typeof(coalesce(p_checks, '[]')) <> 'array' or jsonb_array_length(coalesce(p_checks, '[]')) = 0) then
    return query select 'pass_needs_checks_and_evidence'::text; return;
  end if;
  if p_result in ('not_tested', 'blocked') and (p_reason is null or length(btrim(p_reason)) = 0) then return query select 'reason_required'::text; return; end if;
  insert into projects.build_smoke_checks (organization_id, project_id, deliverable_id, commit_ref, result, checks, device_target, reason, evidence_url, recorded_by)
  values (v_row.organization_id, v_row.project_id, v_row.id, v_commit, p_result, coalesce(p_checks, '[]'), p_device_target, p_reason, p_evidence_url, v_actor);
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_smoke_check(uuid, text, jsonb, text, text, text) from public, anon;
grant execute on function projects.record_smoke_check(uuid, text, jsonb, text, text, text) to authenticated, service_role;

-- the smoke verdict of the build's CURRENT commit: passed, or honestly not tested with a reason. Anything else (none, failed, blocked) is not ready.
create or replace function projects.build_smoke_ready(p_deliverable_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select s.result in ('passed', 'not_tested')
      from projects.build_smoke_checks s
      join projects.deliverable_details dd on dd.deliverable_id = s.deliverable_id and dd.commit_ref = s.commit_ref
     where s.deliverable_id = p_deliverable_id
     order by s.created_at desc limit 1), false)
$$;
revoke all on function projects.build_smoke_ready(uuid) from public, anon;
grant execute on function projects.build_smoke_ready(uuid) to authenticated, service_role;

-- a build is shared only after a smoke verdict on its exact commit
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('projects.submit_deliverable(uuid,uuid,text)'::regprocedure);
  n := replace(d, '  -- Phase 5 Security & Code Review:',
'  -- Phase 5 DevOps/Build: the exact commit has a smoke verdict - passed, or honestly NOT_TESTED with its reason; failed or blocked is not shareable.
  if v_row.kind = ''build'' and not projects.build_smoke_ready(v_row.id) then
    return query select ''no_smoke''::text, null::uuid, v_row.status;
    return;
  end if;

  -- Phase 5 Security & Code Review:');
  if n = d then raise exception 'submit_deliverable: expected text not found'; end if;
  execute n;
end $m$;

-- a failed run whose class is the environment, the toolchain or signing opens a blocker by itself (a truthful BLOCKED, never a vague failure)
create or replace function projects.open_build_blocker_from_run() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'failed' and new.failure_class in ('environment_missing', 'toolchain_incompatible', 'signing_failed') then
    insert into projects.build_blockers (organization_id, project_id, deliverable_id, blocker_type, owner, resume_condition, detail)
    values (new.organization_id, new.project_id, new.deliverable_id, new.failure_class, 'owner',
            case new.failure_class
              when 'environment_missing' then 'A build environment is bound to this deployment (a CI worker or container) and the build is run again.'
              when 'toolchain_incompatible' then 'The required toolchain version is available to the build environment.'
              else 'The signing credential is provided by its owner to the build environment.' end,
            'opened by the failed build run ' || new.id)
    on conflict (deliverable_id, blocker_type) where status = 'open' do nothing;
  end if;
  return new;
end $$;
drop trigger if exists build_runs_open_blocker on projects.build_runs;
create trigger build_runs_open_blocker after insert on projects.build_runs for each row execute function projects.open_build_blocker_from_run();

create or replace function projects.resolve_build_blocker(p_blocker_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  update projects.build_blockers set status = 'resolved', resolved_by = v_actor, resolved_at = now() where id = p_blocker_id and organization_id = v_org and status = 'open';
  if not found then return query select 'not_found_or_closed'::text; return; end if;
  perform core.record_audit(v_org, 'build.blocker_resolved', 'build_blocker', p_blocker_id, null, null);
  return query select 'resolved'::text;
end $$;
revoke all on function projects.resolve_build_blocker(uuid) from public, anon;
grant execute on function projects.resolve_build_blocker(uuid) to authenticated;

-- the artifact record (runner only): what the run produced, and whether it can be distributed at all
create or replace function projects.record_build_artifact(p_build_run_id uuid, p_artifact_type text, p_storage_ref text, p_platform text default null, p_size_bytes bigint default null, p_distributable boolean default true, p_limitation text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_run projects.build_runs;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  select * into v_run from projects.build_runs r where r.id = p_build_run_id;
  if v_run.id is null then return query select 'not_found'::text; return; end if;
  if v_run.status <> 'succeeded' or v_run.artifact_sha256 is null then return query select 'run_has_no_artifact'::text; return; end if;
  begin
    insert into projects.build_artifacts (organization_id, project_id, build_run_id, artifact_type, platform, size_bytes, storage_ref, distributable, limitation)
    values (v_run.organization_id, v_run.project_id, v_run.id, p_artifact_type, p_platform, p_size_bytes, p_storage_ref, coalesce(p_distributable, true), p_limitation)
    on conflict (build_run_id) do nothing;
  exception when check_violation then return query select 'bad_input'::text; return;
  end;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_build_artifact(uuid, text, text, text, bigint, boolean, text) from public, anon, authenticated;
grant execute on function projects.record_build_artifact(uuid, text, text, text, bigint, boolean, text) to service_role;
notify pgrst, 'reload schema';
