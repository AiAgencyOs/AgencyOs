-- A group message can carry a file — G-181.
--
-- A zero-trust audit read the webhook line by line and found this branch:
--
--     if (message.groupId && message.mediaType) { skipped += 1; continue; }
--
-- A photograph, a voice note or a PDF posted into a project group was
-- **counted as somebody else's traffic and thrown away**. The comment beside
-- it was honest about the trade — *"crm.ingest_group_message takes no media
-- kind, and widening it is a separate change"* — and named the loss it was
-- accepting: an internal group losing a sticker is not the same as a client's
-- voice note going unanswered on their lead thread.
--
-- That reasoning was right about the priority and wrong about the outcome.
-- The project group IS the client-facing thread once a project starts
-- (G-015, ADM-13), so the file a client posts there — the screenshot of the
-- bug, the logo, the signed document — is exactly the kind of thing the
-- agency is later accused of never having received. `skipped` made it
-- indistinguishable from a message for a number nobody claims.
--
-- ── what this does, and what it deliberately does not ─────────────────────
--
-- It STORES the envelope, the same way the 1:1 path does: media type, media
-- id and caption, in `metadata`, on a row with a `seq` in the thread. The
-- transcript then says a file arrived, when, and from which number.
--
-- It does NOT queue a reading. `image.received` and `audio.received` exist so
-- a client's file is understood before the agent answers it on a LEAD thread
-- (Doc 08 §9, brief §28) — and nothing answers a group thread automatically:
-- `crm.emit_reply_due` fires on `author_type = 'client'` in a direct
-- conversation, and a group message is not that. Queuing a model call whose
-- output nothing would read is cost with no consumer, which is the shape
-- G-011 exists to refuse. The moment something does answer a group, this is
-- the function that grows the emit.
--
-- ── the parameters are appended, and the old signature is dropped ─────────
--
-- `create or replace` with a different argument list makes an OVERLOAD, and a
-- six-argument call would then be ambiguous — a runtime error on the next
-- group message rather than a failure here. The same trap G-178 hit one
-- function along.

drop function if exists crm.ingest_group_message(text, text, text, text, text, timestamptz);

create function crm.ingest_group_message(
  p_phone_number_id text,
  p_group_id text,
  p_from text,
  p_external_ref text,
  p_body text,
  p_occurred_at timestamptz default now(),
  p_media_type text default null,
  p_media_id text default null,
  p_caption text default null
)
returns table (
  status text,
  organization_id uuid,
  conversation_id uuid,
  message_id uuid,
  message_seq integer
)
language plpgsql
security definer
set search_path = ''
as $$
-- The names in `returns table` above are also plpgsql variables, so an
-- unqualified `organization_id` in the on-conflict target below is ambiguous
-- between the OUT column and the table column. This tells plpgsql to read it
-- as the column, matching the 1:1 path (ingest_whatsapp_message).
#variable_conflict use_column
declare
  v_org          uuid;
  v_conversation crm.conversations;
  v_existing     crm.conversation_messages;
  v_row          crm.conversation_messages;
  v_phone        text;
  v_author       text;
begin
  -- ── 1. whose number is this ──────────────────────────────────────────────
  select o.id into v_org
    from core.organizations o
   where o.settings->>'whatsapp_phone_number_id' = p_phone_number_id;

  if v_org is null then
    return query select 'unknown_phone_number_id'::text, null::uuid, null::uuid, null::uuid, null::int;
    return;
  end if;

  -- ── 2. is it a group this system tracks ──────────────────────────────────
  select c.* into v_conversation
    from crm.conversations c
   where c.organization_id = v_org
     and c.external_ref    = p_group_id
     and c.kind in ('project_group', 'internal_group')
     and c.status <> 'abandoned';

  if v_conversation.id is null then
    -- Not ours. Acknowledged rather than retried: the number can be in groups
    -- this system does not track, and a webhook that fails on them is a
    -- webhook the provider redelivers forever.
    return query select 'unknown_group'::text, v_org, null::uuid, null::uuid, null::int;
    return;
  end if;

  -- ── 3. redelivery is free — sequentially by the read, concurrently by the
  --       on-conflict below, so a racing second delivery is a replay, not an
  --       error ────────────────────────────────────────────────────────────
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

  insert into crm.conversation_messages (
    organization_id, conversation_id, seq, author_type, author_id,
    body, external_ref, metadata, occurred_at
  )
  select
    v_org, v_conversation.id, coalesce(max(m.seq), -1) + 1, v_author, null,
    p_body, p_external_ref,
    jsonb_build_object(
      'channel', 'whatsapp',
      'direction', 'inbound',
      -- Kept so attribution stays possible without being guessed at now.
      'from', v_phone,
      'group_id', p_group_id
    )
    -- G-181 — the file, recorded the way the 1:1 path records it. Each key is
    -- merged only when it has a value, so a text message's metadata is
    -- byte-for-byte what it was before this migration existed.
    || case
         when p_media_type is null then '{}'::jsonb
         else jsonb_build_object('media_type', p_media_type)
       end
    || case
         when coalesce(btrim(p_media_id), '') = '' then '{}'::jsonb
         else jsonb_build_object('media_id', btrim(p_media_id))
       end
    || case
         when coalesce(btrim(p_caption), '') = '' then '{}'::jsonb
         else jsonb_build_object('caption', btrim(p_caption))
       end,
    p_occurred_at
    from crm.conversation_messages m
   where m.conversation_id = v_conversation.id
  on conflict (organization_id, external_ref) where external_ref is not null
  do nothing
  returning * into v_row;

  -- Conflict means a concurrent delivery of the same message won the insert.
  -- Nothing was duplicated; report the existing row as the replay it is.
  if v_row.id is null then
    select m.* into v_existing
      from crm.conversation_messages m
     where m.organization_id = v_org
       and m.external_ref    = p_external_ref;

    return query select 'replayed'::text, v_org, v_existing.conversation_id,
                        v_existing.id, v_existing.seq;
    return;
  end if;

  return query select 'ingested'::text, v_org, v_conversation.id, v_row.id, v_row.seq;
end;
$$;

comment on function crm.ingest_group_message(text, text, text, text, text, timestamptz, text, text, text) is
  'Appends one inbound GROUP message to the thread it belongs to, idempotent on the provider id and serialised on the conversation. G-181 adds the media envelope — type, id and caption — because a file posted into a project group was previously counted as somebody else''s traffic and thrown away. It stores the envelope and deliberately queues no reading: nothing answers a group thread automatically, and a model call whose output nothing reads is cost with no consumer.';
