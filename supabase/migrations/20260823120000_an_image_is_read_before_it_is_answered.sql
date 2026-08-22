-- ═══════════════════════════════════════════════════════════════════════════
-- An image is read before it is answered.
--
-- `20260821120000_a_voice_note_is_not_silence.sql` gave media a record and
-- stopped there, deliberately and with its reason written down:
--
--   "Transcription is deliberately NOT attempted here. Document 08 §9 wants
--    it, it needs a speech provider, an ADM decision about which, and a rule
--    for what an uncertain transcript may be used for — none of which a
--    migration should settle."
--
-- Every word of that is still true **of audio**. None of it is true of an
-- image. The provider question is already answered — ARCHITECTURE.md §6.4
-- names Anthropic for generation, the model in `ai.agents.default_model`
-- already accepts images, and no second vendor, key or bill appears. So the
-- reason for waiting does not apply, and what is left is the consequence:
-- a client sends a screenshot of the app they want and the system files an
-- envelope.
--
-- The owner's brief of 2026-08-22 §28 asks for exactly this, and states the
-- rule that makes it safe in both directions:
--
--   "If vision capability is available: analyze it. … Do not say 'Not
--    transcribed' if the system actually has the capability to inspect the
--    image. If image understanding is unavailable: do not pretend."
--
-- Both halves are enforced by the same fact rather than by a prompt: the
-- transcript line is built from whether a description EXISTS. There is no way
-- to claim a reading that did not happen, because the claim is the reading.
--
-- ── the ordering rule, which is the whole of this migration ──────────────
--
-- A description that arrives after the reply has been sent is worthless. So an
-- image that CAN be fetched holds back the three readings that would otherwise
-- run against an empty body — the intent label, the qualification read, and
-- the reply — until somebody has looked at it.
--
-- `crm.awaits_image_reading` is that condition, in one place. It is
-- deliberately narrow: it holds only for an image that carries a `media_id`,
-- because an image with no id can never be fetched and a gate that waits for
-- an event that cannot happen is a conversation that stops. The same reasoning
-- runs through the workflow: a download that fails permanently, and a job on
-- its last attempt, both mark the message read-with-no-description. **A
-- client's image must never be the reason nobody answered them.**
--
-- ── what is NOT stored ───────────────────────────────────────────────────
--
-- The image. It is fetched into memory, read, and dropped. There is no bucket,
-- no retention window, no second access-control surface, and no copy of a
-- client's photograph in this system. §27 of the same brief — *"never expose
-- one customer's information to another customer"* — is then a property of the
-- description's tenancy, which is the message row's, rather than a policy
-- somebody has to remember to write.
--
-- The trade is stated rather than hidden: the sales agent reads a description,
-- not the picture, so a judgement that needs the pixels is not available to it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── what a reading of an image is ────────────────────────────────────────
--
-- Three columns, the same shape `intent` took: the reading, when it happened,
-- and who did it. `media_read_at` is set whether or not a description came
-- back — it means *somebody looked*, not *somebody succeeded*, and that
-- distinction is what lets a failure release the gate without inventing words.

alter table crm.conversation_messages
  add column if not exists media_description text
    check (media_description is null or length(btrim(media_description)) > 0);

alter table crm.conversation_messages
  add column if not exists media_read_at timestamptz;

alter table crm.conversation_messages
  add column if not exists media_read_by_agent text
    references ai.agents(key) on delete set null;

-- A description belongs to a media row and to nothing else. Without this a
-- text message could carry one, and the transcript would render a description
-- of an image that was never sent.
alter table crm.conversation_messages
  drop constraint if exists conversation_messages_media_reading_check;

alter table crm.conversation_messages
  add constraint conversation_messages_media_reading_check check (
    (media_description is null and media_read_at is null and media_read_by_agent is null)
    or metadata ? 'media_type'
  );

comment on column crm.conversation_messages.media_description is
  'What the agent saw in this message''s image, in words. NOT the client''s words - the transcript labels it as a reading, and the body stays empty. Null means nobody has looked, or looked and could not: the brief of 2026-08-22 section 28 forbids claiming a reading that did not happen, and this column being the only source of the transcript line is what makes that structural rather than a prompt.';

comment on column crm.conversation_messages.media_read_at is
  'When somebody looked at this message''s media - whether or not they could describe it. A permanent download failure and an exhausted job both set this with a null description, because a client''s image must never be the reason nobody answered them.';

comment on column crm.conversation_messages.media_read_by_agent is
  'Which agent read the image, or null when nothing did. Provenance beside the reading, as intent_by_agent is beside the intent.';

create index if not exists conversation_messages_unread_media_idx
  on crm.conversation_messages (organization_id, conversation_id)
  where media_read_at is null and metadata ? 'media_type';


-- ── a reading is written once ────────────────────────────────────────────
--
-- The rule `freeze_message_intent` and `freeze_message_language` already hold
-- one column over each: the message is immutable, and so is what was read from
-- it. A description that could be rewritten is a record of what somebody
-- currently believes rather than of what was seen.

create or replace function crm.freeze_message_media_reading()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.media_read_at is not null
     and (new.media_read_at is distinct from old.media_read_at
          or new.media_description is distinct from old.media_description) then
    raise exception
      'a message''s image was read once; record a new reading rather than editing this one'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_message_media_reading on crm.conversation_messages;
create trigger freeze_message_media_reading
  before update of media_read_at, media_description on crm.conversation_messages
  for each row execute function crm.freeze_message_media_reading();


-- ── the one condition, in one place ──────────────────────────────────────
--
-- Three triggers ask the same question and none of them owns the answer. It is
-- narrow on purpose: `media_id` present, because an image nobody can fetch
-- must not hold anything back.

create or replace function crm.awaits_image_reading(p_metadata jsonb, p_media_read_at timestamptz)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_metadata->>'media_type', '') = 'image'
     and coalesce(p_metadata->>'media_id', '') <> ''
     and p_media_read_at is null;
$$;

comment on function crm.awaits_image_reading(jsonb, timestamptz) is
  'True while an image that CAN be fetched has not been looked at yet. The intent read, the qualification read and the reply all wait on this, because a reading that lands after the reply was sent is worth nothing. False when there is no media_id: a gate waiting on an event that cannot happen is a conversation that stops.';


-- ── the door records what it will need to go and fetch ───────────────────
--
-- Carried forward from `20260821120000_a_voice_note_is_not_silence.sql`, its
-- latest definition, with two additions and no other edit.
--
-- `p_media_id` is Meta's handle for the file. Without it the image exists only
-- inside WhatsApp and nothing can ever look at it, which is why
-- `awaits_image_reading` refuses to hold a message that has none.
--
-- `p_caption` is the client's own typed words alongside the image — *"isme jo
-- login screen hai wo chahiye"* — and dropping them was the quieter half of
-- the same loss. It does NOT go in `body`: `conversation_messages_body_check`
-- says a media row's body is empty, and that rule is right for the reason it
-- gives, that a body beside a kind claims somebody transcribed the file. A
-- caption is neither the file nor a transcription of it, so it travels beside
-- the kind, in metadata, and is rendered as what it is.
--
-- Both are appended with defaults, so every existing call means exactly what
-- it meant before. The seven-argument form is dropped rather than left beside
-- the new one, for the reason the last change gives: two overloads differing
-- only by a defaulted tail make an unqualified call ambiguous, and Postgres
-- reports that at call time rather than here.

drop function if exists crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz, text);

CREATE OR REPLACE FUNCTION crm.ingest_whatsapp_message(p_phone_number_id text, p_from text, p_external_ref text, p_body text, p_profile_name text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now(), p_media_type text DEFAULT NULL::text, p_media_id text DEFAULT NULL::text, p_caption text DEFAULT NULL::text)
 RETURNS TABLE(status text, organization_id uuid, contact_id uuid, lead_id uuid, conversation_id uuid, message_id uuid, message_seq integer, job_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    organization_id, lead_id, contact_id, channel, external_ref, status,
    inbound_number_id
  )
  values (v_org, v_lead, v_contact, 'whatsapp', v_thread, 'active',
          p_phone_number_id)
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
           -- The handle the fetch will need, and the words the client typed
           -- beside the file. Both omitted entirely when absent, so a text
           -- message's metadata is byte-for-byte what it was.
           || case
                when coalesce(btrim(p_media_id), '') = '' then '{}'::jsonb
                else jsonb_build_object('media_id', btrim(p_media_id))
              end
           || case
                when coalesce(btrim(p_caption), '') = '' then '{}'::jsonb
                else jsonb_build_object('caption', btrim(p_caption))
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
  -- The same division the settled-lead guard above makes, and for the same
  -- reason. The message IS stored -- the client sent something and a human
  -- must be able to see that they did. What stops here is the automated
  -- follow-on, not the record.
  --
  -- An IMAGE now reaches the extractor by a different route: it carries no
  -- text *yet*, and `crm.emit_image_read` queues this same extraction once a
  -- description exists, at which point the transcript genuinely has changed.
  -- The condition here is unchanged, because at this instant it is still true.
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
    'requirement.extract:' || v_conversation::text || ':' || least(v_count, 1000)::text,
    gen_random_uuid()
  )
  on conflict (dedupe_key) where dedupe_key is not null
  do nothing
  returning id into v_job;

  return query
    select 'ingested'::text, v_org, v_contact, v_lead, v_conversation,
           v_message, v_seq, v_job;
end;
$function$;

comment on function crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz, text, text, text) is
  'Records one inbound WhatsApp message and everything it implies, exactly once. Sends nothing. p_media_type names the kind of a non-text message (audio, image, video, document, sticker, location) and is null for text; a media message is recorded with a null body and queues no extraction here. p_media_id is Meta''s handle for the file, which is what makes an image fetchable and therefore readable; p_caption is the client''s own typed words beside the file, kept in metadata rather than in body because the body check says a media row carries no text of its own.';

grant execute on function crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz, text, text, text)
  to service_role;


-- ── the event that asks somebody to look ─────────────────────────────────
--
-- Not one of Doc 23 §7's twenty-six, and declared with a null canonical name
-- for the same reason `message.received` is: §7 names business milestones, and
-- a photograph arriving is not one.

insert into core.event_types (type, description, canonical) values
  ('image.received', 'A client sent an image that nobody has looked at yet (brief 2026-08-22 §28).', null)
on conflict (type) do nothing;

create or replace function crm.emit_image_received()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only what a CLIENT sent, and only an image this system can actually go and
  -- fetch. `awaits_image_reading` owns both halves of that, so what holds the
  -- reply back and what asks for the reading can never disagree.
  if new.author_type = 'client'
     and crm.awaits_image_reading(new.metadata, new.media_read_at) then
    perform core.emit_event(
      new.organization_id, 'image.received', 'conversation_message', new.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq)
    );
  end if;
  return new;
end;
$$;

comment on function crm.emit_image_received() is
  'Asks the sales agent to look at a client''s image. Fires only for an image carrying a media_id, which is the same condition that holds the reply back - so the system never waits for a reading it never asked for.';

drop trigger if exists emit_image_received on crm.conversation_messages;
create trigger emit_image_received
  after insert on crm.conversation_messages
  for each row execute function crm.emit_image_received();


-- ── the two readings that now wait ───────────────────────────────────────
--
-- Carried forward from `20260822160000` and `20260822310000`, each with one
-- added clause and nothing else touched.
--
-- Without this the intent read runs the model over an empty body and the reply
-- answers a photograph it has not seen — which is precisely the pretending
-- §28 forbids, arrived at by ordering rather than by dishonesty.

create or replace function crm.emit_message_received()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only what a CLIENT said. An agency message needs no interpreting, and a
  -- system note is not a message from anybody.
  if new.author_type = 'client' and new.intent is null
     -- …and not while an image is still to be looked at. `crm.emit_image_read`
     -- fires this same event the moment the reading lands, so nothing is lost
     -- — it is deferred by exactly as long as looking takes.
     and not crm.awaits_image_reading(new.metadata, new.media_read_at) then
    perform core.emit_event(
      new.organization_id, 'message.received', 'conversation_message', new.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq)
    );
  end if;
  return new;
end;
$$;

create or replace function crm.emit_reply_due()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.author_type <> 'client' then
    return new;
  end if;

  -- An unread image is not yet a message anybody can answer. Deferred, not
  -- dropped: `crm.emit_image_read` fires this event when the reading lands,
  -- and a reading that cannot be had also lands — with no description — so
  -- there is no state in which a client's image leaves them unanswered.
  if crm.awaits_image_reading(new.metadata, new.media_read_at) then
    return new;
  end if;

  if not exists (
    select 1 from core.organizations o
     where o.id = new.organization_id
       and o.agent_answers_clients
  ) then
    return new;
  end if;

  perform core.emit_event(
    new.organization_id, 'reply.due', 'conversation_message', new.id,
    jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq)
  );

  return new;
end;
$$;


-- ── and what happens the moment somebody has looked ──────────────────────
--
-- The three things the insert deferred, in one place, on the transition from
-- "nobody has looked" to "somebody has". Fires whether or not a description
-- came back: a reading that failed is still a reading, and the transcript then
-- says `[photo — not transcribed]`, which is the truth and is what §28 asks
-- for when the capability is unavailable.
--
-- The conditions are restated here rather than shared with the two functions
-- above, because a trigger function cannot be called as one. What keeps them
-- from drifting is not this comment: `verify-image-reading.mjs` §F asserts that
-- an image, once read, produces exactly the events a text message produces at
-- insert — an equivalence between the two paths rather than a reading of them.

create or replace function crm.emit_image_read()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if old.media_read_at is not null or new.media_read_at is null then
    return new;
  end if;

  if new.author_type <> 'client' then
    return new;
  end if;

  -- 1. the reading that names what the message means (Doc 08 §12).
  if new.intent is null then
    perform core.emit_event(
      new.organization_id, 'message.received', 'conversation_message', new.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq)
    );
  end if;

  -- 2. the answer (ADM-91), and only where this agency has switched it on.
  if exists (
    select 1 from core.organizations o
     where o.id = new.organization_id
       and o.agent_answers_clients
  ) then
    perform core.emit_event(
      new.organization_id, 'reply.due', 'conversation_message', new.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq)
    );
  end if;

  -- 3. the requirements. `ingest_whatsapp_message` skips this for media,
  -- correctly, because at that instant the transcript has nothing new in it to
  -- read. A description IS something new in it — often the whole requirement,
  -- since a reference screenshot is how a client says what they want without
  -- writing it — so the extraction the ingest declined is queued here, under
  -- the identical dedupe key, and only when there is a description to read.
  if new.media_description is not null then
    select count(*)::int into v_count
      from crm.conversation_messages m
     where m.conversation_id = new.conversation_id;

    insert into core.jobs (organization_id, kind, payload, dedupe_key, correlation_id)
    values (
      new.organization_id,
      'requirement.extract',
      jsonb_build_object('conversationId', new.conversation_id, 'source', 'whatsapp'),
      'requirement.extract:' || new.conversation_id::text || ':' || least(v_count, 1000)::text,
      gen_random_uuid()
    )
    on conflict (dedupe_key) where dedupe_key is not null
    do nothing;
  end if;

  return new;
end;
$$;

comment on function crm.emit_image_read() is
  'Releases everything an unread image was holding back: the intent reading, the reply, and - only when a description actually came back - the requirement extraction the ingest declined while there was nothing to read. Fires on the transition to read, whether or not the reading produced words, because a client whose image could not be fetched must still be answered.';

drop trigger if exists emit_image_read on crm.conversation_messages;
create trigger emit_image_read
  after update of media_read_at on crm.conversation_messages
  for each row execute function crm.emit_image_read();

notify pgrst, 'reload schema';
