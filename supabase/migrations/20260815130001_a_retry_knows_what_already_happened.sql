-- ═══════════════════════════════════════════════════════════════════════════
-- A retry knows what already happened.
--
-- `crm.send_outbound_message` answers `already_sent` when a row with the
-- caller's external_ref already exists — the idempotent path both the
-- announcer and the follow-up delivery rely on after a crash or a reaped job.
-- But it did not say WHAT already happened: sent, or written-and-not-yet-sent,
-- or failed. So the two callers each guessed, and each guessed wrong in a way
-- that costs a real message:
--
--   • the announcer treated any already_sent as done, and returned success
--     even when the row read `pending` or `failed` — a provider failure whose
--     retry hit already_sent reported success while nothing was delivered and
--     the owner was never told what needed deciding;
--
--   • the follow-up handler had no already_sent branch at all, so it fell
--     through and called the provider AGAIN — a client double-messaged on the
--     wire whenever a job was reaped after the provider accepted but before
--     the local settle.
--
-- The row already knows which it is. This returns it, so a retry can send only
-- when sending is still needed and stay silent when it is not. Nothing about
-- the send decision moves into the caller; the caller is merely told the
-- delivery state the row has always carried.
--
-- This is a return-type change (a seventh column), so the function is DROPped
-- and recreated — `create or replace` refuses a new column in RETURNS TABLE.
-- EVERYTHING ELSE IS THE PRIOR BODY, VERBATIM: the consent rule (direct-only,
-- project_group unmodelled per G-136, internal_group exempt per G-110), the
-- audit call, the seq base, and the grants to `authenticated, service_role`.
-- A first draft hand-reproduced the body and drifted — it dropped the
-- authenticated grant and narrowed the group exemption, silently resolving the
-- open ADM-86 decision and breaking the interactive send path. Adversarial
-- review caught both; this copies the original and adds only the column.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists crm.send_outbound_message(uuid, text, text, uuid);

CREATE FUNCTION crm.send_outbound_message(p_conversation_id uuid, p_body text, p_external_ref text, p_author_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, message_id uuid, seq integer, to_phone text, from_phone_number_id text, recipient_type text, delivery text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    return query select 'not_found'::text, null::uuid, null::int, null::text, null::text, null::text, null::text;
    return;
  end if;

  v_is_group := v_conversation.kind in ('project_group', 'internal_group');

  -- ── consent, at the chokepoint ─────────────────────────────────────────
  --
  -- G-012, ADM-70, ADM-81. Placed here rather than in a caller because ADM-70
  -- required the communication system to enforce it: both callers pass through
  -- this function, so a future third one does not get to skip the rule by not
  -- knowing about it. That is the G-093 argument again.
  --
  -- Checked BEFORE the idempotency lookup deliberately. A send that was
  -- refused for want of consent must not become permitted by being retried.
  -- `direct` only, and the boundary is a category judgement rather than a
  -- convenience. This consent model is per contact per channel, and `direct`
  -- is the only kind that has a contact.
  --
  -- A `project_group` has none, so group consent is UNMODELLED and recorded as
  -- G-136 / ADM-86 rather than quietly resolved here — refusing every group
  -- send would break the group messaging G-014 and G-109 built, and pretending
  -- a group "consented" would invent a record nobody made.
  --
  -- `internal_group` is exempt because there is no client on the other end at
  -- all: the approval announcement runs through this same function, and
  -- suppressing it would silently break G-110.
  if v_conversation.kind = 'direct' then
    if v_conversation.contact_id is null then
      -- A client-facing conversation with nobody identifiable on the other
      -- end. Refused rather than allowed: treating "no identifiable contact"
      -- as "no objection" is how a consent model becomes decorative.
      return query select 'no_consent'::text, null::uuid, null::int,
                          null::text, null::text, null::text, null::text;
      return;
    end if;

    if not exists (
      select 1
        from crm.communication_consent cc
       where cc.organization_id = v_conversation.organization_id
         and cc.contact_id      = v_conversation.contact_id
         and cc.channel         = 'whatsapp'
         and cc.status          = 'granted'
    ) then
      -- Absent and withdrawn are the same answer. ADM-70: absent consent means
      -- do not send, and withdrawn stops future sends on that channel.
      return query select 'no_consent'::text, null::uuid, null::int,
                          null::text, null::text, null::text, null::text;
      return;
    end if;
  end if;

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
    -- current answer instead of the one that was true the first time. And now
    -- the delivery state travels with it, so the caller sends again only if
    -- the row is not already `sent`.
    select ct.* into v_contact from crm.contacts ct where ct.id = v_conversation.contact_id;

    return query select 'already_sent'::text, v_existing.id, v_existing.seq,
                        case when v_is_group then v_conversation.external_ref else v_contact.phone end,
                        v_settings->>'whatsapp_phone_number_id',
                        case when v_is_group then 'group' else 'individual' end,
                        coalesce(v_existing.metadata->>'delivery', 'pending');
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
                      case when v_is_group then 'group' else 'individual' end,
                      'pending'::text;
end;
$function$;

comment on function crm.send_outbound_message(uuid, text, text, uuid) is
  'Queues an outbound message idempotently on external_ref and refuses one to a client without recorded consent (G-012, ADM-70, ADM-81). Now returns the row''s delivery state alongside the already_sent outcome, so a retry after a crash or a reaped job sends again only when the row is not already sent - the announcer no longer reports success over a pending row, and the follow-up handler no longer double-messages a client on the wire. internal_group is exempt (the approval announcement is not client communication - G-110); project_group consent stays unmodelled (G-136).';

grant execute on function crm.send_outbound_message(uuid, text, text, uuid) to authenticated, service_role;
