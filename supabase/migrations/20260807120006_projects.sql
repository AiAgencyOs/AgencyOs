-- ═══════════════════════════════════════════════════════════════════════════
-- 006 — projects: projects, milestones, tasks
--
-- `visibility` is the mechanism behind the client portal: portal users see a
-- row only when it is marked client-visible, so one table serves both
-- audiences without duplicating reads (ARCHITECTURE.md §2).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.projects (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  opportunity_id     uuid references sales.opportunities(id) on delete set null,

  name               text not null check (length(trim(name)) > 0),
  code               text,                -- short human reference, e.g. ACME-01
  description        text,

  status             text not null default 'planning' check (status in
                       ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  visibility         text not null default 'internal' check (visibility in ('internal', 'client')),

  currency           char(3) not null default 'INR',
  budget_minor       bigint check (budget_minor >= 0),

  starts_on          date,
  ends_on            date,
  completed_at       timestamptz,

  lead_id            uuid references core.users(id) on delete set null,  -- delivery lead

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  constraint projects_date_order check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create unique index if not exists projects_org_code_key
  on projects.projects (organization_id, code) where code is not null;

create index if not exists projects_organization_status_idx
  on projects.projects (organization_id, status) where deleted_at is null;

create index if not exists projects_account_idx
  on projects.projects (client_account_id) where deleted_at is null;

create table if not exists projects.milestones (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  name             text not null check (length(trim(name)) > 0),
  description      text,
  position         int not null default 0,

  status           text not null default 'pending' check (status in
                     ('pending', 'in_progress', 'submitted', 'met', 'rejected')),
  visibility       text not null default 'client' check (visibility in ('internal', 'client')),

  -- Milestone → invoice mapping: the link that turns delivery into revenue.
  currency         char(3) not null default 'INR',
  amount_minor     bigint not null default 0 check (amount_minor >= 0),

  due_on           date,
  met_at           timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint milestones_met_at_set check (status <> 'met' or met_at is not null)
);

create index if not exists milestones_project_idx
  on projects.milestones (project_id, position);
create index if not exists milestones_organization_status_idx
  on projects.milestones (organization_id, status);

create table if not exists projects.tasks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  milestone_id     uuid references projects.milestones(id) on delete set null,

  title            text not null check (length(trim(title)) > 0),
  description      text,

  status           text not null default 'todo' check (status in
                     ('todo', 'in_progress', 'blocked', 'in_review', 'done')),
  priority         text not null default 'p2' check (priority in ('p0', 'p1', 'p2', 'p3')),

  assignee_id      uuid references core.users(id) on delete set null,
  estimate_hours   numeric(6, 2) check (estimate_hours >= 0),
  due_on           date,
  completed_at     timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists tasks_project_status_idx
  on projects.tasks (project_id, status);
create index if not exists tasks_assignee_idx
  on projects.tasks (organization_id, assignee_id) where assignee_id is not null;
create index if not exists tasks_milestone_idx on projects.tasks (milestone_id);

do $$
declare t text;
begin
  foreach t in array array['projects','milestones','tasks']
  loop
    execute format('drop trigger if exists set_updated_at on projects.%I', t);
    execute format(
      'create trigger set_updated_at before update on projects.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table projects.projects   enable row level security;
alter table projects.milestones enable row level security;
alter table projects.tasks      enable row level security;

-- Projects: staff see all in the organization; portal users see only
-- client-visible projects belonging to their own account.
drop policy if exists projects_select on projects.projects;
create policy projects_select on projects.projects
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or (
        (select core.is_client())
        and visibility = 'client'
        and client_account_id = (select core.current_client_account_id())
      )
    )
  );

drop policy if exists projects_write on projects.projects;
create policy projects_write on projects.projects
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

-- Milestones inherit their project's audience.
drop policy if exists milestones_select on projects.milestones;
create policy milestones_select on projects.milestones
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or (
        (select core.is_client())
        and visibility = 'client'
        and exists (
          select 1 from projects.projects p
           where p.id = milestones.project_id
             and p.visibility = 'client'
             and p.client_account_id = (select core.current_client_account_id())
        )
      )
    )
  );

drop policy if exists milestones_write on projects.milestones;
create policy milestones_write on projects.milestones
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

-- Tasks are internal-only: clients see milestones, never the task breakdown.
drop policy if exists tasks_select on projects.tasks;
create policy tasks_select on projects.tasks
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists tasks_write on projects.tasks;
create policy tasks_write on projects.tasks
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));
