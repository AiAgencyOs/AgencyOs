-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 3 — a prospect who moves to WhatsApp stays ONE lead.
--
-- Spec §36, §39, §88, §167-N. When a prospect shifts from email, LinkedIn, a
-- marketplace or an ad to WhatsApp, "do NOT create a new independent lead":
-- a secure opaque reference resolves server-side to the existing lead, the
-- conversation continues on it, Sales becomes the owner, and nothing the
-- prospect already said is asked again. A replayed, expired, tampered or
-- cross-tenant token must fail safely.
--
-- THE DECISION THAT MAKES "NO DUPLICATE" TRUE BY CONSTRUCTION.
-- crm.ingest_whatsapp_message keys a lead by its THREAD — (source='whatsapp',
-- source_ref='wa:+<phone>') — and finds a contact by contacts.phone. So the
-- first WhatsApp message from a prospect whose email lead has no WhatsApp
-- thread would open a second lead. Three ways to stop that were weighed:
--   (a) re-emit the ingest function with a handoff branch — the largest, most
--       carried-forward function in the system, changed for one feature;
--   (b) let ingest create the second lead, then FOLD it into the first — the
--       job it already queued points at the loser, and merge_leads refuses a
--       lead with a deal, which is exactly the lead a Sales handoff is about;
--   (c) BIND BEFORE INGEST: when the message carries a valid reference, give
--       the existing lead's contact the sender's phone and re-key the existing
--       lead onto the WhatsApp thread, so the UNCHANGED ingest finds both and
--       continues them. One statement, nothing folded, every job and the whole
--       requirement/quotation history already on the right lead.
-- (c). It was tried against the real ingest function before it was written: one
-- lead, same contact, conversation attached to it.
-- What it costs, stated: leads.source becomes 'whatsapp' (the CLOSING channel).
-- The acquisition source is not lost - crm.lead_touchpoints already holds the
-- first touch, append-only, and a 'handoff' touch is added.
--
-- WHEN A SAFE BIND IS NOT POSSIBLE (the sender's number already belongs to
-- another contact, or the lead already has a different number) nothing is moved
-- and nothing is guessed: the handoff is consumed as LINKED_FOR_REVIEW, the
-- origin touchpoints are copied onto the WhatsApp lead so attribution survives,
-- a duplicate review is opened, and Sales owns the new thread. Two leads then
-- exist until a person decides - which is the honest state, not a hidden one.
--
-- THE TOKEN. The reference (AOS-XXXX-XXXX-XXXX-XXXX, 80 bits) is derived in the
-- application as HMAC(secret, handoff_id), so a retried job can regenerate the
-- same link without the plaintext ever being stored; the database holds only
-- its SHA-256. It carries no data: everything it resolves to is server-side.
-- Lookup is always (organisation, hash) - an organisation's number can only
-- resolve that organisation's handoffs.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the dialable number and the link lifetime ───────────────────────────

create table if not exists crm.whatsapp_handoff_settings (
  organization_id  uuid primary key references core.organizations(id) on delete cascade,
  business_number  text check (business_number is null or business_number ~ '^\+[0-9]{8,15}$'),
  link_ttl_days    integer not null default 14 check (link_ttl_days between 1 and 90),
  updated_by       uuid references core.users(id) on delete set null,
  updated_at       timestamptz not null default now()
);
comment on table crm.whatsapp_handoff_settings is
  'The dialable WhatsApp business number a handoff link opens (the existing whatsapp_phone_number_id is an API id, not a number) and how long a link lives. One row per organisation.';

drop trigger if exists freeze_org_whatsapp_handoff_settings on crm.whatsapp_handoff_settings;
create trigger freeze_org_whatsapp_handoff_settings before update of organization_id on crm.whatsapp_handoff_settings
  for each row execute function core.freeze_organization_id();
alter table crm.whatsapp_handoff_settings enable row level security;
alter table crm.whatsapp_handoff_settings force row level security;
drop policy if exists whatsapp_handoff_settings_select on crm.whatsapp_handoff_settings;
create policy whatsapp_handoff_settings_select on crm.whatsapp_handoff_settings for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
-- The platform's default privileges would otherwise hand anon SELECT and authenticated INSERT/UPDATE/DELETE on a new table;
-- RLS would still refuse the rows, but a grant that is wider than the intent is the first thing a policy mistake exposes.
revoke all on table crm.whatsapp_handoff_settings from public, anon, authenticated;
grant select on crm.whatsapp_handoff_settings to authenticated;
grant select, insert, update on crm.whatsapp_handoff_settings to service_role;

-- ── 2. the handoff ─────────────────────────────────────────────────────────

create table if not exists crm.channel_handoffs (
  id                 uuid primary key,
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  lead_id            uuid not null references crm.leads(id) on delete restrict,
  contact_id         uuid references crm.contacts(id) on delete set null,
  opportunity_id     uuid references sales.opportunities(id) on delete set null,
  source_channel     text not null check (source_channel in ('meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other')),
  source_platform    text check (source_platform is null or length(source_platform) between 2 and 40),
  source_agent       text not null check (source_agent in ('email_outreach', 'social_media', 'b2b_opportunity', 'ad_manager', 'sales', 'human')),
  destination_channel text not null default 'whatsapp' check (destination_channel = 'whatsapp'),
  destination_agent  text not null default 'sales' check (destination_agent = 'sales'),
  status             text not null default 'CREATED' check (status in ('CREATED', 'OPENED', 'RESOLVED', 'CONSUMED', 'EXPIRED', 'INVALID', 'CANCELLED')),
  token_hash         text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  context_version    integer not null default 1 check (context_version >= 1),
  context            jsonb not null check (jsonb_typeof(context) = 'object' and octet_length(context::text) <= 20000),
  next_action        text check (next_action is null or length(next_action) <= 300),
  expires_at         timestamptz not null,
  opened_at          timestamptz,
  resolved_at        timestamptz,
  resolved_phone     text check (resolved_phone is null or resolved_phone ~ '^\+[0-9]{8,15}$'),
  bind_outcome       text check (bind_outcome is null or bind_outcome in ('bound', 'review_needed')),
  consumed_at        timestamptz,
  consumed_contact_id uuid references crm.contacts(id) on delete set null,
  consumed_lead_id   uuid references crm.leads(id) on delete set null,
  consume_outcome    text check (consume_outcome is null or consume_outcome in ('same_lead', 'linked_for_review')),
  cancel_reason      text check (cancel_reason is null or length(cancel_reason) <= 500),
  created_by         uuid references core.users(id) on delete set null,
  correlation_id     uuid,
  created_at         timestamptz not null default now(),
  constraint channel_handoffs_consumed_says_when check (status <> 'CONSUMED' or (consumed_at is not null and consume_outcome is not null))
);
create unique index if not exists channel_handoffs_token_key on crm.channel_handoffs (organization_id, token_hash);
-- At most one LIVE handoff per lead: a retried creation finds it instead of minting a second.
create unique index if not exists channel_handoffs_one_live_per_lead
  on crm.channel_handoffs (lead_id) where status in ('CREATED', 'OPENED', 'RESOLVED');
create index if not exists channel_handoffs_org_status_idx on crm.channel_handoffs (organization_id, status, created_at desc);
create index if not exists channel_handoffs_expiry_idx on crm.channel_handoffs (expires_at) where status in ('CREATED', 'OPENED');

comment on table crm.channel_handoffs is
  'A tracked move of a prospect from another channel to WhatsApp (spec §39). The opaque reference is never stored - only its SHA-256 - and carries no data. Identity, context and the lead are frozen at creation; only the state machine moves. Never deleted.';

-- The state machine, and what may never change.
create or replace function crm.channel_handoff_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a handoff is history; cancel it instead' using errcode = '42501';
  end if;
  if (new.id, new.organization_id, new.lead_id, new.contact_id, new.opportunity_id, new.source_channel, new.source_platform,
      new.source_agent, new.destination_channel, new.destination_agent, new.token_hash, new.context_version, new.context,
      new.expires_at, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.lead_id, old.contact_id, old.opportunity_id, old.source_channel, old.source_platform,
      old.source_agent, old.destination_channel, old.destination_agent, old.token_hash, old.context_version, old.context,
      old.expires_at, old.created_by, old.created_at) then
    raise exception 'a handoff''s identity, context and lifetime are frozen at creation' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'CREATED'  and new.status in ('OPENED', 'RESOLVED', 'EXPIRED', 'CANCELLED', 'INVALID'))
         or (old.status = 'OPENED'   and new.status in ('RESOLVED', 'EXPIRED', 'CANCELLED', 'INVALID'))
         or (old.status = 'RESOLVED' and new.status in ('CONSUMED', 'EXPIRED', 'CANCELLED', 'INVALID'))) then
      raise exception 'a % handoff cannot become %', old.status, new.status using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists channel_handoff_guard on crm.channel_handoffs;
create trigger channel_handoff_guard before update or delete on crm.channel_handoffs
  for each row execute function crm.channel_handoff_guard();

drop trigger if exists freeze_org_channel_handoffs on crm.channel_handoffs;
create trigger freeze_org_channel_handoffs before update of organization_id on crm.channel_handoffs
  for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_channel_handoffs_lead on crm.channel_handoffs;
create trigger org_match_channel_handoffs_lead before insert or update of lead_id, organization_id on crm.channel_handoffs
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');
drop trigger if exists org_match_channel_handoffs_contact on crm.channel_handoffs;
create trigger org_match_channel_handoffs_contact before insert or update of contact_id, organization_id on crm.channel_handoffs
  for each row execute function core.enforce_parent_org('contact_id', 'crm.contacts');
drop trigger if exists org_match_channel_handoffs_opportunity on crm.channel_handoffs;
create trigger org_match_channel_handoffs_opportunity before insert or update of opportunity_id, organization_id on crm.channel_handoffs
  for each row execute function core.enforce_parent_org('opportunity_id', 'sales.opportunities');
drop trigger if exists org_match_channel_handoffs_consumed_contact on crm.channel_handoffs;
create trigger org_match_channel_handoffs_consumed_contact before insert or update of consumed_contact_id, organization_id on crm.channel_handoffs
  for each row execute function core.enforce_parent_org('consumed_contact_id', 'crm.contacts');
drop trigger if exists org_match_channel_handoffs_consumed_lead on crm.channel_handoffs;
create trigger org_match_channel_handoffs_consumed_lead before insert or update of consumed_lead_id, organization_id on crm.channel_handoffs
  for each row execute function core.enforce_parent_org('consumed_lead_id', 'crm.leads');
alter table crm.channel_handoffs enable row level security;
alter table crm.channel_handoffs force row level security;
drop policy if exists channel_handoffs_select on crm.channel_handoffs;
create policy channel_handoffs_select on crm.channel_handoffs for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
-- The token hash is a lookup key, not a secret, but an internal reader has no use for it: grant every column but that one.
revoke all on table crm.channel_handoffs from public, anon, authenticated;
grant select (id, organization_id, lead_id, contact_id, opportunity_id, source_channel, source_platform, source_agent,
              destination_channel, destination_agent, status, context_version, context, next_action, expires_at, opened_at,
              resolved_at, resolved_phone, bind_outcome, consumed_at, consumed_contact_id, consumed_lead_id, consume_outcome,
              cancel_reason, created_by, correlation_id, created_at)
  on crm.channel_handoffs to authenticated;
grant select, insert, update on crm.channel_handoffs to service_role;

-- A handoff can also be the reason two contacts are suspected to be one person.
alter table crm.duplicate_reviews drop constraint if exists duplicate_reviews_reason_check;
alter table crm.duplicate_reviews add constraint duplicate_reviews_reason_check
  check (reason in ('shared_key', 'name_and_domain', 'name_and_company', 'handoff_claim'));

-- ── 3. settings door ───────────────────────────────────────────────────────

create or replace function crm.set_handoff_settings(p_business_number text, p_link_ttl_days integer)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_number text := nullif(crm.norm_phone(p_business_number), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  if (nullif(btrim(coalesce(p_business_number, '')), '') is not null and v_number is null)
     or coalesce(p_link_ttl_days, 14) not between 1 and 90 then
    return query select 'invalid'::text; return;
  end if;
  select to_jsonb(s.*) into v_before from crm.whatsapp_handoff_settings s where s.organization_id = v_org for update;
  insert into crm.whatsapp_handoff_settings (organization_id, business_number, link_ttl_days, updated_by)
  values (v_org, v_number, coalesce(p_link_ttl_days, 14), v_actor)
  on conflict (organization_id) do update
     set business_number = excluded.business_number, link_ttl_days = excluded.link_ttl_days, updated_by = v_actor, updated_at = now()
  returning to_jsonb(crm.whatsapp_handoff_settings.*) into v_after;
  perform core.record_audit(v_org, 'handoff.settings_changed', 'whatsapp_handoff_settings', null, v_before, v_after);
  return query select 'saved'::text;
end;
$$;
revoke all on function crm.set_handoff_settings(text, integer) from public, anon;
grant execute on function crm.set_handoff_settings(text, integer) to authenticated;

-- ── 4. create (idempotent: one live handoff per lead) ──────────────────────

create or replace function crm.create_channel_handoff(
  p_organization_id uuid, p_handoff_id uuid, p_token_hash text, p_lead uuid,
  p_source_channel text, p_source_platform text, p_source_agent text,
  p_next_action text default null, p_ttl_days integer default null, p_correlation_id uuid default null
)
returns table (outcome text, handoff_id uuid, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_lead  crm.leads;
  v_ttl   integer;
  v_ctx   jsonb;
  v_opp   uuid;
  v_exist crm.channel_handoffs;
  v_out   text;
begin
  if v_actor is not null then
    if p_organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false) then
      return query select 'forbidden'::text, null::uuid, null::timestamptz; return;
    end if;
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_handoff_id is null
     or p_source_channel not in ('meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other')
     or p_source_agent not in ('email_outreach', 'social_media', 'b2b_opportunity', 'ad_manager', 'sales', 'human')
     or (p_next_action is not null and length(p_next_action) > 300)
     or (p_ttl_days is not null and p_ttl_days not between 1 and 90) then
    return query select 'invalid'::text, null::uuid, null::timestamptz; return;
  end if;

  select * into v_lead from crm.leads l where l.id = p_lead and l.organization_id = p_organization_id for update;
  if v_lead.id is null then return query select 'unknown_lead'::text, null::uuid, null::timestamptz; return; end if;
  if v_lead.merged_into_lead_id is not null then return query select 'lead_merged'::text, null::uuid, null::timestamptz; return; end if;
  v_out := crm.lead_outcome(p_lead);
  if v_out in ('WON', 'LOST', 'DISQUALIFIED') then return query select 'closed'::text, null::uuid, null::timestamptz; return; end if;

  -- A retry finds the live one; the caller re-derives the same reference from its id.
  select * into v_exist from crm.channel_handoffs h where h.lead_id = p_lead and h.status in ('CREATED', 'OPENED', 'RESOLVED');
  if v_exist.id is not null then
    -- Only an unused link expires: a RESOLVED one was already used and is waiting for its first message to be recorded.
    if v_exist.expires_at < now() and v_exist.status in ('CREATED', 'OPENED') then
      update crm.channel_handoffs set status = 'EXPIRED' where id = v_exist.id;
    else
      return query select 'exists'::text, v_exist.id, v_exist.expires_at; return;
    end if;
  end if;

  select coalesce(p_ttl_days, s.link_ttl_days, 14) into v_ttl from (select 1) x left join crm.whatsapp_handoff_settings s on s.organization_id = p_organization_id;
  select o.id into v_opp from sales.opportunities o where o.lead_id = p_lead order by o.created_at desc, o.id desc limit 1;

  -- The package is built HERE from authoritative rows. A caller cannot put words in it.
  v_ctx := jsonb_build_object(
    'lead', jsonb_strip_nulls(jsonb_build_object(
      'title', v_lead.title, 'summary', v_lead.summary, 'status', v_lead.status, 'score', v_lead.score,
      'service', v_lead.service, 'requirements', v_lead.requirements, 'qualification', v_lead.qualification,
      'source', v_lead.source, 'created_at', v_lead.created_at)),
    'first_touch', (select to_jsonb(a) - 'last_channel' - 'last_platform' - 'last_at' - 'last_campaign' from crm.lead_attribution(p_lead) a),
    'channels_touched', (select coalesce(array_agg(distinct t.channel), '{}') from crm.lead_touchpoints t where t.lead_id = p_lead),
    'conversation_count', (select count(*) from crm.conversations c where c.lead_id = p_lead),
    'meeting_count', (select count(*) from crm.meetings m where m.lead_id = p_lead),
    'objection_count', (select count(*) from sales.objections ob where ob.lead_id = p_lead),
    'opportunity', (select jsonb_build_object('stage', o.stage, 'value_minor', o.value_minor, 'currency', o.currency) from sales.opportunities o where o.id = v_opp),
    'owner_at_creation', (select o.owner from crm.lead_conversation_owner o where o.lead_id = p_lead),
    'built_at', now());

  insert into crm.channel_handoffs (id, organization_id, lead_id, contact_id, opportunity_id, source_channel, source_platform, source_agent,
                                    token_hash, context, next_action, expires_at, created_by, correlation_id)
  values (p_handoff_id, p_organization_id, p_lead, v_lead.contact_id, v_opp, p_source_channel, nullif(btrim(coalesce(p_source_platform, '')), ''),
          p_source_agent, p_token_hash, v_ctx, nullif(btrim(coalesce(p_next_action, '')), ''), now() + make_interval(days => v_ttl), v_actor, p_correlation_id);

  perform core.record_audit(p_organization_id, 'handoff.created', 'lead', p_lead, null,
    jsonb_build_object('handoff_id', p_handoff_id, 'source_channel', p_source_channel, 'source_agent', p_source_agent), p_correlation_id);
  return query select 'created'::text, p_handoff_id, now() + make_interval(days => v_ttl);
exception when unique_violation then
  -- A concurrent create for the same lead won the race: hand back its id, do not create a second.
  select * into v_exist from crm.channel_handoffs h where h.lead_id = p_lead and h.status in ('CREATED', 'OPENED', 'RESOLVED');
  if v_exist.id is not null then return query select 'exists'::text, v_exist.id, v_exist.expires_at; return; end if;
  raise;
end;
$$;
revoke all on function crm.create_channel_handoff(uuid, uuid, text, uuid, text, text, text, text, integer, uuid) from public, anon;
grant execute on function crm.create_channel_handoff(uuid, uuid, text, uuid, text, text, text, text, integer, uuid) to authenticated, service_role;

-- ── 5. open (the link was followed): public, so it returns almost nothing ──

create or replace function crm.open_channel_handoff(p_token_hash text)
returns table (outcome text, business_number text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  h crm.channel_handoffs;
  v_number text;
begin
  select * into h from crm.channel_handoffs x where x.token_hash = p_token_hash for update;
  if h.id is null then return query select 'unknown'::text, null::text; return; end if;
  if h.status in ('CREATED', 'OPENED') and h.expires_at < now() then
    update crm.channel_handoffs set status = 'EXPIRED' where id = h.id;
    perform core.record_audit(h.organization_id, 'handoff.expired', 'lead', h.lead_id, null, jsonb_build_object('handoff_id', h.id));
    return query select 'expired'::text, null::text; return;
  end if;
  if h.status not in ('CREATED', 'OPENED') then
    return query select lower(h.status), null::text; return;
  end if;
  select s.business_number into v_number from crm.whatsapp_handoff_settings s where s.organization_id = h.organization_id;
  if v_number is null then return query select 'no_number'::text, null::text; return; end if;
  if h.status = 'CREATED' then
    update crm.channel_handoffs set status = 'OPENED', opened_at = now() where id = h.id;
  end if;
  return query select 'open'::text, v_number;
end;
$$;
revoke all on function crm.open_channel_handoff(text) from public, anon, authenticated;
grant execute on function crm.open_channel_handoff(text) to service_role;

-- ── 6. bind: before ingest, make the existing lead the WhatsApp thread ─────

create or replace function crm.bind_handoff_from_message(p_phone_number_id text, p_from text, p_code_hash text)
returns table (outcome text, handoff_id uuid, organization_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  h       crm.channel_handoffs;
  v_lead  crm.leads;
  v_phone text := '+' || regexp_replace(coalesce(p_from, ''), '[^0-9]', '', 'g');
  v_thread text;
  v_cphone text;
  v_other uuid;
  v_wa_lead uuid;
begin
  select o.id into v_org from core.organizations o where o.settings ->> 'whatsapp_phone_number_id' = p_phone_number_id limit 1;
  if v_org is null or p_code_hash is null or v_phone !~ '^\+[0-9]{8,15}$' then
    return query select 'unknown'::text, null::uuid, null::uuid; return;
  end if;
  -- (organisation, hash): a number can only resolve ITS OWN organisation's handoffs.
  select * into h from crm.channel_handoffs x where x.organization_id = v_org and x.token_hash = p_code_hash for update;
  if h.id is null then return query select 'unknown'::text, null::uuid, v_org; return; end if;

  if h.status in ('CREATED', 'OPENED') and h.expires_at < now() then
    update crm.channel_handoffs set status = 'EXPIRED' where id = h.id;
    return query select 'expired'::text, h.id, v_org; return;
  end if;
  if h.status = 'RESOLVED' then return query select 'already_resolved'::text, h.id, v_org; return; end if;
  if h.status = 'CONSUMED' then return query select 'already_consumed'::text, h.id, v_org; return; end if;
  if h.status not in ('CREATED', 'OPENED') then return query select lower(h.status), h.id, v_org; return; end if;

  select * into v_lead from crm.leads l where l.id = h.lead_id and l.organization_id = v_org for update;
  if v_lead.id is null or v_lead.merged_into_lead_id is not null or crm.lead_outcome(h.lead_id) in ('WON', 'LOST', 'DISQUALIFIED') then
    update crm.channel_handoffs set status = 'INVALID' where id = h.id;
    perform core.record_audit(v_org, 'handoff.invalidated', 'lead', h.lead_id, null, jsonb_build_object('handoff_id', h.id, 'why', 'the lead is gone, merged or closed'));
    return query select 'invalid'::text, h.id, v_org; return;
  end if;

  v_thread := 'wa:' || v_phone;
  select c.phone into v_cphone from crm.contacts c where c.id = v_lead.contact_id;
  select c.id into v_other from crm.contacts c where c.organization_id = v_org and c.phone = v_phone and c.id is distinct from v_lead.contact_id;
  select l.id into v_wa_lead from crm.leads l where l.organization_id = v_org and l.source = 'whatsapp' and l.source_ref = v_thread;

  if v_lead.source = 'whatsapp' and v_lead.source_ref = v_thread then
    -- The lead is already the thread (a number that was on file): nothing to move.
    update crm.channel_handoffs set status = 'RESOLVED', resolved_at = now(), resolved_phone = v_phone, bind_outcome = 'bound' where id = h.id;
    return query select 'bound'::text, h.id, v_org; return;
  end if;

  if v_other is not null                                  -- the number belongs to a different contact
     or (v_wa_lead is not null and v_wa_lead <> v_lead.id)  -- a WhatsApp thread for it already exists
     or (v_cphone is not null and v_cphone <> v_phone)      -- this contact has a different number
     or v_lead.source = 'whatsapp' then                     -- the lead is already on another number's thread
    update crm.channel_handoffs set status = 'RESOLVED', resolved_at = now(), resolved_phone = v_phone, bind_outcome = 'review_needed' where id = h.id;
    return query select 'review_needed'::text, h.id, v_org; return;
  end if;

  -- The safe bind: this contact gets the number, and this lead becomes the thread the unchanged ingest will find.
  update crm.contacts set phone = v_phone where id = v_lead.contact_id and phone is null;
  perform crm._attach_identity_keys(v_org, v_lead.contact_id, array['phone']::text[], array[v_phone]::text[], 'handoff');
  update crm.leads set source = 'whatsapp', source_ref = v_thread where id = v_lead.id;
  update crm.channel_handoffs set status = 'RESOLVED', resolved_at = now(), resolved_phone = v_phone, bind_outcome = 'bound' where id = h.id;
  perform core.record_audit(v_org, 'handoff.bound', 'lead', v_lead.id,
    jsonb_build_object('source', v_lead.source, 'source_ref', v_lead.source_ref), jsonb_build_object('source', 'whatsapp', 'handoff_id', h.id));
  return query select 'bound'::text, h.id, v_org;
end;
$$;
revoke all on function crm.bind_handoff_from_message(text, text, text) from public, anon, authenticated;
grant execute on function crm.bind_handoff_from_message(text, text, text) to service_role;

-- ── 7. consume: after ingest, finish the move ──────────────────────────────

create or replace function crm.consume_channel_handoff(p_handoff_id uuid, p_organization_id uuid, p_contact_id uuid, p_lead_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  h crm.channel_handoffs;
  v_owner text;
  v_result text;
  r record;
begin
  select * into h from crm.channel_handoffs x where x.id = p_handoff_id and x.organization_id = p_organization_id for update;
  if h.id is null then return query select 'unknown'::text; return; end if;
  if h.status = 'CONSUMED' then return query select 'already_consumed'::text; return; end if;
  if h.status <> 'RESOLVED' then return query select 'not_resolved'::text; return; end if;

  select o.owner into v_owner from crm.lead_conversation_owner o where o.lead_id = h.lead_id;

  if h.bind_outcome = 'bound' then
    if p_lead_id is distinct from h.lead_id then
      -- The bind said the ingest would continue the original lead and it did not. Never guess: leave it for a person.
      perform core.record_audit(p_organization_id, 'handoff.consume_mismatch', 'lead', h.lead_id, null,
        jsonb_build_object('handoff_id', h.id, 'ingested_lead', p_lead_id));
      return query select 'mismatch'::text; return;
    end if;
    perform crm.record_touchpoint(p_organization_id, h.lead_id, 'whatsapp', null, 'handoff',
      jsonb_build_object('handoff_id', h.id, 'from_channel', h.source_channel, 'from_platform', h.source_platform),
      '{}', 'handoff:' || h.id::text, now(), h.correlation_id);
    perform crm.transfer_conversation_owner(p_organization_id, h.lead_id, v_owner, 'sales',
      'prospect moved to WhatsApp (tracked handoff)', 'handoff_consumed',
      jsonb_build_object('handoff_id', h.id, 'from_channel', h.source_channel), h.correlation_id);
    update crm.channel_handoffs set status = 'CONSUMED', consumed_at = now(), consumed_contact_id = p_contact_id,
           consumed_lead_id = p_lead_id, consume_outcome = 'same_lead' where id = h.id;
    v_result := 'consumed';
  else
    -- No safe bind: ingest opened its own lead. Carry the true first touch across, ask a person, and let Sales own the thread.
    if p_lead_id is not null and p_lead_id <> h.lead_id then
      for r in select t.id, t.channel, t.platform, t.touch_type, t.campaign, t.utm, t.occurred_at from crm.lead_touchpoints t where t.lead_id = h.lead_id loop
        perform crm.record_touchpoint(p_organization_id, p_lead_id, r.channel, r.platform, r.touch_type, r.campaign, r.utm,
          'handoff:' || h.id::text || ':' || r.id::text, r.occurred_at, h.correlation_id);
      end loop;
      perform crm.record_touchpoint(p_organization_id, p_lead_id, 'whatsapp', null, 'handoff',
        jsonb_build_object('handoff_id', h.id, 'origin_lead_id', h.lead_id, 'from_channel', h.source_channel),
        '{}', 'handoff:' || h.id::text, now(), h.correlation_id);
      if h.contact_id is not null and p_contact_id is not null and h.contact_id <> p_contact_id then
        perform crm._open_duplicate_review(p_organization_id, h.contact_id, p_contact_id, 'handoff_claim',
          jsonb_build_object('handoff_id', h.id, 'origin_lead', h.lead_id, 'whatsapp_lead', p_lead_id));
      end if;
      perform crm.transfer_conversation_owner(p_organization_id, p_lead_id, (select o.owner from crm.lead_conversation_owner o where o.lead_id = p_lead_id),
        'sales', 'prospect moved to WhatsApp (tracked handoff, needs review)', 'handoff_consumed',
        jsonb_build_object('handoff_id', h.id, 'origin_lead', h.lead_id), h.correlation_id);
    end if;
    update crm.channel_handoffs set status = 'CONSUMED', consumed_at = now(), consumed_contact_id = p_contact_id,
           consumed_lead_id = p_lead_id, consume_outcome = 'linked_for_review' where id = h.id;
    v_result := 'linked_for_review';
  end if;

  perform core.record_audit(p_organization_id, 'handoff.consumed', 'lead', h.lead_id, null,
    jsonb_build_object('handoff_id', h.id, 'result', v_result, 'whatsapp_lead', p_lead_id), h.correlation_id);
  return query select v_result;
end;
$$;
revoke all on function crm.consume_channel_handoff(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function crm.consume_channel_handoff(uuid, uuid, uuid, uuid) to service_role;

-- ── 8. cancel (a person) and expire (the sweep) ────────────────────────────

create or replace function crm.cancel_channel_handoff(p_handoff_id uuid, p_reason text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  h crm.channel_handoffs;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  if v_reason is null then return query select 'needs_reason'::text; return; end if;
  select * into h from crm.channel_handoffs x where x.id = p_handoff_id and x.organization_id = v_org for update;
  if h.id is null then return query select 'not_found'::text; return; end if;
  if h.status not in ('CREATED', 'OPENED', 'RESOLVED') then return query select 'not_live'::text; return; end if;
  update crm.channel_handoffs set status = 'CANCELLED', cancel_reason = v_reason where id = h.id;
  perform core.record_audit(v_org, 'handoff.cancelled', 'lead', h.lead_id, jsonb_build_object('status', h.status), jsonb_build_object('reason', v_reason));
  return query select 'cancelled'::text;
end;
$$;
revoke all on function crm.cancel_channel_handoff(uuid, text) from public, anon;
grant execute on function crm.cancel_channel_handoff(uuid, text) to authenticated;

create or replace function crm.expire_channel_handoffs(p_limit integer default 200)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare n integer := 0; r record;
begin
  for r in select x.id, x.organization_id, x.lead_id from crm.channel_handoffs x
            where x.status in ('CREATED', 'OPENED') and x.expires_at < now()
            order by x.expires_at limit greatest(1, least(coalesce(p_limit, 200), 1000)) for update skip locked loop
    update crm.channel_handoffs set status = 'EXPIRED' where id = r.id;
    perform core.record_audit(r.organization_id, 'handoff.expired', 'lead', r.lead_id, null, jsonb_build_object('handoff_id', r.id));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function crm.expire_channel_handoffs(integer) from public, anon, authenticated;
grant execute on function crm.expire_channel_handoffs(integer) to service_role;

notify pgrst, 'reload schema';
