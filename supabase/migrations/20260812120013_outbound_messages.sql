-- ═══════════════════════════════════════════════════════════════════════════
-- Saying something back.
--
-- Gap G-014, decision ADM-09 — taken under the Admin's blanket delegation of
-- 2026-08-13, and it was the narrowest decision in the set: the inbound
-- webhook already speaks WhatsApp Cloud API, so outbound over the same Graph
-- API is the matching half rather than a new vendor. Recorded as delegated so
-- it can be reversed on sight.
--
-- Until now AgencyOS could hear and could not answer. Every automation the
-- directive describes — follow-ups, payment reminders, delivery notices,
-- review nudges — ends in a message to a client, and there was nowhere for one
-- to go.
--
-- ── the row is written before the send, not after ─────────────────────────
--
-- That ordering is the whole design. A message sent and not recorded is
-- invisible: nobody knows it went, a retry sends it twice, and the transcript
-- the AI extracts requirements from has a hole in it. A message recorded and
-- not sent is merely wrong in a way anybody can see and fix.
--
-- So `send_outbound_message` writes the row first, marked pending, and the
-- caller reports back what the provider said. `conversation_messages_external_ref_key`
-- — the unique index the inbound path already relies on — makes the second
-- attempt at the same message find the first instead of writing another. The
-- caller passes the key, so a retried Server Action, a double-clicked button
-- and a re-run job all land on the same row.
--
-- ── seq is allocated under the conversation's own lock ────────────────────
--
-- `unique (conversation_id, seq)` is not advice. Two staff replying at the
-- same moment both read `max(seq)` and both write `max+1`, and one of them
-- loses their message to a 23505 — which is C2, one table along. The
-- conversation row is locked for the duration, so the second waits and gets
-- the next number.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.send_outbound_message(
  p_conversation_id uuid,
  p_body            text,
  -- The caller's idempotency key. Not defaulted: a caller that forgets it
  -- would get at-least-once delivery to a paying client, so omitting it must
  -- fail to type-check rather than silently work most of the time.
  p_external_ref    text,
  p_author_id       uuid default null
)
returns table (
  -- 'created' | 'already_sent' | 'not_found'
  outcome    text,
  message_id uuid,
  seq        int,
  -- The number to send to, and the account to send it from, read here so the
  -- caller makes one round trip rather than three and cannot assemble a
  -- message for one organization from another's settings.
  to_phone   text,
  from_phone_number_id text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_conversation crm.conversations;
  v_existing     crm.conversation_messages;
  v_next         int;
  v_row          crm.conversation_messages;
  v_contact      crm.contacts;
  v_settings     jsonb;
begin
  select c.* into v_conversation
    from crm.conversations c
   where c.id = p_conversation_id
   for update;

  if v_conversation.id is null then
    return query select 'not_found'::text, null::uuid, null::int, null::text, null::text;
    return;
  end if;

  -- Answered before anything is written, and from the same predicate the index
  -- enforces, so a retry is cheap rather than an exception path.
  select m.* into v_existing
    from crm.conversation_messages m
   where m.organization_id = v_conversation.organization_id
     and m.external_ref    = p_external_ref;

  if v_existing.id is not null then
    return query select 'already_sent'::text, v_existing.id, v_existing.seq, null::text, null::text;
    return;
  end if;

  select coalesce(max(m.seq), -1) + 1 into v_next
    from crm.conversation_messages m
   where m.conversation_id = p_conversation_id;

  insert into crm.conversation_messages (
    organization_id, conversation_id, seq, author_type, author_id,
    body, external_ref, metadata, occurred_at
  )
  values (
    v_conversation.organization_id, p_conversation_id, v_next, 'user', p_author_id,
    p_body, p_external_ref,
    jsonb_build_object('channel', 'whatsapp', 'direction', 'outbound', 'delivery', 'pending'),
    now()
  )
  returning * into v_row;

  select ct.* into v_contact from crm.contacts ct where ct.id = v_conversation.contact_id;

  select o.settings into v_settings
    from core.organizations o
   where o.id = v_conversation.organization_id;

  perform core.record_audit(
    v_conversation.organization_id,
    'message.outbound.queued',
    'conversation_message',
    v_row.id,
    null,
    jsonb_build_object('conversation_id', p_conversation_id, 'seq', v_next)
  );

  return query select 'created'::text, v_row.id, v_next,
                      v_contact.phone,
                      v_settings->>'whatsapp_phone_number_id';
end;
$$;

comment on function crm.send_outbound_message(uuid, text, text, uuid) is
  'Records an outbound message before it is sent, allocating seq under the conversation''s lock and deduplicating on the caller''s idempotency key. Returns the number to send to and the account to send from, so a caller cannot assemble one organization''s message from another''s settings. A message recorded and not sent is visibly wrong; a message sent and not recorded is invisible.';

/**
 * What the provider said.
 *
 * Separate from the send so the row exists whatever happens next. Metadata
 * only — the body, the author and the position in the thread are settled and
 * a delivery report has no business changing any of them.
 */
create or replace function crm.mark_outbound_delivery(
  p_message_id   uuid,
  p_status       text,
  p_provider_ref text default null,
  p_error        text default null
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_updated uuid;
begin
  if p_status not in ('sent', 'failed') then
    raise exception 'delivery status must be sent or failed, not %', p_status
      using errcode = 'check_violation';
  end if;

  update crm.conversation_messages
     set metadata = metadata
       || jsonb_build_object('delivery', p_status)
       || case when p_provider_ref is null then '{}'::jsonb
               else jsonb_build_object('provider_ref', p_provider_ref) end
       || case when p_error is null then '{}'::jsonb
               else jsonb_build_object('error', p_error) end
   where id = p_message_id
     -- Only a pending message is settled, so a late duplicate report cannot
     -- turn a delivered message into a failed one.
     and metadata->>'delivery' = 'pending'
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
$$;

comment on function crm.mark_outbound_delivery(uuid, text, text, text) is
  'Records what the provider said about one outbound message. Metadata only, and only for a message still pending, so a late or duplicate report cannot rewrite a settled delivery.';

revoke all on function crm.send_outbound_message(uuid, text, text, uuid) from public;
revoke all on function crm.mark_outbound_delivery(uuid, text, text, text) from public;

grant execute on function crm.send_outbound_message(uuid, text, text, uuid) to authenticated, service_role;
grant execute on function crm.mark_outbound_delivery(uuid, text, text, text) to authenticated, service_role;
