-- ═══════════════════════════════════════════════════════════════════════════
-- A file has a body, time is written down, and a project becomes a pattern.
--
-- Bucket D, the owner's decisions of 2026-09-29 (AGENT_BRIEF_D.md), stream
-- D2. Four things, one migration:
--
-- 1. FILES MOVE TO SUPABASE STORAGE (decision 5). `projects.project_files`
--    (20260922100000) kept a file as a link because nothing in the stack
--    stored bytes. The owner has decided files live in Supabase Storage, so
--    a row may now carry a `storage_path` (an object in the configured
--    bucket, env SUPABASE_FILES_BUCKET, default `project-files`) INSTEAD OF
--    a `url` — `url` becomes nullable and a CHECK insists on one of the
--    two, so a link-based file keeps working beside an uploaded one. Three
--    more facts a stored file has:
--      versions   — every upload is its own row; a later version points at
--                   the first through `parent_file_id` and carries the next
--                   `version` number. Nothing is overwritten in the bucket.
--      trash      — `deleted_at`/`deleted_by` is a soft delete with a
--                   restore door; the object stays in the bucket until an
--                   owner empties it, which this migration does not build.
--      shares     — `projects.project_file_shares`: a random token, an
--                   expiry, who made it, whether it was revoked. A public
--                   route resolves the token through
--                   `projects.resolve_file_share` (SECURITY DEFINER,
--                   service_role only) and redirects to a short-lived signed
--                   storage URL. The token is the credential; the row says
--                   when it stops being one.
--    The local stack has NO storage service, so the bucket and its
--    `storage.objects` policies are created only where `storage.objects`
--    exists (guarded DO block). The application reads the bucket name from
--    the environment and says plainly when storage is not reachable.
--
-- 2. TIME LOGS (decision 4). `projects.time_logs`: manual hours per task
--    with a date and a note, one row per entry, the person being the one
--    who logged it. Totals per task, per project and per person are the
--    three `security_invoker` views below — reads, so RLS on the base table
--    still decides which rows are counted. No billing effect: nothing here
--    references finance.*, and no rate column exists anywhere in the schema
--    (so the project report's margin can only say time is NOT costed).
--    Doors: add (own), edit own, delete own; owner / ops_admin / delivery
--    lead may delete any (`core.can_manage_delivery()`, the roles holding
--    project.write).
--
-- 3. PROJECT TEMPLATES. Decision: reversed by the owner on 2026-09-29.
--    Earlier passes declined templates as invented structure; the owner has
--    asked for them. `projects.project_templates` holds a NAMED SNAPSHOT of
--    a project's modules, features, milestones (as percentages), scope
--    items, onboarding checklist and task titles in `template_items` jsonb,
--    taken by `createProjectTemplateFromProject`; `createProjectFromTemplate`
--    raises a project through the existing by-hand door and then writes the
--    snapshot into it through the same tables and RPCs a person would use
--    (replace_payment_plan for the plan, open_scope_version/add_scope_item
--    for scope). jsonb rather than child tables: a template is a copy taken
--    at one moment, never edited in place, and nothing joins to it.
--
-- 4. MARGIN ON THE PROJECT REPORT. Decision: reversed by the owner on
--    2026-09-29. Needs no schema — the report computes paid − expenses − AI
--    cost from rows that already exist and labels it a cash-basis estimate.
--    Recorded here so the reversal has a migration header to point at.
--
-- Audit: `audit.record_row_change` raises on a table it has no vocabulary
-- for, and extending it means retyping every branch (the 2026-09-22 note
-- says why that is a risk). The three new tables get their own small
-- recorder, `projects.record_stream_d2_change`, same shape, same actor rule,
-- covering insert, update AND delete (a time log removed or a template
-- deleted is a governed change too). `project_files` keeps the trigger it
-- already has: a soft delete, a restore and a new version are all updates
-- or inserts it already records.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1a. projects.project_files: a body, a version, a trash ───────────────

alter table projects.project_files add column if not exists storage_path   text;
alter table projects.project_files add column if not exists size_bytes     bigint check (size_bytes is null or size_bytes >= 0);
alter table projects.project_files add column if not exists content_type   text;
alter table projects.project_files add column if not exists version        integer not null default 1 check (version >= 1);
alter table projects.project_files add column if not exists parent_file_id uuid references projects.project_files(id) on delete cascade;
alter table projects.project_files add column if not exists deleted_at     timestamptz;
alter table projects.project_files add column if not exists deleted_by     uuid references core.users(id) on delete set null;

alter table projects.project_files alter column url drop not null;

alter table projects.project_files drop constraint if exists project_files_url_check;
alter table projects.project_files drop constraint if exists project_files_link_or_object;
alter table projects.project_files add constraint project_files_link_or_object
  check (
    (url is not null and length(trim(url)) > 0)
    or (storage_path is not null and length(trim(storage_path)) > 0)
  );

alter table projects.project_files drop constraint if exists project_files_deleted_pair;
alter table projects.project_files add constraint project_files_deleted_pair
  check ((deleted_at is null) = (deleted_by is null));

-- A version row is never its own parent, and a parent is a first version.
alter table projects.project_files drop constraint if exists project_files_version_shape;
alter table projects.project_files add constraint project_files_version_shape
  check (
    (parent_file_id is null and version = 1)
    or (parent_file_id is not null and parent_file_id <> id and version > 1)
  );

create unique index if not exists project_files_version_uniq
  on projects.project_files (parent_file_id, version)
  where parent_file_id is not null;

create index if not exists project_files_trash_idx
  on projects.project_files (project_id, deleted_at desc)
  where deleted_at is not null;

comment on column projects.project_files.storage_path is
  'Object path in the configured Supabase Storage bucket (env SUPABASE_FILES_BUCKET). Set for an uploaded file; url is set for a linked one; never both null.';
comment on column projects.project_files.version is
  'Upload number within a file. 1 for the first row; a later upload is a new row with parent_file_id pointing at the first and the next version.';
comment on column projects.project_files.parent_file_id is
  'The first-version row this row is a later version of. Null for a first version.';
comment on column projects.project_files.deleted_at is
  'Soft delete — the trash. Restore clears it together with deleted_by. The object stays in the bucket.';

drop trigger if exists org_match_project_files_parent on projects.project_files;
create trigger org_match_project_files_parent
  before insert or update of parent_file_id, organization_id on projects.project_files
  for each row execute function core.enforce_parent_org('parent_file_id', 'projects.project_files');

-- A version belongs to the same project as its parent, and only a first
-- version may be a parent — a version chain is one level deep.
create or replace function projects.check_project_file_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_parent projects.project_files%rowtype;
begin
  if new.parent_file_id is null then
    return new;
  end if;

  select * into v_parent from projects.project_files where id = new.parent_file_id;
  if not found then
    return new; -- the foreign key refuses this on its own
  end if;
  if v_parent.parent_file_id is not null then
    raise exception 'a version must point at the first version of its file, not at another version';
  end if;
  if v_parent.project_id <> new.project_id then
    raise exception 'a version belongs to the same project as its file';
  end if;
  return new;
end;
$$;

comment on function projects.check_project_file_version() is
  'Keeps a file''s version chain one level deep and inside one project: every later version points at the first version, on the same project.';

drop trigger if exists project_files_check_version on projects.project_files;
create trigger project_files_check_version
  before insert or update of parent_file_id, project_id on projects.project_files
  for each row execute function projects.check_project_file_version();

-- ── 1b. projects.project_file_shares ─────────────────────────────────────

create table if not exists projects.project_file_shares (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  file_id          uuid not null references projects.project_files(id) on delete cascade,
  token            text not null unique check (length(token) between 32 and 128),
  expires_at       timestamptz not null,
  created_by       uuid references core.users(id) on delete set null,
  revoked_at       timestamptz,
  access_count     integer not null default 0 check (access_count >= 0),
  last_accessed_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table projects.project_file_shares is
  'A signed share link to one stored project file — a random token that stops working at expires_at or when revoked. Resolved by projects.resolve_file_share for the public route; never lists anything.';

create index if not exists project_file_shares_file_idx
  on projects.project_file_shares (file_id, created_at desc);
create index if not exists project_file_shares_organization_idx
  on projects.project_file_shares (organization_id, project_id, created_at desc);

drop trigger if exists set_updated_at on projects.project_file_shares;
create trigger set_updated_at before update on projects.project_file_shares
  for each row execute function core.set_updated_at();

alter table projects.project_file_shares enable row level security;
alter table projects.project_file_shares force row level security;

drop policy if exists project_file_shares_select on projects.project_file_shares;
create policy project_file_shares_select on projects.project_file_shares
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists project_file_shares_write on projects.project_file_shares;
create policy project_file_shares_write on projects.project_file_shares
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert, update on projects.project_file_shares to authenticated, service_role;

drop trigger if exists org_match_project_file_shares_project on projects.project_file_shares;
create trigger org_match_project_file_shares_project
  before insert or update of project_id, organization_id on projects.project_file_shares
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_project_file_shares_file on projects.project_file_shares;
create trigger org_match_project_file_shares_file
  before insert or update of file_id, organization_id on projects.project_file_shares
  for each row execute function core.enforce_parent_org('file_id', 'projects.project_files');

drop trigger if exists freeze_org_project_file_shares on projects.project_file_shares;
create trigger freeze_org_project_file_shares
  before update of organization_id on projects.project_file_shares
  for each row execute function core.freeze_organization_id();

-- The public route's only door. SECURITY DEFINER because the caller is
-- nobody (no session); granted to service_role alone, so it is reachable
-- only from the server with the service key, never from a browser holding
-- the anon key. Returns nothing for an unknown, expired or revoked token,
-- or for a file that is in the trash — the route answers 404 for all four
-- so a probe learns nothing about which it was. Counts the access.
create or replace function projects.resolve_file_share(p_token text)
returns table (
  file_id      uuid,
  storage_path text,
  title        text,
  content_type text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_share projects.project_file_shares%rowtype;
  v_file  projects.project_files%rowtype;
begin
  if p_token is null or length(p_token) < 32 then
    return;
  end if;

  select * into v_share from projects.project_file_shares s where s.token = p_token;
  if not found then return; end if;
  if v_share.revoked_at is not null then return; end if;
  if v_share.expires_at <= now() then return; end if;

  select * into v_file from projects.project_files f where f.id = v_share.file_id;
  if not found then return; end if;
  if v_file.deleted_at is not null then return; end if;
  if v_file.storage_path is null then return; end if;

  update projects.project_file_shares s
     set access_count = s.access_count + 1,
         last_accessed_at = now()
   where s.id = v_share.id;

  return query select v_file.id, v_file.storage_path, v_file.title, v_file.content_type;
end;
$$;

comment on function projects.resolve_file_share(text) is
  'Resolves a share token to the stored file it points at, or nothing when the token is unknown, expired, revoked, or the file is in the trash. service_role only: the public route calls it; the row it counts is the only trace.';

revoke all on function projects.resolve_file_share(text) from public, anon, authenticated;
grant execute on function projects.resolve_file_share(text) to service_role;

-- ── 1c. the bucket and its policies, where a storage service exists ──────

do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'storage schema absent: the project-files bucket and its policies are not created here (the local stack has no storage service)';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('project-files', 'project-files', false)
  on conflict (id) do nothing;

  -- Objects are keyed <organization_id>/<project_id>/<file_id>/<version>-<name>.
  -- The first folder is the tenant, and that is what every policy checks.
  execute 'drop policy if exists project_files_objects_select on storage.objects';
  execute $p$create policy project_files_objects_select on storage.objects
    for select to authenticated
    using (bucket_id = 'project-files'
           and (storage.foldername(name))[1] = (select core.current_organization_id())::text
           and (select core.is_internal()))$p$;

  execute 'drop policy if exists project_files_objects_insert on storage.objects';
  execute $p$create policy project_files_objects_insert on storage.objects
    for insert to authenticated
    with check (bucket_id = 'project-files'
                and (storage.foldername(name))[1] = (select core.current_organization_id())::text
                and (select core.can_write()))$p$;

  -- No update and no delete for authenticated: a version is a new object,
  -- and the trash is a column on the row. Emptying the bucket is an owner's
  -- operational act with the service key, not a panel button.
  execute 'drop policy if exists project_files_objects_update on storage.objects';
  execute 'drop policy if exists project_files_objects_delete on storage.objects';
end;
$$;

-- ── 2. projects.time_logs ────────────────────────────────────────────────

create table if not exists projects.time_logs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,
  person_id        uuid not null references core.users(id) on delete cascade,
  hours            numeric(6,2) not null check (hours > 0 and hours <= 24),
  logged_on        date not null,
  note             text check (note is null or length(btrim(note)) between 1 and 1000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table projects.time_logs is
  'Manual hours a person logged against a task on a date, with a note — decision 4 of 2026-09-29. Totals are the three time_log_totals_* views. No billing effect: nothing in finance reads it.';

create index if not exists time_logs_task_idx
  on projects.time_logs (task_id, logged_on desc);
create index if not exists time_logs_project_idx
  on projects.time_logs (organization_id, project_id, logged_on desc);
create index if not exists time_logs_person_idx
  on projects.time_logs (organization_id, person_id, logged_on desc);

drop trigger if exists set_updated_at on projects.time_logs;
create trigger set_updated_at before update on projects.time_logs
  for each row execute function core.set_updated_at();

-- The task named is on the project named — a log cannot straddle two.
create or replace function projects.check_time_log_task()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task_project uuid;
begin
  select t.project_id into v_task_project from projects.tasks t where t.id = new.task_id;
  if v_task_project is not null and v_task_project <> new.project_id then
    raise exception 'the task is not on this project';
  end if;
  return new;
end;
$$;

comment on function projects.check_time_log_task() is
  'Refuses a time log whose task is on a different project than the one named on the row.';

drop trigger if exists time_logs_check_task on projects.time_logs;
create trigger time_logs_check_task
  before insert or update of task_id, project_id on projects.time_logs
  for each row execute function projects.check_time_log_task();

alter table projects.time_logs enable row level security;
alter table projects.time_logs force row level security;

drop policy if exists time_logs_select on projects.time_logs;
create policy time_logs_select on projects.time_logs
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- Add: anyone who may write, and only about themselves.
drop policy if exists time_logs_insert on projects.time_logs;
create policy time_logs_insert on projects.time_logs
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write())
              and person_id = (select auth.uid()));

-- Edit: your own entry, and it stays yours.
drop policy if exists time_logs_update on projects.time_logs;
create policy time_logs_update on projects.time_logs
  for update to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.can_write())
         and person_id = (select auth.uid()))
  with check (organization_id = (select core.current_organization_id())
              and person_id = (select auth.uid()));

-- Delete: your own entry, or any entry if you manage delivery.
drop policy if exists time_logs_delete on projects.time_logs;
create policy time_logs_delete on projects.time_logs
  for delete to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.can_write())
         and (person_id = (select auth.uid()) or (select core.can_manage_delivery())));

grant select, insert, update, delete on projects.time_logs to authenticated, service_role;

drop trigger if exists org_match_time_logs_project on projects.time_logs;
create trigger org_match_time_logs_project
  before insert or update of project_id, organization_id on projects.time_logs
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_time_logs_task on projects.time_logs;
create trigger org_match_time_logs_task
  before insert or update of task_id, organization_id on projects.time_logs
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

drop trigger if exists freeze_org_time_logs on projects.time_logs;
create trigger freeze_org_time_logs
  before update of organization_id on projects.time_logs
  for each row execute function core.freeze_organization_id();

-- The totals. security_invoker so the base table's RLS decides what is
-- summed — a view that ran as its owner would count rows the reader may
-- not see.
create or replace view projects.time_log_totals_by_task
with (security_invoker = true) as
  select organization_id, project_id, task_id,
         sum(hours)::numeric(10,2) as hours,
         count(*)::integer         as entries,
         max(logged_on)            as last_logged_on
    from projects.time_logs
   group by organization_id, project_id, task_id;

create or replace view projects.time_log_totals_by_project
with (security_invoker = true) as
  select organization_id, project_id,
         sum(hours)::numeric(10,2) as hours,
         count(*)::integer         as entries,
         count(distinct person_id)::integer as people,
         max(logged_on)            as last_logged_on
    from projects.time_logs
   group by organization_id, project_id;

create or replace view projects.time_log_totals_by_person
with (security_invoker = true) as
  select organization_id, project_id, person_id,
         sum(hours)::numeric(10,2) as hours,
         count(*)::integer         as entries,
         max(logged_on)            as last_logged_on
    from projects.time_logs
   group by organization_id, project_id, person_id;

comment on view projects.time_log_totals_by_task is 'Hours logged per task — a sum over projects.time_logs under the reader''s own RLS.';
comment on view projects.time_log_totals_by_project is 'Hours logged per project — a sum over projects.time_logs under the reader''s own RLS.';
comment on view projects.time_log_totals_by_person is 'Hours logged per person per project — a sum over projects.time_logs under the reader''s own RLS.';

grant select on projects.time_log_totals_by_task to authenticated, service_role;
grant select on projects.time_log_totals_by_project to authenticated, service_role;
grant select on projects.time_log_totals_by_person to authenticated, service_role;

-- ── 3. projects.project_templates ────────────────────────────────────────
-- Decision: reversed by the owner on 2026-09-29.

create table if not exists projects.project_templates (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  name               text not null check (length(btrim(name)) between 1 and 200),
  description        text check (description is null or length(btrim(description)) <= 1000),
  source_project_id  uuid references projects.projects(id) on delete set null,
  template_items     jsonb not null default '{}'::jsonb,
  created_by         uuid references core.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint project_templates_items_is_object check (jsonb_typeof(template_items) = 'object')
);

comment on table projects.project_templates is
  'A named snapshot of one project''s modules, features, milestone percentages, scope items, onboarding checklist and task titles, from which a new project is raised. Decision: reversed by the owner on 2026-09-29.';

create unique index if not exists project_templates_name_uniq
  on projects.project_templates (organization_id, lower(name));
create index if not exists project_templates_organization_idx
  on projects.project_templates (organization_id, created_at desc);

drop trigger if exists set_updated_at on projects.project_templates;
create trigger set_updated_at before update on projects.project_templates
  for each row execute function core.set_updated_at();

alter table projects.project_templates enable row level security;
alter table projects.project_templates force row level security;

drop policy if exists project_templates_select on projects.project_templates;
create policy project_templates_select on projects.project_templates
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- Saving a template is a delivery act (the roles holding project.write);
-- deleting one is an administrative act, on the settings screen.
drop policy if exists project_templates_insert on projects.project_templates;
create policy project_templates_insert on projects.project_templates
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_manage_delivery()));

drop policy if exists project_templates_update on projects.project_templates;
create policy project_templates_update on projects.project_templates
  for update to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_manage_delivery()));

drop policy if exists project_templates_delete on projects.project_templates;
create policy project_templates_delete on projects.project_templates
  for delete to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_admin()));

grant select, insert, update, delete on projects.project_templates to authenticated, service_role;

drop trigger if exists org_match_project_templates_source on projects.project_templates;
create trigger org_match_project_templates_source
  before insert or update of source_project_id, organization_id on projects.project_templates
  for each row execute function core.enforce_parent_org('source_project_id', 'projects.projects');

drop trigger if exists freeze_org_project_templates on projects.project_templates;
create trigger freeze_org_project_templates
  before update of organization_id on projects.project_templates
  for each row execute function core.freeze_organization_id();

-- ── audit: the three new tables, insert, update and delete ───────────────

create or replace function projects.record_stream_d2_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before  jsonb;
  v_after   jsonb;
  v_org     uuid;
  v_id      uuid;
  v_subject text;
  v_action  text;
begin
  if tg_op = 'DELETE' then
    v_before := to_jsonb(old);
    v_after  := null;
    v_org    := old.organization_id;
    v_id     := old.id;
  else
    v_before := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
    v_after  := to_jsonb(new);
    v_org    := new.organization_id;
    v_id     := new.id;
  end if;

  case tg_table_name
    when 'time_logs' then
      v_subject := 'time_log';
      v_action := case tg_op when 'INSERT' then 'time_log.added' when 'UPDATE' then 'time_log.edited' else 'time_log.deleted' end;

    when 'project_file_shares' then
      v_subject := 'project_file_share';
      v_action :=
        case
          when tg_op = 'INSERT' then 'project_file_share.created'
          when tg_op = 'UPDATE' and new.revoked_at is not null and old.revoked_at is null then 'project_file_share.revoked'
          when tg_op = 'UPDATE' and new.access_count <> old.access_count then 'project_file_share.accessed'
          when tg_op = 'UPDATE' then 'project_file_share.updated'
          else 'project_file_share.deleted'
        end;

    when 'project_templates' then
      v_subject := 'project_template';
      v_action := case tg_op when 'INSERT' then 'project_template.saved' when 'UPDATE' then 'project_template.updated' else 'project_template.deleted' end;

    else
      raise exception 'projects.record_stream_d2_change: no vocabulary for table %', tg_table_name;
  end case;

  if tg_op = 'UPDATE' and (v_before - 'updated_at') = (v_after - 'updated_at') then
    return null;
  end if;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org,
    case when (select auth.uid()) is null then 'system' else 'user' end,
    (select auth.uid()),
    v_action,
    v_subject,
    v_id,
    v_before,
    v_after
  );

  return null;
end;
$$;

comment on function projects.record_stream_d2_change() is
  'Writes audit.audit_log for time_logs, project_file_shares and project_templates inside the transaction that changed the row — insert, update and delete. Same actor rule as audit.record_row_change; a separate function so that one need not be retyped.';

drop trigger if exists audit_row_change on projects.time_logs;
create trigger audit_row_change after insert or update or delete on projects.time_logs
  for each row execute function projects.record_stream_d2_change();

drop trigger if exists audit_row_change on projects.project_file_shares;
create trigger audit_row_change after insert or update on projects.project_file_shares
  for each row execute function projects.record_stream_d2_change();

drop trigger if exists audit_row_change on projects.project_templates;
create trigger audit_row_change after insert or update or delete on projects.project_templates
  for each row execute function projects.record_stream_d2_change();

notify pgrst, 'reload schema';
