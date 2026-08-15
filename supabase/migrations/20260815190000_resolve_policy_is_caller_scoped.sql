-- ═══════════════════════════════════════════════════════════════════════════
-- resolve_policy answers only for the caller's own organization.
--
-- `approvals.resolve_policy` is SECURITY DEFINER — it runs as its owner, past
-- RLS — because `request_approval` calls it to snapshot the binding rung at
-- raise time. But it is also EXECUTE-granted to `authenticated` and reachable
-- directly over PostgREST, and it took the organization to resolve as an
-- ARGUMENT, matching on it with no check that the argument is the caller's own
-- org. So any signed-in user could POST /rpc/resolve_policy with another
-- tenant's id and read that tenant's policy back — the required role, the money
-- threshold, the SLA and the audience another agency configured. The
-- `approval_policies` table's RLS is correctly org-scoped; this function was a
-- hole straight through it.
--
-- The fix is the guard the finance SECURITY DEFINER siblings already carry
-- (`blocking_invoice_number`, `next_unlocked_milestone`): a session caller may
-- resolve only their own org, while the service role — whose
-- `current_organization_id()` is null — stays unrestricted, so `request_approval`
-- and the job runner are unaffected. `current_organization_id()` reads the
-- request's JWT claims, which SECURITY DEFINER does not change, so it still
-- names the caller even though the body runs as the owner.
--
-- `create or replace`, same signature. Nothing else changes.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function approvals.resolve_policy(
  p_organization_id uuid,
  p_subject_type    text,
  p_amount_minor    bigint default null
)
returns approvals.approval_policies
language sql
stable
security definer
set search_path = ''
as $$
  select *
    from approvals.approval_policies
   where organization_id = p_organization_id
     -- A session caller may resolve only their own org; the service role,
     -- whose current_organization_id() is null, is unrestricted.
     and (core.current_organization_id() is null
          or core.current_organization_id() = p_organization_id)
     and subject_type    = p_subject_type
     and active
     and min_amount_minor <= coalesce(p_amount_minor, 0)
   order by min_amount_minor desc
   limit 1;
$$;

comment on function approvals.resolve_policy(uuid, text, bigint) is
  'The active policy binding this subject type at this amount: the highest threshold at or below it. approval_policies_threshold_key makes the ordering total, so this cannot be the unordered LIMIT 1 that D22 was. SECURITY DEFINER for request_approval, but caller-scoped: a session caller resolves only their own org, the service role any — so it cannot be used over PostgREST to read another tenant''s policy configuration.';
