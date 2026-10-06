-- Integration spec (P5-08 section on observability and failure isolation): every check is a fact in an append-only log (class, HTTP status, latency),
-- staff read the last success, the last failure class and the recent error rate, and when an integration degrades or is blocked ONLY the tasks that
-- depend on it are blocked; they resume when it is verified again. Unrelated tasks are never touched.

-- ── 1. the check log ─────────────────────────────────────────────────────
create table if not exists projects.integration_check_log (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  connection_id    uuid not null references projects.integration_connections(id) on delete cascade,
  check_class      text not null check (check_class in ('ok', 'unauthorized', 'not_found', 'rate_limited', 'server_error', 'timeout', 'network', 'credential_missing', 'no_target')),
  http_status      int check (http_status is null or http_status between 100 and 599),
  latency_ms       int check (latency_ms is null or latency_ms >= 0),
  -- clock_timestamp, not now(): two checks in one transaction are still ordered
  checked_at       timestamptz not null default clock_timestamp()
);
create index if not exists integration_check_log_conn_idx on projects.integration_check_log (connection_id, checked_at desc);
alter table projects.integration_check_log enable row level security;
drop policy if exists integration_check_log_read on projects.integration_check_log;
create policy integration_check_log_read on projects.integration_check_log for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.integration_check_log from public, anon;
revoke insert, update, delete on projects.integration_check_log from authenticated;
grant select on projects.integration_check_log to authenticated;
grant all on projects.integration_check_log to service_role;
create trigger integration_check_log_parent_org_project before insert or update of project_id on projects.integration_check_log
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger integration_check_log_parent_org_connection before insert or update of connection_id on projects.integration_check_log
  for each row execute function core.enforce_parent_org('connection_id', 'projects.integration_connections');
create trigger freeze_org_integration_check_log before update of organization_id on projects.integration_check_log
  for each row execute function core.freeze_organization_id();
create or replace function projects.integration_check_log_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'an integration check is a fact: it is never rewritten or removed' using errcode = 'restrict_violation'; end $$;
create trigger integration_check_log_append_only before update on projects.integration_check_log for each row execute function projects.integration_check_log_append_only();

-- the adapter runner's door (service role only): the class, and the HTTP status and latency when it has them
create or replace function projects.log_integration_check(p_connection_id uuid, p_class text, p_http_status int default null, p_latency_ms int default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_row projects.integration_connections;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'adapter_only'::text; return; end if;
  if p_class not in ('ok', 'unauthorized', 'not_found', 'rate_limited', 'server_error', 'timeout', 'network', 'credential_missing', 'no_target') then return query select 'bad_class'::text; return; end if;
  if (p_http_status is not null and p_http_status not between 100 and 599) or (p_latency_ms is not null and p_latency_ms < 0) then return query select 'bad_measure'::text; return; end if;
  select * into v_row from projects.integration_connections c where c.id = p_connection_id;
  if v_row.id is null then return query select 'not_found'::text; return; end if;
  update projects.integration_connections set last_check_at = now(), last_check_class = p_class where id = v_row.id;
  insert into projects.integration_check_log (organization_id, project_id, connection_id, check_class, http_status, latency_ms)
  values (v_row.organization_id, v_row.project_id, v_row.id, p_class, p_http_status, p_latency_ms);
  return query select 'noted'::text;
end $$;
revoke all on function projects.log_integration_check(uuid, text, int, int) from public, anon, authenticated;
grant execute on function projects.log_integration_check(uuid, text, int, int) to service_role;

-- the existing door keeps its signature and its answers; what it noted is now also a fact in the log
create or replace function projects.note_integration_check(p_connection_id uuid, p_class text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
begin
  return query select o.outcome from projects.log_integration_check(p_connection_id, p_class, null, null) o;
end $$;
revoke all on function projects.note_integration_check(uuid, text) from public, anon, authenticated;
grant execute on function projects.note_integration_check(uuid, text) to service_role;

-- staff read: per integration, the last success, the last failure class and the error rate over the last N checks (counted checks are returned,
-- so "0% of 1" is never mistaken for "0% of 50"). 'no_target' and 'credential_missing' are not a provider's failure: nothing was asked of it.
create or replace function projects.integration_observability(p_project_id uuid, p_last int default 20)
returns table (connection_id uuid, name text, health text, checks_counted int, error_rate numeric, last_success_at timestamptz, last_failure_class text, last_failure_at timestamptz, avg_latency_ms int)
language sql stable set search_path = '' as $$
  select c.id, c.name, c.health,
         coalesce(w.n, 0)::int,
         case when coalesce(w.n, 0) = 0 then null else round(w.errors::numeric / w.n, 3) end,
         (select max(l.checked_at) from projects.integration_check_log l where l.connection_id = c.id and l.check_class = 'ok'),
         (select l.check_class from projects.integration_check_log l where l.connection_id = c.id and l.check_class not in ('ok', 'no_target', 'credential_missing') order by l.checked_at desc limit 1),
         (select max(l.checked_at) from projects.integration_check_log l where l.connection_id = c.id and l.check_class not in ('ok', 'no_target', 'credential_missing')),
         w.avg_latency::int
    from projects.integration_connections c
    left join lateral (
      select count(*) as n, count(*) filter (where r.check_class <> 'ok') as errors, avg(r.latency_ms) as avg_latency
        from (select l.check_class, l.latency_ms from projects.integration_check_log l
               where l.connection_id = c.id and l.check_class not in ('no_target', 'credential_missing')
               order by l.checked_at desc limit greatest(coalesce(p_last, 20), 1)) r
    ) w on true
   where c.project_id = p_project_id
   order by c.name
$$;
revoke all on function projects.integration_observability(uuid, int) from public, anon;
grant execute on function projects.integration_observability(uuid, int) to authenticated, service_role;

-- ── 2. what depends on what ──────────────────────────────────────────────
create table if not exists projects.task_integration_dependencies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,
  connection_id    uuid not null references projects.integration_connections(id) on delete cascade,
  -- set while THIS dependency is why the task is held; held_prev_status is what the task was before we blocked it (null: it was already blocked)
  held             boolean not null default false,
  held_prev_status text check (held_prev_status is null or held_prev_status in ('todo', 'in_progress', 'in_review')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (task_id, connection_id),
  check (held or held_prev_status is null)
);
create index if not exists task_integration_dependencies_conn_idx on projects.task_integration_dependencies (connection_id);
alter table projects.task_integration_dependencies enable row level security;
drop policy if exists task_integration_dependencies_read on projects.task_integration_dependencies;
create policy task_integration_dependencies_read on projects.task_integration_dependencies for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.task_integration_dependencies from public, anon;
revoke insert, update, delete on projects.task_integration_dependencies from authenticated;
grant select on projects.task_integration_dependencies to authenticated;
grant all on projects.task_integration_dependencies to service_role;
create trigger task_integration_dependencies_parent_org_project before insert or update of project_id on projects.task_integration_dependencies
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger task_integration_dependencies_parent_org_task before insert or update of task_id on projects.task_integration_dependencies
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');
create trigger task_integration_dependencies_parent_org_connection before insert or update of connection_id on projects.task_integration_dependencies
  for each row execute function core.enforce_parent_org('connection_id', 'projects.integration_connections');
create trigger freeze_org_task_integration_dependencies before update of organization_id on projects.task_integration_dependencies
  for each row execute function core.freeze_organization_id();

-- Brings every task that depends on ONE connection in line with that connection's health. Idempotent; called by the health trigger and by the doors.
--   degraded / blocked : each dependent task that is todo / in_progress / in_review becomes BLOCKED (external_service), remembering what it was
--   verified           : each dependent task this connection was holding resumes - unless another degraded/blocked integration still holds it
-- A task that was in review resumes as in_progress: a task enters review only from in progress, with its hand-off, so blocked -> in_review is not a move
-- the board allows; the work is looked at again once the integration is back.
-- Only rows in task_integration_dependencies for THIS connection are ever touched.
create or replace function projects.sync_integration_dependents(p_connection_id uuid)
returns table (blocked int, resumed int)
language plpgsql security definer set search_path = '' as $$
declare
  v_conn projects.integration_connections; d record; v_task projects.tasks;
  v_blocked int := 0; v_resumed int := 0; v_prev text; v_other uuid;
begin
  select * into v_conn from projects.integration_connections c where c.id = p_connection_id;
  if v_conn.id is null then return query select 0, 0; return; end if;
  if v_conn.health in ('degraded', 'blocked') then
    for d in select * from projects.task_integration_dependencies x where x.connection_id = v_conn.id and not x.held for update loop
      select * into v_task from projects.tasks t where t.id = d.task_id for update;
      if v_task.id is null then continue; end if;
      if v_task.status in ('todo', 'in_progress', 'in_review') then
        update projects.tasks
           set status = 'blocked', blocked_reason = left(format('%s is %s: this task depends on it', v_conn.name, v_conn.health), 500),
               blocker_type = 'external_service', blocker_owner = 'integration owner', blocker_next_action = format('Re-verify %s; the task resumes by itself', v_conn.name)
         where id = v_task.id;
        update projects.task_integration_dependencies set held = true, held_prev_status = v_task.status where id = d.id;
        v_blocked := v_blocked + 1;
      else
        -- already blocked (or finished): note the hold without changing the task
        update projects.task_integration_dependencies set held = true, held_prev_status = null where id = d.id;
      end if;
    end loop;
  elsif v_conn.health = 'verified' then
    for d in select * from projects.task_integration_dependencies x where x.connection_id = v_conn.id and x.held for update loop
      v_prev := d.held_prev_status;
      update projects.task_integration_dependencies set held = false, held_prev_status = null where id = d.id;
      if v_prev is null then continue; end if;
      -- another integration that still holds this task inherits the "what it was before" and the task stays blocked
      select o.id into v_other from projects.task_integration_dependencies o join projects.integration_connections oc on oc.id = o.connection_id
       where o.task_id = d.task_id and o.id <> d.id and o.held and oc.health in ('degraded', 'blocked') order by o.created_at limit 1;
      if v_other is not null then
        update projects.task_integration_dependencies set held_prev_status = v_prev where id = v_other;
      else
        update projects.tasks set status = (case v_prev when 'in_review' then 'in_progress' else v_prev end) where id = d.task_id and status = 'blocked';
        if found then v_resumed := v_resumed + 1; end if;
      end if;
    end loop;
  end if;
  return query select v_blocked, v_resumed;
end $$;
revoke all on function projects.sync_integration_dependents(uuid) from public, anon, authenticated;
grant execute on function projects.sync_integration_dependents(uuid) to service_role;

-- health moves only through the integration doors; whichever door moved it, its dependents follow
create or replace function projects.integration_health_follows() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform projects.sync_integration_dependents(new.id);
  return null;
end $$;
revoke all on function projects.integration_health_follows() from public, anon, authenticated;
drop trigger if exists integration_health_follows on projects.integration_connections;
create trigger integration_health_follows after update of health on projects.integration_connections
  for each row when (old.health is distinct from new.health) execute function projects.integration_health_follows();

-- staff (or the runner) declare that a task cannot work without an integration; a dependency on an integration that is ALREADY degraded takes effect now
create or replace function projects.depend_task_on_integration(p_task_id uuid, p_connection_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_task projects.tasks; v_conn projects.integration_connections; v_id uuid;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text; return; end if;
  if v_actor is not null and not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_task from projects.tasks t where t.id = p_task_id;
  select * into v_conn from projects.integration_connections c where c.id = p_connection_id;
  if v_task.id is null or v_conn.id is null or (v_actor is not null and v_task.organization_id is distinct from (select core.current_organization_id())) then
    return query select 'not_found'::text; return;
  end if;
  if v_task.organization_id <> v_conn.organization_id or v_task.project_id <> v_conn.project_id then return query select 'wrong_project'::text; return; end if;
  insert into projects.task_integration_dependencies (organization_id, project_id, task_id, connection_id, created_by)
  values (v_task.organization_id, v_task.project_id, v_task.id, v_conn.id, v_actor)
  on conflict (task_id, connection_id) do nothing returning id into v_id;
  if v_id is null then return query select 'already_depends'::text; return; end if;
  perform projects.sync_integration_dependents(v_conn.id);
  return query select 'recorded'::text;
end $$;
revoke all on function projects.depend_task_on_integration(uuid, uuid) from public, anon;
grant execute on function projects.depend_task_on_integration(uuid, uuid) to authenticated, service_role;

-- removing a dependency releases what it was holding
create or replace function projects.release_task_integration_dependency(p_task_id uuid, p_connection_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_dep projects.task_integration_dependencies; v_other uuid;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text; return; end if;
  if v_actor is not null and not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_dep from projects.task_integration_dependencies x where x.task_id = p_task_id and x.connection_id = p_connection_id for update;
  if v_dep.id is null or (v_actor is not null and v_dep.organization_id is distinct from (select core.current_organization_id())) then return query select 'not_found'::text; return; end if;
  delete from projects.task_integration_dependencies where id = v_dep.id;
  if v_dep.held and v_dep.held_prev_status is not null then
    select o.id into v_other from projects.task_integration_dependencies o join projects.integration_connections oc on oc.id = o.connection_id
     where o.task_id = v_dep.task_id and o.held and oc.health in ('degraded', 'blocked') order by o.created_at limit 1;
    if v_other is not null then
      update projects.task_integration_dependencies set held_prev_status = v_dep.held_prev_status where id = v_other;
    else
      update projects.tasks set status = (case v_dep.held_prev_status when 'in_review' then 'in_progress' else v_dep.held_prev_status end) where id = v_dep.task_id and status = 'blocked';
    end if;
  end if;
  return query select 'released'::text;
end $$;
revoke all on function projects.release_task_integration_dependency(uuid, uuid) from public, anon;
grant execute on function projects.release_task_integration_dependency(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
