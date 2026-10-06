-- Orchestrator depth (Phase 5 Orchestrator spec 7, 14, 26): concurrency leases with an overlap check in the database, and a refused tool dispatch
-- written to the audit log through a service-role door.
--
-- A lease is a claim on a set of file paths for one task by one agent. A second ACTIVE lease on the same project that overlaps those paths is refused
-- unless the two tasks are sequenced through projects.task_dependencies (one waits for the other, directly or through a chain). The overlap rule lives
-- here, in one function, so the claim door and the verifier can not disagree about what "the same files" means. src/modules/orchestrator/conflicts.ts
-- mirrors it for planning; a test holds the two lists of high-conflict paths equal.

-- ── the paths that are serialised unless proven safe ─────────────────────────
-- Shared schema, central configuration, auth middleware, the lockfile, the event catalog and the agent registry: two agents editing a file UNDER one
-- of these conflict even when their file names differ (two new migrations are two new files and one migration sequence).
create or replace function projects.high_conflict_paths()
returns text[] language sql immutable set search_path = '' as $$
  select array[
    'supabase/migrations', 'supabase/seed.sql', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'proxy.ts',
    'src/lib/db/types.ts', 'src/lib/events/catalog.ts', 'src/modules/agents/registry.ts', 'src/lib/auth', '.github/workflows'
  ]::text[]
$$;
revoke all on function projects.high_conflict_paths() from public, anon;
grant execute on function projects.high_conflict_paths() to authenticated, service_role;

-- One path to the directory-or-file key two leases are compared on. A glob is cut at its first wildcard segment (so `src/ui/**` and `src/ui/*.tsx`
-- both mean `src/ui`: broader is the safe error), the whole repository is the empty key, and anything under a high-conflict path IS that path.
create or replace function projects.lease_scope_key(p_path text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v_clean text := regexp_replace(btrim(replace(coalesce(p_path, ''), E'\\', '/')), '^(\./|/)+', '');
  v_segment text;
  v_key text := '';
  v_hc text;
begin
  foreach v_segment in array string_to_array(v_clean, '/') loop
    exit when v_segment ~ '[*?\[{]';
    continue when v_segment = '' or v_segment = '.';
    v_key := case when v_key = '' then v_segment else v_key || '/' || v_segment end;
  end loop;
  foreach v_hc in array projects.high_conflict_paths() loop
    if v_key = v_hc or left(v_key, length(v_hc) + 1) = v_hc || '/' then return v_hc; end if;
  end loop;
  return v_key;
end $$;
revoke all on function projects.lease_scope_key(text) from public, anon;
grant execute on function projects.lease_scope_key(text) to authenticated, service_role;

create or replace function projects.lease_scopes_overlap(p_a text[], p_b text[])
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1
      from unnest(p_a) as a(path), unnest(p_b) as b(path),
           lateral (select projects.lease_scope_key(a.path) as ka, projects.lease_scope_key(b.path) as kb) k
     where k.ka = '' or k.kb = '' or k.ka = k.kb
        or left(k.ka, length(k.kb) + 1) = k.kb || '/'
        or left(k.kb, length(k.ka) + 1) = k.ka || '/'
  )
$$;
revoke all on function projects.lease_scopes_overlap(text[], text[]) from public, anon;
grant execute on function projects.lease_scopes_overlap(text[], text[]) to authenticated, service_role;

-- ── the lease ───────────────────────────────────────────────────────────────
create table if not exists projects.concurrency_leases (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,
  agent_key        text not null check (length(btrim(agent_key)) > 0 and length(agent_key) <= 80),
  file_scope       text[] not null check (cardinality(file_scope) >= 1),
  state            text not null default 'active' check (state in ('active', 'released', 'expired')),
  claimed_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  released_at      timestamptz,
  release_reason   text check (release_reason is null or length(release_reason) <= 300),
  check (expires_at > claimed_at),
  check ((state = 'active' and released_at is null) or (state <> 'active' and released_at is not null))
);
comment on table projects.concurrency_leases is
  'Orchestrator spec 7: one primary agent per task and no two agents on the same files. Written only through projects.claim_concurrency_lease / release_concurrency_lease / expire_concurrency_leases (service role).';

-- one primary agent per task, enforced by the table and not by a caller remembering to look
create unique index if not exists concurrency_leases_one_active_per_task on projects.concurrency_leases (task_id) where state = 'active';
create index if not exists concurrency_leases_project_active_idx on projects.concurrency_leases (project_id) where state = 'active';
create index if not exists concurrency_leases_org_idx on projects.concurrency_leases (organization_id, claimed_at desc);

alter table projects.concurrency_leases enable row level security;
alter table projects.concurrency_leases force row level security;
drop policy if exists concurrency_leases_read on projects.concurrency_leases;
create policy concurrency_leases_read on projects.concurrency_leases for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.concurrency_leases from public, anon;
revoke insert, update, delete on projects.concurrency_leases from authenticated;
grant select on projects.concurrency_leases to authenticated;
grant all on projects.concurrency_leases to service_role;

drop trigger if exists concurrency_leases_parent_org_project on projects.concurrency_leases;
create trigger concurrency_leases_parent_org_project before insert or update of project_id on projects.concurrency_leases
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists concurrency_leases_parent_org_task on projects.concurrency_leases;
create trigger concurrency_leases_parent_org_task before insert or update of task_id on projects.concurrency_leases
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');
drop trigger if exists freeze_org_concurrency_leases on projects.concurrency_leases;
create trigger freeze_org_concurrency_leases before update of organization_id on projects.concurrency_leases
  for each row execute function core.freeze_organization_id();

-- what a lease claimed is never rewritten, and a lease that ended never comes back: only active -> released | expired
create or replace function projects.concurrency_leases_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.state <> 'active' then
    raise exception 'a lease that has ended is history and is not reopened' using errcode = 'restrict_violation';
  end if;
  if new.project_id is distinct from old.project_id or new.task_id is distinct from old.task_id or new.agent_key is distinct from old.agent_key
     or new.file_scope is distinct from old.file_scope or new.claimed_at is distinct from old.claimed_at then
    raise exception 'a lease''s task, agent and files are fixed when it is claimed' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists concurrency_leases_guard on projects.concurrency_leases;
create trigger concurrency_leases_guard before update on projects.concurrency_leases
  for each row execute function projects.concurrency_leases_guard();

-- ── claim ───────────────────────────────────────────────────────────────────
create or replace function projects.claim_concurrency_lease(p_task_id uuid, p_agent_key text, p_file_scope text[], p_ttl_minutes integer default 60)
returns table (outcome text, lease_id uuid, conflicting_lease_id uuid, conflicting_task_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_task projects.tasks;
  v_existing uuid;
  v_conflict record;
  v_new uuid;
  v_path text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid, null::uuid, null::uuid; return; end if;
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then return query select 'not_found'::text, null::uuid, null::uuid, null::uuid; return; end if;
  if p_agent_key is null or length(btrim(p_agent_key)) = 0 or length(p_agent_key) > 80
     or p_file_scope is null or cardinality(p_file_scope) = 0 or p_ttl_minutes is null or p_ttl_minutes < 1 or p_ttl_minutes > 1440 then
    return query select 'bad_input'::text, null::uuid, null::uuid, null::uuid; return;
  end if;
  foreach v_path in array p_file_scope loop
    -- a path that climbs out of the repository, or an empty one, is not a scope
    if v_path is null or length(btrim(v_path)) = 0 or v_path ~ '(^|[/\\])\.\.([/\\]|$)' then
      return query select 'bad_input'::text, null::uuid, null::uuid, null::uuid; return;
    end if;
  end loop;

  -- Claims on one project are taken one at a time: two workers claiming overlapping paths in the same instant must not both see "no conflict".
  perform pg_advisory_xact_lock(hashtextextended('concurrency_lease:' || v_task.project_id::text, 0));

  -- a lease nobody released and nobody renewed does not hold files forever
  update projects.concurrency_leases l set state = 'expired', released_at = now(), release_reason = 'expired before this claim'
   where l.project_id = v_task.project_id and l.state = 'active' and l.expires_at <= now();

  select l.id into v_existing from projects.concurrency_leases l where l.task_id = v_task.id and l.state = 'active';
  if v_existing is not null then return query select 'already_leased'::text, v_existing, null::uuid, null::uuid; return; end if;

  select l.id as lease_id, l.task_id as task_id into v_conflict
    from projects.concurrency_leases l
   where l.project_id = v_task.project_id and l.state = 'active' and l.task_id <> v_task.id
     and projects.lease_scopes_overlap(l.file_scope, p_file_scope)
     -- Sequenced work may share files: one of the two tasks waits for the other, directly or through a chain, so they never run at once.
     and not exists (
       with recursive up(id) as (
         select d.depends_on_task_id from projects.task_dependencies d where d.task_id = v_task.id
         union select d.depends_on_task_id from projects.task_dependencies d join up on d.task_id = up.id
       ), down(id) as (
         select d.task_id from projects.task_dependencies d where d.depends_on_task_id = v_task.id
         union select d.task_id from projects.task_dependencies d join down on d.depends_on_task_id = down.id
       )
       select 1 where l.task_id in (select id from up) or l.task_id in (select id from down)
     )
   order by l.claimed_at limit 1;
  if v_conflict.lease_id is not null then
    return query select 'conflict'::text, null::uuid, v_conflict.lease_id, v_conflict.task_id; return;
  end if;

  insert into projects.concurrency_leases (organization_id, project_id, task_id, agent_key, file_scope, expires_at)
  values (v_task.organization_id, v_task.project_id, v_task.id, btrim(p_agent_key), p_file_scope, now() + make_interval(mins => p_ttl_minutes))
  returning id into v_new;
  perform core.record_audit(v_task.organization_id, 'orchestrator.lease_claimed', 'concurrency_lease', v_new, null,
                            jsonb_build_object('task_id', v_task.id, 'agent_key', btrim(p_agent_key), 'file_scope', to_jsonb(p_file_scope)));
  return query select 'claimed'::text, v_new, null::uuid, null::uuid;
end $$;
revoke all on function projects.claim_concurrency_lease(uuid, text, text[], integer) from public, anon, authenticated;
grant execute on function projects.claim_concurrency_lease(uuid, text, text[], integer) to service_role;

-- ── release ─────────────────────────────────────────────────────────────────
create or replace function projects.release_concurrency_lease(p_lease_id uuid, p_reason text default 'completed')
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_lease projects.concurrency_leases;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  select * into v_lease from projects.concurrency_leases l where l.id = p_lease_id for update;
  if v_lease.id is null then return query select 'not_found'::text; return; end if;
  if v_lease.state <> 'active' then return query select 'not_active'::text; return; end if;
  update projects.concurrency_leases set state = 'released', released_at = now(), release_reason = left(coalesce(nullif(btrim(p_reason), ''), 'released'), 300)
   where id = v_lease.id;
  perform core.record_audit(v_lease.organization_id, 'orchestrator.lease_released', 'concurrency_lease', v_lease.id, null,
                            jsonb_build_object('task_id', v_lease.task_id, 'reason', left(coalesce(p_reason, ''), 300)));
  return query select 'released'::text;
end $$;
revoke all on function projects.release_concurrency_lease(uuid, text) from public, anon, authenticated;
grant execute on function projects.release_concurrency_lease(uuid, text) to service_role;

-- ── expiry sweep: a worker that crashed holding files must not hold them forever (OR5-T035) ──
create or replace function projects.expire_concurrency_leases(p_project_id uuid default null)
returns table (expired integer)
language plpgsql security definer set search_path = '' as $$
declare v_row record; v_count integer := 0;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select -1; return; end if;
  for v_row in
    update projects.concurrency_leases l set state = 'expired', released_at = now(), release_reason = 'expired'
     where l.state = 'active' and l.expires_at <= now() and (p_project_id is null or l.project_id = p_project_id)
    returning l.id, l.organization_id, l.task_id
  loop
    v_count := v_count + 1;
    perform core.record_audit(v_row.organization_id, 'orchestrator.lease_expired', 'concurrency_lease', v_row.id, null, jsonb_build_object('task_id', v_row.task_id));
  end loop;
  return query select v_count;
end $$;
revoke all on function projects.expire_concurrency_leases(uuid) from public, anon, authenticated;
grant execute on function projects.expire_concurrency_leases(uuid) to service_role;

-- ── a refused tool dispatch is audited (Orchestrator spec 14) ───────────────
-- The gate itself is pure TypeScript (src/modules/orchestrator/tool-dispatch.ts). This is the one place a denial is written down: argument NAMES
-- only, never values, because a refused call may carry exactly the secret that was the reason it was refused.
create or replace function projects.record_tool_dispatch_denial(p_project_id uuid, p_agent_key text, p_tool text, p_code text, p_detail text default null, p_arg_keys text[] default '{}')
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  if p_code is null or p_code not in ('unknown_agent', 'unknown_tool', 'tool_not_bound', 'invalid_args', 'out_of_scope', 'write_not_permitted', 'approval_required') then
    return query select 'bad_code'::text; return;
  end if;
  if p_agent_key is null or length(btrim(p_agent_key)) = 0 or p_tool is null or length(btrim(p_tool)) = 0 then return query select 'bad_input'::text; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null then return query select 'not_found'::text; return; end if;
  perform core.record_audit(v_org, 'orchestrator.tool_dispatch_denied', 'tool_dispatch', p_project_id, null,
                            jsonb_build_object('agent', left(p_agent_key, 80), 'tool', left(p_tool, 80), 'code', p_code, 'detail', left(coalesce(p_detail, ''), 300),
                                               'arg_keys', to_jsonb(coalesce(p_arg_keys, '{}'::text[]))));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_tool_dispatch_denial(uuid, text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function projects.record_tool_dispatch_denial(uuid, text, text, text, text, text[]) to service_role;

notify pgrst, 'reload schema';
