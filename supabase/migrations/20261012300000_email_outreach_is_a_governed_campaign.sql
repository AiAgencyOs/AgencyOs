-- ═══════════════════════════════════════════════════════
-- Email outreach is a governed campaign.
--
-- The owner set up info@ for lead generation and email marketing, and a transport lane for it
-- exists (PR #551), but nothing could send through it and nothing governed what would. This is
-- the governance, built BEFORE the sender so the sender has nowhere unsafe to go:
--
--   • PROSPECTS carry how the address was obtained and on what lawful basis it may be emailed.
--     ADM-70/81 say every client-facing send needs recorded consent on that channel and that an
--     agent may not bypass suppression. So the default basis is recorded EMAIL CONSENT; cold
--     business outreach ("b2b_legitimate_interest") exists as a basis but is OFF until the owner
--     switches it on, personally, in the outreach settings. Nothing here decides that for them.
--   • SUPPRESSION is permanent and checked at the one chokepoint: an unsubscribe, a hard bounce, a
--     complaint, a manual stop. A suppressed address can never be emailed again, by any campaign.
--   • EVERY send passes `claim_outreach_sends` - kill switch, campaign running, suppression, basis,
--     approved template, identity (sender name + postal address), daily cap with warm-up - and is
--     reserved before it is attempted, so a retried tick sends nothing twice.
--   • A campaign is approved by a SECOND person (the creator cannot approve their own), and approval
--     freezes the audience: the count the approver read is the count that goes.
--   • A run that bounces too much PAUSES ITSELF.
--
-- Nothing in this file sends an email. The worker does, through the chokepoint only.
-- ═══════════════════════════════════════════════════════

-- ── email is a consent channel ─────────────────────────────────────────────

alter table crm.communication_consent drop constraint if exists communication_consent_channel_check;
alter table crm.communication_consent add constraint communication_consent_channel_check check (channel in ('whatsapp', 'email'));

-- ── the outreach settings: who is writing, from where ───────────────────────

create table if not exists crm.outreach_settings (
  organization_id       uuid primary key references core.organizations(id) on delete cascade,
  sender_name           text check (sender_name is null or length(btrim(sender_name)) between 1 and 120),
  -- A commercial email must say who sends it and where they are. A send without both is refused.
  postal_address        text check (postal_address is null or length(btrim(postal_address)) between 8 and 400),
  reply_to              text check (reply_to is null or reply_to ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  -- The owner's personal switch. Off: only people with recorded email consent (or an existing relationship) are emailed.
  cold_basis_enabled    boolean not null default false,
  daily_cap             int not null default 20 check (daily_cap between 1 and 500),
  -- Auto-pause: the bounce rate over the last 7 days (at least 20 sends) at which a campaign stops itself.
  bounce_pause_percent  numeric(4, 1) not null default 5.0 check (bounce_pause_percent between 1 and 50),
  -- Warm-up starts at the first real send; a new mailbox that sends a burst is a spam source.
  first_send_on         date,
  updated_by            uuid references core.users(id),
  updated_at            timestamptz not null default now()
);

comment on table crm.outreach_settings is
  'One row per organisation: the sender identity every outreach email must carry, the daily cap (with warm-up), the auto-pause threshold, and the owner-only switch that allows cold business outreach.';

alter table crm.outreach_settings enable row level security;
alter table crm.outreach_settings force row level security;
drop policy if exists outreach_settings_select on crm.outreach_settings;
create policy outreach_settings_select on crm.outreach_settings
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.outreach_settings from public, anon, authenticated;
grant select on crm.outreach_settings to authenticated, service_role;
grant insert, update on crm.outreach_settings to service_role;

drop trigger if exists freeze_org_outreach_settings on crm.outreach_settings;
create trigger freeze_org_outreach_settings
  before update of organization_id on crm.outreach_settings
  for each row execute function core.freeze_organization_id();

create or replace function crm.set_outreach_settings(
  p_sender_name text,
  p_postal_address text,
  p_reply_to text,
  p_daily_cap int,
  p_bounce_pause_percent numeric,
  p_cold_basis_enabled boolean default null
)
returns table (outcome text)
-- 'saved' | 'no_actor' | 'forbidden' | 'owner_only' | 'invalid'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_old   crm.outreach_settings;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  -- The lawful-basis switch is the owner's alone: it is a legal position, not a preference.
  if p_cold_basis_enabled is not null and not coalesce((select core.is_owner()), false) then
    return query select 'owner_only'::text; return;
  end if;
  if p_daily_cap is null or p_daily_cap < 1 or p_daily_cap > 500
     or p_bounce_pause_percent is null or p_bounce_pause_percent < 1 or p_bounce_pause_percent > 50 then
    return query select 'invalid'::text; return;
  end if;

  select * into v_old from crm.outreach_settings where organization_id = v_org;
  insert into crm.outreach_settings (organization_id, sender_name, postal_address, reply_to, daily_cap, bounce_pause_percent, cold_basis_enabled, updated_by, updated_at)
  values (v_org, nullif(btrim(coalesce(p_sender_name, '')), ''), nullif(btrim(coalesce(p_postal_address, '')), ''), nullif(btrim(coalesce(p_reply_to, '')), ''),
          p_daily_cap, p_bounce_pause_percent, coalesce(p_cold_basis_enabled, false), v_actor, now())
  on conflict (organization_id) do update
     set sender_name = excluded.sender_name,
         postal_address = excluded.postal_address,
         reply_to = excluded.reply_to,
         daily_cap = excluded.daily_cap,
         bounce_pause_percent = excluded.bounce_pause_percent,
         cold_basis_enabled = case when p_cold_basis_enabled is null then crm.outreach_settings.cold_basis_enabled else p_cold_basis_enabled end,
         updated_by = v_actor,
         updated_at = now();

  perform core.record_audit(v_org, 'outreach.settings_changed', 'outreach_settings', null,
    jsonb_build_object('daily_cap', v_old.daily_cap, 'cold_basis_enabled', v_old.cold_basis_enabled),
    jsonb_build_object('daily_cap', p_daily_cap, 'cold_basis_enabled', coalesce(p_cold_basis_enabled, v_old.cold_basis_enabled, false)));
  return query select 'saved'::text;
end;
$$;
revoke all on function crm.set_outreach_settings(text, text, text, int, numeric, boolean) from public, anon;
grant execute on function crm.set_outreach_settings(text, text, text, int, numeric, boolean) to authenticated;

-- ── suppression: permanent, one address, one reason ──────────────────────────

create table if not exists crm.email_suppressions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  email            text not null check (email = lower(email) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  reason           text not null check (reason in ('unsubscribed', 'hard_bounce', 'complaint', 'manual', 'erasure')),
  source           text not null check (length(btrim(source)) between 1 and 300),
  note             text check (note is null or length(note) <= 500),
  created_by       uuid references core.users(id),
  created_at       timestamptz not null default now(),
  unique (organization_id, email)
);

comment on table crm.email_suppressions is
  'Addresses no campaign may ever email again (ADM-70: an agent may not bypass suppression). Never edited, never removed: lifting a suppression is a person re-consenting, recorded as new consent, not a delete.';

create or replace function crm.suppression_is_permanent()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'a suppression is permanent: it cannot be edited or removed' using errcode = 'P0001';
end;
$$;
drop trigger if exists suppression_is_permanent on crm.email_suppressions;
create trigger suppression_is_permanent
  before update or delete on crm.email_suppressions
  for each row execute function crm.suppression_is_permanent();

-- (updates are refused outright above; the tenancy scanner still wants the freeze on every org-scoped table)
drop trigger if exists freeze_org_email_suppressions on crm.email_suppressions;
create trigger freeze_org_email_suppressions
  before update of organization_id on crm.email_suppressions
  for each row execute function core.freeze_organization_id();

alter table crm.email_suppressions enable row level security;
alter table crm.email_suppressions force row level security;
drop policy if exists email_suppressions_select on crm.email_suppressions;
create policy email_suppressions_select on crm.email_suppressions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.email_suppressions from public, anon, authenticated;
grant select on crm.email_suppressions to authenticated, service_role;
grant insert on crm.email_suppressions to service_role;

-- ── prospects: how we got the address, and on what basis it may be emailed ───

create table if not exists crm.outreach_prospects (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  email            text not null check (email = lower(email) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  full_name        text check (full_name is null or length(btrim(full_name)) between 1 and 160),
  company          text check (company is null or length(btrim(company)) between 1 and 160),
  job_title        text check (job_title is null or length(btrim(job_title)) between 1 and 160),
  website          text check (website is null or length(website) <= 300),
  language         text not null default 'en' check (language in ('en', 'hinglish', 'hindi')),
  tags             text[] not null default '{}',
  -- How the address was obtained. Required: an address nobody can account for is not emailed.
  provenance       text not null check (length(btrim(provenance)) between 3 and 300),
  lawful_basis     text not null check (lawful_basis in ('consent', 'existing_relationship', 'b2b_legitimate_interest')),
  contact_id       uuid references crm.contacts(id) on delete set null,
  lead_id          uuid references crm.leads(id) on delete set null,
  status           text not null default 'new' check (status in ('new', 'contacted', 'replied', 'converted', 'do_not_contact')),
  created_by       uuid references core.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, email),
  -- Consent and an existing relationship are about a PERSON the system already knows.
  constraint outreach_prospect_basis_needs_contact
    check (lawful_basis = 'b2b_legitimate_interest' or contact_id is not null)
);

comment on table crm.outreach_prospects is
  'People who may be emailed by an outreach campaign, each with the provenance of the address and the lawful basis. consent / existing_relationship need a known contact (and, for consent, a granted email consent row at send time); b2b_legitimate_interest sends only if the owner has switched it on.';

create index if not exists outreach_prospects_status_idx on crm.outreach_prospects (organization_id, status);

drop trigger if exists org_match_outreach_prospect_contact on crm.outreach_prospects;
create trigger org_match_outreach_prospect_contact
  before insert or update of contact_id, organization_id on crm.outreach_prospects
  for each row execute function core.enforce_parent_org('contact_id', 'crm.contacts');
drop trigger if exists org_match_outreach_prospect_lead on crm.outreach_prospects;
create trigger org_match_outreach_prospect_lead
  before insert or update of lead_id, organization_id on crm.outreach_prospects
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');
drop trigger if exists freeze_org_outreach_prospect on crm.outreach_prospects;
create trigger freeze_org_outreach_prospect
  before update of organization_id on crm.outreach_prospects
  for each row execute function core.freeze_organization_id();
drop trigger if exists outreach_prospect_updated_at on crm.outreach_prospects;
create trigger outreach_prospect_updated_at
  before update on crm.outreach_prospects
  for each row execute function core.set_updated_at();

alter table crm.outreach_prospects enable row level security;
alter table crm.outreach_prospects force row level security;
drop policy if exists outreach_prospects_select on crm.outreach_prospects;
create policy outreach_prospects_select on crm.outreach_prospects
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.outreach_prospects from public, anon, authenticated;
grant select on crm.outreach_prospects to authenticated, service_role;
grant insert, update on crm.outreach_prospects to service_role;

-- ── templates: approved wording, with a price-free, provider-free body ──────

create table if not exists crm.email_templates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 120),
  language         text not null default 'en' check (language in ('en', 'hinglish', 'hindi')),
  subject          text not null check (length(btrim(subject)) between 3 and 200),
  body             text not null check (length(btrim(body)) between 20 and 5000),
  status           text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  created_by       uuid references core.users(id),
  approved_by      uuid references core.users(id),
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint email_template_approval_is_recorded check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);

create or replace function crm.enforce_email_template()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_text text := lower(new.subject || ' ' || new.body);
begin
  -- ADM-22 / business rules 08 s5.1: no outbound text states a price. Outreach is the place that would be tempting.
  if v_text ~ '(₹|\yrs\.?\s*[0-9]|\yinr\s*[0-9]|\$\s*[0-9]|[0-9]\s*(lakh|lac|crore)\y|\y(discount|free of charge|guarantee[ds]?)\y)' then
    raise exception 'an outreach email may not state a price, a discount or a guarantee' using errcode = 'check_violation';
  end if;
  -- Never name the machinery.
  if v_text ~ '\y(openai|anthropic|gpt|claude|gemini|llm|chatgpt|ai-generated|prompt)\y' then
    raise exception 'an outreach email may not mention internal AI tooling' using errcode = 'check_violation';
  end if;
  -- Only the placeholders the renderer fills; anything else would reach a stranger as literal text.
  if exists (select 1 from regexp_matches(new.subject || ' ' || new.body, '\{\{([a-z_]+)\}\}', 'g') m where m[1] not in ('first_name', 'company', 'sender_name')) then
    raise exception 'an outreach email may only use {{first_name}}, {{company}} or {{sender_name}}' using errcode = 'check_violation';
  end if;
  -- The system appends the identity, the address and the unsubscribe line. A template that fakes its own is refused.
  if v_text ~ '(unsubscribe|opt[- ]out|manage preferences)' then
    raise exception 'write the message only; the unsubscribe line and the sender identity are added by the system' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' and (new.subject is distinct from old.subject or new.body is distinct from old.body or new.language is distinct from old.language) then
    raise exception 'an approved template is not edited; retire it and write a new one' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_email_template on crm.email_templates;
create trigger enforce_email_template
  before insert or update on crm.email_templates
  for each row execute function crm.enforce_email_template();
drop trigger if exists freeze_org_email_templates on crm.email_templates;
create trigger freeze_org_email_templates
  before update of organization_id on crm.email_templates
  for each row execute function core.freeze_organization_id();

alter table crm.email_templates enable row level security;
alter table crm.email_templates force row level security;
drop policy if exists email_templates_select on crm.email_templates;
create policy email_templates_select on crm.email_templates
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.email_templates from public, anon, authenticated;
grant select on crm.email_templates to authenticated, service_role;
grant insert, update on crm.email_templates to service_role;

-- ── campaigns, steps, recipients, sends ───────────────────────────────────────

create table if not exists crm.email_campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 1 and 120),
  -- Which prospects: tags (any), languages, and a hard ceiling. Read at APPROVAL and frozen into the recipients.
  audience         jsonb not null default '{}'::jsonb,
  status           text not null default 'draft' check (status in ('draft', 'approved', 'running', 'paused', 'done', 'cancelled')),
  recipient_count  int,
  paused_reason    text check (paused_reason is null or length(paused_reason) <= 500),
  created_by       uuid not null references core.users(id),
  approved_by      uuid references core.users(id),
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Four eyes: the person who wrote it does not release it.
  constraint email_campaign_four_eyes check (approved_by is null or approved_by <> created_by),
  constraint email_campaign_approval_is_dated check ((approved_by is null) = (approved_at is null))
);
drop trigger if exists freeze_org_email_campaigns on crm.email_campaigns;
create trigger freeze_org_email_campaigns
  before update of organization_id on crm.email_campaigns
  for each row execute function core.freeze_organization_id();
drop trigger if exists email_campaigns_updated_at on crm.email_campaigns;
create trigger email_campaigns_updated_at before update on crm.email_campaigns for each row execute function core.set_updated_at();

create table if not exists crm.email_campaign_steps (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  campaign_id      uuid not null references crm.email_campaigns(id) on delete cascade,
  step_number      int not null check (step_number between 1 and 3),
  template_id      uuid not null references crm.email_templates(id),
  -- Days after the PREVIOUS step. Step 1 sends at once (0); a follow-up waits.
  delay_days       int not null check (delay_days between 0 and 30),
  unique (campaign_id, step_number),
  constraint email_step_first_is_immediate check (step_number > 1 or delay_days = 0)
);
create trigger org_match_email_step_campaign before insert or update of campaign_id, organization_id on crm.email_campaign_steps
  for each row execute function core.enforce_parent_org('campaign_id', 'crm.email_campaigns');
create trigger org_match_email_step_template before insert or update of template_id, organization_id on crm.email_campaign_steps
  for each row execute function core.enforce_parent_org('template_id', 'crm.email_templates');
create trigger freeze_org_email_steps before update of organization_id on crm.email_campaign_steps
  for each row execute function core.freeze_organization_id();

create table if not exists crm.email_campaign_recipients (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  campaign_id      uuid not null references crm.email_campaigns(id) on delete cascade,
  prospect_id      uuid not null references crm.outreach_prospects(id),
  email            text not null,
  step_number      int not null default 1 check (step_number between 1 and 4),
  status           text not null default 'pending' check (status in ('pending', 'done', 'refused', 'bounced', 'unsubscribed', 'replied', 'failed')),
  refusal_reason   text check (refusal_reason is null or refusal_reason in (
                     'suppressed', 'no_basis', 'no_consent', 'prospect_stopped', 'template_not_approved', 'identity_missing')),
  next_send_at     timestamptz not null default now(),
  last_error       text check (last_error is null or length(last_error) <= 500),
  attempts         int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (campaign_id, prospect_id),
  constraint email_recipient_refusal_has_reason check ((status = 'refused') = (refusal_reason is not null))
);
create index if not exists email_recipients_due_idx on crm.email_campaign_recipients (campaign_id, next_send_at) where status = 'pending';
create trigger org_match_email_recipient_campaign before insert or update of campaign_id, organization_id on crm.email_campaign_recipients
  for each row execute function core.enforce_parent_org('campaign_id', 'crm.email_campaigns');
create trigger org_match_email_recipient_prospect before insert or update of prospect_id, organization_id on crm.email_campaign_recipients
  for each row execute function core.enforce_parent_org('prospect_id', 'crm.outreach_prospects');
create trigger freeze_org_email_recipients before update of organization_id on crm.email_campaign_recipients
  for each row execute function core.freeze_organization_id();
create trigger email_recipients_updated_at before update on crm.email_campaign_recipients for each row execute function core.set_updated_at();

-- THE IDEMPOTENCY KEY: one send per recipient per step, reserved BEFORE it is attempted.
create table if not exists crm.email_outreach_sends (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  campaign_id      uuid not null references crm.email_campaigns(id) on delete cascade,
  recipient_id     uuid not null references crm.email_campaign_recipients(id),
  step_number      int not null,
  email            text not null,
  status           text not null default 'reserved' check (status in ('reserved', 'sent', 'failed', 'bounced')),
  message_ref      text,
  error            text check (error is null or length(error) <= 500),
  reserved_at      timestamptz not null default now(),
  sent_at          timestamptz,
  unique (recipient_id, step_number)
);
create index if not exists email_sends_day_idx on crm.email_outreach_sends (organization_id, reserved_at);
create trigger org_match_email_send_campaign before insert or update of campaign_id, organization_id on crm.email_outreach_sends
  for each row execute function core.enforce_parent_org('campaign_id', 'crm.email_campaigns');
create trigger org_match_email_send_recipient before insert or update of recipient_id, organization_id on crm.email_outreach_sends
  for each row execute function core.enforce_parent_org('recipient_id', 'crm.email_campaign_recipients');
create trigger freeze_org_email_sends before update of organization_id on crm.email_outreach_sends
  for each row execute function core.freeze_organization_id();

alter table crm.email_campaigns enable row level security;
alter table crm.email_campaigns force row level security;
drop policy if exists email_campaigns_select on crm.email_campaigns;
create policy email_campaigns_select on crm.email_campaigns
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.email_campaigns from public, anon, authenticated;
grant select on crm.email_campaigns to authenticated, service_role;
grant insert, update on crm.email_campaigns to service_role;

alter table crm.email_campaign_steps enable row level security;
alter table crm.email_campaign_steps force row level security;
drop policy if exists email_campaign_steps_select on crm.email_campaign_steps;
create policy email_campaign_steps_select on crm.email_campaign_steps
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.email_campaign_steps from public, anon, authenticated;
grant select on crm.email_campaign_steps to authenticated, service_role;
grant insert, update on crm.email_campaign_steps to service_role;

alter table crm.email_campaign_recipients enable row level security;
alter table crm.email_campaign_recipients force row level security;
drop policy if exists email_campaign_recipients_select on crm.email_campaign_recipients;
create policy email_campaign_recipients_select on crm.email_campaign_recipients
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.email_campaign_recipients from public, anon, authenticated;
grant select on crm.email_campaign_recipients to authenticated, service_role;
grant insert, update on crm.email_campaign_recipients to service_role;

alter table crm.email_outreach_sends enable row level security;
alter table crm.email_outreach_sends force row level security;
drop policy if exists email_outreach_sends_select on crm.email_outreach_sends;
create policy email_outreach_sends_select on crm.email_outreach_sends
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.email_outreach_sends from public, anon, authenticated;
grant select on crm.email_outreach_sends to authenticated, service_role;
grant insert, update on crm.email_outreach_sends to service_role;

insert into core.event_types (type, description, canonical) values
  ('outreach.email_sent', 'An outreach email left the info@ mailbox for one prospect.', false),
  ('outreach.campaign_paused', 'An outreach campaign stopped itself (bounce rate) or was stopped by a person.', false),
  ('outreach.unsubscribed', 'A recipient unsubscribed; the address is suppressed for good.', false)
on conflict (type) do nothing;
