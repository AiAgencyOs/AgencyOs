-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 8 — An ad campaign launches as EXACTLY what was
-- approved, its money is counted once, and its results are read from the CRM.
-- Driven through the REAL approval engine and the governed execution door.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-ads.sql
-- Rolls back. Any failed check raises.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void
language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated',
      'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.sha(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
grant execute on function pg_temp.sha(text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b2'
\set OWNER '00000000-0000-4000-8000-00000000a001'
\set ADMIN '00000000-0000-4000-8000-00000000a002'
\set MEMBER '00000000-0000-4000-8000-00000000a003'
\set OTHER '00000000-0000-4000-8000-00000000a004'

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency', 'other-agency') on conflict do nothing;
insert into auth.users (id, email) values
  (:'OWNER', 'lg-owner@example.test'), (:'ADMIN', 'lg-admin@example.test'), (:'MEMBER', 'lg-member@example.test'), (:'OTHER', 'lg-other-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values
  (:'OWNER', 'lg-owner@example.test', 'LG Owner'), (:'ADMIN', 'lg-admin@example.test', 'LG Admin'),
  (:'MEMBER', 'lg-member@example.test', 'LG Member'), (:'OTHER', 'lg-other-owner@example.test', 'LG Other') on conflict do nothing;
create temp table fx (k text primary key, v uuid);
grant all on fx to public;

-- ── setup: policies, an ACTIVE Meta connection through the real registry doors ──
set local role authenticated;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.ensure_acquisition_defaults();
select crm.ensure_acquisition_approval_policies();
insert into fx select 'meta', integration_id from crm.register_integration('meta_ads', 'production', null, true);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select crm.store_connector_secret((select v from fx where k = 'meta'), 'access_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'meta', null);
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), true, 'act_1', '{"CREATE_CAMPAIGN":"AUTOMATED"}', null, null);
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_settings('meta_ads', true, 20, 5000000, 50);
select crm.set_channel_settings('google_ads', true, 20, 5000000, 50);
reset role;

\set META_PLAN '{"destination":{"type":"whatsapp"},"adsets":[{"name":"a1","audience":{"locations":["IN"],"age_min":25,"age_max":55},"placements":["feed"]}],"creatives":[{"headline":"Fast websites","primary_text":"We build fast, accessible websites for growing retailers. Message us to plan yours.","cta":"WHATSAPP_MESSAGE"}]}'
\set GOOGLE_PLAN '{"destination":{"type":"landing_page","landing_page_version_id":"00000000-0000-4000-8000-0000000000aa"},"ad_groups":[{"name":"g","keywords":[{"text":"web design agency","match":"phrase"},{"text":"website developer","match":"exact"},{"text":"ecommerce website","match":"phrase"}]}],"negative_keywords":["free","jobs"],"ads":[{"headlines":["Fast Websites","Built For Retail","Talk To Us"],"descriptions":["We design and build fast storefronts.","Message us on WhatsApp to plan a launch."]}]}'

-- ═══ A. the plan rules are pure and strict ═════════════════════════════════
select pg_temp.check(crm.ad_plan_problems('meta_ads', :'META_PLAN'::jsonb) = '[]'::jsonb, 'a sound Meta plan has no problems');
select pg_temp.check(crm.ad_plan_problems('google_ads', :'GOOGLE_PLAN'::jsonb) = '[]'::jsonb, 'a sound Google plan has no problems');
select pg_temp.check(crm.ad_plan_problems('meta_ads', replace(:'META_PLAN', 'Message us to plan yours.', 'Act now, limited time!')::jsonb)::text like '%manufactured_urgency%', 'manufactured urgency is a problem');
select pg_temp.check(crm.ad_plan_problems('meta_ads', replace(:'META_PLAN', 'fast, accessible', 'award-winning')::jsonb)::text like '%unsupported_claim%', 'an unsupported claim is a problem');
select pg_temp.check(crm.ad_plan_problems('meta_ads', replace(:'META_PLAN', 'fast, accessible', '300% faster')::jsonb)::text like '%unverified_statistic%', 'an unverified statistic is a problem');
select pg_temp.check(crm.ad_plan_problems('meta_ads', replace(:'META_PLAN', '"type":"whatsapp"', '"type":"website"')::jsonb)::text like '%meta_must_route_to_whatsapp%', 'a Meta ad must route to WhatsApp');
select pg_temp.check(crm.ad_plan_problems('meta_ads', replace(:'META_PLAN', '"age_min":25', '"age_min":16')::jsonb)::text like '%age_min_below_18%', 'targeting under 18 is a problem');
select pg_temp.check(crm.ad_plan_problems('meta_ads', replace(:'META_PLAN', 'WHATSAPP_MESSAGE', 'LEARN_MORE')::jsonb)::text like '%cta_must_open_whatsapp%', 'the call to action must open WhatsApp');
select pg_temp.check(crm.ad_plan_problems('google_ads', replace(:'GOOGLE_PLAN', '"type":"landing_page"', '"type":"website"')::jsonb)::text like '%google_needs_a_landing_page%', 'a Google ad needs a landing page');
select pg_temp.check(crm.ad_plan_problems('google_ads', replace(:'GOOGLE_PLAN', 'Fast Websites', 'A headline that is clearly longer than thirty characters')::jsonb)::text like '%headline_over_30_characters%', 'a Google headline over 30 characters is a problem');
select pg_temp.check(crm.ad_plan_problems('google_ads', replace(:'GOOGLE_PLAN', '"negative_keywords":["free","jobs"]', '"negative_keywords":[]')::jsonb)::text like '%needs_a_negative_keyword_strategy%', 'Google needs negative keywords');
select pg_temp.check(crm.ad_plan_problems('google_ads', replace(:'GOOGLE_PLAN', ',{"text":"ecommerce website","match":"phrase"}', '')::jsonb)::text like '%ad_group_needs_three_or_more_keywords%', 'an ad group needs three keywords');
select pg_temp.check(crm.ad_plan_problems('meta_ads', '[]'::jsonb)::text like '%plan_is_not_an_object%', 'a non-object plan is refused');

-- ═══ B. a campaign, a version, a derived hash ═════════════════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'c1', campaign_id from crm.create_ad_campaign(:'ORG', 'meta_ads', 'Website leads - Meta', 'qualified_leads', 'Website Development');
select pg_temp.check((select outcome from crm.create_ad_campaign(:'ORG', 'tiktok_ads', 'Nope campaign')) = 'invalid', 'an unknown platform is refused');
select pg_temp.check((select outcome from crm.create_ad_campaign(:'ORG', 'meta_ads', 'x')) = 'invalid', 'a name under 3 characters is refused');
insert into fx select 'v1', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 100000, null, null, null);
select pg_temp.check((select (state, version, change_kind, change_amount_minor) = ('DRAFT', 1, 'launch', 3000000) from crm.ad_campaign_versions where id = (select v from fx where k = 'v1')), 'version 1 is a DRAFT launch, estimated at 30 days of budget');
select pg_temp.check((select content_hash = pg_temp.sha(jsonb_build_object('platform', 'meta_ads', 'currency', 'INR', 'plan', :'META_PLAN'::jsonb, 'daily', 100000, 'total', null::bigint, 'start', null::date, 'end', null::date)::text) from crm.ad_campaign_versions where id = (select v from fx where k = 'v1')), 'the hash is derived from the plan, the budget and the dates');
select pg_temp.check((select outcome from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 0, null, null, null)) = 'invalid', 'a zero budget is refused');
select pg_temp.check((select outcome from crm.add_ad_version(:'ORG', gen_random_uuid(), :'META_PLAN'::jsonb, 100, null, null, null)) = 'not_found', 'a version of an unknown campaign is refused');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.create_ad_campaign(:'ORG', 'meta_ads', 'Member campaign')) = 'forbidden', 'a member cannot create a campaign');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select outcome from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 100, null, null, null)) = 'forbidden', 'another organisation cannot add a version');
select pg_temp.check((select count(*) from crm.ad_campaigns) = 0, 'another organisation sees none of the campaigns');
reset role;
do $$
declare v uuid; c uuid; h text;
begin
  select id into v from crm.ad_campaign_versions limit 1;
  begin update crm.ad_campaign_versions set plan = '{"x":1}' where id = v; raise exception 'FAILED: a plan was edited';
  exception when insufficient_privilege then raise notice 'ok  what a version plans is frozen'; end;
  begin update crm.ad_campaign_versions set budget_daily_minor = 1 where id = v; raise exception 'FAILED: a budget was edited';
  exception when insufficient_privilege then raise notice 'ok  a version''s budget is frozen'; end;
  begin update crm.ad_campaign_versions set state = 'LIVE' where id = v; raise exception 'FAILED: a state moved outside the doors';
  exception when insufficient_privilege then raise notice 'ok  a state moves only through the doors'; end;
  begin delete from crm.ad_campaign_versions where id = v; raise exception 'FAILED: a version was deleted';
  exception when insufficient_privilege then raise notice 'ok  a version is never deleted'; end;
  begin update crm.ad_campaigns set name = 'renamed' where id = (select campaign_id from crm.ad_campaign_versions where id = v); raise exception 'FAILED: a campaign was renamed';
  exception when insufficient_privilege then raise notice 'ok  what a campaign is for is fixed'; end;
  -- a forged hash on insert is overwritten by the trigger
  insert into crm.ad_campaigns (organization_id, platform, name, created_by_type) values ('00000000-0000-4000-8000-000000000001', 'meta_ads', 'Forgery test', 'human') returning id into c;
  insert into crm.ad_campaign_versions (organization_id, campaign_id, version, plan, budget_daily_minor, content_hash, created_by_type)
    values ('00000000-0000-4000-8000-000000000001', c, 1, '{"a":1}', 5000, repeat('f', 64), 'human') returning content_hash into h;
  if h = repeat('f', 64) then raise exception 'FAILED: a forged hash was kept'; end if;
  raise notice 'ok  a hash supplied by the caller is replaced by the derived one';
  begin update crm.ad_campaign_versions set state = 'LIVE' where campaign_id = c; raise exception 'FAILED';
  exception when insufficient_privilege then null; end;
end $$;

-- ═══ C. a check can fail a plan; it never approves one ═════════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.submit_ad_version(:'ORG', (select v from fx where k = 'v1'))) = 'not_checked', 'an unchecked version cannot be submitted');
insert into fx select 'bad', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), replace(:'META_PLAN', 'Message us to plan yours.', 'Act now, limited time!')::jsonb, 100000, null, null, null);
select pg_temp.check((select outcome from crm.check_ad_version(:'ORG', (select v from fx where k = 'bad'))) = 'check_failed', 'a plan with manufactured urgency fails its check');
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v1')) = 'SUPERSEDED', 'a newer draft SUPERSEDES the older unlaunched one');
select pg_temp.check((select outcome from crm.submit_ad_version(:'ORG', (select v from fx where k = 'bad'))) = 'not_checked', 'a failed plan cannot be submitted');
insert into fx select 'v1b', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 100000, null, null, null);
select pg_temp.check((select outcome from crm.check_ad_version(:'ORG', (select v from fx where k = 'v1b'))) = 'checked', 'the corrected plan passes its check');
select pg_temp.check((select current_version_id = (select v from fx where k = 'v1b') from crm.ad_campaigns where id = (select v from fx where k = 'c1')), 'the campaign points at its newest version');

-- ═══ D. not launchable until the EXACT version is approved ═════════════════
insert into fx select 'req1', approval_request_id from crm.submit_ad_version(:'ORG', (select v from fx where k = 'v1b'));
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v1b')) = 'ADMIN_REVIEW', 'a submitted version waits in ADMIN_REVIEW');
select pg_temp.check((select summary from approvals.approval_requests where id = (select v from fx where k = 'req1')) like '%meta_ads%Website leads - Meta%launch%', 'the approval card names the platform, the campaign and the kind of change');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome || ':' || reason from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v1b'))) = 'not_covered:state_pending', 'before approval the launch door refuses (the approval is pending)');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from approvals.decide_approval((select v from fx where k = 'req1'), 'approved', 'looks right')) = 'decided', 'an admin approves version 1');
reset role;
set local role service_role;
select pg_temp.as_service();

-- ═══ E. the governed launch: once, as approved ═════════════════════════════
select pg_temp.check((select outcome from crm.begin_ad_apply(:'ORG', gen_random_uuid())) = 'not_found', 'an unknown version is refused');
insert into fx select 'x1', execution_id from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v1b'));
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v1b')) = 'LAUNCHING', 'the approved version is LAUNCHING');
select pg_temp.check((select outcome from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v1b'))) = 'in_progress', 'a second worker finds the launch in progress (no double launch)');
select pg_temp.check((select outcome from crm.record_ad_apply(:'ORG', (select v from fx where k = 'v1b'), (select v from fx where k = 'x1'), 'executed', null)) = 'needs_reference', 'a launch without the provider''s campaign id is not recorded as done');
select pg_temp.check((select outcome from crm.record_ad_apply(:'ORG', (select v from fx where k = 'v1b'), (select v from fx where k = 'x1'), 'executed', 'meta-camp-1',
   '[{"object_type":"ad_set","provider_id":"ADSET-1"},{"object_type":"ad","provider_id":"AD-1"},{"object_type":"bogus","provider_id":"zzz"}]')) = 'recorded', 'the launch is recorded with the provider ids');
select pg_temp.check((select (state) = 'LIVE' from crm.ad_campaign_versions where id = (select v from fx where k = 'v1b')), 'the version is LIVE');
select pg_temp.check((select (status, live_version_id) = ('live', (select v from fx where k = 'v1b')) from crm.ad_campaigns where id = (select v from fx where k = 'c1')), 'the campaign is live on that version');
select pg_temp.check((select count(*) from crm.ad_provider_objects where campaign_id = (select v from fx where k = 'c1')) = 3, 'the campaign, ad set and ad ids are kept (the invalid object type is not)');
select pg_temp.check((select outcome from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v1b'))) = 'already_applied', 'a live version is never applied again');
select pg_temp.check((select count(*) from crm.ad_applications where version_id = (select v from fx where k = 'v1b')) = 1, 'one application record per version');
select pg_temp.check((select count(*) from crm.acquisition_usage where channel = 'meta_ads' and ref = 'ad-apply:' || (select v from fx where k = 'v1b')::text) = 1, 'the launch is one counted action');
reset role;
do $$
begin
  begin update crm.ad_applications set provider_campaign_id = 'x'; raise exception 'FAILED: an application was edited';
  exception when insufficient_privilege then raise notice 'ok  an application record is history'; end;
  begin delete from crm.ad_applications; raise exception 'FAILED: an application was deleted';
  exception when insufficient_privilege then raise notice 'ok  an application record is never deleted'; end;
end $$;

-- ═══ F. a change to a LIVE campaign is its own approval ═══════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'v2', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 150000, null, null, null);
select pg_temp.check((select (change_kind, change_amount_minor) = ('budget_increase', 1500000) from crm.ad_campaign_versions where id = (select v from fx where k = 'v2')), 'a higher budget is a BUDGET INCREASE worth the extra 30 days of spend');
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v1b')) = 'LIVE', 'adding a draft does not touch the live version');
select crm.check_ad_version(:'ORG', (select v from fx where k = 'v2'));
insert into fx select 'req2', approval_request_id from crm.submit_ad_version(:'ORG', (select v from fx where k = 'v2'));
select pg_temp.check((select (select hash from (select content_hash as hash from crm.ad_campaign_versions where id = (select v from fx where k = 'v2')) s) <> (select content_hash from crm.ad_campaign_versions where id = (select v from fx where k = 'v1b'))), 'the new version has its own hash');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v2'))) = 'not_covered', 'version 1''s approval does not cover version 2');
reset role;
-- the approval engine's own binding check: version 1's request cannot be spent on version 2
select pg_temp.check((select covered from crm.approval_check((select v from fx where k = 'req1'), 'ad_campaign', (select v from fx where k = 'v2'), (select content_hash from crm.ad_campaign_versions where id = (select v from fx where k = 'v2')))) = false, 'an approval for one version covers no other (artifact mismatch)');
-- a rejected version cannot launch and is swept to REJECTED
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select v from fx where k = 'req2'), 'rejected', 'budget too high');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v2'))) = 'not_covered', 'a rejected version cannot launch');
select pg_temp.check(crm.sync_ad_approvals() >= 1, 'the sweep moves a rejected version to REJECTED');
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v2')) = 'REJECTED', '…and it is REJECTED');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
-- targeting change, creative change and decrease are classified
insert into fx select 'v3', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), replace(:'META_PLAN', '"age_min":25', '"age_min":30')::jsonb, 100000, null, null, null);
select pg_temp.check((select (change_kind, change_amount_minor) = ('targeting_change', 0) from crm.ad_campaign_versions where id = (select v from fx where k = 'v3')), 'different targeting is a TARGETING CHANGE');
insert into fx select 'v4', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), replace(:'META_PLAN', 'Fast websites', 'Websites that sell')::jsonb, 100000, null, null, null);
select pg_temp.check((select change_kind from crm.ad_campaign_versions where id = (select v from fx where k = 'v4')) = 'creative_change', 'different creative is a CREATIVE CHANGE');
insert into fx select 'v5', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 50000, null, null, null);
select pg_temp.check((select (change_kind, change_amount_minor) = ('budget_decrease', 0) from crm.ad_campaign_versions where id = (select v from fx where k = 'v5')), 'a lower budget is a BUDGET DECREASE');
select pg_temp.check((select count(*) from crm.ad_campaign_versions where campaign_id = (select v from fx where k = 'c1') and state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW')) = 1, 'only the newest unlaunched version is in flight');
-- an approved budget increase launches, supersedes the old live version
insert into fx select 'v6', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 150000, null, null, null);
select crm.check_ad_version(:'ORG', (select v from fx where k = 'v6'));
insert into fx select 'req6', approval_request_id from crm.submit_ad_version(:'ORG', (select v from fx where k = 'v6'));
select approvals.decide_approval((select v from fx where k = 'req6'), 'approved', 'agreed the increase');

-- ═══ G. the Admin's cap is a cap: approval cannot lift it ═════════════════
select crm.set_channel_settings('meta_ads', true, 20, 1000000, 50);
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome || ':' || reason from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v6'))) = 'blocked:monthly_budget_exceeded', 'an approved budget increase is still refused above the monthly cap');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_settings('meta_ads', true, 20, 9000000, 50);
select crm.set_channel_pause('meta_ads', true, 'verifier stop');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome || ':' || reason from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v6'))) = 'blocked:channel_paused', 'a paused channel refuses the approved change');
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v6')) = 'ADMIN_REVIEW', '…and the version stays approved-and-waiting');
-- the stop reaches the money: a live campaign on a stopped channel gets a pending pause
select pg_temp.check(crm.enforce_ad_stops() >= 1, 'an emergency stop requests a pause on live campaigns');
select pg_temp.check((select provider_sync_pending = 'pause' and status = 'live' from crm.ad_campaigns where id = (select v from fx where k = 'c1')), 'the pause is PENDING - the campaign is not claimed paused until the platform confirms');
select pg_temp.check((select count(*) from crm.pending_ad_changes() where campaign_id = (select v from fx where k = 'c1')) = 1, 'the worker can list what to push');
select pg_temp.check(crm.enforce_ad_stops() = 0, 'the stop is not requested twice');
select pg_temp.check((select outcome from crm.confirm_ad_change(:'ORG', (select v from fx where k = 'c1'), false, 'platform timeout')) = 'left_pending', 'an unconfirmed pause stays pending');
select pg_temp.check((select outcome from crm.confirm_ad_change(:'ORG', (select v from fx where k = 'c1'), true)) = 'confirmed', 'a confirmed pause is recorded');
select pg_temp.check((select (status) = 'paused' from crm.ad_campaigns where id = (select v from fx where k = 'c1')) and (select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v1b')) = 'PAUSED', 'the campaign and its live version are PAUSED');
select pg_temp.check((select outcome from crm.confirm_ad_change(:'ORG', (select v from fx where k = 'c1'), true)) = 'nothing_pending', '…once');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.request_ad_change(:'ORG', (select v from fx where k = 'c1'), 'resume', 'back to work')) = 'blocked', 'resuming under a stop is refused');
select crm.set_channel_pause('meta_ads', false, null);
select pg_temp.check((select outcome from crm.request_ad_change(:'ORG', (select v from fx where k = 'c1'), 'resume', 'a')) = 'invalid', 'a pause or resume needs a reason');
select pg_temp.check((select outcome from crm.request_ad_change(:'ORG', (select v from fx where k = 'c1'), 'resume', 'stop lifted')) = 'requested', 'resuming after the stop is requested');
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.confirm_ad_change(:'ORG', (select v from fx where k = 'c1'), true);
select pg_temp.check((select status from crm.ad_campaigns where id = (select v from fx where k = 'c1')) = 'live', 'a confirmed resume is live again');
-- a person's own pause is also only an intent until the platform confirms it
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.request_ad_change(:'ORG', (select v from fx where k = 'c1'), 'pause', 'client asked us to hold')) = 'requested', 'a person can ask for a pause (no approval needed to reduce risk)');
select pg_temp.check((select status = 'live' and provider_sync_pending = 'pause' from crm.ad_campaigns where id = (select v from fx where k = 'c1')), '…and until the platform confirms, the campaign is still shown LIVE with a pending pause');
select pg_temp.check((select outcome from crm.request_ad_change(:'ORG', (select v from fx where k = 'c1'), 'end', 'nope')) = 'requested', 'a pending pause can be overtaken by an end request');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.request_ad_change(:'ORG', (select v from fx where k = 'c1'), 'pause', 'member tries')) = 'forbidden', 'a member cannot pause a campaign');
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.confirm_ad_change(:'ORG', (select v from fx where k = 'c1'), false, 'cancelled by the verifier');
update crm.ad_campaigns set provider_sync_pending = null where id = (select v from fx where k = 'c1');

-- now the increase can go ahead
insert into fx select 'x6', execution_id from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v6'));
select pg_temp.check((select outcome from crm.record_ad_apply(:'ORG', (select v from fx where k = 'v6'), (select v from fx where k = 'x6'), 'executed', 'meta-camp-1', '[]')) = 'recorded', 'the approved increase is applied');
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v1b')) = 'SUPERSEDED', 'the previous live version is SUPERSEDED');
select pg_temp.check((select live_version_id from crm.ad_campaigns where id = (select v from fx where k = 'c1')) = (select v from fx where k = 'v6'), 'the campaign now runs version 6');
select pg_temp.check((select count(*) from crm.ad_campaign_versions where campaign_id = (select v from fx where k = 'c1') and state in ('LIVE', 'PAUSED')) = 1, 'exactly one version is running');

-- a failure is retried, an unknown outcome is never re-run
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'v7', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), replace(:'META_PLAN', 'Fast websites', 'Sites that convert')::jsonb, 150000, null, null, null);
select crm.check_ad_version(:'ORG', (select v from fx where k = 'v7'));
insert into fx select 'req7', approval_request_id from crm.submit_ad_version(:'ORG', (select v from fx where k = 'v7'));
select approvals.decide_approval((select v from fx where k = 'req7'), 'approved', 'new creative ok');
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'x7', execution_id from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v7'));
select pg_temp.check((select outcome from crm.record_ad_apply(:'ORG', (select v from fx where k = 'v7'), (select v from fx where k = 'x7'), 'failed', null)) = 'recorded', 'a failed apply is recorded');
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v7')) = 'ADMIN_REVIEW', '…and the version goes back to waiting (the live one keeps running)');
select pg_temp.check((select outcome || ':' || reason from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v7'))) = 'proceed:retry_after_failure', 'a retry is allowed after a failure');
select pg_temp.check((select outcome from crm.record_ad_apply(:'ORG', (select v from fx where k = 'v7'), (select v from fx where k = 'x7'), 'unknown', null)) = 'recorded', 'an apply with an unknown outcome is recorded as unknown');
select pg_temp.check((select outcome from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v7'))) = 'needs_reconciliation', 'an unknown outcome is reconciled, never re-run');
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'v7')) = 'LAUNCHING', '…and the version stays LAUNCHING');
select pg_temp.check((select outcome from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 150000, null, null, null)) = 'apply_in_progress', 'no new version while an apply is unreconciled');

-- ═══ H. money: the platform's figures, counted once ═══════════════════════
select pg_temp.check((select outcome from crm.record_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date - 1, 5000, 4000, 80, 6)) = 'recorded', 'a day''s figures are recorded');
select pg_temp.check((select counted_minor from crm.record_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date - 1, 5000, 4000, 80, 6)) = 0, 'the same report again adds no spend');
select pg_temp.check((select counted_minor from crm.record_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date - 1, 7000, 4500, 90, 7)) = 2000, 'a higher restated figure adds only the difference');
select pg_temp.check((select counted_minor from crm.record_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date - 1, 6000, 4500, 90, 7)) = 0, 'a lower restated figure never un-spends');
select pg_temp.check((select sum(amount) from crm.acquisition_usage where channel = 'meta_ads' and metric = 'spend_minor') = 7000, 'the spend ledger holds the highest the platform reported (7,000), counted once');
select pg_temp.check((select outcome from crm.record_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date, -1, 0, 0, 0)) = 'invalid', 'a negative spend is refused');
insert into fx select 'c2', campaign_id from crm.create_ad_campaign(:'ORG', 'meta_ads', 'Never launched');
select pg_temp.check((select outcome from crm.record_ad_metrics(:'ORG', (select v from fx where k = 'c2'), current_date, 100, 1, 1, 0)) = 'never_launched', 'spend cannot be recorded against a campaign that never launched');

-- ═══ I. results come from the CRM, by FIRST touch ═════════════════════════
insert into fx select 'ct1', contact_id from crm.resolve_identity(:'ORG', '{"name":"Ad Lead One","email":"ad1@adco.example"}', 'whatsapp');
insert into fx select 'ct2', contact_id from crm.resolve_identity(:'ORG', '{"name":"Ad Lead Two","email":"ad2@adco.example"}', 'whatsapp');
insert into fx select 'ct3', contact_id from crm.resolve_identity(:'ORG', '{"name":"Ad Lead Three","email":"ad3@adco.example"}', 'whatsapp');
insert into fx select 'ct4', contact_id from crm.resolve_identity(:'ORG', '{"name":"Ad Lead Four","email":"ad4@adco.example"}', 'whatsapp');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status, qualified_at) values
  ('00000000-0000-4000-8000-0000000000e1', :'ORG', (select v from fx where k = 'ct1'), 'Ad lead one', 'whatsapp', 'wa:ad1', 'qualified', now());
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status, qualified_at, converted_at) values
  ('00000000-0000-4000-8000-0000000000e2', :'ORG', (select v from fx where k = 'ct2'), 'Ad lead two', 'whatsapp', 'wa:ad2', 'converted', now(), now());
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000e3', :'ORG', (select v from fx where k = 'ct3'), 'Email first lead', 'whatsapp', 'wa:ad3', 'new');
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000e4', :'ORG', (select v from fx where k = 'ct4'), 'Foreign ad lead', 'whatsapp', 'wa:ad4', 'new');
-- The WON gate and hand-off are not what is measured here (their own verifiers own them): the fixture steps around them, inside this rolled-back transaction.
alter table sales.opportunities disable trigger opportunities_won_gate;
alter table sales.opportunities disable trigger opportunities_won_handoff;
insert into sales.opportunities (organization_id, lead_id, name, stage, closed_at, value_minor) values
  (:'ORG', '00000000-0000-4000-8000-0000000000e2', 'Won via ad', 'won', now(), 5000000);
alter table sales.opportunities enable trigger opportunities_won_gate;
alter table sales.opportunities enable trigger opportunities_won_handoff;
set local role service_role;
select pg_temp.as_service();
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000e1', 'meta_ads', 'facebook', 'ad_click', '{"ad_id":"AD-1"}', '{}', 'ad:e1', now() - interval '3 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000e2', 'meta_ads', 'facebook', 'ad_click', '{"ad_id":"AD-1"}', '{}', 'ad:e2', now() - interval '3 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000e3', 'email', null, 'outreach_sent', '{}', '{}', 'em:e3', now() - interval '5 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000e3', 'meta_ads', 'facebook', 'ad_click', '{"ad_id":"AD-1"}', '{}', 'ad:e3', now() - interval '3 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000e4', 'meta_ads', 'facebook', 'ad_click', '{"ad_id":"SOMEONE-ELSES-AD"}', '{}', 'ad:e4', now() - interval '3 days');
select pg_temp.check((select (leads, qualified, won, revenue_minor) = (2, 2, 1, 5000000) from crm.ad_outcomes((select v from fx where k = 'c1'))), 'two leads, two qualified, one won, and the won revenue are read from the CRM');
select pg_temp.check((select leads = 2 from crm.ad_outcomes((select v from fx where k = 'c1'))), 'a lead whose FIRST touch was email is not credited to the ad, and a foreign ad id is not ours');
select pg_temp.check((select (spend_minor, cost_per_lead_minor, cost_per_qualified_minor, cost_per_won_minor) = (6000, 3000, 3000, 6000) from crm.ad_outcomes((select v from fx where k = 'c1'))), 'cost per lead, per qualified lead and per win are derived from spend and the CRM');
select pg_temp.check((select insufficient_data from crm.ad_outcomes((select v from fx where k = 'c1'))), 'two leads is NOT enough data to judge, and the result says so');
select pg_temp.check((select (cost_per_meeting_minor is null) and (cost_per_won_minor is not null) from crm.ad_outcomes((select v from fx where k = 'c1'))), 'a cost with nothing to divide by is null, never a guess');
select pg_temp.check((select recommendation from crm.ad_recommendations() where campaign_id = (select v from fx where k = 'c1')) = 'not_enough_leads_to_judge', 'with thin data the recommendation is to wait, not to act');
reset role;
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from crm.ad_outcomes(null)) = 0, 'another organisation reads no outcomes');
select pg_temp.check((select count(*) from crm.ad_outcomes((select v from fx where k = 'c1'))) = 0, '…even when it names our campaign');
reset role;

-- ═══ J. health: reading, never acting ═════════════════════════════════════
set local role service_role;
select pg_temp.as_service();
select crm.record_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date, 0, 0, 0, 0);
select pg_temp.check((select recorded from crm.assess_campaign_health(:'ORG', (select v from fx where k = 'c1'))) >= 1, 'a live campaign delivering nothing is flagged');
select pg_temp.check(exists (select 1 from crm.campaign_health_records where campaign_id = (select v from fx where k = 'c1') and kind = 'zero_delivery'), '…as zero delivery');
select pg_temp.check((select recorded from crm.assess_campaign_health(:'ORG', (select v from fx where k = 'c1'))) = 0, 'assessing twice the same day records nothing new');
select pg_temp.check((select status from crm.ad_campaigns where id = (select v from fx where k = 'c1')) = 'live', 'a health finding does not change the campaign');
select crm.record_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date, 400000, 90000, 900, 3);
select crm.assess_campaign_health(:'ORG', (select v from fx where k = 'c1'));
select pg_temp.check(exists (select 1 from crm.campaign_health_records where campaign_id = (select v from fx where k = 'c1') and kind = 'budget_overrun' and severity = 'critical'), 'spend far above the daily budget is a critical overrun');
select pg_temp.check((select outcome from crm.record_ad_status(:'ORG', (select v from fx where k = 'c1'), 'disapproved', 'policy')) = 'recorded', 'a platform disapproval is recorded');
select crm.assess_campaign_health(:'ORG', (select v from fx where k = 'c1'));
select pg_temp.check(exists (select 1 from crm.campaign_health_records where campaign_id = (select v from fx where k = 'c1') and kind = 'ads_rejected'), 'a disapproved campaign is flagged');
select pg_temp.check((select outcome from crm.record_ad_status(:'ORG', (select v from fx where k = 'c1'), 'confused', null)) = 'invalid', 'an unknown platform status is refused');
reset role;
do $$
begin
  begin update crm.campaign_health_records set severity = 'info'; raise exception 'FAILED: a finding was edited';
  exception when insufficient_privilege then raise notice 'ok  health findings are history'; end;
  begin delete from crm.ad_provider_statuses; raise exception 'FAILED: a status was deleted';
  exception when insufficient_privilege then raise notice 'ok  provider statuses are history'; end;
  begin update crm.ad_metrics set spend_minor = 0; raise exception 'FAILED: a metric was edited';
  exception when insufficient_privilege then raise notice 'ok  metrics are history'; end;
end $$;

-- ═══ K. governance: ad changes can never be automatic; every table is tenant-bound ═══
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from crm.set_acquisition_policy('ad_budget_increase', 'auto', null, null)) = 'never_auto', 'a budget increase can never be set to auto');
select pg_temp.check((select outcome from crm.set_acquisition_policy('ad_targeting_change', 'auto', null, null)) = 'never_auto', '…nor a targeting change');
select pg_temp.check((select outcome from crm.set_acquisition_policy('ad_launch', 'auto', null, null)) = 'never_auto', '…nor a launch (unchanged)');
reset role;
do $$
begin
  begin insert into crm.acquisition_policies (organization_id, action_type, mode) values ('00000000-0000-4000-8000-000000000001', 'ad_targeting_change', 'auto') on conflict (organization_id, action_type) do update set mode = 'auto';
        raise exception 'FAILED: the database accepted an automatic targeting change';
  exception when check_violation then raise notice 'ok  the database itself refuses an automatic targeting change'; end;
  begin insert into crm.acquisition_policies (organization_id, action_type, mode) values ('00000000-0000-4000-8000-000000000001', 'ad_budget_increase', 'auto') on conflict (organization_id, action_type) do update set mode = 'auto';
        raise exception 'FAILED: the database accepted an automatic budget increase';
  exception when check_violation then raise notice 'ok  the database itself refuses an automatic budget increase'; end;
end $$;
do $$
declare t text; n integer;
begin
  foreach t in array array['ad_campaigns', 'ad_campaign_versions', 'ad_provider_objects', 'ad_applications', 'ad_metrics', 'ad_provider_statuses', 'campaign_health_records'] loop
    select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'crm' and c.relname = t and c.relrowsecurity and c.relforcerowsecurity;
    if n <> 1 then raise exception 'FAILED: % is not under forced RLS', t; end if;
    if has_table_privilege('anon', 'crm.' || t, 'select') or has_table_privilege('authenticated', 'crm.' || t, 'insert') or has_table_privilege('authenticated', 'crm.' || t, 'update') or has_table_privilege('authenticated', 'crm.' || t, 'delete') then
      raise exception 'FAILED: % grants more than internal reads', t;
    end if;
    select count(*) into n from pg_trigger g where g.tgrelid = ('crm.' || t)::regclass and g.tgname like 'freeze_org_%';
    if n <> 1 then raise exception 'FAILED: % does not freeze its organisation', t; end if;
  end loop;
  raise notice 'ok  all seven ad tables: forced RLS, no anon read, no authenticated write, organisation frozen';
end $$;
do $$
declare f text;
begin
  foreach f in array array['begin_ad_apply(uuid,uuid,uuid)', 'record_ad_apply(uuid,uuid,uuid,text,text,jsonb,jsonb)', 'record_ad_metrics(uuid,uuid,date,bigint,bigint,bigint,bigint)',
                           'confirm_ad_change(uuid,uuid,boolean,text)', 'enforce_ad_stops(integer)', 'assess_campaign_health(uuid,uuid)', 'sync_ad_approvals(integer)'] loop
    if has_function_privilege('authenticated', 'crm.' || f, 'execute') or has_function_privilege('anon', 'crm.' || f, 'execute') then
      raise exception 'FAILED: crm.% is callable by a signed-in user', f;
    end if;
    if not has_function_privilege('service_role', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is not callable by the engine', f; end if;
  end loop;
  raise notice 'ok  the machine doors are the engine''s alone';
end $$;

select 'ALL CHECKS PASSED' as result;
rollback;
