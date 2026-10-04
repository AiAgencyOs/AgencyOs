-- The Figma plugin reports back what it built.
--
-- AgencyOS cannot create nodes in Figma (the REST API reads and comments only). A small plugin the Admin runs inside Figma pulls a
-- project's finalized screens and selected direction from AgencyOS, builds wireframe frames in the open file, and POSTs one report:
-- which file, which page, which frames (named by screen key). This table is that report's history. It links NOTHING by itself - a
-- person still links a frame to a screen or a theme through the existing, verified flow (`link_theme_figma`, which asks Figma that
-- the node exists) - so "Figma is the source of truth" is never asserted on the strength of a plugin's say-so.

create table if not exists projects.figma_plugin_imports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  file_key        text check (file_key is null or file_key ~ '^[A-Za-z0-9_-]{5,64}$'),
  page_id         text check (page_id is null or length(page_id) <= 40),
  page_name       text check (page_name is null or length(page_name) <= 200),
  -- [{key, screenId, name, nodeId}] - what was created, nothing else.
  frames          jsonb not null check (jsonb_typeof(frames) = 'array' and jsonb_array_length(frames) between 1 and 400),
  created_at      timestamptz not null default now()
);

comment on table projects.figma_plugin_imports is
  'One row per run of the AgencyOS Figma plugin: the file, the page and the frames it created. A record of what was built - it links no screen or theme to Figma; a person does that through link_theme_figma.';

create index if not exists figma_plugin_imports_project_idx on projects.figma_plugin_imports (project_id, created_at desc);

alter table projects.figma_plugin_imports enable row level security;
alter table projects.figma_plugin_imports force row level security;
drop policy if exists figma_plugin_imports_internal_read on projects.figma_plugin_imports;
create policy figma_plugin_imports_internal_read on projects.figma_plugin_imports for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.figma_plugin_imports from public, anon, authenticated;
grant select on projects.figma_plugin_imports to authenticated;
grant select, insert on projects.figma_plugin_imports to service_role;

drop trigger if exists freeze_org_figma_plugin_imports on projects.figma_plugin_imports;
create trigger freeze_org_figma_plugin_imports before update of organization_id on projects.figma_plugin_imports for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_figma_plugin_import_project on projects.figma_plugin_imports;
create trigger org_match_figma_plugin_import_project before insert or update of project_id, organization_id on projects.figma_plugin_imports
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

create or replace function projects.figma_plugin_imports_are_history()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from core.organizations where id = old.organization_id) then
    return old;
  end if;
  raise exception 'a Figma import record is history and cannot be edited or removed' using errcode = 'P0001';
end;
$$;
drop trigger if exists figma_plugin_imports_are_history on projects.figma_plugin_imports;
create trigger figma_plugin_imports_are_history before update or delete on projects.figma_plugin_imports for each row execute function projects.figma_plugin_imports_are_history();

-- The one writer (service role: the plugin has no user session, only a signed, expiring, project-scoped code).
create or replace function projects.record_figma_import(
  p_organization_id uuid, p_project_id uuid, p_file_key text, p_page_id text, p_page_name text, p_frames jsonb
)
returns table (outcome text, import_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = p_organization_id) then
    return query select 'unknown_project'::text, null::uuid; return;
  end if;
  if p_frames is null or jsonb_typeof(p_frames) <> 'array' or jsonb_array_length(p_frames) not between 1 and 400 then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  if p_file_key is not null and p_file_key !~ '^[A-Za-z0-9_-]{5,64}$' then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  insert into projects.figma_plugin_imports (organization_id, project_id, file_key, page_id, page_name, frames)
  values (p_organization_id, p_project_id, p_file_key, left(p_page_id, 40), left(p_page_name, 200), p_frames)
  returning id into v_id;
  perform core.record_audit(p_organization_id, 'figma_plugin.imported', 'project', p_project_id, null,
    jsonb_build_object('import', v_id, 'frames', jsonb_array_length(p_frames), 'file_key', p_file_key));
  return query select 'recorded'::text, v_id;
end;
$$;
revoke all on function projects.record_figma_import(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function projects.record_figma_import(uuid, uuid, text, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
