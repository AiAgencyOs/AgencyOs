-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 2 — one person, one identity, across every channel.
--
-- Spec §7, §40, §41, §64, §78. A person reached by email, then on LinkedIn,
-- then in WhatsApp must remain ONE durable CRM identity with all three in its
-- history; two agents must never negotiate with the same lead; and the first
-- source must survive every later one.
--
-- What the audit found: identity was PHONE-keyed (WhatsApp ingest and the
-- import matcher); email matched only by a manual check; no social handle, no
-- domain, no B2B id, no review queue; attribution was the first Click-to-
-- WhatsApp ad only; and "who is talking to this lead" was a person, not a
-- channel owner.
--
-- Five decisions, each argued:
--
--  1. STRONG KEYS MAP TO ONE PERSON; WEAK SIGNALS ONLY SUGGEST. An exact
--     normalised email, phone, LinkedIn, Instagram, Facebook or B2B id is the
--     same person (crm.identity_keys, unique per organisation). A shared
--     company domain or a similar name is NOT — thousands of people share
--     gmail.com or work at one company — so those signals can only open a
--     DUPLICATE REVIEW, never merge and never block the inbound message.
--     "Never auto-merge uncertain identities" (spec §7) is therefore not a
--     policy a caller must remember: there is no merge in this file.
--
--  2. A KEY CLAIMED BY TWO PEOPLE IS A REVIEW, NOT A WINNER. If a second
--     contact turns up holding a key another contact already owns, the key
--     stays with its owner and a review is opened for the pair. Last-write-wins
--     would silently re-point a person's history.
--
--  3. THE SYNC IS A TRIGGER, SO EVERY EXISTING DOOR IS COVERED. WhatsApp
--     ingest, import commit, outreach conversion and a person typing a contact
--     all insert into crm.contacts. Rather than re-emit each of those large
--     functions, an AFTER trigger keys the contact; a failure there is audited
--     and swallowed, because losing an inbound message to a bookkeeping error
--     is the worse outcome. (The swallow writes an audit row — it is visible.)
--
--  4. ATTRIBUTION IS AN APPEND-ONLY LOG. crm.lead_touchpoints is never updated
--     or deleted, so first touch cannot be overwritten by a later channel —
--     it is simply the earliest row. Last touch is the latest. Every lead gets
--     a touchpoint when it is created, and a Click-to-WhatsApp ad becomes the
--     (earlier) first touch, so existing data is backfilled, idempotently.
--
--  5. THE LIFECYCLE IS NOT DUPLICATED. WON/LOST/NURTURE/DISQUALIFIED already
--     exist, split across crm.leads.status and sales.opportunities.stage.
--     crm.lead_outcome() DERIVES the canonical word from them. A second stored
--     outcome would be a second source of truth and the first thing it would do
--     is disagree.
--
-- Not built here, stated rather than discovered: consolidating two contacts an
-- admin has judged to be the same person (confirmed_same). Eleven tables point
-- at crm.contacts; a generic re-point would be a migration of its own and is
-- the wrong thing to do in the same change as the detection. The decision is
-- recorded; the consolidation is a tracked follow-up.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. normalisers (pure; one place for the rules) ─────────────────────────

create or replace function crm.norm_email(p text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case when lower(btrim(coalesce(p, ''))) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then lower(btrim(p)) end;
$$;

-- Mirrors src/lib/import/phone.ts: only a written '+' carries a country, and a
-- country is never guessed - guessing would be inventing phone ownership.
create or replace function crm.norm_phone(p text)
returns text language sql immutable parallel safe set search_path = '' as $$
  with s as (
    select regexp_replace(coalesce(p, ''), '[\u200e\u200f\u202a-\u202e\s()\-.\u2013\u2014/]', '', 'g') as c
  )
  select case
    when c like '+%' and length(regexp_replace(c, '\D', '', 'g')) between 8 and 15
      then '+' || regexp_replace(c, '\D', '', 'g')
  end from s;
$$;

-- A company domain, from an address, a URL or a bare domain. A free-mail domain
-- is NOT a company signal, so it normalises to null.
create or replace function crm.norm_domain(p text)
returns text language plpgsql immutable parallel safe set search_path = '' as $$
declare v text := lower(btrim(coalesce(p, '')));
begin
  if v = '' then return null; end if;
  v := regexp_replace(v, '^[a-z][a-z0-9+.-]*://', '');
  v := regexp_replace(v, '^.*@', '');
  v := regexp_replace(v, '[/?#:].*$', '');
  v := regexp_replace(v, '^www\.', '');
  if v !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then return null; end if;
  if v in ('gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com',
           'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'zoho.com', 'gmx.com') then
    return null;
  end if;
  return v;
end;
$$;

create or replace function crm.norm_social(p_kind text, p text)
returns text language plpgsql immutable parallel safe set search_path = '' as $$
declare v text := lower(btrim(coalesce(p, '')));
begin
  if v = '' then return null; end if;
  v := regexp_replace(v, '^[a-z][a-z0-9+.-]*://', '');
  if p_kind = 'linkedin' then
    v := regexp_replace(v, '^(www\.|[a-z]{2}\.)?linkedin\.com/', '');
    if v ~ '^(in|company)/[^/?#]+' then
      return regexp_replace(v, '^((in|company)/[^/?#]+).*$', '\1');
    end if;
    if v ~ '^[a-z0-9-]{3,100}$' then return 'in/' || v; end if;
    return null;
  elsif p_kind = 'instagram' then
    v := regexp_replace(v, '^(www\.)?instagram\.com/', '');
    v := regexp_replace(v, '^@', '');
    v := regexp_replace(v, '[/?#].*$', '');
    if v ~ '^[a-z0-9._]{1,30}$' then return v; end if;
    return null;
  elsif p_kind = 'facebook' then
    v := regexp_replace(v, '^(www\.|m\.|web\.)?(facebook|fb)\.com/', '');
    if v ~ '^profile\.php\?id=[0-9]+' then return 'id/' || regexp_replace(v, '^profile\.php\?id=([0-9]+).*$', '\1'); end if;
    v := regexp_replace(v, '[/?#].*$', '');
    if v ~ '^[a-z0-9.]{5,50}$' then return v; end if;
    return null;
  elsif p_kind = 'b2b' then
    if v ~ '^[a-z_]{2,30}:[a-z0-9_.-]{1,100}$' then return v; end if;
    return null;
  end if;
  return null;
end;
$$;

-- ── 1b. a person known only through a social or marketplace channel ────────
--
-- crm.contacts has required "email or phone" since the first CRM migration: a
-- contact is someone we know how to reach. A prospect found on LinkedIn, or on a
-- marketplace, is reachable THERE and has neither yet - and those are exactly the
-- people the spec wants to follow into WhatsApp later (§78). The rule is extended,
-- not weakened: a third way to be reachable, `reachable_via`, set only by
-- crm.resolve_identity when it creates a contact from a social/B2B key alone.
alter table crm.contacts add column if not exists reachable_via text
  check (reachable_via is null or reachable_via in ('linkedin', 'instagram', 'facebook', 'b2b'));
alter table crm.contacts drop constraint if exists contacts_reachable;
alter table crm.contacts add constraint contacts_reachable
  check (email is not null or phone is not null or reachable_via is not null);
comment on column crm.contacts.reachable_via is
  'The social or marketplace channel a contact is reachable through when it has no email or phone yet (set by crm.resolve_identity only). Cleared in meaning, not in value, once an email or phone is learned.';

-- ── 2. identity keys ───────────────────────────────────────────────────────

create table if not exists crm.identity_keys (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  kind             text not null check (kind in ('email', 'phone', 'linkedin', 'instagram', 'facebook', 'b2b')),
  value            text not null check (length(value) between 3 and 200),
  contact_id       uuid not null references crm.contacts(id) on delete cascade,
  source           text check (source is null or length(source) <= 60),
  created_at       timestamptz not null default now(),
  unique (organization_id, kind, value)
);
create index if not exists identity_keys_contact_idx on crm.identity_keys (contact_id);

comment on table crm.identity_keys is
  'Strong identity keys: an exact normalised email, phone, LinkedIn, Instagram, Facebook or B2B id belongs to ONE person (unique per organisation). Weak signals (company domain, a similar name) are deliberately not here - they only ever open a duplicate review.';

-- ── 3. duplicate review ────────────────────────────────────────────────────

create table if not exists crm.duplicate_reviews (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  contact_a        uuid not null references crm.contacts(id) on delete cascade,
  contact_b        uuid not null references crm.contacts(id) on delete cascade,
  reason           text not null check (reason in ('shared_key', 'name_and_domain', 'name_and_company')),
  signals          jsonb not null default '{}'::jsonb check (jsonb_typeof(signals) = 'object'),
  status           text not null default 'open' check (status in ('open', 'confirmed_same', 'kept_separate', 'dismissed')),
  decided_by       uuid references core.users(id) on delete set null,
  decided_at       timestamptz,
  decision_note    text check (decision_note is null or length(decision_note) <= 1000),
  created_at       timestamptz not null default now(),
  -- One row per unordered pair, ever: a pair an admin has decided is never re-opened by a later suggestion.
  constraint duplicate_reviews_ordered check (contact_a < contact_b),
  unique (organization_id, contact_a, contact_b),
  constraint duplicate_reviews_decided_says_who check (status = 'open' or (decided_at is not null))
);
create index if not exists duplicate_reviews_open_idx on crm.duplicate_reviews (organization_id, created_at desc) where status = 'open';

comment on table crm.duplicate_reviews is
  'A suspected duplicate, for a person to decide (spec §7). Opened by crm.resolve_identity or by a key collision; never decided by a machine. confirmed_same records the judgement; consolidating the two contacts is a separate, deliberate step that is NOT automated here.';

-- ── 4. touchpoints: attribution as an append-only log ──────────────────────

create table if not exists crm.lead_touchpoints (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  lead_id          uuid not null references crm.leads(id) on delete cascade,
  channel          text not null check (channel in ('meta_ads', 'email', 'social', 'google_ads', 'b2b', 'whatsapp', 'web_form', 'referral', 'import', 'manual')),
  platform         text check (platform is null or length(platform) between 2 and 40),
  touch_type       text not null check (touch_type in ('lead_created', 'discovered', 'outreach_sent', 'reply_received', 'inbound_message', 'ad_click', 'content_interaction', 'profile_inquiry', 'handoff', 'meeting', 'quotation')),
  campaign         jsonb not null default '{}'::jsonb check (jsonb_typeof(campaign) = 'object'),
  utm              jsonb not null default '{}'::jsonb check (jsonb_typeof(utm) = 'object'),
  external_ref     text check (external_ref is null or length(external_ref) between 1 and 200),
  occurred_at      timestamptz not null default now(),
  -- clock_timestamp, not now(): rows recorded in one transaction must still have an order (first/last touch tie-break).
  recorded_at      timestamptz not null default clock_timestamp(),
  correlation_id   uuid
);
create unique index if not exists lead_touchpoints_external_key
  on crm.lead_touchpoints (organization_id, channel, external_ref) where external_ref is not null;
create index if not exists lead_touchpoints_lead_idx on crm.lead_touchpoints (lead_id, occurred_at, id);
create index if not exists lead_touchpoints_org_channel_idx on crm.lead_touchpoints (organization_id, channel, occurred_at desc);

comment on table crm.lead_touchpoints is
  'Every way a lead has touched or been touched by the agency, append-only (spec §64). First touch is the earliest row and cannot be overwritten by a later channel; last touch is the latest. external_ref makes recording idempotent per channel.';

create or replace function crm.touchpoints_are_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'a touchpoint is history; record a new one instead' using errcode = '42501';
end;
$$;
drop trigger if exists lead_touchpoints_immutable on crm.lead_touchpoints;
create trigger lead_touchpoints_immutable
  before update or delete on crm.lead_touchpoints
  for each row execute function crm.touchpoints_are_history();

-- ── 5. who owns the conversation ───────────────────────────────────────────

create table if not exists crm.lead_conversation_owner (
  lead_id          uuid primary key references crm.leads(id) on delete cascade,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  owner            text not null check (owner in ('email_outreach', 'social_media', 'b2b_opportunity', 'sales', 'human')),
  version          integer not null default 1 check (version >= 1),
  since            timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table crm.lead_conversation_owner is
  'Exactly one owner per lead (spec §40): the agent that may negotiate. Scheduler and Quotation Master are deliberately NOT owners - they own only their subtask and control returns to this owner.';

create table if not exists crm.conversation_owner_transfers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  lead_id          uuid not null references crm.leads(id) on delete cascade,
  from_owner       text,
  to_owner         text not null,
  reason           text not null check (length(btrim(reason)) between 3 and 500),
  workflow_state   text check (workflow_state is null or length(workflow_state) <= 80),
  context          jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  actor_id         uuid references core.users(id) on delete set null,
  correlation_id   uuid,
  created_at       timestamptz not null default clock_timestamp()
);
create index if not exists conversation_owner_transfers_lead_idx on crm.conversation_owner_transfers (lead_id, created_at);

drop trigger if exists conversation_owner_transfers_immutable on crm.conversation_owner_transfers;
create trigger conversation_owner_transfers_immutable
  before update or delete on crm.conversation_owner_transfers
  for each row execute function crm.touchpoints_are_history();

-- ── tenancy: freeze + parent-org guard per FK + RLS, written out per table ──

drop trigger if exists freeze_org_identity_keys on crm.identity_keys;
create trigger freeze_org_identity_keys before update of organization_id on crm.identity_keys
  for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_identity_keys_contact on crm.identity_keys;
create trigger org_match_identity_keys_contact before insert or update of contact_id, organization_id on crm.identity_keys
  for each row execute function core.enforce_parent_org('contact_id', 'crm.contacts');
alter table crm.identity_keys enable row level security;
alter table crm.identity_keys force row level security;
drop policy if exists identity_keys_select on crm.identity_keys;
create policy identity_keys_select on crm.identity_keys for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
-- The platform's default privileges would otherwise hand anon SELECT and authenticated INSERT/UPDATE/DELETE on a new table;
-- RLS would still refuse the rows, but a grant that is wider than the intent is the first thing a policy mistake exposes.
revoke all on table crm.identity_keys from public, anon, authenticated;
grant select on crm.identity_keys to authenticated;
grant select, insert, update, delete on crm.identity_keys to service_role;

drop trigger if exists freeze_org_duplicate_reviews on crm.duplicate_reviews;
create trigger freeze_org_duplicate_reviews before update of organization_id on crm.duplicate_reviews
  for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_duplicate_reviews_a on crm.duplicate_reviews;
create trigger org_match_duplicate_reviews_a before insert or update of contact_a, organization_id on crm.duplicate_reviews
  for each row execute function core.enforce_parent_org('contact_a', 'crm.contacts');
drop trigger if exists org_match_duplicate_reviews_b on crm.duplicate_reviews;
create trigger org_match_duplicate_reviews_b before insert or update of contact_b, organization_id on crm.duplicate_reviews
  for each row execute function core.enforce_parent_org('contact_b', 'crm.contacts');
alter table crm.duplicate_reviews enable row level security;
alter table crm.duplicate_reviews force row level security;
drop policy if exists duplicate_reviews_select on crm.duplicate_reviews;
create policy duplicate_reviews_select on crm.duplicate_reviews for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
-- The platform's default privileges would otherwise hand anon SELECT and authenticated INSERT/UPDATE/DELETE on a new table;
-- RLS would still refuse the rows, but a grant that is wider than the intent is the first thing a policy mistake exposes.
revoke all on table crm.duplicate_reviews from public, anon, authenticated;
grant select on crm.duplicate_reviews to authenticated;
grant select, insert, update on crm.duplicate_reviews to service_role;

drop trigger if exists freeze_org_lead_touchpoints on crm.lead_touchpoints;
create trigger freeze_org_lead_touchpoints before update of organization_id on crm.lead_touchpoints
  for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_lead_touchpoints_lead on crm.lead_touchpoints;
create trigger org_match_lead_touchpoints_lead before insert or update of lead_id, organization_id on crm.lead_touchpoints
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');
alter table crm.lead_touchpoints enable row level security;
alter table crm.lead_touchpoints force row level security;
drop policy if exists lead_touchpoints_select on crm.lead_touchpoints;
create policy lead_touchpoints_select on crm.lead_touchpoints for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
-- The platform's default privileges would otherwise hand anon SELECT and authenticated INSERT/UPDATE/DELETE on a new table;
-- RLS would still refuse the rows, but a grant that is wider than the intent is the first thing a policy mistake exposes.
revoke all on table crm.lead_touchpoints from public, anon, authenticated;
grant select on crm.lead_touchpoints to authenticated;
grant select, insert on crm.lead_touchpoints to service_role;

drop trigger if exists freeze_org_lead_conversation_owner on crm.lead_conversation_owner;
create trigger freeze_org_lead_conversation_owner before update of organization_id on crm.lead_conversation_owner
  for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_lead_conversation_owner_lead on crm.lead_conversation_owner;
create trigger org_match_lead_conversation_owner_lead before insert or update of lead_id, organization_id on crm.lead_conversation_owner
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');
alter table crm.lead_conversation_owner enable row level security;
alter table crm.lead_conversation_owner force row level security;
drop policy if exists lead_conversation_owner_select on crm.lead_conversation_owner;
create policy lead_conversation_owner_select on crm.lead_conversation_owner for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
-- The platform's default privileges would otherwise hand anon SELECT and authenticated INSERT/UPDATE/DELETE on a new table;
-- RLS would still refuse the rows, but a grant that is wider than the intent is the first thing a policy mistake exposes.
revoke all on table crm.lead_conversation_owner from public, anon, authenticated;
grant select on crm.lead_conversation_owner to authenticated;
grant select, insert, update on crm.lead_conversation_owner to service_role;

drop trigger if exists freeze_org_conversation_owner_transfers on crm.conversation_owner_transfers;
create trigger freeze_org_conversation_owner_transfers before update of organization_id on crm.conversation_owner_transfers
  for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_conversation_owner_transfers_lead on crm.conversation_owner_transfers;
create trigger org_match_conversation_owner_transfers_lead before insert or update of lead_id, organization_id on crm.conversation_owner_transfers
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');
alter table crm.conversation_owner_transfers enable row level security;
alter table crm.conversation_owner_transfers force row level security;
drop policy if exists conversation_owner_transfers_select on crm.conversation_owner_transfers;
create policy conversation_owner_transfers_select on crm.conversation_owner_transfers for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
-- The platform's default privileges would otherwise hand anon SELECT and authenticated INSERT/UPDATE/DELETE on a new table;
-- RLS would still refuse the rows, but a grant that is wider than the intent is the first thing a policy mistake exposes.
revoke all on table crm.conversation_owner_transfers from public, anon, authenticated;
grant select on crm.conversation_owner_transfers to authenticated;
grant select, insert on crm.conversation_owner_transfers to service_role;

-- ── 6. helpers (internal: no caller but the doors below) ───────────────────

create or replace function crm._open_duplicate_review(p_org uuid, p_x uuid, p_y uuid, p_reason text, p_signals jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_a uuid := least(p_x, p_y);
  v_b uuid := greatest(p_x, p_y);
  v_id uuid;
begin
  if p_x = p_y then return null; end if;
  insert into crm.duplicate_reviews (organization_id, contact_a, contact_b, reason, signals)
  values (p_org, v_a, v_b, p_reason, coalesce(p_signals, '{}'::jsonb))
  on conflict (organization_id, contact_a, contact_b) do nothing
  returning id into v_id;
  if v_id is null then
    select r.id into v_id from crm.duplicate_reviews r where r.organization_id = p_org and r.contact_a = v_a and r.contact_b = v_b;
  else
    perform core.record_audit(p_org, 'identity.duplicate_review_opened', 'duplicate_review', v_id, null,
      jsonb_build_object('reason', p_reason, 'contact_a', v_a, 'contact_b', v_b));
  end if;
  return v_id;
end;
$$;
revoke all on function crm._open_duplicate_review(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;

-- Attach keys to a contact. A key owned by ANOTHER contact stays with its owner
-- and opens a review. Returns how many were attached and how many collided.
create or replace function crm._attach_identity_keys(p_org uuid, p_contact uuid, p_kinds text[], p_values text[], p_source text)
returns table (attached int, collided int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  i int;
  v_owner uuid;
  v_att int := 0;
  v_col int := 0;
begin
  for i in 1 .. coalesce(array_length(p_kinds, 1), 0) loop
    insert into crm.identity_keys (organization_id, kind, value, contact_id, source)
    values (p_org, p_kinds[i], p_values[i], p_contact, p_source)
    on conflict (organization_id, kind, value) do nothing;
    select k.contact_id into v_owner from crm.identity_keys k
     where k.organization_id = p_org and k.kind = p_kinds[i] and k.value = p_values[i];
    if v_owner = p_contact then
      v_att := v_att + 1;
    else
      v_col := v_col + 1;
      perform crm._open_duplicate_review(p_org, p_contact, v_owner, 'shared_key', jsonb_build_object('kind', p_kinds[i], 'value', p_values[i]));
    end if;
  end loop;
  return query select v_att, v_col;
end;
$$;
revoke all on function crm._attach_identity_keys(uuid, uuid, text[], text[], text) from public, anon, authenticated;

-- ── 7. the contact trigger: every existing door is keyed, none re-emitted ──

create or replace function crm.key_a_contact()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_kinds text[] := '{}';
  v_vals  text[] := '{}';
  v_email text := crm.norm_email(new.email);
  v_phone text := crm.norm_phone(new.phone);
begin
  if v_email is not null then v_kinds := array_append(v_kinds, 'email'::text); v_vals := array_append(v_vals, v_email::text); end if;
  if v_phone is not null then v_kinds := array_append(v_kinds, 'phone'::text); v_vals := array_append(v_vals, v_phone::text); end if;
  if array_length(v_kinds, 1) is null then return new; end if;
  perform crm._attach_identity_keys(new.organization_id, new.id, v_kinds, v_vals, 'contact');
  return new;
exception when others then
  -- Never lose a contact (an inbound message rides on it) to bookkeeping. The failure is audited, not hidden.
  begin
    perform core.record_audit(new.organization_id, 'identity.key_sync_failed', 'contact', new.id, null, jsonb_build_object('error', sqlerrm));
  exception when others then null;
  end;
  return new;
end;
$$;
revoke all on function crm.key_a_contact() from public, anon, authenticated;

drop trigger if exists key_a_contact on crm.contacts;
create trigger key_a_contact
  after insert or update of email, phone on crm.contacts
  for each row execute function crm.key_a_contact();

-- ── 8. resolve_identity: the one door every engine and webhook asks ────────

create or replace function crm.resolve_identity(p_organization_id uuid, p_signals jsonb, p_source text default null)
returns table (outcome text, contact_id uuid, review_id uuid, created boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_kinds  text[] := '{}';
  v_vals   text[] := '{}';
  v_email  text;
  v_phone  text;
  v_name   text := nullif(btrim(coalesce(p_signals ->> 'name', '')), '');
  v_company text := nullif(btrim(coalesce(p_signals ->> 'company', '')), '');
  v_domain text;
  v_k      text;
  v_n      text;
  i        int;
  v_ids    uuid[];
  v_one    uuid;
  v_review uuid;
  v_new    uuid;
  r        record;
begin
  -- A signed-in session may only resolve inside its own organisation; the service role (no auth.uid()) is the engines.
  if (select auth.uid()) is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid, null::uuid, false; return;
  end if;
  if p_signals is null or jsonb_typeof(p_signals) <> 'object' or p_organization_id is null then
    return query select 'invalid'::text, null::uuid, null::uuid, false; return;
  end if;

  v_email := crm.norm_email(p_signals ->> 'email');
  v_phone := crm.norm_phone(p_signals ->> 'phone');
  if v_email is not null then v_kinds := array_append(v_kinds, 'email'::text); v_vals := array_append(v_vals, v_email::text); end if;
  if v_phone is not null then v_kinds := array_append(v_kinds, 'phone'::text); v_vals := array_append(v_vals, v_phone::text); end if;
  foreach v_k in array array['linkedin', 'instagram', 'facebook', 'b2b'] loop
    v_n := crm.norm_social(v_k, p_signals ->> v_k);
    if v_n is not null then v_kinds := array_append(v_kinds, v_k::text); v_vals := array_append(v_vals, v_n::text); end if;
  end loop;
  v_domain := coalesce(crm.norm_domain(p_signals ->> 'email'), crm.norm_domain(p_signals ->> 'website'));

  if array_length(v_kinds, 1) is null then
    return query select 'no_signals'::text, null::uuid, null::uuid, false; return;
  end if;

  -- Serialise two resolutions that share a key, in a fixed order so they cannot deadlock.
  for r in select distinct (a.k || ':' || a.v) as lk from unnest(v_kinds, v_vals) as a(k, v) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || r.lk, 0));
  end loop;

  -- Candidates: the registry first, then contacts that predate it.
  select coalesce(array_agg(distinct c), '{}') into v_ids from (
    select k.contact_id as c from crm.identity_keys k
      join unnest(v_kinds, v_vals) as a(k2, v2) on a.k2 = k.kind and a.v2 = k.value
     where k.organization_id = p_organization_id
    union
    select ct.id from crm.contacts ct where ct.organization_id = p_organization_id and v_email is not null and crm.norm_email(ct.email) = v_email
    union
    select ct.id from crm.contacts ct where ct.organization_id = p_organization_id and v_phone is not null and crm.norm_phone(ct.phone) = v_phone
  ) q;

  if array_length(v_ids, 1) = 1 then
    v_one := v_ids[1];
    perform crm._attach_identity_keys(p_organization_id, v_one, v_kinds, v_vals, p_source);
    -- Fill a contact's EMPTY columns from what is now known, so the doors that find a person by contacts.phone
    -- (WhatsApp ingest) or contacts.email land on this same person. Only ever null -> value, one column at a time:
    -- a column another contact already holds is simply skipped (the key collision above already opened a review).
    begin update crm.contacts set phone = v_phone where id = v_one and organization_id = p_organization_id and phone is null and v_phone is not null;
    exception when unique_violation then null; end;
    begin update crm.contacts set email = v_email where id = v_one and organization_id = p_organization_id and email is null and v_email is not null;
    exception when unique_violation then null; end;
    update crm.contacts set company = v_company where id = v_one and organization_id = p_organization_id and company is null and v_company is not null;
    perform core.record_audit(p_organization_id, 'identity.matched', 'contact', v_one, null,
      jsonb_build_object('source', p_source, 'kinds', v_kinds));
    return query select 'matched'::text, v_one, null::uuid, false; return;
  end if;

  if array_length(v_ids, 1) > 1 then
    -- Different people hold different keys of this one signal set. Nothing is attached and nothing is merged.
    select c.id into v_one from crm.contacts c where c.id = any (v_ids) order by c.created_at, c.id limit 1;
    for r in select unnest(v_ids) as other loop
      if r.other <> v_one then
        v_review := crm._open_duplicate_review(p_organization_id, v_one, r.other, 'shared_key',
          jsonb_build_object('kinds', v_kinds, 'source', p_source));
      end if;
    end loop;
    return query select 'conflict'::text, v_one, v_review, false; return;
  end if;

  -- No strong match: this is a new person. The inbound is never held up by a suspicion.
  insert into crm.contacts (organization_id, full_name, email, phone, company, reachable_via)
  values (p_organization_id,
          coalesce(v_name, nullif(split_part(coalesce(v_email, ''), '@', 1), ''), v_phone, v_vals[1]),
          v_email, v_phone, v_company,
          case when v_email is null and v_phone is null
               then (select a.k from unnest(v_kinds) as a(k) where a.k in ('linkedin', 'instagram', 'facebook', 'b2b') limit 1) end)
  returning id into v_new;
  perform crm._attach_identity_keys(p_organization_id, v_new, v_kinds, v_vals, p_source);

  -- Weak signals only SUGGEST: same name and same company domain / company name.
  if v_name is not null then
    for r in
      select c.id from crm.contacts c
       where c.organization_id = p_organization_id and c.id <> v_new and lower(btrim(c.full_name)) = lower(v_name)
         and ((v_domain is not null and crm.norm_domain(c.email) = v_domain)
              or (v_company is not null and lower(btrim(coalesce(c.company, ''))) = lower(v_company)))
       limit 5
    loop
      v_review := crm._open_duplicate_review(p_organization_id, v_new, r.id,
        case when v_domain is not null then 'name_and_domain' else 'name_and_company' end,
        jsonb_build_object('name', v_name, 'domain', v_domain, 'company', v_company, 'source', p_source));
    end loop;
  end if;

  perform core.record_audit(p_organization_id, 'identity.created', 'contact', v_new, null,
    jsonb_build_object('source', p_source, 'kinds', v_kinds, 'review_opened', v_review is not null));
  return query select case when v_review is null then 'created' else 'created_pending_review' end::text, v_new, v_review, true;
end;
$$;
revoke all on function crm.resolve_identity(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function crm.resolve_identity(uuid, jsonb, text) to service_role;

-- A person decides a suspected duplicate. Nothing here merges anything.
create or replace function crm.decide_duplicate_review(p_review uuid, p_decision text, p_note text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_before jsonb;
  v_after jsonb;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  if p_decision is null or p_decision not in ('confirmed_same', 'kept_separate', 'dismissed') then
    return query select 'invalid'::text; return;
  end if;
  if p_decision <> 'dismissed' and v_note is null then return query select 'needs_note'::text; return; end if;

  select to_jsonb(r.*) into v_before from crm.duplicate_reviews r where r.id = p_review and r.organization_id = v_org for update;
  if v_before is null then return query select 'not_found'::text; return; end if;
  if v_before ->> 'status' <> 'open' then return query select 'already_decided'::text; return; end if;

  update crm.duplicate_reviews
     set status = p_decision, decided_by = v_actor, decided_at = now(), decision_note = v_note
   where id = p_review and organization_id = v_org
  returning to_jsonb(crm.duplicate_reviews.*) into v_after;

  perform core.record_audit(v_org, 'identity.duplicate_review_' || p_decision, 'duplicate_review', p_review, v_before, v_after);
  return query select 'decided'::text;
end;
$$;
revoke all on function crm.decide_duplicate_review(uuid, text, text) from public, anon;
grant execute on function crm.decide_duplicate_review(uuid, text, text) to authenticated;

-- ── 9. touchpoints: recording, and first / last touch ──────────────────────

create or replace function crm.record_touchpoint(
  p_organization_id uuid, p_lead uuid, p_channel text, p_platform text, p_touch_type text,
  p_campaign jsonb default '{}', p_utm jsonb default '{}', p_external_ref text default null,
  p_occurred_at timestamptz default null, p_correlation_id uuid default null
)
returns table (outcome text, touchpoint_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if (select auth.uid()) is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if not exists (select 1 from crm.leads l where l.id = p_lead and l.organization_id = p_organization_id) then
    return query select 'unknown_lead'::text, null::uuid; return;
  end if;
  begin
    insert into crm.lead_touchpoints (organization_id, lead_id, channel, platform, touch_type, campaign, utm, external_ref, occurred_at, correlation_id)
    values (p_organization_id, p_lead, p_channel, nullif(btrim(coalesce(p_platform, '')), ''), p_touch_type,
            coalesce(p_campaign, '{}'), coalesce(p_utm, '{}'), nullif(btrim(coalesce(p_external_ref, '')), ''),
            coalesce(p_occurred_at, now()), p_correlation_id)
    returning id into v_id;
  exception
    when unique_violation then
      select t.id into v_id from crm.lead_touchpoints t
       where t.organization_id = p_organization_id and t.channel = p_channel and t.external_ref = p_external_ref;
      return query select 'duplicate'::text, v_id; return;
    when check_violation or invalid_text_representation then
      return query select 'invalid'::text, null::uuid; return;
  end;
  return query select 'recorded'::text, v_id;
end;
$$;
revoke all on function crm.record_touchpoint(uuid, uuid, text, text, text, jsonb, jsonb, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function crm.record_touchpoint(uuid, uuid, text, text, text, jsonb, jsonb, text, timestamptz, uuid) to service_role;

-- First and last touch, derived - never stored, so it cannot be overwritten.
create or replace function crm.lead_attribution(p_lead uuid)
returns table (
  first_channel text, first_platform text, first_at timestamptz, first_campaign jsonb,
  last_channel text, last_platform text, last_at timestamptz, last_campaign jsonb,
  touch_count bigint, channels text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  with t as (select * from crm.lead_touchpoints where lead_id = p_lead),
       f as (select * from t order by occurred_at, recorded_at, id limit 1),
       l as (select * from t order by occurred_at desc, recorded_at desc, id desc limit 1)
  select f.channel, f.platform, f.occurred_at, f.campaign,
         l.channel, l.platform, l.occurred_at, l.campaign,
         (select count(*) from t),
         (select coalesce(array_agg(distinct channel order by channel), '{}') from t)
    from f, l;
$$;
grant execute on function crm.lead_attribution(uuid) to authenticated, service_role;

-- Every lead gets a first touch the moment it exists; a Click-to-WhatsApp ad is the earlier touch it really was.
create or replace function crm.touch_a_new_lead()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_channel text;
begin
  v_channel := case new.source when 'whatsapp' then 'whatsapp' when 'web_form' then 'web_form' when 'email' then 'email'
                               when 'referral' then 'referral' when 'import' then 'import' else 'manual' end;
  if tg_op = 'INSERT' then
    insert into crm.lead_touchpoints (organization_id, lead_id, channel, touch_type, external_ref, occurred_at)
    values (new.organization_id, new.id, v_channel, 'lead_created', 'lead:' || new.id::text, new.created_at)
    on conflict do nothing;
  end if;
  if new.campaign_source_id is not null then
    insert into crm.lead_touchpoints (organization_id, lead_id, channel, platform, touch_type, campaign, external_ref, occurred_at)
    values (new.organization_id, new.id, 'meta_ads', 'facebook', 'ad_click',
            jsonb_strip_nulls(jsonb_build_object('source_type', new.campaign_source_type, 'ad_id', new.campaign_source_id,
                                                 'url', new.campaign_source_url, 'headline', new.campaign_headline)),
            'lead-ad:' || new.id::text, new.created_at - interval '1 second')
    on conflict do nothing;
  end if;
  return new;
exception when others then
  begin
    perform core.record_audit(new.organization_id, 'identity.touch_failed', 'lead', new.id, null, jsonb_build_object('error', sqlerrm));
  exception when others then null;
  end;
  return new;
end;
$$;
revoke all on function crm.touch_a_new_lead() from public, anon, authenticated;
drop trigger if exists touch_a_new_lead on crm.leads;
create trigger touch_a_new_lead
  after insert or update of campaign_source_id on crm.leads
  for each row execute function crm.touch_a_new_lead();

-- ── 10. conversation owner transfer, with optimistic concurrency ───────────

create or replace function crm.transfer_conversation_owner(
  p_organization_id uuid, p_lead uuid, p_expected_from text, p_to text, p_reason text,
  p_workflow_state text default null, p_context jsonb default '{}', p_correlation_id uuid default null
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_cur    crm.lead_conversation_owner;
  v_outcome text;
begin
  if v_actor is not null then
    if p_organization_id is distinct from (select core.current_organization_id()) then return query select 'forbidden'::text; return; end if;
    if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  end if;
  if p_to is null or p_to not in ('email_outreach', 'social_media', 'b2b_opportunity', 'sales', 'human')
     or (p_expected_from is not null and p_expected_from not in ('email_outreach', 'social_media', 'b2b_opportunity', 'sales', 'human'))
     or v_reason is null or length(v_reason) < 3 then
    return query select 'invalid'::text; return;
  end if;
  if not exists (select 1 from crm.leads l where l.id = p_lead and l.organization_id = p_organization_id) then
    return query select 'unknown_lead'::text; return;
  end if;

  -- The lead row is the lock: two agents racing for one lead queue here, and the loser sees the new owner.
  perform 1 from crm.leads l where l.id = p_lead and l.organization_id = p_organization_id for update;
  select * into v_cur from crm.lead_conversation_owner o where o.lead_id = p_lead;

  v_outcome := crm.lead_outcome(p_lead);
  if v_outcome in ('WON', 'LOST', 'DISQUALIFIED') then return query select 'closed'::text; return; end if;

  if v_cur.lead_id is null then
    if p_expected_from is not null then return query select 'stale'::text; return; end if;
    insert into crm.lead_conversation_owner (lead_id, organization_id, owner) values (p_lead, p_organization_id, p_to);
  else
    if p_expected_from is distinct from v_cur.owner then return query select 'stale'::text; return; end if;
    if v_cur.owner = p_to then return query select 'unchanged'::text; return; end if;
    update crm.lead_conversation_owner set owner = p_to, version = version + 1, since = now(), updated_at = now() where lead_id = p_lead;
  end if;

  insert into crm.conversation_owner_transfers (organization_id, lead_id, from_owner, to_owner, reason, workflow_state, context, actor_id, correlation_id)
  values (p_organization_id, p_lead, v_cur.owner, p_to, v_reason, p_workflow_state, coalesce(p_context, '{}'), v_actor, p_correlation_id);
  perform core.record_audit(p_organization_id, 'identity.conversation_owner_transferred', 'lead', p_lead,
    jsonb_build_object('owner', v_cur.owner), jsonb_build_object('owner', p_to, 'reason', v_reason), p_correlation_id);
  return query select 'transferred'::text;
end;
$$;
revoke all on function crm.transfer_conversation_owner(uuid, uuid, text, text, text, text, jsonb, uuid) from public, anon;
grant execute on function crm.transfer_conversation_owner(uuid, uuid, text, text, text, text, jsonb, uuid) to authenticated, service_role;

-- ── 11. the canonical outcome, derived ─────────────────────────────────────

create or replace function crm.lead_outcome(p_lead uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- WON / LOST / DISQUALIFIED / NURTURE / OPEN, from the two places the existing lifecycle already keeps them. Not stored.
  select case
    when l.status = 'converted' or o.stage = 'won' then 'WON'
    when o.stage = 'lost' then 'LOST'
    when l.status = 'disqualified' then 'DISQUALIFIED'
    when l.status = 'nurture' then 'NURTURE'
    else 'OPEN'
  end
  from crm.leads l
  left join lateral (
    select op.stage from sales.opportunities op where op.lead_id = l.id order by op.created_at desc, op.id desc limit 1
  ) o on true
  where l.id = p_lead
    -- A session may only ask about its own organisation; the service role (no auth.uid()) is the engines.
    and ((select auth.uid()) is null or l.organization_id = (select core.current_organization_id()));
$$;
revoke all on function crm.lead_outcome(uuid) from public, anon;
grant execute on function crm.lead_outcome(uuid) to authenticated, service_role;

-- ── 12. backfill (idempotent) ──────────────────────────────────────────────

do $$
declare c record;
begin
  for c in select id, organization_id, email, phone from crm.contacts loop
    perform crm._attach_identity_keys(
      c.organization_id, c.id,
      array_remove(array[case when crm.norm_email(c.email) is not null then 'email' end, case when crm.norm_phone(c.phone) is not null then 'phone' end], null),
      array_remove(array[crm.norm_email(c.email), crm.norm_phone(c.phone)], null),
      'backfill');
  end loop;
end $$;

insert into crm.lead_touchpoints (organization_id, lead_id, channel, touch_type, external_ref, occurred_at)
select l.organization_id, l.id,
       case l.source when 'whatsapp' then 'whatsapp' when 'web_form' then 'web_form' when 'email' then 'email'
                     when 'referral' then 'referral' when 'import' then 'import' else 'manual' end,
       'lead_created', 'lead:' || l.id::text, l.created_at
  from crm.leads l
on conflict do nothing;

insert into crm.lead_touchpoints (organization_id, lead_id, channel, platform, touch_type, campaign, external_ref, occurred_at)
select l.organization_id, l.id, 'meta_ads', 'facebook', 'ad_click',
       jsonb_strip_nulls(jsonb_build_object('source_type', l.campaign_source_type, 'ad_id', l.campaign_source_id,
                                            'url', l.campaign_source_url, 'headline', l.campaign_headline)),
       'lead-ad:' || l.id::text, l.created_at - interval '1 second'
  from crm.leads l
 where l.campaign_source_id is not null
on conflict do nothing;

notify pgrst, 'reload schema';
