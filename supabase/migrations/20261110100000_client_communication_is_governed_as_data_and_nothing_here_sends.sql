-- ═════════════════════════════════════════════════════════════════
-- Phase 8D: communication governance as DATA. Nothing in this file sends anything to anybody.
--
-- Phase 8 section 11 (anti-spam: gap, caps, cadence, quiet periods, preferences) was PARTIAL: only a minimum gap and consent existed. This adds the rest as
-- records an Admin sets, a ledger a person writes, and ONE deterministic read the next sender must ask first:
--
--   projects.client_communication_caps        per client (and optionally per channel): at most N person-sent contacts in a window of D days. NO default: a
--                                             client with no cap row has no cap, because no document fixes a number (ADM-22 refuses invented ones).
--   projects.client_quiet_periods             per client: a dated interval in which AgencyOS may not contact them, with a reason. Cancelling keeps the row.
--   projects.client_communication_ledger      APPEND-ONLY: what a PERSON sent, or what an AGENT drafted (a draft is never a contact and counts toward nothing),
--                                             with channel, purpose, when, by whom, and whether the read said "eligible" at the moment it was recorded.
--   projects.client_communication_events      APPEND-ONLY: delivery and reply facts recorded by a person about a sent entry (delivered, read, failed, bounced,
--                                             replied). The existing outbound-message log is only JOINED on read (crm.conversation_messages.metadata.delivery).
--   projects.can_contact_now(client, channel, purpose, contact, now)   the eligibility read: consent (crm.communication_consent; ADM-81), quiet periods,
--                                             caps, and the 8A category rules (projects.check_in_eligibility) for the client's live Phase 8 projects.
--
-- Consent: the only recorded consent channel is whatsapp (migration 20260814120008). WhatsApp needs a granted row for the contact and no withdrawal. email
-- and portal have NO consent record, so eligibility refuses them with that reason (ADM-81: every client-facing send needs recorded consent on its channel;
-- there is no exception to widen). call and meeting are made by a person, not sent by AgencyOS: consent does not apply, quiet periods and caps still do.
--
-- A person may record a true send even when the read said "no": the ledger states facts, so it never refuses to write one, it stores what the read said at
-- that moment (eligible_at_record, eligibility_reasons) so a breach is visible rather than silent.
-- ═════════════════════════════════════════════════════════════════

create or replace function projects.p8d_wire_table(p_table text, p_mutable boolean, p_history boolean)
returns void language plpgsql set search_path = '' as $$
begin
  execute format('alter table projects.%I enable row level security', p_table);
  execute format('drop policy if exists %I on projects.%I', p_table || '_read', p_table);
  execute format($p$create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, p_table || '_read', p_table);
  execute format('revoke all on projects.%I from public, anon', p_table);
  execute format('revoke insert, update, delete on projects.%I from authenticated', p_table);
  execute format('grant select on projects.%I to authenticated', p_table);
  execute format('grant all on projects.%I to service_role', p_table);
  execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || p_table, p_table);
  execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || p_table, p_table);
  if p_mutable then
    execute format('drop trigger if exists %I on projects.%I', p_table || '_updated_at', p_table);
    execute format('create trigger %I before update on projects.%I for each row execute function core.set_updated_at()', p_table || '_updated_at', p_table);
    execute format('drop trigger if exists %I on projects.%I', p_table || '_p8_guard', p_table);
    execute format('create trigger %I before update or delete on projects.%I for each row execute function projects.p8_guard_updates()', p_table || '_p8_guard', p_table);
  end if;
  if p_history then
    execute format('drop trigger if exists %I on projects.%I', p_table || '_append_only', p_table);
    execute format('create trigger %I before update or delete on projects.%I for each row execute function projects.p8_append_only()', p_table || '_append_only', p_table);
  end if;
end $$;

create or replace function projects.p8d_wire_parent(p_table text, p_col text, p_parent text)
returns void language plpgsql set search_path = '' as $$
begin
  execute format('drop trigger if exists %I on projects.%I', 'org_match_' || p_table || '_' || p_col, p_table);
  execute format('create trigger %I before insert or update on projects.%I for each row execute function core.enforce_parent_org(%L, %L)',
                 'org_match_' || p_table || '_' || p_col, p_table, p_col, p_parent);
end $$;

-- ── caps and quiet periods: Admin-set, no defaults ──────────────────────────

create table if not exists projects.client_communication_caps (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  channel           text check (channel is null or channel in ('whatsapp', 'email', 'portal', 'call', 'meeting')),
  max_contacts      int not null check (max_contacts between 1 and 1000),
  window_days       int not null check (window_days between 1 and 365),
  active            boolean not null default true,
  set_by            uuid references core.users(id) on delete set null,
  set_at            timestamptz not null default clock_timestamp(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists client_communication_caps_one_per_scope on projects.client_communication_caps (client_account_id, coalesce(channel, '*'));
comment on table projects.client_communication_caps is 'Admin-set contact cap per client (channel null = every channel): at most max_contacts person-sent contacts in window_days. No row, no cap: there is no default number.';

create table if not exists projects.client_quiet_periods (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  reason            text not null check (length(btrim(reason)) between 5 and 500),
  created_by        uuid references core.users(id) on delete set null,
  cancelled_at      timestamptz,
  cancelled_by      uuid references core.users(id) on delete set null,
  cancel_reason     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint client_quiet_periods_forward check (ends_at > starts_at),
  constraint client_quiet_periods_cancel_says_why check ((cancelled_at is null) = (cancelled_by is null) and (cancelled_at is null) = (cancel_reason is null) and (cancel_reason is null or length(btrim(cancel_reason)) >= 5))
);
create index if not exists client_quiet_periods_client_idx on projects.client_quiet_periods (client_account_id, starts_at);
comment on table projects.client_quiet_periods is 'A dated interval in which AgencyOS may not contact the client, set by an Admin with a reason. A cancelled period keeps its row.';

-- ── the ledger and its events: append-only ──────────────────────────────────

create table if not exists projects.client_communication_ledger (
  id                  uuid primary key default gen_random_uuid(),
  seq                 bigint generated always as identity,
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  client_account_id   uuid not null references core.client_accounts(id) on delete restrict,
  project_id          uuid references projects.projects(id) on delete restrict,
  contact_id          uuid references crm.contacts(id) on delete restrict,
  message_id          uuid references crm.conversation_messages(id) on delete restrict,
  channel             text not null check (channel in ('whatsapp', 'email', 'portal', 'call', 'meeting')),
  purpose             text not null check (purpose in ('operational', 'relationship', 'commercial')),
  entry_kind          text not null check (entry_kind in ('sent_by_person', 'drafted_by_agent')),
  summary             text not null check (length(btrim(summary)) between 5 and 1000),
  occurred_at         timestamptz not null,
  recorded_by         uuid references core.users(id) on delete restrict,
  drafted_by_agent    text check (drafted_by_agent is null or length(btrim(drafted_by_agent)) between 1 and 80),
  external_ref        text check (external_ref is null or length(btrim(external_ref)) between 1 and 200),
  eligible_at_record  boolean,
  eligibility_reasons text[] not null default '{}',
  created_at          timestamptz not null default clock_timestamp(),
  -- a send is a person's record; a draft is an agent's and is never attributed to a person
  constraint ledger_sent_is_a_persons check (entry_kind <> 'sent_by_person' or (recorded_by is not null and drafted_by_agent is null and eligible_at_record is not null)),
  constraint ledger_draft_is_an_agents check (entry_kind <> 'drafted_by_agent' or (drafted_by_agent is not null and recorded_by is null and message_id is null)),
  constraint ledger_draft_names_no_price check (entry_kind <> 'drafted_by_agent' or summary !~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off')
);
create unique index if not exists client_communication_ledger_one_external on projects.client_communication_ledger (client_account_id, channel, external_ref) where external_ref is not null;
create index if not exists client_communication_ledger_client_idx on projects.client_communication_ledger (client_account_id, occurred_at desc);
comment on table projects.client_communication_ledger is 'APPEND-ONLY. What a person sent (counts toward caps) or an agent drafted (counts toward nothing), with channel, purpose, time, author and what the eligibility read said when it was recorded. Nothing here sends.';

create table if not exists projects.client_communication_events (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  ledger_id        uuid not null references projects.client_communication_ledger(id) on delete restrict,
  event            text not null check (event in ('delivered', 'read', 'failed', 'bounced', 'replied')),
  occurred_at      timestamptz not null,
  recorded_by      uuid not null references core.users(id) on delete restrict,
  note             text check (note is null or length(btrim(note)) between 1 and 500),
  created_at       timestamptz not null default clock_timestamp()
);
create unique index if not exists client_communication_events_once on projects.client_communication_events (ledger_id, event) where event <> 'replied';
create index if not exists client_communication_events_ledger_idx on projects.client_communication_events (ledger_id, occurred_at, seq);
comment on table projects.client_communication_events is 'APPEND-ONLY delivery / reply facts a person recorded about a sent ledger entry. The existing outbound-message log is joined on read, never written here.';

do $$
declare r record;
begin
  for r in select * from (values
    ('client_communication_caps', 'client_account_id', 'core.client_accounts'),
    ('client_quiet_periods', 'client_account_id', 'core.client_accounts'),
    ('client_communication_ledger', 'client_account_id', 'core.client_accounts'),
    ('client_communication_ledger', 'project_id', 'projects.projects'),
    ('client_communication_ledger', 'contact_id', 'crm.contacts'),
    ('client_communication_ledger', 'message_id', 'crm.conversation_messages'),
    ('client_communication_events', 'ledger_id', 'projects.client_communication_ledger')
  ) as t(tbl, col, parent) loop
    perform projects.p8d_wire_parent(r.tbl, r.col, r.parent);
  end loop;
  perform projects.p8d_wire_table('client_communication_caps', true, false);
  perform projects.p8d_wire_table('client_quiet_periods', true, false);
  perform projects.p8d_wire_table('client_communication_ledger', false, true);
  perform projects.p8d_wire_table('client_communication_events', false, true);
end $$;

-- ── the eligibility read ────────────────────────────────────────────────────

create or replace function projects.can_contact_now(
  p_client_account_id uuid, p_channel text, p_purpose text default 'relationship', p_contact_id uuid default null, p_now timestamptz default clock_timestamp())
returns table (allowed boolean, reasons text[])
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org uuid; v_status text; v_r text[] := '{}'; v_cs text; v_n int; c record; q record; w record; e record; v_granted int; v_withdrawn int;
begin
  if coalesce((select auth.role()), '') <> 'service_role' and not coalesce((select core.is_internal()), false) then return; end if;
  select a.organization_id, a.status into v_org, v_status from core.client_accounts a where a.id = p_client_account_id;
  if v_org is null then return query select false, array['the client is not known']; return; end if;
  if p_channel is null or p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select false, array['the channel is not one AgencyOS knows']; return; end if;
  if p_purpose is null or p_purpose not in ('operational', 'relationship', 'commercial') then return query select false, array['the purpose is not operational, relationship or commercial']; return; end if;
  if v_status <> 'active' then v_r := array_append(v_r, 'the client account is ' || v_status); end if;

  -- consent (ADM-70, ADM-81): whatsapp is the only channel with a consent record; email and portal have none, so nothing may be sent on them
  if p_channel = 'whatsapp' then
    if p_contact_id is not null then
      if not exists (select 1 from crm.contacts ct where ct.id = p_contact_id and ct.client_account_id = p_client_account_id and ct.organization_id = v_org) then
        v_r := array_append(v_r, 'that contact does not belong to this client');
      else
        select cc.status into v_cs from crm.communication_consent cc where cc.organization_id = v_org and cc.contact_id = p_contact_id and cc.channel = 'whatsapp';
        if v_cs is null then v_r := array_append(v_r, 'no WhatsApp consent is recorded for that contact');
        elsif v_cs = 'withdrawn' then v_r := array_append(v_r, 'that contact withdrew WhatsApp consent'); end if;
      end if;
    else
      select count(*) filter (where cc.status = 'granted'), count(*) filter (where cc.status = 'withdrawn') into v_granted, v_withdrawn
        from crm.communication_consent cc join crm.contacts ct on ct.id = cc.contact_id
       where ct.client_account_id = p_client_account_id and ct.organization_id = v_org and cc.organization_id = v_org and cc.channel = 'whatsapp';
      if v_withdrawn > 0 then v_r := array_append(v_r, 'a contact of this client withdrew WhatsApp consent'); end if;
      if v_granted = 0 then v_r := array_append(v_r, 'no contact of this client has recorded WhatsApp consent'); end if;
    end if;
  elsif p_channel in ('email', 'portal') then
    v_r := array_append(v_r, 'no consent record exists for ' || p_channel || ' (ADM-81): AgencyOS sends nothing on it');
  end if;

  -- quiet periods: an Admin-set interval, not cancelled, that contains now
  for q in select * from projects.client_quiet_periods qp
            where qp.client_account_id = p_client_account_id and qp.organization_id = v_org and qp.cancelled_at is null and qp.starts_at <= p_now and p_now < qp.ends_at order by qp.ends_at loop
    v_r := array_append(v_r, 'quiet period until ' || to_char(q.ends_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC: ' || q.reason);
  end loop;

  -- caps: person-sent entries inside each applicable cap's window (a draft is not a contact)
  for c in select * from projects.client_communication_caps cp
            where cp.client_account_id = p_client_account_id and cp.organization_id = v_org and cp.active and (cp.channel is null or cp.channel = p_channel) order by cp.channel nulls first loop
    select count(*) into v_n from projects.client_communication_ledger l
     where l.client_account_id = p_client_account_id and l.organization_id = v_org and l.entry_kind = 'sent_by_person'
       and l.occurred_at > p_now - make_interval(days => c.window_days) and l.occurred_at <= p_now and (c.channel is null or l.channel = c.channel);
    if v_n >= c.max_contacts then
      v_r := array_append(v_r, 'contact cap reached: ' || v_n || ' of ' || c.max_contacts || ' in ' || c.window_days || ' days' || case when c.channel is null then '' else ' on ' || c.channel end);
    end if;
  end loop;

  -- the 8A category rules (consent withdrawal, minimum gap, recovery first, open P1/P2) for each live Phase 8 project of the client
  for w in select ph.project_id, p.name from projects.phase_eight ph join projects.projects p on p.id = ph.project_id
            where ph.client_account_id = p_client_account_id and ph.organization_id = v_org and ph.state <> 'closed' order by p.name loop
    for e in select * from projects.check_in_eligibility(w.project_id, 'scheduled', p_now) x where x.category = p_purpose and not x.allowed loop
      v_r := array_append(v_r, w.name || ': ' || array_to_string(e.reasons, '; '));
    end loop;
  end loop;

  return query select cardinality(v_r) = 0, v_r;
end $$;
revoke all on function projects.can_contact_now(uuid, text, text, uuid, timestamptz) from public, anon;
grant execute on function projects.can_contact_now(uuid, text, text, uuid, timestamptz) to authenticated, service_role;

-- ── doors ───────────────────────────────────────────────────────────────────

create or replace function projects.set_client_communication_cap(p_client_account_id uuid, p_channel text, p_max_contacts int, p_window_days int)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_channel is not null and p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select 'bad_channel'::text; return; end if;
  if p_max_contacts is null or p_max_contacts < 1 or p_max_contacts > 1000 or p_window_days is null or p_window_days < 1 or p_window_days > 365 then return query select 'out_of_range'::text; return; end if;
  if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = v_org) then return query select 'not_found'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.client_communication_caps (organization_id, client_account_id, channel, max_contacts, window_days, active, set_by, set_at)
  values (v_org, p_client_account_id, p_channel, p_max_contacts, p_window_days, true, v_actor, clock_timestamp())
  on conflict (client_account_id, coalesce(channel, '*')) do update set max_contacts = excluded.max_contacts, window_days = excluded.window_days, active = true, set_by = excluded.set_by, set_at = excluded.set_at
  returning id into v_id;
  perform core.record_audit(v_org, 'client_communication.cap_set', 'client_communication_cap', v_id, null, jsonb_build_object('clientAccountId', p_client_account_id, 'channel', p_channel, 'maxContacts', p_max_contacts, 'windowDays', p_window_days));
  return query select 'set'::text;
end $$;
revoke all on function projects.set_client_communication_cap(uuid, text, int, int) from public, anon, service_role;
grant execute on function projects.set_client_communication_cap(uuid, text, int, int) to authenticated;

create or replace function projects.clear_client_communication_cap(p_client_account_id uuid, p_channel text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select cp.id into v_id from projects.client_communication_caps cp
   where cp.organization_id = v_org and cp.client_account_id = p_client_account_id and coalesce(cp.channel, '*') = coalesce(p_channel, '*') and cp.active for update;
  if v_id is null then return query select 'not_found'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.client_communication_caps set active = false, set_by = v_actor, set_at = clock_timestamp() where id = v_id;
  perform core.record_audit(v_org, 'client_communication.cap_cleared', 'client_communication_cap', v_id, null, jsonb_build_object('clientAccountId', p_client_account_id, 'channel', p_channel));
  return query select 'cleared'::text;
end $$;
revoke all on function projects.clear_client_communication_cap(uuid, text) from public, anon, service_role;
grant execute on function projects.clear_client_communication_cap(uuid, text) to authenticated;

create or replace function projects.add_client_quiet_period(p_client_account_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_reason text)
returns table (outcome text, quiet_period_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_id uuid; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text, null::uuid; return; end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then return query select 'bad_interval'::text, null::uuid; return; end if;
  if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.client_quiet_periods (organization_id, client_account_id, starts_at, ends_at, reason, created_by)
  values (v_org, p_client_account_id, p_starts_at, p_ends_at, left(v_reason, 500), v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'client_communication.quiet_period_added', 'client_quiet_period', v_id, null, jsonb_build_object('clientAccountId', p_client_account_id, 'startsAt', p_starts_at, 'endsAt', p_ends_at));
  return query select 'added'::text, v_id;
end $$;
revoke all on function projects.add_client_quiet_period(uuid, timestamptz, timestamptz, text) from public, anon, service_role;
grant execute on function projects.add_client_quiet_period(uuid, timestamptz, timestamptz, text) to authenticated;

create or replace function projects.cancel_client_quiet_period(p_quiet_period_id uuid, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_q projects.client_quiet_periods; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;
  select * into v_q from projects.client_quiet_periods qp where qp.id = p_quiet_period_id and qp.organization_id = v_org for update;
  if v_q.id is null then return query select 'not_found'::text; return; end if;
  if v_q.cancelled_at is not null then return query select 'already_cancelled'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.client_quiet_periods set cancelled_at = clock_timestamp(), cancelled_by = v_actor, cancel_reason = left(v_reason, 500) where id = v_q.id;
  perform core.record_audit(v_org, 'client_communication.quiet_period_cancelled', 'client_quiet_period', v_q.id, null, jsonb_build_object('clientAccountId', v_q.client_account_id));
  return query select 'cancelled'::text;
end $$;
revoke all on function projects.cancel_client_quiet_period(uuid, text) from public, anon, service_role;
grant execute on function projects.cancel_client_quiet_period(uuid, text) to authenticated;

-- a person records that THEY sent something (or spoke to the client). Never refused for being ineligible: it stores what the read said at that moment.
create or replace function projects.record_client_communication(
  p_client_account_id uuid, p_channel text, p_purpose text, p_summary text, p_project_id uuid default null, p_contact_id uuid default null,
  p_occurred_at timestamptz default null, p_message_id uuid default null, p_external_ref text default null)
returns table (outcome text, ledger_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_when timestamptz := coalesce(p_occurred_at, clock_timestamp());
  v_sum text := nullif(btrim(coalesce(p_summary, '')), ''); v_ref text := nullif(btrim(coalesce(p_external_ref, '')), ''); v_id uuid; v_ok boolean; v_why text[];
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_channel is null or p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select 'bad_channel'::text, null::uuid; return; end if;
  if p_purpose is null or p_purpose not in ('operational', 'relationship', 'commercial') then return query select 'bad_purpose'::text, null::uuid; return; end if;
  if v_sum is null or length(v_sum) < 5 then return query select 'summary_required'::text, null::uuid; return; end if;
  if v_when > clock_timestamp() + interval '5 minutes' then return query select 'in_the_future'::text, null::uuid; return; end if;
  if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  if v_ref is not null then
    select l.id into v_id from projects.client_communication_ledger l where l.client_account_id = p_client_account_id and l.channel = p_channel and l.external_ref = v_ref;
    if v_id is not null then return query select 'duplicate'::text, v_id; return; end if;
  end if;
  select e.allowed, e.reasons into v_ok, v_why from projects.can_contact_now(p_client_account_id, p_channel, p_purpose, p_contact_id, v_when) e;
  insert into projects.client_communication_ledger (organization_id, client_account_id, project_id, contact_id, message_id, channel, purpose, entry_kind, summary, occurred_at, recorded_by, external_ref, eligible_at_record, eligibility_reasons)
  values (v_org, p_client_account_id, p_project_id, p_contact_id, p_message_id, p_channel, p_purpose, 'sent_by_person', left(v_sum, 1000), v_when, v_actor, left(v_ref, 200), coalesce(v_ok, false), coalesce(v_why, '{}'))
  returning id into v_id;
  perform core.record_audit(v_org, 'client_communication.recorded', 'client_communication', v_id, null, jsonb_build_object('clientAccountId', p_client_account_id, 'channel', p_channel, 'purpose', p_purpose, 'eligibleAtRecord', coalesce(v_ok, false)));
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_client_communication(uuid, text, text, text, uuid, uuid, timestamptz, uuid, text) from public, anon, service_role;
grant execute on function projects.record_client_communication(uuid, text, text, text, uuid, uuid, timestamptz, uuid, text) to authenticated;

-- an agent leaves a DRAFT in the ledger (service role only). It is never a contact, is never counted and never attributed to a person.
create or replace function projects.record_agent_communication_draft(
  p_organization_id uuid, p_client_account_id uuid, p_channel text, p_purpose text, p_summary text, p_agent text, p_project_id uuid default null, p_contact_id uuid default null)
returns table (outcome text, ledger_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_sum text := nullif(btrim(coalesce(p_summary, '')), ''); v_agent text := nullif(btrim(coalesce(p_agent, '')), ''); v_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_channel is null or p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select 'bad_channel'::text, null::uuid; return; end if;
  if p_purpose is null or p_purpose not in ('operational', 'relationship', 'commercial') then return query select 'bad_purpose'::text, null::uuid; return; end if;
  if v_sum is null or length(v_sum) < 5 or v_agent is null then return query select 'summary_and_agent_required'::text, null::uuid; return; end if;
  if v_sum ~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off' then return query select 'names_a_price'::text, null::uuid; return; end if;
  if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = p_organization_id) then return query select 'not_found'::text, null::uuid; return; end if;
  insert into projects.client_communication_ledger (organization_id, client_account_id, project_id, contact_id, channel, purpose, entry_kind, summary, occurred_at, drafted_by_agent)
  values (p_organization_id, p_client_account_id, p_project_id, p_contact_id, p_channel, p_purpose, 'drafted_by_agent', left(v_sum, 1000), clock_timestamp(), left(v_agent, 80)) returning id into v_id;
  return query select 'drafted'::text, v_id;
end $$;
revoke all on function projects.record_agent_communication_draft(uuid, uuid, text, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function projects.record_agent_communication_draft(uuid, uuid, text, text, text, text, uuid, uuid) to service_role;

create or replace function projects.record_client_communication_event(p_ledger_id uuid, p_event text, p_note text default null, p_occurred_at timestamptz default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_l projects.client_communication_ledger; v_when timestamptz := coalesce(p_occurred_at, clock_timestamp()); v_n int;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_event is null or p_event not in ('delivered', 'read', 'failed', 'bounced', 'replied') then return query select 'bad_event'::text; return; end if;
  if v_when > clock_timestamp() + interval '5 minutes' then return query select 'in_the_future'::text; return; end if;
  select * into v_l from projects.client_communication_ledger l where l.id = p_ledger_id and l.organization_id = v_org;
  if v_l.id is null then return query select 'not_found'::text; return; end if;
  if v_l.entry_kind <> 'sent_by_person' then return query select 'not_a_sent_entry'::text; return; end if;
  if v_when < v_l.occurred_at then return query select 'before_the_send'::text; return; end if;
  insert into projects.client_communication_events (organization_id, ledger_id, event, occurred_at, recorded_by, note)
  values (v_org, p_ledger_id, p_event, v_when, v_actor, left(nullif(btrim(coalesce(p_note, '')), ''), 500))
  on conflict (ledger_id, event) where event <> 'replied' do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return query select 'already_recorded'::text; return; end if;
  perform core.record_audit(v_org, 'client_communication.event_recorded', 'client_communication', p_ledger_id, null, jsonb_build_object('event', p_event));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_client_communication_event(uuid, text, text, timestamptz) from public, anon, service_role;
grant execute on function projects.record_client_communication_event(uuid, text, text, timestamptz) to authenticated;

-- the history of a client's contact: the ledger with each entry's delivery / reply state. Delivery comes from a person's event, else (JOIN READ ONLY)
-- from the existing outbound-message log; absent both it is 'unknown', never 'delivered'.
create or replace function projects.client_communication_history(p_client_account_id uuid, p_limit int default 50)
returns table (id uuid, occurred_at timestamptz, channel text, purpose text, entry_kind text, summary text, project_id uuid, contact_id uuid, recorded_by uuid, drafted_by_agent text,
               eligible_at_record boolean, eligibility_reasons text[], delivery_state text, delivery_source text, replied boolean, replied_at timestamptz, external_ref text)
language sql stable security invoker set search_path = '' as $$
  select l.id, l.occurred_at, l.channel, l.purpose, l.entry_kind, l.summary, l.project_id, l.contact_id, l.recorded_by, l.drafted_by_agent, l.eligible_at_record, l.eligibility_reasons,
         case when l.entry_kind = 'drafted_by_agent' then 'not_sent'
              else coalesce(ev.event, nullif(m.metadata ->> 'delivery', ''), 'unknown') end,
         case when l.entry_kind = 'drafted_by_agent' then 'none' when ev.event is not null then 'person' when nullif(m.metadata ->> 'delivery', '') is not null then 'message_log' else 'none' end,
         rp.occurred_at is not null, rp.occurred_at, l.external_ref
    from projects.client_communication_ledger l
    left join lateral (select e.event from projects.client_communication_events e where e.ledger_id = l.id and e.event <> 'replied' order by e.occurred_at desc, e.seq desc limit 1) ev on true
    left join lateral (select e.occurred_at from projects.client_communication_events e where e.ledger_id = l.id and e.event = 'replied' order by e.occurred_at limit 1) rp on true
    left join crm.conversation_messages m on m.id = l.message_id
   where l.client_account_id = p_client_account_id
     and (coalesce((select auth.role()), '') = 'service_role' or (select core.is_internal()))
   order by l.occurred_at desc, l.seq desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke all on function projects.client_communication_history(uuid, int) from public, anon;
grant execute on function projects.client_communication_history(uuid, int) to authenticated, service_role;

drop function if exists projects.p8d_wire_table(text, boolean, boolean);
drop function if exists projects.p8d_wire_parent(text, text, text);

notify pgrst, 'reload schema';
