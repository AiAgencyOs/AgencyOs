-- The owner is the channel — decision ADM-95, gap G-159.
--
-- G-109 built the internal announcement channel as a WhatsApp GROUP, and
-- today, on the first real WABA this system has ever had, Meta answered the
-- question nobody could answer from documentation: error #131215, "This
-- phone number is not eligible to access Groups APIs." A Cloud API number
-- cannot join a group made in the ordinary app, and this one may not create
-- groups through the API either. The channel G-109 designed cannot deliver
-- on this deployment — not with any id, not with any linking UI.
--
-- ADM-95 (granted by the Admin 2026-08-23, in their own words: "ha bana do
-- 1:1 wala"): while the WABA lacks Groups eligibility, the internal channel
-- is A PERSON — the owner's own WhatsApp, one to one. Everything that
-- announced into the group announces to them: the approval with the full
-- quotation and its PDF, the escalation with its reason. The approval still
-- settles ONLY in AgencyOS; ADM-74 does not move an inch.
--
-- What this adds:
--
--   * conversation kind `internal_direct` — no lead, no project, no client
--     account; one live per organization; external_ref `internal:+<digits>`,
--     a namespace of its own so it can never collide with a client's
--     `wa:+<number>` thread (the owner's own number IS a lead conversation
--     on this very deployment, from testing).
--   * crm.link_internal_recipient — links or RE-links it. Genuinely
--     re-links: the group linker answers already_linked and quietly discards
--     a corrected ref, which is exactly how a mistyped number would have
--     become permanent.
--   * send_outbound_message routes it: addressed by the number inside its
--     own external_ref, recipient_type individual, consent-exempt exactly as
--     the internal group is — this is the agency talking to itself, and
--     ADM-70 governs clients.
--
-- The group path stays built. The day Meta grants Groups eligibility, the
-- announcers prefer... the DIRECT channel still — deliberately: preference
-- lives in one place (the announcer's lookup), documented there, and
-- flipping it is a one-line decision for the day a group actually works.
--
-- D16: conversations_kind_shape carried forward from 20260815460000 and
-- send_outbound_message from 20260823210000, each with marked edits.

alter table crm.conversations
  drop constraint conversations_kind_check;
alter table crm.conversations
  add constraint conversations_kind_check check (
    kind in ('direct', 'project_group', 'internal_group', 'internal_direct', 'client_account')
  );

alter table crm.conversations
  drop constraint conversations_kind_shape,
  add constraint conversations_kind_shape check (
    (kind = 'direct'         and lead_id is not null and project_id is null     and client_account_id is null)
    or (kind = 'project_group'  and lead_id is null     and project_id is not null and client_account_id is null)
    or (kind = 'internal_group' and lead_id is null     and project_id is null     and client_account_id is null)
    -- EDIT (G-159): the owner's own thread — no lead, no project, no client
    -- account. A person, standing where G-109 expected a group.
    or (kind = 'internal_direct' and lead_id is null    and project_id is null     and client_account_id is null)
    or (kind = 'client_account' and lead_id is null     and project_id is null     and client_account_id is not null)
  );
-- One live person-channel per organization, the same way the group is held.
create unique index if not exists conversations_internal_direct_key
  on crm.conversations (organization_id)
  where kind = 'internal_direct' and status <> 'abandoned';

-- ── linking, and honestly RE-linking ────────────────────────────────────────
create or replace function crm.link_internal_recipient(
  p_organization_id uuid,
  p_phone           text,
  p_title           text default null
)
returns table (
  -- 'linked' | 'relinked' | 'bad_phone'
  outcome         text,
  conversation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_digits text;
  v_ref    text;
  v_id     uuid;
begin
  -- Repointing where MONEY is announced is the owner's act. The service says
  -- so with better words; this is the belt under the braces, because the RPC
  -- is granted to `authenticated` and conversations_write admits any internal
  -- member — without this line, the capability gate would be service-owned
  -- only. An identity-less caller (service_role, the verification scripts)
  -- passes: it already holds the whole database.
  if (select auth.uid()) is not null and not (select core.is_owner()) then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  -- Digits only, out of whatever a person typed: spaces, +91, dashes.
  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_digits) not between 8 and 15 then
    return query select 'bad_phone'::text, null::uuid;
    return;
  end if;
  v_ref := 'internal:+' || v_digits;

  -- Re-link for real. The group linker's already_linked branch DISCARDS a
  -- corrected ref; here a second link with a new number must mean the number
  -- changed, because a person owns their mistakes only if the button obeys.
  update crm.conversations c
     set external_ref = v_ref,
         title        = coalesce(p_title, c.title)
   where c.organization_id = p_organization_id
     and c.kind = 'internal_direct'
     and c.status <> 'abandoned'
  returning c.id into v_id;

  if v_id is not null then
    return query select 'relinked'::text, v_id;
    return;
  end if;

  begin
    insert into crm.conversations (
      organization_id, kind, channel, external_ref, status, title
    )
    values (
      p_organization_id, 'internal_direct', 'whatsapp', v_ref, 'active', p_title
    )
    returning id into v_id;
  exception
    when unique_violation then
      -- Two ways here, both real. A concurrent first link won the race on
      -- conversations_internal_direct_key — take the update path against the
      -- row that now exists. Or an ABANDONED internal_direct row still holds
      -- this exact ref (conversations_external_ref_key is not partial on
      -- status) — resurrect it rather than refusing a person their own
      -- number back.
      update crm.conversations c
         set external_ref = v_ref,
             title        = coalesce(p_title, c.title),
             status       = 'active'
       where c.organization_id = p_organization_id
         and c.kind = 'internal_direct'
         and (c.status <> 'abandoned' or c.external_ref = v_ref)
      returning c.id into v_id;

      if v_id is null then
        raise;
      end if;

      return query select 'relinked'::text, v_id;
      return;
  end;

  return query select 'linked'::text, v_id;
end;
$$;

comment on function crm.link_internal_recipient(uuid, text, text) is
  'Points the organization''s internal announcement channel at a person''s own WhatsApp number (ADM-95, G-159) — the fallback for a WABA Meta has not granted Groups eligibility (#131215). Stores external_ref as internal:+<digits>, a namespace that cannot collide with a client''s wa:+ thread. A second call RE-links: the number is updated in place, unlike the group linker, whose already_linked branch discards a correction. SECURITY INVOKER — RLS decides who may write conversations, and the service gates it on organization.settings, the owner alone.';

revoke all on function crm.link_internal_recipient(uuid, text, text) from public;
grant execute on function crm.link_internal_recipient(uuid, text, text) to authenticated, service_role;

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
                        -- EDIT (G-159): an internal_direct channel is addressed by the
                        -- number inside its own external_ref — it has no contact row to
                        -- read a phone from, and it is not a group.
                        case when v_is_group then v_conversation.external_ref
                             when v_conversation.kind = 'internal_direct'
                               then regexp_replace(v_conversation.external_ref, '^internal:\+', '')
                             else v_contact.phone end,
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
                      -- EDIT (G-159): and an internal_direct channel by the number
                      -- inside its own external_ref, as an individual.
                      case when v_is_group then v_conversation.external_ref
                           when v_conversation.kind = 'internal_direct'
                             then regexp_replace(v_conversation.external_ref, '^internal:\+', '')
                           else v_contact.phone end,
                      v_settings->>'whatsapp_phone_number_id',
                      case when v_is_group then 'group' else 'individual' end,
                      'pending'::text;
end;
$function$;

comment on function crm.send_outbound_message(uuid, text, text, uuid, text, text) is
  'Queues an outbound message idempotently on external_ref and refuses one to a client without recorded consent (G-012, ADM-70, ADM-81). Returns the row''s delivery state alongside already_sent so a retry sends again only when the row is not already sent. Consent is per-contact-per-channel and enforced for the kinds that have a contact: direct and client_account (G-139, addressed by the contact''s phone). internal_group and internal_direct are exempt (the agency talking to itself: approval announcements G-110, the owner''s own channel G-159); project_group is messaged on membership (ADM-86 = A, G-136). A document send (G-156) records media_type ''document'' and a filename with an empty body — the body check''s media shape — and answers bad_shape to any other media claim, because nothing here can send one. An internal_direct thread is addressed by the number inside its own external_ref, as an individual (G-159).';

notify pgrst, 'reload schema';
