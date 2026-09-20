-- ═══════════════════════════════════════════════════════════════════════════
-- The vault is allowed to be global.
--
-- 20260920140000 added ai.provider_credentials with an admin-only, role-scoped
-- policy (core.is_admin()) and deliberately no organization_id — every
-- provider ADM-85 named is served on the agency's OWN account, never a
-- per-tenant billing relationship, so there is no tenant to scope a row to.
-- core.audit_untenanted_write_policies() (20260815390000) correctly flags any
-- role-only end-user write policy as a candidate cross-tenant write and
-- demands a human say why this one is safe rather than silently exempting it.
--
-- The reason: the table has ONE global row per provider id (five possible
-- rows, ever), admin-only by RLS, and nothing in it is organization-specific
-- — the same footing as core.organizations and core.users, which this table's
-- own migration already compared itself to. An admin from organization A
-- writing this table is not reading or altering organization B's data; there
-- is no organization B's data here to reach.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.audit_untenanted_write_policies()
returns table(target text, policy_name text, op text, roles text)
language sql
security definer
set search_path = ''
stable
as $$
  select
    n.nspname || '.' || c.relname as target,
    pol.polname as policy_name,
    case pol.polcmd
      when 'a' then 'INSERT'
      when 'w' then 'UPDATE'
      when 'd' then 'DELETE'
      when '*' then 'ALL'
    end as op,
    coalesce(
      (select string_agg(r.rolname, ',' order by r.rolname)
         from pg_roles r where r.oid = any(pol.polroles)),
      'public'
    ) as roles
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('core','audit','crm','sales','projects','finance','ai','approvals','qa')
    and pol.polpermissive                          -- permissive: it GRANTS access
    and pol.polcmd in ('a','w','d','*')            -- INSERT / UPDATE / DELETE / ALL (not SELECT)
    -- reaches an end-user role: public (oid 0), or authenticated / anon by name
    and (
      0 = any(pol.polroles)
      or exists (
        select 1 from pg_roles r
        where r.oid = any(pol.polroles) and r.rolname in ('authenticated', 'anon')
      )
    )
    -- neither USING nor WITH CHECK carries a tenant predicate
    and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
          !~* '(organization_id|current_organization_id|auth\.uid|\.uid\(\))'
    and coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
          !~* '(organization_id|current_organization_id|auth\.uid|\.uid\(\))'
    -- Allowlist: end-user write policies that legitimately carry no tenant
    -- predicate. Each must name why.
    and (n.nspname || '.' || c.relname || '.' || pol.polname) not in (
      'ai.provider_credentials.provider_credentials_admin_rw'  -- a global, admin-only table (see header): one row per provider id, never per-organization
    );
$$;

comment on function core.audit_untenanted_write_policies() is
  'Self-detects the untenanted end-user write policy class: every permissive INSERT/UPDATE/DELETE/ALL policy reaching an end-user role (public/authenticated/anon) whose USING and WITH CHECK carry no tenant predicate (organization_id / current_organization_id / auth.uid) — a write RLS admits regardless of tenant. scripts/verify-untenanted-writes.mjs asserts it is empty; CI runs it, so a role-only write policy on a shared table cannot silently return. ai.provider_credentials is allowlisted: it is genuinely global (ADM-85 — every AI provider is on the agency''s own account, not a per-tenant one), admin-only by RLS, with one row per provider id and no organization data to cross a tenant boundary.';
