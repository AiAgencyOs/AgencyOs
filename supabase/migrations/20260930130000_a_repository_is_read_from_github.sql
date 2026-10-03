-- ═══════════════════════════════════════════════════════════════════════════
-- A repository is read from GitHub.
--
-- Decision: reversed by the owner on 2026-09-29.
--
-- 20260922110000_a_repository_is_a_link_too.sql recorded the earlier choice:
-- SCR-042 stays link-based, "never a live API integration pulling real branch
-- or PR state". The owner reversed that on 2026-09-29: the panel MAY read
-- branches, recent commits and open pull requests from GitHub for a
-- repository, with the token from the deployment environment (`GITHUB_TOKEN`,
-- through src/lib/env), an honest "not configured" state when it is absent,
-- and never a write to GitHub.
--
-- What this table holds is the ONE thing worth persisting: which GitHub
-- repository a project is read from — owner, repo name, the branch to read
-- commits on. Nothing GitHub answers is cached here; a commit or a pull
-- request shown on the screen was fetched on that request or the screen says
-- it could not reach GitHub. `projects.repositories` (the link rows) is left
-- as it is: a link to where the code lives is still a fact somebody typed,
-- and a project may keep several. This is the one live one.
--
-- One link per project (`unique (project_id)`): the screen reads one
-- repository, so a second row would be a question of which one, answered by
-- nobody.
--
-- Linking and unlinking are the governed door — owner, ops_admin and
-- delivery_lead, the three roles that hold project.write in
-- src/lib/authz/permissions.ts — and each writes audit.audit_log with the
-- before and after, so "who pointed this project at that repository" has an
-- answer.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.repository_links (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- Only GitHub is read today. A check rather than an enum, so a second
  -- provider is one migration away rather than a type change.
  provider         text not null default 'github' check (provider in ('github')),
  owner            text not null check (owner ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  repo             text not null check (repo ~ '^[A-Za-z0-9._-]{1,100}$'),
  -- The branch the commit list is read on. A fact somebody typed; the fetcher
  -- reports GitHub's own default beside it when the two differ.
  default_branch   text not null default 'main' check (length(trim(default_branch)) between 1 and 200),

  linked_by        uuid references core.users(id) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (project_id)
);

create index if not exists repository_links_org_idx
  on projects.repository_links (organization_id, created_at desc);

comment on table projects.repository_links is
  'Which GitHub repository a project is read from — owner, repo, branch — and nothing GitHub answers (Decision: reversed by the owner on 2026-09-29). One per project; linked and unlinked through projects.link_repository / projects.unlink_repository, audited.';

drop trigger if exists set_updated_at on projects.repository_links;
create trigger set_updated_at before update on projects.repository_links
  for each row execute function core.set_updated_at();

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table projects.repository_links enable row level security;
alter table projects.repository_links force row level security;

drop policy if exists repository_links_select on projects.repository_links;
create policy repository_links_select on projects.repository_links
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- The three roles that hold project.write. Written through the functions
-- below in practice; the policy says the same thing again so a direct write
-- by any other role is refused by the database, not only by the door.
drop policy if exists repository_links_write on projects.repository_links;
create policy repository_links_write on projects.repository_links
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin', 'delivery_lead'))
  with check (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin', 'delivery_lead'));

grant select, insert, update, delete on projects.repository_links to authenticated, service_role;

drop trigger if exists org_match_repository_links_project on projects.repository_links;
create trigger org_match_repository_links_project
  before insert or update of project_id, organization_id on projects.repository_links
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_repository_links on projects.repository_links;
create trigger freeze_org_repository_links
  before update of organization_id on projects.repository_links
  for each row execute function core.freeze_organization_id();

-- ── the door ─────────────────────────────────────────────────────────────
--
-- security invoker: RLS decides again inside. The function exists for the
-- audit row and the one-per-project upsert, not to bypass anything.

create or replace function projects.link_repository(
  p_project_id uuid,
  p_owner text,
  p_repo text,
  p_default_branch text default 'main'
)
returns table (outcome text, id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_owner  text := btrim(coalesce(p_owner, ''));
  v_repo   text := btrim(coalesce(p_repo, ''));
  v_branch text := coalesce(nullif(btrim(coalesce(p_default_branch, '')), ''), 'main');
  v_before jsonb;
  v_after  jsonb;
  v_id     uuid;
begin
  if (select core.current_user_role()) not in ('owner', 'ops_admin', 'delivery_lead') then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select organization_id into v_org from projects.projects where projects.projects.id = p_project_id;
  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_org is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_owner !~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$' or v_repo !~ '^[A-Za-z0-9._-]{1,100}$' then
    return query select 'invalid_repository'::text, null::uuid; return;
  end if;

  select to_jsonb(l) - 'organization_id' into v_before
    from projects.repository_links l
   where l.project_id = p_project_id;

  insert into projects.repository_links (organization_id, project_id, provider, owner, repo, default_branch, linked_by)
  values (v_org, p_project_id, 'github', v_owner, v_repo, v_branch, v_actor)
  on conflict (project_id) do update
    set owner          = excluded.owner,
        repo           = excluded.repo,
        default_branch = excluded.default_branch,
        linked_by      = excluded.linked_by
  returning projects.repository_links.id into v_id;

  select to_jsonb(l) - 'organization_id' into v_after
    from projects.repository_links l
   where l.id = v_id;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org, 'user', v_actor,
    case when v_before is null then 'repository.linked' else 'repository.relinked' end,
    'repository_link', v_id, v_before, v_after
  );

  return query select 'linked'::text, v_id;
end;
$$;

comment on function projects.link_repository(uuid, text, text, text) is
  'Points a project at the GitHub repository it is read from (Decision: reversed by the owner on 2026-09-29). Owner, ops_admin or delivery_lead; one per project, replacing any earlier link; audited with before and after. Never touches GitHub.';

revoke all on function projects.link_repository(uuid, text, text, text) from public, anon;
grant execute on function projects.link_repository(uuid, text, text, text) to authenticated, service_role;

create or replace function projects.unlink_repository(p_project_id uuid)
returns table (outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_id     uuid;
  v_before jsonb;
begin
  if (select core.current_user_role()) not in ('owner', 'ops_admin', 'delivery_lead') then
    return query select 'forbidden'::text; return;
  end if;

  select l.id, l.organization_id, to_jsonb(l) - 'organization_id'
    into v_id, v_org, v_before
    from projects.repository_links l
   where l.project_id = p_project_id;

  if v_id is null then
    return query select 'not_linked'::text; return;
  end if;
  if v_org is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text; return;
  end if;

  delete from projects.repository_links where projects.repository_links.id = v_id;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (v_org, 'user', v_actor, 'repository.unlinked', 'repository_link', v_id, v_before, null);

  return query select 'unlinked'::text;
end;
$$;

comment on function projects.unlink_repository(uuid) is
  'Removes a project''s GitHub repository link. Owner, ops_admin or delivery_lead; audited with the row that was removed. Never touches GitHub.';

revoke all on function projects.unlink_repository(uuid) from public, anon;
grant execute on function projects.unlink_repository(uuid) to authenticated, service_role;
