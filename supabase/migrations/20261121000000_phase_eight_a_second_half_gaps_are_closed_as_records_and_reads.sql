-- ═════════════════════════════════════════════════════════════════
-- Phase 8A, second half of the traceability gaps (docs/phase-8a-gaps-log-2.md). Everything here is a record, a read or a door; nothing sends, quotes, prices
-- or discounts, and nothing here fakes a provider, a client or an Admin.
--
--   1. support_ticket_events.correlation_id   P8-SEC-004: every ticket event carries the id of the unit of work that wrote it (a transaction id unless the caller
--                                             set projects.correlation_id), so the events of one door call are provably one thing. Old rows stay NULL (honest).
--   2. projects.probe_tenant_access           E2E-13: a lookup that names a record of ANOTHER tenant answers exactly like a missing one ('not_available') and
--                                             writes an audit row 'access.cross_tenant_denied' in the CALLER's organization. The denial is now audited.
--   3. client_contact_preferences             preferred channel, channels to avoid and language, recorded by a person (CS spec section 3, UPS-TST-007).
--   4. communication_category_cadence         an Admin-set minimum gap per message category (operational / relationship / commercial). No default number.
--      projects.can_contact_governed          can_contact_now plus the avoided channels and the category cadence.
--   5. client_feedback, client_goals          feedback a person heard (append-only), and the goals the client stated (CS spec section 5).
--   6. projects.request_support_followup      SUP spec section 7: a person asks for a Developer task or a QA verification; an outbox event carries the payload.
--                                             No Developer task is created here: the event is the request.
--   7. projects.customer_success_next_actions the next-action queue, DERIVED on read from the live records (no queue object is stored).
--   8. client_communication_provider_events   delivery facts from a provider callback (service role only) and projects.record_provider_delivery_callback. The
--                                             HTTP route that would verify a provider signature is NOT built (it needs the provider's secret): see the log.
--   9. projects.reconcile_phase_eight_metrics E2E-14: the observability counts and the overview are reconciled and every disagreement is returned, not hidden.
-- ═════════════════════════════════════════════════════════════════

create or replace function projects.p8f_wire_table(p_table text, p_mutable boolean, p_history boolean)
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

create or replace function projects.p8f_wire_parent(p_table text, p_col text, p_parent text)
returns void language plpgsql set search_path = '' as $$
begin
  execute format('drop trigger if exists %I on projects.%I', 'org_match_' || p_table || '_' || p_col, p_table);
  execute format('create trigger %I before insert or update on projects.%I for each row execute function core.enforce_parent_org(%L, %L)',
                 'org_match_' || p_table || '_' || p_col, p_table, p_col, p_parent);
end $$;

-- ── 1. a correlation id on every ticket event ───────────────────────────────

create or replace function projects.p8_correlation_id()
returns text language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('projects.correlation_id', true), ''), 'tx-' || txid_current()::text)
$$;
revoke all on function projects.p8_correlation_id() from public, anon;
grant execute on function projects.p8_correlation_id() to authenticated, service_role;

alter table projects.support_ticket_events add column if not exists correlation_id text;
alter table projects.support_ticket_events alter column correlation_id set default projects.p8_correlation_id();
create index if not exists support_ticket_events_correlation_idx on projects.support_ticket_events (correlation_id) where correlation_id is not null;
comment on column projects.support_ticket_events.correlation_id is 'The unit of work that wrote the event: projects.correlation_id when the caller set it, else the transaction id. Rows older than this column are NULL (not backfilled with a guess).';

-- two more event kinds: a person asked for a Developer task or a QA verification
alter table projects.support_ticket_events drop constraint if exists support_ticket_events_kind_check;
alter table projects.support_ticket_events add constraint support_ticket_events_kind_check check (kind in (
  'opened', 'classified', 'assigned', 'linked', 'state_changed', 'escalated', 'escalation_acknowledged', 'proposal_recorded',
  'reply_drafted', 'reply_sent', 'reply_discarded', 'client_confirmed', 'client_rejected', 'sla_breach', 'cancelled', 'developer_requested', 'qa_requested'));

-- ── 2. a cross-tenant lookup is denied the same way as a missing one, and the denial is audited ──

create or replace function projects.probe_tenant_access(p_subject_type text, p_subject_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_home boolean := false; v_elsewhere boolean := false;
begin
  if v_actor is null or v_org is null or p_subject_id is null then return query select 'not_available'::text; return; end if;
  if p_subject_type = 'project' then
    select coalesce(bool_or(x.organization_id = v_org), false), coalesce(bool_or(x.organization_id <> v_org), false) into v_home, v_elsewhere from projects.projects x where x.id = p_subject_id;
  elsif p_subject_type = 'client_account' then
    select coalesce(bool_or(x.organization_id = v_org), false), coalesce(bool_or(x.organization_id <> v_org), false) into v_home, v_elsewhere from core.client_accounts x where x.id = p_subject_id;
  elsif p_subject_type = 'support_ticket' then
    select coalesce(bool_or(x.organization_id = v_org), false), coalesce(bool_or(x.organization_id <> v_org), false) into v_home, v_elsewhere from projects.support_tickets x where x.id = p_subject_id;
  else
    return query select 'not_available'::text; return;
  end if;
  if v_home then return query select 'granted'::text; return; end if;
  -- the caller learns nothing: absent and foreign both answer 'not_available'. A foreign one is written to the CALLER's audit trail.
  if v_elsewhere then
    perform core.record_audit(v_org, 'access.cross_tenant_denied', p_subject_type, p_subject_id, null, jsonb_build_object('actor', v_actor, 'subjectType', p_subject_type));
  end if;
  return query select 'not_available'::text;
end $$;
revoke all on function projects.probe_tenant_access(text, uuid) from public, anon, service_role;
grant execute on function projects.probe_tenant_access(text, uuid) to authenticated;

-- ── 3. what the client said about how to be reached ─────────────────────────

create table if not exists projects.client_contact_preferences (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  preferred_channel text check (preferred_channel is null or preferred_channel in ('whatsapp', 'email', 'portal', 'call', 'meeting')),
  avoid_channels    text[] not null default '{}' check (avoid_channels <@ array['whatsapp', 'email', 'portal', 'call', 'meeting']),
  language          text check (language is null or language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  note              text check (note is null or length(btrim(note)) between 1 and 500),
  recorded_by       uuid references core.users(id) on delete set null,
  recorded_at       timestamptz not null default clock_timestamp(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (client_account_id),
  constraint client_contact_preferences_not_both check (preferred_channel is null or not (preferred_channel = any (avoid_channels)))
);
comment on table projects.client_contact_preferences is 'What a person recorded the client said about being reached: preferred channel, channels to avoid, language. Avoided channels are enforced by projects.can_contact_governed; the rest is advisory.';

create table if not exists projects.communication_category_cadence (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  purpose          text not null check (purpose in ('operational', 'relationship', 'commercial')),
  min_gap_days     int not null check (min_gap_days between 0 and 365),
  active           boolean not null default true,
  set_by           uuid references core.users(id) on delete set null,
  set_at           timestamptz not null default clock_timestamp(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, purpose)
);
comment on table projects.communication_category_cadence is 'Admin-set minimum days between two person-sent contacts of the same category to one client. No row, no rule: there is no default number (ADM-22).';

-- ── 5. feedback and goals ───────────────────────────────────────────────────

create table if not exists projects.client_feedback (
  id                uuid primary key default gen_random_uuid(),
  seq               bigint generated always as identity,
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  source            text not null check (source in ('call', 'whatsapp', 'email', 'portal', 'meeting', 'survey')),
  sentiment         text not null check (sentiment in ('positive', 'neutral', 'negative', 'mixed')),
  summary           text not null check (length(btrim(summary)) between 5 and 2000),
  check_in_id       uuid references projects.cs_check_ins(id) on delete set null,
  occurred_at       timestamptz not null,
  recorded_by       uuid not null references core.users(id) on delete restrict,
  created_at        timestamptz not null default clock_timestamp()
);
create index if not exists client_feedback_project_idx on projects.client_feedback (project_id, occurred_at desc);
comment on table projects.client_feedback is 'APPEND-ONLY. Feedback a PERSON heard from the client: source, sentiment, what was said. Nothing here is a score and nothing infers sentiment.';

create table if not exists projects.client_goals (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  goal              text not null check (length(btrim(goal)) between 5 and 1000),
  status            text not null default 'active' check (status in ('active', 'achieved', 'dropped')),
  recorded_by       uuid not null references core.users(id) on delete restrict,
  status_note       text check (status_note is null or length(btrim(status_note)) between 1 and 500),
  closed_by         uuid references core.users(id) on delete set null,
  closed_at         timestamptz,
  created_at        timestamptz not null default clock_timestamp(),
  updated_at        timestamptz not null default now(),
  constraint client_goals_closed_says_who check ((status = 'active') = (closed_at is null and closed_by is null))
);
create index if not exists client_goals_project_idx on projects.client_goals (project_id, status);
comment on table projects.client_goals is 'A goal the client stated, recorded by a person; achieved or dropped by a person with the date. Changed only through its doors.';

-- ── 8. provider delivery facts ──────────────────────────────────────────────

create table if not exists projects.client_communication_provider_events (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  ledger_id        uuid not null references projects.client_communication_ledger(id) on delete restrict,
  provider         text not null check (length(btrim(provider)) between 1 and 60),
  event            text not null check (event in ('delivered', 'read', 'failed', 'bounced')),
  occurred_at      timestamptz not null,
  received_at      timestamptz not null default clock_timestamp()
);
create unique index if not exists client_communication_provider_events_once on projects.client_communication_provider_events (ledger_id, provider, event);
comment on table projects.client_communication_provider_events is 'APPEND-ONLY delivery facts received from a messaging provider callback (service role). The route that verifies the provider signature is not built; until it is, nothing writes here in production.';

do $$
declare r record;
begin
  for r in select * from (values
    ('client_contact_preferences', 'client_account_id', 'core.client_accounts'),
    ('client_feedback', 'project_id', 'projects.projects'),
    ('client_feedback', 'client_account_id', 'core.client_accounts'),
    ('client_feedback', 'check_in_id', 'projects.cs_check_ins'),
    ('client_goals', 'project_id', 'projects.projects'),
    ('client_goals', 'client_account_id', 'core.client_accounts'),
    ('client_communication_provider_events', 'ledger_id', 'projects.client_communication_ledger')
  ) as t(tbl, col, parent) loop
    perform projects.p8f_wire_parent(r.tbl, r.col, r.parent);
  end loop;
  perform projects.p8f_wire_table('client_contact_preferences', true, false);
  perform projects.p8f_wire_table('communication_category_cadence', true, false);
  perform projects.p8f_wire_table('client_feedback', false, true);
  perform projects.p8f_wire_table('client_goals', true, false);
  perform projects.p8f_wire_table('client_communication_provider_events', false, true);
end $$;

insert into core.event_types (type, description, canonical) values
  ('support.developer_task_requested', 'A person asked for a Developer task on a support ticket. Carries ids, classification, coverage and priority; no Developer task is created by this event.', true),
  ('support.qa_verification_requested', 'A person asked for a QA verification of a support ticket fix. Carries ids, classification, coverage and priority; the verification itself is the existing QA flow.', true)
on conflict (type) do nothing;

-- ── 3. the preference door ──────────────────────────────────────────────────

create or replace function projects.set_client_contact_preference(p_client_account_id uuid, p_preferred_channel text, p_avoid_channels text[], p_language text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_avoid text[] := coalesce(p_avoid_channels, '{}');
  v_lang text := nullif(btrim(coalesce(p_language, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_preferred_channel is not null and p_preferred_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select 'bad_channel'::text; return; end if;
  if not (v_avoid <@ array['whatsapp', 'email', 'portal', 'call', 'meeting']) then return query select 'bad_channel'::text; return; end if;
  if p_preferred_channel is not null and p_preferred_channel = any (v_avoid) then return query select 'preferred_is_avoided'::text; return; end if;
  if v_lang is not null and v_lang !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' then return query select 'bad_language'::text; return; end if;
  if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = v_org) then return query select 'not_found'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.client_contact_preferences (organization_id, client_account_id, preferred_channel, avoid_channels, language, note, recorded_by, recorded_at)
  values (v_org, p_client_account_id, p_preferred_channel, (select coalesce(array_agg(distinct c order by c), '{}') from unnest(v_avoid) c), v_lang, left(v_note, 500), v_actor, clock_timestamp())
  on conflict (client_account_id) do update set preferred_channel = excluded.preferred_channel, avoid_channels = excluded.avoid_channels, language = excluded.language,
    note = excluded.note, recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at
  returning id into v_id;
  perform core.record_audit(v_org, 'client_communication.preference_set', 'client_contact_preference', v_id, null,
    jsonb_build_object('clientAccountId', p_client_account_id, 'preferredChannel', p_preferred_channel, 'avoidChannels', v_avoid, 'language', v_lang));
  return query select 'set'::text;
end $$;
revoke all on function projects.set_client_contact_preference(uuid, text, text[], text, text) from public, anon, service_role;
grant execute on function projects.set_client_contact_preference(uuid, text, text[], text, text) to authenticated;

-- ── 4. the cadence doors (Admin only) and the governed eligibility read ─────

create or replace function projects.set_communication_category_cadence(p_purpose text, p_min_gap_days int)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_purpose is null or p_purpose not in ('operational', 'relationship', 'commercial') then return query select 'bad_purpose'::text; return; end if;
  if p_min_gap_days is null or p_min_gap_days < 0 or p_min_gap_days > 365 then return query select 'out_of_range'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.communication_category_cadence (organization_id, purpose, min_gap_days, active, set_by, set_at)
  values (v_org, p_purpose, p_min_gap_days, true, v_actor, clock_timestamp())
  on conflict (organization_id, purpose) do update set min_gap_days = excluded.min_gap_days, active = true, set_by = excluded.set_by, set_at = excluded.set_at
  returning id into v_id;
  perform core.record_audit(v_org, 'client_communication.cadence_set', 'communication_category_cadence', v_id, null, jsonb_build_object('purpose', p_purpose, 'minGapDays', p_min_gap_days));
  return query select 'set'::text;
end $$;
revoke all on function projects.set_communication_category_cadence(text, int) from public, anon, service_role;
grant execute on function projects.set_communication_category_cadence(text, int) to authenticated;

create or replace function projects.clear_communication_category_cadence(p_purpose text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select c.id into v_id from projects.communication_category_cadence c where c.organization_id = v_org and c.purpose = p_purpose and c.active for update;
  if v_id is null then return query select 'not_found'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.communication_category_cadence set active = false, set_by = v_actor, set_at = clock_timestamp() where id = v_id;
  perform core.record_audit(v_org, 'client_communication.cadence_cleared', 'communication_category_cadence', v_id, null, jsonb_build_object('purpose', p_purpose));
  return query select 'cleared'::text;
end $$;
revoke all on function projects.clear_communication_category_cadence(text) from public, anon, service_role;
grant execute on function projects.clear_communication_category_cadence(text) to authenticated;

create or replace function projects.can_contact_governed(
  p_client_account_id uuid, p_channel text, p_purpose text default 'relationship', p_contact_id uuid default null, p_now timestamptz default clock_timestamp())
returns table (allowed boolean, reasons text[])
language plpgsql stable security invoker set search_path = '' as $$
declare v_ok boolean; v_r text[]; v_org uuid; v_avoid text[]; c record; v_last timestamptz;
begin
  select b.allowed, b.reasons into v_ok, v_r from projects.can_contact_now(p_client_account_id, p_channel, p_purpose, p_contact_id, p_now) b;
  if v_ok is null then return; end if;   -- not an internal caller, or the client is not visible: nothing is said
  select a.organization_id into v_org from core.client_accounts a where a.id = p_client_account_id;
  if v_org is null then return query select v_ok, v_r; return; end if;

  select p.avoid_channels into v_avoid from projects.client_contact_preferences p where p.client_account_id = p_client_account_id and p.organization_id = v_org;
  if v_avoid is not null and p_channel = any (v_avoid) then
    v_r := array_append(v_r, 'the client asked not to be contacted on ' || p_channel);
  end if;

  select * into c from projects.communication_category_cadence cc where cc.organization_id = v_org and cc.purpose = p_purpose and cc.active;
  if c.id is not null then
    select max(l.occurred_at) into v_last from projects.client_communication_ledger l
     where l.client_account_id = p_client_account_id and l.organization_id = v_org and l.entry_kind = 'sent_by_person' and l.purpose = p_purpose and l.occurred_at <= p_now;
    if v_last is not null and v_last > p_now - make_interval(days => c.min_gap_days) then
      v_r := array_append(v_r, 'category gap: the last ' || p_purpose || ' contact was ' || floor(extract(epoch from (p_now - v_last)) / 86400)::int || ' days ago; the minimum is ' || c.min_gap_days);
    end if;
  end if;
  return query select cardinality(v_r) = 0, v_r;
end $$;
revoke all on function projects.can_contact_governed(uuid, text, text, uuid, timestamptz) from public, anon;
grant execute on function projects.can_contact_governed(uuid, text, text, uuid, timestamptz) to authenticated, service_role;

-- ── 5. feedback and goal doors ──────────────────────────────────────────────

create or replace function projects.record_client_feedback(p_project_id uuid, p_source text, p_sentiment text, p_summary text, p_check_in_id uuid default null, p_occurred_at timestamptz default null)
returns table (outcome text, feedback_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_when timestamptz := coalesce(p_occurred_at, clock_timestamp());
  v_sum text := nullif(btrim(coalesce(p_summary, '')), ''); v_ph projects.phase_eight; v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_source is null or p_source not in ('call', 'whatsapp', 'email', 'portal', 'meeting', 'survey') then return query select 'bad_source'::text, null::uuid; return; end if;
  if p_sentiment is null or p_sentiment not in ('positive', 'neutral', 'negative', 'mixed') then return query select 'bad_sentiment'::text, null::uuid; return; end if;
  if v_sum is null or length(v_sum) < 5 then return query select 'summary_required'::text, null::uuid; return; end if;
  if v_when > clock_timestamp() + interval '5 minutes' then return query select 'in_the_future'::text, null::uuid; return; end if;
  select * into v_ph from projects.phase_eight w where w.project_id = p_project_id and w.organization_id = v_org;
  if v_ph.project_id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if p_check_in_id is not null and not exists (select 1 from projects.cs_check_ins c where c.id = p_check_in_id and c.project_id = p_project_id and c.organization_id = v_org) then
    return query select 'check_in_not_on_this_project'::text, null::uuid; return;
  end if;
  insert into projects.client_feedback (organization_id, project_id, client_account_id, source, sentiment, summary, check_in_id, occurred_at, recorded_by)
  values (v_org, p_project_id, v_ph.client_account_id, p_source, p_sentiment, left(v_sum, 2000), p_check_in_id, v_when, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'customer_success.feedback_recorded', 'client_feedback', v_id, null, jsonb_build_object('projectId', p_project_id, 'sentiment', p_sentiment, 'source', p_source));
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_client_feedback(uuid, text, text, text, uuid, timestamptz) from public, anon, service_role;
grant execute on function projects.record_client_feedback(uuid, text, text, text, uuid, timestamptz) to authenticated;

create or replace function projects.record_client_goal(p_project_id uuid, p_goal text)
returns table (outcome text, goal_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_g text := nullif(btrim(coalesce(p_goal, '')), ''); v_ph projects.phase_eight; v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if v_g is null or length(v_g) < 5 then return query select 'goal_required'::text, null::uuid; return; end if;
  select * into v_ph from projects.phase_eight w where w.project_id = p_project_id and w.organization_id = v_org;
  if v_ph.project_id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if exists (select 1 from projects.client_goals g where g.project_id = p_project_id and g.status = 'active' and lower(btrim(g.goal)) = lower(v_g)) then
    return query select 'duplicate'::text, (select g.id from projects.client_goals g where g.project_id = p_project_id and g.status = 'active' and lower(btrim(g.goal)) = lower(v_g) limit 1); return;
  end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.client_goals (organization_id, project_id, client_account_id, goal, recorded_by) values (v_org, p_project_id, v_ph.client_account_id, left(v_g, 1000), v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'customer_success.goal_recorded', 'client_goal', v_id, null, jsonb_build_object('projectId', p_project_id));
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_client_goal(uuid, text) from public, anon, service_role;
grant execute on function projects.record_client_goal(uuid, text) to authenticated;

create or replace function projects.close_client_goal(p_goal_id uuid, p_status text, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_g projects.client_goals;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_status is null or p_status not in ('achieved', 'dropped') then return query select 'bad_status'::text; return; end if;
  if v_note is null then return query select 'note_required'::text; return; end if;
  select * into v_g from projects.client_goals g where g.id = p_goal_id and g.organization_id = v_org for update;
  if v_g.id is null then return query select 'not_found'::text; return; end if;
  if v_g.status <> 'active' then return query select 'already_closed'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.client_goals set status = p_status, status_note = left(v_note, 500), closed_by = v_actor, closed_at = clock_timestamp() where id = v_g.id;
  perform core.record_audit(v_org, 'customer_success.goal_closed', 'client_goal', v_g.id, null, jsonb_build_object('projectId', v_g.project_id, 'status', p_status));
  return query select 'closed'::text;
end $$;
revoke all on function projects.close_client_goal(uuid, text, text) from public, anon, service_role;
grant execute on function projects.close_client_goal(uuid, text, text) to authenticated;

-- ── 6. a person asks for a Developer task or a QA verification ──────────────

create or replace function projects.request_support_followup(p_ticket_id uuid, p_kind text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_t projects.support_tickets; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_ev text;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_kind is null or p_kind not in ('developer', 'qa') then return query select 'bad_kind'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = v_org for update;
  if v_t.id is null then return query select 'not_found'::text; return; end if;
  if v_t.classification is null or v_t.coverage_decision is null then return query select 'not_classified'::text; return; end if;
  if p_kind = 'developer' then
    -- a how-to or a thing the client has not been told is covered never becomes a Developer task
    if v_t.classification not in ('warranty_bug', 'maintenance', 'minor_change') or v_t.coverage_decision not in ('covered_warranty', 'covered_maintenance', 'included_support') then
      return query select 'not_a_developer_matter'::text; return;
    end if;
    if v_t.status not in ('classified', 'assigned', 'in_progress') then return query select 'wrong_state'::text; return; end if;
  else
    if v_t.status not in ('in_progress', 'in_qa') then return query select 'wrong_state'::text; return; end if;
  end if;
  v_ev := case p_kind when 'developer' then 'developer_requested' else 'qa_requested' end;
  if exists (select 1 from projects.support_ticket_events e where e.ticket_id = v_t.id and e.kind = v_ev) then return query select 'already_requested'::text; return; end if;
  perform projects.p8_ticket_event(v_org, v_t.id, v_ev, v_t.status, v_t.status, v_actor, 'person', coalesce(v_note, p_kind || ' follow-up requested'), null, null);
  perform core.emit_event(v_org, case p_kind when 'developer' then 'support.developer_task_requested' else 'support.qa_verification_requested' end, 'support_ticket', v_t.id,
    jsonb_build_object('projectId', v_t.project_id, 'ticketId', v_t.id, 'ticketRef', v_t.ticket_ref, 'classification', v_t.classification, 'coverage', v_t.coverage_decision,
                       'priority', v_t.priority, 'defectId', v_t.defect_id, 'maintenanceItemId', v_t.maintenance_item_id, 'requestedBy', v_actor, 'note', left(v_note, 500)));
  return query select 'requested'::text;
end $$;
revoke all on function projects.request_support_followup(uuid, text, text) from public, anon, service_role;
grant execute on function projects.request_support_followup(uuid, text, text) to authenticated;

-- ── 7. the next-action queue: derived, never stored ─────────────────────────

create or replace function projects.customer_success_next_actions(p_now timestamptz default clock_timestamp())
returns table (action_kind text, project_id uuid, project_name text, ref_id uuid, due_at timestamptz, priority int, summary text)
language plpgsql stable security invoker set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  with live as (select w.project_id, p.name from projects.phase_eight w join projects.projects p on p.id = w.project_id where w.organization_id = v_org and w.state <> 'closed'),
  acts as (
    select 'escalation_unacknowledged'::text k, t.project_id, t.id ref, t.escalated_at due, 1 pr, t.ticket_ref || ' was escalated to ' || t.escalated_to_role || ' and nobody has acknowledged it' s
      from projects.support_tickets t where t.organization_id = v_org and t.status not in ('closed', 'cancelled') and t.escalated_at is not null and t.escalation_ack_at is null
    union all
    select 'ticket_resolution_overdue', t.project_id, t.id, t.resolution_due_at, 2, t.ticket_ref || ' passed its resolution target'
      from projects.support_tickets t where t.organization_id = v_org and t.status not in ('closed', 'cancelled') and t.resolution_due_at is not null and t.resolution_due_at < p_now
    union all
    select 'ticket_response_overdue', t.project_id, t.id, t.response_due_at, 2, t.ticket_ref || ' passed its response target with no first response'
      from projects.support_tickets t where t.organization_id = v_org and t.status not in ('closed', 'cancelled') and t.first_response_at is null and t.response_due_at is not null and t.response_due_at < p_now
    union all
    select 'negative_feedback_unaddressed', f.project_id, f.id, f.occurred_at, 3, 'negative client feedback with no completed check-in since'
      from projects.client_feedback f
     where f.organization_id = v_org and f.sentiment in ('negative', 'mixed') and f.occurred_at > p_now - interval '30 days'
       and not exists (select 1 from projects.cs_check_ins c where c.project_id = f.project_id and c.status = 'completed' and c.completed_at > f.occurred_at)
    union all
    select 'recovery_plan_open', r.project_id, r.id, r.deadline::timestamptz, 3, 'a recovery plan is ' || r.status
      from projects.recovery_plans r where r.organization_id = v_org and r.status in ('open', 'in_progress')
    union all
    select 'check_in_due', c.project_id, c.id, c.due_on::timestamptz, 4, c.kind || ' check-in is due'
      from projects.cs_check_ins c where c.organization_id = v_org and c.status = 'due' and c.due_on <= (p_now at time zone 'UTC')::date
    union all
    select 'renewal_review', m.project_id, m.id, m.ends_on::timestamptz, 4, 'the maintenance plan is ' || m.status
      from projects.maintenance_plans m where m.organization_id = v_org and m.status in ('renewal_approaching', 'expired')
    union all
    select 'opportunity_to_qualify', o.project_id, o.id, o.created_at, 5, 'a detected opportunity waits for a person to qualify it'
      from sales.phase_eight_opportunities o where o.organization_id = v_org and o.status = 'detected'
  )
  select a.k, a.project_id, l.name, a.ref, a.due, a.pr, a.s
    from acts a join live l on l.project_id = a.project_id
   order by a.pr, a.due nulls last, l.name
   limit 500;
end $$;
revoke all on function projects.customer_success_next_actions(timestamptz) from public, anon, service_role;
grant execute on function projects.customer_success_next_actions(timestamptz) to authenticated;

-- ── 8. the provider callback door (service role) and history that reads it ──

create or replace function projects.record_provider_delivery_callback(p_organization_id uuid, p_provider text, p_channel text, p_external_ref text, p_event text, p_occurred_at timestamptz default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_provider text := nullif(btrim(coalesce(p_provider, '')), ''); v_ref text := nullif(btrim(coalesce(p_external_ref, '')), ''); v_l projects.client_communication_ledger;
        v_when timestamptz := coalesce(p_occurred_at, clock_timestamp()); v_n int;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  if v_provider is null or v_ref is null then return query select 'provider_and_ref_required'::text; return; end if;
  if p_event is null or p_event not in ('delivered', 'read', 'failed', 'bounced') then return query select 'bad_event'::text; return; end if;
  if v_when > clock_timestamp() + interval '5 minutes' then return query select 'in_the_future'::text; return; end if;
  select count(*) into v_n from projects.client_communication_ledger l
   where l.organization_id = p_organization_id and l.channel = p_channel and l.external_ref = v_ref and l.entry_kind = 'sent_by_person';
  if v_n > 1 then return query select 'ambiguous'::text; return; end if;
  select * into v_l from projects.client_communication_ledger l
   where l.organization_id = p_organization_id and l.channel = p_channel and l.external_ref = v_ref and l.entry_kind = 'sent_by_person';
  if v_l.id is null then return query select 'unmatched'::text; return; end if;
  if v_when < v_l.occurred_at then return query select 'before_the_send'::text; return; end if;
  insert into projects.client_communication_provider_events (organization_id, ledger_id, provider, event, occurred_at)
  values (p_organization_id, v_l.id, left(v_provider, 60), p_event, v_when) on conflict (ledger_id, provider, event) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return query select 'already_recorded'::text; return; end if;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_provider_delivery_callback(uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function projects.record_provider_delivery_callback(uuid, text, text, text, text, timestamptz) to service_role;

-- the history now also reads a provider fact: a person's record first, then the provider, then the message log, else 'unknown' (never 'delivered' by default)
create or replace function projects.client_communication_history(p_client_account_id uuid, p_limit int default 50)
returns table (id uuid, occurred_at timestamptz, channel text, purpose text, entry_kind text, summary text, project_id uuid, contact_id uuid, recorded_by uuid, drafted_by_agent text,
               eligible_at_record boolean, eligibility_reasons text[], delivery_state text, delivery_source text, replied boolean, replied_at timestamptz, external_ref text)
language sql stable security invoker set search_path = '' as $$
  select l.id, l.occurred_at, l.channel, l.purpose, l.entry_kind, l.summary, l.project_id, l.contact_id, l.recorded_by, l.drafted_by_agent, l.eligible_at_record, l.eligibility_reasons,
         case when l.entry_kind = 'drafted_by_agent' then 'not_sent'
              else coalesce(ev.event, pv.event, nullif(m.metadata ->> 'delivery', ''), 'unknown') end,
         case when l.entry_kind = 'drafted_by_agent' then 'none' when ev.event is not null then 'person' when pv.event is not null then 'provider'
              when nullif(m.metadata ->> 'delivery', '') is not null then 'message_log' else 'none' end,
         rp.occurred_at is not null, rp.occurred_at, l.external_ref
    from projects.client_communication_ledger l
    left join lateral (select e.event from projects.client_communication_events e where e.ledger_id = l.id and e.event <> 'replied' order by e.occurred_at desc, e.seq desc limit 1) ev on true
    left join lateral (select e.event from projects.client_communication_provider_events e where e.ledger_id = l.id order by e.occurred_at desc, e.seq desc limit 1) pv on true
    left join lateral (select e.occurred_at from projects.client_communication_events e where e.ledger_id = l.id and e.event = 'replied' order by e.occurred_at limit 1) rp on true
    left join crm.conversation_messages m on m.id = l.message_id
   where l.client_account_id = p_client_account_id
     and (coalesce((select auth.role()), '') = 'service_role' or (select core.is_internal()))
   order by l.occurred_at desc, l.seq desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke all on function projects.client_communication_history(uuid, int) from public, anon;
grant execute on function projects.client_communication_history(uuid, int) to authenticated, service_role;

-- ── 9. the metrics are reconciled, and a disagreement is returned ───────────

create or replace function projects.reconcile_phase_eight_metrics(p_now timestamptz default clock_timestamp())
returns table (check_name text, observability_value int, overview_value int, reconciled boolean, note text)
language plpgsql stable security invoker set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  with o as (select * from projects.phase_eight_observability(p_now)),
       v as (select * from projects.customer_success_overview(p_now)),
       x as (
    select 'open_tickets_state_vs_resolution_sla'::text c, (select coalesce(sum(n), 0)::int from o where metric = 'tickets_by_state' and bucket not in ('closed', 'cancelled')) a,
           (select coalesce(sum(n), 0)::int from o where metric = 'tickets_by_sla') b, 'two groupings of the same open tickets'::text note
    union all
    select 'open_tickets_state_vs_response_sla', (select coalesce(sum(n), 0)::int from o where metric = 'tickets_by_state' and bucket not in ('closed', 'cancelled')),
           (select coalesce(sum(n), 0)::int from o where metric = 'tickets_by_response_sla'), 'two groupings of the same open tickets'
    union all
    select 'live_accounts_health_vs_overview', (select coalesce(sum(n), 0)::int from o where metric = 'health_distribution'), (select count(*)::int from v),
           'one health row per live workspace in both'
    union all
    select 'health_' || s.status || '_vs_overview', (select coalesce(sum(n), 0)::int from o where metric = 'health_distribution' and bucket = s.status),
           (select count(*)::int from v where v.health_status = s.status), 'per derived health status'
      from (values ('healthy'), ('stable'), ('watch'), ('at_risk'), ('critical')) s(status)
    union all
    select 'recovery_plans_vs_overview', (select coalesce(sum(n), 0)::int from o where metric = 'recovery_plans'), (select coalesce(sum(v.open_recovery_plans), 0)::int from v),
           'observability counts every open plan of the organization; the overview only plans of live workspaces: a difference is a plan on a closed workspace'
    union all
    select 'open_opportunities_vs_overview', (select coalesce(sum(n), 0)::int from o where metric = 'opportunities_by_stage' and bucket in ('detected', 'qualified', 'suppressed', 'handed_off')),
           (select coalesce(sum(v.open_opportunities), 0)::int from v),
           'observability counts every open opportunity of the organization; the overview only those of live workspaces'
  ) select x.c, x.a, x.b, x.a = x.b, x.note from x order by x.c;
end $$;
revoke all on function projects.reconcile_phase_eight_metrics(timestamptz) from public, anon, service_role;
grant execute on function projects.reconcile_phase_eight_metrics(timestamptz) to authenticated;

drop function if exists projects.p8f_wire_table(text, boolean, boolean);
drop function if exists projects.p8f_wire_parent(text, text, text);

notify pgrst, 'reload schema';
