-- ═══════════════════════════════════════════════════════════════════════════
-- 002 — core: tenancy, identity, jobs, outbox
-- ═══════════════════════════════════════════════════════════════════════════

-- ── organizations ─────────────────────────────────────────────────────────
create table if not exists core.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  currency    char(3) not null default 'INR',
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table core.organizations is
  'Tenant root. V1 runs a single organization; the column exists everywhere so multi-tenant is a feature, not a rewrite.';

-- ── users (profile mirror of auth.users) ──────────────────────────────────
create table if not exists core.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  actor_type  text not null default 'human' check (actor_type in ('human', 'agent')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists users_email_lower_key on core.users (lower(email));

comment on table core.users is
  'Profile mirror of auth.users. Deliberately has no organization_id: membership is the many-to-many join, so a user can later belong to several organizations.';

-- ── memberships (internal staff ↔ organization) ───────────────────────────
create table if not exists core.memberships (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,
  role             text not null check (role in
                     ('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor')),
  status           text not null default 'active' check (status in ('active', 'suspended')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists memberships_organization_idx on core.memberships (organization_id, status);
create index if not exists memberships_user_idx on core.memberships (user_id);

-- ── client_accounts ───────────────────────────────────────────────────────
create table if not exists core.client_accounts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) > 0),
  billing_email    text,
  currency         char(3) not null default 'INR',
  status           text not null default 'active' check (status in ('active', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists client_accounts_organization_idx
  on core.client_accounts (organization_id, status);

-- ── client_users (portal access, scoped to one client account) ────────────
create table if not exists core.client_users (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete cascade,
  user_id            uuid not null references core.users(id) on delete cascade,
  role               text not null default 'client_member'
                       check (role in ('client_admin', 'client_member')),
  status             text not null default 'active' check (status in ('active', 'revoked')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (client_account_id, user_id)
);

create index if not exists client_users_organization_idx on core.client_users (organization_id);
create index if not exists client_users_user_idx on core.client_users (user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Recursion-breaker.
--
-- The RLS policy on core.users needs to ask "is this user in my organization?",
-- which means reading core.memberships — whose own policy would then be
-- evaluated, and so on. SECURITY DEFINER runs the lookup with the definer's
-- rights, bypassing RLS on memberships and terminating the cycle.
--
-- Safe because it returns only a boolean and leaks no rows.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.shares_organization(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from core.memberships m
     where m.user_id = target_user_id
       and m.organization_id = core.current_organization_id()
       and m.status = 'active'
  ) or exists (
    select 1
      from core.client_users cu
     where cu.user_id = target_user_id
       and cu.organization_id = core.current_organization_id()
       and cu.status = 'active'
  );
$$;

revoke all on function core.shares_organization(uuid) from public;
grant execute on function core.shares_organization(uuid) to authenticated, service_role;

-- ── jobs (durable queue — ARCHITECTURE.md §4.4) ───────────────────────────
create table if not exists core.jobs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  kind             text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'queued' check (status in
                     ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead')),
  priority         smallint not null default 100,
  run_at           timestamptz not null default now(),
  attempts         int not null default 0 check (attempts >= 0),
  max_attempts     int not null default 5 check (max_attempts > 0),
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,
  dedupe_key       text,
  correlation_id   uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Idempotency: a dedupe_key may exist at most once across the whole table.
create unique index if not exists jobs_dedupe_key_key
  on core.jobs (dedupe_key) where dedupe_key is not null;

-- Drives the claim query; partial so it stays small as completed jobs pile up.
create index if not exists jobs_claim_idx
  on core.jobs (priority, run_at) where status = 'queued';

create index if not exists jobs_reaper_idx
  on core.jobs (locked_at) where status = 'running';

comment on table core.jobs is
  'Durable job queue. Every slow operation — above all every AI agent step — runs here, because Vercel has no always-on worker (ARCHITECTURE.md §0.4).';

-- ── outbox_events (transactional outbox — ARCHITECTURE.md §4.5) ───────────
create table if not exists core.outbox_events (
  id               bigserial primary key,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  type             text not null,
  payload          jsonb not null default '{}'::jsonb,
  subject_type     text,
  subject_id       uuid,
  correlation_id   uuid,
  published_at     timestamptz,
  attempts         int not null default 0,
  created_at       timestamptz not null default now()
);

create index if not exists outbox_unpublished_idx
  on core.outbox_events (id) where published_at is null;

comment on table core.outbox_events is
  'Events are written in the same transaction as the state change they describe, so "state committed but event lost" cannot happen.';

-- ── updated_at triggers ───────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['organizations','users','memberships','client_accounts','client_users','jobs']
  loop
    execute format('drop trigger if exists set_updated_at on core.%I', t);
    execute format(
      'create trigger set_updated_at before update on core.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
--
-- current_organization_id() is wrapped in (select ...) throughout: Postgres
-- then evaluates it once per query as an InitPlan instead of once per row.
-- Without the wrapper these policies are a per-row function call and scans
-- get dramatically slower as tables grow.
-- ═══════════════════════════════════════════════════════════════════════════

alter table core.organizations  enable row level security;
alter table core.users          enable row level security;
alter table core.memberships    enable row level security;
alter table core.client_accounts enable row level security;
alter table core.client_users   enable row level security;
alter table core.jobs           enable row level security;
alter table core.outbox_events  enable row level security;

-- organizations: you see only your own
drop policy if exists organizations_select on core.organizations;
create policy organizations_select on core.organizations
  for select to authenticated
  using (id = (select core.current_organization_id()));

drop policy if exists organizations_update on core.organizations;
create policy organizations_update on core.organizations
  for update to authenticated
  using (id = (select core.current_organization_id()) and (select core.is_owner()))
  with check (id = (select core.current_organization_id()));

-- users: yourself, plus anyone sharing your organization
drop policy if exists users_select on core.users;
create policy users_select on core.users
  for select to authenticated
  using (id = (select auth.uid()) or core.shares_organization(id));

drop policy if exists users_update_self on core.users;
create policy users_update_self on core.users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- memberships: internal staff read their organization's; only owners write
drop policy if exists memberships_select on core.memberships;
create policy memberships_select on core.memberships
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists memberships_write on core.memberships;
create policy memberships_write on core.memberships
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_owner()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_owner()));

-- client_accounts: staff see all in the org; portal users see only their own
drop policy if exists client_accounts_select on core.client_accounts;
create policy client_accounts_select on core.client_accounts
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or id = (select core.current_client_account_id())
    )
  );

drop policy if exists client_accounts_write on core.client_accounts;
create policy client_accounts_write on core.client_accounts
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

-- client_users: staff manage; portal users see only peers on their account
drop policy if exists client_users_select on core.client_users;
create policy client_users_select on core.client_users
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or client_account_id = (select core.current_client_account_id())
    )
  );

drop policy if exists client_users_write on core.client_users;
create policy client_users_write on core.client_users
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

-- jobs and outbox: observability for internal staff; writes are service-role
-- only, which bypasses RLS and therefore needs no policy.
drop policy if exists jobs_select on core.jobs;
create policy jobs_select on core.jobs
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists outbox_select on core.outbox_events;
create policy outbox_select on core.outbox_events
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- ═══════════════════════════════════════════════════════════════════════════
-- Atomic job claim.
--
-- FOR UPDATE SKIP LOCKED is the whole point: it is what stops two concurrent
-- serverless invocations from claiming the same job. Without it, cron and the
-- self-dispatch nudge race and jobs run twice.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.claim_jobs(worker_id text, batch_size int default 5)
returns setof core.jobs
language sql
volatile
security definer
set search_path = ''
as $$
  update core.jobs j
     set status    = 'running',
         locked_at = now(),
         locked_by = worker_id,
         attempts  = j.attempts + 1
   where j.id in (
     select id
       from core.jobs
      where status = 'queued'
        and run_at <= now()
      order by priority, run_at
      limit batch_size
        for update skip locked
   )
  returning j.*;
$$;

revoke all on function core.claim_jobs(text, int) from public, anon, authenticated;
grant execute on function core.claim_jobs(text, int) to service_role;

-- Releases jobs whose worker died mid-run (the function invocation was killed
-- before it could finish). Jobs past max_attempts are parked as 'dead'.
create or replace function core.reap_stalled_jobs(stall_timeout interval default '5 minutes')
returns int
language sql
volatile
security definer
set search_path = ''
as $$
  with released as (
    update core.jobs
       set status     = case when attempts >= max_attempts then 'dead' else 'queued' end,
           locked_at  = null,
           locked_by  = null,
           last_error = coalesce(last_error, 'worker stalled; reclaimed')
     where status = 'running'
       and locked_at < now() - stall_timeout
    returning 1
  )
  select count(*)::int from released;
$$;

revoke all on function core.reap_stalled_jobs(interval) from public, anon, authenticated;
grant execute on function core.reap_stalled_jobs(interval) to service_role;
