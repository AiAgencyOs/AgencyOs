-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 10 — B2B marketplaces: opportunities are scored and
-- chosen by a person, proposals and profile changes go out as EXACTLY what was
-- approved, and a marketplace's own rules decide whether a conversation may
-- leave it.
--
-- WHAT THE AUDIT FOUND. The B2B engine (spec §58-§59) had nothing under it: no
-- opportunity record, no fit judgement, no proposal approval, no profile
-- control, no connects budget, and - the real hazard - nothing that knew a
-- marketplace usually FORBIDS taking a client off its platform. The tracked
-- WhatsApp handoff (slice 3) would have happily built a link for a prospect
-- found on Upwork.
--
-- WHAT THIS ADDS.
--  1. `b2b_platform_rules`: per marketplace, whether contact off the platform
--     is forbidden, allowed only after an award, or allowed, and whether the
--     platform may be automated at all. The default is the restrictive one and
--     LOOSENING it is the owner's decision. `create_channel_handoff` is carried
--     forward so a B2B handoff is refused unless the rule permits it (no rule
--     is a refusal, not permission).
--  2. Opportunities, recorded as facts (frozen) with an explainable fit score
--     and the Admin's own thresholds; a person shortlists. An opportunity the
--     Admin's excluded terms hit is EXCLUDED and cannot be shortlisted.
--  3. Proposals as immutable versions with a derived hash, checked by rules that
--     can fail a proposal and never approve one: no contact details, no
--     external links, no messaging-app names where the platform forbids it; no
--     urgency, claims or unsourced statistics; past work only from the agency's
--     own portfolio. A price can be set by a PERSON only - an agent's draft has
--     none - and a proposal without one cannot pass the check.
--  4. Submission is the governed `b2b_proposal_submit` action, never automatic.
--     Because no marketplace connector exists and most platforms prohibit
--     automation, the supported path is ASSISTED: a person submits on the
--     platform, then records it; the record is accepted only for the exact
--     approved version, once, with the stops, the approval and the Admin's
--     connects budget re-read at that moment.
--  5. Profile changes follow the same pattern (`profile_update`).
--  6. Results by platform from the records themselves; a thin sample says so.
--
-- NOT BUILT: marketplace connectors (nothing is read from or sent to a
-- platform), automated discovery, the AI that writes proposals, and moving a
-- won client into a lead automatically (a person links the lead).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the marketplaces' own rules, and the Admin's thresholds ─────────────

create table if not exists crm.b2b_platform_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  platform         text not null check (platform in ('upwork', 'freelancer', 'peopleperhour', 'guru', 'contra', 'fiverr', 'clutch', 'goodfirms')),
  offplatform_contact text not null default 'forbidden' check (offplatform_contact in ('forbidden', 'after_award', 'allowed')),
  automation_mode  text not null default 'manual' check (automation_mode in ('manual', 'assisted', 'automated')),
  note             text check (note is null or length(note) <= 500),
  updated_by       uuid references core.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  unique (organization_id, platform)
);
comment on table crm.b2b_platform_rules is 'What a marketplace permits, as the agency understands its terms. The default is the restrictive one; loosening is the owner''s decision. No row means forbidden.';

create table if not exists crm.b2b_settings (
  organization_id  uuid primary key references core.organizations(id) on delete cascade,
  min_budget_minor bigint check (min_budget_minor is null or min_budget_minor >= 0),
  excluded_terms   text[] not null default '{}' check (cardinality(excluded_terms) <= 50),
  score_threshold  integer not null default 50 check (score_threshold between 0 and 100),
  monthly_connects_cap integer check (monthly_connects_cap is null or monthly_connects_cap >= 0),
  updated_by       uuid references core.users(id) on delete set null,
  updated_at       timestamptz not null default now()
);
comment on table crm.b2b_settings is 'The Admin''s thresholds for B2B: the smallest job worth a proposal, words that exclude one, the score that makes a job worth a look, and the monthly connects budget. Read every time an opportunity is scored or a proposal submitted.';

-- ── 2. opportunities ───────────────────────────────────────────────────────

create table if not exists crm.b2b_opportunities (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  platform         text not null check (platform in ('upwork', 'freelancer', 'peopleperhour', 'guru', 'contra', 'fiverr', 'clutch', 'goodfirms')),
  external_ref     text not null check (length(external_ref) between 1 and 200),
  url              text check (url is null or (url ~ '^https://' and length(url) <= 500)),
  title            text not null check (length(btrim(title)) between 3 and 300),
  description      text not null default '' check (length(description) <= 10000),
  budget_min_minor bigint check (budget_min_minor is null or budget_min_minor >= 0),
  budget_max_minor bigint check (budget_max_minor is null or budget_max_minor >= 0),
  currency         char(3) not null default 'USD',
  client_country   text check (client_country is null or length(client_country) between 2 and 60),
  posted_at        timestamptz,
  source           text not null check (source in ('assisted_import', 'adapter')),
  status           text not null default 'new' check (status in ('new', 'scored', 'below_threshold', 'excluded', 'shortlisted', 'skipped', 'submitted', 'won', 'lost')),
  fit_score        integer check (fit_score is null or fit_score between 0 and 100),
  fit_reasons      jsonb not null default '[]'::jsonb check (jsonb_typeof(fit_reasons) = 'array'),
  skip_reason      text check (skip_reason is null or length(skip_reason) <= 300),
  lead_id          uuid references crm.leads(id) on delete set null,
  outcome_value_minor bigint check (outcome_value_minor is null or outcome_value_minor >= 0),
  outcome_note     text check (outcome_note is null or length(outcome_note) <= 500),
  closed_at        timestamptz,
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (organization_id, platform, external_ref),
  constraint b2b_budget_order check (budget_max_minor is null or budget_min_minor is null or budget_max_minor >= budget_min_minor)
);
create index if not exists b2b_opportunities_org_status_idx on crm.b2b_opportunities (organization_id, status, created_at desc);
comment on table crm.b2b_opportunities is 'A job or request found on a marketplace. The facts about it are frozen as recorded; only its status, the fit judgement and the outcome move, through the doors.';

-- ── 3. proposals: immutable versions ───────────────────────────────────────

create table if not exists crm.b2b_proposal_versions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  opportunity_id   uuid not null references crm.b2b_opportunities(id) on delete restrict,
  version          integer not null check (version >= 1),
  body             text not null check (length(btrim(body)) between 1 and 6000),
  currency         char(3) not null default 'USD',
  price_minor      bigint check (price_minor is null or price_minor > 0),
  timeline_days    integer check (timeline_days is null or timeline_days between 1 and 730),
  connects_cost    integer not null default 0 check (connects_cost between 0 and 100),
  portfolio_item_ids uuid[] not null default '{}' check (cardinality(portfolio_item_ids) <= 6),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  state            text not null default 'DRAFT' check (state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW', 'REJECTED', 'SUBMITTING', 'SUBMITTED', 'SUPERSEDED', 'CANCELLED')),
  review           jsonb check (review is null or jsonb_typeof(review) = 'object'),
  approval_request_id uuid references approvals.approval_requests(id) on delete set null,
  external_ref     text check (external_ref is null or length(external_ref) <= 200),
  submitted_via    text check (submitted_via is null or submitted_via in ('manual', 'adapter')),
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  unique (opportunity_id, version),
  -- Agents do not price (the pricing authority is the Quotation Master and a person): an agent's draft carries no price.
  constraint b2b_proposal_price_is_human check (price_minor is null or created_by_type = 'human')
);
create index if not exists b2b_proposals_org_state_idx on crm.b2b_proposal_versions (organization_id, state, created_at desc);
create unique index if not exists b2b_proposals_one_submitting_key on crm.b2b_proposal_versions (opportunity_id) where state in ('SUBMITTING', 'SUBMITTED');
comment on table crm.b2b_proposal_versions is 'One immutable version of a proposal. The hash is derived by a trigger; only the workflow state moves, through the doors. A price exists only on a version a person wrote.';

-- ── 4. profile changes: immutable versions ─────────────────────────────────

create table if not exists crm.b2b_profile_versions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  platform         text not null check (platform in ('upwork', 'freelancer', 'peopleperhour', 'guru', 'contra', 'fiverr', 'clutch', 'goodfirms')),
  version          integer not null check (version >= 1),
  content          jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 30000),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  state            text not null default 'DRAFT' check (state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW', 'REJECTED', 'APPLIED', 'SUPERSEDED', 'CANCELLED')),
  review           jsonb check (review is null or jsonb_typeof(review) = 'object'),
  approval_request_id uuid references approvals.approval_requests(id) on delete set null,
  evidence_url     text check (evidence_url is null or (evidence_url ~ '^https://' and length(evidence_url) <= 500)),
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  unique (organization_id, platform, version)
);
comment on table crm.b2b_profile_versions is 'One immutable version of what a marketplace profile should say. Applying it is a person''s act on the platform, recorded here against the exact approved version.';

-- ── 5. guards ──────────────────────────────────────────────────────────────

create or replace function crm.b2b_proposal_stamp()
returns trigger language plpgsql set search_path = '' as $$
declare o crm.b2b_opportunities;
begin
  select * into o from crm.b2b_opportunities x where x.id = new.opportunity_id;
  new.content_hash := encode(sha256(convert_to(jsonb_build_object(
    'platform', o.platform, 'external_ref', o.external_ref, 'body', new.body, 'currency', new.currency, 'price', new.price_minor,
    'timeline', new.timeline_days, 'connects', new.connects_cost, 'portfolio', new.portfolio_item_ids)::text, 'UTF8')), 'hex');
  return new;
end;
$$;
drop trigger if exists b2b_proposal_stamp on crm.b2b_proposal_versions;
create trigger b2b_proposal_stamp before insert on crm.b2b_proposal_versions for each row execute function crm.b2b_proposal_stamp();

create or replace function crm.b2b_proposal_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a proposal version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.opportunity_id, new.version, new.body, new.currency, new.price_minor, new.timeline_days, new.connects_cost, new.portfolio_item_ids, new.content_hash, new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.opportunity_id, old.version, old.body, old.currency, old.price_minor, old.timeline_days, old.connects_cost, old.portfolio_item_ids, old.content_hash, old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a proposal says is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
      raise exception 'a proposal''s state moves only through the B2B doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'        and new.state in ('CHECKED', 'CHECK_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECK_FAILED' and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECKED'      and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW' and new.state in ('SUBMITTING', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'SUBMITTING'   and new.state in ('SUBMITTED', 'ADMIN_REVIEW'))) then
      raise exception 'a % proposal cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  elsif (new.external_ref, new.submitted_via) is distinct from (old.external_ref, old.submitted_via)
        and coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
    raise exception 'a submission is recorded only through the B2B doors' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists b2b_proposal_guard on crm.b2b_proposal_versions;
create trigger b2b_proposal_guard before update or delete on crm.b2b_proposal_versions for each row execute function crm.b2b_proposal_guard();

create or replace function crm.b2b_profile_stamp()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.content_hash := encode(sha256(convert_to(jsonb_build_object('platform', new.platform, 'content', new.content)::text, 'UTF8')), 'hex');
  return new;
end;
$$;
drop trigger if exists b2b_profile_stamp on crm.b2b_profile_versions;
create trigger b2b_profile_stamp before insert on crm.b2b_profile_versions for each row execute function crm.b2b_profile_stamp();

create or replace function crm.b2b_profile_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a profile version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.platform, new.version, new.content, new.content_hash, new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.platform, old.version, old.content, old.content_hash, old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a profile says is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
      raise exception 'a profile version''s state moves only through the B2B doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'        and new.state in ('CHECKED', 'CHECK_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECK_FAILED' and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECKED'      and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW' and new.state in ('APPLIED', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'APPLIED'      and new.state = 'SUPERSEDED')) then
      raise exception 'a % profile version cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  elsif new.evidence_url is distinct from old.evidence_url and coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
    raise exception 'evidence is recorded only through the B2B doors' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists b2b_profile_guard on crm.b2b_profile_versions;
create trigger b2b_profile_guard before update or delete on crm.b2b_profile_versions for each row execute function crm.b2b_profile_guard();

create or replace function crm.b2b_opportunity_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'an opportunity is history' using errcode = '42501'; end if;
  if (new.organization_id, new.platform, new.external_ref, new.url, new.title, new.description, new.budget_min_minor, new.budget_max_minor, new.currency, new.client_country, new.posted_at, new.source, new.created_at)
     is distinct from
     (old.organization_id, old.platform, old.external_ref, old.url, old.title, old.description, old.budget_min_minor, old.budget_max_minor, old.currency, old.client_country, old.posted_at, old.source, old.created_at) then
    raise exception 'what an opportunity said when it was found is frozen' using errcode = '42501';
  end if;
  if (new.status, new.fit_score, new.fit_reasons, new.skip_reason, new.lead_id, new.outcome_value_minor, new.outcome_note, new.closed_at)
     is distinct from
     (old.status, old.fit_score, old.fit_reasons, old.skip_reason, old.lead_id, old.outcome_value_minor, old.outcome_note, old.closed_at)
     and coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
    raise exception 'an opportunity moves only through the B2B doors' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and old.status in ('won', 'lost') then
    raise exception 'an opportunity that was won or lost does not reopen' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists b2b_opportunity_guard on crm.b2b_opportunities;
create trigger b2b_opportunity_guard before update or delete on crm.b2b_opportunities for each row execute function crm.b2b_opportunity_guard();

-- tenancy, RLS, privileges
drop trigger if exists freeze_org_b2b_platform_rules on crm.b2b_platform_rules;
create trigger freeze_org_b2b_platform_rules before update of organization_id on crm.b2b_platform_rules for each row execute function core.freeze_organization_id();
alter table crm.b2b_platform_rules enable row level security;
alter table crm.b2b_platform_rules force row level security;
drop policy if exists b2b_platform_rules_select on crm.b2b_platform_rules;
create policy b2b_platform_rules_select on crm.b2b_platform_rules for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.b2b_platform_rules from public, anon, authenticated;
grant select on crm.b2b_platform_rules to authenticated;
grant select, insert, update on crm.b2b_platform_rules to service_role;
drop trigger if exists freeze_org_b2b_settings on crm.b2b_settings;
create trigger freeze_org_b2b_settings before update of organization_id on crm.b2b_settings for each row execute function core.freeze_organization_id();
alter table crm.b2b_settings enable row level security;
alter table crm.b2b_settings force row level security;
drop policy if exists b2b_settings_select on crm.b2b_settings;
create policy b2b_settings_select on crm.b2b_settings for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.b2b_settings from public, anon, authenticated;
grant select on crm.b2b_settings to authenticated;
grant select, insert, update on crm.b2b_settings to service_role;
drop trigger if exists freeze_org_b2b_opportunities on crm.b2b_opportunities;
create trigger freeze_org_b2b_opportunities before update of organization_id on crm.b2b_opportunities for each row execute function core.freeze_organization_id();
alter table crm.b2b_opportunities enable row level security;
alter table crm.b2b_opportunities force row level security;
drop policy if exists b2b_opportunities_select on crm.b2b_opportunities;
create policy b2b_opportunities_select on crm.b2b_opportunities for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.b2b_opportunities from public, anon, authenticated;
grant select on crm.b2b_opportunities to authenticated;
grant select, insert, update on crm.b2b_opportunities to service_role;
drop trigger if exists freeze_org_b2b_proposal_versions on crm.b2b_proposal_versions;
create trigger freeze_org_b2b_proposal_versions before update of organization_id on crm.b2b_proposal_versions for each row execute function core.freeze_organization_id();
alter table crm.b2b_proposal_versions enable row level security;
alter table crm.b2b_proposal_versions force row level security;
drop policy if exists b2b_proposal_versions_select on crm.b2b_proposal_versions;
create policy b2b_proposal_versions_select on crm.b2b_proposal_versions for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.b2b_proposal_versions from public, anon, authenticated;
grant select on crm.b2b_proposal_versions to authenticated;
grant select, insert, update on crm.b2b_proposal_versions to service_role;
drop trigger if exists freeze_org_b2b_profile_versions on crm.b2b_profile_versions;
create trigger freeze_org_b2b_profile_versions before update of organization_id on crm.b2b_profile_versions for each row execute function core.freeze_organization_id();
alter table crm.b2b_profile_versions enable row level security;
alter table crm.b2b_profile_versions force row level security;
drop policy if exists b2b_profile_versions_select on crm.b2b_profile_versions;
create policy b2b_profile_versions_select on crm.b2b_profile_versions for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.b2b_profile_versions from public, anon, authenticated;
grant select on crm.b2b_profile_versions to authenticated;
grant select, insert, update on crm.b2b_profile_versions to service_role;

drop trigger if exists org_match_b2b_opportunities_lead on crm.b2b_opportunities;
create trigger org_match_b2b_opportunities_lead before insert or update of lead_id, organization_id on crm.b2b_opportunities for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');
drop trigger if exists org_match_b2b_proposals_opportunity on crm.b2b_proposal_versions;
create trigger org_match_b2b_proposals_opportunity before insert or update of opportunity_id, organization_id on crm.b2b_proposal_versions for each row execute function core.enforce_parent_org('opportunity_id', 'crm.b2b_opportunities');
drop trigger if exists org_match_b2b_proposals_approval on crm.b2b_proposal_versions;
create trigger org_match_b2b_proposals_approval before insert or update of approval_request_id, organization_id on crm.b2b_proposal_versions for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');
drop trigger if exists org_match_b2b_profiles_approval on crm.b2b_profile_versions;
create trigger org_match_b2b_profiles_approval before insert or update of approval_request_id, organization_id on crm.b2b_profile_versions for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');

-- ── 6. the fit judgement: explainable, deterministic, the Admin's thresholds ─
-- Service match 50, budget 30 (10 when the client gave none), enough detail to judge 20. An excluded term is a refusal, not a low score.

create or replace function crm.b2b_fit(p_organization_id uuid, p_title text, p_description text, p_budget_max_minor bigint, p_budget_min_minor bigint)
returns table (score integer, status text, reasons jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s crm.b2b_settings;
  v_text text := lower(coalesce(p_title, '') || ' ' || coalesce(p_description, ''));
  v_score integer := 0;
  v_reasons jsonb := '[]'::jsonb;
  v_term text;
  v_svc text;
  v_best bigint := coalesce(p_budget_max_minor, p_budget_min_minor);
begin
  select * into s from crm.b2b_settings x where x.organization_id = p_organization_id;
  foreach v_term in array coalesce(s.excluded_terms, '{}'::text[]) loop
    if length(btrim(v_term)) > 0 and position(lower(btrim(v_term)) in v_text) > 0 then
      return query select 0, 'excluded'::text, jsonb_build_array('excluded_term:' || lower(btrim(v_term))); return;
    end if;
  end loop;
  select t.name into v_svc from crm.target_services t
   where t.organization_id = p_organization_id and t.active and position(lower(t.name) in v_text) > 0 order by t.priority limit 1;
  if v_svc is not null then v_score := v_score + 50; v_reasons := v_reasons || to_jsonb('service_match:' || v_svc); else v_reasons := v_reasons || to_jsonb('no_target_service_mentioned'::text); end if;
  if v_best is null then v_score := v_score + 10; v_reasons := v_reasons || to_jsonb('budget_not_stated'::text);
  elsif s.min_budget_minor is null or v_best >= s.min_budget_minor then v_score := v_score + 30; v_reasons := v_reasons || to_jsonb('budget_ok'::text);
  else v_reasons := v_reasons || to_jsonb('budget_below_minimum'::text); end if;
  if length(coalesce(p_description, '')) >= 200 then v_score := v_score + 20; v_reasons := v_reasons || to_jsonb('enough_detail'::text); else v_reasons := v_reasons || to_jsonb('thin_description'::text); end if;
  return query select v_score, case when v_score >= coalesce(s.score_threshold, 50) then 'scored' else 'below_threshold' end::text, v_reasons;
end;
$$;
revoke all on function crm.b2b_fit(uuid, text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function crm.b2b_fit(uuid, text, text, bigint, bigint) to service_role;

-- ── 7. doors: rules and settings ───────────────────────────────────────────

create or replace function crm._b2b_set(p_table text, p_id uuid, p_state text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform set_config('crm.b2b_write', '1', true);
  if p_table = 'proposal' then update crm.b2b_proposal_versions set state = p_state where id = p_id;
  elsif p_table = 'profile' then update crm.b2b_profile_versions set state = p_state where id = p_id;
  end if;
  perform set_config('crm.b2b_write', '', true);
end;
$$;
revoke all on function crm._b2b_set(text, uuid, text) from public, anon, authenticated;

create or replace function crm.ensure_b2b_defaults()
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); p text;
begin
  if (select auth.uid()) is null or v_org is null or not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  insert into crm.b2b_settings (organization_id) values (v_org) on conflict do nothing;
  foreach p in array array['upwork', 'freelancer', 'peopleperhour', 'guru', 'contra', 'fiverr', 'clutch', 'goodfirms'] loop
    insert into crm.b2b_platform_rules (organization_id, platform) values (v_org, p) on conflict do nothing;
  end loop;
  return query select 'ready'::text;
end;
$$;
revoke all on function crm.ensure_b2b_defaults() from public, anon;
grant execute on function crm.ensure_b2b_defaults() to authenticated;

-- A tighter rule is the admin's; a LOOSER one (contact off the platform, automation) is the owner's.
create or replace function crm.set_b2b_platform_rule(p_platform text, p_offplatform text, p_mode text, p_note text)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id());
  r crm.b2b_platform_rules;
  v_loosens boolean;
begin
  if (select auth.uid()) is null or v_org is null or not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  if p_offplatform not in ('forbidden', 'after_award', 'allowed') or p_mode not in ('manual', 'assisted', 'automated') then return query select 'invalid'::text; return; end if;
  select * into r from crm.b2b_platform_rules x where x.organization_id = v_org and x.platform = p_platform;
  if r.id is null then return query select 'unknown_platform'::text; return; end if;
  v_loosens := (array_position(array['forbidden', 'after_award', 'allowed'], p_offplatform) > array_position(array['forbidden', 'after_award', 'allowed'], r.offplatform_contact))
            or (array_position(array['manual', 'assisted', 'automated'], p_mode) > array_position(array['manual', 'assisted', 'automated'], r.automation_mode));
  if v_loosens and not coalesce((select core.is_owner()), false) then return query select 'not_owner'::text; return; end if;
  update crm.b2b_platform_rules set offplatform_contact = p_offplatform, automation_mode = p_mode, note = left(nullif(btrim(coalesce(p_note, '')), ''), 500), updated_by = (select auth.uid()), updated_at = now() where id = r.id;
  perform core.record_audit(v_org, 'b2b.platform_rule_changed', 'b2b_platform_rule', r.id, to_jsonb(r), jsonb_build_object('platform', p_platform, 'offplatform_contact', p_offplatform, 'automation_mode', p_mode));
  return query select 'saved'::text;
end;
$$;
revoke all on function crm.set_b2b_platform_rule(text, text, text, text) from public, anon;
grant execute on function crm.set_b2b_platform_rule(text, text, text, text) to authenticated;

create or replace function crm.set_b2b_settings(p_min_budget_minor bigint, p_excluded_terms text[], p_score_threshold integer, p_monthly_connects_cap integer)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null or v_org is null or not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  insert into crm.b2b_settings (organization_id, min_budget_minor, excluded_terms, score_threshold, monthly_connects_cap, updated_by)
  values (v_org, p_min_budget_minor, coalesce(p_excluded_terms, '{}'::text[]), coalesce(p_score_threshold, 50), p_monthly_connects_cap, (select auth.uid()))
  on conflict (organization_id) do update set min_budget_minor = excluded.min_budget_minor, excluded_terms = excluded.excluded_terms,
    score_threshold = excluded.score_threshold, monthly_connects_cap = excluded.monthly_connects_cap, updated_by = excluded.updated_by, updated_at = now();
  perform core.record_audit(v_org, 'b2b.settings_changed', 'b2b_settings', null, null, jsonb_build_object('score_threshold', p_score_threshold, 'monthly_connects_cap', p_monthly_connects_cap));
  return query select 'saved'::text;
exception when check_violation then return query select 'invalid'::text;
end;
$$;
revoke all on function crm.set_b2b_settings(bigint, text[], integer, integer) from public, anon;
grant execute on function crm.set_b2b_settings(bigint, text[], integer, integer) to authenticated;

-- ── 8. doors: opportunities ────────────────────────────────────────────────

create or replace function crm.record_b2b_opportunity(
  p_organization_id uuid, p_platform text, p_external_ref text, p_url text, p_title text, p_description text,
  p_budget_min_minor bigint, p_budget_max_minor bigint, p_currency text, p_client_country text, p_posted_at timestamptz, p_source text default 'assisted_import'
)
returns table (outcome text, opportunity_id uuid, status text, score integer)
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; f record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid, null::text, null::integer; return; end if;
  if p_source not in ('assisted_import', 'adapter') then return query select 'invalid'::text, null::uuid, null::text, null::integer; return; end if;
  if exists (select 1 from crm.b2b_opportunities o where o.organization_id = p_organization_id and o.platform = p_platform and o.external_ref = p_external_ref) then
    return query select 'duplicate'::text, (select o.id from crm.b2b_opportunities o where o.organization_id = p_organization_id and o.platform = p_platform and o.external_ref = p_external_ref), null::text, null::integer; return;
  end if;
  select * into f from crm.b2b_fit(p_organization_id, p_title, p_description, p_budget_max_minor, p_budget_min_minor);
  insert into crm.b2b_opportunities (organization_id, platform, external_ref, url, title, description, budget_min_minor, budget_max_minor, currency, client_country, posted_at, source,
                                     status, fit_score, fit_reasons, created_by)
  values (p_organization_id, p_platform, btrim(p_external_ref), nullif(btrim(coalesce(p_url, '')), ''), btrim(p_title), coalesce(p_description, ''), p_budget_min_minor, p_budget_max_minor,
          upper(coalesce(nullif(btrim(p_currency), ''), 'USD')), nullif(btrim(coalesce(p_client_country, '')), ''), p_posted_at, p_source, f.status, f.score, f.reasons, (select auth.uid()))
  returning id into v_id;
  perform core.record_audit(p_organization_id, 'b2b.opportunity_recorded', 'b2b_opportunity', v_id, null, jsonb_build_object('platform', p_platform, 'status', f.status, 'score', f.score));
  return query select 'recorded'::text, v_id, f.status, f.score;
exception when check_violation then return query select 'invalid'::text, null::uuid, null::text, null::integer;
end;
$$;
revoke all on function crm.record_b2b_opportunity(uuid, text, text, text, text, text, bigint, bigint, text, text, timestamptz, text) from public, anon;
grant execute on function crm.record_b2b_opportunity(uuid, text, text, text, text, text, bigint, bigint, text, text, timestamptz, text) to authenticated, service_role;

create or replace function crm.decide_b2b_opportunity(p_organization_id uuid, p_opportunity uuid, p_decision text, p_reason text default null)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare o crm.b2b_opportunities;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text; return; end if;
  if p_decision not in ('shortlist', 'skip') then return query select 'invalid'::text; return; end if;
  select * into o from crm.b2b_opportunities x where x.id = p_opportunity and x.organization_id = p_organization_id for update;
  if o.id is null then return query select 'not_found'::text; return; end if;
  if o.status = 'excluded' then return query select 'excluded'::text; return; end if;
  if o.status in ('submitted', 'won', 'lost') then return query select 'already_past_that'::text; return; end if;
  if p_decision = 'skip' and length(btrim(coalesce(p_reason, ''))) < 3 then return query select 'needs_reason'::text; return; end if;
  perform set_config('crm.b2b_write', '1', true);
  update crm.b2b_opportunities set status = case p_decision when 'shortlist' then 'shortlisted' else 'skipped' end, skip_reason = case p_decision when 'skip' then left(p_reason, 300) end where id = o.id;
  perform set_config('crm.b2b_write', '', true);
  perform core.record_audit(p_organization_id, 'b2b.opportunity_' || p_decision, 'b2b_opportunity', o.id, null, jsonb_build_object('reason', left(p_reason, 300)));
  return query select 'decided'::text;
end;
$$;
revoke all on function crm.decide_b2b_opportunity(uuid, uuid, text, text) from public, anon;
grant execute on function crm.decide_b2b_opportunity(uuid, uuid, text, text) to authenticated, service_role;

create or replace function crm.record_b2b_outcome(p_organization_id uuid, p_opportunity uuid, p_outcome text, p_value_minor bigint, p_note text)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare o crm.b2b_opportunities;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text; return; end if;
  if p_outcome not in ('won', 'lost') or (p_outcome = 'won' and coalesce(p_value_minor, 0) <= 0) then return query select 'invalid'::text; return; end if;
  select * into o from crm.b2b_opportunities x where x.id = p_opportunity and x.organization_id = p_organization_id for update;
  if o.id is null then return query select 'not_found'::text; return; end if;
  if o.status <> 'submitted' then return query select 'not_submitted'::text; return; end if;
  perform set_config('crm.b2b_write', '1', true);
  update crm.b2b_opportunities set status = p_outcome, outcome_value_minor = case when p_outcome = 'won' then p_value_minor end, outcome_note = left(nullif(btrim(coalesce(p_note, '')), ''), 500), closed_at = now() where id = o.id;
  perform set_config('crm.b2b_write', '', true);
  perform core.record_audit(p_organization_id, 'b2b.opportunity_' || p_outcome, 'b2b_opportunity', o.id, null, jsonb_build_object('value_minor', p_value_minor));
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm.record_b2b_outcome(uuid, uuid, text, bigint, text) from public, anon;
grant execute on function crm.record_b2b_outcome(uuid, uuid, text, bigint, text) to authenticated, service_role;

-- A person links a lead the platform conversation became. It adds a touchpoint; it creates nothing and merges nothing.
create or replace function crm.link_b2b_opportunity_lead(p_organization_id uuid, p_opportunity uuid, p_lead uuid)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare o crm.b2b_opportunities;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text; return; end if;
  select * into o from crm.b2b_opportunities x where x.id = p_opportunity and x.organization_id = p_organization_id for update;
  if o.id is null then return query select 'not_found'::text; return; end if;
  if o.lead_id is not null then return query select 'already_linked'::text; return; end if;
  if not exists (select 1 from crm.leads l where l.id = p_lead and l.organization_id = p_organization_id) then return query select 'unknown_lead'::text; return; end if;
  perform set_config('crm.b2b_write', '1', true);
  update crm.b2b_opportunities set lead_id = p_lead where id = o.id;
  perform set_config('crm.b2b_write', '', true);
  perform crm.record_touchpoint(p_organization_id, p_lead, 'b2b', o.platform, 'profile_inquiry', jsonb_build_object('opportunity_id', o.id, 'external_ref', o.external_ref), '{}'::jsonb, 'b2b:' || o.id::text, o.created_at);
  return query select 'linked'::text;
end;
$$;
revoke all on function crm.link_b2b_opportunity_lead(uuid, uuid, uuid) from public, anon;
grant execute on function crm.link_b2b_opportunity_lead(uuid, uuid, uuid) to authenticated, service_role;

-- ── 9. proposal rules, versions, check, submit ─────────────────────────────

create or replace function crm.b2b_copy_problems(p_text text, p_offplatform text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v jsonb := crm._copy_problems(p_text); t text := coalesce(p_text, '');
begin
  if p_offplatform is distinct from 'allowed' then
    if t ~* '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' then v := v || to_jsonb('contains_an_email_address'::text); end if;
    if t ~ '\+?[0-9][0-9 ().-]{7,}[0-9]' then v := v || to_jsonb('contains_a_phone_number'::text); end if;
    if t ~* '(whatsapp|wa\.me|telegram|t\.me|skype|signal app|discord|viber)' then v := v || to_jsonb('names_a_messaging_app'::text); end if;
    if t ~* 'https?://' or t ~* 'www\.' then v := v || to_jsonb('contains_an_external_link'::text); end if;
  end if;
  return v;
end;
$$;

create or replace function crm.add_b2b_proposal_version(p_organization_id uuid, p_opportunity uuid, p_body text, p_price_minor bigint, p_timeline_days integer, p_connects_cost integer, p_portfolio_item_ids uuid[], p_by_type text default 'human')
returns table (outcome text, version_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare o crm.b2b_opportunities; v_n integer; v_id uuid; r record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_by_type not in ('human', 'agent', 'rule') or (p_by_type <> 'human' and p_price_minor is not null) then return query select 'invalid'::text, null::uuid; return; end if;
  select * into o from crm.b2b_opportunities x where x.id = p_opportunity and x.organization_id = p_organization_id for update;
  if o.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if o.status <> 'shortlisted' then return query select 'not_shortlisted'::text, null::uuid; return; end if;
  if exists (select 1 from crm.b2b_proposal_versions v where v.opportunity_id = o.id and v.state in ('SUBMITTING', 'SUBMITTED')) then return query select 'already_submitted'::text, null::uuid; return; end if;
  for r in select v.id, v.approval_request_id from crm.b2b_proposal_versions v where v.opportunity_id = o.id and v.state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW') loop
    if r.approval_request_id is not null then perform approvals.cancel_request(r.approval_request_id, 'a newer version of the proposal replaced it'); end if;
    perform crm._b2b_set('proposal', r.id, 'SUPERSEDED');
  end loop;
  select coalesce(max(v.version), 0) + 1 into v_n from crm.b2b_proposal_versions v where v.opportunity_id = o.id;
  insert into crm.b2b_proposal_versions (organization_id, opportunity_id, version, body, currency, price_minor, timeline_days, connects_cost, portfolio_item_ids, created_by_type, created_by)
  values (p_organization_id, o.id, v_n, p_body, o.currency, p_price_minor, p_timeline_days, coalesce(p_connects_cost, 0), coalesce(p_portfolio_item_ids, '{}'), p_by_type, (select auth.uid()))
  returning id into v_id;
  perform core.record_audit(p_organization_id, 'b2b.proposal_version_added', 'b2b_opportunity', o.id, null, jsonb_build_object('version', v_n));
  return query select 'added'::text, v_id;
exception when check_violation or not_null_violation then return query select 'invalid'::text, null::uuid;
end;
$$;
revoke all on function crm.add_b2b_proposal_version(uuid, uuid, text, bigint, integer, integer, uuid[], text) from public, anon;
grant execute on function crm.add_b2b_proposal_version(uuid, uuid, text, bigint, integer, integer, uuid[], text) to authenticated, service_role;

create or replace function crm.check_b2b_proposal(p_organization_id uuid, p_version uuid)
returns table (outcome text, problems jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.b2b_proposal_versions; o crm.b2b_opportunities; rule crm.b2b_platform_rules; s crm.b2b_settings; p jsonb; pid uuid; v_used bigint;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::jsonb; return; end if;
  select * into v from crm.b2b_proposal_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::jsonb; return; end if;
  if v.state not in ('DRAFT', 'CHECK_FAILED') then return query select 'wrong_state'::text, null::jsonb; return; end if;
  select * into o from crm.b2b_opportunities x where x.id = v.opportunity_id;
  select * into rule from crm.b2b_platform_rules x where x.organization_id = p_organization_id and x.platform = o.platform;
  select * into s from crm.b2b_settings x where x.organization_id = p_organization_id;
  -- No rule row means forbidden: the rule is read as the restrictive one.
  p := crm.b2b_copy_problems(v.body, coalesce(rule.offplatform_contact, 'forbidden'));
  if length(btrim(v.body)) < 80 then p := p || to_jsonb('too_short_to_be_a_proposal'::text); end if;
  if v.price_minor is null then p := p || to_jsonb('needs_a_price_from_a_person'::text); end if;
  if v.timeline_days is null then p := p || to_jsonb('needs_a_timeline'::text); end if;
  foreach pid in array v.portfolio_item_ids loop
    if not exists (select 1 from crm.portfolio_items i where i.organization_id = p_organization_id and i.is_active and i.id = pid) then p := p || to_jsonb('past_work_is_not_a_portfolio_item'::text); end if;
  end loop;
  if s.monthly_connects_cap is not null then
    select coalesce(sum(u.amount), 0) into v_used from crm.acquisition_usage u
     where u.organization_id = p_organization_id and u.channel = 'b2b' and u.metric = 'connect' and u.occurred_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
    if v_used + v.connects_cost > s.monthly_connects_cap then p := p || to_jsonb('over_the_monthly_connects_budget'::text); end if;
  end if;
  p := (select coalesce(jsonb_agg(distinct e.value), '[]'::jsonb) from jsonb_array_elements(p) e);
  perform set_config('crm.b2b_write', '1', true);
  update crm.b2b_proposal_versions set state = case when jsonb_array_length(p) = 0 then 'CHECKED' else 'CHECK_FAILED' end, review = jsonb_build_object('problems', p, 'checked_at', now()) where id = v.id;
  perform set_config('crm.b2b_write', '', true);
  return query select case when jsonb_array_length(p) = 0 then 'checked' else 'check_failed' end::text, p;
end;
$$;
revoke all on function crm.check_b2b_proposal(uuid, uuid) from public, anon;
grant execute on function crm.check_b2b_proposal(uuid, uuid) to authenticated, service_role;

create or replace function crm.submit_b2b_proposal(p_organization_id uuid, p_version uuid)
returns table (outcome text, approval_request_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.b2b_proposal_versions; o crm.b2b_opportunities; b record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  select * into v from crm.b2b_proposal_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v.state <> 'CHECKED' then return query select 'not_checked'::text, null::uuid; return; end if;
  select * into o from crm.b2b_opportunities x where x.id = v.opportunity_id;
  select * into b from crm.bind_approval(p_organization_id, 'b2b_proposal', v.id, v.version, v.content_hash,
    left(o.platform || ' · ' || o.title || ' · ' || v.price_minor::text || ' ' || v.currency || ' (minor units) · ' || v.body, 480), v.price_minor, 'system', null, 168);
  if b.outcome not in ('requested', 'already_pending') then return query select b.outcome::text, null::uuid; return; end if;
  perform set_config('crm.b2b_write', '1', true);
  update crm.b2b_proposal_versions set state = 'ADMIN_REVIEW', approval_request_id = b.request_id where id = v.id;
  perform set_config('crm.b2b_write', '', true);
  perform core.record_audit(p_organization_id, 'b2b.proposal_submitted_for_approval', 'b2b_opportunity', o.id, null, jsonb_build_object('version', v.version, 'approval_request_id', b.request_id, 'hash', v.content_hash));
  return query select 'submitted'::text, b.request_id;
end;
$$;
revoke all on function crm.submit_b2b_proposal(uuid, uuid) from public, anon;
grant execute on function crm.submit_b2b_proposal(uuid, uuid) to authenticated, service_role;

-- The ONE way a proposal is recorded as sent. Re-reads, NOW: the stops, the exact-version approval, the daily action limit, and the connects budget.
-- p_via 'manual' is a person's own act on the platform (no connector needed); 'adapter' is the engine and needs the platform's rule to allow automation.
create or replace function crm._b2b_begin_submit(p_organization_id uuid, p_version uuid, p_via text, p_correlation_id uuid)
returns table (outcome text, reason text, execution_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v crm.b2b_proposal_versions; o crm.b2b_opportunities; rule crm.b2b_platform_rules; s crm.b2b_settings; ch crm.acquisition_channels;
  g record; v_used bigint; v_today bigint; d record;
begin
  select * into v from crm.b2b_proposal_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text, null::uuid; return; end if;
  if v.state = 'SUBMITTED' then return query select 'already_submitted'::text, null::text, null::uuid; return; end if;
  if v.state not in ('ADMIN_REVIEW', 'SUBMITTING') then return query select 'not_approved_state'::text, v.state, null::uuid; return; end if;
  select * into o from crm.b2b_opportunities x where x.id = v.opportunity_id;
  select * into rule from crm.b2b_platform_rules x where x.organization_id = p_organization_id and x.platform = o.platform;
  select * into s from crm.b2b_settings x where x.organization_id = p_organization_id;
  if p_via = 'adapter' then
    if coalesce(rule.automation_mode, 'manual') <> 'automated' then return query select 'blocked'::text, 'platform_not_automated'::text, null::uuid; return; end if;
    select * into d from crm.acquisition_decide(p_organization_id, 'b2b_proposal_submit', 'b2b', coalesce(v.price_minor, 0), 1, p_correlation_id);
    if d.decision = 'BLOCK' then return query select 'blocked'::text, d.reason, null::uuid; return; end if;
  else
    -- A person acting on the platform needs no connector, but the stops, the daily limit and the budget still apply.
    if crm.acquisition_blocked(p_organization_id, 'b2b') is not null then return query select 'blocked'::text, crm.acquisition_blocked(p_organization_id, 'b2b'), null::uuid; return; end if;
    select * into ch from crm.acquisition_channels c where c.organization_id = p_organization_id and c.channel = 'b2b';
    if ch.organization_id is not null and ch.daily_limit is not null then
      select coalesce(sum(u.amount), 0) into v_today from crm.acquisition_usage u where u.organization_id = p_organization_id and u.channel = 'b2b' and u.metric = 'action' and u.occurred_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
      if v_today + 1 > ch.daily_limit then return query select 'blocked'::text, 'daily_limit'::text, null::uuid; return; end if;
    end if;
  end if;
  if s.monthly_connects_cap is not null and v.connects_cost > 0 then
    select coalesce(sum(u.amount), 0) into v_used from crm.acquisition_usage u where u.organization_id = p_organization_id and u.channel = 'b2b' and u.metric = 'connect' and u.occurred_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
    if v_used + v.connects_cost > s.monthly_connects_cap then return query select 'blocked'::text, 'monthly_connects_exceeded'::text, null::uuid; return; end if;
  end if;
  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'b2b_proposal', v.id, v.content_hash, 'b2b_proposal_submit', 'b2b', p_correlation_id);
  if g.outcome = 'proceed' then
    if v.state = 'ADMIN_REVIEW' then perform crm._b2b_set('proposal', v.id, 'SUBMITTING'); end if;
    return query select 'proceed'::text, g.reason, g.execution_id; return;
  end if;
  return query select g.outcome::text, g.reason, g.execution_id;
end;
$$;
revoke all on function crm._b2b_begin_submit(uuid, uuid, text, uuid) from public, anon, authenticated;

create or replace function crm.begin_b2b_submit(p_organization_id uuid, p_version uuid, p_correlation_id uuid default null)
returns table (outcome text, reason text, execution_id uuid)
language sql volatile security definer set search_path = '' as $$
  select * from crm._b2b_begin_submit(p_organization_id, p_version, 'adapter', p_correlation_id);
$$;
revoke all on function crm.begin_b2b_submit(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function crm.begin_b2b_submit(uuid, uuid, uuid) to service_role;

create or replace function crm._b2b_finish_submit(p_organization_id uuid, p_version uuid, p_execution uuid, p_status text, p_external_ref text, p_via text, p_evidence jsonb)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.b2b_proposal_versions; f record;
begin
  if p_status not in ('executed', 'failed', 'unknown') then return query select 'invalid'::text; return; end if;
  select * into v from crm.b2b_proposal_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state <> 'SUBMITTING' then return query select 'wrong_state'::text; return; end if;
  if p_status = 'executed' and coalesce(btrim(p_external_ref), '') = '' then return query select 'needs_reference'::text; return; end if;
  select * into f from crm.finish_governed_execution(p_organization_id, p_execution, p_status, p_external_ref, p_evidence);
  if f.outcome <> 'recorded' then return query select f.outcome::text; return; end if;
  if p_status = 'executed' then
    perform set_config('crm.b2b_write', '1', true);
    update crm.b2b_proposal_versions set state = 'SUBMITTED', external_ref = left(btrim(p_external_ref), 200), submitted_via = p_via where id = v.id;
    update crm.b2b_opportunities set status = 'submitted' where id = v.opportunity_id;
    perform set_config('crm.b2b_write', '', true);
    perform crm.record_acquisition_usage(p_organization_id, 'b2b', 'action', 1, 'b2b-submit:' || v.id::text);
    if v.connects_cost > 0 then perform crm.record_acquisition_usage(p_organization_id, 'b2b', 'connect', v.connects_cost, 'b2b-connects:' || v.id::text); end if;
  elsif p_status = 'failed' then
    perform crm._b2b_set('proposal', v.id, 'ADMIN_REVIEW');
  end if;
  perform core.record_audit(p_organization_id, 'b2b.proposal_' || p_status, 'b2b_opportunity', v.opportunity_id, null, jsonb_build_object('version', v.version, 'via', p_via, 'external_ref', left(p_external_ref, 200)));
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm._b2b_finish_submit(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;

create or replace function crm.record_b2b_submit(p_organization_id uuid, p_version uuid, p_execution uuid, p_status text, p_external_ref text, p_evidence jsonb default '{}')
returns table (outcome text)
language sql volatile security definer set search_path = '' as $$
  select * from crm._b2b_finish_submit(p_organization_id, p_version, p_execution, p_status, p_external_ref, 'adapter', p_evidence);
$$;
revoke all on function crm.record_b2b_submit(uuid, uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function crm.record_b2b_submit(uuid, uuid, uuid, text, text, jsonb) to service_role;

-- A person submitted it on the platform and says so. Accepted only for the exact approved version, once.
create or replace function crm.record_manual_b2b_submission(p_organization_id uuid, p_version uuid, p_external_ref text)
returns table (outcome text, reason text)
language plpgsql volatile security definer set search_path = '' as $$
declare b record; f record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::text; return; end if;
  if coalesce(btrim(p_external_ref), '') = '' then return query select 'needs_reference'::text, null::text; return; end if;
  select * into b from crm._b2b_begin_submit(p_organization_id, p_version, 'manual', null);
  if b.outcome <> 'proceed' then return query select b.outcome::text, b.reason; return; end if;
  select * into f from crm._b2b_finish_submit(p_organization_id, p_version, b.execution_id, 'executed', p_external_ref, 'manual', jsonb_build_object('recorded_by', 'a person on the platform'));
  return query select f.outcome::text, null::text;
end;
$$;
revoke all on function crm.record_manual_b2b_submission(uuid, uuid, text) from public, anon;
grant execute on function crm.record_manual_b2b_submission(uuid, uuid, text) to authenticated;

create or replace function crm.sync_b2b_approvals(p_limit integer default 200)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in select 'proposal' as kind, v.id, v.state_changed_at from crm.b2b_proposal_versions v join approvals.approval_requests a on a.id = v.approval_request_id
            where v.state = 'ADMIN_REVIEW' and a.state in ('rejected', 'expired', 'cancelled', 'changes_requested')
           union all
           select 'profile', v.id, v.state_changed_at from crm.b2b_profile_versions v join approvals.approval_requests a on a.id = v.approval_request_id
            where v.state = 'ADMIN_REVIEW' and a.state in ('rejected', 'expired', 'cancelled', 'changes_requested')
           order by 3 limit greatest(1, least(coalesce(p_limit, 200), 1000)) loop
    perform crm._b2b_set(r.kind, r.id, 'REJECTED');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function crm.sync_b2b_approvals(integer) from public, anon, authenticated;
grant execute on function crm.sync_b2b_approvals(integer) to service_role;

-- ── 10. profile changes ────────────────────────────────────────────────────

create or replace function crm.b2b_profile_problems(p_content jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v jsonb := '[]'::jsonb;
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object' then return '["content_is_not_an_object"]'::jsonb; end if;
  if length(coalesce(p_content ->> 'headline', '')) not between 5 and 120 then v := v || to_jsonb('headline_length'::text); end if;
  if length(coalesce(p_content ->> 'summary', '')) not between 50 and 3000 then v := v || to_jsonb('summary_length'::text); end if;
  if p_content ? 'testimonials' or p_content ? 'reviews' or p_content ? 'rating' or p_content ? 'badges' then v := v || to_jsonb('claims_a_platform_could_not_confirm'::text); end if;
  v := v || crm._copy_problems(p_content::text);
  return (select coalesce(jsonb_agg(distinct e.value), '[]'::jsonb) from jsonb_array_elements(v) e);
end;
$$;

create or replace function crm.add_b2b_profile_version(p_organization_id uuid, p_platform text, p_content jsonb, p_by_type text default 'human')
returns table (outcome text, version_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v_n integer; v_id uuid; r record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_by_type not in ('human', 'agent', 'rule') then return query select 'invalid'::text, null::uuid; return; end if;
  for r in select v.id, v.approval_request_id from crm.b2b_profile_versions v where v.organization_id = p_organization_id and v.platform = p_platform and v.state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW') loop
    if r.approval_request_id is not null then perform approvals.cancel_request(r.approval_request_id, 'a newer version of the profile replaced it'); end if;
    perform crm._b2b_set('profile', r.id, 'SUPERSEDED');
  end loop;
  select coalesce(max(v.version), 0) + 1 into v_n from crm.b2b_profile_versions v where v.organization_id = p_organization_id and v.platform = p_platform;
  insert into crm.b2b_profile_versions (organization_id, platform, version, content, created_by_type, created_by) values (p_organization_id, p_platform, v_n, p_content, p_by_type, (select auth.uid())) returning id into v_id;
  return query select 'added'::text, v_id;
exception when check_violation or not_null_violation then return query select 'invalid'::text, null::uuid;
end;
$$;
revoke all on function crm.add_b2b_profile_version(uuid, text, jsonb, text) from public, anon;
grant execute on function crm.add_b2b_profile_version(uuid, text, jsonb, text) to authenticated, service_role;

create or replace function crm.check_b2b_profile(p_organization_id uuid, p_version uuid)
returns table (outcome text, problems jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.b2b_profile_versions; p jsonb;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::jsonb; return; end if;
  select * into v from crm.b2b_profile_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::jsonb; return; end if;
  if v.state not in ('DRAFT', 'CHECK_FAILED') then return query select 'wrong_state'::text, null::jsonb; return; end if;
  p := crm.b2b_profile_problems(v.content);
  perform set_config('crm.b2b_write', '1', true);
  update crm.b2b_profile_versions set state = case when jsonb_array_length(p) = 0 then 'CHECKED' else 'CHECK_FAILED' end, review = jsonb_build_object('problems', p, 'checked_at', now()) where id = v.id;
  perform set_config('crm.b2b_write', '', true);
  return query select case when jsonb_array_length(p) = 0 then 'checked' else 'check_failed' end::text, p;
end;
$$;
revoke all on function crm.check_b2b_profile(uuid, uuid) from public, anon;
grant execute on function crm.check_b2b_profile(uuid, uuid) to authenticated, service_role;

create or replace function crm.submit_b2b_profile(p_organization_id uuid, p_version uuid)
returns table (outcome text, approval_request_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.b2b_profile_versions; b record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  select * into v from crm.b2b_profile_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v.state <> 'CHECKED' then return query select 'not_checked'::text, null::uuid; return; end if;
  select * into b from crm.bind_approval(p_organization_id, 'acquisition_action', v.id, v.version, v.content_hash,
    left('Update ' || v.platform || ' profile · ' || coalesce(v.content ->> 'headline', ''), 480), null, 'system', null, 168);
  if b.outcome not in ('requested', 'already_pending') then return query select b.outcome::text, null::uuid; return; end if;
  perform set_config('crm.b2b_write', '1', true);
  update crm.b2b_profile_versions set state = 'ADMIN_REVIEW', approval_request_id = b.request_id where id = v.id;
  perform set_config('crm.b2b_write', '', true);
  return query select 'submitted'::text, b.request_id;
end;
$$;
revoke all on function crm.submit_b2b_profile(uuid, uuid) from public, anon;
grant execute on function crm.submit_b2b_profile(uuid, uuid) to authenticated, service_role;

-- A person changed the profile on the platform and says so. Accepted only for the exact approved version, once.
create or replace function crm.record_manual_profile_update(p_organization_id uuid, p_version uuid, p_evidence_url text)
returns table (outcome text, reason text)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.b2b_profile_versions; g record; f record; prev uuid;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::text; return; end if;
  if coalesce(p_evidence_url, '') !~ '^https://' then return query select 'needs_evidence'::text, null::text; return; end if;
  select * into v from crm.b2b_profile_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v.state = 'APPLIED' then return query select 'already_applied'::text, null::text; return; end if;
  if v.state <> 'ADMIN_REVIEW' then return query select 'not_approved_state'::text, v.state; return; end if;
  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'acquisition_action', v.id, v.content_hash, 'profile_update', 'b2b', null);
  if g.outcome <> 'proceed' then return query select g.outcome::text, g.reason; return; end if;
  select * into f from crm.finish_governed_execution(p_organization_id, g.execution_id, 'executed', p_evidence_url, jsonb_build_object('recorded_by', 'a person on the platform'));
  if f.outcome <> 'recorded' then return query select f.outcome::text, null::text; return; end if;
  for prev in select x.id from crm.b2b_profile_versions x where x.organization_id = p_organization_id and x.platform = v.platform and x.state = 'APPLIED' loop
    perform crm._b2b_set('profile', prev, 'SUPERSEDED');
  end loop;
  perform set_config('crm.b2b_write', '1', true);
  update crm.b2b_profile_versions set state = 'APPLIED', evidence_url = p_evidence_url where id = v.id;
  perform set_config('crm.b2b_write', '', true);
  perform crm.record_acquisition_usage(p_organization_id, 'b2b', 'action', 1, 'b2b-profile:' || v.id::text);
  perform core.record_audit(p_organization_id, 'b2b.profile_applied', 'b2b_profile', v.id, null, jsonb_build_object('platform', v.platform, 'version', v.version));
  return query select 'recorded'::text, null::text;
end;
$$;
revoke all on function crm.record_manual_profile_update(uuid, uuid, text) from public, anon;
grant execute on function crm.record_manual_profile_update(uuid, uuid, text) to authenticated;

-- ── 11. results, from the records themselves ───────────────────────────────

create or replace function crm.b2b_outcomes()
returns table (platform text, found bigint, shortlisted bigint, submitted bigint, won bigint, lost bigint, revenue_minor bigint, connects_spent bigint, win_rate_pct integer, insufficient_data boolean)
language sql stable security definer set search_path = '' as $$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org)
  select o.platform,
         count(*)::bigint,
         count(*) filter (where o.status in ('shortlisted', 'submitted', 'won', 'lost'))::bigint,
         count(*) filter (where o.status in ('submitted', 'won', 'lost'))::bigint,
         count(*) filter (where o.status = 'won')::bigint,
         count(*) filter (where o.status = 'lost')::bigint,
         coalesce(sum(o.outcome_value_minor) filter (where o.status = 'won'), 0)::bigint,
         coalesce((select sum(p.connects_cost) from crm.b2b_proposal_versions p join crm.b2b_opportunities o2 on o2.id = p.opportunity_id
                    where o2.platform = o.platform and o2.organization_id = o.organization_id and p.state = 'SUBMITTED'), 0)::bigint,
         case when count(*) filter (where o.status in ('won', 'lost')) > 0
              then round(100.0 * count(*) filter (where o.status = 'won') / count(*) filter (where o.status in ('won', 'lost')))::integer end,
         count(*) filter (where o.status in ('won', 'lost')) < 10
    from crm.b2b_opportunities o, caller k
   where k.uid is null or o.organization_id = k.org
   group by o.platform, o.organization_id
   order by o.platform;
$$;
revoke all on function crm.b2b_outcomes() from public, anon;
grant execute on function crm.b2b_outcomes() to authenticated, service_role;

-- ── 12. the tracked WhatsApp handoff honours the marketplace's rule ────────
-- crm.create_channel_handoff, carried forward from 20261015300000 with ONE edit: the marked block that refuses a B2B handoff the
-- platform's rule does not permit.

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

  -- A marketplace may forbid taking a conversation off its platform. Fail closed: no rule is a refusal, not permission.
  if p_source_channel = 'b2b' then
    if coalesce(btrim(p_source_platform), '') = '' then return query select 'platform_required'::text, null::uuid, null::timestamptz; return; end if;
    if not exists (
         select 1 from crm.b2b_platform_rules r
          where r.organization_id = p_organization_id and r.platform = p_source_platform
            and (r.offplatform_contact = 'allowed'
                 or (r.offplatform_contact = 'after_award' and exists (select 1 from crm.b2b_opportunities o where o.organization_id = p_organization_id and o.lead_id = p_lead and o.status = 'won')))) then
      return query select 'offplatform_forbidden'::text, null::uuid, null::timestamptz; return;
    end if;
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
notify pgrst, 'reload schema';
