-- ═══════════════════════════════════════════════════════════════════════════
-- A message reports what the wire did — G-... (C10, production-readiness).
--
-- Until now an outbound message carried one delivery axis: `metadata.delivery`,
-- which is pending → sent | failed and answers "did the PROVIDER accept it?".
-- crm.mark_outbound_delivery settles that the moment sendWhatsAppText returns a
-- providerRef. What happened AFTER — did WhatsApp deliver it to the recipient's
-- phone, did the recipient read it, did a downstream failure bounce it — is a
-- SECOND axis Meta reports asynchronously, in the same webhook envelope, under
-- `value.statuses[]`, keyed by the message id we stored as `provider_ref`.
--
-- Those receipts were parsed and DROPPED (src/lib/whatsapp/payload.ts counted
-- them as `ignored`). So the transcript could show a follow-up `sent` that in
-- fact never reached the client, and nothing distinguished a read message from
-- one still sitting on Meta's servers. This records that second axis honestly.
--
-- DESIGN — a separate axis, not an overload:
--   * `metadata.wire_status` holds the Meta-reported downstream state
--     (sent | delivered | read | failed) and is left ENTIRELY separate from
--     `metadata.delivery` (the accept-state). A message can be delivery=sent
--     (we handed it off) and wire_status=failed (Meta later said it bounced),
--     and reading both is the point — collapsing them would hide exactly the
--     case that matters.
--   * MONOTONIC. sent(1) < delivered(2) < read(3); `read` and `failed` are
--     terminal. A receipt is recorded only when it advances the status, so an
--     out-of-order or duplicate receipt (Meta does not guarantee order) is a
--     no-op and the status can never regress.
--   * Tenancy from DATA, never the payload — the same rule crm.ingest_whatsapp_
--     message follows: the org is resolved from `whatsapp_phone_number_id` in
--     core.organizations.settings, and the update is scoped to that org AND to
--     an OUTBOUND row, so a receipt can neither stamp wire state onto an
--     inbound message (a client's own words) nor reach across a tenant even if
--     two providers ever minted the same id.
--   * It does NOT touch escalation. Whether a never-delivered attempt may still
--     escalate is the C3/P7 caveat, an owner decision (ADM-11 territory); this
--     records the FACT the honest fix will one day read, and changes no
--     follow-up behaviour today.
--
-- One of the sanctioned service-role write paths: only the webhook (identity-
-- less) calls this, so it is granted to service_role alone. It still sets the
-- crm.sanctioned_write flag the conversation_messages UPDATE guard checks
-- (20260815340000), so it works regardless of how the guard evolves.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.record_delivery_receipt(
  p_phone_number_id text,
  p_provider_ref text,
  p_status text,
  p_occurred_at timestamptz default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org           uuid;
  v_message_id    uuid;
  v_current       text;
  v_incoming_rank int;
  v_current_rank  int;
  v_when          timestamptz := coalesce(p_occurred_at, now());
begin
  -- Declare the sanctioned-write capability the conversation_messages guard
  -- checks (crm.conversation_messages_update_is_sanctioned, 20260815340000).
  perform set_config('crm.sanctioned_write', 'on', true);

  -- An unknown status string is acknowledged, not raised: Meta may add states,
  -- and a webhook that 500s on one it does not know would have Meta redeliver
  -- the whole batch forever.
  if p_status not in ('sent', 'delivered', 'read', 'failed') then
    return 'ignored_unknown_status';
  end if;

  -- Tenancy from data. An organization claims a number by putting its
  -- phone_number_id in settings; a receipt for a number no org claims is
  -- acknowledged and dropped, exactly as an inbound message for it would be.
  select o.id into v_org
    from core.organizations o
   where o.settings->>'whatsapp_phone_number_id' = p_phone_number_id
   limit 1;
  if v_org is null then
    return 'unknown_phone_number_id';
  end if;

  -- The receipt names a message by the provider's id, which we stored as
  -- provider_ref when the send was accepted (crm.mark_outbound_delivery). The
  -- match is scoped to the resolved org AND to an outbound row: a receipt
  -- cannot stamp wire state onto an inbound message, and cannot cross a tenant.
  -- Locked, because two receipts for one message can arrive in one burst.
  select m.id, m.metadata->>'wire_status'
    into v_message_id, v_current
    from crm.conversation_messages m
   where m.organization_id = v_org
     and m.metadata->>'direction' = 'outbound'
     and m.metadata->>'provider_ref' = p_provider_ref
   for update
   limit 1;
  if v_message_id is null then
    -- The message is not ours, or its send has not yet recorded a provider_ref
    -- (a receipt racing ahead of our own accept-recording). Either way there is
    -- nothing to stamp; saying so is honest.
    return 'unmatched';
  end if;

  -- `read` and `failed` are terminal — a read message cannot un-read and a
  -- failed one is final — so a later contradicting receipt is dropped.
  if v_current in ('read', 'failed') then
    return 'ignored_terminal';
  end if;

  v_incoming_rank := case p_status
    when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'failed' then 4 end;
  v_current_rank := case v_current
    when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;

  -- Monotonic: record only a forward move. A duplicate or an out-of-order
  -- receipt (delivered arriving after read) is a no-op.
  if v_incoming_rank <= v_current_rank then
    return 'ignored_not_forward';
  end if;

  update crm.conversation_messages
     set metadata = metadata
       || jsonb_build_object('wire_status', p_status)
       || jsonb_build_object(p_status || '_at', to_jsonb(v_when))
   where id = v_message_id;

  -- A wire failure is a low-volume event worth an audit trail — a message the
  -- provider accepted but never delivered is a real problem an operator will
  -- want to trace. delivered/read are high-volume telemetry; the message row
  -- is their record, so they are not audited.
  if p_status = 'failed' then
    perform core.record_audit(
      v_org,
      'message.outbound.wire_failed',
      'conversation_message',
      v_message_id,
      null,
      jsonb_build_object('provider_ref', p_provider_ref, 'occurred_at', to_jsonb(v_when))
    );
  end if;

  return 'recorded';
end;
$$;

-- Status receipts are the highest delivery by volume, and each one looks a
-- message up by (organization_id, provider_ref). Without an index that is a
-- scan of the org's whole transcript per receipt; with one it is a probe.
-- Partial, because only outbound messages that were accepted carry a
-- provider_ref — inbound rows and unsent drafts do not, and indexing them
-- would be dead weight.
create index if not exists conversation_messages_provider_ref_idx
  on crm.conversation_messages (organization_id, (metadata->>'provider_ref'))
  where metadata->>'provider_ref' is not null;

comment on function crm.record_delivery_receipt(text, text, text, timestamptz) is
  'Records one Meta delivery receipt (sent/delivered/read/failed) against the outbound message it names by provider_ref, on a monotonic metadata.wire_status axis separate from metadata.delivery. Tenancy is resolved from phone_number_id in organizations.settings, never the payload; the update is scoped to the resolved org and to an outbound row, so a receipt cannot touch an inbound message or cross a tenant. read and failed are terminal; an out-of-order or duplicate receipt is a no-op. Does not change escalation (C3/P7, owner-gated). Service-role only.';

revoke all on function crm.record_delivery_receipt(text, text, text, timestamptz) from public;
grant execute on function crm.record_delivery_receipt(text, text, text, timestamptz) to service_role;
