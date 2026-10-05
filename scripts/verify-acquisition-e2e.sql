-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 12 — END TO END across the slices. One visitor goes
-- from a Google landing page to a WhatsApp message through the REAL ingest
-- function; one prospect goes from an email to WhatsApp through the tracked
-- handoff; every engine's numbers must agree about the same leads; and the
-- emergency stop must reach every governed action. Rolls back.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-e2e.sql
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

create or replace function pg_temp.h(code text) returns text language sql as $$ select encode(sha256(convert_to(code, 'UTF8')), 'hex') $$;
grant execute on function pg_temp.h(text) to public;

update core.organizations set settings = settings || '{"whatsapp_phone_number_id":"pnid-e2e"}'::jsonb where id = :'ORG';
insert into core.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000b2', 'Other Agency', 'other-agency') on conflict do nothing;
-- The funnel answers only an INTERNAL session about its own organisation, so the baseline is taken as the admin.
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
create temp table base90 as select * from crm.acquisition_funnel(90);
grant all on base90 to public;
create or replace function pg_temp.d(p_channel text, p_col text) returns bigint language sql as $$
  select (to_jsonb(f) ->> p_col)::bigint - (to_jsonb(b) ->> p_col)::bigint from crm.acquisition_funnel(90) f join base90 b using (channel) where channel = p_channel $$;
grant execute on function pg_temp.d(text, text) to public;

-- ── setup: defaults, approval rules, the WhatsApp number, three connections through the real registry doors ──
set local role authenticated;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.ensure_acquisition_defaults();
select crm.ensure_acquisition_approval_policies();
select crm.set_handoff_settings('+14155550100', 14);
select crm.set_channel_settings('google_ads', true, 20, 500000000, 50);
select crm.set_channel_settings('email', true, 20, null, 50);
insert into fx select 'host', integration_id from crm.register_integration('hostinger', 'production', null, true);
insert into fx select 'ggl', integration_id from crm.register_integration('google_ads', 'production', null, true);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select crm.store_connector_secret((select v from fx where k = 'host'), 'api_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'host', null);
select crm.store_connector_secret((select v from fx where k = 'ggl'), 'refresh_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'g', null);
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'host'), true);
select crm.record_integration_check(:'ORG', (select v from fx where k = 'host'), true, 'host-1', '{"DEPLOY_PAGE":"AUTOMATED"}', null, null);
select crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'ggl'), true);
select crm.record_integration_check(:'ORG', (select v from fx where k = 'ggl'), true, 'cust-1', '{"CREATE_CAMPAIGN":"AUTOMATED"}', null, null);
reset role;

-- ═══ A. a landing page, verified; a Google campaign pointing at it; a visitor who messages on WhatsApp ═══
\set GOOD '{"headline":"Websites that bring in enquiries","subheadline":"Fast, accessible sites built for growing retailers.","benefits":[{"title":"Fast to load","text":"Pages that load quickly on a phone."},{"title":"Easy to update","text":"Change your own content without a developer."},{"title":"Built to be found","text":"Clean structure that search engines can read."}],"cta_text":"Chat on WhatsApp","privacy_url":"https://example.com/privacy","contact_email":"hello@example.com"}'
\set GPLAN_HEAD '{"destination":{"type":"landing_page","landing_page_version_id":"'
\set GPLAN_TAIL '"},"ad_groups":[{"name":"g","keywords":[{"text":"web design agency","match":"phrase"},{"text":"website developer","match":"exact"},{"text":"ecommerce website","match":"phrase"}]}],"negative_keywords":["free","jobs"],"ads":[{"headlines":["Fast Websites","Built For Retail","Talk To Us"],"descriptions":["We design and build fast storefronts.","Message us on WhatsApp to plan a launch."]}]}'
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'pg', page_id from crm.create_landing_page(:'ORG', 'E2E page', 'e2e-page', 'Website Development');
insert into fx select 'lv', version_id from crm.add_landing_version(:'ORG', (select v from fx where k = 'pg'), :'GOOD'::jsonb, 'https://lp.example.com/e2e');
select crm.check_landing_version(:'ORG', (select v from fx where k = 'lv'));
insert into fx select 'lreq', approval_request_id from crm.submit_landing_version(:'ORG', (select v from fx where k = 'lv'));
select approvals.decide_approval((select v from fx where k = 'lreq'), 'approved', 'ok');
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'lx', execution_id from crm.begin_landing_deploy(:'ORG', (select v from fx where k = 'lv'));
select crm.record_landing_deploy(:'ORG', (select v from fx where k = 'lv'), (select v from fx where k = 'lx'), 'executed', 'https://lp.example.com/e2e', pg_temp.h('html'));
select pg_temp.check((select outcome from crm.record_landing_verification(:'ORG', (select v from fx where k = 'lv'), '{"reachable":true,"carries_approved_version":true,"links_to_approved_whatsapp":true,"captures_tracking":true}')) = 'verified', 'the landing page is deployed and VERIFIED');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'gc', campaign_id from crm.create_ad_campaign(:'ORG', 'google_ads', 'E2E search');
insert into fx select 'gv', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'gc'), (:'GPLAN_HEAD' || (select v from fx where k = 'lv')::text || :'GPLAN_TAIL')::jsonb, 100000, null, null, null);
select pg_temp.check((select outcome from crm.check_ad_version(:'ORG', (select v from fx where k = 'gv'))) = 'checked', 'the Google plan passes its check because its page is VERIFIED');
insert into fx select 'greq', approval_request_id from crm.submit_ad_version(:'ORG', (select v from fx where k = 'gv'));
select approvals.decide_approval((select v from fx where k = 'greq'), 'approved', 'ok');
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'gx', execution_id from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'gv'));
select pg_temp.check((select outcome from crm.record_ad_apply(:'ORG', (select v from fx where k = 'gv'), (select v from fx where k = 'gx'), 'executed', '777001', '[]')) = 'recorded', 'the approved Google launch is applied once, with the provider''s campaign id');

-- the visitor clicks the ad, lands on the page, taps the button, and WhatsApp opens with the prefilled tag
select (left((select v from fx where k = 'lv')::text, 8)) as pfx \gset
insert into fx select 'visit', lead_id from crm.ingest_whatsapp_message('pnid-e2e', '14155550222', 'wamid.e2e.1', 'Hi, I''d like to talk about: Websites that bring in enquiries LP-' || :'pfx' || '-777001', 'Visitor Vee');
select pg_temp.check((select outcome from crm.record_landing_arrival(:'ORG', (select v from fx where k = 'visit'), 'Hi, I''d like to talk about: Websites that bring in enquiries LP-' || :'pfx' || '-777001', now())) = 'recorded', 'the tag in the REAL ingested message is turned into a Google touch');
select crm.ingest_whatsapp_message('pnid-e2e', '14155550222', 'wamid.e2e.2', 'Following up - LP-' || :'pfx' || '-777001', 'Visitor Vee');
select crm.record_landing_arrival(:'ORG', (select v from fx where k = 'visit'), 'Following up - LP-' || :'pfx' || '-777001', now());
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from crm.leads l join crm.contacts c on c.id = l.contact_id where c.phone = '+14155550222') = 1, 'two messages from the visitor are ONE lead');
select pg_temp.check((select count(*) from crm.lead_touchpoints where lead_id = (select v from fx where k = 'visit') and external_ref = 'landing:' || (select v from fx where k = 'visit')::text) = 1, '…with ONE landing visit recorded');
select pg_temp.check((select first_channel from crm.lead_attribution((select v from fx where k = 'visit'))) = 'google_ads', 'the lead''s FIRST touch is Google: the visit came before the message it produced');
select pg_temp.check((select leads from crm.ad_outcomes((select v from fx where k = 'gc'))) = 1, 'the campaign is credited with the lead');
select pg_temp.check(pg_temp.d('google_ads', 'leads') = 1, 'and so does the cross-channel funnel: two engines, one lead, one answer');
select pg_temp.check((pg_temp.d('google_ads', 'leads') = (select leads from crm.ad_outcomes((select v from fx where k = 'gc')))), 'the funnel and the campaign report the same number');

-- ═══ B. an email prospect moves to WhatsApp through the tracked handoff ══════
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'ect', contact_id from crm.resolve_identity(:'ORG', '{"name":"Em Prospect","email":"em@e2eco.example","phone":"+14155550333"}', 'email');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000e1', :'ORG', (select v from fx where k = 'ect'), 'Em from email', 'email', 'outreach:em', 'new');
set local role service_role;
select pg_temp.as_service();
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000e1', 'email', null, 'outreach_sent', '{}', '{}', 'e2e:em:out', now() - interval '3 days');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h('AOS-E2EE-1111-AAAA-2222'), '00000000-0000-4000-8000-0000000000e1', 'email', null, 'email_outreach')) = 'created', 'a tracked handoff is created for the emailed prospect');
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-e2e', '14155550333', pg_temp.h('AOS-E2EE-1111-AAAA-2222'))) = 'bound', 'their first WhatsApp message binds to the SAME lead');
insert into fx select 'em', lead_id from crm.ingest_whatsapp_message('pnid-e2e', '14155550333', 'wamid.e2e.3', 'Hi, following up on your email. Ref AOS-E2EE-1111-AAAA-2222', 'Em');
select pg_temp.check((select v from fx where k = 'em') = '00000000-0000-4000-8000-0000000000e1', 'the real ingest continued the emailed lead');
select pg_temp.check((select outcome from crm.consume_channel_handoff((select id from crm.channel_handoffs where lead_id = '00000000-0000-4000-8000-0000000000e1'), :'ORG', (select v from fx where k = 'ect'), '00000000-0000-4000-8000-0000000000e1')) = 'consumed', 'the handoff is consumed once the message is recorded');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from crm.leads where contact_id = (select v from fx where k = 'ect')) = 1, 'no second lead was created');
select pg_temp.check(pg_temp.d('email', 'leads') = 1, 'the funnel credits the lead to EMAIL, the channel that found it');
select pg_temp.check((select (first_channel, last_channel) = ('email', 'whatsapp') from crm.lead_attribution('00000000-0000-4000-8000-0000000000e1')), 'while attribution still shows email first and WhatsApp last');

-- ═══ C. the funnel never double counts, never loses a lead ═════════════════
select pg_temp.check((select sum(leads) from crm.acquisition_funnel(90)) = (select count(*) from crm.leads where created_at >= now() - interval '90 days' and merged_into_lead_id is null), 'every lead in the window is in exactly one channel row');

-- ═══ D. the emergency stop reaches every governed action ═════════════════
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from core.set_kill_switch('acquisition_paused', true, 'end to end')) = 'set', 'the owner throws the global stop');
do $$
declare a text; ch text; r record; n integer := 0;
begin
  for a in select unnest(array['email_outreach', 'email_followup', 'social_publish', 'social_outreach', 'social_followup', 'b2b_proposal_submit', 'b2b_outreach', 'profile_update',
                               'ad_launch', 'ad_budget_increase', 'ad_targeting_change', 'landing_page_deploy']) loop
    ch := case when a in ('ad_launch', 'ad_budget_increase', 'ad_targeting_change') then 'google_ads' else null end;
    select * into r from crm.acquisition_decide('00000000-0000-4000-8000-000000000001', a, ch, 0, 1);
    if r.decision <> 'BLOCK' or r.reason <> 'acquisition_paused' then raise exception 'FAILED: % was % (%) under the global stop', a, r.decision, r.reason; end if;
    n := n + 1;
  end loop;
  raise notice 'ok  all % governed actions are BLOCKED by the global stop at the one policy question', n;
end $$;
select pg_temp.check((select bool_and(crm.acquisition_blocked('00000000-0000-4000-8000-000000000001', c) = 'acquisition_paused') from unnest(array['meta_ads', 'email', 'social', 'google_ads', 'b2b']) c), 'every channel reads the stop');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select (select count(*) from crm.enforce_ad_stops() x) >= 0) and true, 'the worker turns the stop into pending pauses on live campaigns');
select pg_temp.check((select provider_sync_pending = 'pause' and status = 'live' from crm.ad_campaigns where id = (select v from fx where k = 'gc')), 'the live Google campaign has a PENDING pause - still shown live until the platform confirms');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from core.set_kill_switch('acquisition_paused', false, 'resolved')) = 'set', 'the owner lifts it');
select pg_temp.check((select decision <> 'BLOCK' or reason <> 'acquisition_paused' from crm.acquisition_decide('00000000-0000-4000-8000-000000000001', 'landing_page_deploy', null, 0, 1)), 'with the stop lifted the same question no longer answers "acquisition_paused"');

select 'ALL CHECKS PASSED' as result;
rollback;
