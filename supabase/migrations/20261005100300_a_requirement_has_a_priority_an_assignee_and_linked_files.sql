-- ═══════════════════════════════════════════════════════════════════════════
-- A requirement has a priority, an assignee and linked files — after the scope
-- is frozen.
--
-- Owner decisions 5 and 6 (2026-10-03). A requirement is a projects.scope_items
-- row; once its scope version is frozen the wording NEVER changes
-- (projects.refuse_frozen_scope_item). Priority and assignee are day-to-day
-- planning facts, so they live in their OWN table and are editable at any time
-- without touching a frozen row:
--
--   projects.scope_item_plans   one row per requirement: priority High/Medium/
--                               Low (null = not set) and an assignee (an active
--                               member of the organisation, null = nobody)
--   projects.scope_item_files   the attachments: LINKS to files the project
--                               already holds (projects.project_files). Nothing
--                               is uploaded here; unlinking deletes the link,
--                               never the file.
--
-- Neither table has a write policy or a write grant for authenticated. The
-- doors (security definer, role re-checked, audited):
--
--   projects.set_requirement_plan(scope_item, priority, assignee)
--   projects.link_requirement_file(scope_item, file)
--   projects.unlink_requirement_file(scope_item, file)
--
-- A file can be linked only if it belongs to the SAME project as the
-- requirement and is not in the trash.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.scope_item_plans (
  scope_item_id   uuid primary key references projects.scope_items(id) on delete cascade,
  organization_id uuid not null references core.organizations(id) on delete cascade,
  priority        text check (priority is null or priority in ('high', 'medium', 'low')),
  assignee_id     uuid references core.users(id) on delete set null,
  updated_by      uuid references core.users(id) on delete set null,
  updated_at      timestamptz not null default now()
);

comment on table projects.scope_item_plans is
  'The priority and assignee of a requirement (a scope item), kept apart from the frozen scope row so they stay editable after the scope is frozen. No write policy and no write grant for authenticated: every path in is projects.set_requirement_plan.';

create index if not exists scope_item_plans_organization_idx on projects.scope_item_plans (organization_id, assignee_id);

create table if not exists projects.scope_item_files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  scope_item_id   uuid not null references projects.scope_items(id) on delete cascade,
  file_id         uuid not null references projects.project_files(id) on delete cascade,
  linked_by       uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (scope_item_id, file_id)
);

comment on table projects.scope_item_files is
  'A requirement''s attachments: links to files the project already holds. No write policy and no write grant for authenticated: every path in is projects.link_requirement_file / unlink_requirement_file.';

create index if not exists scope_item_files_file_idx on projects.scope_item_files (file_id);
create index if not exists scope_item_files_organization_idx on projects.scope_item_files (organization_id, scope_item_id);

do $$
declare
  t text;
begin
  foreach t in array array['scope_item_plans', 'scope_item_files'] loop
    execute format('alter table projects.%I enable row level security', t);
    execute format('alter table projects.%I force row level security', t);
    execute format('drop policy if exists %I on projects.%I', t || '_select', t);
    execute format(
      'create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))',
      t || '_select', t);
    execute format('revoke all on table projects.%I from public, anon, authenticated', t);
    execute format('grant select on table projects.%I to authenticated', t);
    execute format('grant select, insert, update, delete on table projects.%I to service_role', t);
    execute format('drop trigger if exists freeze_org_%I on projects.%I', t, t);
    execute format('create trigger freeze_org_%I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', t, t);
    execute format('drop trigger if exists org_match_%I_item on projects.%I', t, t);
    execute format(
      'create trigger org_match_%I_item before insert or update of scope_item_id, organization_id on projects.%I for each row execute function core.enforce_parent_org(''scope_item_id'', ''projects.scope_items'')',
      t, t);
  end loop;
end
$$;

drop trigger if exists org_match_scope_item_files_file on projects.scope_item_files;
create trigger org_match_scope_item_files_file
  before insert or update of file_id, organization_id on projects.scope_item_files
  for each row execute function core.enforce_parent_org('file_id', 'projects.project_files');

-- The project a requirement belongs to, through its scope version.
create or replace function projects.scope_item_project(p_scope_item_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sv.project_id
    from projects.scope_items si
    join projects.scope_versions sv on sv.id = si.scope_version_id
   where si.id = p_scope_item_id
     and si.organization_id = (select core.current_organization_id());
$$;

revoke all on function projects.scope_item_project(uuid) from public, anon;
grant execute on function projects.scope_item_project(uuid) to authenticated, service_role;

create or replace function projects.set_requirement_plan(p_scope_item_id uuid, p_priority text, p_assignee_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_priority text := nullif(lower(btrim(coalesce(p_priority, ''))), '');
  v_project  uuid;
  v_before   projects.scope_item_plans;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  v_project := projects.scope_item_project(p_scope_item_id);
  if v_project is null then
    return query select 'not_found'::text; return;
  end if;
  if v_priority is not null and v_priority not in ('high', 'medium', 'low') then
    return query select 'invalid_priority'::text; return;
  end if;
  if p_assignee_id is not null and not exists (
       select 1 from core.memberships m
        where m.organization_id = v_org and m.user_id = p_assignee_id and m.status = 'active') then
    return query select 'invalid_assignee'::text; return;
  end if;

  select * into v_before from projects.scope_item_plans p where p.scope_item_id = p_scope_item_id for update;

  insert into projects.scope_item_plans (scope_item_id, organization_id, priority, assignee_id, updated_by, updated_at)
  values (p_scope_item_id, v_org, v_priority, p_assignee_id, v_actor, now())
  on conflict (scope_item_id) do update
    set priority = excluded.priority, assignee_id = excluded.assignee_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  perform core.record_audit(
    v_org, 'requirement.plan_set', 'scope_item', p_scope_item_id,
    jsonb_build_object('priority', v_before.priority, 'assigneeId', v_before.assignee_id),
    jsonb_build_object('priority', v_priority, 'assigneeId', p_assignee_id, 'projectId', v_project)
  );
  return query select 'set'::text;
end;
$$;

comment on function projects.set_requirement_plan(uuid, text, uuid) is
  'Sets a requirement''s priority (high, medium, low or null) and assignee (an active member or null). Works after the scope is frozen: it never touches the scope row. Any task.write role of the same organisation; audited requirement.plan_set.';

revoke all on function projects.set_requirement_plan(uuid, text, uuid) from public, anon;
grant execute on function projects.set_requirement_plan(uuid, text, uuid) to authenticated, service_role;

create or replace function projects.link_requirement_file(p_scope_item_id uuid, p_file_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_project uuid;
  v_file    projects.project_files;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  v_project := projects.scope_item_project(p_scope_item_id);
  if v_project is null then
    return query select 'not_found'::text; return;
  end if;
  select * into v_file from projects.project_files f where f.id = p_file_id and f.organization_id = v_org;
  if v_file.id is null or v_file.deleted_at is not null then
    return query select 'file_not_found'::text; return;
  end if;
  if v_file.project_id <> v_project then
    return query select 'other_project'::text; return;
  end if;
  if exists (select 1 from projects.scope_item_files l where l.scope_item_id = p_scope_item_id and l.file_id = p_file_id) then
    return query select 'already_linked'::text; return;
  end if;

  insert into projects.scope_item_files (organization_id, scope_item_id, file_id, linked_by)
  values (v_org, p_scope_item_id, p_file_id, v_actor);

  perform core.record_audit(
    v_org, 'requirement.file_linked', 'scope_item', p_scope_item_id,
    null, jsonb_build_object('fileId', p_file_id, 'title', v_file.title, 'projectId', v_project)
  );
  return query select 'linked'::text;
end;
$$;

comment on function projects.link_requirement_file(uuid, uuid) is
  'Links an existing, not-trashed file of the same project to a requirement. Any task.write role of the same organisation; audited requirement.file_linked.';

revoke all on function projects.link_requirement_file(uuid, uuid) from public, anon;
grant execute on function projects.link_requirement_file(uuid, uuid) to authenticated, service_role;

create or replace function projects.unlink_requirement_file(p_scope_item_id uuid, p_file_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_project uuid;
  v_link    projects.scope_item_files;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  v_project := projects.scope_item_project(p_scope_item_id);
  if v_project is null then
    return query select 'not_found'::text; return;
  end if;
  select * into v_link from projects.scope_item_files l
   where l.scope_item_id = p_scope_item_id and l.file_id = p_file_id and l.organization_id = v_org for update;
  if v_link.id is null then
    return query select 'not_linked'::text; return;
  end if;

  delete from projects.scope_item_files where id = v_link.id;

  perform core.record_audit(
    v_org, 'requirement.file_unlinked', 'scope_item', p_scope_item_id,
    jsonb_build_object('fileId', p_file_id, 'projectId', v_project), null
  );
  return query select 'unlinked'::text;
end;
$$;

comment on function projects.unlink_requirement_file(uuid, uuid) is
  'Removes the link between a requirement and a file. The file itself is untouched. Any task.write role of the same organisation; audited requirement.file_unlinked.';

revoke all on function projects.unlink_requirement_file(uuid, uuid) from public, anon;
grant execute on function projects.unlink_requirement_file(uuid, uuid) to authenticated, service_role;
