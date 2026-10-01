-- X2 / decision 13 (2026-10-01): the contract and migration checks of a client
-- environment run as a GitHub workflow dispatched from the panel, and the
-- result is recorded on the environment's readiness.
--
-- What already existed: `projects.environments.readiness` holds three checks
-- (api_contract, migrations, external_config), each recorded BY A PERSON through
-- `projects.record_environment_check` with an evidence link, and
-- `projects.promote_build` refuses while one is missing or failed. Nothing ran a
-- check. That hand-recorded path stays exactly as it is, as the fallback.
--
-- What this adds:
--   projects.environment_check_runs   one row per dispatch: which environment,
--                                     which of the two checks (api_contract,
--                                     migrations), the repository and workflow
--                                     file, a correlation key sent to the
--                                     workflow, who dispatched and when, and
--                                     what the status read found (run id, link,
--                                     status, conclusion).
--   projects.record_check_dispatch    the door the service calls AFTER GitHub
--                                     accepted the workflow_dispatch. Owner, ops
--                                     admin or delivery lead (core.can_manage_delivery,
--                                     the roles of project.write).
--   projects.record_check_run_result  the door the status read calls. While the
--                                     run is going it stores status; when it has
--                                     completed it stores the conclusion and the
--                                     link AND records each dispatched check on the
--                                     environment's readiness - ok only when the
--                                     conclusion is `success` - with the run's URL as
--                                     the evidence, so the Builds screen and the
--                                     promotion gate read one place. Recorded once.
--
-- Every new table has RLS enabled and forced, an internal SELECT policy and no
-- write grant for authenticated; both doors are security definer, re-check the
-- role, are scoped to the caller's organization, and write an audit row.
-- Idempotent.

create table if not exists projects.environment_check_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  environment_id   uuid not null references projects.environments(id) on delete cascade,
  checks           text[] not null check (
                     cardinality(checks) between 1 and 2
                     and checks <@ array['api_contract', 'migrations']::text[]
                   ),
  repository       text not null check (length(btrim(repository)) between 3 and 200),
  workflow_file    text not null check (workflow_file ~ '^[A-Za-z0-9._-]+\.ya?ml$'),
  ref              text not null check (length(btrim(ref)) between 1 and 200),
  -- Sent to the workflow as an input so a run can be matched to its dispatch.
  dispatch_key     text not null check (length(dispatch_key) between 8 and 64),
  dispatched_by    uuid references core.users(id) on delete set null,
  dispatched_at    timestamptz not null default now(),
  -- What the status read found.
  status           text not null default 'dispatched' check (status in ('dispatched', 'in_progress', 'completed')),
  conclusion       text check (conclusion is null or length(conclusion) between 1 and 40),
  run_id           bigint,
  run_url          text check (run_url is null or run_url ~ '^https://'),
  result_read_at   timestamptz,
  -- Set once, when a completed run was written onto the environment's readiness.
  applied_at       timestamptz,
  constraint environment_check_runs_completed_has_conclusion check (status <> 'completed' or conclusion is not null)
);

comment on table projects.environment_check_runs is
  'X2 decision 13: one row per dispatch of the contract/migration check workflow on a client environment, with the run the status read found (status, conclusion, link). Written only through projects.record_check_dispatch and projects.record_check_run_result.';

create index if not exists environment_check_runs_env_idx
  on projects.environment_check_runs (organization_id, environment_id, dispatched_at desc);
create unique index if not exists environment_check_runs_dispatch_key_idx
  on projects.environment_check_runs (organization_id, dispatch_key);

drop trigger if exists org_match_environment_check_runs_project on projects.environment_check_runs;
create trigger org_match_environment_check_runs_project
  before insert or update of project_id, organization_id on projects.environment_check_runs
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists org_match_environment_check_runs_environment on projects.environment_check_runs;
create trigger org_match_environment_check_runs_environment
  before insert or update of environment_id, organization_id on projects.environment_check_runs
  for each row execute function core.enforce_parent_org('environment_id', 'projects.environments');
drop trigger if exists freeze_org_environment_check_runs on projects.environment_check_runs;
create trigger freeze_org_environment_check_runs
  before update of organization_id on projects.environment_check_runs
  for each row execute function core.freeze_organization_id();

alter table projects.environment_check_runs enable row level security;
alter table projects.environment_check_runs force row level security;
drop policy if exists environment_check_runs_select on projects.environment_check_runs;
create policy environment_check_runs_select on projects.environment_check_runs
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.environment_check_runs from public, anon, authenticated;
grant select on projects.environment_check_runs to authenticated;
grant select, insert, update, delete on projects.environment_check_runs to service_role;

-- ── the dispatch ───────────────────────────────────────────────────────────
create or replace function projects.record_check_dispatch(
  p_environment_id uuid,
  p_checks         text[],
  p_repository     text,
  p_workflow_file  text,
  p_ref            text,
  p_dispatch_key   text
)
returns table (outcome text, run_row_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_env   projects.environments;
  v_id    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if p_checks is null or cardinality(p_checks) < 1 or not (p_checks <@ array['api_contract', 'migrations']::text[]) then
    return query select 'bad_check'::text, null::uuid; return;
  end if;
  if p_workflow_file is null or p_workflow_file !~ '^[A-Za-z0-9._-]+\.ya?ml$' then
    return query select 'bad_workflow'::text, null::uuid; return;
  end if;
  if p_dispatch_key is null or length(p_dispatch_key) not between 8 and 64 then
    return query select 'bad_key'::text, null::uuid; return;
  end if;
  select * into v_env from projects.environments e where e.id = p_environment_id and e.organization_id = v_org;
  if v_env.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  insert into projects.environment_check_runs (
    organization_id, project_id, environment_id, checks, repository, workflow_file, ref, dispatch_key, dispatched_by
  ) values (
    v_org, v_env.project_id, v_env.id, (select array_agg(distinct c order by c) from unnest(p_checks) c),
    btrim(p_repository), p_workflow_file, btrim(p_ref), p_dispatch_key, v_actor
  )
  returning id into v_id;

  perform core.record_audit(
    v_org, 'environment.checks_dispatched', 'environment', v_env.id, null,
    jsonb_build_object('projectId', v_env.project_id, 'runRowId', v_id, 'checks', p_checks,
                       'repository', btrim(p_repository), 'workflow', p_workflow_file, 'ref', btrim(p_ref))
  );
  return query select 'recorded'::text, v_id;
end;
$$;

comment on function projects.record_check_dispatch(uuid, text[], text, text, text, text) is
  'X2 decision 13 - records that the contract/migration check workflow was dispatched on GitHub for an environment. Called only after GitHub accepted the dispatch. Owner, ops_admin or delivery_lead; audited environment.checks_dispatched.';
revoke all on function projects.record_check_dispatch(uuid, text[], text, text, text, text) from public, anon;
grant execute on function projects.record_check_dispatch(uuid, text[], text, text, text, text) to authenticated, service_role;

-- ── the status read ─────────────────────────────────────────────────────────
create or replace function projects.record_check_run_result(
  p_run_row_id uuid,
  p_status     text,
  p_conclusion text,
  p_run_id     bigint,
  p_run_url    text
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_run   projects.environment_check_runs;
  v_env   projects.environments;
  v_conclusion text := nullif(btrim(coalesce(p_conclusion, '')), '');
  v_ok    boolean;
  v_check text;
  v_entry jsonb;
  v_readiness jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if p_status not in ('in_progress', 'completed') then
    return query select 'bad_status'::text; return;
  end if;
  if p_status = 'completed' and v_conclusion is null then
    return query select 'bad_conclusion'::text; return;
  end if;
  if p_run_url is not null and btrim(p_run_url) <> '' and p_run_url !~ '^https://' then
    return query select 'bad_url'::text; return;
  end if;

  select * into v_run from projects.environment_check_runs r where r.id = p_run_row_id and r.organization_id = v_org for update;
  if v_run.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_run.applied_at is not null then
    return query select 'already_recorded'::text; return;
  end if;

  update projects.environment_check_runs
     set status = p_status,
         conclusion = case when p_status = 'completed' then v_conclusion else conclusion end,
         run_id = coalesce(p_run_id, run_id),
         run_url = coalesce(nullif(btrim(coalesce(p_run_url, '')), ''), run_url),
         result_read_at = now()
   where id = v_run.id;

  if p_status = 'completed' then
    select * into v_env from projects.environments e where e.id = v_run.environment_id and e.organization_id = v_org for update;
    if v_env.id is not null then
      v_ok := v_conclusion = 'success';
      v_readiness := v_env.readiness;
      foreach v_check in array v_run.checks loop
        v_entry := jsonb_build_object(
          'ok', v_ok,
          'evidence_url', coalesce(nullif(btrim(coalesce(p_run_url, '')), ''), v_run.run_url),
          'note', 'GitHub workflow ' || v_run.workflow_file || ' run ' || coalesce(p_run_id::text, v_run.run_id::text, '?') || ': ' || v_conclusion,
          'checked_at', now(),
          'checked_by', v_actor,
          'source', 'workflow',
          'run_row_id', v_run.id
        );
        v_readiness := v_readiness || jsonb_build_object(v_check, v_entry);
      end loop;
      update projects.environments set readiness = v_readiness where id = v_env.id;
    end if;
    update projects.environment_check_runs set applied_at = now() where id = v_run.id;

    perform core.record_audit(
      v_org, 'environment.checks_result_recorded', 'environment', v_run.environment_id, null,
      jsonb_build_object('projectId', v_run.project_id, 'runRowId', v_run.id, 'checks', v_run.checks,
                         'conclusion', v_conclusion, 'ok', v_conclusion = 'success', 'runUrl', coalesce(p_run_url, v_run.run_url))
    );
    return query select 'recorded'::text;
    return;
  end if;

  return query select 'progress_noted'::text;
end;
$$;

comment on function projects.record_check_run_result(uuid, text, text, bigint, text) is
  'X2 decision 13 - stores what the GitHub status read found for a dispatched check run; once completed it records each dispatched check on the environment readiness (ok only for conclusion success, the run URL as evidence) and audits environment.checks_result_recorded. Recorded once.';
revoke all on function projects.record_check_run_result(uuid, text, text, bigint, text) from public, anon;
grant execute on function projects.record_check_run_result(uuid, text, text, bigint, text) to authenticated, service_role;

notify pgrst, 'reload schema';
