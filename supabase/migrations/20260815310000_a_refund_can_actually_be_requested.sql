-- ═══════════════════════════════════════════════════════════════════════════
-- A refund can actually be requested and recorded — and only through its engine.
--
-- Same class as the manual-payment verification bug (20260815300000): finance.refunds
-- had ONLY a SELECT policy — no INSERT and no UPDATE policy. request_refund and
-- record_refund are SECURITY INVOKER and the app calls them with the user's session
-- (requestRefund / recordRefund → createClient → rpc). So request_refund's
-- `insert into finance.refunds` was refused outright — RLS *raises* on a blocked
-- INSERT — and record_refund's UPDATE matched zero rows. The entire refund flow
-- was broken in the app: an owner asking for a refund got an error, and no refund
-- could ever be recorded. Every finance verify path drives these RPCs with the
-- **service role** (RLS-bypassing), so the suite was green while the feature was
-- dead. Proven live: as an authenticated owner, request_refund raised
-- 'new row violates row-level security policy for table "refunds"'; as the service
-- role it returned 'requested'.
--
-- FIX (mirrors the payments fix): INSERT and UPDATE policies scoped to
-- owner/ops_admin in their own org, so the sanctioned functions pass RLS — paired
-- with a guard trigger admitting a write only when it carries the
-- finance.sanctioned_write capability the two functions now set, or from an
-- identity-less server-side caller. So the refund engine works, while a direct
-- Data-API write cannot forge a refund (which would bypass the refund APPROVAL
-- gate request_refund raises and record_refund requires decided — a real money
-- control) or tamper with a recorded one. The two functions are reproduced
-- verbatim from the catalog with only the one set_config line added (the shape
-- #177 used), not hand-rewritten. Neither writes finance.invoices, so there is no
-- interaction with the invoices guard.
-- ═══════════════════════════════════════════════════════════════════════════

create policy refunds_sanctioned_insert on finance.refunds
  for insert
  to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  );

create policy refunds_sanctioned_update on finance.refunds
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

create or replace function finance.refunds_write_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- request_refund / record_refund mark their writes with the transaction-scoped
  -- capability; a direct Data-API write cannot set it.
  if current_setting('finance.sanctioned_write', true) = 'on' then
    return new;
  end if;

  -- Identity-less server-side callers (service role, cron, migrations) are trusted
  -- infrastructure, not the Data-API surface this guard defends.
  if (select auth.uid()) is null then
    return new;
  end if;

  raise exception
    'finance.refunds is written only through request_refund and record_refund, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function finance.refunds_write_is_sanctioned() is
  'Refuses any authenticated end-user write to finance.refunds that did not come through request_refund or record_refund (which set the transaction-scoped finance.sanctioned_write flag). A direct PATCH/INSERT over the Data API cannot set it and is refused, so a refund cannot be forged past its approval gate nor a recorded one tampered with. The service role and other identity-less callers are unrestricted.';

drop trigger if exists refunds_write_is_sanctioned on finance.refunds;
create trigger refunds_write_is_sanctioned
  before insert or update on finance.refunds
  for each row execute function finance.refunds_write_is_sanctioned();

-- MAINTENANCE: any future CREATE OR REPLACE of request_refund or record_refund
-- MUST keep the set_config('finance.sanctioned_write', 'on', true) line, or the
-- refund flow breaks for authenticated users. tests/finance-sanctioned-write.test.ts
-- pins this. The two functions follow, verbatim + that one line.

-- ── request_refund: verbatim from the catalog, + the one-line capability declaration ──
CREATE OR REPLACE FUNCTION finance.request_refund(p_invoice_id uuid, p_amount_minor bigint, p_reason text, p_requested_by uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, refund_id uuid, request_id uuid, net_received bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_invoice  finance.invoices;
  v_net      bigint;
  v_approval record;
  v_row      finance.refunds;
begin
  -- Declare the sanctioned-write capability the refunds guard checks
  -- (finance.refunds_write_is_sanctioned, 20260815310000). Transaction-scoped;
  -- a direct Data-API write cannot set it.
  perform set_config('finance.sanctioned_write', 'on', true);
  if p_amount_minor is null or p_amount_minor <= 0 then
    return query select 'non_positive'::text, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- The lock is taken here and held for the ceiling check, so two refunds
  -- requested at the same moment cannot both measure against the same balance.
  select i.* into v_invoice
    from finance.invoices i
   where i.id = p_invoice_id
   for update;

  if v_invoice.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  v_net := finance.net_received_minor(p_invoice_id)
    -- Requests that are not yet recorded still count against the ceiling.
    -- Otherwise three people each request the full amount, all three are
    -- approved, and the ceiling is only discovered on the third recording —
    -- after two owners have already said yes to money that is not there.
    - coalesce((select sum(r.amount_minor) from finance.refunds r
                 where r.invoice_id = p_invoice_id and r.status = 'requested'), 0);

  if p_amount_minor > v_net then
    -- Refused, never clamped. D1's rule: a caller asking for more than exists
    -- is told so, not quietly given less.
    return query select 'exceeds_received'::text, null::uuid, null::uuid, v_net;
    return;
  end if;

  select * into v_approval
    from approvals.request_approval(
      v_invoice.organization_id, 'refund', p_invoice_id,
      case when p_requested_by is null then 'system' else 'user' end,
      p_requested_by,
      'Refund of ' || p_amount_minor || ' minor units on ' || v_invoice.number || ' — ' || p_reason,
      jsonb_build_object('invoice', v_invoice.number, 'amount_minor', p_amount_minor, 'reason', p_reason),
      p_amount_minor,
      'internal',
      null
    );

  if v_approval.outcome = 'no_policy' then
    -- No policy means nobody is named to approve it, and the money floor means
    -- that policy can only ever name the owner. Refused rather than left
    -- pending against nobody.
    return query select 'no_policy'::text, null::uuid, null::uuid, v_net;
    return;
  end if;

  insert into finance.refunds (
    organization_id, invoice_id, amount_minor, reason, approval_request_id, requested_by
  )
  values (
    v_invoice.organization_id, p_invoice_id, p_amount_minor, p_reason,
    v_approval.request_id, p_requested_by
  )
  returning * into v_row;

  perform core.record_audit(
    v_invoice.organization_id, 'refund.requested', 'refund', v_row.id, null,
    jsonb_build_object('invoice_id', p_invoice_id, 'amount_minor', p_amount_minor,
                       'approval_request_id', v_approval.request_id)
  );

  return query select 'requested'::text, v_row.id, v_approval.request_id, v_net;
end;
$function$;

-- ── record_refund: verbatim from the catalog, + the one-line capability declaration ──
CREATE OR REPLACE FUNCTION finance.record_refund(p_refund_id uuid, p_provider_refund_id text, p_recorded_by uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, refund_id uuid, net_received bigint)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_row   finance.refunds;
  v_state text;
  v_net   bigint;
begin
  -- Declare the sanctioned-write capability the refunds guard checks
  -- (finance.refunds_write_is_sanctioned, 20260815310000). Transaction-scoped;
  -- a direct Data-API write cannot set it.
  perform set_config('finance.sanctioned_write', 'on', true);
  select r.* into v_row from finance.refunds r where r.id = p_refund_id for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::bigint;
    return;
  end if;

  if v_row.status = 'recorded' then
    return query select 'already_recorded'::text, v_row.id, null::bigint;
    return;
  end if;

  -- The gate. Not a convention: without an approved request behind it, no
  -- amount of calling this function moves anything.
  select a.state into v_state
    from approvals.approval_requests a
   where a.id = v_row.approval_request_id;

  if v_state is distinct from 'approved' then
    return query select 'not_approved'::text, v_row.id, null::bigint;
    return;
  end if;

  -- Re-checked here as well as at request time, and under the invoice's lock:
  -- a refund approved yesterday must still fit today, because another refund
  -- may have been recorded in between.
  perform 1 from finance.invoices i where i.id = v_row.invoice_id for update;
  v_net := finance.net_received_minor(v_row.invoice_id);

  if v_row.amount_minor > v_net then
    return query select 'exceeds_received'::text, v_row.id, v_net;
    return;
  end if;

  begin
    update finance.refunds
       set status = 'recorded',
           provider_refund_id = p_provider_refund_id,
           recorded_by = p_recorded_by,
           recorded_at = now()
     where finance.refunds.id = v_row.id
       and finance.refunds.status = 'requested';
  exception
    when unique_violation then
      -- refunds_provider_key. The same bank reference twice is one refund
      -- being recorded twice, which is the retry case rather than an error.
      return query select 'duplicate'::text, v_row.id, v_net;
      return;
  end;

  perform core.record_audit(
    v_row.organization_id, 'refund.recorded', 'refund', v_row.id,
    to_jsonb(v_row),
    jsonb_build_object('status', 'recorded', 'provider_refund_id', p_provider_refund_id,
                       'net_received_after', v_net - v_row.amount_minor)
  );

  return query select 'recorded'::text, v_row.id, v_net - v_row.amount_minor;
end;
$function$;

