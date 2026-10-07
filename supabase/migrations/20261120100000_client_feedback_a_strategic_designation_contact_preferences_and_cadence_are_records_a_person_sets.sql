-- ═════════════════════════════════════════════════════════════════
-- Phase 8A gaps log 1 (part 2): the relationship records the Customer Success, Upsell and communication-governance specs name and no table held.
--
--   client_feedback                      APPEND-ONLY. What a client said (feedback) or wants (a goal): recorded by a PERSON, or submitted by the CLIENT through its portal. An
--                                        agent has no door here: nobody fabricates satisfaction (CUS-9). A negative entry stays an item for Customer Success until a person
--                                        acknowledges it (client_feedback_acknowledgements, append-only).
--   client_strategic_designations        'strategic' / 'vip' set by an ADMIN with the rule they decided it under and a reason. No criteria are configured anywhere and an
--                                        agent may not decide VIP: the door is Admin-only and refuses the service role. It changes no health, no priority and no price.
--   client_contact_preferences           preferred channel, language, channels to avoid and a preferred contact: recorded by a person, or stated by the client in the portal.
--   communication_cadence_rules          Admin-set minimum days between two person-sent contacts of one purpose (optionally one channel). NO default number: no rule, no cadence.
--   can_contact_now_with_preferences     the 8D eligibility read plus cadence and preferences. A channel the client asked us to avoid is a REASON; a preferred channel or
--                                        language is an ADVISORY. Nothing here sends anything.
-- ═════════════════════════════════════════════════════════════════

-- ── client feedback and goals ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists projects.client_feedback (
  id                uuid primary key default gen_random_uuid(),
  seq               bigint generated always as identity,
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  project_id        uuid references projects.projects(id) on delete restrict,
  kind              text not null check (kind in ('feedback', 'goal')),
  source            text not null check (source in ('client_portal', 'call', 'meeting', 'email', 'whatsapp', 'survey', 'other')),
  entered_by        text not null check (entered_by in ('staff', 'client')),
  sentiment         text check (sentiment in ('positive', 'neutral', 'negative', 'mixed')),
  rating            int check (rating between 1 and 5),
  body              text not null check (length(btrim(body)) between 10 and 4000 and not projects.p7_has_secret(body)),
  recorded_by       uuid not null references core.users(id) on delete restrict,
  occurred_on       date not null default current_date,
  created_at        timestamptz not null default clock_timestamp(),
  -- a goal is a wish, not a score: it carries no sentiment and no rating
  constraint client_feedback_goal_has_no_score check (kind <> 'goal' or (sentiment is null and rating is null)),
  -- feedback says how the client felt (a sentiment) - a rating is optional
  constraint client_feedback_feedback_has_a_sentiment check (kind <> 'feedback' or sentiment is not null),
  -- what the client typed in the portal is the client's, and only the portal is the client's door
  constraint client_feedback_portal_is_the_clients check ((entered_by = 'client') = (source = 'client_portal'))
);
create index if not exists client_feedback_client_idx on projects.client_feedback (client_account_id, seq desc);
create index if not exists client_feedback_negative_idx on projects.client_feedback (organization_id, seq desc) where sentiment = 'negative';
comment on table projects.client_feedback is
  'APPEND-ONLY. What a client said or wants, as a person recorded it or as the client submitted it. No agent writes here: satisfaction is never inferred.';

create table if not exists projects.client_feedback_acknowledgements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  feedback_id      uuid not null unique references projects.client_feedback(id) on delete restrict,
  acknowledged_by  uuid not null references core.users(id) on delete restrict,
  note             text not null check (length(btrim(note)) between 5 and 1000 and not projects.p7_has_secret(note)),
  acknowledged_at  timestamptz not null default clock_timestamp()
);
comment on table projects.client_feedback_acknowledgements is 'APPEND-ONLY. A person read a feedback entry and says what they did about it. Until then a negative entry is a next action.';

-- ── strategic / VIP designation: an Admin decision ──────────────────────────────────────────────────────────────────────────────────────────

create table if not exists projects.client_strategic_designations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  designation       text not null check (designation in ('strategic', 'vip')),
  criteria          text not null check (length(btrim(criteria)) between 10 and 1000),
  reason            text not null check (length(btrim(reason)) between 10 and 1000),
  active            boolean not null default true,
  set_by            uuid not null references core.users(id) on delete restrict,
  set_at            timestamptz not null default clock_timestamp(),
  ended_by          uuid references core.users(id) on delete restrict,
  ended_at          timestamptz,
  ended_reason      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint client_designation_ended_says_why check ((active) = (ended_at is null and ended_by is null and ended_reason is null)
                                                    and (active or length(btrim(coalesce(ended_reason, ''))) >= 5))
);
create unique index if not exists client_strategic_designations_one_live on projects.client_strategic_designations (client_account_id, designation) where active;
comment on table projects.client_strategic_designations is
  'Strategic / VIP, decided by an Admin under a stated rule and reason. No criteria exist in configuration and an agent may not decide it: only the Admin door writes this table. It changes no health, priority or price.';

-- ── contact preferences ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists projects.client_contact_preferences (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  client_account_id    uuid not null unique references core.client_accounts(id) on delete restrict,
  preferred_channel    text check (preferred_channel in ('whatsapp', 'email', 'portal', 'call', 'meeting')),
  language             text check (language ~ '^[a-z]{2,8}(-[A-Za-z0-9]{2,8})?$'),
  avoid_channels       text[] not null default '{}' check (avoid_channels <@ array['whatsapp', 'email', 'portal', 'call', 'meeting']::text[]),
  preferred_contact_id uuid references crm.contacts(id) on delete set null,
  note                 text check (note is null or (length(btrim(note)) between 1 and 500 and not projects.p7_has_secret(note))),
  source               text not null check (source in ('person_recorded', 'client_stated')),
  set_by               uuid not null references core.users(id) on delete restrict,
  set_at               timestamptz not null default clock_timestamp(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- one cannot both prefer and avoid a channel
  constraint client_contact_preferences_consistent check (preferred_channel is null or not (preferred_channel = any (avoid_channels)))
);
comment on table projects.client_contact_preferences is 'How a client asked to be contacted. Recorded by a person or stated by the client. A channel to avoid is a refusal in can_contact_now_with_preferences; a preferred channel or language is advice.';

-- ── cadence per message category: Admin-set, no default ─────────────────────────────────────────────────────────────────────────────────────

create table if not exists projects.communication_cadence_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  purpose          text not null check (purpose in ('operational', 'relationship', 'commercial')),
  channel          text check (channel is null or channel in ('whatsapp', 'email', 'portal', 'call', 'meeting')),
  min_gap_days     int not null check (min_gap_days between 1 and 365),
  active           boolean not null default true,
  set_by           uuid not null references core.users(id) on delete restrict,
  set_at           timestamptz not null default clock_timestamp(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists communication_cadence_rules_one_per_scope on projects.communication_cadence_rules (organization_id, purpose, coalesce(channel, '*'));
comment on table projects.communication_cadence_rules is 'Admin-set minimum days between two person-sent contacts of one purpose (channel null = any channel). No row, no cadence: no document fixes a number.';

do $$
declare r record;
begin
  for r in select * from (values
    ('client_feedback', 'client_account_id', 'core.client_accounts'), ('client_feedback', 'project_id', 'projects.projects'),
    ('client_feedback_acknowledgements', 'feedback_id', 'projects.client_feedback'),
    ('client_strategic_designations', 'client_account_id', 'core.client_accounts'),
    ('client_contact_preferences', 'client_account_id', 'core.client_accounts'), ('client_contact_preferences', 'preferred_contact_id', 'crm.contacts')
  ) as t(tbl, col, parent) loop
    perform projects.p8g_wire_parent(r.tbl, r.col, r.parent);
  end loop;
  perform projects.p8g_wire_table('client_feedback', false, true);
  perform projects.p8g_wire_table('client_feedback_acknowledgements', false, true);
  perform projects.p8g_wire_table('client_strategic_designations', true, false);
  perform projects.p8g_wire_table('client_contact_preferences', true, false);
  perform projects.p8g_wire_table('communication_cadence_rules', true, false);
end $$;

-- ── feedback doors ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function projects.record_client_feedback(
  p_client_account_id uuid, p_kind text, p_source text, p_sentiment text, p_rating int, p_body text, p_project_id uuid default null, p_occurred_on date default null)
returns table (outcome text, feedback_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_body text := nullif(btrim(coalesce(p_body, '')), ''); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('feedback', 'goal') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_source is null or p_source not in ('call', 'meeting', 'email', 'whatsapp', 'survey', 'other') then return query select 'bad_source'::text, null::uuid; return; end if;
  if p_kind = 'feedback' and (p_sentiment is null or p_sentiment not in ('positive', 'neutral', 'negative', 'mixed')) then return query select 'sentiment_required'::text, null::uuid; return; end if;
  if p_kind = 'goal' and (p_sentiment is not null or p_rating is not null) then return query select 'a_goal_has_no_score'::text, null::uuid; return; end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then return query select 'rating_out_of_range'::text, null::uuid; return; end if;
  if v_body is null or length(v_body) < 10 or length(v_body) > 4000 then return query select 'body_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_body) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if coalesce(p_occurred_on, current_date) > current_date then return query select 'in_the_future'::text, null::uuid; return; end if;
  if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  if p_project_id is not null and not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.client_account_id = p_client_account_id) then return query select 'project_not_the_clients'::text, null::uuid; return; end if;
  insert into projects.client_feedback (organization_id, client_account_id, project_id, kind, source, entered_by, sentiment, rating, body, recorded_by, occurred_on)
  values (v_org, p_client_account_id, p_project_id, p_kind, p_source, 'staff', p_sentiment, p_rating, v_body, v_actor, coalesce(p_occurred_on, current_date)) returning id into v_id;
  perform core.record_audit(v_org, 'client_feedback.recorded', 'client_feedback', v_id, null, jsonb_build_object('clientAccountId', p_client_account_id, 'kind', p_kind, 'sentiment', p_sentiment), projects.p8g_correlation());
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_client_feedback(uuid, text, text, text, int, text, uuid, date) from public, anon, service_role;
grant execute on function projects.record_client_feedback(uuid, text, text, text, int, text, uuid, date) to authenticated;

-- the client's own door: its account only, a project of its own only, and never an expired portal
create or replace function projects.submit_client_feedback(p_kind text, p_sentiment text, p_rating int, p_body text, p_project_id uuid default null)
returns table (outcome text, feedback_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_account uuid := (select core.current_client_account_id()); v_org uuid; v_body text := nullif(btrim(coalesce(p_body, '')), ''); v_id uuid; v_p projects.projects;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_client()), false) or v_account is null then return query select 'not_a_client'::text, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('feedback', 'goal') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_kind = 'feedback' and (p_sentiment is null or p_sentiment not in ('positive', 'neutral', 'negative', 'mixed')) then return query select 'sentiment_required'::text, null::uuid; return; end if;
  if p_kind = 'goal' and (p_sentiment is not null or p_rating is not null) then return query select 'a_goal_has_no_score'::text, null::uuid; return; end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then return query select 'rating_out_of_range'::text, null::uuid; return; end if;
  if v_body is null or length(v_body) < 10 or length(v_body) > 4000 then return query select 'body_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_body) then return query select 'contains_secret'::text, null::uuid; return; end if;
  select a.organization_id into v_org from core.client_accounts a where a.id = v_account;
  if v_org is null then return query select 'not_found'::text, null::uuid; return; end if;
  if p_project_id is not null then
    v_p := projects.p7b_portal_project(p_project_id);
    if v_p.id is null or v_p.client_account_id is distinct from v_account then return query select 'not_found'::text, null::uuid; return; end if;
    if projects.p7b_portal_access(p_project_id) = 'expired' then return query select 'portal_expired'::text, null::uuid; return; end if;
  end if;
  insert into projects.client_feedback (organization_id, client_account_id, project_id, kind, source, entered_by, sentiment, rating, body, recorded_by, occurred_on)
  values (v_org, v_account, p_project_id, p_kind, 'client_portal', 'client', p_sentiment, p_rating, v_body, v_actor, current_date) returning id into v_id;
  perform core.record_audit(v_org, 'client_feedback.submitted', 'client_feedback', v_id, null, jsonb_build_object('clientAccountId', v_account, 'kind', p_kind, 'sentiment', p_sentiment), projects.p8g_correlation());
  return query select 'submitted'::text, v_id;
end $$;
revoke all on function projects.submit_client_feedback(text, text, int, text, uuid) from public, anon, service_role;
grant execute on function projects.submit_client_feedback(text, text, int, text, uuid) to authenticated;

create or replace function projects.acknowledge_client_feedback(p_feedback_id uuid, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_n int;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if v_note is null or length(v_note) < 5 or length(v_note) > 1000 then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(v_note) then return query select 'contains_secret'::text; return; end if;
  if not exists (select 1 from projects.client_feedback f where f.id = p_feedback_id and f.organization_id = v_org) then return query select 'not_found'::text; return; end if;
  insert into projects.client_feedback_acknowledgements (organization_id, feedback_id, acknowledged_by, note) values (v_org, p_feedback_id, v_actor, v_note) on conflict (feedback_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return query select 'already_acknowledged'::text; return; end if;
  perform core.record_audit(v_org, 'client_feedback.acknowledged', 'client_feedback', p_feedback_id, null, null, projects.p8g_correlation());
  return query select 'acknowledged'::text;
end $$;
revoke all on function projects.acknowledge_client_feedback(uuid, text) from public, anon, service_role;
grant execute on function projects.acknowledge_client_feedback(uuid, text) to authenticated;

-- what the client sees of ITS OWN submissions: no internal acknowledgement note, nobody else's rows
create or replace function projects.client_feedback_for_client()
returns table (feedback_id uuid, kind text, sentiment text, rating int, body text, project_id uuid, submitted_at timestamptz, acknowledged boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_account uuid := (select core.current_client_account_id());
begin
  if not coalesce((select core.is_client()), false) or v_account is null then return; end if;
  return query
    select f.id, f.kind, f.sentiment, f.rating, f.body, f.project_id, f.created_at, exists (select 1 from projects.client_feedback_acknowledgements a where a.feedback_id = f.id)
      from projects.client_feedback f
     where f.client_account_id = v_account and f.entered_by = 'client'
     order by f.created_at desc, f.seq desc limit 100;
end $$;
revoke all on function projects.client_feedback_for_client() from public, anon, service_role;
grant execute on function projects.client_feedback_for_client() to authenticated;

-- ── strategic designation doors (Admin only; the service role is refused by the role check AND by having no grant) ──────────────────────────

create or replace function projects.set_client_designation(p_client_account_id uuid, p_designation text, p_criteria text, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_crit text := nullif(btrim(coalesce(p_criteria, '')), ''); v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_designation is null or p_designation not in ('strategic', 'vip') then return query select 'bad_designation'::text; return; end if;
  if v_crit is null or length(v_crit) < 10 or length(v_crit) > 1000 then return query select 'criteria_required'::text; return; end if;
  if v_reason is null or length(v_reason) < 10 or length(v_reason) > 1000 then return query select 'reason_required'::text; return; end if;
  if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = v_org) then return query select 'not_found'::text; return; end if;
  if exists (select 1 from projects.client_strategic_designations d where d.client_account_id = p_client_account_id and d.designation = p_designation and d.active) then return query select 'already_designated'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.client_strategic_designations (organization_id, client_account_id, designation, criteria, reason, set_by) values (v_org, p_client_account_id, p_designation, v_crit, v_reason, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'client_designation.set', 'client_designation', v_id, null, jsonb_build_object('clientAccountId', p_client_account_id, 'designation', p_designation), projects.p8g_correlation());
  return query select 'designated'::text;
end $$;
revoke all on function projects.set_client_designation(uuid, text, text, text) from public, anon, service_role;
grant execute on function projects.set_client_designation(uuid, text, text, text) to authenticated;

create or replace function projects.end_client_designation(p_client_account_id uuid, p_designation text, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;
  select d.id into v_id from projects.client_strategic_designations d where d.organization_id = v_org and d.client_account_id = p_client_account_id and d.designation = p_designation and d.active for update;
  if v_id is null then return query select 'not_found'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.client_strategic_designations set active = false, ended_by = v_actor, ended_at = clock_timestamp(), ended_reason = left(v_reason, 500) where id = v_id;
  perform core.record_audit(v_org, 'client_designation.ended', 'client_designation', v_id, null, jsonb_build_object('clientAccountId', p_client_account_id, 'designation', p_designation), projects.p8g_correlation());
  return query select 'ended'::text;
end $$;
revoke all on function projects.end_client_designation(uuid, text, text) from public, anon, service_role;
grant execute on function projects.end_client_designation(uuid, text, text) to authenticated;

-- ── contact preference doors ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function projects.p8g_upsert_preferences(
  p_org uuid, p_actor uuid, p_account uuid, p_channel text, p_language text, p_avoid text[], p_contact uuid, p_note text, p_source text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_avoid text[] := coalesce(p_avoid, '{}'); v_lang text := nullif(btrim(coalesce(p_language, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_id uuid;
begin
  if p_channel is not null and p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return 'bad_channel'; end if;
  if not (v_avoid <@ array['whatsapp', 'email', 'portal', 'call', 'meeting']::text[]) then return 'bad_avoid_channel'; end if;
  if p_channel is not null and p_channel = any (v_avoid) then return 'prefers_and_avoids_the_same_channel'; end if;
  if v_lang is not null and v_lang !~ '^[a-z]{2,8}(-[A-Za-z0-9]{2,8})?$' then return 'bad_language'; end if;
  if v_note is not null and (length(v_note) > 500 or projects.p7_has_secret(v_note)) then return 'bad_note'; end if;
  if p_contact is not null and not exists (select 1 from crm.contacts c where c.id = p_contact and c.client_account_id = p_account and c.organization_id = p_org) then return 'contact_not_the_clients'; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.client_contact_preferences (organization_id, client_account_id, preferred_channel, language, avoid_channels, preferred_contact_id, note, source, set_by, set_at)
  values (p_org, p_account, p_channel, v_lang, v_avoid, p_contact, v_note, p_source, p_actor, clock_timestamp())
  on conflict (client_account_id) do update set preferred_channel = excluded.preferred_channel, language = excluded.language, avoid_channels = excluded.avoid_channels,
    preferred_contact_id = excluded.preferred_contact_id, note = excluded.note, source = excluded.source, set_by = excluded.set_by, set_at = excluded.set_at
  returning id into v_id;
  perform core.record_audit(p_org, 'client_preferences.set', 'client_contact_preferences', v_id, null, jsonb_build_object('clientAccountId', p_account, 'source', p_source), projects.p8g_correlation());
  return 'set';
end $$;
revoke all on function projects.p8g_upsert_preferences(uuid, uuid, uuid, text, text, text[], uuid, text, text) from public, anon, authenticated, service_role;

create or replace function projects.set_client_contact_preferences(
  p_client_account_id uuid, p_preferred_channel text, p_language text, p_avoid_channels text[] default '{}', p_preferred_contact_id uuid default null, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = v_org) then return query select 'not_found'::text; return; end if;
  return query select projects.p8g_upsert_preferences(v_org, v_actor, p_client_account_id, p_preferred_channel, p_language, p_avoid_channels, p_preferred_contact_id, p_note, 'person_recorded');
end $$;
revoke all on function projects.set_client_contact_preferences(uuid, text, text, text[], uuid, text) from public, anon, service_role;
grant execute on function projects.set_client_contact_preferences(uuid, text, text, text[], uuid, text) to authenticated;

create or replace function projects.set_my_contact_preferences(p_preferred_channel text, p_language text, p_avoid_channels text[] default '{}', p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_account uuid := (select core.current_client_account_id()); v_org uuid;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_client()), false) or v_account is null then return query select 'not_a_client'::text; return; end if;
  select a.organization_id into v_org from core.client_accounts a where a.id = v_account;
  if v_org is null then return query select 'not_found'::text; return; end if;
  return query select projects.p8g_upsert_preferences(v_org, v_actor, v_account, p_preferred_channel, p_language, p_avoid_channels, null, p_note, 'client_stated');
end $$;
revoke all on function projects.set_my_contact_preferences(text, text, text[], text) from public, anon, service_role;
grant execute on function projects.set_my_contact_preferences(text, text, text[], text) to authenticated;

create or replace function projects.my_contact_preferences()
returns table (preferred_channel text, language text, avoid_channels text[], note text, set_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_account uuid := (select core.current_client_account_id());
begin
  if not coalesce((select core.is_client()), false) or v_account is null then return; end if;
  return query select p.preferred_channel, p.language, p.avoid_channels, p.note, p.set_at from projects.client_contact_preferences p where p.client_account_id = v_account;
end $$;
revoke all on function projects.my_contact_preferences() from public, anon, service_role;
grant execute on function projects.my_contact_preferences() to authenticated;

-- ── cadence doors (Admin) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function projects.set_communication_cadence_rule(p_purpose text, p_channel text, p_min_gap_days int)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_purpose is null or p_purpose not in ('operational', 'relationship', 'commercial') then return query select 'bad_purpose'::text; return; end if;
  if p_channel is not null and p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select 'bad_channel'::text; return; end if;
  if p_min_gap_days is null or p_min_gap_days < 1 or p_min_gap_days > 365 then return query select 'out_of_range'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.communication_cadence_rules (organization_id, purpose, channel, min_gap_days, active, set_by, set_at) values (v_org, p_purpose, p_channel, p_min_gap_days, true, v_actor, clock_timestamp())
  on conflict (organization_id, purpose, coalesce(channel, '*')) do update set min_gap_days = excluded.min_gap_days, active = true, set_by = excluded.set_by, set_at = excluded.set_at
  returning id into v_id;
  perform core.record_audit(v_org, 'communication_cadence.set', 'communication_cadence_rule', v_id, null, jsonb_build_object('purpose', p_purpose, 'channel', p_channel, 'minGapDays', p_min_gap_days), projects.p8g_correlation());
  return query select 'set'::text;
end $$;
revoke all on function projects.set_communication_cadence_rule(text, text, int) from public, anon, service_role;
grant execute on function projects.set_communication_cadence_rule(text, text, int) to authenticated;

create or replace function projects.clear_communication_cadence_rule(p_purpose text, p_channel text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select r.id into v_id from projects.communication_cadence_rules r where r.organization_id = v_org and r.purpose = p_purpose and coalesce(r.channel, '*') = coalesce(p_channel, '*') and r.active for update;
  if v_id is null then return query select 'not_found'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.communication_cadence_rules set active = false, set_by = v_actor, set_at = clock_timestamp() where id = v_id;
  perform core.record_audit(v_org, 'communication_cadence.cleared', 'communication_cadence_rule', v_id, null, jsonb_build_object('purpose', p_purpose, 'channel', p_channel), projects.p8g_correlation());
  return query select 'cleared'::text;
end $$;
revoke all on function projects.clear_communication_cadence_rule(text, text) from public, anon, service_role;
grant execute on function projects.clear_communication_cadence_rule(text, text) to authenticated;

-- ── the eligibility read with cadence and preferences ──────────────────────────────────────────────────────────────────────────────────────────

create or replace function projects.can_contact_now_with_preferences(
  p_client_account_id uuid, p_channel text, p_purpose text default 'relationship', p_contact_id uuid default null, p_now timestamptz default clock_timestamp())
returns table (allowed boolean, reasons text[], advisories text[])
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org uuid; v_r text[] := '{}'; v_a text[] := '{}'; v_base boolean; v_base_r text[]; c record; v_last timestamptz; pref projects.client_contact_preferences;
begin
  if coalesce((select auth.role()), '') <> 'service_role' and not coalesce((select core.is_internal()), false) then return; end if;
  select b.allowed, b.reasons into v_base, v_base_r from projects.can_contact_now(p_client_account_id, p_channel, p_purpose, p_contact_id, p_now) b;
  if v_base is null then return; end if;
  v_r := coalesce(v_base_r, '{}');
  select a.organization_id into v_org from core.client_accounts a where a.id = p_client_account_id;
  if v_org is null or p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') or p_purpose not in ('operational', 'relationship', 'commercial') then
    return query select v_base, v_r, v_a; return;
  end if;

  -- cadence: the latest PERSON-SENT contact of this purpose (a draft is not a contact) against each applicable Admin-set gap
  for c in select * from projects.communication_cadence_rules cr
            where cr.organization_id = v_org and cr.active and cr.purpose = p_purpose and (cr.channel is null or cr.channel = p_channel) order by cr.channel nulls first loop
    select max(l.occurred_at) into v_last from projects.client_communication_ledger l
     where l.client_account_id = p_client_account_id and l.organization_id = v_org and l.entry_kind = 'sent_by_person' and l.purpose = p_purpose
       and l.occurred_at <= p_now and (c.channel is null or l.channel = c.channel);
    if v_last is not null and v_last > p_now - make_interval(days => c.min_gap_days) then
      v_r := array_append(v_r, 'cadence: a ' || p_purpose || ' contact' || case when c.channel is null then '' else ' on ' || c.channel end || ' was made on ' || to_char(v_last at time zone 'UTC', 'YYYY-MM-DD')
                              || ' and the gap is ' || c.min_gap_days || ' days');
    end if;
  end loop;

  -- preferences: a channel the client asked us to avoid is a refusal; everything else is advice
  select * into pref from projects.client_contact_preferences p where p.client_account_id = p_client_account_id and p.organization_id = v_org;
  if pref.id is not null then
    if p_channel = any (pref.avoid_channels) then v_r := array_append(v_r, 'the client asked not to be contacted by ' || p_channel); end if;
    if pref.preferred_channel is not null and pref.preferred_channel <> p_channel then v_a := array_append(v_a, 'the client prefers ' || pref.preferred_channel); end if;
    if pref.language is not null then v_a := array_append(v_a, 'write in ' || pref.language); end if;
    if pref.preferred_contact_id is not null and p_contact_id is not null and pref.preferred_contact_id <> p_contact_id then v_a := array_append(v_a, 'the client prefers a different contact'); end if;
  end if;
  return query select cardinality(v_r) = 0, v_r, v_a;
end $$;
revoke all on function projects.can_contact_now_with_preferences(uuid, text, text, uuid, timestamptz) from public, anon;
grant execute on function projects.can_contact_now_with_preferences(uuid, text, text, uuid, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
