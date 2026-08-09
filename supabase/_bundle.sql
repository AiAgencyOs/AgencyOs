-- ═══════════════════════════════════════════════════════════════════════════
-- AgencyOS — all migrations bundled for the Supabase SQL Editor.
--
-- GENERATED from supabase/migrations/. Do not edit by hand: change the
-- individual migration and regenerate.
--
--   Dashboard → SQL Editor → New query → paste this whole file → Run
--
-- Wrapped in a single transaction: it either all applies or none of it does,
-- so a failure never leaves the schema half-built. Every statement is also
-- idempotent, so re-running after a fix is safe.
-- ═══════════════════════════════════════════════════════════════════════════

begin;


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120001_schemas_and_helpers.sql                                ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 001 — Schemas, extensions, and the helper functions RLS is built on
--
-- Idempotent: safe to run repeatedly.
-- ═══════════════════════════════════════════════════════════════════════════

-- No extensions required: gen_random_uuid() is built into Postgres 13+, so we
-- avoid depending on pgcrypto being installed in a particular schema.

-- ── Schemas (one per module — ARCHITECTURE.md §4.2) ────────────────────────
create schema if not exists core;      -- orgs, users, memberships, jobs, outbox
create schema if not exists audit;     -- append-only audit trail
create schema if not exists crm;       -- contacts, leads, activities
create schema if not exists sales;     -- opportunities, proposals
create schema if not exists projects;  -- projects, milestones, tasks
create schema if not exists finance;   -- invoices, payments
create schema if not exists ai;        -- agents, runs, steps, cost

comment on schema core is 'Platform primitives: tenancy, identity, jobs, events.';
comment on schema audit is 'Append-only audit trail. No UPDATE or DELETE, ever.';
comment on schema crm is 'Lead CRM: contacts, leads, activities.';
comment on schema sales is 'Opportunities and proposals.';
comment on schema projects is 'Delivery: projects, milestones, tasks.';
comment on schema finance is 'Invoicing and payments.';
comment on schema ai is 'Agent registry, runs, steps, and cost accounting.';

-- ═══════════════════════════════════════════════════════════════════════════
-- CLAIM ACCESSORS
--
-- Every RLS policy reads tenancy from these, never from request data. The
-- values come from a signed JWT that the client cannot forge; the token hook
-- that populates them ships in Feature 3 (Authentication).
--
-- Until then these return NULL, so every RLS policy denies. That is the
-- correct failure direction: a schema with no auth yet should expose nothing.
--
-- plpgsql with an exception block rather than a plain cast: a malformed claim
-- must not error the caller's entire query.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.current_organization_id()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare v text;
begin
  v := nullif(auth.jwt() -> 'app_metadata' ->> 'organization_id', '');
  if v is null then return null; end if;
  return v::uuid;
exception when others then
  return null;
end;
$$;

create or replace function core.current_user_role()
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  return nullif(auth.jwt() -> 'app_metadata' ->> 'role', '');
exception when others then
  return null;
end;
$$;

create or replace function core.current_client_account_id()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare v text;
begin
  v := nullif(auth.jwt() -> 'app_metadata' ->> 'client_account_id', '');
  if v is null then return null; end if;
  return v::uuid;
exception when others then
  return null;
end;
$$;

-- Internal staff roles. Client portal users are deliberately excluded.
create or replace function core.is_internal()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select core.current_user_role() in
    ('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor');
$$;

create or replace function core.is_client()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select core.current_user_role() in ('client_admin', 'client_member');
$$;

-- Roles permitted to mutate operational data.
create or replace function core.can_write()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select core.current_user_role() in ('owner', 'ops_admin', 'delivery_lead', 'member');
$$;

create or replace function core.is_owner()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select core.current_user_role() = 'owner';
$$;

comment on function core.current_organization_id() is
  'Tenant id from the verified JWT. NULL until the Feature 3 token hook lands, which makes every RLS policy deny.';

-- ── Shared updated_at trigger ──────────────────────────────────────────────
create or replace function core.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- GRANTS
--
-- Supabase's model: grant broadly at the SQL level, then gate every row with
-- RLS. A grant here is necessary but never sufficient — no policy, no access.
--
-- `anon` gets SELECT only. Unauthenticated users have no organization claim,
-- so RLS denies regardless; this is defence in depth.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare s text;
begin
  foreach s in array array['core','audit','crm','sales','projects','finance','ai']
  loop
    execute format('grant usage on schema %I to anon, authenticated, service_role', s);

    execute format('grant select on all tables in schema %I to anon', s);
    execute format('grant select, insert, update, delete on all tables in schema %I to authenticated', s);
    execute format('grant all on all tables in schema %I to service_role', s);
    execute format('grant usage, select on all sequences in schema %I to authenticated, service_role', s);

    execute format('alter default privileges in schema %I grant select on tables to anon', s);
    execute format('alter default privileges in schema %I grant select, insert, update, delete on tables to authenticated', s);
    execute format('alter default privileges in schema %I grant all on tables to service_role', s);
    execute format('alter default privileges in schema %I grant usage, select on sequences to authenticated, service_role', s);
  end loop;
end;
$$;


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120002_core.sql                                               ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

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


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120003_audit.sql                                              ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 003 — audit: append-only trail
--
-- Append-only is enforced by omission: there is no UPDATE policy and no DELETE
-- policy, so no role short of service_role can rewrite history. A trigger
-- blocks it too, in case a policy is ever added by mistake.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists audit.audit_log (
  id               bigserial primary key,
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  actor_type       text not null check (actor_type in ('user', 'agent', 'system', 'client')),
  actor_id         uuid,

  action           text not null,        -- 'lead.qualified', 'deliverable.approved'
  subject_type     text not null,        -- 'lead', 'deliverable'
  subject_id       uuid,

  before           jsonb,
  after            jsonb,

  correlation_id   uuid,
  ip               inet,
  user_agent       text,

  created_at       timestamptz not null default now()
);

create index if not exists audit_log_subject_idx
  on audit.audit_log (organization_id, subject_type, subject_id, created_at desc);

create index if not exists audit_log_actor_idx
  on audit.audit_log (organization_id, actor_id, created_at desc);

create index if not exists audit_log_action_idx
  on audit.audit_log (organization_id, action, created_at desc);

create index if not exists audit_log_correlation_idx
  on audit.audit_log (correlation_id) where correlation_id is not null;

comment on table audit.audit_log is
  'Append-only. Every gated state transition writes here in the same transaction as the change itself.';

-- Immutability guard, independent of RLS.
create or replace function audit.reject_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'audit.audit_log is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists audit_log_no_update on audit.audit_log;
create trigger audit_log_no_update
  before update on audit.audit_log
  for each row execute function audit.reject_mutation();

drop trigger if exists audit_log_no_delete on audit.audit_log;
create trigger audit_log_no_delete
  before delete on audit.audit_log
  for each row execute function audit.reject_mutation();

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table audit.audit_log enable row level security;

-- Owners and ops read the trail. Deliberately not readable by clients.
drop policy if exists audit_log_select on audit.audit_log;
create policy audit_log_select on audit.audit_log
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  );

-- Anyone acting inside the organization may append, but only about themselves:
-- a user cannot attribute an action to someone else.
drop policy if exists audit_log_insert on audit.audit_log;
create policy audit_log_insert on audit.audit_log
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (
      (actor_type = 'user'   and actor_id = (select auth.uid()))
      or (actor_type = 'client' and actor_id = (select auth.uid()))
    )
  );

-- No UPDATE or DELETE policy exists, by design.


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120004_crm.sql                                                ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 004 — crm: contacts, leads, activities
--
-- Backs Feature 4 (Lead CRM), Feature 6 (AI Requirement Collection), and
-- Feature 7 (WhatsApp Integration).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── contacts (a person; may or may not be attached to a client account) ───
create table if not exists crm.contacts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid references core.client_accounts(id) on delete set null,

  full_name          text not null check (length(trim(full_name)) > 0),
  email              text,
  phone              text,          -- E.164, e.g. +919876543210
  company            text,
  job_title          text,
  notes              text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- A contact must be reachable somehow, or it is not a contact.
  constraint contacts_reachable check (email is not null or phone is not null)
);

create index if not exists contacts_organization_idx on crm.contacts (organization_id);
create index if not exists contacts_account_idx
  on crm.contacts (client_account_id) where client_account_id is not null;

-- Dedupe within an organization, case-insensitively.
create unique index if not exists contacts_org_email_key
  on crm.contacts (organization_id, lower(email)) where email is not null;
create unique index if not exists contacts_org_phone_key
  on crm.contacts (organization_id, phone) where phone is not null;

-- ── leads ─────────────────────────────────────────────────────────────────
create table if not exists crm.leads (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  contact_id         uuid references crm.contacts(id) on delete set null,

  title              text not null check (length(trim(title)) > 0),
  summary            text,

  source             text not null default 'manual' check (source in
                       ('manual', 'whatsapp', 'web_form', 'email', 'referral', 'import')),
  -- Provider-side identifier (e.g. WhatsApp wa_id) for dedupe on ingest.
  source_ref         text,

  status             text not null default 'new' check (status in
                       ('new', 'qualifying', 'qualified', 'disqualified', 'converted')),

  -- Written by the Lead Qualifier agent (Feature 6). Null until it runs.
  score              smallint check (score between 0 and 100),
  score_reasons      jsonb,
  tags               text[] not null default '{}',

  assigned_to        uuid references core.users(id) on delete set null,

  -- Free-form requirements gathered by the AI agent / WhatsApp thread.
  requirements       jsonb not null default '{}'::jsonb,

  qualified_at       timestamptz,
  converted_at       timestamptz,
  disqualified_reason text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  -- Terminal states must record when they happened.
  constraint leads_qualified_at_set
    check (status <> 'qualified' or qualified_at is not null),
  constraint leads_converted_at_set
    check (status <> 'converted' or converted_at is not null)
);

create index if not exists leads_organization_status_idx
  on crm.leads (organization_id, status, created_at desc) where deleted_at is null;

create index if not exists leads_assigned_idx
  on crm.leads (organization_id, assigned_to) where deleted_at is null;

create index if not exists leads_contact_idx on crm.leads (contact_id);

create index if not exists leads_score_idx
  on crm.leads (organization_id, score desc nulls last) where deleted_at is null;

create index if not exists leads_tags_idx on crm.leads using gin (tags);

-- Ingest idempotency: one lead per provider reference per source.
create unique index if not exists leads_source_ref_key
  on crm.leads (organization_id, source, source_ref) where source_ref is not null;

comment on column crm.leads.requirements is
  'Structured requirements collected by the AI agent. Schema-on-read for now; promoted to columns once the shape settles.';

-- ── lead_activities (timeline: notes, messages, status changes) ───────────
create table if not exists crm.lead_activities (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  lead_id          uuid not null references crm.leads(id) on delete cascade,

  kind             text not null check (kind in
                     ('note', 'status_change', 'message_in', 'message_out',
                      'call', 'agent_run', 'assignment')),
  body             text,
  metadata         jsonb not null default '{}'::jsonb,

  actor_type       text not null default 'user' check (actor_type in ('user', 'agent', 'system', 'client')),
  actor_id         uuid,

  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index if not exists lead_activities_lead_idx
  on crm.lead_activities (lead_id, occurred_at desc);

create index if not exists lead_activities_organization_idx
  on crm.lead_activities (organization_id, occurred_at desc);

-- ── triggers ──────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['contacts','leads']
  loop
    execute format('drop trigger if exists set_updated_at on crm.%I', t);
    execute format(
      'create trigger set_updated_at before update on crm.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ── RLS: internal staff only. Leads are never client-visible. ─────────────
alter table crm.contacts        enable row level security;
alter table crm.leads           enable row level security;
alter table crm.lead_activities enable row level security;

drop policy if exists contacts_select on crm.contacts;
create policy contacts_select on crm.contacts
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists contacts_write on crm.contacts;
create policy contacts_write on crm.contacts
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop policy if exists leads_select on crm.leads;
create policy leads_select on crm.leads
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists leads_write on crm.leads;
create policy leads_write on crm.leads
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop policy if exists lead_activities_select on crm.lead_activities;
create policy lead_activities_select on crm.lead_activities
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists lead_activities_insert on crm.lead_activities;
create policy lead_activities_insert on crm.lead_activities
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write()));


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120005_sales.sql                                              ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 005 — sales: opportunities and proposals
--
-- Spine only. Quote pricing rules, versioning, and the approval join land with
-- the sales feature; this establishes the tenancy, keys, and RLS shape now so
-- later migrations are additive.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists sales.opportunities (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  lead_id            uuid references crm.leads(id) on delete set null,
  client_account_id  uuid references core.client_accounts(id) on delete set null,

  name               text not null check (length(trim(name)) > 0),
  stage              text not null default 'discovery' check (stage in
                       ('discovery', 'proposal', 'negotiation', 'won', 'lost')),

  currency           char(3) not null default 'INR',
  value_minor        bigint not null default 0 check (value_minor >= 0),

  expected_close_on  date,
  closed_at          timestamptz,
  lost_reason        text,

  owner_id           uuid references core.users(id) on delete set null,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint opportunities_closed_at_set
    check (stage not in ('won', 'lost') or closed_at is not null)
);

create index if not exists opportunities_organization_stage_idx
  on sales.opportunities (organization_id, stage, created_at desc);
create index if not exists opportunities_lead_idx on sales.opportunities (lead_id);
create index if not exists opportunities_account_idx on sales.opportunities (client_account_id);

create table if not exists sales.proposals (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  opportunity_id     uuid not null references sales.opportunities(id) on delete cascade,

  version            int not null default 1 check (version > 0),
  title              text not null,
  body               text,

  status             text not null default 'draft' check (status in
                       ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected')),

  currency           char(3) not null default 'INR',
  subtotal_minor     bigint not null default 0 check (subtotal_minor >= 0),
  tax_minor          bigint not null default 0 check (tax_minor >= 0),
  total_minor        bigint not null default 0 check (total_minor >= 0),

  -- Set when an AI agent drafted it; null when a human wrote it.
  generated_by_run_id uuid,

  sent_at            timestamptz,
  decided_at         timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (opportunity_id, version)
);

create index if not exists proposals_organization_status_idx
  on sales.proposals (organization_id, status, created_at desc);

create table if not exists sales.proposal_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  proposal_id      uuid not null references sales.proposals(id) on delete cascade,

  position         int not null default 0,
  description      text not null,
  quantity         numeric(12, 2) not null default 1 check (quantity > 0),
  unit_price_minor bigint not null default 0 check (unit_price_minor >= 0),
  amount_minor     bigint not null default 0 check (amount_minor >= 0),

  created_at       timestamptz not null default now()
);

create index if not exists proposal_items_proposal_idx
  on sales.proposal_items (proposal_id, position);

do $$
declare t text;
begin
  foreach t in array array['opportunities','proposals']
  loop
    execute format('drop trigger if exists set_updated_at on sales.%I', t);
    execute format(
      'create trigger set_updated_at before update on sales.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table sales.opportunities  enable row level security;
alter table sales.proposals      enable row level security;
alter table sales.proposal_items enable row level security;

-- Policy names are built as whole identifiers, not by concatenating a suffix
-- onto a %I placeholder: format('%I_select', t) quotes only `t` and yields
-- "opportunities"_select, which is a syntax error.
do $$
declare
  t text;
  select_policy text;
  write_policy text;
begin
  foreach t in array array['opportunities','proposals','proposal_items']
  loop
    select_policy := t || '_select';
    write_policy  := t || '_write';

    execute format('drop policy if exists %I on sales.%I', select_policy, t);
    execute format(
      'create policy %I on sales.%I for select to authenticated
         using (organization_id = (select core.current_organization_id())
                and (select core.is_internal()))', select_policy, t);

    execute format('drop policy if exists %I on sales.%I', write_policy, t);
    execute format(
      'create policy %I on sales.%I for all to authenticated
         using (organization_id = (select core.current_organization_id())
                and (select core.can_write()))
         with check (organization_id = (select core.current_organization_id())
                and (select core.can_write()))', write_policy, t);
  end loop;
end;
$$;


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120006_projects.sql                                           ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

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


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120007_finance.sql                                            ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 007 — finance: invoices, line items, payments
--
-- All money is BIGINT minor units (paise for INR, cents for USD) plus an ISO
-- currency. Never floating point: 0.1 + 0.2 must not be a billing question.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance.invoices (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  project_id         uuid references projects.projects(id) on delete set null,
  milestone_id       uuid references projects.milestones(id) on delete set null,

  number             text not null,
  status             text not null default 'draft' check (status in
                       ('draft', 'pending_approval', 'issued', 'partially_paid',
                        'paid', 'void', 'overdue')),

  currency           char(3) not null default 'INR',
  subtotal_minor     bigint not null default 0 check (subtotal_minor >= 0),
  tax_minor          bigint not null default 0 check (tax_minor >= 0),
  total_minor        bigint not null default 0 check (total_minor >= 0),
  paid_minor         bigint not null default 0 check (paid_minor >= 0),

  notes              text,
  provider_ref       text,

  issued_at          timestamptz,
  due_at             timestamptz,
  paid_at            timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (organization_id, number),

  constraint invoices_paid_not_over_total check (paid_minor <= total_minor),
  constraint invoices_issued_at_set check (status = 'draft' or status = 'pending_approval' or issued_at is not null),
  constraint invoices_paid_at_set check (status <> 'paid' or paid_at is not null)
);

create index if not exists invoices_organization_status_idx
  on finance.invoices (organization_id, status, due_at);
create index if not exists invoices_account_idx
  on finance.invoices (client_account_id, status);
create index if not exists invoices_milestone_idx on finance.invoices (milestone_id);

create table if not exists finance.invoice_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  invoice_id       uuid not null references finance.invoices(id) on delete cascade,

  position         int not null default 0,
  description      text not null,
  quantity         numeric(12, 2) not null default 1 check (quantity > 0),
  unit_price_minor bigint not null default 0 check (unit_price_minor >= 0),
  amount_minor     bigint not null default 0 check (amount_minor >= 0),
  tax_rate_bp      int not null default 0 check (tax_rate_bp between 0 and 10000),  -- basis points

  created_at       timestamptz not null default now()
);

create index if not exists invoice_items_invoice_idx
  on finance.invoice_items (invoice_id, position);

comment on column finance.invoice_items.tax_rate_bp is
  'Tax rate in basis points (1800 = 18% GST). Integer, so rates never round.';

create table if not exists finance.payments (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  invoice_id           uuid not null references finance.invoices(id) on delete restrict,

  provider             text not null default 'razorpay',
  provider_payment_id  text not null,

  amount_minor         bigint not null check (amount_minor > 0),
  currency             char(3) not null default 'INR',

  status               text not null check (status in
                         ('created', 'authorized', 'captured', 'failed', 'refunded')),

  captured_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Webhook idempotency: a provider payment lands at most once, enforced by
  -- the database rather than by application checks that race under concurrency.
  unique (provider, provider_payment_id)
);

create index if not exists payments_invoice_idx on finance.payments (invoice_id, status);
create index if not exists payments_organization_idx on finance.payments (organization_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['invoices','payments']
  loop
    execute format('drop trigger if exists set_updated_at on finance.%I', t);
    execute format(
      'create trigger set_updated_at before update on finance.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table finance.invoices      enable row level security;
alter table finance.invoice_items enable row level security;
alter table finance.payments      enable row level security;

-- Clients see their own invoices once issued — never drafts.
drop policy if exists invoices_select on finance.invoices;
create policy invoices_select on finance.invoices
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or (
        (select core.is_client())
        and client_account_id = (select core.current_client_account_id())
        and status not in ('draft', 'pending_approval')
      )
    )
  );

-- Only owners and ops touch money.
drop policy if exists invoices_write on finance.invoices;
create policy invoices_write on finance.invoices
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'))
  with check (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'));

drop policy if exists invoice_items_select on finance.invoice_items;
create policy invoice_items_select on finance.invoice_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and exists (
      select 1 from finance.invoices i
       where i.id = invoice_items.invoice_id
    )
  );

drop policy if exists invoice_items_write on finance.invoice_items;
create policy invoice_items_write on finance.invoice_items
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'))
  with check (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'));

-- Payments are written by the webhook handler under service_role, which
-- bypasses RLS. Humans read only.
drop policy if exists payments_select on finance.payments;
create policy payments_select on finance.payments
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.current_user_role()) in ('owner', 'ops_admin')
      or (
        (select core.is_client())
        and exists (
          select 1 from finance.invoices i
           where i.id = payments.invoice_id
             and i.client_account_id = (select core.current_client_account_id())
        )
      )
    )
  );


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120008_ai.sql                                                 ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 008 — ai: agent registry, runs, steps, cost
--
-- Two things this schema exists to guarantee (ARCHITECTURE.md §6):
--   1. Every agent action is traceable to the exact prompt version that
--      produced it.
--   2. Every token is counted, so cost per lead and cost per project are
--      measurable from day one rather than discovered in a bill.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── agents (registry; global, not tenant-owned) ───────────────────────────
create table if not exists ai.agents (
  key              text primary key check (key ~ '^[a-z][a-z0-9_]{2,48}$'),
  display_name     text not null,
  description      text,

  -- L0 read-only · L1 propose (requires approval) · L2 autonomous within limits
  autonomy_level   text not null default 'L1' check (autonomy_level in ('L0', 'L1', 'L2')),

  enabled          boolean not null default true,   -- per-agent kill switch

  default_model    text not null,
  default_effort   text not null default 'medium'
                     check (default_effort in ('low', 'medium', 'high', 'xhigh', 'max')),

  max_steps        int not null default 12 check (max_steps > 0),
  max_cost_minor   bigint not null default 5000 check (max_cost_minor > 0),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table ai.agents is
  'Agent configuration as data, so demoting a misbehaving agent to L0 or killing it is an UPDATE, not a deploy.';

-- ── agent_runs ────────────────────────────────────────────────────────────
create table if not exists ai.agent_runs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  agent_key             text not null references ai.agents(key) on delete restrict,

  trigger               text not null,      -- 'event:lead.created' | 'user:<uuid>'
  subject_type          text,
  subject_id            uuid,

  status                text not null default 'queued' check (status in
                          ('queued', 'running', 'awaiting_approval', 'succeeded',
                           'failed', 'cancelled', 'budget_exceeded')),

  input                 jsonb,
  output                jsonb,

  -- Reproducibility: the exact prompt bytes that produced this output.
  prompt_key            text,
  prompt_version        text,
  prompt_hash           text,
  model                 text,

  input_tokens          int not null default 0 check (input_tokens >= 0),
  output_tokens         int not null default 0 check (output_tokens >= 0),
  cache_read_tokens     int not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens    int not null default 0 check (cache_write_tokens >= 0),
  cost_minor            bigint not null default 0 check (cost_minor >= 0),

  step_count            int not null default 0 check (step_count >= 0),
  error                 text,
  correlation_id        uuid,

  started_at            timestamptz,
  finished_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists agent_runs_organization_status_idx
  on ai.agent_runs (organization_id, status, created_at desc);
create index if not exists agent_runs_agent_idx
  on ai.agent_runs (organization_id, agent_key, created_at desc);
create index if not exists agent_runs_subject_idx
  on ai.agent_runs (subject_type, subject_id);
create index if not exists agent_runs_correlation_idx
  on ai.agent_runs (correlation_id) where correlation_id is not null;

-- ── agent_steps (one row per model call or tool call) ─────────────────────
create table if not exists ai.agent_steps (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  run_id           uuid not null references ai.agent_runs(id) on delete cascade,

  seq              int not null check (seq >= 0),
  kind             text not null check (kind in
                     ('model_call', 'tool_call', 'validation', 'decision')),

  request          jsonb,
  response         jsonb,

  tokens_in        int not null default 0 check (tokens_in >= 0),
  tokens_out       int not null default 0 check (tokens_out >= 0),
  cost_minor       bigint not null default 0 check (cost_minor >= 0),
  latency_ms       int check (latency_ms >= 0),

  error            text,
  created_at       timestamptz not null default now(),

  unique (run_id, seq)
);

create index if not exists agent_steps_run_idx on ai.agent_steps (run_id, seq);

comment on table ai.agent_steps is
  'One row per step. A run is resumed from its last persisted step, which is what lets an agent survive a killed serverless invocation (ARCHITECTURE.md §6.3).';

-- ── cost_ledger (nightly rollup; the budget check reads this) ─────────────
create table if not exists ai.cost_ledger (
  id               bigserial primary key,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  day              date not null,
  agent_key        text not null references ai.agents(key) on delete cascade,
  model            text not null,

  runs             int not null default 0 check (runs >= 0),
  input_tokens     bigint not null default 0 check (input_tokens >= 0),
  output_tokens    bigint not null default 0 check (output_tokens >= 0),
  cost_minor       bigint not null default 0 check (cost_minor >= 0),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (organization_id, day, agent_key, model)
);

create index if not exists cost_ledger_day_idx on ai.cost_ledger (organization_id, day desc);

do $$
declare t text;
begin
  foreach t in array array['agents','agent_runs','cost_ledger']
  loop
    execute format('drop trigger if exists set_updated_at on ai.%I', t);
    execute format(
      'create trigger set_updated_at before update on ai.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table ai.agents      enable row level security;
alter table ai.agent_runs  enable row level security;
alter table ai.agent_steps enable row level security;
alter table ai.cost_ledger enable row level security;

-- Registry is readable by any signed-in staff member; only owners change it.
drop policy if exists agents_select on ai.agents;
create policy agents_select on ai.agents
  for select to authenticated
  using ((select core.is_internal()));

drop policy if exists agents_write on ai.agents;
create policy agents_write on ai.agents
  for all to authenticated
  using ((select core.is_owner()))
  with check ((select core.is_owner()));

drop policy if exists agent_runs_select on ai.agent_runs;
create policy agent_runs_select on ai.agent_runs
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists agent_steps_select on ai.agent_steps;
create policy agent_steps_select on ai.agent_steps
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists cost_ledger_select on ai.cost_ledger;
create policy cost_ledger_select on ai.cost_ledger
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'));

-- Runs and steps are written exclusively by the job runner under service_role,
-- which bypasses RLS. No INSERT/UPDATE policy exists for authenticated users:
-- an agent trace nobody can forge is the point.


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120009_health_check.sql                                       ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 009 — public.health_check()
--
-- Upgrades /api/health from its "schema-cache" fallback probe to a genuine
-- database round trip. The route already prefers this function and falls back
-- only when it is absent, so no application change is needed: the probe field
-- flips from "schema-cache" to "rpc" the moment this migration lands.
--
-- Lives in `public` because that schema is exposed to PostgREST by default,
-- so the health check keeps working even if the module schemas are not yet
-- added to the project's exposed-schema list.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.health_check()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'server_time', now(),
    'database', current_database()
  );
$$;

comment on function public.health_check() is
  'Liveness probe for /api/health. Executes in Postgres, so a successful reply proves the database is serving queries — not merely that PostgREST is running.';

grant execute on function public.health_check() to anon, authenticated, service_role;


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120010_expose_schemas.sql                                     ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 010 — Expose the module schemas to PostgREST
--
-- PostgREST serves only the schemas on its exposed list. Without this the
-- tables exist but every query fails with PGRST106, which reads like a missing
-- table and wastes an afternoon.
--
-- Doing it in SQL rather than leaving it as a dashboard step means a fresh
-- environment comes up correctly from migrations alone.
--
-- Guarded: altering the `authenticator` role requires elevated privileges that
-- some environments withhold. If it is not permitted we warn and continue —
-- the fallback is Project Settings → API → Exposed schemas.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  target_schemas constant text :=
    'public, graphql_public, core, audit, crm, sales, projects, finance, ai';
begin
  execute format('alter role authenticator set pgrst.db_schemas = %L', target_schemas);
  perform pg_notify('pgrst', 'reload config');
  raise notice 'PostgREST exposed schemas set to: %', target_schemas;
exception
  when insufficient_privilege or undefined_object then
    raise warning
      'Could not set exposed schemas automatically (%). Add them manually: Project Settings -> API -> Exposed schemas.',
      sqlerrm;
end;
$$;


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260807120011_auth_hook.sql                                          ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 011 — Authentication: token claims hook, profile sync, bootstrap
--
-- This migration is what makes Feature 2's RLS actually work. Until now
-- core.current_organization_id() returned NULL for everyone and every policy
-- denied. The hook below runs at token issuance and stamps the tenancy claims
-- those policies read.
--
-- REQUIRES A DASHBOARD STEP: Authentication → Hooks → Customize Access Token
-- must be pointed at core.custom_access_token_hook. Without it the function
-- exists but is never called, and every policy keeps denying.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- Profile sync: auth.users → core.users
--
-- SECURITY DEFINER because the trigger fires in the auth subsystem's context,
-- which has no rights on core.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into core.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
     set email      = excluded.email,
         full_name  = coalesce(excluded.full_name, core.users.full_name),
         avatar_url = coalesce(excluded.avatar_url, core.users.avatar_url);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function core.handle_new_auth_user();

-- ═══════════════════════════════════════════════════════════════════════════
-- V1 bootstrap: the first user to sign in becomes owner.
--
-- Without this there is a deadlock: memberships grant claims, claims are
-- required to write memberships, and nobody can create the first one. The
-- guard is deliberately narrow — it fires only when there are zero memberships
-- and exactly one organization, i.e. a fresh single-tenant install.
--
-- When multi-tenant signup arrives this becomes an invite flow and this
-- function should be dropped.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.bootstrap_first_owner(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_org_count int;
  v_member_count int;
begin
  select count(*) into v_member_count from core.memberships;
  if v_member_count > 0 then
    return null;
  end if;

  select count(*) into v_org_count from core.organizations;
  if v_org_count <> 1 then
    return null;
  end if;

  select id into v_org_id from core.organizations limit 1;

  insert into core.memberships (organization_id, user_id, role, status)
  values (v_org_id, p_user_id, 'owner', 'active')
  on conflict (organization_id, user_id) do nothing;

  return v_org_id;
end;
$$;

revoke all on function core.bootstrap_first_owner(uuid) from public, anon;
grant execute on function core.bootstrap_first_owner(uuid) to authenticated, service_role;

-- PostgREST resolves rpc() against `public`, and `public` is always exposed.
-- This thin wrapper keeps the logic in core while giving the app one reliable
-- entry point that works before the module schemas are on the exposed list.
create or replace function public.bootstrap_first_owner(p_user_id uuid)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select core.bootstrap_first_owner(p_user_id);
$$;

revoke all on function public.bootstrap_first_owner(uuid) from public, anon;
grant execute on function public.bootstrap_first_owner(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- CUSTOM ACCESS TOKEN HOOK
--
-- Supabase Auth calls this on every token issue and refresh. Whatever it puts
-- in app_metadata becomes a signed claim the client cannot forge — which is
-- precisely why RLS trusts it and never trusts request data.
--
-- Resolution order:
--   1. internal staff  → core.memberships       (organization_id, role)
--   2. portal user     → core.client_users      (+ client_account_id)
--   3. neither         → no claims, so RLS denies everything
--
-- SECURITY DEFINER so it can read those tables regardless of RLS. It returns
-- only claims, never rows.
--
-- It must never throw: an exception here breaks login entirely. The exception
-- handler degrades to a claimless token, which denies access rather than
-- granting it.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_claims jsonb;
  v_app_metadata jsonb;
  v_membership record;
  v_client_user record;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_claims := coalesce(event -> 'claims', '{}'::jsonb);
  v_app_metadata := coalesce(v_claims -> 'app_metadata', '{}'::jsonb);

  -- 1. Internal staff
  select m.organization_id, m.role
    into v_membership
    from core.memberships m
   where m.user_id = v_user_id
     and m.status = 'active'
   order by
     case m.role
       when 'owner' then 1
       when 'ops_admin' then 2
       when 'delivery_lead' then 3
       when 'member' then 4
       else 5
     end
   limit 1;

  if found then
    v_app_metadata := v_app_metadata
      || jsonb_build_object(
           'organization_id', v_membership.organization_id,
           'role', v_membership.role,
           'audience', 'internal'
         );
  else
    -- 2. Client portal user
    select cu.organization_id, cu.client_account_id, cu.role
      into v_client_user
      from core.client_users cu
     where cu.user_id = v_user_id
       and cu.status = 'active'
     limit 1;

    if found then
      v_app_metadata := v_app_metadata
        || jsonb_build_object(
             'organization_id', v_client_user.organization_id,
             'client_account_id', v_client_user.client_account_id,
             'role', v_client_user.role,
             'audience', 'client'
           );
    end if;
  end if;

  v_claims := jsonb_set(v_claims, '{app_metadata}', v_app_metadata);
  return jsonb_set(event, '{claims}', v_claims);

exception when others then
  -- Never break sign-in. A claimless token means RLS denies, which is the
  -- safe direction to fail.
  raise warning 'custom_access_token_hook failed for %: %', v_user_id, sqlerrm;
  return event;
end;
$$;

-- Only the auth subsystem may invoke the hook.
revoke all on function core.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function core.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- The auth role needs to reach the tables the hook reads. Guarded because
-- supabase_auth_admin does not exist on every Postgres deployment.
do $$
begin
  execute 'grant usage on schema core to supabase_auth_admin';
  execute 'grant select on core.memberships to supabase_auth_admin';
  execute 'grant select on core.client_users to supabase_auth_admin';
  execute 'grant select on core.organizations to supabase_auth_admin';
exception when undefined_object then
  raise warning 'supabase_auth_admin role not present; skipping hook grants.';
end;
$$;

comment on function core.custom_access_token_hook(jsonb) is
  'Supabase Auth token hook. Stamps organization_id, role, and client_account_id into app_metadata so RLS can trust them. Enable at Authentication -> Hooks -> Customize Access Token.';


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260808120001_crm_requirement_collection.sql                         ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 012 — crm: requirement collection (conversations, messages, requirements)
--
-- Backs Feature 6 (AI Requirement Collection), which migration 004 already
-- named as a consumer of the crm schema. The `requirement_collector` agent is
-- already registered in ai.agents by the seed; this migration gives it
-- somewhere to read from and somewhere to write to.
--
-- Why these are new tables rather than reuse:
--   • crm.lead_activities is a mixed lead timeline (notes, status changes,
--     assignments). It has no thread grouping, no intra-thread ordering, and
--     no channel, so it cannot serve as a transcript. It is left untouched.
--   • crm.leads.requirements is a single unversioned jsonb blob, documented as
--     "schema-on-read for now". It is left untouched; requirement_versions is
--     the versioned successor and the two do not fight over one row.
--
-- Vocabularies are reused verbatim rather than reinvented:
--   • conversations.channel  ⊂ crm.leads.source
--   • conversation_messages.author_type = crm.lead_activities.actor_type
--   • requirement_versions   mirrors sales.proposals: `version` + unique
--     (parent, version) + an FK-less `generated_by_run_id`.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── conversations ─────────────────────────────────────────────────────────
create table if not exists crm.conversations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  lead_id            uuid not null references crm.leads(id) on delete cascade,
  -- Denormalised from the lead so a conversation can name the specific person
  -- spoken to, which may differ from the lead's primary contact.
  contact_id         uuid references crm.contacts(id) on delete set null,

  channel            text not null default 'manual' check (channel in
                       ('manual', 'whatsapp', 'web_form', 'email')),

  status             text not null default 'active' check (status in
                       ('active', 'completed', 'abandoned')),

  -- Provider-side thread id (e.g. WhatsApp conversation id) for ingest
  -- idempotency. Mirrors crm.leads.source_ref.
  external_ref       text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists conversations_organization_status_idx
  on crm.conversations (organization_id, status, created_at desc);
create index if not exists conversations_lead_idx
  on crm.conversations (lead_id, created_at desc);
create index if not exists conversations_contact_idx
  on crm.conversations (contact_id) where contact_id is not null;

-- Ingest idempotency: one conversation per provider thread per channel.
create unique index if not exists conversations_external_ref_key
  on crm.conversations (organization_id, channel, external_ref)
  where external_ref is not null;

comment on table crm.conversations is
  'A requirement-gathering thread with a lead. The transcript lives in crm.conversation_messages; extracted requirements in crm.requirement_versions.';

-- ── conversation_messages ─────────────────────────────────────────────────
create table if not exists crm.conversation_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  conversation_id  uuid not null references crm.conversations(id) on delete cascade,

  -- Ordering within the thread. Explicit rather than timestamp-derived so two
  -- messages in the same millisecond still have a defined order. Mirrors
  -- ai.agent_steps.seq.
  seq              int not null check (seq >= 0),

  -- Same vocabulary as crm.lead_activities.actor_type: 'client' is the
  -- customer, 'user' a staff member, 'agent' the AI.
  author_type      text not null check (author_type in ('user', 'agent', 'system', 'client')),
  author_id        uuid,

  body             text not null check (length(trim(body)) > 0),

  -- Room for future AI processing (token counts, extraction markers, provider
  -- message ids) without a migration per field.
  metadata         jsonb not null default '{}'::jsonb,

  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  unique (conversation_id, seq)
);

create index if not exists conversation_messages_thread_idx
  on crm.conversation_messages (conversation_id, seq);
create index if not exists conversation_messages_organization_idx
  on crm.conversation_messages (organization_id, occurred_at desc);

comment on table crm.conversation_messages is
  'Append-only transcript. There is deliberately no UPDATE or DELETE policy: a record of what a customer actually said is not something the app should be able to rewrite.';

-- ── requirement_versions ──────────────────────────────────────────────────
create table if not exists crm.requirement_versions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  conversation_id     uuid not null references crm.conversations(id) on delete cascade,

  version             int not null check (version > 0),

  source              text not null check (source in ('agent', 'human')),

  -- The requirement_collector agent is L1 (propose), so an extraction lands as
  -- 'proposed' and a human decides. Editing means inserting the next version,
  -- not mutating this row — see the guard trigger below.
  status              text not null default 'proposed' check (status in
                        ('proposed', 'accepted', 'rejected', 'superseded')),

  payload             jsonb not null default '{}'::jsonb,

  -- Set when an AI agent produced it; null when a human wrote it. FK-less by
  -- the same reasoning as sales.proposals.generated_by_run_id: crm should not
  -- take a hard dependency on the ai schema.
  generated_by_run_id uuid,
  created_by          uuid,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (conversation_id, version)
);

create index if not exists requirement_versions_conversation_idx
  on crm.requirement_versions (conversation_id, version desc);
create index if not exists requirement_versions_organization_idx
  on crm.requirement_versions (organization_id, created_at desc);
create index if not exists requirement_versions_status_idx
  on crm.requirement_versions (organization_id, status, created_at desc);

comment on table crm.requirement_versions is
  'Structured requirements extracted from a conversation. Append-only history: a correction is version N+1, so what the agent originally proposed stays auditable.';

-- ── triggers ──────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['conversations','requirement_versions']
  loop
    execute format('drop trigger if exists set_updated_at on crm.%I', t);
    execute format(
      'create trigger set_updated_at before update on crm.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- Versioning is only real if the versioned bytes cannot be edited in place.
create or replace function crm.requirement_versions_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.organization_id     is distinct from old.organization_id
     or new.conversation_id  is distinct from old.conversation_id
     or new.version          is distinct from old.version
     or new.source           is distinct from old.source
     or new.payload          is distinct from old.payload
     or new.generated_by_run_id is distinct from old.generated_by_run_id
     or new.created_by       is distinct from old.created_by
     or new.created_at       is distinct from old.created_at
  then
    raise exception
      'crm.requirement_versions is append-only except for status; insert version % instead',
      old.version + 1
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists requirement_versions_guard on crm.requirement_versions;
create trigger requirement_versions_guard
  before update on crm.requirement_versions
  for each row execute function crm.requirement_versions_guard();

-- ── RLS: internal staff only, same shape as the rest of crm ───────────────
alter table crm.conversations         enable row level security;
alter table crm.conversation_messages enable row level security;
alter table crm.requirement_versions  enable row level security;

drop policy if exists conversations_select on crm.conversations;
create policy conversations_select on crm.conversations
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists conversations_write on crm.conversations;
create policy conversations_write on crm.conversations
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop policy if exists conversation_messages_select on crm.conversation_messages;
create policy conversation_messages_select on crm.conversation_messages
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- Insert only. See the table comment: the transcript is not rewritable.
drop policy if exists conversation_messages_insert on crm.conversation_messages;
create policy conversation_messages_insert on crm.conversation_messages
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write()));

drop policy if exists requirement_versions_select on crm.requirement_versions;
create policy requirement_versions_select on crm.requirement_versions
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists requirement_versions_insert on crm.requirement_versions;
create policy requirement_versions_insert on crm.requirement_versions
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write()));

-- UPDATE is permitted so a human can accept/reject/supersede a proposal. The
-- guard trigger above is what keeps that from becoming an in-place edit.
drop policy if exists requirement_versions_update on crm.requirement_versions;
create policy requirement_versions_update on crm.requirement_versions
  for update to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

-- ── Enqueueing an extraction ──────────────────────────────────────────────
-- core.jobs had no INSERT policy: jobs were runner-written only. Requirement
-- extraction is user-initiated, so internal staff need to enqueue exactly one
-- kind of job for their own organization — and nothing else. The `kind`
-- predicate is the point of this policy, not incidental to it.
drop policy if exists jobs_insert_requirement_extract on core.jobs;
create policy jobs_insert_requirement_extract on core.jobs
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write())
              and kind = 'requirement.extract');


-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260809120001_sales_pipeline_and_delivery.sql                        ║
-- ╚═══════════════════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════════════════════════════════════
-- 013 — Sales pipeline, delivery handoff, milestone payment plans
--
-- Covers LEAD → SALES → CLIENT WON → PROJECT CREATION → ONBOARDING.
--
-- Almost every concept in that chain already had a home, so this migration is
-- deliberately small. What already existed and is reused as-is:
--
--   crm.leads.status          new → qualifying → qualified → converted
--   sales.opportunities.stage discovery → proposal → negotiation → won / lost
--   crm.lead_activities       sales notes (kind = 'note') and the lead timeline
--   core.client_accounts      the won client
--   projects.projects         the project
--   projects.milestones       ordered, priced delivery milestones
--   audit.audit_log           the history trail for every transition
--
-- Only four things were genuinely absent, and they are added below.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Lead follow-up tracking ────────────────────────────────────────────
-- A lead that nobody has scheduled a next touch for is how deals go quiet.
alter table crm.leads add column if not exists next_follow_up_at timestamptz;

create index if not exists leads_follow_up_idx
  on crm.leads (organization_id, next_follow_up_at)
  where deleted_at is null and next_follow_up_at is not null;

comment on column crm.leads.next_follow_up_at is
  'When the next sales touch is due. Null means nothing is scheduled, which is what an overdue-leads view looks for.';

-- ── 2. Lead qualification ─────────────────────────────────────────────────
-- Distinct from crm.leads.requirements, which records *what the client wants
-- built*. This records *whether the deal is worth pursuing* — the two answer
-- different questions and change at different times.
--
-- jsonb for the same reason requirements is jsonb: the shape is still settling.
-- The authoritative shape is the Zod schema in src/modules/crm/schema.ts;
-- promote to columns once it stops moving.
alter table crm.leads add column if not exists qualification jsonb not null default '{}'::jsonb;

comment on column crm.leads.qualification is
  'Structured qualification (budget band, timeline, decision maker, fit notes). Schema-on-read; validated by requirementQualificationSchema before write.';

-- ── 3. Onboarding as an explicit project state ────────────────────────────
-- The workflow has a real gap between "we won it" and "we are building": the
-- WhatsApp group, the advance payment, the kickoff. That is a state, not a
-- pause inside 'planning', so it gets named.
alter table projects.projects drop constraint if exists projects_status_check;
alter table projects.projects add constraint projects_status_check
  check (status in ('planning', 'onboarding', 'active', 'on_hold', 'completed', 'cancelled'));

comment on column projects.projects.status is
  'planning → onboarding → active → completed. onboarding covers kickoff, group setup, and advance payment, before delivery starts.';

-- ── 4. Flexible milestone payment plans ───────────────────────────────────
-- The business uses different splits per deal (30/20/30/20, 5/10/30/20/35,
-- …), so no structure is hard-coded anywhere. A plan is simply the ordered
-- milestones of a project, each carrying its share.
--
-- Percent is stored alongside the money rather than instead of it: the
-- percentage is what was negotiated, amount_minor is what will be invoiced,
-- and keeping both means a budget change can be re-applied without guessing
-- the original split.
alter table projects.milestones add column if not exists payment_percent numeric(5, 2);

alter table projects.milestones drop constraint if exists milestones_payment_percent_range;
alter table projects.milestones add constraint milestones_payment_percent_range
  check (payment_percent is null or (payment_percent > 0 and payment_percent <= 100));

comment on column projects.milestones.payment_percent is
  'This milestone''s share of the project budget. Null for milestones that are pure delivery checkpoints with no payment attached.';

-- A plan that does not add up to 100% is a billing error waiting to happen, so
-- it is refused by the database rather than by convention.
--
-- DEFERRABLE INITIALLY DEFERRED is the point: a plan is written as several rows
-- in one transaction and is only meaningful once all of them are in, so the
-- check runs at COMMIT rather than after each row.
create or replace function projects.assert_payment_plan_totals()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project uuid;
  v_count   int;
  v_total   numeric(6, 2);
begin
  if tg_op = 'DELETE' then
    v_project := old.project_id;
  else
    v_project := new.project_id;
  end if;

  select count(*), coalesce(sum(payment_percent), 0)
    into v_count, v_total
    from projects.milestones
   where project_id = v_project
     and payment_percent is not null;

  -- No priced milestones at all is a valid state: a project can exist before
  -- its payment plan is agreed.
  if v_count > 0 and v_total <> 100 then
    raise exception
      'payment plan for project % must total 100 percent, got %', v_project, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

drop trigger if exists milestones_payment_plan_total on projects.milestones;
create constraint trigger milestones_payment_plan_total
  after insert or update or delete on projects.milestones
  deferrable initially deferred
  for each row execute function projects.assert_payment_plan_totals();

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Deliberately unchanged. Every table touched here already has policies, and
-- new columns inherit them: crm.leads, projects.projects and
-- projects.milestones are all org-scoped with can_write() gating on writes.



-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260809120002_milestone_invoicing.sql                                ║
-- ╚═══════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════
-- 014 — Milestone → invoice: the money link, enforced by the database
--
-- Covers PAYMENT MILESTONE → DRAFT INVOICE → ISSUED → PAID → NEXT STAGE.
--
-- finance.invoices already carries milestone_id, project_id, client_account_id
-- and the full status vocabulary, so no table is added and no column changes
-- meaning. What was missing is the set of invariants that make milestone
-- billing safe to run:
--
--   1. A milestone can have at most ONE live invoice. Application checks race;
--      an index does not.
--   2. A milestone invoice must also name its project, so the money link is
--      never half-connected.
--   3. Manually recorded payments need a write path that is not "service role
--      only" — there is no gateway yet, and a human recording a bank transfer
--      is the mechanism, not a workaround.
--   4. Domain events need a write path, so `invoice.paid` can later unlock the
--      next milestone without finance knowing what listens.
--
-- No payment provider is contacted anywhere in this migration or the code that
-- uses it. finance.payments.provider = 'manual' is the only value humans may
-- write; gateway rows keep arriving under service_role when that day comes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. One live invoice per milestone ─────────────────────────────────────
-- Idempotency for invoice generation, enforced where concurrency cannot dodge
-- it. `void` is excluded on purpose: voiding an invoice is how a mistaken bill
-- is withdrawn, and the milestone must then be billable again.
create unique index if not exists invoices_milestone_live_key
  on finance.invoices (milestone_id)
  where milestone_id is not null and status <> 'void';

comment on index finance.invoices_milestone_live_key is
  'At most one non-void invoice per milestone. Makes generateInvoiceFromMilestone idempotent under concurrent calls, not merely usually-idempotent.';

-- ── 1b. A draft can be withdrawn ──────────────────────────────────────────
-- Migration 007 required issued_at for every status except draft and
-- pending_approval, which quietly made a draft impossible to void: voiding
-- moved it out of the exempt set while there was no issue date to supply, and
-- the check refused the write.
--
-- That is backwards. A draft that is withdrawn was *never issued*, so demanding
-- the moment it was issued is asking for a fact that does not exist — and the
-- invoice it blocks is precisely the one most likely to be wrong. `void` joins
-- the exemption; every other status still has to say when it went out.
alter table finance.invoices drop constraint if exists invoices_issued_at_set;
alter table finance.invoices add constraint invoices_issued_at_set
  check (status in ('draft', 'pending_approval', 'void') or issued_at is not null);

-- ── 2. A milestone invoice always names its project ───────────────────────
-- projects.milestones.project_id is NOT NULL, so an invoice that knows the
-- milestone but not the project is necessarily a bug in the writer.
alter table finance.invoices drop constraint if exists invoices_milestone_implies_project;
alter table finance.invoices add constraint invoices_milestone_implies_project
  check (milestone_id is null or project_id is not null);

-- Billing views load every invoice for a project at once.
create index if not exists invoices_project_idx
  on finance.invoices (project_id)
  where project_id is not null;

-- ── 3. Manual payments ────────────────────────────────────────────────────
-- Until a gateway is integrated, "payment received" is a human asserting that
-- money landed, with the bank/UPI reference as evidence. That assertion is a
-- real record with a real actor, so it is written by the user's own session
-- under RLS rather than smuggled in through the service role.
--
-- INSERT only, and only for provider = 'manual':
--   • a recorded payment is an immutable fact — corrections are a refund or a
--     void, never an edit;
--   • gateway rows (provider = 'razorpay', …) stay unreachable from a browser
--     session, so no user can fabricate a capture that never happened.
--
-- unique (provider, provider_payment_id) already exists and does double duty:
-- webhook idempotency for gateways, and duplicate-reference protection here.
drop policy if exists payments_manual_insert on finance.payments;
create policy payments_manual_insert on finance.payments
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
    and provider = 'manual'
  );

comment on column finance.payments.provider is
  'Payment source. ''manual'' is a human-recorded bank/UPI/cheque receipt and is the only value an authenticated session may insert; gateway providers are written by the webhook handler under service_role.';

-- ── 4. Domain events ──────────────────────────────────────────────────────
-- ARCHITECTURE.md §9: modules publish events, never call each other. The
-- outbox previously had no INSERT policy because only the job runner wrote to
-- it, which made `invoice.paid` unemittable from a request.
--
-- Scoped tightly: an author may only stamp their own organization, and only
-- the two roles that already move money may publish at all. published_at must
-- be null, so a caller cannot insert an event that is pre-marked as delivered
-- and therefore never dispatched.
drop policy if exists outbox_insert on core.outbox_events;
create policy outbox_insert on core.outbox_events
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
    and published_at is null
  );

comment on table core.outbox_events is
  'Events are written alongside the state change they describe. Owners and ops admins may publish from a request (finance emits invoice.issued / invoice.paid here); everything else writes under service_role.';

-- ── RLS otherwise unchanged ───────────────────────────────────────────────
-- finance.invoices and finance.invoice_items keep the policies from migration
-- 007 exactly as they are: staff read their organization, clients read their
-- own account's invoices once they leave draft, and only owner/ops_admin
-- write. Issuing an invoice is therefore also what makes it visible in the
-- client portal — no separate "share" mechanism exists or is needed.



-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║ 20260809120003_outbox_dispatch.sql                                    ║
-- ╚═══════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════
-- 015 — Outbox dispatch: invoice.paid → job runner → next milestone
--
-- Almost nothing is needed here, which is the point. The transactional outbox
-- (migration 002) already has everything the dispatcher requires:
--
--   core.outbox_events.published_at   dispatch-once marker
--   core.outbox_events.attempts       visible failure counter
--   outbox_unpublished_idx            the claim index
--   core.jobs.dedupe_key + its unique index
--                                     at-least-once delivery made harmless
--   core.jobs.kind                    free text, so a new handler needs no DDL
--   audit.audit_log actor_type 'system'
--                                     the runner can record itself honestly
--
-- No table, column, status or constraint changes. `milestone.unlock` is simply
-- a second value in an existing column, and the milestone it moves goes from
-- `pending` to `in_progress` — both already in the migration 006 CHECK. This
-- layer introduces no new state anywhere.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Claim index for a queue with more than one kind ───────────────────────
-- The runner now claims by (kind, status), and jobs_claim_idx from migration
-- 002 leads on priority — so with two kinds queued it scans past every job of
-- the wrong kind to find the right one. Cheap today, quadratic in kinds later,
-- and the fix is one index.
create index if not exists jobs_kind_claim_idx
  on core.jobs (kind, priority, run_at)
  where status = 'queued';

comment on index core.jobs_kind_claim_idx is
  'Serves the runner claim: one kind at a time, oldest and highest priority first.';

comment on column core.jobs.kind is
  'Which handler runs this job. ''requirement.extract'' (AI extraction) and ''milestone.unlock'' (invoice.paid → next milestone). Mapped from event subscriptions in src/lib/events/catalog.ts.';

comment on column core.jobs.dedupe_key is
  'Globally unique. Outbox dispatch writes ''evt:<event id>:<handler>'', which is what makes at-least-once event delivery enqueue exactly one job.';

comment on column core.outbox_events.published_at is
  'Set once the dispatcher has enqueued every subscribed handler''s job. Enqueue happens first, so a crash in between replays harmlessly: the dedupe key absorbs it.';


-- ── CLI migration history ──────────────────────────────────────────────────
-- Recorded so a later `supabase db push` sees these as already applied and
-- does not attempt to re-run them.

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version    text primary key,
  statements text[],
  name       text
);

insert into supabase_migrations.schema_migrations (version) values
  ('20260807120001'),
  ('20260807120002'),
  ('20260807120003'),
  ('20260807120004'),
  ('20260807120005'),
  ('20260807120006'),
  ('20260807120007'),
  ('20260807120008'),
  ('20260807120009'),
  ('20260807120010'),
  ('20260807120011'),
  ('20260808120001'),
  ('20260809120001'),
  ('20260809120002'),
  ('20260809120003')
on conflict (version) do nothing;

commit;
