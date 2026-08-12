-- ═══════════════════════════════════════════════════════════════════════════
-- The first owner is decided once, not by whoever counted first.
--
-- Audit finding D19. core.bootstrap_first_owner counted memberships, counted
-- organizations, then inserted — three statements with nothing held across
-- them:
--
--     select count(*) from core.memberships   →  0
--     select count(*) from core.organizations →  1
--     insert into core.memberships … 'owner'
--
-- Two different people signing in at the same moment on a fresh install both
-- read zero and both insert. The `on conflict (organization_id, user_id)`
-- clause does not help: it dedupes the *same* user retrying, and says nothing
-- about two different ones. The result is two owners on a deployment meant to
-- have one.
--
-- `owner` is `['*']` in src/lib/authz/permissions.ts — every capability there
-- is. Stated precisely, because the two halves differ in when they bite:
--
--   The four capabilities only owner holds — proposal.approve, refund.issue,
--   agent.configure, organization.settings — have no call site yet. Today they
--   grant nothing.
--
--   The rest do. An owner passes every `can()` the application actually
--   enforces, which includes invoice.create and invoice.issue — and
--   invoice.issue deliberately covers recording payments and voiding as well
--   (SECURITY.md §3). So an accidental owner can raise a bill, issue it to a
--   client, and record a payment against it.
--
-- And nothing in the application demotes a membership, so it is permanent.
--
-- ── Why an advisory lock rather than the usual FOR UPDATE ─────────────────
--
-- The house pattern is to lock the row being decided about and re-decide
-- through it. That does not fit here, because the predicate is not about a
-- row: it is "core.memberships is empty". There is no row to lock — the
-- absence of rows is the whole condition.
--
-- The alternatives were considered and rejected:
--
--   A unique index cannot express it. The rule is not "one owner ever" — more
--   owners are invited legitimately later — it is "only while the table is
--   empty", and no constraint can say that.
--
--   `insert … select … where not exists (select 1 from core.memberships)`
--   looks atomic and is not. Under READ COMMITTED both transactions evaluate
--   the NOT EXISTS against their own snapshot, both find it true, and both
--   insert. It is the classic non-atomic idiom.
--
--   Locking the single organizations row would work, since every bootstrapper
--   targets the same one. It was rejected as indirect: it makes the guarantee
--   depend on a row that is incidental to the rule, and it inherits the
--   LIMIT-under-a-row-lock hazard recorded in 20260811120005 for no gain.
--
-- pg_advisory_xact_lock takes a lock on a number rather than a row, which is
-- exactly the shape of a predicate about a whole table. It is held to the end
-- of the transaction and released automatically — including on error — so
-- there is nothing to leak. `xact` rather than session-scoped deliberately:
-- session locks do not survive transaction-mode connection pooling, and every
-- caller here arrives through PostgREST.
--
-- The key is derived from the function's own name so it cannot silently
-- collide with a lock somebody takes later for a different reason.
--
-- Deadlock is not reachable: this is the first lock the transaction takes and
-- there is exactly one key, so there is no pair to order wrongly.
--
-- No schema change: no table, column, index or constraint is added, altered or
-- dropped. The signature, security context and grants are unchanged.
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
  'Gives the first user of a fresh single-organization install the owner role, serialised on an advisory lock so two concurrent first sign-ins cannot both be provisioned. Fires only when there are zero memberships and exactly one organization; returns the organization id when it provisioned someone and null when it declined.';

-- Unchanged from migration 011, restated because CREATE OR REPLACE keeps the
-- old grants only by accident of not dropping the function — and a future
-- change that does drop it would silently lose them.
revoke all on function core.bootstrap_first_owner(uuid) from public, anon;
grant execute on function core.bootstrap_first_owner(uuid) to authenticated, service_role;

-- The public wrapper is unchanged and is not redefined here: it is one line of
-- `select core.bootstrap_first_owner(p_user_id)`, so it inherits the lock
-- without knowing about it.
