-- ═══════════════════════════════════════════════════════════════════════════
-- A caller may claim the deployment for itself, and for nobody else.
--
-- Gap G-084, found while fixing D19 and deliberately not folded into it: a
-- different defect on the same function.
--
-- `core.bootstrap_first_owner(p_user_id uuid)` took the user to provision as a
-- parameter and never compared it with the caller. `execute` is granted to
-- `authenticated` and both the core function and its public wrapper are
-- reachable over PostgREST, so on an unclaimed deployment any signed-in user
-- could POST it naming somebody else's id — and sign-up is open, with no domain
-- allowlist and no email confirmation, so "any signed-in user" is "anyone".
--
-- D19 fixed how many owners result. This fixes which one. They are independent:
-- the advisory lock serialises the decision, and would serialise a wrong
-- decision just as faithfully.
--
-- What this does NOT change, and should not be read as changing: on a fresh
-- deployment the first person to sign in still becomes owner, and that is the
-- V1 bootstrap working as designed (migration 011 explains why it exists). The
-- narrowing is only that a caller can no longer nominate a third party.
--
-- The service role keeps its exemption. Its key carries `role` and no `sub`, so
-- `auth.uid()` is null under it and the check does not bind — the same posture
-- SECURITY.md §5 records for every sanctioned service-role path: no RLS, no
-- session, scope by hand. `scripts/verify-first-owner.mjs` races the function
-- with generated user ids under that key, and continues to.
--
-- No schema change: the signature, the security context and the grants are
-- unchanged. The rest of the body is migration 20260812120005 verbatim.
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
  -- ── 0. a caller with an identity may only name itself ───────────────────
  --
  -- Gap G-084. `p_user_id` arrived unvalidated and `execute` is granted to
  -- `authenticated`, so any signed-in user could POST this RPC naming somebody
  -- else's id and hand them the deployment. D19 made sure only one owner
  -- results; it said nothing about whether it is the right one.
  --
  -- `auth.uid()` is null for the service role — its key carries `role` and no
  -- `sub` — so the sanctioned service-role paths keep working and scope by
  -- hand, exactly as they do everywhere else (SECURITY.md §5). The check binds
  -- only callers who actually have an identity to assert.
  --
  -- Declined rather than raised, like every other refusal here.
  -- ensureProvisioned reads null as "nothing to do", and this function sits on
  -- the sign-in path where an exception is the one thing it must not become.
  if (select auth.uid()) is not null and p_user_id is distinct from (select auth.uid()) then
    return null;
  end if;

  -- ── 1. the answer for every sign-in after the first ─────────────────────
  --
  -- ensureProvisioned calls this on *every* sign-in, forever, and for all but
  -- one of them the answer is "already claimed". Taking the lock first would
  -- put a single global exclusive key on the sign-in path for the life of the
  -- deployment — and since `execute` is granted to `authenticated`, anyone
  -- signed in could queue every other login behind a tight loop of calls.
  --
  -- So the cheap read comes first, unlocked, and it is allowed to be racy:
  -- being wrong here can only mean *not* returning early, which falls through
  -- to the locked path below. It is a fast path, never an authority. Claiming
  -- is one-way — nothing in the application deletes a membership — so a
  -- non-zero count is a fact that cannot become false while this runs.
  select count(*) into v_member_count from core.memberships;
  if v_member_count > 0 then
    return null;
  end if;

  -- ── 2. serialise the decision that actually provisions ──────────────────
  --
  -- Reached only on a deployment that still looks unclaimed, which happens
  -- once in a deployment's life plus whatever concurrent callers arrive in
  -- the same instant. Those are exactly the callers this exists to order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('core.bootstrap_first_owner')::bigint
  );

  -- ── 3. decide again, through the lock ───────────────────────────────────
  --
  -- The re-count is the whole fix. The count in step 1 was taken before the
  -- lock and is worth nothing by the time the lock is granted: the transaction
  -- that held it may have inserted and committed in between. This one cannot
  -- be stale, because nothing else can be inside this block.
  --
  -- It depends on READ COMMITTED, which is the default and is not overridden
  -- anywhere in this repository. Under REPEATABLE READ the snapshot would be
  -- fixed at the first statement of the transaction and this re-count would
  -- still read zero, so the lock would be held and useless. Stated because it
  -- is a real dependency rather than an obvious one.
  select count(*) into v_member_count from core.memberships;
  if v_member_count > 0 then
    return null;
  end if;

  -- The guard is unchanged and deliberately narrow: zero memberships and
  -- exactly one organization, i.e. a fresh single-tenant install.
  select count(*) into v_org_count from core.organizations;
  if v_org_count <> 1 then
    return null;
  end if;

  -- `limit 1` is kept, and the warning in 20260811120005 does not apply to
  -- it. That one is about a LIMIT under a *row lock*, where the chosen tuple
  -- can be lost to a concurrent delete; there is no FOR UPDATE here. The
  -- count above already establishes there is exactly one row, so this reads
  -- it rather than choosing between candidates. `into strict` was considered
  -- and rejected: it raises where this function has always declined, and it
  -- sits on the sign-in path.
  select id into v_org_id from core.organizations limit 1;

  -- ── 3. the write, in the same transaction as the decision ───────────────
  --
  -- The conflict clause can no longer fire — a second call by the same user
  -- reads a non-empty memberships table and returns above — but it is kept
  -- rather than tidied away. It names the unique constraint that is the last
  -- line of defence, and it is what makes this function safe for any caller
  -- added later that reaches the insert by another route.
  insert into core.memberships (organization_id, user_id, role, status)
  values (v_org_id, p_user_id, 'owner', 'active')
  on conflict (organization_id, user_id) do nothing;

  return v_org_id;
end;
$$;

comment on function core.bootstrap_first_owner(uuid) is
  'Gives the first user of a fresh single-organization install the owner role. Serialised on an advisory lock so two concurrent first sign-ins cannot both be provisioned (D19), and a caller holding an identity may only name itself (G-084) — the service role, which has none, still scopes by hand. Fires only when there are zero memberships and exactly one organization; returns the organization id when it provisioned someone and null when it declined.';

revoke all on function core.bootstrap_first_owner(uuid) from public, anon;
grant execute on function core.bootstrap_first_owner(uuid) to authenticated, service_role;
