-- A quotation the client can keep — brief §12.
--
-- A WhatsApp text is read once and scrolls away. The thing a client saves,
-- forwards to a partner, prints and signs against is a document — and §12's
-- bar for it is professional, readable, structured, branded, versioned,
-- traceable, with one hard rule at the bottom: do not add undocumented
-- commercial commitments. The renderer lives in the application
-- (src/lib/pdf/quotation.ts) and follows the same law as the text form:
-- nothing the proposal row does not record appears in the document.
--
-- This migration is only the part the database owns: **the transcript could
-- not say a document was sent.** `crm.send_outbound_message` took a body and
-- nothing else, hardcoded its metadata, and `conversation_messages_body_check`
-- makes body-and-media mutually exclusive — so an outbound PDF either went
-- unrecorded (a wire message the transcript denies, the exact shape G-155
-- just closed in the announcer) or lied about being text.
--
-- ── what this changes ───────────────────────────────────────────────────────
--
-- `send_outbound_message` gains `p_media_type` / `p_media_filename`. A
-- document row records an EMPTY body with metadata.media_type = 'document'
-- and its filename — which is precisely the shape the existing body check
-- already permits, so no constraint moves. Everything else — the consent
-- refusal, the idempotency on external_ref, the sequence under the lock, the
-- group-vs-individual routing, the audit row — is carried forward verbatim
-- and applies to a document exactly as it applies to text. A caption was
-- deliberately NOT added: the words travel in the text message beside the
-- document, where the price guard (crm.refuse_unread_price) can read them.
--
-- `media_type` is restricted to 'document', and the inbound reading engine
-- stays asleep on these rows by construction: crm.awaits_media_reading wakes
-- for image/audio rows carrying a media_id, and an outbound document row has
-- neither.
--
-- ── what this deliberately does not change ──────────────────────────────────
--
-- No new consent rule (the existing one applies), no exemption anywhere, no
-- new event, no reading of documents. ADM-74 stands: a PDF delivered to the
-- internal group is content the channel may carry; the approval still settles
-- in AgencyOS and nothing reads a reply.
-- D16: carried forward verbatim from 20260815460000_a_post_project_thread.sql
-- with three marked edits (the signature, the shape guard, and the insert).
CREATE OR REPLACE FUNCTION crm.send_outbound_message(p_conversation_id uuid, p_body text, p_external_ref text, p_author_id uuid DEFAULT NULL::uuid, p_media_type text DEFAULT NULL::text, p_media_filename text DEFAULT NULL::text)
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
  -- ── EDIT 2 (the only new refusal) ─────────────────────────────────────────
  -- A document row and a text row are exclusive shapes, and the exclusivity
  -- is already law: conversation_messages_body_check makes body-with-media a
  -- constraint violation. Refusing here turns that violation into an answer
  -- a caller can read. `document` only — this function has no business
  -- claiming an outbound image or voice note was sent when nothing here can
  -- send one, and the inbound reading engine (crm.awaits_media_reading)
  -- wakes for image/audio rows, which an outbound send must never look like.
  if p_media_type is not null and (p_media_type <> 'document' or length(trim(p_body)) > 0) then
    return query select 'bad_shape'::text, null::uuid, null::int, null::text, null::text, null::text, null::text;
    return;
  end if;

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
  --
  -- G-139: `client_account` joins `direct` here. A post-project thread carries
  -- the client account's contact, so it IS a kind that has a contact, and the
  -- same per-contact consent rule applies — it is client-facing communication.
  if v_conversation.kind in ('direct', 'client_account') then
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
    -- EDIT 3: a document row records an empty body (the body check's media
    -- shape) and carries its kind and filename in metadata, exactly where the
    -- inbound ingest records a client's media. `direction` says which way it
    -- went; media_id is deliberately absent, so nothing tries to re-read it.
    case when p_media_type is null then p_body else '' end, p_external_ref,
    jsonb_build_object('channel', 'whatsapp', 'direction', 'outbound', 'delivery', 'pending')
      || case when p_media_type is null then '{}'::jsonb
              else jsonb_build_object('media_type', p_media_type, 'media_filename', p_media_filename) end,
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

comment on function crm.send_outbound_message(uuid, text, text, uuid, text, text) is
  'Queues an outbound message idempotently on external_ref and refuses one to a client without recorded consent (G-012, ADM-70, ADM-81). Returns the row''s delivery state alongside already_sent so a retry sends again only when the row is not already sent. Consent is per-contact-per-channel and enforced for the kinds that have a contact: direct and client_account (G-139, addressed by the contact''s phone). internal_group is exempt (approval announcement, G-110); project_group is messaged on membership (ADM-86 = A, G-136). A document send (G-156) records media_type ''document'' and a filename with an empty body — the body check''s media shape — and answers bad_shape to any other media claim, because nothing here can send one.';

-- The four-argument signature is replaced by the six-argument one above;
-- PostgREST resolves defaulted parameters, so every existing caller is
-- unchanged. The old function object is dropped so there is exactly one
-- definition to read — and one to carry forward next time.
drop function if exists crm.send_outbound_message(uuid, text, text, uuid);

grant execute on function crm.send_outbound_message(uuid, text, text, uuid, text, text) to authenticated, service_role;
