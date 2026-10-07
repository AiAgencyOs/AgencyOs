-- DevOps/Build spec (P509 §6, §32): a build is REQUESTED (a record with a state) before any worker runs it, so a lost callback or a refused
-- dispatch is visible instead of silent. The request names the exact commit; a result is accepted only for a request that exists.
create table if not exists projects.build_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  deliverable_id   uuid not null references projects.deliverables(id) on delete restrict,
  commit_ref       text not null check (length(btrim(commit_ref)) > 0),
  environment      text not null check (environment in ('dev', 'review', 'staging', 'client_test')),
  status           text not null default 'requested' check (status in ('requested', 'reported', 'dispatch_failed', 'cancelled')),
  detail           text check (detail is null or length(detail) <= 500),
  requested_by     uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  settled_at       timestamptz,
  check ((status = 'requested') = (settled_at is null))
);
create unique index if not exists build_requests_one_open on projects.build_requests (deliverable_id, commit_ref) where status = 'requested';
alter table projects.build_requests enable row level security;
drop policy if exists build_requests_read on projects.build_requests;
create policy build_requests_read on projects.build_requests for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.build_requests from public, anon;
revoke insert, update, delete on projects.build_requests from authenticated;
grant select on projects.build_requests to authenticated;
grant all on projects.build_requests to service_role;
create trigger build_requests_parent_org_project before insert or update of project_id on projects.build_requests for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger build_requests_parent_org_deliverable before insert or update of deliverable_id on projects.build_requests for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');
create trigger freeze_org_build_requests before update of organization_id on projects.build_requests for each row execute function core.freeze_organization_id();
create or replace function projects.build_requests_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a build request is part of the record' using errcode = 'restrict_violation'; end if;
  if old.status <> 'requested' then raise exception 'a settled build request is final' using errcode = 'restrict_violation'; end if;
  if new.commit_ref is distinct from old.commit_ref or new.deliverable_id is distinct from old.deliverable_id or new.environment is distinct from old.environment then
    raise exception 'a build request names its commit once' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger build_requests_guard before update or delete on projects.build_requests for each row execute function projects.build_requests_guard();

create or replace function projects.request_build(p_deliverable_id uuid)
returns table (outcome text, request_id uuid, commit_ref text, environment text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_row projects.deliverables; v_dd projects.deliverable_details; v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid, null::text, null::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid, null::text, null::text; return; end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org;
  if v_row.id is null then return query select 'not_found'::text, null::uuid, null::text, null::text; return; end if;
  if v_row.kind <> 'build' then return query select 'wrong_kind'::text, null::uuid, null::text, null::text; return; end if;
  if v_row.status not in ('draft', 'changes_requested') then return query select 'build_already_shared'::text, null::uuid, null::text, null::text; return; end if;
  select * into v_dd from projects.deliverable_details dd where dd.deliverable_id = v_row.id;
  if nullif(btrim(coalesce(v_dd.commit_ref, '')), '') is null then return query select 'no_commit'::text, null::uuid, null::text, null::text; return; end if;
  if exists (select 1 from projects.build_requests r where r.deliverable_id = v_row.id and r.commit_ref = v_dd.commit_ref and r.status = 'requested') then
    return query select 'already_requested'::text, null::uuid, null::text, null::text; return;
  end if;
  insert into projects.build_requests (organization_id, project_id, deliverable_id, commit_ref, environment, requested_by)
  values (v_row.organization_id, v_row.project_id, v_row.id, v_dd.commit_ref, coalesce(v_dd.target_env, 'review'), v_actor) returning id into v_new;
  perform core.record_audit(v_org, 'build.requested', 'build_request', v_new, null, jsonb_build_object('deliverableId', v_row.id, 'commit', v_dd.commit_ref));
  return query select 'requested'::text, v_new, v_dd.commit_ref, coalesce(v_dd.target_env, 'review');
end $$;
revoke all on function projects.request_build(uuid) from public, anon;
grant execute on function projects.request_build(uuid) to authenticated;

-- the dispatcher / the report endpoint settle it (service role only): dispatch refused, or the worker reported
create or replace function projects.settle_build_request(p_request_id uuid, p_status text, p_detail text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  if p_status not in ('reported', 'dispatch_failed', 'cancelled') then return query select 'bad_status'::text; return; end if;
  update projects.build_requests set status = p_status, detail = left(p_detail, 500), settled_at = now() where id = p_request_id and status = 'requested';
  if not found then
    return query select (case when exists (select 1 from projects.build_requests r where r.id = p_request_id) then 'already_settled' else 'not_found' end)::text; return;
  end if;
  return query select 'settled'::text;
end $$;
revoke all on function projects.settle_build_request(uuid, text, text) from public, anon, authenticated;
grant execute on function projects.settle_build_request(uuid, text, text) to service_role;

-- the report endpoint asks which open request a report belongs to (the exact deliverable and commit); org comes from the row
create or replace function projects.open_build_request_for(p_deliverable_id uuid, p_commit text)
returns table (request_id uuid, organization_id uuid, project_id uuid, environment text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.organization_id, r.project_id, r.environment
    from projects.build_requests r
   where coalesce((select auth.role()), '') = 'service_role' and r.deliverable_id = p_deliverable_id and r.commit_ref = p_commit and r.status = 'requested'
$$;
revoke all on function projects.open_build_request_for(uuid, text) from public, anon, authenticated;
grant execute on function projects.open_build_request_for(uuid, text) to service_role;
notify pgrst, 'reload schema';
