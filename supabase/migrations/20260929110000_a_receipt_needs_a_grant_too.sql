-- ═══════════════════════════════════════════════════════════════════════════
-- finance.verify_payment could not be called by the admin session it exists
-- for.
--
-- Found driving `tests/phase4-full-pipeline-e2e.test.ts` against a real
-- scratch Postgres, immediately after the M2 milestone-position fix
-- (20260929100000) in the same run.
--
-- `finance.verify_payment` is `security invoker`, granted to `authenticated`
-- (20260813120015_payment_verified.sql), and called from
-- `verifyPayment` (`src/modules/finance/service.ts`) through an ordinary
-- session client — the real "Confirm Payment" action an owner/ops_admin
-- takes, not a job. `20260928130000_a_payment_gets_its_own_receipt.sql`
-- added a call inside it to `finance.new_receipt_reference()` and correctly
-- granted the new `finance.receipts` table INSERT to `authenticated` — but
-- granted EXECUTE on `new_receipt_reference()` itself to `service_role`
-- only. Because `verify_payment` is invoker, not definer, that inner call
-- runs with the CALLING role's privileges, so every real admin session
-- verifying a payment fails outright:
--
--   ERROR: permission denied for function new_receipt_reference
--
-- `new_receipt_reference()` reads and writes nothing — six random characters
-- from a fixed alphabet, `security invoker`, no tenancy surface — so
-- granting it to `authenticated` carries the same shape as every other
-- reference generator in this schema (`approvals.new_reference()`, granted
-- to `authenticated` already).
-- ═══════════════════════════════════════════════════════════════════════════

grant execute on function finance.new_receipt_reference() to authenticated;

comment on function finance.new_receipt_reference() is
  'A six-character reference over an alphabet with the characters people misread on a phone removed, the same shape approvals.new_reference() already uses. Granted to authenticated (20260929110000): finance.verify_payment is SECURITY INVOKER and calls this from a real admin session, not only the service role — the missing grant made every real "Confirm Payment" action fail once receipt generation was added.';
