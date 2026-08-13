-- ═══════════════════════════════════════════════════════════════════════════
-- A message in a group belongs to the group.
--
-- Gap G-115, found while building G-110 and filed rather than absorbed.
--
-- `crm.ingest_whatsapp_message` resolves an organization from the phone number
-- id and then unconditionally creates **a contact, a lead and a `direct`
-- conversation**. It has no notion of `kind` at all, because when it was
-- written every conversation was a 1:1 thread.
--
-- G-109 then added groups as an *outbound* channel. Nothing has ever routed an
-- inbound group message, so nothing has broken — but the moment a webhook does,
-- every message anybody sends in a project group or the internal approval group
-- becomes a **new lead** for whoever sent it. A colleague typing "morning" in
-- the internal group would open a sales lead on themselves, and a client's
-- message in their own project group would open a second lead beside the one
-- they already have. Silent, and in the CRM.
--
-- ── the provider makes this straightforward ───────────────────────────────
--
-- Meta's Groups API (developers.facebook.com/documentation/business-messaging/
-- whatsapp/groups) delivers an inbound group message carrying **`group_id`**
-- in the message object, with `from` naming the individual participant who
-- sent it. So the two cases are distinguishable at the door, and the group id
-- is what `crm.conversations.external_ref` already holds for both group kinds.
--
-- ── what this deliberately does not do ────────────────────────────────────
--
-- **No contact, no lead.** That is the whole point: a group participant is not
-- a sales lead, and inventing one is the defect. The sender's number is kept
-- on the message's metadata so attribution remains possible later.
--
-- **No attribution to a user or contact.** `author_type` is `'client'` for a
-- project group and `'user'` for the internal group — the audience each group
-- has, and the most this can honestly say. Matching a sender's phone to a
-- `core.users` row is impossible: users have no phone column, which is the
-- same fact that blocks ADM-74. Matching it to a `crm.contacts` row is
-- possible and deliberately not done here, because a contact who is in a group
-- is not necessarily the person the message is *about*, and guessing wrongly
-- would put words in a named client's mouth. **G-116**, and it needs a rule.
--
-- **An unknown group is ignored, not an error.** A business number can be in
-- groups this system does not track, and a webhook must acknowledge rather
-- than retry forever.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.ingest_group_message(
  p_phone_number_id text,
  -- The provider's group id, which is what conversations.external_ref holds.
  p_group_id        text,
  -- The individual participant who sent it. Recorded, never used to create a
  -- lead or a contact.
  p_from            text,
  p_external_ref    text,
  p_body            text,
  p_occurred_at     timestamptz default now()
)
returns table (
  -- 'ingested' | 'replayed' | 'unknown_phone_number_id' | 'unknown_group'
  status          text,
  organization_id uuid,
  conversation_id uuid,
  message_id      uuid,
  message_seq     int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org          uuid;
  v_conversation crm.conversations;
  v_existing     crm.conversation_messages;
  v_phone        text;
  v_author       text;
  v_seq          int;
  v_row          crm.conversation_messages;
begin
  -- ── 1. tenancy, from data ────────────────────────────────────────────────
  select o.id into v_org
    from core.organizations o
   where o.settings->>'whatsapp_phone_number_id' = p_phone_number_id
   limit 1;

  if v_org is null then
    return query select 'unknown_phone_number_id'::text,
                        null::uuid, null::uuid, null::uuid, null::int;
    return;
  end if;

  -- ── 2. the group this belongs to ─────────────────────────────────────────
  --
  -- Scoped to the organization resolved above, not to the group id alone:
  -- `conversations_group_external_ref_key` is unique across groups, but
  -- restating the tenant here means a provider id colliding across tenants
  -- can never file a message into the wrong one.
  select c.* into v_conversation
    from crm.conversations c
   where c.organization_id = v_org
     and c.external_ref    = p_group_id
     and c.kind in ('project_group', 'internal_group')
     and c.status <> 'abandoned'
   limit 1;

  if v_conversation.id is null then
    -- Not ours. Acknowledged rather than retried: the number can be in groups
    -- this system does not track, and a webhook that fails on them is a
    -- webhook the provider redelivers forever.
    return query select 'unknown_group'::text, v_org, null::uuid, null::uuid, null::int;
    return;
  end if;

  -- ── 3. redelivery is free ────────────────────────────────────────────────
  select m.* into v_existing
    from crm.conversation_messages m
   where m.organization_id = v_org
     and m.external_ref    = p_external_ref;

  if v_existing.id is not null then
    return query select 'replayed'::text, v_org, v_existing.conversation_id,
                        v_existing.id, v_existing.seq;
    return;
  end if;

  -- ── 4. the message ───────────────────────────────────────────────────────
  --
  -- The conversation is locked so two participants posting at once cannot both
  -- take the same seq — the C2 pattern, and the same one send_outbound_message
  -- uses on the way out.
  perform 1 from crm.conversations c where c.id = v_conversation.id for update;

  v_phone := '+' || regexp_replace(p_from, '[^0-9]', '', 'g');

  -- The most this can honestly say. A project group holds the client and the
  -- agency; the internal group holds staff and the agent. Neither can be
  -- narrowed to a person without a phone-to-identity link that does not exist
  -- (G-116, and ADM-74 for the half that matters to approvals).
  v_author := case when v_conversation.kind = 'internal_group' then 'user' else 'client' end;

  select coalesce(max(m.seq), -1) + 1 into v_seq
    from crm.conversation_messages m
   where m.conversation_id = v_conversation.id;

  insert into crm.conversation_messages (
    organization_id, conversation_id, seq, author_type, author_id,
    body, external_ref, metadata, occurred_at
  )
  values (
    v_org, v_conversation.id, v_seq, v_author, null,
    p_body, p_external_ref,
    jsonb_build_object(
      'channel', 'whatsapp',
      'direction', 'inbound',
      -- Kept so attribution stays possible without being guessed at now.
      'from', v_phone,
      'group_id', p_group_id
    ),
    p_occurred_at
  )
  returning * into v_row;

  return query select 'ingested'::text, v_org, v_conversation.id, v_row.id, v_seq;
end;
$$;

comment on function crm.ingest_group_message(text, text, text, text, text, timestamptz) is
  'Records an inbound WhatsApp group message against the group it was sent in (G-115). Creates NO contact and NO lead - that is the defect it exists to prevent: crm.ingest_whatsapp_message would file a colleague''s "morning" in the internal group as a new sales lead on that colleague. An unknown group is acknowledged rather than retried, because a number can be in groups this system does not track.';

revoke all on function crm.ingest_group_message(text, text, text, text, text, timestamptz) from public;
grant execute on function crm.ingest_group_message(text, text, text, text, text, timestamptz) to service_role;
