-- ═══════════════════════════════════════════════════════════════════════════
-- Inbound WhatsApp ingest.
--
-- The head of the sales chain: a message arrives from a client and must become
-- a contact, a lead, a conversation, a transcript line and a queued extraction
-- — exactly once, no matter how many times the provider delivers it.
--
-- All of it lives here rather than in the application for two reasons.
--
--   1. Atomicity. Five inserts across two schemas either all happen or none
--      do. Split across round trips, a process killed midway leaves a lead
--      with no conversation, or a message no extraction will ever read.
--   2. The `seq` race. Assigning a transcript position by reading the maximum
--      and then inserting is two statements with a gap; two messages arriving
--      together both read the same maximum and one loses on the unique index.
--      Here the maximum is read *inside* the insert, under a row lock on the
--      conversation, so concurrent arrivals queue instead of colliding.
--
-- The application keeps the parts worth keeping there: validating the payload,
-- and turning the outcome into a Result. src/modules/crm/ingest.ts.
--
-- Tenancy is resolved from data, never from configuration: an organization
-- claims a WhatsApp number by putting its phone_number_id in
-- core.organizations.settings. V1 runs a single organization, but nothing here
-- assumes that — an unmatched number is refused rather than defaulted.
--
-- What this deliberately does NOT do: send anything. ARCHITECTURE.md §6.1
-- forbids an agent committing client communication without recorded human
-- approval, and requirement_collector is L1 — it proposes, a human sends. This
-- function records what arrived and queues the extraction. Nothing else.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the per-message replay guard ───────────────────────────────────────────
--
-- crm.conversation_messages already anticipated this: its `metadata` comment
-- names "provider message ids" as a thing it expects to hold. jsonb cannot be
-- cheaply made unique, and a replay guard that is not unique is not a guard,
-- so the provider's id gets a column of its own — named for the `external_ref`
-- that crm.conversations already uses for the same purpose one level up.
alter table crm.conversation_messages
  add column if not exists external_ref text;

comment on column crm.conversation_messages.external_ref is
  'The provider''s own id for this message (e.g. a WhatsApp wamid). Null for messages composed in the app. Unique per organization, which is what makes redelivery free.';

-- The guard itself. Partial, because only messages that came from a provider
-- have one, and two app-composed messages must not collide on null.
create unique index if not exists conversation_messages_external_ref_key
  on crm.conversation_messages (organization_id, external_ref)
  where external_ref is not null;


-- ── the ingest ─────────────────────────────────────────────────────────────
--
-- Returns one row describing what happened. Three outcomes, all of them
-- ordinary:
--
--   unknown_phone_number_id — no organization claims this number. Not an
--                             error: the provider can deliver to a number we
--                             no longer serve, and a webhook must still be
--                             able to answer 200 rather than retry forever.
--   replayed                — this provider message id is already recorded.
--                             The existing ids are returned and nothing is
--                             written, including no second extraction job.
--   ingested                — new message; everything resolved or created.
--
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
  returning id into v_lead;

  if v_lead is null then
    select l.id into v_lead
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

  -- ── 6. queue the extraction ──────────────────────────────────────────────
  --
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
  'Records one inbound WhatsApp message and everything it implies, exactly once. Sends nothing.';

-- Service role only. This bypasses RLS by construction (security definer) and
-- resolves its own tenancy, so no signed-in principal has any business calling
-- it — the webhook that will call it holds the service key and nothing else.
revoke all on function crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function crm.ingest_whatsapp_message(text, text, text, text, text, timestamptz)
  to service_role;
