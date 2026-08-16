-- ═══════════════════════════════════════════════════════════════════════════
-- An end-user voids an invoice; they never delete the financial record.
--
-- The sanctioned-write guard (20260815290000) stops an authenticated end-user
-- forging an invoice's state over the Data API — but only on INSERT and UPDATE.
-- `invoices_write` is the ALL policy (owner/ops_admin) and DELETE is granted to
-- authenticated, so DELETE was left open: an ops_admin could **delete** a draft
-- or unpaid invoice outright over PostgREST rather than voiding it, erasing the
-- financial record and its number instead of leaving a `void` row and its audit.
-- The engine already provides the sanctioned path — void_invoice handles every
-- non-terminal state including `draft` — so deleting is never the right verb for
-- a person; it is the one destructive move the guard did not yet cover.
--
-- A BEFORE DELETE trigger refuses the delete for any caller with an end-user
-- identity, exactly like the sanctioned-write guards: an authenticated end-user
-- is refused, while an identity-less server-side caller (the service role — its
-- fixture cleanup, and the ON DELETE CASCADE from a deleted organization, both
-- run without auth.uid()) is unaffected. Invoices only ever cascade from
-- core.organizations (RESTRICT/SET NULL on the rest), and organizations carry no
-- end-user DELETE policy, so no legitimate cascade reaches this as an end-user.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.invoices_reject_end_user_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    raise exception 'an invoice is voided (finance.void_invoice), not deleted'
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

comment on function finance.invoices_reject_end_user_delete() is
  'Refuses a DELETE of finance.invoices by any authenticated end-user: a financial record is voided through finance.void_invoice (which handles every non-terminal state, draft included), never erased. Identity-less server-side callers — the service role and the ON DELETE CASCADE from a deleted organization — are unaffected, so fixture cleanup and org teardown still work.';

drop trigger if exists invoices_reject_end_user_delete on finance.invoices;
create trigger invoices_reject_end_user_delete
  before delete on finance.invoices
  for each row execute function finance.invoices_reject_end_user_delete();
