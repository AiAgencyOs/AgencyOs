-- ═══════════════════════════════════════════════════════════════════════════
-- ADM-04 decided A (owner, 2026-08-16): recording money and verifying it are two
-- acts — even for the same owner. A manual payment is INSERTed only as
-- unverified; confirmation is a separate, separately-timestamped act.
--
-- ADM-04 established "recording money and believing it are two acts" and #193
-- built the two-step engine — `record_manual_payment` inserts `captured` with
-- `verified_at` null, `verify_payment` confirms it under the invoice lock. But
-- the direct-INSERT policy `payments_manual_insert` never restricted
-- `verified_at`, so an owner/ops_admin could INSERT a `provider='manual'` payment
-- already `verified_at`-stamped over the Data API — collapsing the two acts into
-- one, and (because `net_verified_minor` counts it as confirmed) advancing a
-- milestone on money confirmed in the same keystroke it was recorded. Not
-- credential-free-exploitable (the actor is the money-trusted owner in their own
-- org), but it left the two-act model unenforced on the one path that bypassed
-- the RPCs. The owner has now chosen **Option A**: verification is a separate
-- control.
--
-- Tighten the INSERT policy's WITH CHECK to forbid a verification on INSERT, so
-- every confirmation goes through `finance.verify_payment`. `record_manual_payment`
-- inserts `verified_at` null and is unaffected; `verify_payment` is an UPDATE and
-- is governed by a different policy, so the two-step flow is untouched. The
-- service role (identity-less) bypasses RLS, so migrations/backfills are free.
-- ═══════════════════════════════════════════════════════════════════════════

alter policy payments_manual_insert on finance.payments
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) = any (array['owner', 'ops_admin'])
    and provider = 'manual'
    -- A manual payment enters the book unverified; belief is a later, separate act.
    and verified_at is null
    and verified_by is null
  );
