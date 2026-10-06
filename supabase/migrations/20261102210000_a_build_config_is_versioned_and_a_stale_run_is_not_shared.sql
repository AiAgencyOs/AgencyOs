-- DevOps/Build spec (P509 §9, §30): the build configuration is a versioned, Admin-written record. A run is stamped with the config version it
-- was recorded under, and a build whose run used an OLDER config than the current one is not shared ('stale_config'). Reproducibility is
-- computed from recorded runs, never claimed from one.

create table if not exists projects.build_configs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  version          int not null check (version >= 1),
  config           jsonb not null check (jsonb_typeof(config) = 'object' and config <> '{}'::jsonb),
  note             text check (note is null or length(note) <= 1000),
  current          boolean not null default true,
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  superseded_at    timestamptz,
  unique (project_id, version),
  check (current = (superseded_at is null))
);
-- exactly one current config per project
create unique index if not exists build_configs_one_current on projects.build_configs (project_id) where current;

alter table projects.build_configs enable row level security;
drop policy if exists build_configs_read on projects.build_configs;
create policy build_configs_read on projects.build_configs for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.build_configs from public, anon;
revoke insert, update, delete on projects.build_configs from authenticated;
grant select on projects.build_configs to authenticated;
grant all on projects.build_configs to service_role;
create trigger build_configs_parent_org_project before insert or update of project_id on projects.build_configs for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger freeze_org_build_configs before update of organization_id on projects.build_configs for each row execute function core.freeze_organization_id();

-- a version is history: the only edit it ever takes is being superseded
create or replace function projects.build_configs_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a build config version is part of the record' using errcode = 'restrict_violation'; end if;
  if tg_op = 'UPDATE' then
    if not (old.current and not new.current)
       or new.config is distinct from old.config or new.version is distinct from old.version or new.project_id is distinct from old.project_id
       or new.note is distinct from old.note or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'a build config version is only ever superseded, never edited' using errcode = 'restrict_violation';
    end if;
  end if;
  if tg_op = 'INSERT' and projects.mask_secrets(new.config::text) is distinct from new.config::text then
    raise exception 'a build config names variables, never carries a secret value' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger build_configs_guard before insert or update or delete on projects.build_configs for each row execute function projects.build_configs_guard();

-- the Admin door: a new version, the previous one superseded in the same step
create or replace function projects.set_build_config(p_project_id uuid, p_config jsonb, p_note text default null)
returns table (outcome text, version int)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_proj projects.projects; v_key text; v_val jsonb; v_next int; v_prev projects.build_configs; v_name jsonb;
  v_allowed text[] := array['node_version', 'package_manager', 'install_command', 'lint_command', 'test_command', 'build_command', 'output_dir', 'target_platform', 'env_names'];
begin
  if v_actor is null then return query select 'no_actor'::text, null::int; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::int; return; end if;
  select * into v_proj from projects.projects p where p.id = p_project_id and p.organization_id = v_org;
  if v_proj.id is null then return query select 'not_found'::text, null::int; return; end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' or p_config = '{}'::jsonb then return query select 'bad_config'::text, null::int; return; end if;
  if p_note is not null and length(p_note) > 1000 then return query select 'bad_config'::text, null::int; return; end if;
  for v_key, v_val in select * from jsonb_each(p_config) loop
    if not (v_key = any (v_allowed)) then return query select 'unknown_key'::text, null::int; return; end if;
    if v_key = 'env_names' then
      if jsonb_typeof(v_val) <> 'array' then return query select 'bad_config'::text, null::int; return; end if;
      for v_name in select * from jsonb_array_elements(v_val) loop
        if jsonb_typeof(v_name) <> 'string' or (v_name #>> '{}') !~ '^[A-Z][A-Z0-9_]{0,63}$' then return query select 'bad_config'::text, null::int; return; end if;
      end loop;
    elsif jsonb_typeof(v_val) <> 'string' or length(v_val #>> '{}') not between 1 and 300 then
      return query select 'bad_config'::text, null::int; return;
    end if;
  end loop;
  -- a build never deploys or publishes, and the config never holds a secret value
  if lower(p_config::text) ~ '(vercel +(deploy|--prod)|gh +release|fastlane +(supply|pilot|deliver)|npm +publish|kubectl +apply|terraform +apply|git +push|--deploy)' then
    return query select 'deploy_is_not_a_build'::text, null::int; return;
  end if;
  if projects.mask_secrets(p_config::text) is distinct from p_config::text then return query select 'secret_in_config'::text, null::int; return; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  select * into v_prev from projects.build_configs c where c.project_id = p_project_id and c.current;
  if v_prev.id is not null and v_prev.config = p_config then return query select 'unchanged'::text, v_prev.version; return; end if;
  select coalesce(max(c.version), 0) + 1 into v_next from projects.build_configs c where c.project_id = p_project_id;
  update projects.build_configs c set current = false, superseded_at = now() where c.project_id = p_project_id and c.current;
  insert into projects.build_configs (organization_id, project_id, version, config, note, created_by) values (v_org, p_project_id, v_next, p_config, p_note, v_actor);
  perform core.record_audit(v_org, 'build.config_set', 'project', p_project_id, case when v_prev.id is null then null else jsonb_build_object('version', v_prev.version, 'config', v_prev.config) end,
    jsonb_build_object('version', v_next, 'config', p_config));
  return query select 'recorded'::text, v_next;
end $$;
revoke all on function projects.set_build_config(uuid, jsonb, text) from public, anon;
grant execute on function projects.set_build_config(uuid, jsonb, text) to authenticated;

create or replace function projects.build_config_current_version(p_project_id uuid)
returns int language sql stable security definer set search_path = '' as $$
  select c.version from projects.build_configs c where c.project_id = p_project_id and c.current
$$;
revoke all on function projects.build_config_current_version(uuid) from public, anon;
grant execute on function projects.build_config_current_version(uuid) to authenticated, service_role;

-- the fingerprint a run is recorded with: stamped with the config version it ran under. A worker may say it ran an OLDER version (the stamp
-- then keeps it, and the build is stale); it can never claim a newer one, and a project with no config gets no stamp at all.
create or replace function projects.stamp_config_version(p_fingerprint jsonb, p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cur int := projects.build_config_current_version(p_project_id); v_claim int; v_base jsonb := coalesce(p_fingerprint, '{}'::jsonb) - 'config_version';
begin
  if v_cur is null or v_base = '{}'::jsonb then return v_base; end if;
  if (p_fingerprint ->> 'config_version') ~ '^[0-9]{1,6}$' then v_claim := (p_fingerprint ->> 'config_version')::int; end if;
  return v_base || jsonb_build_object('config_version', case when v_claim between 1 and v_cur then v_claim else v_cur end);
end $$;
revoke all on function projects.stamp_config_version(jsonb, uuid) from public, anon, authenticated;
grant execute on function projects.stamp_config_version(jsonb, uuid) to service_role;

-- two runs recorded in one transaction are still ordered (now() would give them the same instant)
alter table projects.build_runs alter column created_at set default clock_timestamp();

-- true when the project has a current config and NO succeeded run on this build's commit was recorded under it (or a newer one)
create or replace function projects.build_run_config_stale(p_deliverable_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select not exists (
             select 1 from projects.build_runs br
               join projects.deliverable_details dd on dd.deliverable_id = br.deliverable_id and dd.commit_ref = br.commit_ref
              where br.deliverable_id = d.id and br.status = 'succeeded' and br.artifact_sha256 is not null
                and br.fingerprint ->> 'config_version' ~ '^[0-9]{1,6}$' and (br.fingerprint ->> 'config_version')::int >= c.version)
      from projects.deliverables d
      join projects.build_configs c on c.project_id = d.project_id and c.current
     where d.id = p_deliverable_id), false)
$$;
revoke all on function projects.build_run_config_stale(uuid) from public, anon;
grant execute on function projects.build_run_config_stale(uuid) to authenticated, service_role;

-- record_build_run stamps the fingerprint (patched into the live definition: the text must be there or this fails loudly)
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('projects.record_build_run(uuid,text,text,text,jsonb,jsonb,text,uuid,text,text)'::regprocedure);
  n := replace(d, 'coalesce(p_fingerprint, ''{}''), p_artifact_sha256, v_actor, p_idempotency_key',
                  'projects.stamp_config_version(coalesce(p_fingerprint, ''{}''), v_row.project_id), p_artifact_sha256, v_actor, p_idempotency_key');
  if n = d then raise exception 'record_build_run: expected text not found'; end if;
  execute n;
end $m$;

-- a build is shared only when its run used the CURRENT build config
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('projects.submit_deliverable(uuid,uuid,text)'::regprocedure);
  n := replace(d, '  -- Phase 5 DevOps/Build: the exact commit has a smoke verdict',
'  -- Phase 5 DevOps/Build: the run that built this commit used the CURRENT build config, not an older version of it.
  if v_row.kind = ''build'' and projects.build_run_config_stale(v_row.id) then
    return query select ''stale_config''::text, null::uuid, v_row.status;
    return;
  end if;

  -- Phase 5 DevOps/Build: the exact commit has a smoke verdict');
  if n = d then raise exception 'submit_deliverable: expected text not found'; end if;
  execute n;
end $m$;

-- reproducible only when it was reproduced: 'reproduced' needs two or more succeeded runs of the same commit under the same config version
-- whose artifact hashes AND comparable fingerprints are identical; 'differs' when they are not; 'single_run' when there is nothing to compare.
create or replace function projects.build_reproducibility(p_deliverable_id uuid, p_commit text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid; v_cv text; v_n int; v_hashes int; v_fps int;
begin
  select d.organization_id into v_org from projects.deliverables d where d.id = p_deliverable_id;
  if v_org is null then return null; end if;
  if not (coalesce((select auth.role()), '') = 'service_role'
          or (coalesce((select core.is_internal()), false) and v_org = (select core.current_organization_id()))) then return null; end if;
  select coalesce(br.fingerprint ->> 'config_version', '') into v_cv
    from projects.build_runs br
   where br.deliverable_id = p_deliverable_id and br.commit_ref = p_commit and br.status = 'succeeded' and br.artifact_sha256 is not null
   order by br.created_at desc, br.id desc limit 1;
  if not found then return 'single_run'; end if;
  select count(*), count(distinct br.artifact_sha256),
         count(distinct (br.fingerprint - array['config_version', 'run_url', 'run_id', 'run_attempt', 'started_at', 'finished_at', 'request_id'])::text)
    into v_n, v_hashes, v_fps
    from projects.build_runs br
   where br.deliverable_id = p_deliverable_id and br.commit_ref = p_commit and br.status = 'succeeded' and br.artifact_sha256 is not null
     and coalesce(br.fingerprint ->> 'config_version', '') = v_cv;
  if v_n < 2 then return 'single_run'; end if;
  return case when v_hashes = 1 and v_fps = 1 then 'reproduced' else 'differs' end;
end $$;
revoke all on function projects.build_reproducibility(uuid, text) from public, anon;
grant execute on function projects.build_reproducibility(uuid, text) to authenticated, service_role;
notify pgrst, 'reload schema';
