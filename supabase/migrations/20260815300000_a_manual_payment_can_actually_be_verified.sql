-- ═══════════════════════════════════════════════════════════════════════════
-- A captured payment can actually be confirmed — verify_payment works for the app.
--
-- BUG (pre-existing, money-critical, masked by the service role): finance.payments
-- has an INSERT policy (payments_manual_insert) and a SELECT policy, but **no
-- UPDATE policy**. `finance.verify_payment` is SECURITY INVOKER, and the app calls
-- it with the *user's* session (verifyPayment → requireInternal → createClient →
-- rpc). So its `update finance.payments set verified_at = now() …` matches **zero
-- rows** under RLS (default-deny with no UPDATE policy), the #177 zero-row guard
-- reports `already_verified`, and **verified_at is never set**. The invoice never
-- reaches `paid` through net_verified_minor and a milestone gated on verified
-- money never unlocks. Every finance verify script drives verify_payment with the
-- **service role**, which bypasses RLS — so the suite was green while the real
-- authenticated path silently no-op'd. Proven live: as an authenticated ops_admin,
-- verify_payment returns `already_verified` and the row's verified_at stays null;
-- as the service role it verifies. (Provider-webhook verification, if run by the
-- service role, is unaffected; the broken path is a person confirming a manually
-- recorded payment.)
--
-- FIX: an UPDATE policy scoped to owner/ops_admin in their own org, so
-- verify_payment's update passes RLS — paired with a guard trigger that admits an
-- authenticated UPDATE only when it carries the finance.sanctioned_write capability
-- (which verify_payment, the SOLE payment updater, sets as its first statement) or
-- comes from an identity-less server-side caller (service role, cron). So the fix
-- makes the sanctioned confirmation work WITHOUT opening a direct Data-API UPDATE
-- that could tamper with a recorded payment's amount/status or set verified_at
-- outside verify_payment (which alone reconciles the invoice atomically under its
-- lock). verify_payment writes the payment BEFORE the invoice, so its payment
-- update still sees the flag `on` (the invoices guard consumes it only on the later
-- invoice write).
--
-- DELIBERATELY UNTOUCHED — the INSERT path. Whether a manual payment may be
-- inserted already `verified_at`-stamped (payments_manual_insert permits it today)
-- is an OWNER decision, not a security one: ADM-04 established that recording money
-- and believing it are two acts; whether an owner who has already confirmed the
-- money may do both in one step, or must always record-then-verify, is a workflow
-- choice recorded in the checkpoint and NOT decided here. Both paths run only
-- through owner/ops_admin in their own org; neither is credential-free-exploitable.
-- ═══════════════════════════════════════════════════════════════════════════

-- RLS must permit the row to be updated at all; the guard below narrows *how*.
create policy payments_sanctioned_update on finance.payments
  for update
  to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  );

create or replace function finance.payments_update_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- verify_payment (the only payment updater) marks its write with the same
  -- transaction-scoped capability the invoices guard uses; a direct Data-API
  -- UPDATE cannot set it.
  if current_setting('finance.sanctioned_write', true) = 'on' then
    return new;
  end if;

  -- Identity-less server-side callers (service role, cron, migrations) are
  -- trusted infrastructure, not the Data-API surface this guard defends.
  if (select auth.uid()) is null then
    return new;
  end if;

  raise exception
    'finance.payments is confirmed only through verify_payment, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function finance.payments_update_is_sanctioned() is
  'Refuses any authenticated end-user UPDATE of finance.payments that did not come through verify_payment (which sets the transaction-scoped finance.sanctioned_write flag as it confirms a captured payment and reconciles its invoice under a lock). A direct PATCH over the Data API cannot set the flag and is refused, so a recorded payment''s amount/status cannot be tampered with and verified_at cannot be set outside the sanctioned confirmation. The service role and other identity-less callers are unrestricted. INSERT is intentionally not guarded here — see 20260815300000.';

drop trigger if exists payments_update_is_sanctioned on finance.payments;
create trigger payments_update_is_sanctioned
  before update on finance.payments
  for each row execute function finance.payments_update_is_sanctioned();
