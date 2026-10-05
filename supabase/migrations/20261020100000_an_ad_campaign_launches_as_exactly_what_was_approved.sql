-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 8 — an ad campaign launches as EXACTLY what was
-- approved, its money is counted, and its results are read from the CRM.
--
-- Spec §9, §10, §65, §82, §83 (campaign half), §176, §181. One engine for both
-- ad platforms (Meta/Facebook and Google), because what must be true is the
-- same for both: nothing spends money until a person has approved exactly
-- this plan and this budget; a change to a live campaign is a new plan with
-- its own approval; every rupee reported is counted against the channel's cap;
-- and success is judged by qualified leads, meetings, quotes and WON clients -
-- never by clicks or the cheapest lead.
--
-- It reuses, rather than repeats, what slices 4 and 7 built: the approval
-- binding (a content hash and a validity window), the one-execution-per-
-- approval door, the decision function, the usage ledger. The new things are
-- the ad plan itself and what can be checked about it WITHOUT a provider:
--
--  1. A PLAN IS A DOCUMENT WITH RULES. Meta plans must route to WhatsApp (the
--     spec's primary route), name audiences within the target geographies, and
--     carry no pressure language or unproven claims in any text; Google plans
--     need keyword groups, a negative-keyword strategy and responsive-ad text
--     within the platform's length limits. A plan that breaks a rule fails its
--     check and cannot be sent for approval.
--
--  2. THE BUDGET IS CHECKED AGAINST THE ADMIN'S CAP BEFORE ANYONE IS ASKED.
--     A plan whose month would push the channel past its monthly budget fails
--     its check; and launching asks crm.acquisition_decide with the amount, so
--     the cap, the stops and the connector are re-read at the moment of
--     launch. A cap is a cap: approval cannot lift it, the Admin raises it in
--     Settings where it is audited.
--
--  3. A CHANGE TO A LIVE CAMPAIGN IS A NEW VERSION. Each version is immutable
--     with a derived hash, like a content version. Applying one classifies what
--     changed (budget up, targeting, creative) so the right action is asked
--     about, and the version it replaces becomes history only when the new one
--     is confirmed live. Automatic ad changes are NOT offered: the two ad
--     actions that could have been automatic (budget increase, targeting
--     change) are added to the actions that always need a person, because a
--     safe automatic path (an approval-free execution record) does not exist
--     yet and pretending otherwise would be the false automation the spec
--     forbids.
--
--  4. SPEND IS A LEDGER, AND RESTATEMENTS DO NOT DOUBLE-COUNT. Providers
--     restate a day's spend. Each report is stored; only the INCREASE over the
--     last report for that day is added to crm.acquisition_usage, so the
--     monthly cap sees the truth once.
--
--  5. RESULTS COME FROM THE CRM. First-touch attribution through the
--     touchpoint log (a Click-to-WhatsApp ad id already lands there) joined to
--     the provider ids recorded at launch gives leads, qualified leads,
--     meetings, quotes, WON and revenue per campaign, and from spend the cost
--     of each - with an explicit "insufficient data" flag instead of a
--     misleading ratio. Recommendations carry their evidence, impact,
--     confidence, risk and period (spec §176) and are never applied by
--     themselves.
--
-- What is NOT here: any call to Meta or Google (no adapter exists - a launch
-- result arrives through crm.record_ad_apply from whatever adapter is written),
-- the audit of an existing account (assisted entry only), and the Google
-- landing-page destination check (slice 9 adds it).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. two more actions that always need a person ──────────────────────────

update crm.acquisition_policies set mode = 'approval' where action_type in ('ad_budget_increase', 'ad_targeting_change') and mode = 'auto';
alter table crm.acquisition_policies drop constraint if exists acquisition_policies_hard_gates;
alter table crm.acquisition_policies add constraint acquisition_policies_hard_gates
  check (mode <> 'auto' or action_type not in ('social_publish', 'b2b_proposal_submit', 'ad_launch', 'landing_page_deploy', 'profile_update', 'ad_budget_increase', 'ad_targeting_change'));
comment on constraint acquisition_policies_hard_gates on crm.acquisition_policies is
  'The actions that always need a person. Ad budget increases and targeting changes joined the list in slice 8: an automatic ad change needs an approval-free execution record that does not exist yet.';

-- crm.set_acquisition_policy, carried forward from its live definition with ONE edit: the never-auto list above.
create or replace function crm.set_acquisition_policy(p_action text, p_mode text, p_approval_above_minor bigint, p_escalate_above_minor bigint)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if p_mode = 'auto' and p_action in ('social_publish', 'b2b_proposal_submit', 'ad_launch', 'landing_page_deploy', 'profile_update', 'ad_budget_increase', 'ad_targeting_change') then
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
$function$;

-- ── 1. campaigns and immutable versions ────────────────────────────────────

create table if not exists crm.ad_campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  platform         text not null check (platform in ('meta_ads', 'google_ads')),
  name             text not null check (length(btrim(name)) between 3 and 120),
  objective        text not null default 'qualified_leads' check (length(objective) between 3 and 80),
  target_service   text check (target_service is null or length(target_service) between 2 and 80),
  currency         char(3) not null default 'INR',
  status           text not null default 'draft' check (status in ('draft', 'live', 'paused', 'ended')),
  current_version_id uuid,
  live_version_id  uuid,
  provider_sync_pending text check (provider_sync_pending is null or provider_sync_pending in ('pause', 'resume', 'end')),
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
comment on table crm.ad_campaigns is
  'One ad campaign on one platform. Its plan lives only in immutable versions. provider_sync_pending says AgencyOS has recorded an intent (pause, resume, end) that the platform has not yet confirmed - the screen never claims a pause that has not been confirmed.';

create table if not exists crm.ad_campaign_versions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  campaign_id      uuid not null references crm.ad_campaigns(id) on delete restrict,
  version          integer not null check (version >= 1),
  plan             jsonb not null check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 60000),
  budget_daily_minor bigint not null check (budget_daily_minor > 0),
  budget_total_minor bigint check (budget_total_minor is null or budget_total_minor >= budget_daily_minor),
  start_date       date,
  end_date         date,
  change_kind      text not null default 'launch' check (change_kind in ('launch', 'budget_increase', 'budget_decrease', 'targeting_change', 'creative_change')),
  change_amount_minor bigint not null default 0 check (change_amount_minor >= 0),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  state            text not null default 'DRAFT' check (state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW', 'REJECTED', 'LAUNCHING', 'LIVE', 'PAUSED', 'ENDED', 'SUPERSEDED', 'CANCELLED')),
  review           jsonb check (review is null or jsonb_typeof(review) = 'object'),
  approval_request_id uuid references approvals.approval_requests(id) on delete set null,
  supersedes_version_id uuid references crm.ad_campaign_versions(id) on delete set null,
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  unique (campaign_id, version),
  constraint ad_versions_dates_make_sense check (end_date is null or start_date is null or end_date >= start_date)
);
create index if not exists ad_versions_org_state_idx on crm.ad_campaign_versions (organization_id, state, created_at desc);
comment on table crm.ad_campaign_versions is
  'One immutable version of a campaign plan and its budget. The hash and the kind of change (launch, budget increase, targeting change, creative change) are derived by a trigger; only the workflow state moves, and only through the doors. Applying a version to a live campaign is a governed execution like any other.';

alter table crm.ad_campaigns drop constraint if exists ad_campaigns_current_version_fk;
alter table crm.ad_campaigns add constraint ad_campaigns_current_version_fk foreign key (current_version_id) references crm.ad_campaign_versions(id) on delete set null deferrable initially deferred;
alter table crm.ad_campaigns drop constraint if exists ad_campaigns_live_version_fk;
alter table crm.ad_campaigns add constraint ad_campaigns_live_version_fk foreign key (live_version_id) references crm.ad_campaign_versions(id) on delete set null deferrable initially deferred;

create table if not exists crm.ad_provider_objects (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  campaign_id      uuid not null references crm.ad_campaigns(id) on delete cascade,
  platform         text not null check (platform in ('meta_ads', 'google_ads')),
  object_type      text not null check (object_type in ('campaign', 'ad_set', 'ad_group', 'ad', 'keyword', 'creative')),
  provider_id      text not null check (length(provider_id) between 1 and 200),
  created_at       timestamptz not null default now(),
  unique (organization_id, platform, object_type, provider_id)
);
comment on table crm.ad_provider_objects is 'The provider ids a launch created, so an ad id found on a lead (a Click-to-WhatsApp referral, a tracked click) resolves back to THIS campaign. One provider object maps to one campaign, ever.';

create table if not exists crm.ad_applications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  version_id       uuid not null references crm.ad_campaign_versions(id) on delete restrict,
  execution_id     uuid not null references crm.governed_executions(id) on delete restrict,
  provider_campaign_id text not null check (length(provider_campaign_id) between 1 and 200),
  applied_at       timestamptz not null default now(),
  unique (version_id),
  unique (execution_id)
);
comment on table crm.ad_applications is 'The record that a version was applied at the provider. One per version, ever. Append-only.';

create table if not exists crm.ad_metrics (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  campaign_id      uuid not null references crm.ad_campaigns(id) on delete cascade,
  metric_date      date not null,
  reported_at      timestamptz not null default clock_timestamp(),
  spend_minor      bigint not null check (spend_minor >= 0),
  impressions      bigint not null default 0 check (impressions >= 0),
  clicks           bigint not null default 0 check (clicks >= 0),
  platform_leads   bigint not null default 0 check (platform_leads >= 0)
);
create index if not exists ad_metrics_campaign_idx on crm.ad_metrics (campaign_id, metric_date, reported_at desc);
comment on table crm.ad_metrics is 'Daily figures as the platform reported them, append-only. A restated day is a new row; the latest report per day is the figure used, and only the INCREASE in spend is added to the usage ledger.';

create table if not exists crm.ad_provider_statuses (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  campaign_id      uuid not null references crm.ad_campaigns(id) on delete cascade,
  status           text not null check (status in ('active', 'paused', 'rejected', 'disapproved', 'limited', 'suspended')),
  detail           text check (detail is null or length(detail) <= 500),
  reported_at      timestamptz not null default clock_timestamp()
);
create index if not exists ad_provider_statuses_idx on crm.ad_provider_statuses (campaign_id, reported_at desc);

create table if not exists crm.campaign_health_records (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  campaign_id      uuid not null references crm.ad_campaigns(id) on delete cascade,
  kind             text not null check (kind in ('zero_delivery', 'budget_overrun', 'spend_spike', 'cpl_spike', 'possible_tracking_failure', 'low_quality_leads', 'ads_rejected', 'platform_limited')),
  severity         text not null check (severity in ('info', 'warning', 'critical')),
  detail           jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  recommended_action text not null check (length(recommended_action) between 3 and 500),
  assessed_on      date not null default (now() at time zone 'utc')::date,
  created_at       timestamptz not null default now(),
  unique (campaign_id, kind, assessed_on)
);
comment on table crm.campaign_health_records is 'What looks wrong with a campaign (spec §9) and what a person should look at. A record never changes the campaign: assessing health is reading, not acting.';

-- ── helpers: the shape of a plan, and what changed between two ─────────────

create or replace function crm._jarr(j jsonb)
returns jsonb language sql immutable parallel safe set search_path = '' as $$
  select case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end;
$$;

create or replace function crm._ad_monthly_estimate(p_daily bigint, p_total bigint)
returns bigint language sql immutable parallel safe set search_path = '' as $$
  select case when p_total is null then p_daily * 30 else least(p_daily * 30, p_total) end;
$$;

create or replace function crm._ad_targeting_signature(p_platform text, p_plan jsonb)
returns jsonb language sql immutable parallel safe set search_path = '' as $$
  select case when p_platform = 'meta_ads'
              then jsonb_build_object('adsets', coalesce((select jsonb_agg(jsonb_build_object('audience', a -> 'audience', 'placements', a -> 'placements') order by a ->> 'name') from jsonb_array_elements(crm._jarr(p_plan -> 'adsets')) a), '[]'::jsonb))
              else jsonb_build_object('groups', coalesce((select jsonb_agg(jsonb_build_object('keywords', g -> 'keywords') order by g ->> 'name') from jsonb_array_elements(crm._jarr(p_plan -> 'ad_groups')) g), '[]'::jsonb),
                                      'negatives', coalesce(p_plan -> 'negative_keywords', '[]'::jsonb)) end;
$$;

create or replace function crm._ad_creative_signature(p_platform text, p_plan jsonb)
returns jsonb language sql immutable parallel safe set search_path = '' as $$
  select case when p_platform = 'meta_ads' then coalesce(p_plan -> 'creatives', '[]'::jsonb) else coalesce(p_plan -> 'ads', '[]'::jsonb) end;
$$;

-- What is wrong with a plan, as codes. Pure: no table is read, so the rules are the same wherever they run.
create or replace function crm.ad_plan_problems(p_platform text, p_plan jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := '[]'::jsonb;
  t text;
  phrase text;
  a jsonb; c jsonb; g jsonb; k jsonb; x jsonb;
  n integer;
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then return '["plan_is_not_an_object"]'::jsonb; end if;
  t := lower(p_plan::text);

  foreach phrase in array array['limited time', 'act now', 'only today', 'last chance', 'offer expires', 'hurry', 'don''t miss out', 'only a few spots',
                                'guaranteed results', '100% guarantee', 'we guarantee', 'risk-free', 'once in a lifetime'] loop
    if position(phrase in t) > 0 then v := v || to_jsonb('manufactured_urgency:' || phrase); end if;
  end loop;
  foreach phrase in array array['#1', 'number one', 'best in', 'world-class', 'award-winning', 'top-rated', 'industry-leading', 'market leader'] loop
    if position(phrase in t) > 0 then v := v || to_jsonb('unsupported_claim:' || phrase); end if;
  end loop;
  if t ~ '[0-9]+(\.[0-9]+)?\s*%' then v := v || to_jsonb('unverified_statistic'::text); end if;

  if p_platform = 'meta_ads' then
    if coalesce(p_plan #>> '{destination,type}', '') <> 'whatsapp' then v := v || to_jsonb('meta_must_route_to_whatsapp'::text); end if;
    if jsonb_array_length(crm._jarr(p_plan -> 'adsets')) = 0 then v := v || to_jsonb('needs_an_ad_set'::text); end if;
    for a in select e.value from jsonb_array_elements(crm._jarr(p_plan -> 'adsets')) e loop
      if jsonb_array_length(crm._jarr(a #> '{audience,locations}')) = 0 then v := v || to_jsonb('ad_set_needs_locations'::text); end if;
      if coalesce((a #>> '{audience,age_min}')::numeric, 0) < 18 then v := v || to_jsonb('age_min_below_18'::text); end if;
    end loop;
    if jsonb_array_length(crm._jarr(p_plan -> 'creatives')) = 0 then v := v || to_jsonb('needs_a_creative'::text); end if;
    for c in select e.value from jsonb_array_elements(crm._jarr(p_plan -> 'creatives')) e loop
      if length(coalesce(c ->> 'headline', '')) not between 1 and 40 then v := v || to_jsonb('headline_length'::text); end if;
      if length(coalesce(c ->> 'primary_text', '')) not between 20 and 500 then v := v || to_jsonb('primary_text_length'::text); end if;
      if coalesce(c ->> 'cta', '') <> 'WHATSAPP_MESSAGE' then v := v || to_jsonb('cta_must_open_whatsapp'::text); end if;
    end loop;
  elsif p_platform = 'google_ads' then
    if coalesce(p_plan #>> '{destination,type}', '') <> 'landing_page' or coalesce(p_plan #>> '{destination,landing_page_version_id}', '') !~* '^[0-9a-f-]{36}$' then
      v := v || to_jsonb('google_needs_a_landing_page'::text);
    end if;
    if jsonb_array_length(crm._jarr(p_plan -> 'ad_groups')) = 0 then v := v || to_jsonb('needs_an_ad_group'::text); end if;
    for g in select e.value from jsonb_array_elements(crm._jarr(p_plan -> 'ad_groups')) e loop
      n := jsonb_array_length(crm._jarr(g -> 'keywords'));
      if n < 3 then v := v || to_jsonb('ad_group_needs_three_or_more_keywords'::text); end if;
      for k in select e.value from jsonb_array_elements(crm._jarr(g -> 'keywords')) e loop
        if coalesce(k ->> 'match', '') not in ('exact', 'phrase', 'broad') or length(coalesce(k ->> 'text', '')) not between 2 and 80 then v := v || to_jsonb('keyword_shape'::text); end if;
      end loop;
    end loop;
    if jsonb_array_length(crm._jarr(p_plan -> 'negative_keywords')) = 0 then v := v || to_jsonb('needs_a_negative_keyword_strategy'::text); end if;
    if jsonb_array_length(crm._jarr(p_plan -> 'ads')) = 0 then v := v || to_jsonb('needs_an_ad'::text); end if;
    for a in select e.value from jsonb_array_elements(crm._jarr(p_plan -> 'ads')) e loop
      n := jsonb_array_length(crm._jarr(a -> 'headlines'));
      if n not between 3 and 15 then v := v || to_jsonb('headline_count'::text); end if;
      for x in select e.value from jsonb_array_elements(crm._jarr(a -> 'headlines')) e loop
        if length(coalesce(x #>> '{}', '')) not between 1 and 30 then v := v || to_jsonb('headline_over_30_characters'::text); end if;
      end loop;
      n := jsonb_array_length(crm._jarr(a -> 'descriptions'));
      if n not between 2 and 4 then v := v || to_jsonb('description_count'::text); end if;
      for x in select e.value from jsonb_array_elements(crm._jarr(a -> 'descriptions')) e loop
        if length(coalesce(x #>> '{}', '')) not between 1 and 90 then v := v || to_jsonb('description_over_90_characters'::text); end if;
      end loop;
    end loop;
  end if;
  return (select coalesce(jsonb_agg(distinct e.value), '[]'::jsonb) from jsonb_array_elements(v) e);
end;
$$;

-- ── the hash and the kind of change are DERIVED ────────────────────────────

create or replace function crm.ad_version_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c crm.ad_campaigns;
  p crm.ad_campaign_versions;
  v_new bigint;
  v_old bigint;
begin
  select * into c from crm.ad_campaigns x where x.id = new.campaign_id;
  new.content_hash := encode(sha256(convert_to(jsonb_build_object(
    'platform', c.platform, 'currency', c.currency, 'plan', new.plan, 'daily', new.budget_daily_minor, 'total', new.budget_total_minor,
    'start', new.start_date, 'end', new.end_date)::text, 'UTF8')), 'hex');

  -- What does this version change about a campaign that is already running?
  select * into p from crm.ad_campaign_versions v where v.campaign_id = new.campaign_id and v.state in ('LIVE', 'PAUSED') order by v.version desc limit 1;
  v_new := crm._ad_monthly_estimate(new.budget_daily_minor, new.budget_total_minor);
  if p.id is null then
    new.change_kind := 'launch';
    new.change_amount_minor := v_new;
  else
    v_old := crm._ad_monthly_estimate(p.budget_daily_minor, p.budget_total_minor);
    if v_new > v_old then new.change_kind := 'budget_increase'; new.change_amount_minor := v_new - v_old;
    elsif crm._ad_targeting_signature(c.platform, new.plan) is distinct from crm._ad_targeting_signature(c.platform, p.plan) then new.change_kind := 'targeting_change'; new.change_amount_minor := 0;
    elsif crm._ad_creative_signature(c.platform, new.plan) is distinct from crm._ad_creative_signature(c.platform, p.plan) then new.change_kind := 'creative_change'; new.change_amount_minor := 0;
    elsif v_new < v_old then new.change_kind := 'budget_decrease'; new.change_amount_minor := 0;
    else new.change_kind := 'creative_change'; new.change_amount_minor := 0; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists ad_version_stamp on crm.ad_campaign_versions;
create trigger ad_version_stamp before insert on crm.ad_campaign_versions for each row execute function crm.ad_version_stamp();

create or replace function crm.ad_version_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'an ad version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.campaign_id, new.version, new.plan, new.budget_daily_minor, new.budget_total_minor, new.start_date, new.end_date,
      new.change_kind, new.change_amount_minor, new.content_hash, new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.campaign_id, old.version, old.plan, old.budget_daily_minor, old.budget_total_minor, old.start_date, old.end_date,
      old.change_kind, old.change_amount_minor, old.content_hash, old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a version plans is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.ad_write', true), '') <> '1' then
      raise exception 'a version''s state moves only through the ad doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'        and new.state in ('CHECKED', 'CHECK_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECK_FAILED' and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECKED'      and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW' and new.state in ('LAUNCHING', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'LAUNCHING'    and new.state in ('LIVE', 'ADMIN_REVIEW'))
      or (old.state = 'LIVE'         and new.state in ('PAUSED', 'ENDED', 'SUPERSEDED'))
      or (old.state = 'PAUSED'       and new.state in ('LIVE', 'ENDED', 'SUPERSEDED'))) then
      raise exception 'a % version cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists ad_version_guard on crm.ad_campaign_versions;
create trigger ad_version_guard before update or delete on crm.ad_campaign_versions for each row execute function crm.ad_version_guard();

create or replace function crm.ad_history_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'this record is history; add a new one instead' using errcode = '42501';
end;
$$;
drop trigger if exists ad_applications_immutable on crm.ad_applications;
create trigger ad_applications_immutable before update or delete on crm.ad_applications for each row execute function crm.ad_history_only();
drop trigger if exists ad_metrics_immutable on crm.ad_metrics;
create trigger ad_metrics_immutable before update or delete on crm.ad_metrics for each row execute function crm.ad_history_only();
drop trigger if exists ad_provider_statuses_immutable on crm.ad_provider_statuses;
create trigger ad_provider_statuses_immutable before update or delete on crm.ad_provider_statuses for each row execute function crm.ad_history_only();
drop trigger if exists campaign_health_records_immutable on crm.campaign_health_records;
create trigger campaign_health_records_immutable before update or delete on crm.campaign_health_records for each row execute function crm.ad_history_only();

create or replace function crm.ad_campaign_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a campaign is history' using errcode = '42501'; end if;
  if (new.organization_id, new.platform, new.name, new.created_at) is distinct from (old.organization_id, old.platform, old.name, old.created_at) then
    raise exception 'what a campaign is for is fixed; make a new campaign' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists ad_campaign_guard on crm.ad_campaigns;
create trigger ad_campaign_guard before update or delete on crm.ad_campaigns for each row execute function crm.ad_campaign_guard();

-- freeze + parent guards + RLS + privileges, per table
drop trigger if exists freeze_org_ad_campaigns on crm.ad_campaigns;
create trigger freeze_org_ad_campaigns before update of organization_id on crm.ad_campaigns for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_ad_campaigns_current on crm.ad_campaigns;
create trigger org_match_ad_campaigns_current before insert or update of current_version_id, organization_id on crm.ad_campaigns for each row execute function core.enforce_parent_org('current_version_id', 'crm.ad_campaign_versions');
drop trigger if exists org_match_ad_campaigns_live on crm.ad_campaigns;
create trigger org_match_ad_campaigns_live before insert or update of live_version_id, organization_id on crm.ad_campaigns for each row execute function core.enforce_parent_org('live_version_id', 'crm.ad_campaign_versions');
alter table crm.ad_campaigns enable row level security;
alter table crm.ad_campaigns force row level security;
drop policy if exists ad_campaigns_select on crm.ad_campaigns;
create policy ad_campaigns_select on crm.ad_campaigns for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.ad_campaigns from public, anon, authenticated;
grant select on crm.ad_campaigns to authenticated;
grant select, insert, update on crm.ad_campaigns to service_role;

drop trigger if exists freeze_org_ad_campaign_versions on crm.ad_campaign_versions;
create trigger freeze_org_ad_campaign_versions before update of organization_id on crm.ad_campaign_versions for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_ad_versions_campaign on crm.ad_campaign_versions;
create trigger org_match_ad_versions_campaign before insert or update of campaign_id, organization_id on crm.ad_campaign_versions for each row execute function core.enforce_parent_org('campaign_id', 'crm.ad_campaigns');
drop trigger if exists org_match_ad_versions_approval on crm.ad_campaign_versions;
create trigger org_match_ad_versions_approval before insert or update of approval_request_id, organization_id on crm.ad_campaign_versions for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');
drop trigger if exists org_match_ad_versions_supersedes on crm.ad_campaign_versions;
create trigger org_match_ad_versions_supersedes before insert or update of supersedes_version_id, organization_id on crm.ad_campaign_versions for each row execute function core.enforce_parent_org('supersedes_version_id', 'crm.ad_campaign_versions');
alter table crm.ad_campaign_versions enable row level security;
alter table crm.ad_campaign_versions force row level security;
drop policy if exists ad_campaign_versions_select on crm.ad_campaign_versions;
create policy ad_campaign_versions_select on crm.ad_campaign_versions for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.ad_campaign_versions from public, anon, authenticated;
grant select on crm.ad_campaign_versions to authenticated;
grant select, insert, update on crm.ad_campaign_versions to service_role;

drop trigger if exists freeze_org_ad_provider_objects on crm.ad_provider_objects;
create trigger freeze_org_ad_provider_objects before update of organization_id on crm.ad_provider_objects for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_ad_provider_objects_campaign on crm.ad_provider_objects;
create trigger org_match_ad_provider_objects_campaign before insert or update of campaign_id, organization_id on crm.ad_provider_objects for each row execute function core.enforce_parent_org('campaign_id', 'crm.ad_campaigns');
alter table crm.ad_provider_objects enable row level security;
alter table crm.ad_provider_objects force row level security;
drop policy if exists ad_provider_objects_select on crm.ad_provider_objects;
create policy ad_provider_objects_select on crm.ad_provider_objects for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.ad_provider_objects from public, anon, authenticated;
grant select on crm.ad_provider_objects to authenticated;
grant select, insert on crm.ad_provider_objects to service_role;

drop trigger if exists freeze_org_ad_applications on crm.ad_applications;
create trigger freeze_org_ad_applications before update of organization_id on crm.ad_applications for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_ad_applications_version on crm.ad_applications;
create trigger org_match_ad_applications_version before insert or update of version_id, organization_id on crm.ad_applications for each row execute function core.enforce_parent_org('version_id', 'crm.ad_campaign_versions');
drop trigger if exists org_match_ad_applications_execution on crm.ad_applications;
create trigger org_match_ad_applications_execution before insert or update of execution_id, organization_id on crm.ad_applications for each row execute function core.enforce_parent_org('execution_id', 'crm.governed_executions');
alter table crm.ad_applications enable row level security;
alter table crm.ad_applications force row level security;
drop policy if exists ad_applications_select on crm.ad_applications;
create policy ad_applications_select on crm.ad_applications for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.ad_applications from public, anon, authenticated;
grant select on crm.ad_applications to authenticated;
grant select, insert on crm.ad_applications to service_role;

drop trigger if exists freeze_org_ad_metrics on crm.ad_metrics;
create trigger freeze_org_ad_metrics before update of organization_id on crm.ad_metrics for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_ad_metrics_campaign on crm.ad_metrics;
create trigger org_match_ad_metrics_campaign before insert or update of campaign_id, organization_id on crm.ad_metrics for each row execute function core.enforce_parent_org('campaign_id', 'crm.ad_campaigns');
alter table crm.ad_metrics enable row level security;
alter table crm.ad_metrics force row level security;
drop policy if exists ad_metrics_select on crm.ad_metrics;
create policy ad_metrics_select on crm.ad_metrics for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.ad_metrics from public, anon, authenticated;
grant select on crm.ad_metrics to authenticated;
grant select, insert on crm.ad_metrics to service_role;

drop trigger if exists freeze_org_ad_provider_statuses on crm.ad_provider_statuses;
create trigger freeze_org_ad_provider_statuses before update of organization_id on crm.ad_provider_statuses for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_ad_provider_statuses_campaign on crm.ad_provider_statuses;
create trigger org_match_ad_provider_statuses_campaign before insert or update of campaign_id, organization_id on crm.ad_provider_statuses for each row execute function core.enforce_parent_org('campaign_id', 'crm.ad_campaigns');
alter table crm.ad_provider_statuses enable row level security;
alter table crm.ad_provider_statuses force row level security;
drop policy if exists ad_provider_statuses_select on crm.ad_provider_statuses;
create policy ad_provider_statuses_select on crm.ad_provider_statuses for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.ad_provider_statuses from public, anon, authenticated;
grant select on crm.ad_provider_statuses to authenticated;
grant select, insert on crm.ad_provider_statuses to service_role;

drop trigger if exists freeze_org_campaign_health_records on crm.campaign_health_records;
create trigger freeze_org_campaign_health_records before update of organization_id on crm.campaign_health_records for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_campaign_health_campaign on crm.campaign_health_records;
create trigger org_match_campaign_health_campaign before insert or update of campaign_id, organization_id on crm.campaign_health_records for each row execute function core.enforce_parent_org('campaign_id', 'crm.ad_campaigns');
alter table crm.campaign_health_records enable row level security;
alter table crm.campaign_health_records force row level security;
drop policy if exists campaign_health_records_select on crm.campaign_health_records;
create policy campaign_health_records_select on crm.campaign_health_records for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.campaign_health_records from public, anon, authenticated;
grant select on crm.campaign_health_records to authenticated;
grant select, insert on crm.campaign_health_records to service_role;

create unique index if not exists ad_versions_one_running_key on crm.ad_campaign_versions (campaign_id) where state in ('LIVE', 'PAUSED');
create unique index if not exists ad_versions_one_launching_key on crm.ad_campaign_versions (campaign_id) where state = 'LAUNCHING';

-- ── 2. doors ───────────────────────────────────────────────────────────────

create or replace function crm._ad_action(p_kind text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case p_kind when 'budget_increase' then 'ad_budget_increase' when 'targeting_change' then 'ad_targeting_change' else 'ad_launch' end;
$$;

create or replace function crm._ad_set_state(p_version uuid, p_state text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform set_config('crm.ad_write', '1', true);
  update crm.ad_campaign_versions set state = p_state where id = p_version;
  perform set_config('crm.ad_write', '', true);
end;
$$;
revoke all on function crm._ad_set_state(uuid, text) from public, anon, authenticated;

create or replace function crm.create_ad_campaign(p_organization_id uuid, p_platform text, p_name text, p_objective text default 'qualified_leads', p_target_service text default null, p_by_type text default 'human')
returns table (outcome text, campaign_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_platform not in ('meta_ads', 'google_ads') or p_by_type not in ('human', 'agent', 'rule') then return query select 'invalid'::text, null::uuid; return; end if;
  insert into crm.ad_campaigns (organization_id, platform, name, objective, target_service, created_by_type, created_by)
  values (p_organization_id, p_platform, btrim(p_name), coalesce(nullif(btrim(p_objective), ''), 'qualified_leads'), nullif(btrim(coalesce(p_target_service, '')), ''), p_by_type, (select auth.uid()))
  returning id into v_id;
  perform core.record_audit(p_organization_id, 'ads.campaign_created', 'ad_campaign', v_id, null, jsonb_build_object('platform', p_platform));
  return query select 'created'::text, v_id;
exception when check_violation then return query select 'invalid'::text, null::uuid;
end;
$$;
revoke all on function crm.create_ad_campaign(uuid, text, text, text, text, text) from public, anon;
grant execute on function crm.create_ad_campaign(uuid, text, text, text, text, text) to authenticated, service_role;

create or replace function crm.add_ad_version(p_organization_id uuid, p_campaign uuid, p_plan jsonb, p_daily_minor bigint, p_total_minor bigint default null,
                                              p_start date default null, p_end date default null, p_by_type text default 'human')
returns table (outcome text, version_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare c crm.ad_campaigns; v_n integer; v_id uuid; r record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  select * into c from crm.ad_campaigns x where x.id = p_campaign and x.organization_id = p_organization_id for update;
  if c.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if c.status = 'ended' then return query select 'campaign_ended'::text, null::uuid; return; end if;
  if exists (select 1 from crm.ad_campaign_versions v where v.campaign_id = c.id and v.state = 'LAUNCHING') then
    return query select 'apply_in_progress'::text, null::uuid; return;
  end if;
  -- One plan in flight per campaign: an unlaunched version is replaced, and its approval request with it.
  for r in select v.id, v.approval_request_id from crm.ad_campaign_versions v
            where v.campaign_id = c.id and v.state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW') loop
    if r.approval_request_id is not null then perform approvals.cancel_request(r.approval_request_id, 'a newer version of the campaign replaced it'); end if;
    perform crm._ad_set_state(r.id, 'SUPERSEDED');
  end loop;
  select coalesce(max(v.version), 0) + 1 into v_n from crm.ad_campaign_versions v where v.campaign_id = c.id;
  insert into crm.ad_campaign_versions (organization_id, campaign_id, version, plan, budget_daily_minor, budget_total_minor, start_date, end_date, supersedes_version_id, created_by_type, created_by)
  values (p_organization_id, c.id, v_n, p_plan, p_daily_minor, p_total_minor, p_start, p_end,
          (select v.id from crm.ad_campaign_versions v where v.campaign_id = c.id order by v.version desc limit 1), p_by_type, (select auth.uid()))
  returning id into v_id;
  update crm.ad_campaigns set current_version_id = v_id where id = c.id;
  perform core.record_audit(p_organization_id, 'ads.version_added', 'ad_campaign', c.id, null, jsonb_build_object('version', v_n));
  return query select 'added'::text, v_id;
exception when check_violation or not_null_violation or invalid_text_representation then return query select 'invalid'::text, null::uuid;
end;
$$;
revoke all on function crm.add_ad_version(uuid, uuid, jsonb, bigint, bigint, date, date, text) from public, anon;
grant execute on function crm.add_ad_version(uuid, uuid, jsonb, bigint, bigint, date, date, text) to authenticated, service_role;

create or replace function crm.check_ad_version(p_organization_id uuid, p_version uuid)
returns table (outcome text, problems jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.ad_campaign_versions; c crm.ad_campaigns; p jsonb;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::jsonb; return; end if;
  select * into v from crm.ad_campaign_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::jsonb; return; end if;
  if v.state not in ('DRAFT', 'CHECK_FAILED') then return query select 'wrong_state'::text, null::jsonb; return; end if;
  select * into c from crm.ad_campaigns x where x.id = v.campaign_id;
  p := crm.ad_plan_problems(c.platform, v.plan);
  -- A check can fail a plan; it never approves one. CHECKED only means "no machine-detectable problem" - a person still decides.
  perform set_config('crm.ad_write', '1', true);
  update crm.ad_campaign_versions set state = case when jsonb_array_length(p) = 0 then 'CHECKED' else 'CHECK_FAILED' end,
         review = jsonb_build_object('problems', p, 'checked_at', now()) where id = v.id;
  perform set_config('crm.ad_write', '', true);
  return query select case when jsonb_array_length(p) = 0 then 'checked' else 'check_failed' end::text, p;
end;
$$;
revoke all on function crm.check_ad_version(uuid, uuid) from public, anon;
grant execute on function crm.check_ad_version(uuid, uuid) to authenticated, service_role;

create or replace function crm.submit_ad_version(p_organization_id uuid, p_version uuid)
returns table (outcome text, approval_request_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.ad_campaign_versions; c crm.ad_campaigns; b record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  select * into v from crm.ad_campaign_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v.state <> 'CHECKED' then return query select 'not_checked'::text, null::uuid; return; end if;
  select * into c from crm.ad_campaigns x where x.id = v.campaign_id;
  select * into b from crm.bind_approval(p_organization_id, 'ad_campaign', v.id, v.version, v.content_hash,
    left(c.platform || ' · ' || c.name || ' · ' || v.change_kind || ' · daily ' || v.budget_daily_minor::text || ' ' || c.currency || ' (minor units)', 480),
    case when v.change_amount_minor > 0 then v.change_amount_minor end, 'system', null, 168);
  if b.outcome not in ('requested', 'already_pending') then return query select b.outcome::text, null::uuid; return; end if;
  perform set_config('crm.ad_write', '1', true);
  update crm.ad_campaign_versions set state = 'ADMIN_REVIEW', approval_request_id = b.request_id where id = v.id;
  perform set_config('crm.ad_write', '', true);
  perform core.record_audit(p_organization_id, 'ads.submitted_for_approval', 'ad_campaign', c.id, null,
    jsonb_build_object('version', v.version, 'kind', v.change_kind, 'approval_request_id', b.request_id, 'hash', v.content_hash));
  return query select 'submitted'::text, b.request_id;
end;
$$;
revoke all on function crm.submit_ad_version(uuid, uuid) from public, anon;
grant execute on function crm.submit_ad_version(uuid, uuid) to authenticated, service_role;

create or replace function crm.begin_ad_apply(p_organization_id uuid, p_version uuid, p_correlation_id uuid default null)
returns table (outcome text, reason text, execution_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.ad_campaign_versions; c crm.ad_campaigns; d record; g record;
begin
  select * into v from crm.ad_campaign_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text, null::uuid; return; end if;
  if v.state in ('LIVE', 'PAUSED') then return query select 'already_applied'::text, null::text, null::uuid; return; end if;
  if v.state not in ('ADMIN_REVIEW', 'LAUNCHING') then return query select 'not_approved_state'::text, v.state, null::uuid; return; end if;
  select * into c from crm.ad_campaigns x where x.id = v.campaign_id;

  -- The connector, the cap and the stops are asked NOW, with the money this change adds. Approval is satisfied by the exact-version check
  -- below; only BLOCK refuses here.
  select * into d from crm.acquisition_decide(p_organization_id, crm._ad_action(v.change_kind), c.platform, v.change_amount_minor, 1, p_correlation_id);
  if d.decision = 'BLOCK' then return query select 'blocked'::text, d.reason, null::uuid; return; end if;

  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'ad_campaign', v.id, v.content_hash,
                                                    crm._ad_action(v.change_kind), c.platform, p_correlation_id);
  if g.outcome = 'proceed' then
    if v.state = 'ADMIN_REVIEW' then perform crm._ad_set_state(v.id, 'LAUNCHING'); end if;
    return query select 'proceed'::text, g.reason, g.execution_id; return;
  end if;
  return query select g.outcome::text, g.reason, g.execution_id;
end;
$$;
revoke all on function crm.begin_ad_apply(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function crm.begin_ad_apply(uuid, uuid, uuid) to service_role;

create or replace function crm.record_ad_apply(p_organization_id uuid, p_version uuid, p_execution uuid, p_status text, p_provider_campaign_id text,
                                               p_objects jsonb default '[]', p_evidence jsonb default '{}')
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.ad_campaign_versions; c crm.ad_campaigns; f record; o jsonb; prev uuid;
begin
  if p_status not in ('executed', 'failed', 'unknown') then return query select 'invalid'::text; return; end if;
  select * into v from crm.ad_campaign_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state <> 'LAUNCHING' then return query select 'wrong_state'::text; return; end if;
  if p_status = 'executed' and coalesce(btrim(p_provider_campaign_id), '') = '' then return query select 'needs_reference'::text; return; end if;
  select * into c from crm.ad_campaigns x where x.id = v.campaign_id for update;

  select * into f from crm.finish_governed_execution(p_organization_id, p_execution, p_status, p_provider_campaign_id, p_evidence);
  if f.outcome <> 'recorded' then return query select f.outcome::text; return; end if;

  if p_status = 'executed' then
    for prev in select x.id from crm.ad_campaign_versions x where x.campaign_id = c.id and x.state in ('LIVE', 'PAUSED') and x.id <> v.id loop
      perform crm._ad_set_state(prev, 'SUPERSEDED');
    end loop;
    insert into crm.ad_applications (organization_id, version_id, execution_id, provider_campaign_id) values (p_organization_id, v.id, p_execution, btrim(p_provider_campaign_id));
    insert into crm.ad_provider_objects (organization_id, campaign_id, platform, object_type, provider_id)
    values (p_organization_id, c.id, c.platform, 'campaign', btrim(p_provider_campaign_id)) on conflict do nothing;
    for o in select e.value from jsonb_array_elements(case when jsonb_typeof(p_objects) = 'array' then p_objects else '[]'::jsonb end) e loop
      if o ->> 'object_type' in ('campaign', 'ad_set', 'ad_group', 'ad', 'keyword', 'creative') and length(coalesce(o ->> 'provider_id', '')) between 1 and 200 then
        insert into crm.ad_provider_objects (organization_id, campaign_id, platform, object_type, provider_id)
        values (p_organization_id, c.id, c.platform, o ->> 'object_type', o ->> 'provider_id') on conflict do nothing;
      end if;
    end loop;
    perform crm._ad_set_state(v.id, 'LIVE');
    update crm.ad_campaigns set status = 'live', live_version_id = v.id, provider_sync_pending = null where id = c.id;
    perform crm.record_acquisition_usage(p_organization_id, c.platform, 'action', 1, 'ad-apply:' || v.id::text);
  elsif p_status = 'failed' then
    perform crm._ad_set_state(v.id, 'ADMIN_REVIEW');
  end if;
  perform core.record_audit(p_organization_id, 'ads.apply_' || p_status, 'ad_campaign', c.id, null, jsonb_build_object('version', v.version, 'kind', v.change_kind, 'provider_ref', left(p_provider_campaign_id, 200)));
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm.record_ad_apply(uuid, uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function crm.record_ad_apply(uuid, uuid, uuid, text, text, jsonb, jsonb) to service_role;

-- Pausing and ending reduce risk, so they need no approval - but they are INTENTS until the platform confirms them.
create or replace function crm.request_ad_change(p_organization_id uuid, p_campaign uuid, p_action text, p_reason text)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare c crm.ad_campaigns; v_block text;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text; return; end if;
  if p_action not in ('pause', 'resume', 'end') or length(btrim(coalesce(p_reason, ''))) < 3 then return query select 'invalid'::text; return; end if;
  select * into c from crm.ad_campaigns x where x.id = p_campaign and x.organization_id = p_organization_id for update;
  if c.id is null then return query select 'not_found'::text; return; end if;
  if c.status = 'ended' or c.live_version_id is null then return query select 'not_running'::text; return; end if;
  if p_action = 'resume' then
    if c.status <> 'paused' then return query select 'not_paused'::text; return; end if;
    v_block := crm.acquisition_blocked(p_organization_id, c.platform);
    if v_block is not null then return query select 'blocked'::text; return; end if;
  elsif p_action = 'pause' and c.status <> 'live' then return query select 'not_live'::text; return; end if;
  update crm.ad_campaigns set provider_sync_pending = p_action where id = c.id;
  perform core.record_audit(p_organization_id, 'ads.' || p_action || '_requested', 'ad_campaign', c.id, null, jsonb_build_object('reason', left(p_reason, 300)));
  return query select 'requested'::text;
end;
$$;
revoke all on function crm.request_ad_change(uuid, uuid, text, text) from public, anon;
grant execute on function crm.request_ad_change(uuid, uuid, text, text) to authenticated, service_role;

-- The platform confirmed (or refused) the pending pause/resume/end.
create or replace function crm.confirm_ad_change(p_organization_id uuid, p_campaign uuid, p_confirmed boolean, p_detail text default null)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare c crm.ad_campaigns; p text;
begin
  select * into c from crm.ad_campaigns x where x.id = p_campaign and x.organization_id = p_organization_id for update;
  if c.id is null then return query select 'not_found'::text; return; end if;
  p := c.provider_sync_pending;
  if p is null then return query select 'nothing_pending'::text; return; end if;
  if p_confirmed then
    if p = 'pause' then perform crm._ad_set_state(c.live_version_id, 'PAUSED'); update crm.ad_campaigns set status = 'paused', provider_sync_pending = null where id = c.id;
    elsif p = 'resume' then perform crm._ad_set_state(c.live_version_id, 'LIVE'); update crm.ad_campaigns set status = 'live', provider_sync_pending = null where id = c.id;
    else
      perform crm._ad_set_state(c.live_version_id, 'ENDED'); update crm.ad_campaigns set status = 'ended', provider_sync_pending = null where id = c.id;
    end if;
    perform core.record_audit(p_organization_id, 'ads.' || p || '_confirmed', 'ad_campaign', c.id, null, '{}'::jsonb);
  else
    perform core.record_audit(p_organization_id, 'ads.' || p || '_not_confirmed', 'ad_campaign', c.id, null, jsonb_build_object('detail', left(p_detail, 300)));
  end if;
  return query select case when p_confirmed then 'confirmed' else 'left_pending' end::text;
end;
$$;
revoke all on function crm.confirm_ad_change(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function crm.confirm_ad_change(uuid, uuid, boolean, text) to service_role;

-- An emergency stop must reach the money: every live campaign on a stopped channel gets a pending pause the worker pushes.
create or replace function crm.enforce_ad_stops(p_limit integer default 100)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in select c.id, c.organization_id, c.platform from crm.ad_campaigns c
            where c.status = 'live' and c.provider_sync_pending is null and crm.acquisition_blocked(c.organization_id, c.platform) is not null
            order by c.created_at limit greatest(1, least(coalesce(p_limit, 100), 1000)) for update skip locked loop
    update crm.ad_campaigns set provider_sync_pending = 'pause' where id = r.id;
    perform core.record_audit(r.organization_id, 'ads.pause_requested', 'ad_campaign', r.id, null, jsonb_build_object('reason', 'a stop is active on the channel'));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function crm.enforce_ad_stops(integer) from public, anon, authenticated;
grant execute on function crm.enforce_ad_stops(integer) to service_role;

create or replace function crm.pending_ad_changes(p_limit integer default 50)
returns table (organization_id uuid, campaign_id uuid, platform text, action text)
language sql stable security definer set search_path = '' as $$
  select c.organization_id, c.id, c.platform, c.provider_sync_pending from crm.ad_campaigns c
   where c.provider_sync_pending is not null order by c.created_at limit greatest(1, least(coalesce(p_limit, 50), 500));
$$;
revoke all on function crm.pending_ad_changes(integer) from public, anon, authenticated;
grant execute on function crm.pending_ad_changes(integer) to service_role;

create or replace function crm.sync_ad_approvals(p_limit integer default 200)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in select v.id from crm.ad_campaign_versions v join approvals.approval_requests a on a.id = v.approval_request_id
            where v.state = 'ADMIN_REVIEW' and a.state in ('rejected', 'expired', 'cancelled', 'changes_requested')
            order by v.state_changed_at limit greatest(1, least(coalesce(p_limit, 200), 1000)) for update of v skip locked loop
    perform crm._ad_set_state(r.id, 'REJECTED');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function crm.sync_ad_approvals(integer) from public, anon, authenticated;
grant execute on function crm.sync_ad_approvals(integer) to service_role;

-- ── 3. money: what the platform says it spent, counted once ────────────────

create or replace function crm.record_ad_metrics(p_organization_id uuid, p_campaign uuid, p_date date, p_spend_minor bigint, p_impressions bigint, p_clicks bigint, p_platform_leads bigint)
returns table (outcome text, counted_minor bigint)
language plpgsql volatile security definer set search_path = '' as $$
declare c crm.ad_campaigns; v_prev bigint; v_delta bigint; r record;
begin
  select * into c from crm.ad_campaigns x where x.id = p_campaign and x.organization_id = p_organization_id for update;
  if c.id is null then return query select 'not_found'::text, 0::bigint; return; end if;
  if c.live_version_id is null then return query select 'never_launched'::text, 0::bigint; return; end if;
  select m.spend_minor into v_prev from crm.ad_metrics m where m.campaign_id = c.id and m.metric_date = p_date order by m.reported_at desc, m.id desc limit 1;
  insert into crm.ad_metrics (organization_id, campaign_id, metric_date, spend_minor, impressions, clicks, platform_leads)
  values (p_organization_id, c.id, p_date, p_spend_minor, coalesce(p_impressions, 0), coalesce(p_clicks, 0), coalesce(p_platform_leads, 0));
  -- Only the INCREASE is money newly spent. A restated lower figure never un-spends; the ledger is append-only and errs high.
  v_delta := greatest(p_spend_minor - coalesce(v_prev, 0), 0);
  if v_delta > 0 then
    select * into r from crm.record_acquisition_usage(p_organization_id, c.platform, 'spend_minor', v_delta, 'ad-spend:' || c.id::text || ':' || p_date::text || ':' || p_spend_minor::text);
  end if;
  return query select 'recorded'::text, v_delta;
exception when check_violation then return query select 'invalid'::text, 0::bigint;
end;
$$;
revoke all on function crm.record_ad_metrics(uuid, uuid, date, bigint, bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function crm.record_ad_metrics(uuid, uuid, date, bigint, bigint, bigint, bigint) to service_role;

create or replace function crm.record_ad_status(p_organization_id uuid, p_campaign uuid, p_status text, p_detail text default null)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not exists (select 1 from crm.ad_campaigns c where c.id = p_campaign and c.organization_id = p_organization_id) then return query select 'not_found'::text; return; end if;
  insert into crm.ad_provider_statuses (organization_id, campaign_id, status, detail) values (p_organization_id, p_campaign, p_status, left(p_detail, 500));
  return query select 'recorded'::text;
exception when check_violation then return query select 'invalid'::text;
end;
$$;
revoke all on function crm.record_ad_status(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function crm.record_ad_status(uuid, uuid, text, text) to service_role;

-- ── 4. results, read from the CRM ──────────────────────────────────────────
-- A lead belongs to a campaign when its FIRST touch was that platform and carried one of the campaign's own provider ids.

create or replace function crm.ad_outcomes(p_campaign uuid default null)
returns table (campaign_id uuid, platform text, name text, spend_minor bigint, impressions bigint, clicks bigint, platform_leads bigint,
               leads bigint, qualified bigint, meetings bigint, quotes bigint, won bigint, revenue_minor bigint,
               cost_per_lead_minor bigint, cost_per_qualified_minor bigint, cost_per_meeting_minor bigint, cost_per_won_minor bigint, insufficient_data boolean)
language sql stable security definer set search_path = '' as $$
  with caller as (
    select (select auth.uid()) as uid, (select core.current_organization_id()) as org
  ), camps as (
    select c.* from crm.ad_campaigns c, caller k
     where (p_campaign is null or c.id = p_campaign) and (k.uid is null or c.organization_id = k.org)
  ), spend as (
    select m.campaign_id,
           sum(m.spend_minor) as spend_minor, sum(m.impressions) as impressions, sum(m.clicks) as clicks, sum(m.platform_leads) as platform_leads
      from (select distinct on (x.campaign_id, x.metric_date) x.* from crm.ad_metrics x order by x.campaign_id, x.metric_date, x.reported_at desc, x.id desc) m
     group by m.campaign_id
  ), first_touch as (
    select distinct on (t.lead_id) t.lead_id, t.organization_id, t.channel, t.campaign, t.utm
      from crm.lead_touchpoints t order by t.lead_id, t.occurred_at, t.recorded_at, t.id
  ), attributed as (
    select distinct on (f.lead_id) f.lead_id, c.id as campaign_id
      from first_touch f
      join camps c on c.organization_id = f.organization_id and c.platform = f.channel
      join crm.ad_provider_objects o on o.campaign_id = c.id
       and o.provider_id in (f.campaign ->> 'ad_id', f.campaign ->> 'ad_set_id', f.campaign ->> 'campaign_id', f.utm ->> 'utm_campaign')
     order by f.lead_id, c.id
  ), per as (
    select a.campaign_id,
           count(*) as leads,
           count(*) filter (where l.qualified_at is not null) as qualified,
           count(*) filter (where exists (select 1 from crm.meetings m where m.lead_id = l.id and m.status = 'completed')) as meetings,
           count(*) filter (where exists (select 1 from sales.proposals p join sales.opportunities op on op.id = p.opportunity_id where op.lead_id = l.id and p.status in ('sent', 'accepted'))) as quotes,
           count(*) filter (where crm.lead_outcome(l.id) = 'WON') as won,
           coalesce(sum((select op.value_minor from sales.opportunities op where op.lead_id = l.id and op.stage = 'won' order by op.created_at desc limit 1)), 0)::bigint as revenue_minor
      from attributed a join crm.leads l on l.id = a.lead_id
     group by a.campaign_id
  )
  select c.id, c.platform, c.name, coalesce(s.spend_minor, 0)::bigint, coalesce(s.impressions, 0)::bigint, coalesce(s.clicks, 0)::bigint, coalesce(s.platform_leads, 0)::bigint,
         coalesce(p.leads, 0)::bigint, coalesce(p.qualified, 0)::bigint, coalesce(p.meetings, 0)::bigint, coalesce(p.quotes, 0)::bigint, coalesce(p.won, 0)::bigint, coalesce(p.revenue_minor, 0)::bigint,
         case when coalesce(p.leads, 0) > 0 then (coalesce(s.spend_minor, 0) / p.leads) end::bigint,
         case when coalesce(p.qualified, 0) > 0 then (coalesce(s.spend_minor, 0) / p.qualified) end::bigint,
         case when coalesce(p.meetings, 0) > 0 then (coalesce(s.spend_minor, 0) / p.meetings) end::bigint,
         case when coalesce(p.won, 0) > 0 then (coalesce(s.spend_minor, 0) / p.won) end::bigint,
         coalesce(p.leads, 0) < 10
    from camps c left join spend s on s.campaign_id = c.id left join per p on p.campaign_id = c.id
   order by c.created_at desc;
$$;
revoke all on function crm.ad_outcomes(uuid) from public, anon;
grant execute on function crm.ad_outcomes(uuid) to authenticated, service_role;

-- Advice, never action: what a person might look at, and the numbers it rests on. Thin data says so rather than guessing.
create or replace function crm.ad_recommendations()
returns table (campaign_id uuid, name text, recommendation text, basis jsonb)
language sql stable security definer set search_path = '' as $$
  select o.campaign_id, o.name,
         case
           when o.insufficient_data and o.spend_minor = 0 then 'no_spend_yet'
           when o.insufficient_data then 'not_enough_leads_to_judge'
           when o.qualified = 0 then 'review_for_pause_no_qualified_leads'
           when o.won > 0 then 'review_for_budget_increase_request'
           else 'keep_watching'
         end,
         jsonb_build_object('spend_minor', o.spend_minor, 'leads', o.leads, 'qualified', o.qualified, 'won', o.won, 'cost_per_qualified_minor', o.cost_per_qualified_minor)
    from crm.ad_outcomes(null) o
$$;
revoke all on function crm.ad_recommendations() from public, anon;
grant execute on function crm.ad_recommendations() to authenticated, service_role;

-- ── 5. is something wrong? (reading, never acting) ─────────────────────────

create or replace function crm.assess_campaign_health(p_organization_id uuid, p_campaign uuid)
returns table (outcome text, recorded integer)
language plpgsql volatile security definer set search_path = '' as $$
declare
  c crm.ad_campaigns; v crm.ad_campaign_versions;
  m record; v_avg numeric; v_n integer; n integer := 0; v_status text; o record; v_clicks bigint;
begin
  select * into c from crm.ad_campaigns x where x.id = p_campaign and x.organization_id = p_organization_id;
  if c.id is null then return query select 'not_found'::text, 0; return; end if;
  if c.status not in ('live', 'paused') then return query select 'not_running'::text, 0; return; end if;
  select * into v from crm.ad_campaign_versions x where x.id = c.live_version_id;
  select d.* into m from (select distinct on (x.metric_date) x.* from crm.ad_metrics x where x.campaign_id = c.id order by x.metric_date desc, x.reported_at desc, x.id desc) d order by d.metric_date desc limit 1;

  if m.id is not null and c.status = 'live' then
    if m.spend_minor = 0 or m.impressions = 0 then
      insert into crm.campaign_health_records (organization_id, campaign_id, kind, severity, detail, recommended_action)
      values (c.organization_id, c.id, 'zero_delivery', 'warning', jsonb_build_object('date', m.metric_date), 'Check the platform for a billing, policy or audience problem') on conflict do nothing;
      get diagnostics v_n = row_count; n := n + v_n;
    end if;
    if m.spend_minor > v.budget_daily_minor * 1.2 then
      insert into crm.campaign_health_records (organization_id, campaign_id, kind, severity, detail, recommended_action)
      values (c.organization_id, c.id, 'budget_overrun', 'critical', jsonb_build_object('date', m.metric_date, 'spend_minor', m.spend_minor, 'daily_budget_minor', v.budget_daily_minor), 'Pause the campaign and check the budget on the platform') on conflict do nothing;
      get diagnostics v_n = row_count; n := n + v_n;
    end if;
    select avg(d.spend_minor), count(*) into v_avg, v_n from (select distinct on (x.metric_date) x.* from crm.ad_metrics x where x.campaign_id = c.id and x.metric_date < m.metric_date and x.metric_date >= m.metric_date - 7 order by x.metric_date, x.reported_at desc, x.id desc) d;
    if v_n >= 3 and v_avg > 0 and m.spend_minor > v_avg * 2 then
      insert into crm.campaign_health_records (organization_id, campaign_id, kind, severity, detail, recommended_action)
      values (c.organization_id, c.id, 'spend_spike', 'warning', jsonb_build_object('date', m.metric_date, 'spend_minor', m.spend_minor, 'prior_average_minor', round(v_avg)), 'Compare with the platform and the plan before the next day''s spend') on conflict do nothing;
      get diagnostics v_n = row_count; n := n + v_n;
    end if;
  end if;

  select sum(x.clicks), sum(x.platform_leads) into v_clicks, v_n from (select distinct on (d.metric_date) d.* from crm.ad_metrics d where d.campaign_id = c.id and d.metric_date >= (now() at time zone 'utc')::date - 7 order by d.metric_date, d.reported_at desc, d.id desc) x;
  select * into o from crm.ad_outcomes(c.id);
  if o.campaign_id is not null and (coalesce(v_clicks, 0) >= 30 or coalesce(v_n, 0) >= 5) and o.leads = 0 then
    insert into crm.campaign_health_records (organization_id, campaign_id, kind, severity, detail, recommended_action)
    values (c.organization_id, c.id, 'possible_tracking_failure', 'critical', jsonb_build_object('clicks_7d', v_clicks, 'platform_leads_7d', v_n, 'crm_leads', o.leads), 'The platform reports traffic or leads that never reached the CRM: check the tracking reference and the WhatsApp handoff') on conflict do nothing;
    get diagnostics v_n = row_count; n := n + v_n;
  end if;
  if o.campaign_id is not null and o.leads >= 10 and o.qualified = 0 then
    insert into crm.campaign_health_records (organization_id, campaign_id, kind, severity, detail, recommended_action)
    values (c.organization_id, c.id, 'low_quality_leads', 'warning', jsonb_build_object('leads', o.leads, 'qualified', o.qualified), 'Review the audience and the creative: leads arrive but none qualify') on conflict do nothing;
    get diagnostics v_n = row_count; n := n + v_n;
  end if;

  select s.status into v_status from crm.ad_provider_statuses s where s.campaign_id = c.id order by s.reported_at desc, s.id desc limit 1;
  if v_status in ('rejected', 'disapproved') then
    insert into crm.campaign_health_records (organization_id, campaign_id, kind, severity, detail, recommended_action)
    values (c.organization_id, c.id, 'ads_rejected', 'critical', jsonb_build_object('status', v_status), 'Read the platform''s reason and make a corrected version') on conflict do nothing;
    get diagnostics v_n = row_count; n := n + v_n;
  elsif v_status in ('limited', 'suspended') then
    insert into crm.campaign_health_records (organization_id, campaign_id, kind, severity, detail, recommended_action)
    values (c.organization_id, c.id, 'platform_limited', 'critical', jsonb_build_object('status', v_status), 'Resolve the account or policy limit on the platform') on conflict do nothing;
    get diagnostics v_n = row_count; n := n + v_n;
  end if;
  return query select 'assessed'::text, n;
end;
$$;
revoke all on function crm.assess_campaign_health(uuid, uuid) from public, anon, authenticated;
grant execute on function crm.assess_campaign_health(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
