-- ═══════════════════════════════════════════════════════════════════════════
-- A project has folders that exist before a file is in them.
--
-- Owner decision 7 (2026-10-03): "New Folder" — folders become real records,
-- so an EMPTY folder exists. Until now a folder was only a text path on a file
-- (projects.project_files.folder, inside a category); it vanished when its last
-- file left.
--
--   projects.project_folders   (project, category, path) — unique; path is the
--                              same shape the file column already enforces
--                              (no leading/trailing slash, no "//", no "..",
--                              ≤ 200 characters)
--
-- Filing a file into a folder stays the file's own `folder` column (edit_file
-- already writes it); a trigger now makes sure that a folder a file names —
-- and every ancestor of it — is a folder record, so the two never disagree.
-- Existing folders are backfilled.
--
-- projects.project_folders has NO write policy and NO write grant for
-- authenticated. The doors (security definer, role re-checked, audited):
--
--   projects.create_project_folder(project, category, path)
--   projects.file_into_folder(file, path | '')   — moves a file into an existing
--                                                  folder of its own category
--                                                  ('' = the category root)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.project_folders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  category        text not null check (category in ('requirements', 'design', 'development', 'qa', 'deployment', 'marketing', 'documents', 'assets', 'builds', 'other')),
  path            text not null check (char_length(path) between 1 and 200 and path !~ '(^/|/$|//|\.\.)'),
  created_by      uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (project_id, category, path)
);

comment on table projects.project_folders is
  'A folder of a project inside one file category, as a record — so an empty folder exists. No write policy and no write grant for authenticated: every path in is projects.create_project_folder (or the file trigger that keeps a named folder real).';

create index if not exists project_folders_project_idx on projects.project_folders (project_id, category, path);
create index if not exists project_folders_organization_idx on projects.project_folders (organization_id, project_id);

alter table projects.project_folders enable row level security;
alter table projects.project_folders force row level security;

drop policy if exists project_folders_select on projects.project_folders;
create policy project_folders_select on projects.project_folders
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

revoke all on table projects.project_folders from public, anon, authenticated;
grant select on table projects.project_folders to authenticated;
grant select, insert, update, delete on table projects.project_folders to service_role;

drop trigger if exists org_match_project_folders_project on projects.project_folders;
create trigger org_match_project_folders_project
  before insert or update of project_id, organization_id on projects.project_folders
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_project_folders on projects.project_folders;
create trigger freeze_org_project_folders
  before update of organization_id on projects.project_folders
  for each row execute function core.freeze_organization_id();

-- Every folder a path names: "a/b/c" → a, a/b, a/b/c.
create or replace function projects.ensure_folder_path(p_org uuid, p_project uuid, p_category text, p_path text, p_actor uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(p_path, '/');
  v_acc   text;
  i       integer;
begin
  if p_path is null or p_path = '' then
    return;
  end if;
  for i in 1 .. cardinality(v_parts) loop
    v_acc := array_to_string(v_parts[1:i], '/');
    insert into projects.project_folders (organization_id, project_id, category, path, created_by)
    values (p_org, p_project, p_category, v_acc, p_actor)
    on conflict (project_id, category, path) do nothing;
  end loop;
end;
$$;

revoke all on function projects.ensure_folder_path(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function projects.ensure_folder_path(uuid, uuid, text, text, uuid) to service_role;

-- Backfill: the folders files already name.
do $$
declare
  r record;
begin
  for r in select distinct organization_id, project_id, category, folder from projects.project_files where folder <> '' loop
    perform projects.ensure_folder_path(r.organization_id, r.project_id, r.category, r.folder, null);
  end loop;
end
$$;

create or replace function projects.project_files_keep_folder_real()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Security definer: the writer of a file has no grant on project_folders; the
  -- folder written is only the one the (already policy-checked) row names.
  if new.folder <> '' then
    perform projects.ensure_folder_path(new.organization_id, new.project_id, new.category, new.folder, null);
  end if;
  return new;
end;
$$;

drop trigger if exists project_files_keep_folder_real on projects.project_files;
create trigger project_files_keep_folder_real
  after insert or update of folder, category on projects.project_files
  for each row execute function projects.project_files_keep_folder_real();

create or replace function projects.create_project_folder(p_project_id uuid, p_category text, p_path text)
returns table (outcome text, folder_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_path  text := btrim(coalesce(p_path, ''));
  v_id    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null) then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if p_category is null or p_category not in ('requirements', 'design', 'development', 'qa', 'deployment', 'marketing', 'documents', 'assets', 'builds', 'other') then
    return query select 'invalid_category'::text, null::uuid; return;
  end if;
  if char_length(v_path) < 1 or char_length(v_path) > 200 or v_path ~ '(^/|/$|//|\.\.)' then
    return query select 'invalid_path'::text, null::uuid; return;
  end if;
  if exists (select 1 from projects.project_folders f where f.project_id = p_project_id and f.category = p_category and lower(f.path) = lower(v_path)) then
    return query select 'exists'::text, null::uuid; return;
  end if;

  perform projects.ensure_folder_path(v_org, p_project_id, p_category, v_path, v_actor);
  select f.id into v_id from projects.project_folders f where f.project_id = p_project_id and f.category = p_category and f.path = v_path;

  perform core.record_audit(
    v_org, 'project.folder_created', 'project_folder', v_id,
    null, jsonb_build_object('projectId', p_project_id, 'category', p_category, 'path', v_path)
  );
  return query select 'created'::text, v_id;
end;
$$;

comment on function projects.create_project_folder(uuid, text, text) is
  'Creates a folder (and any ancestor it names) inside one file category of a project. Any task.write role of the same organisation; refused exists for a path already there (case-insensitively); audited project.folder_created.';

revoke all on function projects.create_project_folder(uuid, text, text) from public, anon;
grant execute on function projects.create_project_folder(uuid, text, text) to authenticated, service_role;

create or replace function projects.file_into_folder(p_file_id uuid, p_path text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_path  text := btrim(coalesce(p_path, ''));
  v_file  projects.project_files;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_file from projects.project_files f where f.id = p_file_id and f.organization_id = v_org for update;
  if v_file.id is null or v_file.deleted_at is not null then
    return query select 'not_found'::text; return;
  end if;
  if v_path <> '' and not exists (
       select 1 from projects.project_folders f
        where f.project_id = v_file.project_id and f.category = v_file.category and f.path = v_path) then
    return query select 'no_such_folder'::text; return;
  end if;
  if v_file.folder = v_path then
    return query select 'unchanged'::text; return;
  end if;

  update projects.project_files set folder = v_path where id = p_file_id;

  perform core.record_audit(
    v_org, 'file.filed', 'project_file', p_file_id,
    jsonb_build_object('folder', v_file.folder),
    jsonb_build_object('folder', v_path, 'projectId', v_file.project_id)
  );
  return query select 'filed'::text;
end;
$$;

comment on function projects.file_into_folder(uuid, text) is
  'Files a file into an existing folder of its own category (or, with an empty path, the category root). Any task.write role of the same organisation; audited file.filed.';

revoke all on function projects.file_into_folder(uuid, text) from public, anon;
grant execute on function projects.file_into_folder(uuid, text) to authenticated, service_role;
