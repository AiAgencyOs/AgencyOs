-- ═══════════════════════════════════════════════════════════════════════════
-- A file has a home already.
--
-- SCR-024's Project Files screen had nothing to read: the traceability sweep
-- behind the Admin Panel rebuild found zero storage integration anywhere in
-- the repository (`.storage.` / `createSignedUrl`: no hits) and no
-- attachment table. `projects.deliverables` (20260813120001) is the nearest
-- neighbour and settles the only real design question here by precedent —
-- "a link rather than a blob... copying it into Postgres would make the
-- database the worst file server in the stack." This table keeps that rule:
-- `url` points at wherever the agency already keeps the file (Drive, Figma,
-- the client's own bucket), and AGENTS.md §35 says exactly this — "the UX may
-- present folders while storage remains metadata-driven."
--
-- Not `projects.deliverables` itself: that table's `kind` is a promise made
-- to a client (design/prototype/build/document) with its own version
-- sequence and client-visibility rules. A requirements PDF or a QA report
-- is neither a promise nor versioned against anything, and forcing it
-- through `deliverables`' vocabulary would mean either inventing a v1 nobody
-- asked for or growing that CHECK constraint until "kind" stops meaning
-- what a client sees.
--
-- `category` is the ten-folder taxonomy AGENTS.md §35 lists, minus the
-- numeric prefixes — those are a presentation concern for the page, not a
-- fact about the row.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.project_files (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  category         text not null default 'other' check (category in (
                      'requirements', 'design', 'development', 'qa',
                      'deployment', 'marketing', 'documents', 'assets',
                      'builds', 'other'
                    )),

  title            text not null check (length(trim(title)) > 0),
  url              text not null check (length(trim(url)) > 0),
  description      text,

  uploaded_by      uuid references core.users(id) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists project_files_project_idx
  on projects.project_files (project_id, category, created_at desc);

comment on table projects.project_files is
  'Project file references — SCR-024. Metadata and an external link, never a blob, matching projects.deliverables and AGENTS.md §35.';

drop trigger if exists set_updated_at on projects.project_files;
create trigger set_updated_at before update on projects.project_files
  for each row execute function core.set_updated_at();

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table projects.project_files enable row level security;
alter table projects.project_files force row level security;

-- Internal-only, like projects.tasks: a project's file index is a working
-- surface, not something #17 (client-facing files) has settled the shape of
-- yet. Widening this to clients is that screen's decision, not this one's.
drop policy if exists project_files_select on projects.project_files;
create policy project_files_select on projects.project_files
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists project_files_write on projects.project_files;
create policy project_files_write on projects.project_files
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop trigger if exists org_match_project_files_project on projects.project_files;
create trigger org_match_project_files_project
  before insert or update of project_id, organization_id on projects.project_files
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_project_files on projects.project_files;
create trigger freeze_org_project_files
  before update of organization_id on projects.project_files
  for each row execute function core.freeze_organization_id();
