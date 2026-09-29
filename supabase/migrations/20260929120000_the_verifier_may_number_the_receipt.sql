-- The verifier may number the receipt.
--
-- 20260928130000 taught finance.verify_payment to issue a receipt, and
-- numbered it with finance.new_receipt_reference() — granted to service_role
-- only. verify_payment is SECURITY INVOKER and granted to authenticated: it
-- runs as the ops_admin who clicked PAYMENT VERIFIED, and that person had no
-- right to call the numbering helper. So the human gate the whole finance
-- flow rests on (screen architecture SCR-054, "human-only financial gate")
-- failed with "permission denied for function new_receipt_reference" for
-- every real verifier, while the service-role path in the job runner —
-- which nothing in production uses for verification — kept passing.
--
-- Found by scripts/verify-milestone-invoicing.mjs against a real Postgres
-- (2026-09-29): "an authenticated ops_admin (not the service role) confirms
-- it" was the check that failed. The helper is six random characters over
-- a fixed alphabet; there is nothing to protect in it, only the receipt
-- insert it feeds, and that already has its RLS policy.

grant execute on function finance.new_receipt_reference() to authenticated;

comment on function finance.new_receipt_reference() is
  'A six-character receipt reference over the misread-safe alphabet. Executable by authenticated since 20260929120000: finance.verify_payment (SECURITY INVOKER) numbers the receipt as the verifying admin, not as the service role.';
