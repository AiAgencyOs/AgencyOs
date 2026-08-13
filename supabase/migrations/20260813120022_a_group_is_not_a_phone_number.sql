-- ═══════════════════════════════════════════════════════════════════════════
-- A group is not a phone number.
--
-- G-110's defect, found by reading the provider's documentation rather than by
-- any check this repository runs.
--
-- `send_outbound_message` has always resolved the recipient the only way that
-- made sense when every conversation was a 1:1 thread: from the conversation's
-- **contact**, whose `phone` it returns. G-109 then added group conversations,
-- which have no contact at all — `conversations_kind_shape` requires
-- `lead_id is null and project_id is null` for an internal group, and no group
-- carries a contact.
--
-- So a group send returned `to_phone = null`. Confirmed against a real
-- database rather than reasoned about:
--
--   select outcome, to_phone from crm.send_outbound_message(<internal group>, 'x', 'k');
--    created | <NULL>
--
-- G-110's announcer treats a null recipient as a permanent failure, so **every
-- announcement would have parked dead** and the backlog alert would have fired
-- on the pile. The sixteen live checks behind it all passed, because every one
-- of them tests the database half — the event, the reference, the audience
-- filter, the idempotency — and none of them sends anything.
--
-- ── what the provider actually wants ──────────────────────────────────────
--
-- Meta's Groups API (developers.facebook.com/documentation/business-messaging/
-- whatsapp/groups) takes a different envelope for a group:
--
--   individual:  { recipient_type: 'individual', to: '<phone>' }
--   group:       { recipient_type: 'group',      to: '<group id>' }
--
-- and the group id is exactly what `conversations.external_ref` already holds
-- for a `project_group` or `internal_group` — G-109 stores the provider-side id
-- there and `conversations_group_external_ref_key` makes it unique.
--
-- Inbound is supported too: a group message arrives carrying `group_id`
-- alongside `from`, which is the individual participant. That is what makes
-- G-115 buildable, and it is not built here.
--
-- ── the shape of the fix ──────────────────────────────────────────────────
--
-- The function returns **what to send to and how to address it**, rather than
-- a column named for one of the two cases. A caller that forgets to look at
-- the kind now sends to a group id with `recipient_type: 'individual'` and is
-- refused by the provider, which is a loud failure; before this it silently
-- had nothing to send to at all.
--
-- `to_phone` is kept as a column name in the result for exactly one reason: it
-- is what `sendClientMessage` and the announcer already read, and renaming it
-- in the same change that fixes the behaviour would make the diff about the
-- rename. It now means "the recipient", and the comment says so.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists crm.send_outbound_message(uuid, text, text, uuid);

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
  -- Who to send to: a phone number for a 1:1 thread, the provider's group id
  -- for a group. Read here so the caller makes one round trip rather than
  -- three and cannot assemble a message for one organization from another's
  -- settings.
  to_phone   text,
  from_phone_number_id text,
  -- How to address it: 'individual' or 'group', straight into the provider's
  -- `recipient_type`. Returned rather than inferred by the caller, because the
  -- caller would have to re-read the conversation to infer it.
  recipient_type text
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
  v_is_group     boolean;
begin
  select c.* into v_conversation
    from crm.conversations c
   where c.id = p_conversation_id
   for update;

  if v_conversation.id is null then
    return query select 'not_found'::text, null::uuid, null::int, null::text, null::text, null::text;
    return;
  end if;

  v_is_group := v_conversation.kind in ('project_group', 'internal_group');

  select m.* into v_existing
    from crm.conversation_messages m
   where m.organization_id = v_conversation.organization_id
     and m.external_ref    = p_external_ref;

  select o.settings into v_settings
    from core.organizations o
   where o.id = v_conversation.organization_id;

  if v_existing.id is not null then
    -- A retry of the same send. The recipient is recomputed rather than
    -- remembered, so a caller that retries after a group was linked gets the
    -- current answer instead of the one that was true the first time.
    select ct.* into v_contact from crm.contacts ct where ct.id = v_conversation.contact_id;

    return query select 'already_sent'::text, v_existing.id, v_existing.seq,
                        case when v_is_group then v_conversation.external_ref else v_contact.phone end,
                        v_settings->>'whatsapp_phone_number_id',
                        case when v_is_group then 'group' else 'individual' end;
    return;
  end if;

  -- `-1`, not `0`: a thread's first message is seq 0. Carried forward from the
  -- original verbatim, because rewriting it as `coalesce(max, 0) + 1` — which
  -- is what this said for one commit — shifts every thread's numbering by one
  -- and was caught only by verify-outbound-messages asserting the first seq.
  -- Exactly the regeneration drift D16 was.
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

  perform core.record_audit(
    v_conversation.organization_id,
    'message.outbound.queued',
    'conversation_message',
    v_row.id,
    null,
    jsonb_build_object('conversation_id', p_conversation_id, 'seq', v_next)
  );

  return query select 'created'::text, v_row.id, v_next,
                      -- The whole fix, in one expression: a group is addressed
                      -- by the provider id G-109 already stores, not by a
                      -- contact's phone that a group does not have.
                      case when v_is_group then v_conversation.external_ref else v_contact.phone end,
                      v_settings->>'whatsapp_phone_number_id',
                      case when v_is_group then 'group' else 'individual' end;
end;
$$;

comment on function crm.send_outbound_message(uuid, text, text, uuid) is
  'Records an outbound message before it is sent, allocating seq under the conversation''s lock and deduplicating on the caller''s idempotency key. Returns the recipient AND how to address it - a phone number for a 1:1 thread, the provider''s group id with recipient_type ''group'' for a group, which is what Meta''s Groups API requires. Before this it returned a contact''s phone unconditionally, so a group send resolved to null and G-110''s announcements would every one have parked dead.';

revoke all on function crm.send_outbound_message(uuid, text, text, uuid) from public;
grant execute on function crm.send_outbound_message(uuid, text, text, uuid) to authenticated, service_role;
