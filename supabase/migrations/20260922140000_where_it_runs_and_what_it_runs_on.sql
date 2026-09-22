-- ═══════════════════════════════════════════════════════════════════════════
-- Where it runs, and what it runs on.
--
-- SCR-043's other two halves — Builds shipped 2026-09-22 by filtering the
-- existing `deliverables` reader; nothing anywhere in the schema tracked a
-- deployment environment or a dependency version, and `builds/page.tsx`'s own
-- Callout said so rather than inventing either. That call is now made, on
-- the owner's explicit instruction to decide the remaining deferred screens
-- rather than leave each one open.
--
-- Same precedent as `projects.project_files` (20260922100000) and
-- `projects.repositories` (20260922110000): a link, never a blob. An
-- environment's Vercel/Supabase dashboard and a dependency's changelog both
-- already live somewhere; copying either into Postgres would make the
-- database the worst hosting/registry mirror in the stack.
--
-- Two tables, not one, because they answer different questions and a single
-- row cannot honestly hold both: "where is this deployed" has a URL and a
-- kind (development/staging/production); "what does this project depend on"
-- has a name and a version, and frequently no URL worth recording at all —
-- forcing a dependency through `project_files`' `url not null` would invent
-- a link nobody has.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.environments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  kind             text not null default 'development' check (kind in (
                      'development', 'staging', 'production', 'other'
                    )),

  label            text not null check (length(trim(label)) > 0),
  url              text not null check (length(trim(url)) > 0),
  notes            text,

  created_by       uuid references core.users(id) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists environments_project_idx
  on projects.environments (project_id, kind, created_at desc);

comment on table projects.environments is
  'Where a project is deployed — SCR-043. Metadata and an external link, never a blob, matching projects.project_files and projects.repositories.';

drop trigger if exists set_updated_at on projects.environments;
create trigger set_updated_at before update on projects.environments
  for each row execute function core.set_updated_at();

alter table projects.environments enable row level security;
alter table projects.environments force row level security;

-- Internal-only, the same boundary project_files chose: a deployment URL is
-- a working surface for the team, not something the client screen has
-- settled the shape of.
drop policy if exists environments_select on projects.environments;
create policy environments_select on projects.environments
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists environments_write on projects.environments;
create policy environments_write on projects.environments
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop trigger if exists org_match_environments_project on projects.environments;
create trigger org_match_environments_project
  before insert or update of project_id, organization_id on projects.environments
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_environments on projects.environments;
create trigger freeze_org_environments
  before update of organization_id on projects.environments
  for each row execute function core.freeze_organization_id();

-- ── dependencies ─────────────────────────────────────────────────────────

create table if not exists projects.dependencies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  name             text not null check (length(trim(name)) > 0),
  version          text,
  -- A link to the changelog, docs or registry page, when one is worth
  -- keeping. Unlike project_files/environments, most dependencies have
  -- nothing a person would click through to, so this stays nullable rather
  -- than inventing a URL to satisfy a constraint.
  reference        text,
  notes            text,

  created_by       uuid references core.users(id) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists dependencies_project_idx
  on projects.dependencies (project_id, name);

comment on table projects.dependencies is
  'What a project depends on — SCR-043. A name and, where useful, a version and a link; never the package itself.';

drop trigger if exists set_updated_at on projects.dependencies;
create trigger set_updated_at before update on projects.dependencies
  for each row execute function core.set_updated_at();

alter table projects.dependencies enable row level security;
alter table projects.dependencies force row level security;

drop policy if exists dependencies_select on projects.dependencies;
create policy dependencies_select on projects.dependencies
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists dependencies_write on projects.dependencies;
create policy dependencies_write on projects.dependencies
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop trigger if exists org_match_dependencies_project on projects.dependencies;
create trigger org_match_dependencies_project
  before insert or update of project_id, organization_id on projects.dependencies
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_dependencies on projects.dependencies;
create trigger freeze_org_dependencies
  before update of organization_id on projects.dependencies
  for each row execute function core.freeze_organization_id();
