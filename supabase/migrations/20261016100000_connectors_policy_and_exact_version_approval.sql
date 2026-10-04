-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 4 — connectors that are honest about what they are,
-- one policy question, and approvals that bind to the exact thing approved.
--
-- Spec §8, §45-§47, §55-§57, §98, §169, §50, §54. Three gaps the audit found:
--
--  * NO PER-TENANT CREDENTIAL STORE. The vault (core.secret_credentials) has no
--    organization_id: one slot per deployment. That is right for the agency's
--    own keys and wrong for provider connections that belong to an
--    organisation. Connector credentials get their own table, encrypted in the
--    application with the organisation, the integration and the secret's name
--    bound in as authenticated data - a ciphertext copied to another tenant's
--    row does not decrypt. The database never sees a plaintext and an admin
--    session cannot read even the ciphertext.
--
--  * NO UNIFIED POLICY DECISION. Governance was five mechanisms (autonomy,
--    tool permission, approval policy, kill switches, per-action limits) and no
--    function that composes them. crm.acquisition_decide returns the four
--    canonical answers - AUTO_APPROVE / ADMIN_APPROVAL_REQUIRED / BLOCK /
--    ESCALATE - and says why, and logs the decision. Its defaults fail SAFE:
--    an action with no policy needs approval, an unknown action is blocked,
--    and the actions the spec makes mandatory (publish, submit a proposal,
--    launch a campaign, deploy a page, update a profile) can never be set to
--    auto - by a CHECK, not by a screen.
--
--  * APPROVAL BOUND TO A ROW, NOT TO THE CONTENT. The approval engine binds to
--    (subject_type, subject_id) and snapshots a payload; nothing says "this
--    SHA-256 of this content". crm.approval_bindings records the exact hash
--    and a validity window, crm.approval_check answers "does THIS approval
--    cover THIS content NOW", and crm.begin_governed_execution is the one door a
--    side effect passes through: it re-reads the pause state, re-checks the
--    approval (never trusting what was true when the job was queued) and
--    reserves ONE execution per approval, so a replayed job cannot publish
--    twice. APPROVED, EXECUTED and VERIFIED are separate rows, as the spec
--    insists. An execution whose outcome is uncertain is `unknown` and is
--    RECONCILED, never blindly retried.
--
-- The registry is also honest about itself: a provider with no adapter is
-- NOT_IMPLEMENTED, and only the door an adapter's real result passes through
-- can ever move a connection to a verified state - a trigger refuses any other
-- write. Entering a credential for a provider nothing can use yet does not make
-- it look connected.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. vocabulary (functions, so SQL and TS name the same things once) ─────

create or replace function crm.provider_type(p text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case
    when p in ('meta_ads', 'google_ads') then 'ads'
    when p in ('facebook_page', 'instagram', 'linkedin') then 'social'
    when p = 'email_provider' then 'email'
    when p = 'hostinger' then 'deployment'
    when p = 'whatsapp' then 'messaging'
    when p = 'calendar' then 'calendar'
    when p in ('upwork', 'freelancer', 'peopleperhour', 'guru', 'contra', 'fiverr') then 'marketplace'
    when p in ('clutch', 'goodfirms') then 'directory'
    when p = 'other' then 'other'
  end;
$$;

-- Which action belongs to which engine. Commercial actions (discount, offer, payment terms) have no channel.
create or replace function crm.action_channel(p_action text, p_channel text default null)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_action in ('email_outreach', 'email_followup') then 'email'
    when p_action in ('social_publish', 'social_outreach', 'social_followup') then 'social'
    when p_action in ('b2b_proposal_submit', 'b2b_outreach', 'profile_update') then 'b2b'
    when p_action in ('ad_launch', 'ad_budget_increase', 'ad_targeting_change') and p_channel in ('meta_ads', 'google_ads') then p_channel
    when p_action = 'landing_page_deploy' then 'google_ads'
    when p_action in ('discount', 'special_offer', 'payment_terms', 'high_volume_messaging') then 'none'
  end;
$$;

-- The connector an action cannot run without. Email goes through the existing governed info@ lane, not this registry.
create or replace function crm.required_providers(p_action text, p_channel text)
returns text[] language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_action = 'landing_page_deploy' then array['hostinger']
    when p_channel = 'meta_ads' then array['meta_ads']
    when p_channel = 'google_ads' then array['google_ads']
    when p_channel = 'social' then array['linkedin', 'instagram', 'facebook_page']
    when p_channel = 'b2b' and p_action = 'profile_update' then array['clutch', 'goodfirms', 'fiverr', 'upwork', 'freelancer', 'peopleperhour', 'guru', 'contra']
    when p_channel = 'b2b' then array['upwork', 'freelancer', 'peopleperhour', 'guru', 'contra', 'fiverr']
    else array[]::text[]
  end;
$$;

-- ── 2. the integration registry ────────────────────────────────────────────

create table if not exists crm.acquisition_integrations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  provider         text not null check (crm.provider_type(provider) is not null),
  integration_type text generated always as (crm.provider_type(provider)) stored,
  environment      text not null default 'production' check (environment in ('development', 'staging', 'production')),
  label            text not null default 'default' check (length(btrim(label)) between 1 and 60),
  status           text not null default 'UNCONFIGURED' check (status in ('UNCONFIGURED', 'CONFIGURED', 'CONNECTING', 'ACTIVE', 'DEGRADED', 'DISABLED', 'REVOKED')),
  verification     text not null default 'NOT_IMPLEMENTED' check (verification in
    ('NOT_IMPLEMENTED', 'IMPLEMENTED_NOT_CONFIGURED', 'CONFIGURED_NOT_VERIFIED', 'SANDBOX_VERIFIED', 'LIVE_VERIFIED', 'DEGRADED', 'BLOCKED_BY_CREDENTIAL', 'BLOCKED_BY_PROVIDER', 'DISABLED')),
  adapter_implemented boolean not null default false,
  account_ref      text check (account_ref is null or length(account_ref) <= 80),
  api_version      text check (api_version is null or length(api_version) <= 40),
  capabilities     jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  webhook          jsonb not null default '{}'::jsonb check (jsonb_typeof(webhook) = 'object'),
  rate_limit       jsonb not null default '{}'::jsonb check (jsonb_typeof(rate_limit) = 'object'),
  health           text check (health is null or length(health) <= 200),
  last_checked_at  timestamptz,
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  last_error_class text check (last_error_class is null or last_error_class in ('transient', 'permanent', 'conditional', 'security')),
  last_error       text check (last_error is null or length(last_error) <= 300),
  status_reason    text check (status_reason is null or length(status_reason) <= 500),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, provider, environment, label)
);
create index if not exists acquisition_integrations_org_idx on crm.acquisition_integrations (organization_id, provider);

comment on table crm.acquisition_integrations is
  'One row per provider connection (spec §55). status is the lifecycle; verification is what has actually been PROVEN (spec §98) and can only be moved by the doors an adapter result passes through - a trigger refuses any other write, so an unverified connection can never look verified. capabilities maps each provider capability to AUTOMATED / ASSISTED / MANUAL / UNAVAILABLE / DEGRADED (spec §56).';

create or replace function crm.integration_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The registry's truth columns move only through the doors, which raise the flag for the statement.
  if coalesce(current_setting('crm.integration_write', true), '') <> '1' then
    if new.status is distinct from old.status or new.verification is distinct from old.verification
       or new.adapter_implemented is distinct from old.adapter_implemented or new.capabilities is distinct from old.capabilities
       or new.account_ref is distinct from old.account_ref or new.last_success_at is distinct from old.last_success_at
       or new.last_failure_at is distinct from old.last_failure_at or new.last_error_class is distinct from old.last_error_class then
      raise exception 'an integration''s status and verification are set by the registry doors only' using errcode = '42501';
    end if;
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'UNCONFIGURED' and new.status in ('CONFIGURED', 'DISABLED', 'REVOKED'))
    or (old.status = 'CONFIGURED'   and new.status in ('CONNECTING', 'ACTIVE', 'DEGRADED', 'DISABLED', 'REVOKED'))
    or (old.status = 'CONNECTING'   and new.status in ('CONFIGURED', 'ACTIVE', 'DEGRADED', 'DISABLED', 'REVOKED'))
    or (old.status = 'ACTIVE'       and new.status in ('CONNECTING', 'DEGRADED', 'DISABLED', 'REVOKED'))
    or (old.status = 'DEGRADED'     and new.status in ('CONNECTING', 'ACTIVE', 'CONFIGURED', 'DISABLED', 'REVOKED'))
    or (old.status = 'DISABLED'     and new.status in ('CONFIGURED', 'UNCONFIGURED', 'REVOKED'))) then
    raise exception 'an integration cannot go from % to %', old.status, new.status using errcode = '23514';
  end if;
  if new.organization_id is distinct from old.organization_id or new.provider is distinct from old.provider or new.environment is distinct from old.environment then
    raise exception 'an integration''s organisation, provider and environment are fixed' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists integration_write_guard on crm.acquisition_integrations;
create trigger integration_write_guard before update on crm.acquisition_integrations
  for each row execute function crm.integration_write_guard();

-- ── 3. tenant-scoped credentials ───────────────────────────────────────────

create table if not exists crm.connector_credentials (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  integration_id   uuid not null references crm.acquisition_integrations(id) on delete cascade,
  name             text not null check (name ~ '^[a-z][a-z0-9_]{1,40}$'),
  ciphertext       text not null check (length(ciphertext) between 1 and 20000),
  iv               text not null check (length(iv) between 8 and 64),
  auth_tag         text not null check (length(auth_tag) between 8 and 64),
  hint             text check (hint is null or length(hint) <= 4),
  expires_on       date,
  status           text not null default 'active' check (status in ('active', 'revoked')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  rotated_at       timestamptz,
  revoked_at       timestamptz
);
create unique index if not exists connector_credentials_one_active on crm.connector_credentials (integration_id, name) where status = 'active';
comment on table crm.connector_credentials is
  'A provider credential belonging to ONE organisation''s integration. AES-256-GCM in application code with (organisation, integration, name) bound in as authenticated data, so a ciphertext moved to another row does not decrypt. A session cannot read the ciphertext, iv or tag - only the service role, to build an outbound client. A rotation revokes the old row and adds a new one; nothing is overwritten.';

-- ── 4. policy, usage, decisions ────────────────────────────────────────────

create table if not exists crm.acquisition_policies (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  action_type         text not null check (action_type in (
    'email_outreach', 'email_followup', 'social_publish', 'social_outreach', 'social_followup', 'b2b_proposal_submit', 'b2b_outreach',
    'ad_launch', 'ad_budget_increase', 'ad_targeting_change', 'landing_page_deploy', 'profile_update', 'discount', 'special_offer',
    'payment_terms', 'high_volume_messaging')),
  mode                text not null check (mode in ('auto', 'approval', 'block')),
  approval_above_minor bigint check (approval_above_minor is null or approval_above_minor >= 0),
  escalate_above_minor bigint check (escalate_above_minor is null or escalate_above_minor >= 0),
  updated_by          uuid references core.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  unique (organization_id, action_type),
  -- The gates the spec makes mandatory are not a preference. No screen, door or service can set them to auto.
  constraint acquisition_policies_hard_gates check (mode <> 'auto' or action_type not in
    ('social_publish', 'b2b_proposal_submit', 'ad_launch', 'landing_page_deploy', 'profile_update'))
);
comment on table crm.acquisition_policies is
  'What the Admin has decided for each action type (spec §45). No row = ADMIN_APPROVAL_REQUIRED. Loosening to auto is owner-only; the five mandatory gates cannot be auto at all.';

create table if not exists crm.acquisition_usage (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  channel          text not null check (channel in ('meta_ads', 'email', 'social', 'google_ads', 'b2b')),
  metric           text not null check (metric in ('action', 'spend_minor', 'connect')),
  amount           bigint not null check (amount >= 0),
  ref              text check (ref is null or length(ref) between 1 and 200),
  occurred_at      timestamptz not null default clock_timestamp(),
  correlation_id   uuid
);
create unique index if not exists acquisition_usage_ref_key on crm.acquisition_usage (organization_id, channel, metric, ref) where ref is not null;
create index if not exists acquisition_usage_window_idx on crm.acquisition_usage (organization_id, channel, metric, occurred_at desc);
comment on table crm.acquisition_usage is
  'Append-only ledger of what each channel has consumed (actions, spend in minor units, B2B connects). The decision function reads it; ref makes recording idempotent. Days and months are UTC.';

create table if not exists crm.acquisition_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  action_type      text not null,
  channel          text,
  amount_minor     bigint,
  decision         text not null check (decision in ('AUTO_APPROVE', 'ADMIN_APPROVAL_REQUIRED', 'BLOCK', 'ESCALATE')),
  reason           text not null,
  policy_version   text,
  correlation_id   uuid,
  created_at       timestamptz not null default clock_timestamp()
);
create index if not exists acquisition_decisions_org_idx on crm.acquisition_decisions (organization_id, created_at desc);

-- ── 5. exact-version approvals and the one-execution door ──────────────────

create table if not exists crm.approval_bindings (
  approval_request_id uuid primary key references approvals.approval_requests(id) on delete restrict,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  artifact_type    text not null check (artifact_type in ('social_content', 'b2b_proposal', 'ad_campaign', 'acquisition_action')),
  artifact_id      uuid not null,
  version          integer not null check (version >= 1),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  valid_until      timestamptz not null,
  created_at       timestamptz not null default now()
);
create index if not exists approval_bindings_artifact_idx on crm.approval_bindings (organization_id, artifact_type, artifact_id);
comment on table crm.approval_bindings is
  'The exact content an approval covers (spec §46): a SHA-256 of the artifact version and a validity window. Append-only. crm.approval_check compares what is about to be executed with this, now - a cached "it was approved" is never trusted.';

create table if not exists crm.governed_executions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  approval_request_id uuid not null references approvals.approval_requests(id) on delete restrict,
  artifact_type    text not null,
  artifact_id      uuid not null,
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  action_type      text not null,
  channel          text,
  status           text not null default 'executing' check (status in ('executing', 'executed', 'verified', 'failed', 'unknown')),
  attempt          integer not null default 1 check (attempt between 1 and 3),
  external_ref     text check (external_ref is null or length(external_ref) <= 300),
  evidence         jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 20000),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  verified_at      timestamptz,
  correlation_id   uuid,
  -- ONE execution per approval: a replayed job, a duplicate event or a crashed-and-retried worker meets this row.
  unique (approval_request_id)
);
create index if not exists governed_executions_org_idx on crm.governed_executions (organization_id, status, started_at desc);
comment on table crm.governed_executions is
  'The execution of an approved action (spec §46: APPROVED, EXECUTED and VERIFIED are different things). One row per approval, so the action cannot happen twice. unknown = the outcome is uncertain and must be RECONCILED against the provider, never blindly retried (spec §54).';

-- ── tenancy, privileges, RLS: written out per table ────────────────────────

create or replace function crm.history_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'this record is history; add a new one instead' using errcode = '42501';
end;
$$;
drop trigger if exists acquisition_usage_immutable on crm.acquisition_usage;
create trigger acquisition_usage_immutable before update or delete on crm.acquisition_usage for each row execute function crm.history_only();
drop trigger if exists acquisition_decisions_immutable on crm.acquisition_decisions;
create trigger acquisition_decisions_immutable before update or delete on crm.acquisition_decisions for each row execute function crm.history_only();
drop trigger if exists approval_bindings_immutable on crm.approval_bindings;
create trigger approval_bindings_immutable before update or delete on crm.approval_bindings for each row execute function crm.history_only();

create or replace function crm.governed_execution_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'an execution is history' using errcode = '42501'; end if;
  if (new.approval_request_id, new.organization_id, new.artifact_type, new.artifact_id, new.content_hash, new.action_type, new.channel)
     is distinct from (old.approval_request_id, old.organization_id, old.artifact_type, old.artifact_id, old.content_hash, old.action_type, old.channel) then
    raise exception 'what was executed is fixed' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'executing' and new.status in ('executed', 'failed', 'unknown'))
    or (old.status = 'unknown'   and new.status in ('executed', 'failed'))
    or (old.status = 'failed'    and new.status = 'executing')
    or (old.status = 'executed'  and new.status = 'verified')) then
    raise exception 'an execution cannot go from % to %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists governed_execution_guard on crm.governed_executions;
create trigger governed_execution_guard before update or delete on crm.governed_executions for each row execute function crm.governed_execution_guard();

-- acquisition_integrations
drop trigger if exists freeze_org_acquisition_integrations on crm.acquisition_integrations;
create trigger freeze_org_acquisition_integrations before update of organization_id on crm.acquisition_integrations for each row execute function core.freeze_organization_id();
alter table crm.acquisition_integrations enable row level security;
alter table crm.acquisition_integrations force row level security;
drop policy if exists acquisition_integrations_select on crm.acquisition_integrations;
create policy acquisition_integrations_select on crm.acquisition_integrations for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.acquisition_integrations from public, anon, authenticated;
grant select on crm.acquisition_integrations to authenticated;
grant select, insert, update on crm.acquisition_integrations to service_role;

-- connector_credentials: a session reads the metadata, never the secret material
drop trigger if exists freeze_org_connector_credentials on crm.connector_credentials;
create trigger freeze_org_connector_credentials before update of organization_id on crm.connector_credentials for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_connector_credentials_integration on crm.connector_credentials;
create trigger org_match_connector_credentials_integration before insert or update of integration_id, organization_id on crm.connector_credentials
  for each row execute function core.enforce_parent_org('integration_id', 'crm.acquisition_integrations');
alter table crm.connector_credentials enable row level security;
alter table crm.connector_credentials force row level security;
drop policy if exists connector_credentials_select on crm.connector_credentials;
create policy connector_credentials_select on crm.connector_credentials for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.connector_credentials from public, anon, authenticated;
grant select (id, organization_id, integration_id, name, hint, expires_on, status, created_by, created_at, rotated_at, revoked_at) on crm.connector_credentials to authenticated;
grant select, insert, update on crm.connector_credentials to service_role;

-- acquisition_policies
drop trigger if exists freeze_org_acquisition_policies on crm.acquisition_policies;
create trigger freeze_org_acquisition_policies before update of organization_id on crm.acquisition_policies for each row execute function core.freeze_organization_id();
alter table crm.acquisition_policies enable row level security;
alter table crm.acquisition_policies force row level security;
drop policy if exists acquisition_policies_select on crm.acquisition_policies;
create policy acquisition_policies_select on crm.acquisition_policies for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.acquisition_policies from public, anon, authenticated;
grant select on crm.acquisition_policies to authenticated;
grant select, insert, update on crm.acquisition_policies to service_role;

-- acquisition_usage
drop trigger if exists freeze_org_acquisition_usage on crm.acquisition_usage;
create trigger freeze_org_acquisition_usage before update of organization_id on crm.acquisition_usage for each row execute function core.freeze_organization_id();
alter table crm.acquisition_usage enable row level security;
alter table crm.acquisition_usage force row level security;
drop policy if exists acquisition_usage_select on crm.acquisition_usage;
create policy acquisition_usage_select on crm.acquisition_usage for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.acquisition_usage from public, anon, authenticated;
grant select on crm.acquisition_usage to authenticated;
grant select, insert on crm.acquisition_usage to service_role;

-- acquisition_decisions
drop trigger if exists freeze_org_acquisition_decisions on crm.acquisition_decisions;
create trigger freeze_org_acquisition_decisions before update of organization_id on crm.acquisition_decisions for each row execute function core.freeze_organization_id();
alter table crm.acquisition_decisions enable row level security;
alter table crm.acquisition_decisions force row level security;
drop policy if exists acquisition_decisions_select on crm.acquisition_decisions;
create policy acquisition_decisions_select on crm.acquisition_decisions for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.acquisition_decisions from public, anon, authenticated;
grant select on crm.acquisition_decisions to authenticated;
grant select, insert on crm.acquisition_decisions to service_role;

-- approval_bindings
drop trigger if exists freeze_org_approval_bindings on crm.approval_bindings;
create trigger freeze_org_approval_bindings before update of organization_id on crm.approval_bindings for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_approval_bindings_request on crm.approval_bindings;
create trigger org_match_approval_bindings_request before insert or update of approval_request_id, organization_id on crm.approval_bindings
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');
alter table crm.approval_bindings enable row level security;
alter table crm.approval_bindings force row level security;
drop policy if exists approval_bindings_select on crm.approval_bindings;
create policy approval_bindings_select on crm.approval_bindings for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.approval_bindings from public, anon, authenticated;
grant select on crm.approval_bindings to authenticated;
grant select, insert on crm.approval_bindings to service_role;

-- governed_executions
drop trigger if exists freeze_org_governed_executions on crm.governed_executions;
create trigger freeze_org_governed_executions before update of organization_id on crm.governed_executions for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_governed_executions_request on crm.governed_executions;
create trigger org_match_governed_executions_request before insert or update of approval_request_id, organization_id on crm.governed_executions
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');
alter table crm.governed_executions enable row level security;
alter table crm.governed_executions force row level security;
drop policy if exists governed_executions_select on crm.governed_executions;
create policy governed_executions_select on crm.governed_executions for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.governed_executions from public, anon, authenticated;
grant select on crm.governed_executions to authenticated;
grant select, insert, update on crm.governed_executions to service_role;

-- ── 6. approval subject types the engines will raise ───────────────────────

alter table approvals.approval_policies drop constraint if exists approval_policies_subject_type_check;
alter table approvals.approval_policies add constraint approval_policies_subject_type_check
  check (subject_type in ('proposal', 'deliverable', 'invoice', 'refund', 'scope_change', 'prototype', 'agent_action', 'ticket_plan', 'handover', 'ui_version',
                          'social_content', 'b2b_proposal', 'ad_campaign', 'acquisition_action'));
alter table approvals.approval_requests drop constraint if exists approval_requests_subject_type_check;
alter table approvals.approval_requests add constraint approval_requests_subject_type_check
  check (subject_type in ('proposal', 'deliverable', 'invoice', 'refund', 'scope_change', 'prototype', 'agent_action', 'ticket_plan', 'handover', 'ui_version',
                          'social_content', 'b2b_proposal', 'ad_campaign', 'acquisition_action'));

-- ── 7. doors: the registry ─────────────────────────────────────────────────

create or replace function crm.register_integration(p_provider text, p_environment text, p_label text, p_adapter_implemented boolean)
returns table (outcome text, integration_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_id    uuid;
  v_label text := coalesce(nullif(btrim(coalesce(p_label, '')), ''), 'default');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text, null::uuid; return; end if;
  if crm.provider_type(p_provider) is null or p_environment not in ('development', 'staging', 'production') or length(v_label) > 60 then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  begin
    insert into crm.acquisition_integrations (organization_id, provider, environment, label, adapter_implemented, verification, created_by)
    values (v_org, p_provider, p_environment, v_label, coalesce(p_adapter_implemented, false),
            case when coalesce(p_adapter_implemented, false) then 'IMPLEMENTED_NOT_CONFIGURED' else 'NOT_IMPLEMENTED' end, v_actor)
    returning id into v_id;
  exception when unique_violation then
    return query select 'duplicate'::text, null::uuid; return;
  end;
  perform core.record_audit(v_org, 'integration.registered', 'acquisition_integration', v_id, null,
    jsonb_build_object('provider', p_provider, 'environment', p_environment, 'adapter_implemented', coalesce(p_adapter_implemented, false)));
  return query select 'registered'::text, v_id;
end;
$$;
revoke all on function crm.register_integration(text, text, text, boolean) from public, anon;
grant execute on function crm.register_integration(text, text, text, boolean) to authenticated;

-- An adapter shipped (or was removed): move NOT_IMPLEMENTED <-> IMPLEMENTED_* honestly. Service role (the app) only.
create or replace function crm.sync_integration_adapter(p_organization_id uuid, p_integration uuid, p_implemented boolean)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare i crm.acquisition_integrations; v_has boolean; v_new text;
begin
  select * into i from crm.acquisition_integrations x where x.id = p_integration and x.organization_id = p_organization_id for update;
  if i.id is null then return query select 'not_found'::text; return; end if;
  if i.adapter_implemented = coalesce(p_implemented, false) then return query select 'unchanged'::text; return; end if;
  select exists (select 1 from crm.connector_credentials c where c.integration_id = i.id and c.status = 'active') into v_has;
  v_new := case
    when not coalesce(p_implemented, false) then 'NOT_IMPLEMENTED'
    when v_has then 'CONFIGURED_NOT_VERIFIED'
    else 'IMPLEMENTED_NOT_CONFIGURED' end;
  perform set_config('crm.integration_write', '1', true);
  update crm.acquisition_integrations set adapter_implemented = coalesce(p_implemented, false),
         verification = case when verification in ('NOT_IMPLEMENTED', 'IMPLEMENTED_NOT_CONFIGURED', 'CONFIGURED_NOT_VERIFIED') then v_new else verification end
   where id = i.id;
  perform set_config('crm.integration_write', '', true);
  return query select 'synced'::text;
end;
$$;
revoke all on function crm.sync_integration_adapter(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function crm.sync_integration_adapter(uuid, uuid, boolean) to service_role;

-- Owner only: a credential is the one thing here an admin cannot be trusted with by default.
create or replace function crm.store_connector_secret(p_integration uuid, p_name text, p_ciphertext text, p_iv text, p_auth_tag text, p_hint text, p_expires_on date)
returns table (outcome text, credential_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  i crm.acquisition_integrations;
  v_old uuid;
  v_id  uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_owner()), false) then return query select 'not_owner'::text, null::uuid; return; end if;
  if p_name is null or p_name !~ '^[a-z][a-z0-9_]{1,40}$' or coalesce(length(p_ciphertext), 0) = 0 or coalesce(length(p_iv), 0) < 8
     or coalesce(length(p_auth_tag), 0) < 8 or (p_hint is not null and length(p_hint) > 4) then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  select * into i from crm.acquisition_integrations x where x.id = p_integration and x.organization_id = v_org for update;
  if i.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if i.status = 'REVOKED' then return query select 'revoked'::text, null::uuid; return; end if;

  select c.id into v_old from crm.connector_credentials c where c.integration_id = i.id and c.name = p_name and c.status = 'active';
  if v_old is not null then
    update crm.connector_credentials set status = 'revoked', revoked_at = now() where id = v_old;
  end if;
  insert into crm.connector_credentials (organization_id, integration_id, name, ciphertext, iv, auth_tag, hint, expires_on, created_by, rotated_at)
  values (v_org, i.id, p_name, p_ciphertext, p_iv, p_auth_tag, p_hint, p_expires_on, v_actor, case when v_old is not null then now() end)
  returning id into v_id;

  perform set_config('crm.integration_write', '1', true);
  update crm.acquisition_integrations
     set status = case when status in ('UNCONFIGURED', 'DISABLED') then 'CONFIGURED' else status end,
         verification = case when verification = 'IMPLEMENTED_NOT_CONFIGURED' then 'CONFIGURED_NOT_VERIFIED' else verification end
   where id = i.id;
  perform set_config('crm.integration_write', '', true);

  -- The audit row names the credential and its last four characters at most: never the value, never the ciphertext.
  perform core.record_audit(v_org, case when v_old is not null then 'integration.secret_rotated' else 'integration.secret_stored' end,
    'acquisition_integration', i.id, null, jsonb_build_object('name', p_name, 'hint', p_hint, 'provider', i.provider));
  return query select case when v_old is not null then 'rotated' else 'stored' end::text, v_id;
end;
$$;
revoke all on function crm.store_connector_secret(uuid, text, text, text, text, text, date) from public, anon;
grant execute on function crm.store_connector_secret(uuid, text, text, text, text, text, date) to authenticated;

create or replace function crm.set_integration_state(p_integration uuid, p_to text, p_reason text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  i crm.acquisition_integrations;
  v_has boolean;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  if p_to not in ('DISABLED', 'CONFIGURED', 'REVOKED') then return query select 'invalid'::text; return; end if;
  if p_to = 'REVOKED' and not coalesce((select core.is_owner()), false) then return query select 'not_owner'::text; return; end if;
  if v_reason is null then return query select 'needs_reason'::text; return; end if;
  select * into i from crm.acquisition_integrations x where x.id = p_integration and x.organization_id = v_org for update;
  if i.id is null then return query select 'not_found'::text; return; end if;
  if i.status = p_to then return query select 'unchanged'::text; return; end if;
  if i.status = 'REVOKED' then return query select 'revoked'::text; return; end if;

  if p_to = 'CONFIGURED' then
    select exists (select 1 from crm.connector_credentials c where c.integration_id = i.id and c.status = 'active') into v_has;
    if i.status <> 'DISABLED' then return query select 'invalid'::text; return; end if;
    if not v_has then p_to := 'UNCONFIGURED'; end if;
  end if;

  perform set_config('crm.integration_write', '1', true);
  update crm.acquisition_integrations
     set status = p_to, status_reason = v_reason,
         verification = case when p_to in ('DISABLED', 'REVOKED') then 'DISABLED'
                             when i.adapter_implemented and p_to = 'CONFIGURED' then 'CONFIGURED_NOT_VERIFIED'
                             when i.adapter_implemented then 'IMPLEMENTED_NOT_CONFIGURED'
                             else 'NOT_IMPLEMENTED' end
   where id = i.id;
  perform set_config('crm.integration_write', '', true);
  if p_to = 'REVOKED' then
    update crm.connector_credentials set status = 'revoked', revoked_at = now() where integration_id = i.id and status = 'active';
  end if;
  perform core.record_audit(v_org, 'integration.' || lower(p_to), 'acquisition_integration', i.id,
    jsonb_build_object('status', i.status), jsonb_build_object('status', p_to, 'reason', v_reason));
  return query select 'set'::text;
end;
$$;
revoke all on function crm.set_integration_state(uuid, text, text) from public, anon;
grant execute on function crm.set_integration_state(uuid, text, text) to authenticated;

-- The result of a REAL adapter call (service role only). The only path to a verified state.
create or replace function crm.record_integration_check(
  p_organization_id uuid, p_integration uuid, p_ok boolean, p_account_ref text, p_capabilities jsonb,
  p_error_class text, p_error text, p_api_version text default null
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  i crm.acquisition_integrations;
  v_key text; v_val text;
  v_ver text;
  v_status text;
begin
  select * into i from crm.acquisition_integrations x where x.id = p_integration and x.organization_id = p_organization_id for update;
  if i.id is null then return query select 'not_found'::text; return; end if;
  if not i.adapter_implemented then return query select 'no_adapter'::text; return; end if;
  if i.status in ('DISABLED', 'REVOKED') then return query select 'not_live'::text; return; end if;
  if not exists (select 1 from crm.connector_credentials c where c.integration_id = i.id and c.status = 'active') then
    return query select 'no_credential'::text; return;
  end if;
  if p_capabilities is not null then
    if jsonb_typeof(p_capabilities) <> 'object' then return query select 'invalid'::text; return; end if;
    for v_key, v_val in select k, v #>> '{}' from jsonb_each(p_capabilities) as t(k, v) loop
      if v_key not in ('SEARCH', 'READ_PROFILE', 'READ_OPPORTUNITIES', 'READ_MESSAGES', 'SEND_MESSAGE', 'PUBLISH_CONTENT', 'READ_ANALYTICS',
                       'CREATE_CAMPAIGN', 'UPDATE_CAMPAIGN', 'READ_AD_METRICS', 'SUBMIT_PROPOSAL', 'READ_PROPOSAL_STATUS', 'DEPLOY_PAGE',
                       'READ_DEPLOYMENT', 'CREATE_MEETING')
         or v_val not in ('AUTOMATED', 'ASSISTED', 'MANUAL', 'UNAVAILABLE', 'DEGRADED') then
        return query select 'invalid'::text; return;
      end if;
    end loop;
  end if;
  if not coalesce(p_ok, false) and (p_error_class is null or p_error_class not in ('transient', 'permanent', 'conditional', 'security')) then
    return query select 'invalid'::text; return;
  end if;

  if coalesce(p_ok, false) then
    v_ver := case when i.environment = 'production' then 'LIVE_VERIFIED' else 'SANDBOX_VERIFIED' end;
    v_status := 'ACTIVE';
  else
    v_ver := case when p_error_class = 'conditional' then 'BLOCKED_BY_CREDENTIAL'
                  when p_error_class = 'permanent' then 'BLOCKED_BY_PROVIDER'
                  else 'DEGRADED' end;
    v_status := case when i.status = 'ACTIVE' or i.status = 'DEGRADED' then 'DEGRADED' else 'CONFIGURED' end;
  end if;

  perform set_config('crm.integration_write', '1', true);
  -- A direct jump is not in the lifecycle (CONFIGURED -> DEGRADED is, CONNECTING is the in-between): route through CONNECTING.
  if i.status not in ('CONNECTING') then
    update crm.acquisition_integrations set status = 'CONNECTING' where id = i.id and status in ('CONFIGURED', 'ACTIVE', 'DEGRADED');
  end if;
  update crm.acquisition_integrations
     set status = v_status, verification = v_ver, last_checked_at = now(),
         last_success_at = case when coalesce(p_ok, false) then now() else last_success_at end,
         last_failure_at = case when not coalesce(p_ok, false) then now() else last_failure_at end,
         last_error_class = case when coalesce(p_ok, false) then null else p_error_class end,
         last_error = case when coalesce(p_ok, false) then null else left(coalesce(p_error, ''), 300) end,
         account_ref = coalesce(left(p_account_ref, 80), account_ref),
         capabilities = coalesce(p_capabilities, capabilities),
         api_version = coalesce(left(p_api_version, 40), api_version),
         health = case when coalesce(p_ok, false) then 'ok' else left('failing: ' || coalesce(p_error_class, 'unknown'), 200) end
   where id = i.id;
  perform set_config('crm.integration_write', '', true);

  perform core.record_audit(p_organization_id, case when coalesce(p_ok, false) then 'integration.check_passed' else 'integration.check_failed' end,
    'acquisition_integration', i.id, null,
    jsonb_build_object('provider', i.provider, 'verification', v_ver, 'error_class', p_error_class));
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm.record_integration_check(uuid, uuid, boolean, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function crm.record_integration_check(uuid, uuid, boolean, text, jsonb, text, text, text) to service_role;

-- ── 8. doors: policy and usage ─────────────────────────────────────────────

create or replace function crm.set_acquisition_policy(p_action text, p_mode text, p_approval_above_minor bigint, p_escalate_above_minor bigint)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after jsonb;
  v_loosens boolean;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  if crm.action_channel(p_action, 'meta_ads') is null and p_action not in ('ad_launch', 'ad_budget_increase', 'ad_targeting_change') then
    return query select 'invalid'::text; return;
  end if;
  if p_mode not in ('auto', 'approval', 'block') or coalesce(p_approval_above_minor, 0) < 0 or coalesce(p_escalate_above_minor, 0) < 0 then
    return query select 'invalid'::text; return;
  end if;
  if p_mode = 'auto' and p_action in ('social_publish', 'b2b_proposal_submit', 'ad_launch', 'landing_page_deploy', 'profile_update') then
    return query select 'never_auto'::text; return;
  end if;
  select to_jsonb(p.*) into v_before from crm.acquisition_policies p where p.organization_id = v_org and p.action_type = p_action for update;
  -- Loosening governance (to auto, or a higher threshold than before) is the owner's. Tightening is any admin's.
  v_loosens := p_mode = 'auto' and coalesce(v_before ->> 'mode', '') <> 'auto'
               or (p_mode = 'auto' and coalesce((v_before ->> 'approval_above_minor')::bigint, 0) < coalesce(p_approval_above_minor, 9223372036854775807))
               or (v_before is null and p_mode = 'auto')
               or (p_mode <> 'block' and v_before is not null and (v_before ->> 'escalate_above_minor') is not null
                   and coalesce(p_escalate_above_minor, 9223372036854775807) > (v_before ->> 'escalate_above_minor')::bigint);
  if v_loosens and not coalesce((select core.is_owner()), false) then return query select 'not_owner'::text; return; end if;

  insert into crm.acquisition_policies (organization_id, action_type, mode, approval_above_minor, escalate_above_minor, updated_by)
  values (v_org, p_action, p_mode, p_approval_above_minor, p_escalate_above_minor, v_actor)
  on conflict (organization_id, action_type) do update
     set mode = excluded.mode, approval_above_minor = excluded.approval_above_minor,
         escalate_above_minor = excluded.escalate_above_minor, updated_by = v_actor, updated_at = now()
  returning to_jsonb(crm.acquisition_policies.*) into v_after;
  perform core.record_audit(v_org, 'acquisition.policy_changed', 'acquisition_policy', null, v_before, v_after);
  return query select 'saved'::text;
end;
$$;
revoke all on function crm.set_acquisition_policy(text, text, bigint, bigint) from public, anon;
grant execute on function crm.set_acquisition_policy(text, text, bigint, bigint) to authenticated;

create or replace function crm.ensure_acquisition_approval_policies()
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  t text;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  -- The approval engine refuses a subject type with no policy (no_policy = never default open). Seed an ordinary,
  -- editable ladder: an ops admin decides, within 48 hours. The owner can raise any of them in Settings > Approvals.
  foreach t in array array['social_content', 'b2b_proposal', 'ad_campaign', 'acquisition_action'] loop
    insert into approvals.approval_policies (organization_id, subject_type, min_amount_minor, required_role, sla_hours, audience, note)
    select v_org, t, 0, 'ops_admin', 48, 'internal', 'Lead generation default - editable.'
    where not exists (select 1 from approvals.approval_policies p where p.organization_id = v_org and p.subject_type = t and p.active);
  end loop;
  return query select 'ready'::text;
end;
$$;
revoke all on function crm.ensure_acquisition_approval_policies() from public, anon;
grant execute on function crm.ensure_acquisition_approval_policies() to authenticated;

create or replace function crm.record_acquisition_usage(p_organization_id uuid, p_channel text, p_metric text, p_amount bigint, p_ref text default null, p_correlation_id uuid default null)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_channel not in ('meta_ads', 'email', 'social', 'google_ads', 'b2b') or p_metric not in ('action', 'spend_minor', 'connect') or coalesce(p_amount, -1) < 0 then
    return query select 'invalid'::text; return;
  end if;
  begin
    insert into crm.acquisition_usage (organization_id, channel, metric, amount, ref, correlation_id)
    values (p_organization_id, p_channel, p_metric, p_amount, nullif(btrim(coalesce(p_ref, '')), ''), p_correlation_id);
  exception when unique_violation then
    return query select 'duplicate'::text; return;
  end;
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm.record_acquisition_usage(uuid, text, text, bigint, text, uuid) from public, anon, authenticated;
grant execute on function crm.record_acquisition_usage(uuid, text, text, bigint, text, uuid) to service_role;

-- ── 9. THE decision ────────────────────────────────────────────────────────

create or replace function crm.acquisition_decide(
  p_organization_id uuid, p_action text, p_channel text default null,
  p_amount_minor bigint default 0, p_requested_count integer default 1, p_correlation_id uuid default null
)
returns table (decision text, reason text, required_role text, policy_version text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_channel text;
  v_block   text;
  v_pol     crm.acquisition_policies;
  v_chan    crm.acquisition_channels;
  v_need    text[];
  v_used_today bigint;
  v_used_month bigint;
  v_amount  bigint := greatest(coalesce(p_amount_minor, 0), 0);
  v_count   integer := greatest(coalesce(p_requested_count, 1), 1);
  d text; r text; role text; ver text;
begin
  if (select auth.uid()) is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'BLOCK'::text, 'tenant_mismatch'::text, null::text, null::text; return;
  end if;

  v_channel := crm.action_channel(p_action, p_channel);
  if v_channel is null then
    d := 'BLOCK'; r := case when crm.action_channel(p_action, 'meta_ads') is null and p_action not in ('ad_launch', 'ad_budget_increase', 'ad_targeting_change') then 'unknown_action' else 'channel_required' end;
  else
    select * into v_pol from crm.acquisition_policies p where p.organization_id = p_organization_id and p.action_type = p_action;
    ver := case when v_pol.id is not null then v_pol.id::text || ':' || extract(epoch from v_pol.updated_at)::bigint::text else 'default' end;

    -- 1. the stops: global, then channel. Commercial actions have no channel to pause.
    if v_channel <> 'none' then
      v_block := crm.acquisition_blocked(p_organization_id, v_channel);
      if v_block is not null then d := 'BLOCK'; r := v_block; end if;
    end if;

    -- 2. a connector the action cannot run without (email uses the existing governed lane)
    if d is null then
      v_need := crm.required_providers(p_action, v_channel);
      if array_length(v_need, 1) is not null and not exists (
        select 1 from crm.acquisition_integrations i
         where i.organization_id = p_organization_id and i.provider = any (v_need) and i.status = 'ACTIVE') then
        d := 'BLOCK'; r := 'integration_not_active';
      end if;
    end if;

    -- 3. the Admin's limits: a daily action ceiling and a monthly spend cap. A cap is a cap - approval cannot lift it.
    if d is null and v_channel <> 'none' then
      select * into v_chan from crm.acquisition_channels c where c.organization_id = p_organization_id and c.channel = v_channel;
      if v_chan.organization_id is not null and v_chan.daily_limit is not null then
        select coalesce(sum(u.amount), 0) into v_used_today from crm.acquisition_usage u
         where u.organization_id = p_organization_id and u.channel = v_channel and u.metric = 'action'
           and u.occurred_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
        if v_used_today + v_count > v_chan.daily_limit then d := 'BLOCK'; r := 'daily_limit'; end if;
      end if;
      if d is null and v_chan.organization_id is not null and v_chan.monthly_budget_minor is not null and v_amount > 0 then
        select coalesce(sum(u.amount), 0) into v_used_month from crm.acquisition_usage u
         where u.organization_id = p_organization_id and u.channel = v_channel and u.metric = 'spend_minor'
           and u.occurred_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
        if v_used_month + v_amount > v_chan.monthly_budget_minor then d := 'BLOCK'; r := 'monthly_budget_exceeded'; end if;
      end if;
    end if;

    -- 4. the policy. No row is not permission: it is ADMIN_APPROVAL_REQUIRED.
    if d is null then
      if v_pol.id is null then
        d := 'ADMIN_APPROVAL_REQUIRED'; r := 'no_policy_default'; role := 'ops_admin';
      elsif v_pol.mode = 'block' then
        d := 'BLOCK'; r := 'blocked_by_policy';
      elsif v_pol.escalate_above_minor is not null and v_amount > v_pol.escalate_above_minor then
        d := 'ESCALATE'; r := 'above_escalation_threshold'; role := 'owner';
      elsif v_pol.mode = 'approval' then
        d := 'ADMIN_APPROVAL_REQUIRED'; r := 'policy_requires_approval'; role := 'ops_admin';
      elsif v_pol.approval_above_minor is not null and v_amount > v_pol.approval_above_minor then
        d := 'ADMIN_APPROVAL_REQUIRED'; r := 'above_auto_threshold'; role := 'ops_admin';
      else
        d := 'AUTO_APPROVE'; r := 'within_policy';
      end if;
    end if;
  end if;

  insert into crm.acquisition_decisions (organization_id, action_type, channel, amount_minor, decision, reason, policy_version, correlation_id)
  values (p_organization_id, p_action, v_channel, v_amount, d, r, ver, p_correlation_id);
  return query select d, r, role, ver;
end;
$$;
revoke all on function crm.acquisition_decide(uuid, text, text, bigint, integer, uuid) from public, anon;
grant execute on function crm.acquisition_decide(uuid, text, text, bigint, integer, uuid) to authenticated, service_role;

-- ── 10. doors: bind an approval to exact content, check it, execute once ───

create or replace function crm.bind_approval(
  p_organization_id uuid, p_artifact_type text, p_artifact_id uuid, p_version integer, p_content_hash text,
  p_summary text, p_amount_minor bigint, p_requested_by_type text, p_requested_by_id uuid,
  p_valid_hours integer default 72, p_correlation_id uuid default null
)
returns table (outcome text, request_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_prior text;
  v_req   record;
begin
  if (select auth.uid()) is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if p_artifact_type not in ('social_content', 'b2b_proposal', 'ad_campaign', 'acquisition_action') or p_content_hash !~ '^[0-9a-f]{64}$'
     or coalesce(p_version, 0) < 1 or coalesce(p_valid_hours, 72) not between 1 and 720 or p_artifact_id is null then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  -- An artifact id names ONE immutable version. The same id with different content means a version was edited in place:
  -- refuse, the caller must create a new version (a new id) and ask again.
  select b.content_hash into v_prior from crm.approval_bindings b
   where b.organization_id = p_organization_id and b.artifact_type = p_artifact_type and b.artifact_id = p_artifact_id
   order by b.created_at desc limit 1;
  if v_prior is not null and v_prior <> p_content_hash then
    return query select 'content_changed'::text, null::uuid; return;
  end if;

  select * into v_req from approvals.request_approval(p_organization_id, p_artifact_type, p_artifact_id, p_requested_by_type, p_requested_by_id,
    left(p_summary, 500), jsonb_build_object('artifact_type', p_artifact_type, 'version', p_version, 'content_hash', p_content_hash),
    p_amount_minor, 'internal', p_correlation_id);
  if v_req.outcome not in ('requested', 'already_pending') then
    return query select v_req.outcome::text, null::uuid; return;
  end if;
  insert into crm.approval_bindings (approval_request_id, organization_id, artifact_type, artifact_id, version, content_hash, valid_until)
  values (v_req.request_id, p_organization_id, p_artifact_type, p_artifact_id, p_version, p_content_hash, now() + make_interval(hours => coalesce(p_valid_hours, 72)))
  on conflict (approval_request_id) do nothing;
  return query select v_req.outcome::text, v_req.request_id;
end;
$$;
revoke all on function crm.bind_approval(uuid, text, uuid, integer, text, text, bigint, text, uuid, integer, uuid) from public, anon;
grant execute on function crm.bind_approval(uuid, text, uuid, integer, text, text, bigint, text, uuid, integer, uuid) to authenticated, service_role;

-- Does THIS approval cover THIS content, NOW? Read fresh every time; nothing cached at queue time is trusted.
create or replace function crm.approval_check(p_request uuid, p_artifact_type text, p_artifact_id uuid, p_content_hash text)
returns table (covered boolean, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b crm.approval_bindings;
  v_state text;
  v_org uuid;
begin
  select * into b from crm.approval_bindings x where x.approval_request_id = p_request;
  if b.approval_request_id is null then return query select false, 'no_binding'::text; return; end if;
  if (select auth.uid()) is not null and b.organization_id is distinct from (select core.current_organization_id()) then
    return query select false, 'no_binding'::text; return;
  end if;
  select r.state, r.organization_id into v_state, v_org from approvals.approval_requests r where r.id = p_request;
  if v_state is distinct from 'approved' then return query select false, ('state_' || coalesce(v_state, 'missing'))::text; return; end if;
  if b.artifact_type <> p_artifact_type or b.artifact_id <> p_artifact_id then return query select false, 'artifact_mismatch'::text; return; end if;
  if b.content_hash <> p_content_hash then return query select false, 'content_changed'::text; return; end if;
  if b.valid_until < now() then return query select false, 'expired'::text; return; end if;
  return query select true, 'ok'::text;
end;
$$;
revoke all on function crm.approval_check(uuid, text, uuid, text) from public, anon;
grant execute on function crm.approval_check(uuid, text, uuid, text) to authenticated, service_role;

-- The ONE door a governed side effect passes through. Service role only.
create or replace function crm.begin_governed_execution(
  p_organization_id uuid, p_request uuid, p_artifact_type text, p_artifact_id uuid, p_content_hash text,
  p_action text, p_channel text, p_correlation_id uuid default null
)
returns table (outcome text, reason text, execution_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_chan text := crm.action_channel(p_action, p_channel);
  v_block text;
  v_cov record;
  v_new uuid;
  e crm.governed_executions;
begin
  if v_chan is null then return query select 'blocked'::text, 'unknown_action'::text, null::uuid; return; end if;
  if not exists (select 1 from approvals.approval_requests r where r.id = p_request and r.organization_id = p_organization_id) then
    return query select 'not_covered'::text, 'no_binding'::text, null::uuid; return;
  end if;

  -- Pause and approval are re-read NOW. A pause thrown while this job waited stops it; so does an approval that expired.
  if v_chan <> 'none' then
    v_block := crm.acquisition_blocked(p_organization_id, v_chan);
    if v_block is not null then return query select 'blocked'::text, v_block, null::uuid; return; end if;
  end if;
  select * into v_cov from crm.approval_check(p_request, p_artifact_type, p_artifact_id, p_content_hash);
  if not v_cov.covered then return query select 'not_covered'::text, v_cov.reason, null::uuid; return; end if;

  insert into crm.governed_executions (organization_id, approval_request_id, artifact_type, artifact_id, content_hash, action_type, channel, correlation_id)
  values (p_organization_id, p_request, p_artifact_type, p_artifact_id, p_content_hash, p_action, nullif(v_chan, 'none'), p_correlation_id)
  on conflict (approval_request_id) do nothing
  returning id into v_new;
  if v_new is not null then
    perform core.record_audit(p_organization_id, 'governed.execution_started', 'acquisition_execution', v_new, null,
      jsonb_build_object('action', p_action, 'approval_request_id', p_request), p_correlation_id);
    return query select 'proceed'::text, 'first_execution'::text, v_new; return;
  end if;

  select * into e from crm.governed_executions x where x.approval_request_id = p_request for update;
  if e.status in ('executed', 'verified') then return query select 'already_executed'::text, e.status, e.id; return; end if;
  if e.status = 'executing' then
    if e.started_at < now() - interval '10 minutes' then
      update crm.governed_executions set status = 'unknown' where id = e.id;
      perform core.record_audit(p_organization_id, 'governed.execution_unknown', 'acquisition_execution', e.id, null, jsonb_build_object('action', p_action));
      return query select 'needs_reconciliation'::text, 'stalled'::text, e.id; return;
    end if;
    return query select 'in_progress'::text, 'executing'::text, e.id; return;
  end if;
  if e.status = 'unknown' then return query select 'needs_reconciliation'::text, 'unknown'::text, e.id; return; end if;
  if e.status = 'failed' then
    if e.attempt >= 3 then return query select 'exhausted'::text, 'max_attempts'::text, e.id; return; end if;
    update crm.governed_executions set status = 'executing', attempt = attempt + 1, started_at = now(), finished_at = null where id = e.id;
    return query select 'proceed'::text, 'retry_after_failure'::text, e.id; return;
  end if;
  return query select 'in_progress'::text, e.status, e.id;
end;
$$;
revoke all on function crm.begin_governed_execution(uuid, uuid, text, uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function crm.begin_governed_execution(uuid, uuid, text, uuid, text, text, text, uuid) to service_role;

create or replace function crm.finish_governed_execution(p_organization_id uuid, p_execution uuid, p_status text, p_external_ref text, p_evidence jsonb)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare e crm.governed_executions;
begin
  if p_status not in ('executed', 'failed', 'unknown') then return query select 'invalid'::text; return; end if;
  select * into e from crm.governed_executions x where x.id = p_execution and x.organization_id = p_organization_id for update;
  if e.id is null then return query select 'not_found'::text; return; end if;
  if not (e.status = 'executing' or (e.status = 'unknown' and p_status in ('executed', 'failed'))) then
    return query select 'wrong_state'::text; return;
  end if;
  update crm.governed_executions
     set status = p_status, finished_at = now(), external_ref = coalesce(left(p_external_ref, 300), external_ref),
         evidence = coalesce(p_evidence, '{}'::jsonb)
   where id = e.id;
  perform core.record_audit(p_organization_id, 'governed.execution_' || p_status, 'acquisition_execution', e.id, null,
    jsonb_build_object('action', e.action_type, 'external_ref', left(p_external_ref, 300)));
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm.finish_governed_execution(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function crm.finish_governed_execution(uuid, uuid, text, text, jsonb) to service_role;

-- EXECUTED is the provider accepting it. VERIFIED is the result confirmed (e.g. the post is really there).
create or replace function crm.verify_governed_execution(p_organization_id uuid, p_execution uuid, p_evidence jsonb)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare e crm.governed_executions;
begin
  select * into e from crm.governed_executions x where x.id = p_execution and x.organization_id = p_organization_id for update;
  if e.id is null then return query select 'not_found'::text; return; end if;
  if e.status = 'verified' then return query select 'already_verified'::text; return; end if;
  if e.status <> 'executed' then return query select 'wrong_state'::text; return; end if;
  update crm.governed_executions set status = 'verified', verified_at = now(), evidence = evidence || coalesce(jsonb_build_object('verification', p_evidence), '{}'::jsonb) where id = e.id;
  perform core.record_audit(p_organization_id, 'governed.execution_verified', 'acquisition_execution', e.id, null, jsonb_build_object('action', e.action_type));
  return query select 'verified'::text;
end;
$$;
revoke all on function crm.verify_governed_execution(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function crm.verify_governed_execution(uuid, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
