-- ═══════════════════════════════════════════════════════════════════════════
-- Inbound WhatsApp ingest — no extraction for a lead that is already settled.
--
-- Audit finding C6. crm.ingest_whatsapp_message resolves the lead by thread
-- key and then queues a requirement extraction unconditionally, because the
-- lead's own status was never read. A number whose lead had been converted or
-- disqualified therefore kept commissioning model runs against a deal that was
-- already decided — every further message another job.
--
-- The lead stays exactly as it was. `converted` is terminal per
-- crm/schema.ts LEAD_TRANSITIONS ("a lead that became a project does not go
-- back into the pipeline") and this does not reopen it; `disqualified` is
-- reopenable, but by a human performing that sales action, not by a message
-- arriving. One lead per `wa:<phone>` is unchanged, leads_source_ref_key is
-- untouched, and no second lead or conversation is invented.
--
-- What changes is one thing: the extraction is not queued when the lead is
-- already in a terminal state. The message itself is still recorded — dropping
-- it is the failure C5 has just been fixed to stop, and the transcript is
-- where a human reads what the client actually said.
--
-- No schema change. This replaces the function body and nothing else: same
-- signature, same return shape, same grants. `job_id` comes back null for a
-- terminal lead, which is a value the contract already carries — a replay and
-- a same-transcript duplicate both return null there today.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.ingest_whatsapp_message(
  p_phone_number_id text,
  p_from            text,
  p_external_ref    text,
  p_body            text,
  p_profile_name    text default null,
  p_occurred_at     timestamptz default now()
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

comment on function crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz) is
  'Records one inbound WhatsApp message and everything it implies, exactly once. No extraction is queued when the lead is already converted or disqualified; the message is still recorded. Sends nothing.';

-- Unchanged from the original grant, restated because create or replace does
-- not reset privileges and a reader should not have to check another file to
-- know who may call this.
revoke all on function crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz)
  to service_role;
