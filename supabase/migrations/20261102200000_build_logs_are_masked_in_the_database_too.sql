-- DevOps/Build spec (P509 §14, §26): a build log is evidence, and a secret that reaches it is a leak the moment it is stored. The runner masks what it
-- records (src/modules/projects/build-runner.ts maskSecrets); the DATABASE masks again, so a runner that forgot, or a different writer, cannot
-- store one. Logs are internal: a client never sees a build log, and the client-safe view below has no log column at all.

-- the same families as maskSecrets (TS): keys, tokens, JWTs, PEM private keys, URLs with a password, name=value pairs, bearer credentials
create or replace function projects.mask_secrets(p_text text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := coalesce(p_text, '');
begin
  v := regexp_replace(v, 'sk-[A-Za-z0-9_-]{16,}', '[masked]', 'g');
  v := regexp_replace(v, 'gh[pousr]_[A-Za-z0-9]{20,}', '[masked]', 'g');
  v := regexp_replace(v, 'xox[abprs]-[A-Za-z0-9-]{10,}', '[masked]', 'g');
  v := regexp_replace(v, 'AKIA[0-9A-Z]{12,}', '[masked]', 'g');
  v := regexp_replace(v, 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}', '[masked]', 'g');
  -- a complete key block, then a block that was cut off (everything after the header goes)
  v := regexp_replace(v, '-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]*-----END [A-Z ]*PRIVATE KEY-----', '[masked]', 'g');
  v := regexp_replace(v, '-----BEGIN [A-Z ]*PRIVATE KEY-----.*', '[masked]', 'g');
  v := regexp_replace(v, '\m[a-z][a-z0-9+.-]*://[^[:space:]:@/]+:[^[:space:]@/]+@[^[:space:]/]+', '[masked]', 'gi');
  v := regexp_replace(v, '\mBearer[[:space:]]+[A-Za-z0-9._~+/=-]{12,}', '[masked]', 'gi');
  v := regexp_replace(v, '\m(api[_-]?key|secret|token|password|passwd)[[:space:]]*[=:][[:space:]]*[^[:space:]]{6,}', '[masked]', 'gi');
  return v;
end $$;
revoke all on function projects.mask_secrets(text) from public, anon;
grant execute on function projects.mask_secrets(text) to authenticated, service_role;

create table if not exists projects.build_logs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  build_run_id     uuid not null references projects.build_runs(id) on delete restrict,
  stage            text not null check (stage in ('source', 'env', 'install', 'lint_type', 'test', 'build', 'artifact_verify', 'smoke')),
  attempt          int not null check (attempt between 1 and 3),
  masked_text      text not null check (length(masked_text) between 1 and 50000),
  -- clock_timestamp, not now(): two lines in one transaction are still ordered
  created_at       timestamptz not null default clock_timestamp()
);
create index if not exists build_logs_run_idx on projects.build_logs (build_run_id, created_at);

alter table projects.build_logs enable row level security;
drop policy if exists build_logs_read on projects.build_logs;
create policy build_logs_read on projects.build_logs for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.build_logs from public, anon;
revoke insert, update, delete on projects.build_logs from authenticated;
grant select on projects.build_logs to authenticated;
grant all on projects.build_logs to service_role;
create trigger build_logs_parent_org_project before insert or update of project_id on projects.build_logs for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger build_logs_parent_org_run before insert or update of build_run_id on projects.build_logs for each row execute function core.enforce_parent_org('build_run_id', 'projects.build_runs');
create trigger freeze_org_build_logs before update of organization_id on projects.build_logs for each row execute function core.freeze_organization_id();

-- append-only, and whatever the writer sent is masked again on the way in (a direct service-role insert too)
create or replace function projects.build_logs_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then raise exception 'a build log is evidence and is never rewritten or deleted' using errcode = 'restrict_violation'; end if;
  new.masked_text := projects.mask_secrets(new.masked_text);
  return new;
end $$;
create trigger build_logs_guard before insert or update or delete on projects.build_logs for each row execute function projects.build_logs_guard();

-- the only door: the runner / report endpoint (service role)
create or replace function projects.append_build_log(p_build_run_id uuid, p_stage text, p_text text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_run projects.build_runs; v_text text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  if p_stage is null or p_stage not in ('source', 'env', 'install', 'lint_type', 'test', 'build', 'artifact_verify', 'smoke') then return query select 'bad_stage'::text; return; end if;
  select * into v_run from projects.build_runs r where r.id = p_build_run_id;
  if v_run.id is null then return query select 'not_found'::text; return; end if;
  -- mask first, THEN bound the length: a cut can never leave the front half of a secret behind
  v_text := left(projects.mask_secrets(p_text), 50000);
  if length(btrim(v_text)) = 0 then return query select 'empty'::text; return; end if;
  insert into projects.build_logs (organization_id, project_id, build_run_id, stage, attempt, masked_text)
  values (v_run.organization_id, v_run.project_id, v_run.id, p_stage, v_run.attempt, v_text);
  return query select 'recorded'::text;
end $$;
revoke all on function projects.append_build_log(uuid, text, text) from public, anon, authenticated;
grant execute on function projects.append_build_log(uuid, text, text) to service_role;

-- staff read: internal roles of the run's own organization, in the order they were written
create or replace function projects.build_logs_for_run(p_build_run_id uuid)
returns table (stage text, attempt int, masked_text text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.stage, l.attempt, l.masked_text, l.created_at
    from projects.build_logs l
   where l.build_run_id = p_build_run_id
     and coalesce((select core.is_internal()), false)
     and l.organization_id = (select core.current_organization_id())
   order by l.created_at, l.id
$$;
revoke all on function projects.build_logs_for_run(uuid) from public, anon;
grant execute on function projects.build_logs_for_run(uuid) to authenticated;

-- the client-safe face of a run: its verdict and when, and nothing else - no stages, no fingerprint, no failure detail, no logs. A client sees only
-- the SUCCEEDED runs of a build that has been shared with its own account; staff see the runs of their organization.
create or replace view projects.build_runs_client_safe as
  select r.id, r.deliverable_id, r.environment, r.status, r.created_at
    from projects.build_runs r
    join projects.deliverables d on d.id = r.deliverable_id
    join projects.projects p on p.id = d.project_id
   where r.organization_id = (select core.current_organization_id())
     and (coalesce((select core.is_internal()), false)
          or (coalesce((select core.is_client()), false) and r.status = 'succeeded' and d.status in ('in_review', 'approved')
              and p.client_account_id = (select core.current_client_account_id())));
revoke all on projects.build_runs_client_safe from public, anon;
grant select on projects.build_runs_client_safe to authenticated, service_role;
notify pgrst, 'reload schema';
