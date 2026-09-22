-- ═══════════════════════════════════════════════════════════════════════════
-- A repository is a link too.
--
-- SCR-042's Repository, Branch & Code Review screen had nothing to read: the
-- traceability sweep found zero git/VCS integration anywhere in the
-- repository or the schema. Confirmed with the owner (2026-09-22): this
-- stays link-based, the same choice `projects.project_files` and
-- `projects.deliverables` already made — a URL to wherever the repository,
-- its branches and its pull requests actually live (GitHub, GitLab,
-- Bitbucket), never a live API integration pulling real branch or PR state.
-- That is the honest boundary of what this table can say: it records where
-- to look, not what is currently true there. A screen that showed a branch
-- name or a review status without a real integration behind it would be
-- inventing data this table does not have.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.repositories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  name             text not null check (length(trim(name)) > 0),
  platform         text not null default 'other' check (platform in
                      ('github', 'gitlab', 'bitbucket', 'other')),
  url              text not null check (length(trim(url)) > 0),
  default_branch   text,
  -- Where a reviewer actually looks — a PR list, a review board. Separate
  -- from `url` because the repository itself and where its reviews happen
  -- are not always the same link (a GitHub repo's PR tab vs. a separate
  -- review tool).
  review_url       text,
  notes            text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists repositories_project_idx
  on projects.repositories (project_id, created_at desc);

comment on table projects.repositories is
  'Repository references — SCR-042. A link, like projects.project_files and projects.deliverables: where the code and its reviews live, never live branch or PR state pulled from an API this product does not integrate with.';

drop trigger if exists set_updated_at on projects.repositories;
create trigger set_updated_at before update on projects.repositories
  for each row execute function core.set_updated_at();

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table projects.repositories enable row level security;
alter table projects.repositories force row level security;

drop policy if exists repositories_select on projects.repositories;
create policy repositories_select on projects.repositories
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists repositories_write on projects.repositories;
create policy repositories_write on projects.repositories
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop trigger if exists org_match_repositories_project on projects.repositories;
create trigger org_match_repositories_project
  before insert or update of project_id, organization_id on projects.repositories
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_repositories on projects.repositories;
create trigger freeze_org_repositories
  before update of organization_id on projects.repositories
  for each row execute function core.freeze_organization_id();
