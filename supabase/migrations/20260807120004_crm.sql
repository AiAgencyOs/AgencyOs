-- ═══════════════════════════════════════════════════════════════════════════
-- 004 — crm: contacts, leads, activities
--
-- Backs Feature 4 (Lead CRM), Feature 6 (AI Requirement Collection), and
-- Feature 7 (WhatsApp Integration).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── contacts (a person; may or may not be attached to a client account) ───
create table if not exists crm.contacts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid references core.client_accounts(id) on delete set null,

  full_name          text not null check (length(trim(full_name)) > 0),
  email              text,
  phone              text,          -- E.164, e.g. +919876543210
  company            text,
  job_title          text,
  notes              text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- A contact must be reachable somehow, or it is not a contact.
  constraint contacts_reachable check (email is not null or phone is not null)
);

create index if not exists contacts_organization_idx on crm.contacts (organization_id);
create index if not exists contacts_account_idx
  on crm.contacts (client_account_id) where client_account_id is not null;

-- Dedupe within an organization, case-insensitively.
create unique index if not exists contacts_org_email_key
  on crm.contacts (organization_id, lower(email)) where email is not null;
create unique index if not exists contacts_org_phone_key
  on crm.contacts (organization_id, phone) where phone is not null;

-- ── leads ─────────────────────────────────────────────────────────────────
create table if not exists crm.leads (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  contact_id         uuid references crm.contacts(id) on delete set null,

  title              text not null check (length(trim(title)) > 0),
  summary            text,

  source             text not null default 'manual' check (source in
                       ('manual', 'whatsapp', 'web_form', 'email', 'referral', 'import')),
  -- Provider-side identifier (e.g. WhatsApp wa_id) for dedupe on ingest.
  source_ref         text,

  status             text not null default 'new' check (status in
                       ('new', 'qualifying', 'qualified', 'disqualified', 'converted')),

  -- Written by the Lead Qualifier agent (Feature 6). Null until it runs.
  score              smallint check (score between 0 and 100),
  score_reasons      jsonb,
  tags               text[] not null default '{}',

  assigned_to        uuid references core.users(id) on delete set null,

  -- Free-form requirements gathered by the AI agent / WhatsApp thread.
  requirements       jsonb not null default '{}'::jsonb,

  qualified_at       timestamptz,
  converted_at       timestamptz,
  disqualified_reason text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  -- Terminal states must record when they happened.
  constraint leads_qualified_at_set
    check (status <> 'qualified' or qualified_at is not null),
  constraint leads_converted_at_set
    check (status <> 'converted' or converted_at is not null)
);

create index if not exists leads_organization_status_idx
  on crm.leads (organization_id, status, created_at desc) where deleted_at is null;

create index if not exists leads_assigned_idx
  on crm.leads (organization_id, assigned_to) where deleted_at is null;

create index if not exists leads_contact_idx on crm.leads (contact_id);

create index if not exists leads_score_idx
  on crm.leads (organization_id, score desc nulls last) where deleted_at is null;

create index if not exists leads_tags_idx on crm.leads using gin (tags);

-- Ingest idempotency: one lead per provider reference per source.
create unique index if not exists leads_source_ref_key
  on crm.leads (organization_id, source, source_ref) where source_ref is not null;

comment on column crm.leads.requirements is
  'Structured requirements collected by the AI agent. Schema-on-read for now; promoted to columns once the shape settles.';

-- ── lead_activities (timeline: notes, messages, status changes) ───────────
create table if not exists crm.lead_activities (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  lead_id          uuid not null references crm.leads(id) on delete cascade,

  kind             text not null check (kind in
                     ('note', 'status_change', 'message_in', 'message_out',
                      'call', 'agent_run', 'assignment')),
  body             text,
  metadata         jsonb not null default '{}'::jsonb,

  actor_type       text not null default 'user' check (actor_type in ('user', 'agent', 'system', 'client')),
  actor_id         uuid,

  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index if not exists lead_activities_lead_idx
  on crm.lead_activities (lead_id, occurred_at desc);

create index if not exists lead_activities_organization_idx
  on crm.lead_activities (organization_id, occurred_at desc);

-- ── triggers ──────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['contacts','leads']
  loop
    execute format('drop trigger if exists set_updated_at on crm.%I', t);
    execute format(
      'create trigger set_updated_at before update on crm.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ── RLS: internal staff only. Leads are never client-visible. ─────────────
alter table crm.contacts        enable row level security;
alter table crm.leads           enable row level security;
alter table crm.lead_activities enable row level security;

drop policy if exists contacts_select on crm.contacts;
create policy contacts_select on crm.contacts
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists contacts_write on crm.contacts;
create policy contacts_write on crm.contacts
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop policy if exists leads_select on crm.leads;
create policy leads_select on crm.leads
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists leads_write on crm.leads;
create policy leads_write on crm.leads
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop policy if exists lead_activities_select on crm.lead_activities;
create policy lead_activities_select on crm.lead_activities
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists lead_activities_insert on crm.lead_activities;
create policy lead_activities_insert on crm.lead_activities
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write()));
