-- ═══════════════════════════════════════════════════════════════════════════
-- The INVOKER-writer-without-the-RLS-policy class cannot silently return.
--
-- This session found three money-critical instances of one class: a SECURITY
-- INVOKER function the app calls with the user's session, writing a table whose
-- RLS lacks the policy that write needs. The function runs as the authenticated
-- user, RLS blocks the write, and the feature is dead in the app — invisible to
-- CI because every verify script drives the RPC through the service role, which
-- bypasses RLS (verify_payment #193, request_refund/record_refund #194).
--
-- This function makes the class self-detecting. It returns every app-callable
-- (granted to authenticated) SECURITY INVOKER function that writes an INSERT or
-- UPDATE into an RLS-enabled table which has NO policy for that operation — i.e.
-- a write RLS will refuse for an authenticated caller. `scripts/verify-invoker-rls.mjs`
-- asserts it returns nothing, and CI runs it, so a future function that
-- reintroduces the shape fails the build instead of shipping a dead feature.
--
-- The allowlist below is the set of INVOKER functions that legitimately write a
-- policy-less RLS table because they are invoked ONLY by the service role
-- (cron/jobs), which is exempt from RLS. Each is named with its reason; adding
-- one demands the same justification, which is the point.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.audit_invoker_writes_without_policy()
returns table(target text, op text, writer text)
language sql
security definer
set search_path = ''
stable
as $$
  select distinct
    m.tbl as target,
    case when m.verb = 'insert into' then 'INSERT' else 'UPDATE' end as op,
    w.fn as writer
  from (
    select n.nspname || '.' || p.proname as fn, p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prokind = 'f'
      and not p.prosecdef                                           -- INVOKER only
      and has_function_privilege('authenticated', p.oid, 'EXECUTE') -- app-callable
      and n.nspname in ('finance','projects','crm','sales','core','approvals','qa','ai')
  ) w
  cross join lateral (
    select rm[1] as verb, rm[2] as tbl
    from regexp_matches(
      lower(pg_get_functiondef(w.oid)),
      '(insert into|update)\s+(([a-z_]+)\.[a-z_]+)', 'g'
    ) as rm
  ) m
  where to_regclass(m.tbl) is not null
    and (select c.relrowsecurity from pg_class c where c.oid = to_regclass(m.tbl))
    and not exists (
      select 1 from pg_policy pol
      where pol.polrelid = to_regclass(m.tbl)
        and (pol.polcmd = (case when m.verb = 'insert into' then 'a' else 'w' end)
             or pol.polcmd = '*')
    )
    and (w.fn, case when m.verb = 'insert into' then 'INSERT' else 'UPDATE' end) not in (
      -- Service-role-only writers of a policy-less RLS table. RLS is bypassed for
      -- the service role, so these are correct as-is; they are NOT app-callable
      -- as an authenticated end-user in practice.
      ('approvals.expire_overdue', 'INSERT'),  -- approval-expiry cron (lib/approvals/expire.ts, admin client)
      ('core.claim_alert', 'INSERT'),          -- backlog-alert cron (lib/observability/alert.ts, admin client)
      ('core.claim_alert', 'UPDATE'),          -- same
      ('core.clear_alert', 'DELETE'),          -- same (DELETE never surfaces here; listed for completeness)
      ('core.emit_event', 'INSERT')            -- helper: called only from within other sanctioned functions, whose own gate applies
    );
$$;

comment on function core.audit_invoker_writes_without_policy() is
  'Self-detects the INVOKER-writer-without-the-RLS-policy class: every app-callable SECURITY INVOKER function that writes an RLS-enabled table lacking a policy for that op (a write RLS refuses for an authenticated caller), minus an allowlist of service-role-only cron writers. scripts/verify-invoker-rls.mjs asserts it is empty; CI runs it, so the class cannot silently return.';

revoke all on function core.audit_invoker_writes_without_policy() from public;
grant execute on function core.audit_invoker_writes_without_policy() to service_role;
