-- ═══════════════════════════════════════════════════════════════════════════
-- A voice note is words somebody said.
--
-- `20260821120000_a_voice_note_is_not_silence.sql` recorded that a recording
-- arrived and stopped there, with its reason written down:
--
--   "Transcription is deliberately NOT attempted here. Document 08 §9 wants
--    it, it needs a speech provider, an ADM decision about which, and a rule
--    for what an uncertain transcript may be used for — none of which a
--    migration should settle."
--
-- All three are now answered, and none of them by this file.
--
--   the provider   ADM-94, raised for the owner. ADM-84 §5 refused to pick a
--                  vendor for one capability because it was named for another,
--                  and ADM-85 records what makes it a business question —
--                  "an account, a billing relationship, and credentials". So
--                  the port is capability-shaped (`AiTranscriber`, separate
--                  from `AiProvider` precisely so Anthropic cannot look like a
--                  candidate), the first adapter is one file, and swapping it
--                  is one line in `router.ts`.
--
--   the rule       the one the image already established, and it is why this
--                  can be small: a reading lives in `media_description`, never
--                  in `body`, and the transcript renders it as what it is. A
--                  transcript is quoted as the client's words, because they
--                  are; a description of a photograph is attributed to the
--                  agent, because it is the agent's sentence. Neither can be
--                  mistaken for the other by anybody reading the thread.
--
--   the ordering   already built. `crm.awaits_image_reading` held a reply back
--                  until somebody had looked; it holds one back until somebody
--                  has LISTENED too, and it is renamed for saying so.
--
-- ── what this migration is not ───────────────────────────────────────────
--
-- A second system. There is no transcript table, no second gate, no second
-- release trigger and no second column: a recording and a photograph are both
-- media that somebody has or has not read, and the difference between them is
-- the verb in one rendered line.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── one condition, now for two kinds ─────────────────────────────────────
--
-- Renamed rather than widened in place. A function called
-- `awaits_image_reading` that also holds a voice note back is a name that
-- lies, and the four triggers that ask it are the four places somebody would
-- read the name instead of the body.

create or replace function crm.awaits_media_reading(p_metadata jsonb, p_media_read_at timestamptz)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_metadata->>'media_type', '') in ('image', 'audio')
     and coalesce(p_metadata->>'media_id', '') <> ''
     and p_media_read_at is null;
$$;

comment on function crm.awaits_media_reading(jsonb, timestamptz) is
  'True while a file that CAN be fetched and CAN be read has not been read yet. The intent read, the qualification read and the reply all wait on this, because a reading that lands after the reply was sent is worth nothing. Two kinds only - a photograph is described and a recording is transcribed; a video, a document, a sticker and a location hold nothing back, because nothing here reads them and a gate waiting on an event that cannot happen is a conversation that stops. False when there is no media_id, for the same reason.';


-- ── the two readings that wait ───────────────────────────────────────────
--
-- Carried forward from `20260823120000`, their latest definition, with the one
-- renamed call and nothing else touched.

create or replace function crm.emit_message_received()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only what a CLIENT said. An agency message needs no interpreting, and a
  -- system note is not a message from anybody.
  if new.author_type = 'client' and new.intent is null
     -- …and not while a file is still to be read. `crm.emit_media_read` fires
     -- this same event the moment the reading lands, so nothing is lost — it
     -- is deferred by exactly as long as reading takes.
     and not crm.awaits_media_reading(new.metadata, new.media_read_at) then
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

  -- A file nobody has read is not yet a message anybody can answer. Deferred,
  -- not dropped: `crm.emit_media_read` fires this event when the reading
  -- lands, and a reading that cannot be had also lands — with nothing in it —
  -- so there is no state in which a client's voice note leaves them
  -- unanswered.
  if crm.awaits_media_reading(new.metadata, new.media_read_at) then
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


-- ── the event that asks somebody to read it ──────────────────────────────
--
-- Two types rather than one, because "a client sent a photograph" and "a
-- client left a voice note" are different things to see in a log, and because
-- collapsing them would need the kind in the payload anyway. One subscriber
-- and one job kind serve both — the handler is `sales:readMedia`, and the
-- workflow branches on what actually arrived.

insert into core.event_types (type, description, canonical) values
  ('audio.received', 'A client sent a recording that nobody has listened to yet (Doc 08 §9).', null)
on conflict (type) do nothing;

create or replace function crm.emit_media_received()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only what a CLIENT sent, and only a file this system can actually go and
  -- read. `awaits_media_reading` owns both halves of that, so what holds the
  -- reply back and what asks for the reading can never disagree.
  if new.author_type = 'client'
     and crm.awaits_media_reading(new.metadata, new.media_read_at) then
    perform core.emit_event(
      new.organization_id,
      case new.metadata->>'media_type'
        when 'audio' then 'audio.received'
        else 'image.received'
      end,
      'conversation_message', new.id,
      jsonb_build_object(
        'conversation_id', new.conversation_id,
        'seq', new.seq,
        'media_type', new.metadata->>'media_type'
      )
    );
  end if;
  return new;
end;
$$;

comment on function crm.emit_media_received() is
  'Asks the sales agent to read what a client sent - image.received for a photograph, audio.received for a recording. Fires only for a file carrying a media_id, which is the same condition that holds the reply back, so the system never waits for a reading it never asked for.';

drop trigger if exists emit_image_received on crm.conversation_messages;
drop trigger if exists emit_media_received on crm.conversation_messages;
create trigger emit_media_received
  after insert on crm.conversation_messages
  for each row execute function crm.emit_media_received();


-- ── and what happens the moment somebody has read it ─────────────────────
--
-- Carried forward from `20260823120000` unchanged but for its name, which was
-- `emit_image_read` and is now true of both kinds. The body was already
-- generic: it fires on `media_read_at` becoming non-null and never asked what
-- sort of file it was.

create or replace function crm.emit_media_read()
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
  -- read. A description IS something new in it — and a voice note's words are
  -- more than that, since on WhatsApp in India they are often the whole
  -- enquiry — so the extraction the ingest declined is queued here, under the
  -- identical dedupe key, and only when there is a reading to read.
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

comment on function crm.emit_media_read() is
  'Releases everything an unread file was holding back: the intent reading, the reply, and - only when a reading actually came back - the requirement extraction the ingest declined while there was nothing to read. Fires on the transition to read, whether or not the reading produced words, because a client whose recording could not be transcribed must still be answered.';

drop trigger if exists emit_image_read on crm.conversation_messages;
drop trigger if exists emit_media_read on crm.conversation_messages;
create trigger emit_media_read
  after update of media_read_at on crm.conversation_messages
  for each row execute function crm.emit_media_read();


-- ── the old names go ─────────────────────────────────────────────────────
--
-- Dropped rather than left beside the new ones. A function nothing calls is a
-- function somebody will call, and two conditions that must agree are the
-- defect this codebase keeps finding in itself.

drop function if exists crm.emit_image_received();
drop function if exists crm.emit_image_read();
drop function if exists crm.awaits_image_reading(jsonb, timestamptz);

comment on column crm.conversation_messages.media_description is
  'What the agent got out of this message''s file: a description of a photograph, or the words in a recording. NOT the client''s words when it describes an image - the transcript attributes it to the agent - and IS their words when it transcribes a recording, where the transcript quotes it. Null means nobody has read it, or read it and could not: the brief of 2026-08-22 section 28 forbids claiming a reading that did not happen, and this column being the only source of the transcript line is what makes that structural rather than a prompt.';

notify pgrst, 'reload schema';
