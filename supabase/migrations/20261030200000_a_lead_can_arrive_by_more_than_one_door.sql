-- ═══════════════════════════════════════════════════════════════════════════
-- A lead can arrive by more than one door — audit step 1.1.
--
-- Business Phase 1-4 forensic audit, step 1.1: `crm.leads.source` already
-- allowed `web_form` and `email`, and nothing ever wrote either value. Only
-- `crm.ingest_whatsapp_message` existed, so a contact enquiry through the
-- agency's own website, a reply to an outbound email, or a Facebook/Instagram
-- Lead Ad was lost outright — the queue only ever showed WhatsApp.
--
-- This gives each of the other three channels the same thing WhatsApp has:
-- one atomic, idempotent, SECURITY DEFINER function that resolves tenancy from
-- the payload, finds-or-creates the contact, finds-or-creates the lead, and
-- (for the two that carry a narrative message) appends to a transcript and
-- queues extraction. Deliberately NOT a shared helper in TypeScript — the
-- reason `crm.ingest_whatsapp_message` gives for being one SQL statement
-- (`src/modules/crm/ingest.ts`'s own module comment) applies just as much
-- here: several inserts across tables that must be atomic, and a transcript
-- position that cannot be assigned safely by reading a maximum and then
-- inserting. Each function below is that same atomic unit for its channel; the
-- TypeScript beside it stays the thin shape ingest.ts already established.
--
-- ── what is reused rather than reinvented ─────────────────────────────────
--
--   • Contact dedupe: the exact insert-or-find against
--     contacts_org_email_key / contacts_org_phone_key that
--     crm.ingest_whatsapp_message already uses for phone. A returning
--     visitor's name is never overwritten by a new submission, for the same
--     reason a WhatsApp profile name is not.
--   • Lead idempotency: `leads_source_ref_key` (organization_id, source,
--     source_ref), unique already. Each function below chooses a source_ref
--     that means "the same person, this channel" so a second submission
--     continues one open lead rather than opening a new one per event.
--   • Campaign attribution: `campaign_source_type` / `campaign_source_id` /
--     `campaign_source_url` / `campaign_headline`, added for the WhatsApp
--     Click-to-WhatsApp referral by 20260904180000 and reused here verbatim
--     for a Facebook/Instagram Lead Ad — a lead ad's ad_id is exactly the
--     "which advertisement brought them" question those columns exist to
--     answer, and `campaign_source_type` already allows 'ad'.
--   • The conversation/message transcript (crm.conversations,
--     crm.conversation_messages) already lists `web_form` and `email` in
--     `conversations.channel`'s CHECK — added by migration 012 alongside
--     WhatsApp and never populated. A web-form enquiry and an inbound email
--     both carry free text worth a human (and the extractor) reading, so both
--     get a conversation and queue `requirement.extract`, exactly as a
--     WhatsApp text message does.
--   • Requirement extraction dedupe: the identical
--     `requirement.extract:<conversation>:<count>` key, so a resubmission and
--     the job runner cannot produce two model calls against one transcript.
--
-- ── what does NOT reuse the transcript model ──────────────────────────────
--
-- A Facebook/Instagram Lead Ad submission is a set of form-field answers, not
-- a narrative message — there is no prose for the extractor to read, the same
-- reason a WhatsApp image or location queues no extraction. It gets a contact,
-- a lead, and a `lead_activities` row recording the raw answers (kind
-- `message_in`, the same vocabulary a WhatsApp transcript line's author_type
-- borrows from), but no conversation and no job.
--
-- ── the one new vocabulary value ──────────────────────────────────────────
--
-- `crm.leads.source` allowed 'manual', 'whatsapp', 'web_form', 'email',
-- 'referral', 'import' — no value for a Lead Ad. Additive: existing rows keep
-- their value, and every existing CHECK caller (crm/schema.ts LEAD_SOURCES,
-- wherever it is mirrored) needs the new value added alongside, not in place
-- of, the old list.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.leads drop constraint if exists leads_source_check;
alter table crm.leads add constraint leads_source_check check (source in
  ('manual', 'whatsapp', 'web_form', 'email', 'facebook_lead_ads', 'referral', 'import'));

comment on column crm.leads.source is
  'How this lead arrived. whatsapp/web_form/email/facebook_lead_ads are producer-written by crm.ingest_*; manual is staff-created; referral and import are the pre-existing manual paths.';


-- ── web form ────────────────────────────────────────────────────────────────
--
-- Tenancy resolved the same way WhatsApp's phone_number_id is: a value the
-- organization configures and the public form embeds, matched against
-- `core.organizations.settings`. Not a secret in the HMAC sense — nothing
-- signs a browser's own POST — so the endpoint calling this additionally
-- applies its own anti-abuse checks (see app/api/leads/web-form/route.ts);
-- this function's job is identity and idempotency, not spam filtering.
--
-- v_ref keys the lead by WHO, not by WHEN: 'web:' || identity, so a visitor
-- who submits the contact form twice continues one open lead — a second
-- message on one thread — rather than opening a duplicate inquiry. Mirrors
-- WhatsApp's 'wa:' || phone exactly.

CREATE OR REPLACE FUNCTION crm.ingest_web_form_lead(
  p_form_key      text,
  p_full_name     text,
  p_email         text DEFAULT NULL::text,
  p_phone         text DEFAULT NULL::text,
  p_message       text DEFAULT NULL::text,
  p_external_ref  text DEFAULT NULL::text,
  p_occurred_at   timestamp with time zone DEFAULT now(),
  p_page_url      text DEFAULT NULL::text,
  p_utm_source    text DEFAULT NULL::text,
  p_utm_campaign  text DEFAULT NULL::text
)
 RETURNS TABLE(status text, organization_id uuid, contact_id uuid, lead_id uuid, conversation_id uuid, message_id uuid, message_seq integer, job_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_org          uuid;
  v_email        text;
  v_phone        text;
  v_identity     text;
  v_thread       text;
  v_display      text;
  v_contact      uuid;
  v_lead         uuid;
  v_lead_status  text;
  v_conversation uuid;
  v_message      uuid;
  v_seq          int;
  v_job          uuid;
  v_count        int;
begin
  select o.id
    into v_org
    from core.organizations o
   where o.settings->>'web_form_key' = p_form_key
   limit 1;

  if v_org is null then
    return query
      select 'unknown_form_key'::text,
             null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::int, null::uuid;
    return;
  end if;

  v_email    := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_phone    := case when btrim(coalesce(p_phone, '')) = '' then null
                     else '+' || regexp_replace(p_phone, '[^0-9]', '', 'g') end;

  -- The route's own zod schema refuses both absent before this is ever
  -- called; checked again here because this function is the actual boundary
  -- a malformed or forged call would cross.
  if v_email is null and v_phone is null then
    return query
      select 'not_reachable'::text,
             null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::int, null::uuid;
    return;
  end if;

  v_identity := coalesce(v_email, v_phone);
  v_thread   := 'web:' || v_identity;
  v_display  := coalesce(nullif(btrim(p_full_name), ''), v_identity);

  -- ── contact: insert-or-find, keyed by whichever identity was supplied ────
  -- Look up by whichever identity was supplied before inserting: a contact
  -- has TWO independent partial unique indexes (email, phone), and an insert
  -- whose ON CONFLICT names only one of them still raises on the other. Look
  -- first, and let the insert's untargeted ON CONFLICT DO NOTHING (which
  -- catches a conflict on ANY unique constraint, not just one named index)
  -- absorb the race if one arrives concurrently.
  if v_email is not null then
    select c.id into v_contact
      from crm.contacts c
     where c.organization_id = v_org
       and lower(c.email) = v_email;
  end if;

  if v_contact is null and v_phone is not null then
    select c.id into v_contact
      from crm.contacts c
     where c.organization_id = v_org
       and c.phone = v_phone;
  end if;

  if v_contact is null then
    insert into crm.contacts (organization_id, full_name, email, phone)
    values (v_org, v_display, v_email, v_phone)
    on conflict do nothing
    returning id into v_contact;
  end if;

  if v_contact is null then
    select c.id into v_contact
      from crm.contacts c
     where c.organization_id = v_org
       and ((v_email is not null and lower(c.email) = v_email)
            or (v_phone is not null and c.phone = v_phone));
  end if;

  -- ── lead ──────────────────────────────────────────────────────────────
  insert into crm.leads (
    organization_id, contact_id, title, summary, source, source_ref, status,
    campaign_source_type, campaign_source_id, campaign_source_url, campaign_headline
  )
  values (
    v_org, v_contact,
    'Web form — ' || v_display,
    'Inbound via the website contact form. Requirements not yet collected.',
    'web_form', v_thread, 'new',
    case when p_utm_source is not null or p_utm_campaign is not null then 'ad' else null end,
    nullif(btrim(coalesce(p_utm_campaign, '')), ''),
    nullif(btrim(coalesce(p_page_url, '')), ''),
    nullif(btrim(coalesce(p_utm_source, '')), '')
  )
  on conflict (organization_id, source, source_ref) where source_ref is not null
  do nothing
  returning id, status into v_lead, v_lead_status;

  if v_lead is null then
    select l.id, l.status into v_lead, v_lead_status
      from crm.leads l
     where l.organization_id = v_org
       and l.source = 'web_form'
       and l.source_ref = v_thread;
  end if;

  -- ── conversation ──────────────────────────────────────────────────────
  insert into crm.conversations (
    organization_id, lead_id, contact_id, channel, external_ref, status
  )
  values (v_org, v_lead, v_contact, 'web_form', v_thread, 'active')
  on conflict (organization_id, channel, external_ref) where external_ref is not null
  do nothing
  returning id into v_conversation;

  if v_conversation is null then
    select c.id into v_conversation
      from crm.conversations c
     where c.organization_id = v_org
       and c.channel = 'web_form'
       and c.external_ref = v_thread;
  end if;

  -- No message body was submitted (a pure "contact me" form with no free-text
  -- field) — the lead and conversation still exist so a human can follow up,
  -- but there is nothing to transcribe or extract from.
  if coalesce(btrim(p_message), '') = '' then
    return query
      select 'ingested'::text, v_org, v_contact, v_lead, v_conversation,
             null::uuid, null::int, null::uuid;
    return;
  end if;

  perform 1 from crm.conversations c where c.id = v_conversation for update;

  insert into crm.conversation_messages (
    organization_id, conversation_id, seq, author_type, body, external_ref, occurred_at, metadata
  )
  select v_org,
         v_conversation,
         coalesce(max(m.seq), -1) + 1,
         'client',
         p_message,
         p_external_ref,
         p_occurred_at,
         jsonb_build_object('provider', 'web_form')
           || case when p_page_url is null then '{}'::jsonb
                   else jsonb_build_object('page_url', p_page_url) end
    from crm.conversation_messages m
   where m.conversation_id = v_conversation
  on conflict (organization_id, external_ref) where external_ref is not null
  do nothing
  returning id, seq into v_message, v_seq;

  if v_message is null and p_external_ref is not null then
    select m.id, m.seq into v_message, v_seq
      from crm.conversation_messages m
     where m.organization_id = v_org
       and m.external_ref = p_external_ref;

    return query
      select 'replayed'::text, v_org, v_contact, v_lead, v_conversation,
             v_message, v_seq, null::uuid;
    return;
  end if;

  if v_lead_status in ('converted', 'disqualified') then
    return query
      select 'ingested'::text, v_org, v_contact, v_lead, v_conversation,
             v_message, v_seq, null::uuid;
    return;
  end if;

  select count(*)::int into v_count
    from crm.conversation_messages m
   where m.conversation_id = v_conversation;

  insert into core.jobs (organization_id, kind, payload, dedupe_key, correlation_id)
  values (
    v_org, 'requirement.extract',
    jsonb_build_object('conversationId', v_conversation, 'source', 'web_form'),
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

comment on function crm.ingest_web_form_lead(text, text, text, text, text, text, timestamptz, text, text, text) is
  'Records one website contact-form submission and everything it implies, exactly once per (organization, identity) thread. p_form_key resolves tenancy the way WhatsApp''s phone_number_id does. Mirrors crm.ingest_whatsapp_message''s shape.';

grant execute on function crm.ingest_web_form_lead(text, text, text, text, text, text, timestamptz, text, text, text)
  to service_role;


-- ── email ─────────────────────────────────────────────────────────────────
--
-- Tenancy resolved from the mailbox the message was delivered to, matched
-- against `core.organizations.settings->>'inbound_email_address'` —
-- structurally identical to WhatsApp's phone_number_id lookup. v_thread keys
-- the lead by the sender's address, so a second email from the same person
-- continues one open lead rather than opening a duplicate.

CREATE OR REPLACE FUNCTION crm.ingest_email_lead(
  p_mailbox        text,
  p_from_email     text,
  p_from_name      text DEFAULT NULL::text,
  p_subject        text DEFAULT NULL::text,
  p_body           text DEFAULT ''::text,
  p_external_ref   text DEFAULT NULL::text,
  p_occurred_at    timestamp with time zone DEFAULT now()
)
 RETURNS TABLE(status text, organization_id uuid, contact_id uuid, lead_id uuid, conversation_id uuid, message_id uuid, message_seq integer, job_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_org          uuid;
  v_email        text;
  v_thread       text;
  v_display      text;
  v_contact      uuid;
  v_lead         uuid;
  v_lead_status  text;
  v_conversation uuid;
  v_message      uuid;
  v_seq          int;
  v_job          uuid;
  v_count        int;
begin
  select o.id
    into v_org
    from core.organizations o
   where o.settings->>'inbound_email_address' = lower(btrim(p_mailbox))
   limit 1;

  if v_org is null then
    return query
      select 'unknown_mailbox'::text,
             null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::int, null::uuid;
    return;
  end if;

  v_email   := lower(btrim(p_from_email));
  v_thread  := 'email:' || v_email;
  v_display := coalesce(nullif(btrim(p_from_name), ''), v_email);

  insert into crm.contacts (organization_id, full_name, email)
  values (v_org, v_display, v_email)
  on conflict (organization_id, lower(email)) where email is not null
  do nothing
  returning id into v_contact;

  if v_contact is null then
    select c.id into v_contact
      from crm.contacts c
     where c.organization_id = v_org
       and lower(c.email) = v_email;
  end if;

  insert into crm.leads (
    organization_id, contact_id, title, summary, source, source_ref, status
  )
  values (
    v_org, v_contact,
    'Email — ' || coalesce(nullif(btrim(p_subject), ''), v_display),
    'Inbound via email. Requirements not yet collected.',
    'email', v_thread, 'new'
  )
  on conflict (organization_id, source, source_ref) where source_ref is not null
  do nothing
  returning id, status into v_lead, v_lead_status;

  if v_lead is null then
    select l.id, l.status into v_lead, v_lead_status
      from crm.leads l
     where l.organization_id = v_org
       and l.source = 'email'
       and l.source_ref = v_thread;
  end if;

  insert into crm.conversations (
    organization_id, lead_id, contact_id, channel, external_ref, status
  )
  values (v_org, v_lead, v_contact, 'email', v_thread, 'active')
  on conflict (organization_id, channel, external_ref) where external_ref is not null
  do nothing
  returning id into v_conversation;

  if v_conversation is null then
    select c.id into v_conversation
      from crm.conversations c
     where c.organization_id = v_org
       and c.channel = 'email'
       and c.external_ref = v_thread;
  end if;

  perform 1 from crm.conversations c where c.id = v_conversation for update;

  insert into crm.conversation_messages (
    organization_id, conversation_id, seq, author_type, body, external_ref, occurred_at, metadata
  )
  select v_org,
         v_conversation,
         coalesce(max(m.seq), -1) + 1,
         'client',
         p_body,
         p_external_ref,
         p_occurred_at,
         jsonb_build_object('provider', 'email')
           || case when p_subject is null then '{}'::jsonb
                   else jsonb_build_object('subject', p_subject) end
    from crm.conversation_messages m
   where m.conversation_id = v_conversation
  on conflict (organization_id, external_ref) where external_ref is not null
  do nothing
  returning id, seq into v_message, v_seq;

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

  if v_lead_status in ('converted', 'disqualified') then
    return query
      select 'ingested'::text, v_org, v_contact, v_lead, v_conversation,
             v_message, v_seq, null::uuid;
    return;
  end if;

  select count(*)::int into v_count
    from crm.conversation_messages m
   where m.conversation_id = v_conversation;

  insert into core.jobs (organization_id, kind, payload, dedupe_key, correlation_id)
  values (
    v_org, 'requirement.extract',
    jsonb_build_object('conversationId', v_conversation, 'source', 'email'),
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

comment on function crm.ingest_email_lead(text, text, text, text, text, text, timestamptz) is
  'Records one inbound email and everything it implies, exactly once per provider Message-ID. p_mailbox resolves tenancy the way WhatsApp''s phone_number_id does. Mirrors crm.ingest_whatsapp_message''s shape.';

grant execute on function crm.ingest_email_lead(text, text, text, text, text, text, timestamptz)
  to service_role;


-- ── facebook / instagram lead ads ────────────────────────────────────────
--
-- No conversation, no message, no job — a Lead Ad submission is a set of
-- field answers, not a narrative a client typed, the same reason a WhatsApp
-- image or location queues no extraction. Parsing Meta's leadgen_id into
-- these named fields is the route's job, exactly as parseDelivery unwraps
-- WhatsApp's envelope before ingest.ts ever sees it — this function accepts
-- only what it needs, named for what it is rather than for Meta's shape.
--
-- Idempotent on the leadgen_id itself: Meta's own webhook can redeliver, and
-- p_leadgen_id is the provider's unique id for this submission — the same
-- role p_external_ref plays for a WhatsApp message, just one level up,
-- because a lead ad has no separate "message" to be idempotent about.

CREATE OR REPLACE FUNCTION crm.ingest_facebook_lead(
  p_page_id        text,
  p_leadgen_id     text,
  p_full_name      text DEFAULT NULL::text,
  p_email          text DEFAULT NULL::text,
  p_phone          text DEFAULT NULL::text,
  p_ad_id          text DEFAULT NULL::text,
  p_ad_name        text DEFAULT NULL::text,
  p_form_id        text DEFAULT NULL::text,
  p_form_name      text DEFAULT NULL::text,
  p_field_data     jsonb DEFAULT '{}'::jsonb,
  p_occurred_at    timestamp with time zone DEFAULT now()
)
 RETURNS TABLE(status text, organization_id uuid, contact_id uuid, lead_id uuid, activity_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_org       uuid;
  v_email     text;
  v_phone     text;
  v_identity  text;
  v_display   text;
  v_contact   uuid;
  v_lead      uuid;
  v_activity  uuid;
begin
  select o.id
    into v_org
    from core.organizations o
   where o.settings->>'facebook_page_id' = p_page_id
   limit 1;

  if v_org is null then
    return query
      select 'unknown_page_id'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- Idempotent on the provider's own id for this submission, before anything
  -- else is touched: a redelivered webhook must create nothing a second time.
  select l.id, l.contact_id into v_lead, v_contact
    from crm.leads l
   where l.organization_id = v_org
     and l.source = 'facebook_lead_ads'
     and l.source_ref = p_leadgen_id;

  if v_lead is not null then
    return query
      select 'replayed'::text, v_org, v_contact, v_lead, null::uuid;
    return;
  end if;

  v_email    := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_phone    := case when btrim(coalesce(p_phone, '')) = '' then null
                     else '+' || regexp_replace(p_phone, '[^0-9]', '', 'g') end;

  if v_email is null and v_phone is null then
    return query
      select 'not_reachable'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  v_identity := coalesce(v_email, v_phone);
  v_display  := coalesce(nullif(btrim(p_full_name), ''), v_identity);

  -- Look up by whichever identity was supplied before inserting: a contact
  -- has TWO independent partial unique indexes (email, phone), and an insert
  -- whose ON CONFLICT names only one of them still raises on the other. Look
  -- first, and let the insert's untargeted ON CONFLICT DO NOTHING (which
  -- catches a conflict on ANY unique constraint, not just one named index)
  -- absorb the race if one arrives concurrently.
  if v_email is not null then
    select c.id into v_contact
      from crm.contacts c
     where c.organization_id = v_org
       and lower(c.email) = v_email;
  end if;

  if v_contact is null and v_phone is not null then
    select c.id into v_contact
      from crm.contacts c
     where c.organization_id = v_org
       and c.phone = v_phone;
  end if;

  if v_contact is null then
    insert into crm.contacts (organization_id, full_name, email, phone)
    values (v_org, v_display, v_email, v_phone)
    on conflict do nothing
    returning id into v_contact;
  end if;

  if v_contact is null then
    select c.id into v_contact
      from crm.contacts c
     where c.organization_id = v_org
       and ((v_email is not null and lower(c.email) = v_email)
            or (v_phone is not null and c.phone = v_phone));
  end if;

  insert into crm.leads (
    organization_id, contact_id, title, summary, source, source_ref, status,
    campaign_source_type, campaign_source_id, campaign_headline, requirements
  )
  values (
    v_org, v_contact,
    'Facebook/Instagram Lead Ad — ' || v_display,
    'Inbound via a Facebook/Instagram Lead Ad form. No conversation yet.',
    'facebook_lead_ads', p_leadgen_id, 'new',
    'ad', nullif(btrim(coalesce(p_ad_id, '')), ''), nullif(btrim(coalesce(p_ad_name, '')), ''),
    jsonb_build_object('lead_ad_field_data', coalesce(p_field_data, '{}'::jsonb))
  )
  returning id into v_lead;

  insert into crm.lead_activities (
    organization_id, lead_id, kind, body, metadata, actor_type, occurred_at
  )
  values (
    v_org, v_lead, 'message_in',
    'Submitted ' || coalesce(p_form_name, 'a Lead Ad form'),
    jsonb_build_object(
      'provider', 'facebook_lead_ads',
      'leadgen_id', p_leadgen_id,
      'form_id', p_form_id,
      'form_name', p_form_name,
      'ad_id', p_ad_id,
      'field_data', coalesce(p_field_data, '{}'::jsonb)
    ),
    'client', p_occurred_at
  )
  returning id into v_activity;

  return query
    select 'ingested'::text, v_org, v_contact, v_lead, v_activity;
end;
$function$;

comment on function crm.ingest_facebook_lead(text, text, text, text, text, text, text, text, text, jsonb, timestamptz) is
  'Records one Facebook/Instagram Lead Ad submission and everything it implies, exactly once per leadgen_id. p_page_id resolves tenancy the way WhatsApp''s phone_number_id does. No conversation or extraction job: a form submission carries no narrative to read.';

grant execute on function crm.ingest_facebook_lead(text, text, text, text, text, text, text, text, text, jsonb, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
