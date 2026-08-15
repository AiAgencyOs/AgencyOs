-- ═══════════════════════════════════════════════════════════════════════════
-- A group message is recorded once, even under a race.
--
-- `crm.ingest_group_message` guards redelivery with a read-then-insert: it
-- SELECTs for an existing row by external_ref and, finding none, inserts. That
-- is correct for a sequential redelivery — the provider sends the same message
-- twice, minutes apart, and the second read finds the first. It is NOT correct
-- for two deliveries racing: both read "no existing row" before either
-- commits, and both proceed to insert.
--
-- The unique index `conversation_messages_external_ref_key` (organization_id,
-- external_ref) already stops the DUPLICATE — the second insert cannot land.
-- But it lands as an ERROR: a unique violation the function does not handle,
-- so the RPC throws, the webhook answers non-200, and the provider redelivers
-- what was in fact already stored. No data is lost, but a stored message reads
-- as a failure.
--
-- The 1:1 path (`crm.ingest_whatsapp_message`) already solved this: it inserts
-- `on conflict (organization_id, external_ref) do nothing` and, when nothing
-- was inserted, re-selects the existing row and returns `replayed`. This
-- brings the group path to the same shape — the concurrent second delivery is
-- reported as the replay it is, not raised as an error.
--
-- Only the message insert changes in substance. The conversation resolution,
-- the unknown-group acknowledgement, the author-kind rule, and the grants
-- carry the prior behaviour unchanged (a couple of no-op `limit 1`s on
-- `select ... into` were dropped as noise, since `select into` takes the first
-- row regardless).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.ingest_group_message(
  p_phone_number_id text,
  p_group_id        text,
  p_from            text,
  p_external_ref    text,
  p_body            text,
  p_occurred_at     timestamptz default now()
)
returns table (
  status          text,
  organization_id uuid,
  conversation_id uuid,
  message_id      uuid,
  message_seq     int
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
  v_seq          int;
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
    ),
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

comment on function crm.ingest_group_message(text, text, text, text, text, timestamptz) is
  'Records an inbound group message once (G-115), idempotently on external_ref even under a race: the read handles a sequential redelivery, and the on-conflict handles two deliveries arriving at once - the loser is reported as replayed rather than raised as a unique-violation error that would make the provider redeliver a message already stored. Matches the 1:1 path (ingest_whatsapp_message).';

revoke all on function crm.ingest_group_message(text, text, text, text, text, timestamptz) from public;
grant execute on function crm.ingest_group_message(text, text, text, text, text, timestamptz) to service_role;
