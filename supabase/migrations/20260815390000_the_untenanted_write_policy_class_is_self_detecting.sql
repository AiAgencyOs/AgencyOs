-- ═══════════════════════════════════════════════════════════════════════════
-- The untenanted end-user write policy class cannot silently return.
--
-- `agents_write` (20260815380000) was a write policy gated by ROLE alone —
-- `core.is_owner()`, true for the owner of any organization — on a table with no
-- tenant column, so it admitted a cross-tenant write. That is a class, and its
-- mirror is exactly the one the INVOKER/RLS audit cannot see: a permissive
-- INSERT/UPDATE/DELETE/ALL policy for an end-user role (authenticated / anon /
-- public) whose USING and WITH CHECK reference NO tenant predicate — no
-- organization_id, no core.current_organization_id(), no auth.uid(). Such a
-- policy grants the write to every caller of that role regardless of tenant, so
-- if the table is shared (or its rows are another tenant's) it is a cross-tenant
-- write. Service-role verify scripts never see it, because they bypass RLS.
--
-- This function makes the class self-detecting. It returns every permissive
-- end-user write policy whose expression carries no tenant predicate, minus an
-- allowlist of policies that legitimately need none (a self-scoped policy our
-- token set does not recognise, or a genuinely global table managed elsewhere).
-- `scripts/verify-untenanted-writes.mjs` asserts it returns nothing and CI runs
-- it, so a future policy that reintroduces the shape fails the build.
--
-- A note on precision. A policy that scopes by a novel idiom our token set does
-- not name will be flagged as a false positive — deliberately: the fix is to add
-- it to the allowlist WITH its reason, which forces a human to look at a
-- role-only write policy and say why it is safe. That is the tripwire working,
-- not misfiring. Today, after the agents_write drop, the audit is empty.
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
    -- predicate. Each must name why. (Empty today — agents_write is dropped, and
    -- users_update_self is auth.uid()-scoped, which the token set already
    -- recognises, so it never surfaces.)
    and (n.nspname || '.' || c.relname || '.' || pol.polname) not in (
      ''  -- placeholder so the NOT IN list is never empty
    );
$$;

comment on function core.audit_untenanted_write_policies() is
  'Self-detects the untenanted end-user write policy class: every permissive INSERT/UPDATE/DELETE/ALL policy reaching an end-user role (public/authenticated/anon) whose USING and WITH CHECK carry no tenant predicate (organization_id / current_organization_id / auth.uid) — a write RLS admits regardless of tenant. scripts/verify-untenanted-writes.mjs asserts it is empty; CI runs it, so a role-only write policy on a shared table cannot silently return.';

revoke all on function core.audit_untenanted_write_policies() from public;
grant execute on function core.audit_untenanted_write_policies() to service_role;
