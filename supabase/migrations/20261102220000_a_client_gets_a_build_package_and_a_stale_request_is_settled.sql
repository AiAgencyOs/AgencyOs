-- DevOps/Build spec (P509 §24, §32): what a client may be given of a build, and how a build request that nobody answered is settled.
--   projects.client_build_packages   append-only; written only through create_client_build_package, only when the build is READY
--   projects.client_build_package    the client-safe read: a label, limitations and testing instructions - no logs, stages, fingerprint, commit or ids
--   projects.cancel_build_request / projects.expire_stale_build_requests   a request is cancelled by an Admin, or settled by a sweeper

-- READY = QA passed AND Admin approved AND the artifact is the one the newest succeeded run produced (for the current commit) AND the smoke verdict
-- of that commit is shareable AND the run used the current build config. Anything else names what is missing.
create or replace function projects.client_build_package_readiness(p_deliverable_id uuid)
returns table (ready boolean, reason text, build_run_id uuid, build_artifact_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_row projects.deliverables; v_commit text; v_gate record; v_run projects.build_runs; v_art projects.build_artifacts;
begin
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id;
  if v_row.id is null then return query select false, 'not_found'::text, null::uuid, null::uuid; return; end if;
  if v_row.kind <> 'build' then return query select false, 'wrong_kind'::text, null::uuid, null::uuid; return; end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_row.id;
  if nullif(btrim(coalesce(v_commit, '')), '') is null then return query select false, 'no_commit'::text, null::uuid, null::uuid; return; end if;
  select * into v_gate from projects.prototype_send_gate(v_row.id);
  if not coalesce(v_gate.qa_passed, false) then return query select false, 'not_qa_passed'::text, null::uuid, null::uuid; return; end if;
  if not coalesce(v_gate.admin_approved, false) then return query select false, 'not_admin_approved'::text, null::uuid, null::uuid; return; end if;
  select * into v_run from projects.build_runs r where r.deliverable_id = v_row.id and r.status = 'succeeded' and r.artifact_sha256 is not null order by r.created_at desc, r.id desc limit 1;
  if v_run.id is null then return query select false, 'no_build_run'::text, null::uuid, null::uuid; return; end if;
  -- the newest run built an older commit: whatever artifact exists is not this build's
  if v_run.commit_ref <> v_commit then return query select false, 'artifact_not_newest'::text, v_run.id, null::uuid; return; end if;
  select * into v_art from projects.build_artifacts a where a.build_run_id = v_run.id;
  if v_art.id is null then
    return query select false, (case when exists (select 1 from projects.build_artifacts a join projects.build_runs r on r.id = a.build_run_id where r.deliverable_id = v_row.id)
                                     then 'artifact_not_newest' else 'no_artifact' end)::text, v_run.id, null::uuid;
    return;
  end if;
  if not projects.build_smoke_ready(v_row.id) then return query select false, 'no_smoke'::text, v_run.id, v_art.id; return; end if;
  if projects.build_run_config_stale(v_row.id) then return query select false, 'stale_config'::text, v_run.id, v_art.id; return; end if;
  return query select true, 'ready'::text, v_run.id, v_art.id;
end $$;
revoke all on function projects.client_build_package_readiness(uuid) from public, anon, authenticated;
grant execute on function projects.client_build_package_readiness(uuid) to service_role;

create table if not exists projects.client_build_packages (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  deliverable_id        uuid not null references projects.deliverables(id) on delete restrict,
  build_run_id          uuid not null references projects.build_runs(id) on delete restrict,
  build_artifact_id     uuid not null references projects.build_artifacts(id) on delete restrict,
  commit_ref            text not null check (length(btrim(commit_ref)) > 0),
  label                 text not null default 'Development build, not production' check (label = 'Development build, not production'),
  limitations           text not null check (length(btrim(limitations)) between 1 and 2000),
  testing_instructions  text not null check (length(btrim(testing_instructions)) between 1 and 4000),
  created_by            uuid references core.users(id) on delete set null,
  created_at            timestamptz not null default clock_timestamp()
);
create index if not exists client_build_packages_idx on projects.client_build_packages (deliverable_id, created_at desc);

alter table projects.client_build_packages enable row level security;
drop policy if exists client_build_packages_read on projects.client_build_packages;
create policy client_build_packages_read on projects.client_build_packages for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.client_build_packages from public, anon;
revoke insert, update, delete on projects.client_build_packages from authenticated;
grant select on projects.client_build_packages to authenticated;
grant all on projects.client_build_packages to service_role;
create trigger client_build_packages_parent_org_project before insert or update of project_id on projects.client_build_packages for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger client_build_packages_parent_org_deliverable before insert or update of deliverable_id on projects.client_build_packages for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');
create trigger client_build_packages_parent_org_run before insert or update of build_run_id on projects.client_build_packages for each row execute function core.enforce_parent_org('build_run_id', 'projects.build_runs');
create trigger client_build_packages_parent_org_artifact before insert or update of build_artifact_id on projects.client_build_packages for each row execute function core.enforce_parent_org('build_artifact_id', 'projects.build_artifacts');
create trigger freeze_org_client_build_packages before update of organization_id on projects.client_build_packages for each row execute function core.freeze_organization_id();
create or replace function projects.client_build_packages_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a client build package records what the client was told: it is never rewritten (write a new one)' using errcode = 'restrict_violation'; end $$;
create trigger client_build_packages_append_only before update or delete on projects.client_build_packages for each row execute function projects.client_build_packages_append_only();

create or replace function projects.create_client_build_package(p_deliverable_id uuid, p_limitations text, p_testing_instructions text)
returns table (outcome text, package_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_row projects.deliverables; v_ready record; v_commit text; v_lim text := nullif(btrim(coalesce(p_limitations, '')), ''); v_ins text := nullif(btrim(coalesce(p_testing_instructions, '')), '');
  v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org;
  if v_row.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_lim is null then return query select 'limitations_required'::text, null::uuid; return; end if;
  if v_ins is null then return query select 'instructions_required'::text, null::uuid; return; end if;
  if length(v_lim) > 2000 or length(v_ins) > 4000 then return query select 'too_long'::text, null::uuid; return; end if;
  if projects.mask_secrets(v_lim || ' ' || v_ins) is distinct from (v_lim || ' ' || v_ins) then return query select 'secret_in_text'::text, null::uuid; return; end if;
  select * into v_ready from projects.client_build_package_readiness(v_row.id);
  if not v_ready.ready then return query select v_ready.reason, null::uuid; return; end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_row.id;
  insert into projects.client_build_packages (organization_id, project_id, deliverable_id, build_run_id, build_artifact_id, commit_ref, limitations, testing_instructions, created_by)
  values (v_row.organization_id, v_row.project_id, v_row.id, v_ready.build_run_id, v_ready.build_artifact_id, v_commit, v_lim, v_ins, v_actor) returning id into v_new;
  perform core.record_audit(v_org, 'build.client_package_created', 'deliverable', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'packageId', v_new, 'commit', v_commit));
  return query select 'recorded'::text, v_new;
end $$;
revoke all on function projects.create_client_build_package(uuid, text, text) from public, anon;
grant execute on function projects.create_client_build_package(uuid, text, text) to authenticated;

-- the client-safe read. A client reads only its own account's build, only once it has been shared, only while it is STILL ready (a newer artifact,
-- a withdrawn approval or a stale config takes the package away), and sees nothing internal: no log, stage, fingerprint, commit, run or artifact id.
create or replace function projects.client_build_package(p_deliverable_id uuid)
returns table (title text, version int, label text, platform text, artifact_type text, distributable boolean, artifact_limitation text, limitations text, testing_instructions text, packaged_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_row projects.deliverables; v_proj projects.projects; v_ready record; v_pkg projects.client_build_packages;
begin
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id;
  if v_row.id is null or v_row.organization_id is distinct from v_org then return; end if;
  select * into v_proj from projects.projects p where p.id = v_row.project_id;
  if coalesce((select core.is_client()), false) then
    if v_proj.client_account_id is distinct from (select core.current_client_account_id()) or v_row.status not in ('in_review', 'approved') then return; end if;
  elsif not coalesce((select core.is_internal()), false) then
    return;
  end if;
  select * into v_ready from projects.client_build_package_readiness(v_row.id);
  if not v_ready.ready then return; end if;
  select * into v_pkg from projects.client_build_packages k where k.deliverable_id = v_row.id and k.build_artifact_id = v_ready.build_artifact_id order by k.created_at desc, k.id desc limit 1;
  if v_pkg.id is null then return; end if;
  return query
    select v_row.title, v_row.version, v_pkg.label, dd.platform, a.artifact_type, a.distributable, a.limitation, v_pkg.limitations, v_pkg.testing_instructions, v_pkg.created_at
      from projects.build_artifacts a left join projects.deliverable_details dd on dd.deliverable_id = v_row.id
     where a.id = v_pkg.build_artifact_id;
end $$;
revoke all on function projects.client_build_package(uuid) from public, anon;
grant execute on function projects.client_build_package(uuid) to authenticated;

-- an Admin cancels a request that has not been answered; the report endpoint then refuses a report for it (it is no longer open)
create or replace function projects.cancel_build_request(p_request_id uuid, p_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_req projects.build_requests;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_req from projects.build_requests r where r.id = p_request_id and r.organization_id = v_org for update;
  if v_req.id is null then return query select 'not_found'::text; return; end if;
  if v_req.status <> 'requested' then return query select 'already_settled'::text; return; end if;
  update projects.build_requests set status = 'cancelled', detail = left(coalesce(nullif(btrim(p_reason), ''), 'cancelled by an Admin'), 500), settled_at = now() where id = v_req.id;
  perform core.record_audit(v_org, 'build.request_cancelled', 'build_request', v_req.id, null, jsonb_build_object('deliverableId', v_req.deliverable_id, 'commit', v_req.commit_ref));
  return query select 'cancelled'::text;
end $$;
revoke all on function projects.cancel_build_request(uuid, text) from public, anon;
grant execute on function projects.cancel_build_request(uuid, text) to authenticated;

-- the sweeper (service role): a request nobody reported on within the interval is a failed dispatch, visibly - not an open request forever
create or replace function projects.expire_stale_build_requests(p_older_than interval)
returns table (outcome text, expired int)
language plpgsql security definer set search_path = '' as $$
declare r record; v_n int := 0;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, 0; return; end if;
  if p_older_than is null or p_older_than < interval '1 minute' then return query select 'bad_interval'::text, 0; return; end if;
  for r in select q.id, q.organization_id, q.deliverable_id, q.commit_ref from projects.build_requests q where q.status = 'requested' and q.created_at < now() - p_older_than order by q.created_at for update loop
    update projects.build_requests set status = 'dispatch_failed', detail = 'no report received', settled_at = now() where id = r.id;
    perform core.record_audit(r.organization_id, 'build.request_expired', 'build_request', r.id, null, jsonb_build_object('deliverableId', r.deliverable_id, 'commit', r.commit_ref));
    v_n := v_n + 1;
  end loop;
  return query select 'swept'::text, v_n;
end $$;
revoke all on function projects.expire_stale_build_requests(interval) from public, anon, authenticated;
grant execute on function projects.expire_stale_build_requests(interval) to service_role;
notify pgrst, 'reload schema';
