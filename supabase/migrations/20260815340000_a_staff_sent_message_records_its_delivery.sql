-- ═══════════════════════════════════════════════════════════════════════════
-- A staff-sent client message can actually record its delivery — and the
-- transcript stays immutable to a direct write.
--
-- Found by core.audit_invoker_writes_without_policy() (20260815330000): the same
-- class as the payment/refund fixes. crm.conversation_messages has an INSERT and
-- a SELECT policy but NO UPDATE policy. crm.mark_outbound_delivery — the ONLY
-- function that updates a message (to stamp delivery state and write the G-079
-- audit row in one transaction) — is SECURITY INVOKER, and `sendClientMessage`
-- (the internal "message this lead" action, app/(internal)/leads/[leadId]) calls
-- it with the USER's session. So its UPDATE matched zero rows under RLS and
-- returned false: a staff-sent WhatsApp message was delivered on the wire but its
-- row stayed `delivery: pending` with no audit, forever — a failed send looked
-- identical to a pending one. The follow-up job path (via the service role,
-- RLS-bypassing) recorded delivery correctly, which is why it was invisible.
--
-- FIX (mirrors payments/refunds): an UPDATE policy scoped to the admins who can
-- send (owner/ops_admin — `sendClientMessage` gates on lead.write), so the
-- sanctioned update passes RLS — plus a guard admitting an authenticated UPDATE
-- only when it carries the crm.sanctioned_write capability mark_outbound_delivery
-- now sets, or an identity-less server-side caller. So delivery recording works,
-- while a direct Data-API PATCH cannot rewrite a message's body or forge its
-- delivery state (the transcript stays the append-only record §16 relies on).
-- ═══════════════════════════════════════════════════════════════════════════

create policy conversation_messages_sanctioned_update on crm.conversation_messages
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

create or replace function crm.conversation_messages_update_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_setting('crm.sanctioned_write', true) = 'on' then
    return new;
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  raise exception
    'crm.conversation_messages is updated only through mark_outbound_delivery, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function crm.conversation_messages_update_is_sanctioned() is
  'Refuses any authenticated end-user UPDATE of crm.conversation_messages that did not come through crm.mark_outbound_delivery (which sets the transaction-scoped crm.sanctioned_write flag as it stamps a message''s delivery state). A direct PATCH over the Data API cannot set it and is refused, so a message body cannot be rewritten and a delivery state cannot be forged. The service role and other identity-less callers are unrestricted. INSERT keeps its own policy; message rows are otherwise append-only.';

drop trigger if exists conversation_messages_update_is_sanctioned on crm.conversation_messages;
create trigger conversation_messages_update_is_sanctioned
  before update on crm.conversation_messages
  for each row execute function crm.conversation_messages_update_is_sanctioned();

-- MAINTENANCE: a future CREATE OR REPLACE of crm.mark_outbound_delivery MUST keep
-- the set_config('crm.sanctioned_write', 'on', true) line, or staff-sent message
-- delivery recording breaks again. tests/finance-sanctioned-write.test.ts pins it.
-- The function follows, verbatim from the catalog + that one line.

CREATE OR REPLACE FUNCTION crm.mark_outbound_delivery(p_message_id uuid, p_status text, p_provider_ref text DEFAULT NULL::text, p_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_updated uuid;
begin
  -- Declare the sanctioned-write capability the conversation_messages guard
  -- checks (crm.conversation_messages_update_is_sanctioned, 20260815340000).
  perform set_config('crm.sanctioned_write', 'on', true);
  if p_status not in ('sent', 'failed') then
    raise exception 'delivery status must be sent or failed, not %', p_status
      using errcode = 'check_violation';
  end if;

  update crm.conversation_messages
     -- A message that failed and then delivered must not keep the old error:
     -- {delivery: sent, error: 'HTTP 500'} reads as both at once, and no
     -- surface rendering metadata.error could tell recovery from failure.
     set metadata = (case when p_status = 'sent' then metadata - 'error' else metadata end)
       || jsonb_build_object('delivery', p_status)
       || case when p_provider_ref is null then '{}'::jsonb
               else jsonb_build_object('provider_ref', p_provider_ref) end
       || case when p_error is null then '{}'::jsonb
               else jsonb_build_object('error', p_error) end
   where id = p_message_id
     -- `sent` is terminal. The old
     -- predicate admitted only `pending`, which protected against a late
     -- duplicate report but also blocked failed → sent — so a message that
     -- failed transiently and then delivered on retry read `failed` forever,
     -- in the transcript and on the operations screen. Measured before
     -- fixing: mark(sent) after mark(failed) returned false and the state
     -- stayed failed.
     --
     -- The list names the two settleable states rather than excluding `sent`,
     -- and the difference is not style — review caught it. `is distinct from
     -- 'sent'` also admits rows with NO delivery key at all, which is every
     -- INBOUND message, so a wrong message id passed by a future service-role
     -- caller would have stamped delivery state and an outbound audit row
     -- onto a client's own words. Under this predicate, as under the original,
     -- that call matches zero rows and returns false.
     and metadata->>'delivery' in ('pending', 'failed')
  returning id into v_updated;

  -- Audited from inside the transaction that records the delivery, rather
  -- than from a thirteenth service call site. G-079 moved the four writes
  -- that had a function to sit inside; this one is born with one, so it
  -- should not be added to the twelve that G-093 still describes.
  if v_updated is not null then
    perform core.record_audit(
      (select m.organization_id from crm.conversation_messages m where m.id = p_message_id),
      'message.outbound.' || p_status,
      'conversation_message',
      p_message_id,
      null,
      jsonb_build_object('provider_ref', p_provider_ref, 'error', p_error)
    );
  end if;

  return v_updated is not null;
end;
$function$;
