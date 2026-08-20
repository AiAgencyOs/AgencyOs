-- ═══════════════════════════════════════════════════════════════════════════
-- A voice note is not silence.
--
-- `src/lib/whatsapp/payload.ts` read the text of an inbound message and
-- discarded everything else:
--
--   "Only text is read. An image, audio note, reaction or location is a real
--    message but carries nothing this slice can extract requirements from, and
--    inventing a body for it would put words in a client's mouth. Acknowledged
--    and counted; a later step can widen this."
--
-- The reasoning was right and the consequence was not survivable in
-- production: a client who answers with a voice note — which, on WhatsApp in
-- India, is most of them — leaves no trace at all. Staff see a conversation
-- that appears to have stopped, and reply into a silence the client did not
-- create. Documents 08 §9 and §11 both assume media arrives.
--
-- ── what this does and does not claim ─────────────────────────────────────
--
-- It records that a message of a given KIND arrived, and nothing about what it
-- said. `body` stays null; the kind lives in `metadata.media_type`. That is
-- the distinction the original comment was protecting: naming the envelope is
-- not inventing the letter, and the transcript renders it as an envelope.
--
-- Transcription is deliberately NOT attempted here. Document 08 §9 wants it,
-- it needs a speech provider, an ADM decision about which, and a rule for what
-- an uncertain transcript may be used for — none of which a migration should
-- settle. Recording the arrival is the honest half that costs nothing.
--
-- ── why the extraction is skipped ─────────────────────────────────────────
--
-- Media carries no text, so the extractor would re-read an unchanged
-- transcript and write a requirement version restating the last one. The
-- function already makes exactly this division for a settled lead, in the same
-- words: what stops is the automated follow-on, not the record.
--
-- ── the signature ─────────────────────────────────────────────────────────
--
-- `p_media_type` is added last with a default, so every existing call means
-- precisely what it meant before. The six-argument form is dropped rather than
-- left beside the new one: two overloads differing only by a defaulted tail
-- make an unqualified six-argument call ambiguous, and Postgres reports that
-- as an error at call time rather than here.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz);

-- ── the body constraint learns what a media row is ────────────────────────
--
-- `body text not null check (length(trim(body)) > 0)` said a message must say
-- something, which was right while every message was text. A voice note says
-- something too — just not in a column. Relaxing the check to allow any empty
-- body would give back exactly the empty text message it was written to
-- refuse, so the exemption is named: empty is permitted only for a row that
-- carries a kind.
--
-- The same rule the application states in `inboundWhatsAppMessageSchema`, on
-- the pair rather than on either field. Stated in both places on purpose:
-- the schema is what a caller reads, and the constraint is what holds when
-- somebody writes around the caller.
alter table crm.conversation_messages
  drop constraint if exists conversation_messages_body_check;

alter table crm.conversation_messages
  add constraint conversation_messages_body_check check (
    case
      when metadata ? 'media_type' then length(trim(body)) = 0
      else length(trim(body)) > 0
    end
  );

comment on constraint conversation_messages_body_check on crm.conversation_messages is
  'A message says something: text rows carry a body, media rows carry a kind in metadata and an empty body. Exclusive on purpose - an empty body with no kind is the meaningless row the original check refused, and a body beside a kind would claim someone transcribed it.';


create or replace function crm.ingest_whatsapp_message(
  p_phone_number_id text,
  p_from            text,
  p_external_ref    text,
  p_body            text,
  p_profile_name    text default null,
  p_occurred_at     timestamptz default now(),
  -- 'audio' | 'image' | 'video' | 'document' | 'sticker' | 'location' … or
  -- null for the ordinary text message this function has always taken.
  p_media_type      text default null
)
returns table (
  status          text,
  organization_id uuid,
  contact_id      uuid,
  lead_id         uuid,
  conversation_id uuid,
  message_id      uuid,
  message_seq     int,
  job_id          uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
-- The names in `returns table` above are also plpgsql variables, and four of
-- them (organization_id, contact_id, lead_id, conversation_id) are real column
-- names on the tables below. Without this, every `on conflict (organization_id,
-- …)` is rejected as ambiguous. Nothing here reads those output variables —
-- results are assembled from the v_ locals and returned explicitly — so
-- resolving ambiguity to the column is both correct and the only thing meant.
#variable_conflict use_column
declare
  v_org          uuid;
  v_phone        text;
  v_thread       text;
  v_display      text;
  v_contact      uuid;
  v_lead         uuid;
  -- The resolved lead's status, read in the same statement that resolves the
  -- lead so there is no second round trip and no gap to race in.
  v_lead_status  text;
  v_conversation uuid;
  v_message      uuid;
  v_seq          int;
  v_job          uuid;
  v_count        int;
begin
  -- ── 1. tenancy, from data ────────────────────────────────────────────────
  select o.id
    into v_org
    from core.organizations o
   where o.settings->>'whatsapp_phone_number_id' = p_phone_number_id
   limit 1;

  if v_org is null then
    return query
      select 'unknown_phone_number_id'::text,
             null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::int, null::uuid;
    return;
  end if;

  -- E.164, matching the format crm.contacts.phone documents. The provider
  -- sends bare digits; normalising here means one representation in the
  -- database whatever the caller passed.
  v_phone   := '+' || regexp_replace(p_from, '[^0-9]', '', 'g');
  v_thread  := 'wa:' || v_phone;
  v_display := coalesce(nullif(btrim(p_profile_name), ''), v_phone);

  -- ── 2. contact ───────────────────────────────────────────────────────────
  --
  -- Insert-or-find rather than upsert: a returning client's profile name must
  -- not overwrite whatever a human has since corrected it to.
  insert into crm.contacts (organization_id, full_name, phone)
  values (v_org, v_display, v_phone)
  on conflict (organization_id, phone) where phone is not null
  do nothing
  returning id into v_contact;

  if v_contact is null then
    select c.id into v_contact
      from crm.contacts c
     where c.organization_id = v_org
       and c.phone = v_phone;
  end if;

  -- ── 3. lead ──────────────────────────────────────────────────────────────
  --
  -- Keyed by the thread, so every message from one number continues one lead
  -- rather than opening a new one per message. leads_source_ref_key is what
  -- makes that idempotent.
  insert into crm.leads (
    organization_id, contact_id, title, summary, source, source_ref, status
  )
  values (
    v_org, v_contact,
    'WhatsApp — ' || v_display,
    'Inbound via WhatsApp. Requirements not yet collected.',
    'whatsapp', v_thread, 'new'
  )
  on conflict (organization_id, source, source_ref) where source_ref is not null
  do nothing
  returning id, status into v_lead, v_lead_status;

  if v_lead is null then
    select l.id, l.status into v_lead, v_lead_status
      from crm.leads l
     where l.organization_id = v_org
       and l.source = 'whatsapp'
       and l.source_ref = v_thread;
  end if;

  -- ── 4. conversation ──────────────────────────────────────────────────────
  insert into crm.conversations (
    organization_id, lead_id, contact_id, channel, external_ref, status
  )
  values (v_org, v_lead, v_contact, 'whatsapp', v_thread, 'active')
  on conflict (organization_id, channel, external_ref) where external_ref is not null
  do nothing
  returning id into v_conversation;

  if v_conversation is null then
    select c.id into v_conversation
      from crm.conversations c
     where c.organization_id = v_org
       and c.channel = 'whatsapp'
       and c.external_ref = v_thread;
  end if;

  -- ── 5. the message ───────────────────────────────────────────────────────
  --
  -- The row lock is the fix for the seq race. Two messages arriving on the
  -- same thread at the same instant would otherwise both read the same maximum
  -- and one would lose on unique (conversation_id, seq); serialised here, the
  -- second reads a maximum that already includes the first.
  --
  -- Locking the *conversation* rather than the messages is deliberate: there
  -- is nothing to lock on an empty transcript, and the conversation row is the
  -- one thing guaranteed to exist by this point.
  perform 1 from crm.conversations c where c.id = v_conversation for update;

  -- max() over an empty transcript yields null, so coalesce gives seq 0 for
  -- the first message. The aggregate makes this exactly one row, always.
  insert into crm.conversation_messages (
    organization_id, conversation_id, seq, author_type, body,
    external_ref, occurred_at, metadata
  )
  select v_org,
         v_conversation,
         coalesce(max(m.seq), -1) + 1,
         'client',
         p_body,
         p_external_ref,
         p_occurred_at,
         jsonb_build_object('provider', 'whatsapp', 'phone_number_id', p_phone_number_id)
           || case
                when p_media_type is null then '{}'::jsonb
                else jsonb_build_object('media_type', p_media_type)
              end
    from crm.conversation_messages m
   where m.conversation_id = v_conversation
  on conflict (organization_id, external_ref) where external_ref is not null
  do nothing
  returning id, seq into v_message, v_seq;

  -- Conflict means the provider delivered this message again. Everything above
  -- was insert-or-find, so nothing was duplicated getting here; report the
  -- existing row and stop short of queueing a second extraction.
  if v_message is null then
    select m.id, m.seq into v_message, v_seq
      from crm.conversation_messages m
     where m.organization_id = v_org
       and m.external_ref = p_external_ref;

    return query
      select 'replayed'::text, v_org, v_contact, v_lead, v_conversation,
             v_message, v_seq, null::uuid;
    return;
  end if;

  -- ── 6. queue the extraction, unless the lead is already settled ──────────
  --
  -- C6. A converted or disqualified lead has been decided, and requirement
  -- extraction exists to move an undecided one forward. Queueing against a
  -- settled deal spends a model call on a question nobody asked and writes a
  -- proposal onto a lead no one is working.
  --
  -- The message above is already stored, deliberately: the client said
  -- something and the transcript is where a human reads it. What stops here is
  -- the automated follow-on, not the record.
  --
  -- Read from crm.leads rather than restated as a list this file owns — the
  -- statuses come from the same check constraint crm/schema.ts LEAD_TRANSITIONS
  -- mirrors, where `converted` is terminal outright and `disqualified` reopens
  -- only when a human performs that sales action.
  if v_lead_status in ('converted', 'disqualified') then
    return query
      select 'ingested'::text, v_org, v_contact, v_lead, v_conversation,
             v_message, v_seq, null::uuid;
    return;
  end if;

  -- A voice note, an image or a location carries no text, so there is nothing
  -- for the extractor to read: queueing one would spend a model call on a
  -- transcript that did not change, and write a fresh requirement version
  -- saying what the last one already said.
  --
  -- Same division the settled-lead guard above makes, for the same reason.
  -- The message IS stored — the client sent something and a human must be
  -- able to see that they did. What stops here is the automated follow-on,
  -- not the record.
  if p_media_type is not null then
    return query
      select 'ingested'::text, v_org, v_contact, v_lead, v_conversation,
             v_message, v_seq, null::uuid;
    return;
  end if;

  -- Same dedupe key crm/service.ts requestExtraction uses — kind, conversation
  -- and message count — so a human clicking "extract" and a message arriving
  -- cannot produce two model calls against the same transcript. In the same
  -- transaction as the message, so a queued job always has a transcript to
  -- read.
  select count(*)::int into v_count
    from crm.conversation_messages m
   where m.conversation_id = v_conversation;

  insert into core.jobs (organization_id, kind, payload, dedupe_key, correlation_id)
  values (
    v_org,
    'requirement.extract',
    jsonb_build_object('conversationId', v_conversation, 'source', 'whatsapp'),
    'requirement.extract:' || v_conversation::text || ':' || v_count::text,
    gen_random_uuid()
  )
  on conflict (dedupe_key) where dedupe_key is not null
  do nothing
  returning id into v_job;

  return query
    select 'ingested'::text, v_org, v_contact, v_lead, v_conversation,
           v_message, v_seq, v_job;
end;
$$;

comment on function crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz, text) is
  'Records one inbound WhatsApp message and everything it implies, exactly once. Sends nothing. p_media_type names the kind of a non-text message (audio, image, video, document, sticker, location) and is null for text; a media message is recorded with a null body and queues no extraction, because it carries nothing to extract.';

-- Unchanged from the original grant, restated because the signature changed.
grant execute on function crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz, text)
  to service_role;
