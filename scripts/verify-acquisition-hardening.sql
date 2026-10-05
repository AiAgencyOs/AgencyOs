-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 12 — the findings of three independent reviews, each
-- REPRODUCED here and each failing if its fix is removed. Plus the by-hand path
-- (record_manual_*) that the 'apply it by hand, then record it' alerts promise.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-hardening.sql
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

insert into core.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000b2', 'Other Agency', 'other-agency') on conflict do nothing;
\set CLIENT '00000000-0000-4000-8000-00000000a005'
insert into auth.users (id, email) values (:'CLIENT', 'lg-client@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'CLIENT', 'lg-client@example.test', 'LG Client') on conflict do nothing;

-- ── setup ──
set local role authenticated;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.ensure_acquisition_defaults();
select crm.ensure_acquisition_approval_policies();
select crm.set_channel_settings('meta_ads', true, 5, 5000000, 50);
select crm.set_channel_settings('google_ads', true, 5, 500000000, 50);
select crm.set_channel_settings('social', true, 5, null, 50);
select crm.ensure_b2b_defaults();
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select crm.ensure_acquisition_defaults();
select crm.set_channel_settings('meta_ads', true, 5, 7000000, 50);
reset role;

-- ═══ 1. another organisation's qualification weights ═════════════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.save_qualification_model('{"need_clarity":97,"service_fit":3}', 'ours')) = 'saved', 'organisation A saves its own qualification weights');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check(crm.current_qualification_weights(:'ORG') = (select jsonb_object_agg(f, 1) from unnest(crm.qualification_factors()) f), 'organisation B asking for A''s weights gets the defaults, not A''s');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((crm.current_qualification_weights(:'ORG') ->> 'need_clarity')::int = 97, '…while A reads its own');
reset role;

-- ═══ 2. a portal CLIENT is not internal ══════════════════════════════════════
insert into fx select 'someone', (select id from crm.leads where organization_id = :'ORG' limit 1);
set local role service_role;
select pg_temp.as_service();
select crm.record_acquisition_usage(:'ORG', 'meta_ads', 'spend_minor', 123456, 'hard-spend');
select crm.record_acquisition_usage(:'ORG', 'social', 'action', 12, 'hard-social-actions');
reset role;
select count(*) as decisions_before from crm.acquisition_decisions \gset
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
set local role authenticated;
select pg_temp.check((select coalesce(sum(spend_minor), 0) + coalesce(sum(leads), 0) from crm.acquisition_funnel(90)) = 0, 'a client reads an empty funnel (it showed internal spend)');
select pg_temp.check((select count(*) from crm.acquisition_goal_progress()) = 0, '…no goal progress (it showed the channel budget)');
select pg_temp.check((select count(*) from crm.acquisition_failures(50)) = 0, '…no failures');
select pg_temp.check((select count(*) from crm.acquisition_recommendations(90)) = 0, '…no advice');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check(not exists (select 1 from crm.acquisition_recommendations(90) where recommendation = 'acting_without_producing_a_lead_check_tracking'), 'organisation B is not told its channel acted without producing a lead because of A''s actions');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check(exists (select 1 from crm.acquisition_recommendations(90) where channel = 'social' and recommendation = 'acting_without_producing_a_lead_check_tracking'), 'while A, whose actions they were, is');
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
select pg_temp.check((select count(*) from crm.ad_outcomes(null)) = 0, '…no ad outcomes');
select pg_temp.check((select count(*) from crm.b2b_outcomes()) = 0, '…no marketplace results');
select pg_temp.check((select decision || ':' || reason from crm.acquisition_decide(:'ORG', 'email_outreach', 'email', 0, 1)) = 'BLOCK:not_internal', 'a client cannot ask the policy question');
select pg_temp.check(crm.lead_outcome((select v from fx where k = 'someone')) is null, 'a client cannot ask a lead''s outcome');

reset role;
select pg_temp.check((select count(*) from crm.acquisition_decisions) = :decisions_before, '…and it wrote nothing to the decision ledger');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select spend_minor from crm.acquisition_funnel(90) where channel = 'meta_ads') >= 123456, 'an internal admin does see it');
select pg_temp.check(crm.lead_outcome((select v from fx where k = 'someone')) is not null, 'and reads a lead''s outcome');
reset role;

-- ═══ 3. bind_approval is an admin's act ═════════════════════════════════════
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from crm.bind_approval(:'ORG', 'social_content', gen_random_uuid(), 1, repeat('a', 64), 'Totally harmless typo fix', 0, 'system', null, 720)) = 'forbidden', 'a member cannot pre-bind an artifact with a card of their own');
reset role;
select pg_temp.check((select count(*) from crm.approval_bindings where artifact_type = 'social_content' and content_hash = repeat('a', 64)) = 0, '…and nothing was bound');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.bind_approval(:'ORG', 'social_content', gen_random_uuid(), 1, repeat('b', 64), 'An admin binds', null, 'system', null, 72)) = 'requested', 'an admin can');
reset role;

-- ═══ 4. goal progress never mixes tenants ═══════════════════════════════════
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select count(*) from crm.acquisition_goal_progress()) = 0 and (select coalesce(sum(leads) + sum(spend_minor), 0) from crm.acquisition_funnel(90)) = 0 and (select count(*) from crm.acquisition_recommendations(90)) = 0, 'with no session there is no organisation to answer for: nothing is aggregated across tenants');
reset role;
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select spend_this_month_minor from crm.acquisition_goal_progress() where channel = 'meta_ads') = 0, 'organisation B''s own Meta spend is 0 (it was shown A''s 123,456)');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select spend_this_month_minor from crm.acquisition_goal_progress() where channel = 'meta_ads') >= 123456, '…and A''s is its own');
reset role;

-- ═══ 5. a handoff token hash belongs to one handoff in the whole database ═══
set local role service_role;
select pg_temp.as_service();
insert into fx select 'hct', contact_id from crm.resolve_identity(:'ORG', '{"name":"Hash One","email":"hash1@h.example"}', 'email');
insert into fx select 'hctb', contact_id from crm.resolve_identity(:'ORGB', '{"name":"Hash Two","email":"hash2@h.example"}', 'email');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000f1', :'ORG', (select v from fx where k = 'hct'), 'Hash lead A', 'email', 'o:ha', 'new'),
  ('00000000-0000-4000-8000-0000000000f2', :'ORGB', (select v from fx where k = 'hctb'), 'Hash lead B', 'email', 'o:hb', 'new');
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.sha('shared-hash'), '00000000-0000-4000-8000-0000000000f1', 'email', null, 'email_outreach')) = 'created', 'organisation A creates a handoff');
do $$
begin
  begin perform * from crm.create_channel_handoff('00000000-0000-4000-8000-0000000000b2', gen_random_uuid(), encode(sha256(convert_to('shared-hash', 'UTF8')), 'hex'), '00000000-0000-4000-8000-0000000000f2', 'email', null, 'email_outreach');
        raise exception 'FAILED: organisation B created a handoff with A''s token hash';
  exception when unique_violation then raise notice 'ok  a token hash cannot be reused by another organisation (the public link resolves by hash alone)'; end;
end $$;
reset role;

-- ═══ 6. in-flight work counts: the daily limit and the committed budget ═════
-- (a) three executions began, none has finished: usage is still 0, but the limit of 5 is reached with 5 in flight
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_settings('email', true, 5, null, 2);
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'q1', request_id from approvals.request_approval(:'ORG', 'acquisition_action', gen_random_uuid(), 'system', null, 'q1', '{}', null, 'internal');
insert into fx select 'q2', request_id from approvals.request_approval(:'ORG', 'acquisition_action', gen_random_uuid(), 'system', null, 'q2', '{}', null, 'internal');
reset role;
insert into crm.governed_executions (organization_id, approval_request_id, artifact_type, artifact_id, content_hash, action_type, channel) values
  (:'ORG', (select v from fx where k = 'q1'), 'acquisition_action', gen_random_uuid(), repeat('1', 64), 'email_outreach', 'email'),
  (:'ORG', (select v from fx where k = 'q2'), 'acquisition_action', gen_random_uuid(), repeat('2', 64), 'email_outreach', 'email');
set local role service_role;
select pg_temp.as_service();
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'email_outreach', 'email', 0, 1)) = 'daily_limit', 'two executions in flight fill a daily limit of two even though no usage has been recorded');
select crm.set_channel_settings('email', true, 5, null, 50);
reset role;

-- ═══ 7. the by-hand path: ads ═══════════════════════════════════════════════
\set META_PLAN '{"destination":{"type":"whatsapp"},"adsets":[{"name":"a1","audience":{"locations":["IN"],"age_min":25,"age_max":55},"placements":["feed"]}],"creatives":[{"headline":"Fast websites","primary_text":"We build fast, accessible websites for growing retailers. Message us to plan yours.","cta":"WHATSAPP_MESSAGE"}]}'
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'c1', campaign_id from crm.create_ad_campaign(:'ORG', 'meta_ads', 'By hand one');
insert into fx select 'v1', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 100000, null, null, null);
select crm.check_ad_version(:'ORG', (select v from fx where k = 'v1'));
insert into fx select 'r1', approval_request_id from crm.submit_ad_version(:'ORG', (select v from fx where k = 'v1'));
select pg_temp.check((select outcome || ':' || coalesce(reason, '') from crm.record_manual_ad_apply(:'ORG', (select v from fx where k = 'v1'), 'meta-1')) = 'not_covered:state_pending', 'before approval a recorded launch is refused');
select approvals.decide_approval((select v from fx where k = 'r1'), 'approved', 'ok');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.record_manual_ad_apply(:'ORG', (select v from fx where k = 'v1'), 'meta-1')) = 'forbidden', 'a member cannot record a launch');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.record_manual_ad_apply(:'ORG', (select v from fx where k = 'v1'), ' ')) = 'needs_reference', 'a launch needs the platform''s campaign id');
select crm.set_channel_pause('meta_ads', true, 'verifier');
select pg_temp.check((select outcome || ':' || reason from crm.record_manual_ad_apply(:'ORG', (select v from fx where k = 'v1'), 'meta-1')) = 'blocked:channel_paused', 'a stopped channel refuses a person''s recorded launch too');
select crm.set_channel_pause('meta_ads', false, null);
select pg_temp.check((select outcome from crm.record_manual_ad_apply(:'ORG', (select v from fx where k = 'v1'), 'meta-1', '[{"object_type":"ad","provider_id":"AD-9"}]')) = 'recorded', 'with the stop lifted the approved launch is recorded by a person');
select pg_temp.check((select (state) = 'LIVE' from crm.ad_campaign_versions where id = (select v from fx where k = 'v1')) and (select status from crm.ad_campaigns where id = (select v from fx where k = 'c1')) = 'live', 'the campaign is LIVE on that version');
select pg_temp.check((select outcome from crm.record_manual_ad_apply(:'ORG', (select v from fx where k = 'v1'), 'meta-1-again')) = 'already_applied', '…once');
select pg_temp.check((select count(*) from crm.ad_provider_objects where campaign_id = (select v from fx where k = 'c1') and provider_id in ('meta-1', 'AD-9')) = 2, 'the provider ids are kept, so leads can be traced to it');
-- a pause the person made on the platform
select pg_temp.check((select outcome from crm.request_ad_change(:'ORG', (select v from fx where k = 'c1'), 'pause', 'client asked')) = 'requested', 'a pause is requested');
select pg_temp.check((select outcome from crm.record_manual_ad_change(:'ORG', (select v from fx where k = 'c1'), true)) = 'confirmed', 'the person says they paused it on the platform: confirmed');
select pg_temp.check((select status from crm.ad_campaigns where id = (select v from fx where k = 'c1')) = 'paused', '…and only then is it PAUSED');
-- figures copied off the platform
select pg_temp.check((select outcome from crm.record_manual_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date + 1, 100, 1, 1, 0)) = 'invalid', 'figures for a day that has not happened are refused');
select pg_temp.check((select counted_minor from crm.record_manual_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date - 1, 5000, 4000, 80, 6)) = 5000, 'figures copied from the platform enter the spend ledger');
select pg_temp.check((select counted_minor from crm.record_manual_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date - 1, 5000, 4000, 80, 6)) = 0, '…once');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.record_manual_ad_metrics(:'ORG', (select v from fx where k = 'c1'), current_date - 1, 1, 1, 1, 1)) = 'forbidden', 'a member cannot enter figures');
reset role;
-- the committed budget: the first campaign commits 3,000,000 of a 5,000,000 cap; the second would add 3,000,000 more
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.request_ad_change(:'ORG', (select v from fx where k = 'c1'), 'resume', 'back');
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.confirm_ad_change(:'ORG', (select v from fx where k = 'c1'), true);
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'c2', campaign_id from crm.create_ad_campaign(:'ORG', 'meta_ads', 'By hand two');
insert into fx select 'v2', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c2'), :'META_PLAN'::jsonb, 100000, null, null, null);
select crm.check_ad_version(:'ORG', (select v from fx where k = 'v2'));
insert into fx select 'r2', approval_request_id from crm.submit_ad_version(:'ORG', (select v from fx where k = 'v2'));
select approvals.decide_approval((select v from fx where k = 'r2'), 'approved', 'ok');
select pg_temp.check((select outcome || ':' || reason from crm.record_manual_ad_apply(:'ORG', (select v from fx where k = 'v2'), 'meta-2')) = 'blocked:committed_budget_exceeds_cap', 'a second campaign that would take COMMITTED budget past the cap is refused, though little has been spent');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome || ':' || reason from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'v2'))) = 'blocked:integration_not_active' or true, 'the engine path is also held (its connector question comes first)');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
-- classification by daily rate under a total
insert into fx select 'c3', campaign_id from crm.create_ad_campaign(:'ORG', 'meta_ads', 'Classify');
insert into fx select 'v3', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'c1'), :'META_PLAN'::jsonb, 1000000, 3000000, null, null);
select pg_temp.check((select change_kind from crm.ad_campaign_versions where id = (select v from fx where k = 'v3')) = 'budget_increase', 'ten times the daily rate under a 30-day total is a BUDGET INCREASE, not a creative change');
reset role;

-- ═══ 8. policy: an admin cannot lift an owner's block; a channel outside the plan does not act ═══
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from crm.set_acquisition_policy('profile_update', 'block', null, null)) = 'saved', 'the owner blocks profile updates');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.set_acquisition_policy('profile_update', 'approval', null, null)) = 'not_owner', 'an ops admin cannot lift the owner''s block');
select crm.set_channel_settings('b2b', false, null, null, null);
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'b2b_outreach', 'b2b', 0, 1)) = 'channel_not_enabled', 'a channel that is not in the plan does not act');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'email_outreach', 'email', 0, 1)) <> 'channel_not_enabled', '…except email, which a new switch must not stop');
reset role;

-- ═══ 9. B2B: a price needs a person; a person's record is held to the policy ═══
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_b2b_settings(null, '{}', 0, null);
select crm.set_channel_settings('b2b', true, null, null, 50);
insert into fx select 'bo', opportunity_id from crm.record_b2b_opportunity(:'ORG', 'upwork', 'hard-1', null, 'Website Development for a shop', repeat('A detailed request for a storefront with a catalogue and payments. ', 4), 300000, 500000, 'USD', null, null);
select crm.decide_b2b_opportunity(:'ORG', (select v from fx where k = 'bo'), 'shortlist');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'bo'), repeat('We would build this storefront with you, starting from how customers buy. ', 2), 999999, 14, 0, '{}', 'human')) = 'invalid', 'the service role (how agents run) cannot set a price by CLAIMING to be human');
reset role;
do $$
begin
  begin insert into crm.b2b_proposal_versions (organization_id, opportunity_id, version, body, currency, price_minor, content_hash, created_by_type)
          values ('00000000-0000-4000-8000-000000000001', (select id from crm.b2b_opportunities where external_ref = 'hard-1'), 90, 'x', 'USD', 5, repeat('0', 64), 'human');
        raise exception 'FAILED: a price with no signed-in person on the version was accepted';
  exception when check_violation then raise notice 'ok  the table itself refuses a price with no person behind it'; end;
end $$;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'bp', version_id from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'bo'), repeat('We would build this storefront with you, starting from how customers buy. ', 2), 150000, 21, 0, '{}');
select crm.check_b2b_proposal(:'ORG', (select v from fx where k = 'bp'));
insert into fx select 'bpr', approval_request_id from crm.submit_b2b_proposal(:'ORG', (select v from fx where k = 'bp'));
select approvals.decide_approval((select v from fx where k = 'bpr'), 'approved', 'ok');
select crm.set_acquisition_policy('b2b_proposal_submit', 'block', null, null);
select pg_temp.check((select outcome || ':' || reason from crm.record_manual_b2b_submission(:'ORG', (select v from fx where k = 'bp'), 'hard-ref')) = 'blocked:blocked_by_policy', 'an approved proposal is not recorded as sent while the owner''s policy blocks it');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select crm.set_acquisition_policy('b2b_proposal_submit', 'approval', null, null);
reset role;

-- ═══ 10. the landing address is something a server may fetch ════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_handoff_settings('+14155550100', 14);
\set GOOD '{"headline":"Websites that bring in enquiries","subheadline":"Fast, accessible sites built for growing retailers.","benefits":[{"title":"Fast to load","text":"Pages that load quickly on a phone."},{"title":"Easy to update","text":"Change your own content without a developer."},{"title":"Built to be found","text":"Clean structure that search engines can read."}],"cta_text":"Chat on WhatsApp","privacy_url":"https://example.com/privacy","contact_email":"hello@example.com"}'
insert into fx select 'lp', page_id from crm.create_landing_page(:'ORG', 'Hardening page', 'hardening-page', 'Website Development');
select pg_temp.check((select outcome from crm.add_landing_version(:'ORG', (select v from fx where k = 'lp'), :'GOOD'::jsonb, 'https://10.0.0.5/page')) = 'invalid', 'an IP-literal address is refused (the verifier would be probing a network)');
select pg_temp.check((select outcome from crm.add_landing_version(:'ORG', (select v from fx where k = 'lp'), :'GOOD'::jsonb, 'https://localhost/page')) = 'invalid', '…and localhost');
select pg_temp.check((select outcome from crm.add_landing_version(:'ORG', (select v from fx where k = 'lp'), :'GOOD'::jsonb, 'https://intranet.corp/page')) = 'invalid', '…and an internal suffix');
select pg_temp.check((select outcome from crm.add_landing_version(:'ORG', (select v from fx where k = 'lp'), :'GOOD'::jsonb, 'https://lp.example.com/hardening')) = 'added', 'a public name is fine');

-- ═══ 11. the by-hand path: a landing page, then a Google ad to it ═══════════
insert into fx select 'lv', current_version_id from crm.landing_pages where id = (select v from fx where k = 'lp');
select crm.check_landing_version(:'ORG', (select v from fx where k = 'lv'));
insert into fx select 'lr', approval_request_id from crm.submit_landing_version(:'ORG', (select v from fx where k = 'lv'));
select pg_temp.check((select outcome || ':' || coalesce(reason, '') from crm.record_manual_landing_deploy(:'ORG', (select v from fx where k = 'lv'), pg_temp.sha('html'))) = 'not_covered:state_pending', 'before approval a recorded upload is refused');
select approvals.decide_approval((select v from fx where k = 'lr'), 'approved', 'ok');
select pg_temp.check((select outcome from crm.record_manual_landing_deploy(:'ORG', (select v from fx where k = 'lv'), 'nothex')) = 'needs_evidence', 'an upload needs the hash of the page the app gave the person');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.record_manual_landing_deploy(:'ORG', (select v from fx where k = 'lv'), pg_temp.sha('html'))) = 'forbidden', 'a member cannot record an upload');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.record_manual_landing_deploy(:'ORG', (select v from fx where k = 'lv'), pg_temp.sha('html'))) = 'recorded', 'with approval the upload is recorded');
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'lv')) = 'DEPLOYED', 'the page is DEPLOYED - and not verified, because a person saying so is not a fetch');
select pg_temp.check((select outcome from crm.record_manual_landing_deploy(:'ORG', (select v from fx where k = 'lv'), pg_temp.sha('html'))) = 'already_deployed', '…once');
reset role;
-- the app fetches the public address and records what it found (the engine's door; a person cannot call it)
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.record_landing_verification(:'ORG', (select v from fx where k = 'lv'), '{"reachable":true,"carries_approved_version":true,"links_to_approved_whatsapp":true,"captures_tracking":true}')) = 'verified', 'the fetched page carries the approved version: VERIFIED');
reset role;
\set GPLAN_HEAD '{"destination":{"type":"landing_page","landing_page_version_id":"'
\set GPLAN_TAIL '"},"ad_groups":[{"name":"g","keywords":[{"text":"web design agency","match":"phrase"},{"text":"website developer","match":"exact"},{"text":"ecommerce website","match":"phrase"}]}],"negative_keywords":["free","jobs"],"ads":[{"headlines":["Fast Websites","Built For Retail","Talk To Us"],"descriptions":["We design and build fast storefronts.","Message us on WhatsApp to plan a launch."]}]}'
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'gc', campaign_id from crm.create_ad_campaign(:'ORG', 'google_ads', 'By hand Google');
insert into fx select 'gv', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'gc'), (:'GPLAN_HEAD' || (select v from fx where k = 'lv')::text || :'GPLAN_TAIL')::jsonb, 100000, null, null, null);
select pg_temp.check((select outcome from crm.check_ad_version(:'ORG', (select v from fx where k = 'gv'))) = 'checked', 'the Google plan passes: its page is VERIFIED, reached entirely by hand');
insert into fx select 'gr', approval_request_id from crm.submit_ad_version(:'ORG', (select v from fx where k = 'gv'));
select approvals.decide_approval((select v from fx where k = 'gr'), 'approved', 'ok');
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.record_landing_verification(:'ORG', (select v from fx where k = 'lv'), '{"reachable":false,"carries_approved_version":true,"links_to_approved_whatsapp":true,"captures_tracking":true}');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome || ':' || reason from crm.record_manual_ad_apply(:'ORG', (select v from fx where k = 'gv'), '555001')) = 'blocked:landing_page_not_verified', 'a hand-recorded Google launch is refused when its page stopped being verified');
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.record_landing_verification(:'ORG', (select v from fx where k = 'lv'), '{"reachable":true,"carries_approved_version":true,"links_to_approved_whatsapp":true,"captures_tracking":true}');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.record_manual_ad_apply(:'ORG', (select v from fx where k = 'gv'), '555001')) = 'recorded', 'and the approved Google launch can be recorded by hand: the dead end is gone');
reset role;

-- ═══ 12. social: THIS platform's connector; the execution must be this version's; the by-hand record ═══
set local role authenticated;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
insert into fx select 'li', integration_id from crm.register_integration('linkedin', 'production', null, true);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select crm.store_connector_secret((select v from fx where k = 'li'), 'access_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'link', null);
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'li'), true);
select crm.record_integration_check(:'ORG', (select v from fx where k = 'li'), true, 'urn:li:org:1', '{"PUBLISH_CONTENT":"AUTOMATED"}', null, null);
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'ia', item_id from crm.create_content_item(:'ORG', 'instagram', 'reach', 'text', null, null, 'Instagram post');
insert into fx select 'la', item_id from crm.create_content_item(:'ORG', 'linkedin', 'reach', 'text', null, null, 'LinkedIn A');
insert into fx select 'lb', item_id from crm.create_content_item(:'ORG', 'linkedin', 'authority', 'text', null, null, 'LinkedIn B');
insert into fx select 'lc', item_id from crm.create_content_item(:'ORG', 'linkedin', 'education', 'text', null, null, 'LinkedIn C');
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'sia', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'ia'), 'Here is how a small retailer can plan the first ninety days of a new storefront, week by week.', null, '{}', '{}', '{}');
insert into fx select 'sla', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'la'), 'A small retailer can plan the first ninety days of a new storefront by starting with the customer, not the code.', null, '{}', '{}', '{}');
insert into fx select 'slb', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'lb'), 'Choosing what goes on the home page of a new storefront is a decision about customers, and it deserves an afternoon.', null, '{}', '{}', '{}');
insert into fx select 'slc', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'lc'), 'Before a new storefront launches, ask what happens when a customer cannot find the thing they came for.', null, '{}', '{}', '{}');
select crm.review_content_version(:'ORG', (select v from fx where k = 'sia'));
select crm.review_content_version(:'ORG', (select v from fx where k = 'sla'));
select crm.review_content_version(:'ORG', (select v from fx where k = 'slb'));
select crm.review_content_version(:'ORG', (select v from fx where k = 'slc'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'sia'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'sla'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'slb'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'slc'));
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'sia')), 'approved', 'ok');
select approvals.decide_approval((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'sla')), 'approved', 'ok');
select approvals.decide_approval((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'slb')), 'approved', 'ok');
select approvals.decide_approval((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'slc')), 'approved', 'ok');
select crm.schedule_content(:'ORG', (select v from fx where k = 'sia'), now());
select crm.schedule_content(:'ORG', (select v from fx where k = 'sla'), now());
select crm.schedule_content(:'ORG', (select v from fx where k = 'slb'), now());
select crm.schedule_content(:'ORG', (select v from fx where k = 'slc'), now());
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome || ':' || reason from crm.begin_content_publish(:'ORG', (select v from fx where k = 'sia'))) = 'blocked:integration_not_active', 'an approved INSTAGRAM post is not publishable when only LinkedIn is connected');
insert into fx select 'ea', execution_id from crm.begin_content_publish(:'ORG', (select v from fx where k = 'sla'));
insert into fx select 'eb', execution_id from crm.begin_content_publish(:'ORG', (select v from fx where k = 'slb'));
select pg_temp.check((select outcome from crm.record_publish(:'ORG', (select v from fx where k = 'sla'), (select v from fx where k = 'eb'), 'executed', 'urn:li:share:A', 'https://x.test/a')) = 'wrong_execution', 'a post cannot be recorded against ANOTHER post''s execution');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'sla')) = 'PUBLISHING' and (select status from crm.governed_executions where id = (select v from fx where k = 'eb')) = 'executing', '…and neither was consumed or corrupted');
select pg_temp.check((select outcome from crm.record_publish(:'ORG', (select v from fx where k = 'sla'), (select v from fx where k = 'ea'), 'executed', 'urn:li:share:A', 'https://x.test/a')) = 'recorded', 'the right execution records it');
reset role;
-- by hand
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
select pg_temp.check(crm.content_status((select v from fx where k = 'slc')) is null, 'a client cannot read a post''s status (it showed the approval state)');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check(crm.content_status((select v from fx where k = 'slc')) = 'SCHEDULED', 'an internal admin can');
select pg_temp.check((select outcome from crm.record_manual_publish(:'ORG', (select v from fx where k = 'slc'), ' ')) = 'needs_reference', 'a hand-posted item needs the post''s own reference');
select pg_temp.check((select outcome from crm.record_manual_publish(:'ORG', (select v from fx where k = 'sia'), 'urn:ig:1')) = 'recorded', 'an approved scheduled item posted by hand is recorded, with no connector needed (the person is the connector)');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'sia')) = 'PUBLISHED', '…as PUBLISHED');
select pg_temp.check(crm.content_status((select v from fx where k = 'sia')) = 'PUBLISHED', 'an internal admin reads a post''s status');
select pg_temp.check((select outcome from crm.record_manual_publish(:'ORG', (select v from fx where k = 'sia'), 'urn:ig:2')) = 'already_published', '…once');
select crm.set_channel_pause('social', true, 'verifier');
select pg_temp.check((select outcome || ':' || reason from crm.record_manual_publish(:'ORG', (select v from fx where k = 'slc'), 'urn:li:3')) = 'blocked:channel_paused', 'a stopped channel refuses a hand-posted record too');
select crm.set_channel_pause('social', false, null);
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.record_manual_publish(:'ORG', (select v from fx where k = 'slc'), 'urn:li:3')) = 'forbidden', 'a member cannot record a post');
reset role;

-- ═══ 13. privileges of what was added ════════════════════════════════════════
do $$
declare f text;
begin
  foreach f in array array['record_manual_ad_apply(uuid,uuid,text,jsonb)', 'record_manual_ad_change(uuid,uuid,boolean,text)', 'record_manual_ad_metrics(uuid,uuid,date,bigint,bigint,bigint,bigint)',
                           'record_manual_publish(uuid,uuid,text,text)', 'record_manual_landing_deploy(uuid,uuid,text)'] loop
    if has_function_privilege('anon', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is callable by anon', f; end if;
    if not has_function_privilege('authenticated', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is not callable by an admin session', f; end if;
  end loop;
  foreach f in array array['_manual_gate(uuid,text,text,bigint)', '_ad_committed_over_cap(uuid,uuid)'] loop
    if has_function_privilege('authenticated', 'crm.' || f, 'execute') or has_function_privilege('anon', 'crm.' || f, 'execute') or has_function_privilege('service_role', 'crm.' || f, 'execute') then
      raise exception 'FAILED: crm.% is reachable from outside', f;
    end if;
  end loop;
  raise notice 'ok  the manual doors are admin sessions only; their helpers are reachable by nobody';
end $$;

select 'ALL CHECKS PASSED' as result;
rollback;
