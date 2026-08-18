-- ═══════════════════════════════════════════════════════════════════════════
-- The owner can read the deployment's structural security posture.
--
-- Three catalogue scanners already exist and are enforced on every migration by
-- CI: core.unguarded_org_fks() (org-scoped FKs missing their tenant guard),
-- core.unfrozen_org_tables() (tables that let organization_id be re-tenanted),
-- and core.audit_invoker_writes_without_policy() (SECURITY INVOKER functions
-- that write to an RLS table with no policy — the class that silently returns).
-- They are service_role-only, so an OWNER cannot see them: the hardening is real
-- but invisible.
--
-- This wraps them in one owner-readable function. What it returns is STRUCTURAL —
-- schema-level facts identical for every tenant (which foreign key, which table,
-- which function), not any organization's data — so exposing it to an owner
-- leaks the deployment's own hardening status, never another tenant's rows. It
-- is SECURITY DEFINER (the scanners need catalogue access the caller lacks) but
-- authority-gated to owner/ops_admin, and READ-ONLY: it writes nothing, so it is
-- not itself part of the invoker-write class it reports on.
--
-- The Security Center reads this. An all-empty result is the honest "every
-- invariant holds" state; a non-empty array names exactly what regressed.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.security_posture()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  -- Authority: an authenticated caller must be owner or ops_admin. The service
  -- role (identity-less: jobs, the verify harness) is unrestricted.
  if v_actor is not null and (select core.current_user_role()) not in ('owner', 'ops_admin') then
    raise exception 'only an owner or ops-admin may read the security posture'
      using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'unguarded_fks',
      coalesce((select jsonb_agg(to_jsonb(u) order by u.child, u.fk_column) from core.unguarded_org_fks() u), '[]'::jsonb),
    'unfrozen_tables',
      coalesce((select jsonb_agg(to_jsonb(t) order by t.org_table) from core.unfrozen_org_tables() t), '[]'::jsonb),
    'invoker_writes',
      coalesce((select jsonb_agg(to_jsonb(w) order by w.target, w.op) from core.audit_invoker_writes_without_policy() w), '[]'::jsonb)
  );
end;
$$;

comment on function core.security_posture() is
  'Owner/ops_admin-readable summary of the three structural security-invariant scanners (unguarded org FKs, unfrozen org tables, invoker writes without policy). SECURITY DEFINER for catalogue access, authority-gated, read-only; returns STRUCTURAL schema facts (not tenant data), so it is safe to show an owner. Empty arrays = every invariant holds. The Security Center (/security) reads it.';

revoke all on function core.security_posture() from public, anon;
grant execute on function core.security_posture() to authenticated, service_role;
