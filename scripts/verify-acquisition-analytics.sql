-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 11 — Results are read from the CRM, goals are measured
-- against what the Admin set, and what is failing is loud. Reading only.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-analytics.sql
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

-- The scratch database already holds seed leads, so counts are asserted as the CHANGE the fixtures cause.
-- The funnel answers only an INTERNAL session about its own organisation, so the baseline is taken as the admin.
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
create temp table base90 as select * from crm.acquisition_funnel(90);
create temp table base365 as select * from crm.acquisition_funnel(365);
grant all on base90, base365 to public;
create or replace function pg_temp.d(p_days integer, p_channel text, p_col text) returns bigint language sql as $$
  select (to_jsonb(f) ->> p_col)::bigint - (to_jsonb(b) ->> p_col)::bigint
    from crm.acquisition_funnel(p_days) f join (select * from base90 where p_days = 90 union all select * from base365 where p_days = 365) b using (channel) where channel = p_channel $$;
grant execute on function pg_temp.d(integer, text, text) to public;

-- ── setup: goals, leads with histories across channels, spend ──
set local role authenticated;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.ensure_acquisition_defaults();
select crm.ensure_acquisition_approval_policies();
select crm.set_channel_settings('meta_ads', true, 5, 1000000, 50);
select crm.set_channel_settings('email', true, 3, null, 50);
reset role;
insert into core.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000b2', 'Other Agency', 'other-agency') on conflict do nothing;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'c1', contact_id from crm.resolve_identity(:'ORG', '{"name":"Hist One","email":"h1@an.example"}', 'whatsapp');
insert into fx select 'c2', contact_id from crm.resolve_identity(:'ORG', '{"name":"Hist Two","email":"h2@an.example"}', 'whatsapp');
insert into fx select 'c3', contact_id from crm.resolve_identity(:'ORG', '{"name":"Hist Three","email":"h3@an.example"}', 'whatsapp');
insert into fx select 'c4', contact_id from crm.resolve_identity(:'ORG', '{"name":"Hist Four","email":"h4@an.example"}', 'whatsapp');
insert into fx select 'c5', contact_id from crm.resolve_identity(:'ORG', '{"name":"Hist Five","email":"h5@an.example"}', 'whatsapp');
insert into fx select 'c6', contact_id from crm.resolve_identity(:'ORG', '{"name":"Hist Six","email":"h6@an.example"}', 'whatsapp');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status, created_at, qualified_at, converted_at) values
  ('00000000-0000-4000-8000-0000000000a1', :'ORG', (select v from fx where k = 'c1'), 'L1 meta then email', 'whatsapp', 'wa:an1', 'converted', now() - interval '30 days', now(), now()),
  ('00000000-0000-4000-8000-0000000000a2', :'ORG', (select v from fx where k = 'c2'), 'L2 google', 'whatsapp', 'wa:an2', 'qualified', now() - interval '30 days', now(), null),
  ('00000000-0000-4000-8000-0000000000a3', :'ORG', (select v from fx where k = 'c3'), 'L3 email then meta', 'whatsapp', 'wa:an3', 'new', now() - interval '30 days', null, null),
  ('00000000-0000-4000-8000-0000000000a4', :'ORG', (select v from fx where k = 'c4'), 'L4 nothing else', 'whatsapp', 'wa:an4', 'new', now() - interval '30 days', null, null),
  ('00000000-0000-4000-8000-0000000000a5', :'ORG', (select v from fx where k = 'c5'), 'L5 old', 'whatsapp', 'wa:an5', 'new', now() - interval '200 days', null, null),
  ('00000000-0000-4000-8000-0000000000a6', :'ORG', (select v from fx where k = 'c6'), 'L6 b2b win in dollars', 'whatsapp', 'wa:an6', 'converted', now() - interval '30 days', now(), now());
-- The WON gate and hand-off are not what is measured here: the fixture steps around them, inside this rolled-back transaction.
alter table sales.opportunities disable trigger opportunities_won_gate;
alter table sales.opportunities disable trigger opportunities_won_handoff;
insert into sales.opportunities (organization_id, lead_id, name, stage, closed_at, value_minor, currency) values
  (:'ORG', '00000000-0000-4000-8000-0000000000a1', 'Won in rupees', 'won', now(), 5000000, 'INR'),
  (:'ORG', '00000000-0000-4000-8000-0000000000a6', 'Won in dollars', 'won', now(), 120000, 'USD');
alter table sales.opportunities enable trigger opportunities_won_gate;
alter table sales.opportunities enable trigger opportunities_won_handoff;
set local role service_role;
select pg_temp.as_service();
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000a1', 'meta_ads', 'facebook', 'ad_click', '{"ad_id":"A1"}', '{}', 'an:a1:ad', now() - interval '35 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000a1', 'email', null, 'reply_received', '{}', '{}', 'an:a1:em', now() - interval '10 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000a2', 'google_ads', 'google', 'ad_click', '{}', '{}', 'an:a2:g', now() - interval '35 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000a3', 'email', null, 'outreach_sent', '{}', '{}', 'an:a3:em', now() - interval '35 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000a3', 'meta_ads', 'facebook', 'ad_click', '{"ad_id":"A3"}', '{}', 'an:a3:ad', now() - interval '10 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000a6', 'b2b', 'upwork', 'profile_inquiry', '{}', '{}', 'an:a6:b', now() - interval '35 days');
select crm.record_acquisition_usage(:'ORG', 'meta_ads', 'spend_minor', 60000, 'an-spend-1');
select crm.record_acquisition_usage(:'ORG', 'social', 'action', 12, 'an-social-actions');
reset role;
insert into crm.acquisition_usage (organization_id, channel, metric, amount, ref, occurred_at) values (:'ORG', 'meta_ads', 'spend_minor', 999999, 'an-old-spend', now() - interval '400 days');

-- ═══ A. results by the channel of the FIRST touch, with the other views alongside ═══
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from crm.acquisition_funnel(90)) = 6, 'the funnel has a row for each of the five channels and everything else');
select pg_temp.check((pg_temp.d(90, 'meta_ads', 'leads'), pg_temp.d(90, 'meta_ads', 'qualified'), pg_temp.d(90, 'meta_ads', 'won')) = (1, 1, 1), 'Meta is credited with the one lead whose FIRST touch was a Meta ad - qualified and won');
select pg_temp.check((pg_temp.d(90, 'email', 'leads'), pg_temp.d(90, 'email', 'qualified'), pg_temp.d(90, 'email', 'won')) = (1, 0, 0), 'email is credited with the lead it found first, even though Meta touched it last');
select pg_temp.check((pg_temp.d(90, 'google_ads', 'leads'), pg_temp.d(90, 'google_ads', 'qualified'), pg_temp.d(90, 'google_ads', 'won')) = (1, 1, 0), 'Google is credited with its own first-touch lead');
select pg_temp.check((pg_temp.d(90, 'b2b', 'leads'), pg_temp.d(90, 'b2b', 'won')) = (1, 1), 'a marketplace win is credited to B2B');
select pg_temp.check(pg_temp.d(90, 'other', 'leads') = 1, 'a lead with no channel but its own arrival is "other", not invented credit');
select pg_temp.check((pg_temp.d(90, 'meta_ads', 'last_touch_leads'), pg_temp.d(90, 'email', 'last_touch_leads')) = (1, 1), 'last-touch counts are alongside, from the same rows: the lead email found first is LAST touched by Meta, and the one Meta found first by email');
select pg_temp.check(pg_temp.d(90, 'meta_ads', 'touched_leads') = 2, 'two leads were TOUCHED by Meta, though only one was found by it');
select pg_temp.check(pg_temp.d(90, 'email', 'touched_leads') = 2, 'and two were touched by email');
select pg_temp.check((select revenue from crm.acquisition_funnel(90) where channel = 'meta_ads') = '{"INR": 5000000}'::jsonb, 'revenue is kept in the currency it was won in');
select pg_temp.check((select revenue from crm.acquisition_funnel(90) where channel = 'b2b') = '{"USD": 120000}'::jsonb, '…so rupees and dollars are never added together');
select pg_temp.check((select revenue from crm.acquisition_funnel(90) where channel = 'email') = '{}'::jsonb, 'a channel with no wins has no revenue, not a zero in some currency');
select pg_temp.check((select spend_minor from crm.acquisition_funnel(90) where channel = 'meta_ads') = 60000, 'spend inside the window comes from the usage ledger (old spend is outside it)');
select pg_temp.check((select (cost_per_lead_minor, cost_per_qualified_minor, cost_per_won_minor) = (60000, 60000, 60000) from crm.acquisition_funnel(90) where channel = 'meta_ads'), 'each cost is spend divided by what it bought');
select pg_temp.check((select cost_per_lead_minor is null and cost_per_won_minor is null from crm.acquisition_funnel(90) where channel = 'email'), 'a channel with no spend has no cost - not zero');
select pg_temp.check((select cost_per_won_minor is null from crm.acquisition_funnel(90) where channel = 'google_ads'), 'a cost with nothing to divide by is null');
select pg_temp.check((select bool_and(insufficient_data) from crm.acquisition_funnel(90) where channel <> 'other'), 'every engine channel is marked too thin to judge (the ''other'' row, everything that arrived on its own, can be large)');
select pg_temp.check(pg_temp.d(365, 'other', 'leads') = 2, 'a wider window takes in the older lead');
select pg_temp.check((select sum(leads) from crm.acquisition_funnel(90)) - (select sum(leads) from base90) = 5, 'five of the six new leads are in the 90-day window, none counted twice');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select sum(leads) from crm.acquisition_funnel(365)) = 0 and (select sum(spend_minor) from crm.acquisition_funnel(365)) = 0, 'another organisation sees none of it');

-- ═══ B. goals ══════════════════════════════════════════════════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select count(*) from crm.acquisition_goal_progress()) = 5, 'goal progress has a row for each of the five channels');
select pg_temp.check((select (qualified_target, qualified_this_month, spend_this_month_minor, budget_used_pct) = (5, 1, 60000, 6) from crm.acquisition_goal_progress() where channel = 'meta_ads'), 'Meta: goal 5, one qualified this month, spend counted, 6% of the budget used');
select pg_temp.check((select (pace_pct is not null and on_pace is not null) from crm.acquisition_goal_progress() where channel = 'meta_ads'), 'a channel with a goal has a pace');
select pg_temp.check((select (pace_pct = round(100.0 * (qualified_this_month::numeric * days_in_month / days_elapsed) / qualified_target)::integer) and (on_pace = ((qualified_this_month::numeric * days_in_month / days_elapsed) >= qualified_target * 0.8)) from crm.acquisition_goal_progress() where channel = 'meta_ads'), 'the pace is the month projected from the days elapsed, and "on pace" means within 80% of the goal');
select pg_temp.check((select (qualified_this_month = 0 and pace_pct = 0 and on_pace = false) from crm.acquisition_goal_progress() where channel = 'email'), 'a channel with a goal and nothing qualified is at 0% pace and NOT on pace, on any day of the month');
select pg_temp.check((select (pace_pct is null and on_pace is null and budget_used_pct is null) from crm.acquisition_goal_progress() where channel = 'social'), 'a channel with no goal and no budget has no pace and no percentage - never a guess');
select pg_temp.check((select days_elapsed between 1 and days_in_month from crm.acquisition_goal_progress() limit 1), 'the month''s clock is sane');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.acquisition_goal_progress()) = 0, 'another organisation sees none of our goals');
reset role;

-- ═══ C. what is wrong, in one list ═════════════════════════════════════════
set local role service_role;
select pg_temp.as_service();
insert into fx select 'req1', request_id from approvals.request_approval(:'ORG', 'acquisition_action', gen_random_uuid(), 'system', null, 'verifier', '{}', null, 'internal');
insert into fx select 'req2', request_id from approvals.request_approval(:'ORG', 'acquisition_action', gen_random_uuid(), 'system', null, 'verifier two', '{}', null, 'internal');
insert into fx select 'req3', request_id from approvals.request_approval(:'ORG', 'acquisition_action', gen_random_uuid(), 'system', null, 'verifier three', '{}', null, 'internal');
insert into fx select 'req4', request_id from approvals.request_approval(:'ORG', 'acquisition_action', gen_random_uuid(), 'system', null, 'verifier four', '{}', null, 'internal');
reset role;
insert into crm.governed_executions (id, organization_id, approval_request_id, artifact_type, artifact_id, content_hash, action_type, channel) values
  ('00000000-0000-4000-8000-0000000000e1', :'ORG', (select v from fx where k = 'req1'), 'acquisition_action', gen_random_uuid(), repeat('a', 64), 'ad_launch', 'meta_ads'),
  ('00000000-0000-4000-8000-0000000000e2', :'ORG', (select v from fx where k = 'req2'), 'acquisition_action', gen_random_uuid(), repeat('b', 64), 'social_publish', 'social'),
  ('00000000-0000-4000-8000-0000000000e3', :'ORG', (select v from fx where k = 'req3'), 'acquisition_action', gen_random_uuid(), repeat('c', 64), 'b2b_proposal_submit', 'b2b');
insert into crm.governed_executions (id, organization_id, approval_request_id, artifact_type, artifact_id, content_hash, action_type, channel, started_at) values
  ('00000000-0000-4000-8000-0000000000e4', :'ORG', (select v from fx where k = 'req4'), 'acquisition_action', gen_random_uuid(), repeat('d', 64), 'landing_page_deploy', 'google_ads', now() - interval '30 minutes');
set local role service_role;
select pg_temp.as_service();
select crm.finish_governed_execution(:'ORG', '00000000-0000-4000-8000-0000000000e1', 'unknown', null, '{}');
select crm.finish_governed_execution(:'ORG', '00000000-0000-4000-8000-0000000000e2', 'failed', null, '{"reason":"quota"}');
select crm.finish_governed_execution(:'ORG', '00000000-0000-4000-8000-0000000000e3', 'executed', 'ref-1', '{}');
select core.raise_alert(:'ORG', 'ad_operations', 'warning', 'An approved ad change is waiting', 'verifier-alert-1');
select core.raise_alert(:'ORG', 'something_else', 'critical', 'Not an acquisition alert', 'verifier-alert-2');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'reg', integration_id from crm.register_integration('meta_ads', 'production', null, true);
select crm.set_channel_pause('b2b', true, 'verifier stop');
select pg_temp.check((select kind from crm.acquisition_failures(100) limit 1) like 'execution_%' or (select severity from crm.acquisition_failures(100) limit 1) = 'critical', 'the list starts with the worst');
select pg_temp.check((select severity from crm.acquisition_failures(100) limit 1) = 'critical', '…critical first');
select pg_temp.check(exists (select 1 from crm.acquisition_failures(100) where kind = 'execution_unknown' and severity = 'critical' and channel = 'meta_ads' and advice like '%Check the platform%'), 'an execution with an UNKNOWN outcome is critical and says to check the platform');
select pg_temp.check(exists (select 1 from crm.acquisition_failures(100) where kind = 'execution_failed' and severity = 'warning' and channel = 'social'), 'a failed execution (first attempt) is a warning');
select pg_temp.check(not exists (select 1 from crm.acquisition_failures(100) where ref_id = '00000000-0000-4000-8000-0000000000e3'), 'an execution that succeeded is not a failure');
select pg_temp.check(exists (select 1 from crm.acquisition_failures(100) where kind = 'execution_stalled' and ref_id = '00000000-0000-4000-8000-0000000000e4'), 'an execution stuck for over ten minutes is stalled');
select pg_temp.check(exists (select 1 from crm.acquisition_failures(100) where kind = 'worker_alert' and channel = 'meta_ads' and summary = 'An approved ad change is waiting'), 'an unacknowledged alert from an acquisition worker is listed against its channel');
select pg_temp.check(not exists (select 1 from crm.acquisition_failures(100) where summary = 'Not an acquisition alert'), '…and an alert from somewhere else is not');
select pg_temp.check(exists (select 1 from crm.acquisition_failures(100) where kind = 'channel_paused' and channel = 'b2b' and severity = 'info'), 'a stop in force is listed, quietly');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select crm.store_connector_secret((select v from fx where k = 'reg'), 'access_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'meta', null);
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'reg'), true);
select crm.record_integration_check(:'ORG', (select v from fx where k = 'reg'), true, 'act_1', '{"CREATE_CAMPAIGN":"AUTOMATED"}', null, null);
select crm.record_integration_check(:'ORG', (select v from fx where k = 'reg'), false, null, null, 'transient', 'rate limited');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check(exists (select 1 from crm.acquisition_failures(100) where kind = 'connection_degraded' and severity = 'warning'), 'a degraded connection is listed');
select pg_temp.check((select count(*) from crm.acquisition_failures(2)) = 2, 'the list is bounded by the limit asked for');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.acquisition_failures(100)) = 0, 'another organisation sees none of our failures');

-- ═══ D. advice, never action ═══════════════════════════════════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check(exists (select 1 from crm.acquisition_recommendations(90) where channel = 'social' and recommendation = 'acting_without_producing_a_lead_check_tracking'), 'a channel that acted twelve times and produced no lead is flagged: tracking may be broken');
select pg_temp.check(not exists (select 1 from crm.acquisition_recommendations(90) where channel = 'meta_ads' and recommendation = 'acting_without_producing_a_lead_check_tracking'), '…and a channel that produced a lead is not');
select pg_temp.check(exists (select 1 from crm.acquisition_recommendations(90) where channel = 'meta_ads' and recommendation = 'too_early_to_judge' and (basis ->> 'leads')::int = 1), 'with one lead the advice is that it is too early to judge, with the number it rests on');
select pg_temp.check(not exists (select 1 from crm.acquisition_recommendations(90) where recommendation = 'cost_per_qualified_far_above_its_sibling'), 'no cost comparison is made from a sample this small');
select pg_temp.check(not exists (select 1 from crm.acquisition_recommendations(90) where channel = 'social' and recommendation = 'behind_pace_for_the_monthly_goal'), 'a channel with no goal is never "behind" it');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_settings('meta_ads', true, 5, 65000, 50);
select pg_temp.check((select count(*) from crm.acquisition_recommendations(90) where channel = 'meta_ads' and recommendation = 'budget_nearly_used') = (select case when days_elapsed < days_in_month then 1 else 0 end from crm.acquisition_goal_progress() where channel = 'meta_ads'), '92% of the budget used with the month not over is flagged (and only then)');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.acquisition_recommendations(90)) = 0, 'another organisation gets none of our advice');
reset role;

-- ═══ E. reading only ═══════════════════════════════════════════════════════
do $$
declare f text; v text;
begin
  foreach f in array array['acquisition_funnel(integer)', 'acquisition_goal_progress()', 'acquisition_failures(integer)', 'acquisition_recommendations(integer)'] loop
    select p.provolatile into v from pg_proc p where p.oid = ('crm.' || f)::regprocedure;
    if v <> 's' then raise exception 'FAILED: crm.% is not STABLE (it may write)', f; end if;
    if has_function_privilege('anon', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is callable by anon', f; end if;
    if not has_function_privilege('authenticated', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is not callable by a signed-in user', f; end if;
  end loop;
  raise notice 'ok  all four are STABLE (cannot write), closed to anon and open to signed-in users';
end $$;
-- nothing was changed by reading: the usage ledger, the executions and the alerts are as they were
select pg_temp.check((select count(*) from crm.acquisition_usage where ref = 'an-spend-1') = 1, 'reading changed nothing');

select 'ALL CHECKS PASSED' as result;
rollback;
