-- ═══════════════════════════════════════════════════════════════════════════
-- Lead Generation & Acquisition — slice 1: what the Admin decides, and the
-- brake the Admin can throw.
--
-- The acquisition specification (lead gen/…Implementation_Specification.pdf,
-- §1–§2, §8, §12 step 2) asks for five engines — Meta/Facebook Ads, Email,
-- Social, Google Ads, B2B — that are all steered from one place and all
-- stoppable from one place. Nothing in the repository held that steering:
-- the target service lived nowhere, the ICP lived nowhere, and the only stop
-- was `outbound_paused`, which is WhatsApp-shaped.
--
-- Three decisions, each argued rather than assumed:
--
--  1. TARGET SERVICES AND THE ICP ARE DATA. "Website + App Development" is the
--     DEFAULT the spec names, not an assumption of the code: tomorrow the
--     owner targets SEO, and no deploy is involved. The defaults are rows an
--     admin may deactivate, seeded once by a door, never a constant a worker
--     reads. The ICP is VERSIONED and every version is immutable (spec §117):
--     a decision made under ICP v2 must stay explainable after v3 exists, so
--     "edit" means "insert the next version", and the version a prospect was
--     found under can be named later.
--
--  2. PER-CHANNEL SETTINGS ARE ONE ROW PER (organisation, channel), seeded
--     DISABLED. Enabling a channel that has no engine yet is a no-op — and
--     honest about it on the screen — but the rows already carry the pause,
--     the goal, the budget and the daily ceiling the engines will read.
--     `enabled` and `paused` are deliberately two columns: enabled is a
--     decision about whether the channel is part of the plan; paused is the
--     emergency brake, which must work even on a channel that is enabled.
--
--  3. THE BRAKE DOES NOT DEPEND ON THE THING IT STOPS (spec §70). Pause-all is
--     a FOURTH `core.kill_switches` row — `acquisition_paused` — read by
--     `core.org_paused` like the other three, owner-only, reason required,
--     audited. Per-channel pause is a column on the channel row, thrown by an
--     admin. Both are read through ONE function, `crm.acquisition_blocked`,
--     so no engine can honour one and forget the other. A pause stops NEW side
--     effects; it deletes nothing and rewrites no state.
--
-- Everything below is additive. `core.set_kill_switch` is carried forward from
-- its own latest definition (20261001150000) with ONE marked edit — the
-- whitelist gains 'acquisition_paused' — so nothing it already refused is
-- re-opened.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the fourth emergency stop ───────────────────────────────────────────

alter table core.kill_switches drop constraint if exists kill_switches_switch_check;
alter table core.kill_switches
  add constraint kill_switches_switch_check
  check (switch in ('agents_paused', 'outbound_paused', 'jobs_paused', 'acquisition_paused'));

comment on table core.kill_switches is
  'The four emergency stops (SCR-068): agents_paused (no agent job is claimed or continued), outbound_paused (crm.send_outbound_message refuses every send), jobs_paused (no job of any kind is claimed), acquisition_paused (no lead-generation engine takes a NEW external side effect — crm.acquisition_blocked). Owner only, reason required, through core.set_kill_switch; read by core.org_paused wherever work is claimed or sent.';

create or replace function core.set_kill_switch(p_switch text, p_active boolean, p_reason text)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_owner' | 'bad_switch' | 'no_reason' | 'unchanged'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;
  -- EDIT (lead generation): 'acquisition_paused' joins the whitelist.
  if p_switch is null or p_switch not in ('agents_paused', 'outbound_paused', 'jobs_paused', 'acquisition_paused') then
    return query select 'bad_switch'::text; return;
  end if;
  if v_reason is null then
    return query select 'no_reason'::text; return;
  end if;

  select to_jsonb(k.*) into v_before
    from core.kill_switches k
   where k.organization_id = v_org and k.switch = p_switch
   for update;

  if coalesce((v_before ->> 'active')::boolean, false) = coalesce(p_active, false) then
    return query select 'unchanged'::text; return;
  end if;

  insert into core.kill_switches (organization_id, switch, active, reason, set_by, set_at)
  values (v_org, p_switch, coalesce(p_active, false), v_reason, v_actor, now())
  on conflict (organization_id, switch) do update
     set active = excluded.active, reason = excluded.reason, set_by = excluded.set_by, set_at = now(), updated_at = now()
  returning to_jsonb(core.kill_switches.*) into v_after;

  perform core.record_audit(
    v_org,
    case when coalesce(p_active, false) then 'kill_switch.engaged' else 'kill_switch.released' end,
    'kill_switch', null, v_before, v_after
  );

  return query select 'set'::text;
end;
$$;

comment on function core.set_kill_switch(text, boolean, text) is
  'Engages or releases one emergency stop with a reason (SCR-068). Owner only; audited as kill_switch.engaged / kill_switch.released.';

revoke all on function core.set_kill_switch(text, boolean, text) from public, anon;
grant execute on function core.set_kill_switch(text, boolean, text) to authenticated;

-- ── 2. target services ─────────────────────────────────────────────────────

create table if not exists crm.target_services (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  name             text not null check (length(trim(name)) between 2 and 80),
  description      text check (description is null or length(description) <= 600),
  priority         integer not null default 100 check (priority between 1 and 1000),
  active           boolean not null default true,
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists target_services_org_name_key
  on crm.target_services (organization_id, lower(name));
create index if not exists target_services_org_active_idx
  on crm.target_services (organization_id, active, priority);

comment on table crm.target_services is
  'What the agency is selling through acquisition right now. DATA, not a constant: the engines read the active rows (lowest priority number first), so changing the service is an edit here and no deploy. The three defaults are seeded once by crm.ensure_acquisition_defaults and are ordinary rows an admin may deactivate.';

-- ── 3. the ideal customer profile, versioned and immutable ─────────────────

create table if not exists crm.icp_versions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  version          integer not null check (version >= 1),
  definition       jsonb not null check (jsonb_typeof(definition) = 'object'),
  note             text check (note is null or length(note) <= 500),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (organization_id, version)
);

comment on table crm.icp_versions is
  'The ideal customer profile (spec §117). Append-only: a change is the NEXT version, never an edit, so what a prospect was qualified against stays nameable. Current = highest version. definition carries industries, geographies, company_sizes, personas, exclusions (arrays of text) and min_qualification_score (0-100).';

create or replace function crm.icp_versions_are_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'an ICP version is history; save the next version instead' using errcode = '42501';
end;
$$;

drop trigger if exists icp_versions_immutable on crm.icp_versions;
create trigger icp_versions_immutable
  before update or delete on crm.icp_versions
  for each row execute function crm.icp_versions_are_history();

-- ── 4. one settings row per channel ────────────────────────────────────────

create table if not exists crm.acquisition_channels (
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  channel                  text not null check (channel in ('meta_ads', 'email', 'social', 'google_ads', 'b2b')),
  enabled                  boolean not null default false,
  paused                   boolean not null default false,
  pause_reason             text,
  paused_by                uuid references core.users(id) on delete set null,
  paused_at                timestamptz,
  monthly_qualified_target integer check (monthly_qualified_target is null or monthly_qualified_target between 0 and 100000),
  monthly_budget_minor     bigint check (monthly_budget_minor is null or monthly_budget_minor >= 0),
  daily_limit              integer check (daily_limit is null or daily_limit between 0 and 100000),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (organization_id, channel),
  constraint acquisition_channels_pause_says_why
    check (not paused or (pause_reason is not null and length(trim(pause_reason)) > 0))
);

comment on table crm.acquisition_channels is
  'The five engines'' Admin-owned settings. enabled = part of the plan; paused = the emergency brake (works on an enabled channel, needs a reason). Seeded disabled. monthly_budget_minor is paise/cents like every money column here. Read by every engine through crm.acquisition_blocked.';

-- ── tenancy, RLS: the same shape as every org-scoped table here ─────────────

drop trigger if exists freeze_org_target_services on crm.target_services;
create trigger freeze_org_target_services
  before update of organization_id on crm.target_services
  for each row execute function core.freeze_organization_id();

alter table crm.target_services enable row level security;
alter table crm.target_services force row level security;

drop policy if exists target_services_select on crm.target_services;
create policy target_services_select on crm.target_services
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- The platform's default privileges would otherwise hand anon SELECT and authenticated INSERT/UPDATE/DELETE on a new table;
-- RLS would still refuse the rows, but a grant that is wider than the intent is the first thing a policy mistake exposes.
revoke all on table crm.target_services from public, anon, authenticated;
grant select on crm.target_services to authenticated;
grant select, insert, update on crm.target_services to service_role;

drop trigger if exists freeze_org_icp_versions on crm.icp_versions;
create trigger freeze_org_icp_versions
  before update of organization_id on crm.icp_versions
  for each row execute function core.freeze_organization_id();

alter table crm.icp_versions enable row level security;
alter table crm.icp_versions force row level security;

drop policy if exists icp_versions_select on crm.icp_versions;
create policy icp_versions_select on crm.icp_versions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- The platform's default privileges would otherwise hand anon SELECT and authenticated INSERT/UPDATE/DELETE on a new table;
-- RLS would still refuse the rows, but a grant that is wider than the intent is the first thing a policy mistake exposes.
revoke all on table crm.icp_versions from public, anon, authenticated;
grant select on crm.icp_versions to authenticated;
grant select, insert, update on crm.icp_versions to service_role;

drop trigger if exists freeze_org_acquisition_channels on crm.acquisition_channels;
create trigger freeze_org_acquisition_channels
  before update of organization_id on crm.acquisition_channels
  for each row execute function core.freeze_organization_id();

alter table crm.acquisition_channels enable row level security;
alter table crm.acquisition_channels force row level security;

drop policy if exists acquisition_channels_select on crm.acquisition_channels;
create policy acquisition_channels_select on crm.acquisition_channels
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- The platform's default privileges would otherwise hand anon SELECT and authenticated INSERT/UPDATE/DELETE on a new table;
-- RLS would still refuse the rows, but a grant that is wider than the intent is the first thing a policy mistake exposes.
revoke all on table crm.acquisition_channels from public, anon, authenticated;
grant select on crm.acquisition_channels to authenticated;
grant select, insert, update on crm.acquisition_channels to service_role;

grant delete on crm.target_services to service_role;

drop trigger if exists set_updated_at on crm.target_services;
create trigger set_updated_at before update on crm.target_services
  for each row execute function core.set_updated_at();
drop trigger if exists set_updated_at on crm.acquisition_channels;
create trigger set_updated_at before update on crm.acquisition_channels
  for each row execute function core.set_updated_at();

-- ── 5. the one question every engine asks before a new side effect ─────────

create or replace function crm.acquisition_blocked(p_organization_id uuid, p_channel text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- NULL = free to act. Otherwise the reason, in the order an operator would
  -- want it: the global stop outranks the channel stop. An unknown channel is
  -- blocked rather than allowed: the question must fail closed.
  select case
    when p_channel is null or p_channel not in ('meta_ads', 'email', 'social', 'google_ads', 'b2b') then 'unknown_channel'
    -- A signed-in session may only ask about its own organisation; the service
    -- role (no auth.uid()) is the engines and may ask about any.
    when (select auth.uid()) is not null
         and p_organization_id is distinct from (select core.current_organization_id()) then 'tenant_mismatch'
    when core.org_paused(p_organization_id, 'acquisition_paused') then 'acquisition_paused'
    when exists (
      select 1 from crm.acquisition_channels c
       where c.organization_id = p_organization_id and c.channel = p_channel and c.paused
    ) then 'channel_paused'
    else null
  end;
$$;

comment on function crm.acquisition_blocked(uuid, text) is
  'NULL when the channel may take a new external side effect, else why not: acquisition_paused (global) | channel_paused | unknown_channel | tenant_mismatch (a session asking about another organisation). Engines call this at execution time, never at scheduling time, so a pause thrown while work is queued still stops it.';

revoke all on function crm.acquisition_blocked(uuid, text) from public, anon;
grant execute on function crm.acquisition_blocked(uuid, text) to authenticated, service_role;

-- ── 6. the doors ───────────────────────────────────────────────────────────
-- All admin-only (owner or ops_admin), all org-pinned to the session, all
-- audited in the same transaction, all return a named outcome.

create or replace function crm.ensure_acquisition_defaults()
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_seeded boolean := false;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;

  insert into crm.acquisition_channels (organization_id, channel)
  select v_org, c from unnest(array['meta_ads', 'email', 'social', 'google_ads', 'b2b']) as c
  on conflict do nothing;

  -- The spec's initial default (Website, App, General Development). Seeded
  -- only into an organisation that has NO target service at all, so a
  -- deliberate "deactivate everything" or a replaced list is never undone.
  if not exists (select 1 from crm.target_services where organization_id = v_org) then
    insert into crm.target_services (organization_id, name, description, priority, created_by) values
      (v_org, 'Website Development', 'Business, e-commerce and marketing websites.', 10, v_actor),
      (v_org, 'App Development', 'Mobile and web applications.', 20, v_actor),
      (v_org, 'General Development Services', 'Other software development work that fits the agency.', 30, v_actor);
    v_seeded := true;
    perform core.record_audit(v_org, 'acquisition.defaults_seeded', 'target_service', null, null,
      jsonb_build_object('services', 3));
  end if;

  return query select case when v_seeded then 'seeded' else 'ready' end::text;
end;
$$;

revoke all on function crm.ensure_acquisition_defaults() from public, anon;
grant execute on function crm.ensure_acquisition_defaults() to authenticated;

create or replace function crm.set_target_service(
  p_id uuid, p_name text, p_description text, p_priority integer, p_active boolean
)
returns table (outcome text, service_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_name   text := nullif(trim(coalesce(p_name, '')), '');
  v_before jsonb;
  v_after  jsonb;
  v_id     uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if v_name is null or length(v_name) not between 2 and 80
     or coalesce(p_priority, 100) not between 1 and 1000
     or (p_description is not null and length(p_description) > 600) then
    return query select 'invalid'::text, null::uuid; return;
  end if;

  if p_id is null then
    begin
      insert into crm.target_services (organization_id, name, description, priority, active, created_by)
      values (v_org, v_name, nullif(trim(coalesce(p_description, '')), ''), coalesce(p_priority, 100), coalesce(p_active, true), v_actor)
      returning id, to_jsonb(crm.target_services.*) into v_id, v_after;
    exception when unique_violation then
      return query select 'duplicate'::text, null::uuid; return;
    end;
    perform core.record_audit(v_org, 'acquisition.target_service_added', 'target_service', v_id, null, v_after);
    return query select 'saved'::text, v_id; return;
  end if;

  select to_jsonb(s.*) into v_before from crm.target_services s
   where s.id = p_id and s.organization_id = v_org for update;
  if v_before is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  begin
    update crm.target_services
       set name = v_name,
           description = nullif(trim(coalesce(p_description, '')), ''),
           priority = coalesce(p_priority, priority),
           active = coalesce(p_active, active)
     where id = p_id and organization_id = v_org
    returning to_jsonb(crm.target_services.*) into v_after;
  exception when unique_violation then
    return query select 'duplicate'::text, null::uuid; return;
  end;

  perform core.record_audit(v_org, 'acquisition.target_service_changed', 'target_service', p_id, v_before, v_after);
  return query select 'saved'::text, p_id;
end;
$$;

revoke all on function crm.set_target_service(uuid, text, text, integer, boolean) from public, anon;
grant execute on function crm.set_target_service(uuid, text, text, integer, boolean) to authenticated;

create or replace function crm.set_channel_settings(
  p_channel text, p_enabled boolean, p_monthly_qualified_target integer,
  p_monthly_budget_minor bigint, p_daily_limit integer
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_channel is null or p_channel not in ('meta_ads', 'email', 'social', 'google_ads', 'b2b')
     or (p_monthly_qualified_target is not null and p_monthly_qualified_target not between 0 and 100000)
     or (p_monthly_budget_minor is not null and p_monthly_budget_minor < 0)
     or (p_daily_limit is not null and p_daily_limit not between 0 and 100000) then
    return query select 'invalid'::text; return;
  end if;

  select to_jsonb(c.*) into v_before from crm.acquisition_channels c
   where c.organization_id = v_org and c.channel = p_channel for update;

  insert into crm.acquisition_channels (organization_id, channel, enabled, monthly_qualified_target, monthly_budget_minor, daily_limit)
  values (v_org, p_channel, coalesce(p_enabled, false), p_monthly_qualified_target, p_monthly_budget_minor, p_daily_limit)
  on conflict (organization_id, channel) do update
     set enabled = coalesce(p_enabled, crm.acquisition_channels.enabled),
         monthly_qualified_target = p_monthly_qualified_target,
         monthly_budget_minor = p_monthly_budget_minor,
         daily_limit = p_daily_limit
  returning to_jsonb(crm.acquisition_channels.*) into v_after;

  perform core.record_audit(v_org, 'acquisition.channel_settings_changed', 'acquisition_channel', null, v_before, v_after);
  return query select 'saved'::text;
end;
$$;

revoke all on function crm.set_channel_settings(text, boolean, integer, bigint, integer) from public, anon;
grant execute on function crm.set_channel_settings(text, boolean, integer, bigint, integer) to authenticated;

create or replace function crm.set_channel_pause(p_channel text, p_paused boolean, p_reason text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_channel is null or p_channel not in ('meta_ads', 'email', 'social', 'google_ads', 'b2b') then
    return query select 'invalid'::text; return;
  end if;
  if coalesce(p_paused, false) and v_reason is null then
    return query select 'no_reason'::text; return;
  end if;

  select to_jsonb(c.*) into v_before from crm.acquisition_channels c
   where c.organization_id = v_org and c.channel = p_channel for update;

  if coalesce((v_before ->> 'paused')::boolean, false) = coalesce(p_paused, false) then
    return query select 'unchanged'::text; return;
  end if;

  insert into crm.acquisition_channels (organization_id, channel, paused, pause_reason, paused_by, paused_at)
  values (v_org, p_channel, coalesce(p_paused, false), case when coalesce(p_paused, false) then v_reason end,
          case when coalesce(p_paused, false) then v_actor end, case when coalesce(p_paused, false) then now() end)
  on conflict (organization_id, channel) do update
     set paused = excluded.paused, pause_reason = excluded.pause_reason,
         paused_by = excluded.paused_by, paused_at = excluded.paused_at
  returning to_jsonb(crm.acquisition_channels.*) into v_after;

  perform core.record_audit(v_org,
    case when coalesce(p_paused, false) then 'acquisition.channel_paused' else 'acquisition.channel_resumed' end,
    'acquisition_channel', null, v_before, v_after);
  return query select 'set'::text;
end;
$$;

revoke all on function crm.set_channel_pause(text, boolean, text) from public, anon;
grant execute on function crm.set_channel_pause(text, boolean, text) to authenticated;

create or replace function crm.save_icp(p_definition jsonb, p_note text)
returns table (outcome text, version integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_next  integer;
  v_key   text;
  v_score jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::integer; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::integer; return;
  end if;
  if p_definition is null or jsonb_typeof(p_definition) <> 'object' then
    return query select 'invalid'::text, null::integer; return;
  end if;
  -- Closed vocabulary: an unknown key is a typo that would silently never be
  -- read, which is worse than a refusal.
  for v_key in select jsonb_object_keys(p_definition) loop
    if v_key not in ('industries', 'geographies', 'company_sizes', 'personas', 'exclusions', 'min_qualification_score') then
      return query select 'invalid'::text, null::integer; return;
    end if;
    if v_key <> 'min_qualification_score' and jsonb_typeof(p_definition -> v_key) <> 'array' then
      return query select 'invalid'::text, null::integer; return;
    end if;
  end loop;
  v_score := p_definition -> 'min_qualification_score';
  if v_score is not null and (jsonb_typeof(v_score) <> 'number' or (v_score #>> '{}')::numeric not between 0 and 100) then
    return query select 'invalid'::text, null::integer; return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('icp:' || v_org::text, 0));
  select coalesce(max(i.version), 0) + 1 into v_next from crm.icp_versions i where i.organization_id = v_org;

  insert into crm.icp_versions (organization_id, version, definition, note, created_by)
  values (v_org, v_next, p_definition, nullif(trim(coalesce(p_note, '')), ''), v_actor);

  perform core.record_audit(v_org, 'acquisition.icp_saved', 'icp', null, null,
    jsonb_build_object('version', v_next, 'definition', p_definition));
  return query select 'saved'::text, v_next;
end;
$$;

revoke all on function crm.save_icp(jsonb, text) from public, anon;
grant execute on function crm.save_icp(jsonb, text) to authenticated;

notify pgrst, 'reload schema';
