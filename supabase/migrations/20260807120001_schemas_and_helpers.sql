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
