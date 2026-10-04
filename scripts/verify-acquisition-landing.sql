-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 9 — A landing page is deployed as EXACTLY what was
-- approved, DEPLOYED is not VERIFIED, and a Google ad may only point at a
-- VERIFIED page. Driven through the REAL approval engine and governed door.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-landing.sql
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

-- ── setup ──
set local role authenticated;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.ensure_acquisition_defaults();
select crm.ensure_acquisition_approval_policies();
select crm.set_channel_settings('google_ads', true, 20, 50000000, 50);
reset role;
insert into crm.portfolio_items (id, organization_id, kind, title, url) values
  ('00000000-0000-4000-8000-0000000000f1', :'ORG', 'past_work', 'Retail storefront rebuild', 'https://example.com/work/storefront'),
  ('00000000-0000-4000-8000-0000000000f2', :'ORG', 'sample', 'Retired sample', 'https://example.com/work/old');
update crm.portfolio_items set is_active = false where id = '00000000-0000-4000-8000-0000000000f2';
insert into core.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000b2', 'Other Agency', 'other-agency') on conflict do nothing;

\set GOOD '{"headline":"Websites that bring in enquiries","subheadline":"Fast, accessible sites built for growing retailers.","benefits":[{"title":"Fast to load","text":"Pages that load quickly on a phone."},{"title":"Easy to update","text":"Change your own content without a developer."},{"title":"Built to be found","text":"Clean structure that search engines can read."}],"proof":[{"portfolio_item_id":"00000000-0000-4000-8000-0000000000f1","caption":"A retail storefront we rebuilt"}],"faq":[{"q":"How long does a site take?","a":"It depends on the scope; we give an estimate after a short conversation."}],"cta_text":"Chat on WhatsApp","privacy_url":"https://example.com/privacy","contact_email":"hello@example.com"}'

-- ═══ A. the rules are pure and strict ══════════════════════════════════════
select pg_temp.check(crm.landing_content_problems(:'GOOD'::jsonb) = '[]'::jsonb, 'sound content has no problems');
select pg_temp.check(crm.landing_content_problems('[]'::jsonb)::text like '%content_is_not_an_object%', 'a non-object is refused');
select pg_temp.check(crm.landing_content_problems(replace(:'GOOD', 'Websites that bring in enquiries', 'Act now: limited time websites')::jsonb)::text like '%manufactured_urgency%', 'manufactured urgency is a problem');
select pg_temp.check(crm.landing_content_problems(replace(:'GOOD', 'Fast, accessible sites', 'Award-winning sites')::jsonb)::text like '%unsupported_claim%', 'an unsupported claim is a problem');
select pg_temp.check(crm.landing_content_problems(replace(:'GOOD', 'Pages that load quickly', '98% faster pages')::jsonb)::text like '%unverified_statistic%', 'an unsourced statistic is a problem');
select pg_temp.check(crm.landing_content_problems(replace(:'GOOD', '"portfolio_item_id":"00000000-0000-4000-8000-0000000000f1",', '')::jsonb)::text like '%proof_without_a_source%', 'proof with no source is a problem');
select pg_temp.check(crm.landing_content_problems((:'GOOD')::jsonb || '{"testimonials":[{"quote":"Great"}]}'::jsonb)::text like '%testimonials_are_not_supported%', 'testimonials are not supported at all');
select pg_temp.check(crm.landing_content_problems(replace(:'GOOD', 'https://example.com/privacy', 'http://example.com/privacy')::jsonb)::text like '%needs_a_privacy_link%', 'a page needs a privacy link');
select pg_temp.check(crm.landing_content_problems(replace(:'GOOD', 'hello@example.com', 'nobody')::jsonb)::text like '%needs_a_contact_email%', '…and a contact email');
select pg_temp.check(crm.landing_content_problems(replace(:'GOOD', ',{"title":"Built to be found","text":"Clean structure that search engines can read."}', '')::jsonb)::text like '%benefits_count%', 'three to six benefits');

-- ═══ B. a page, a version, a derived hash ═════════════════════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'pg', page_id from crm.create_landing_page(:'ORG', 'Website leads page', 'website-leads', 'Website Development');
select pg_temp.check((select outcome from crm.create_landing_page(:'ORG', 'Another page', 'website-leads')) = 'slug_taken', 'a slug can be used once');
select pg_temp.check((select outcome from crm.create_landing_page(:'ORG', 'Bad slug page', 'Bad Slug!')) = 'invalid', 'a slug must be lowercase words and hyphens');
select pg_temp.check((select outcome from crm.add_landing_version(:'ORG', (select v from fx where k = 'pg'), :'GOOD'::jsonb, 'https://lp.example.com/website-leads')) = 'no_whatsapp_number', 'a page cannot be written before the WhatsApp number is set');
select crm.set_handoff_settings('+14155550100', 14);
insert into fx select 'v1', version_id from crm.add_landing_version(:'ORG', (select v from fx where k = 'pg'), :'GOOD'::jsonb, 'https://lp.example.com/website-leads');
select pg_temp.check((select (state, version, whatsapp_number) = ('DRAFT', 1, '+14155550100') from crm.landing_page_versions where id = (select v from fx where k = 'v1')), 'version 1 is a DRAFT carrying the number in force');
select pg_temp.check((select content_hash = pg_temp.sha(jsonb_build_object('slug', 'website-leads', 'content', :'GOOD'::jsonb, 'whatsapp', '+14155550100', 'url', 'https://lp.example.com/website-leads', 'tracking', '{"capture":["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid"]}'::jsonb)::text) from crm.landing_page_versions where id = (select v from fx where k = 'v1')), 'the hash is derived from slug, content, number, address and tracking');
select pg_temp.check((select outcome from crm.add_landing_version(:'ORG', (select v from fx where k = 'pg'), :'GOOD'::jsonb, 'http://insecure.example.com/x')) = 'invalid', 'a page address must be https');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.create_landing_page(:'ORG', 'Member page', 'member-page')) = 'forbidden', 'a member cannot create a page');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.landing_pages) = 0, 'another organisation sees none of the pages');
select pg_temp.check((select outcome from crm.add_landing_version(:'ORG', (select v from fx where k = 'pg'), :'GOOD'::jsonb, 'https://lp.example.com/x')) = 'forbidden', 'another organisation cannot add a version');
reset role;
do $$
declare v uuid; h text; pg uuid;
begin
  select id into v from crm.landing_page_versions limit 1;
  begin update crm.landing_page_versions set content = '{"x":1}' where id = v; raise exception 'FAILED: content was edited';
  exception when insufficient_privilege then raise notice 'ok  what a page says is frozen'; end;
  begin update crm.landing_page_versions set whatsapp_number = '+14155559999' where id = v; raise exception 'FAILED: the number was edited';
  exception when insufficient_privilege then raise notice 'ok  the WhatsApp number is frozen with the version'; end;
  begin update crm.landing_page_versions set state = 'VERIFIED' where id = v; raise exception 'FAILED: a state moved outside the doors';
  exception when insufficient_privilege then raise notice 'ok  a state moves only through the doors'; end;
  begin delete from crm.landing_page_versions where id = v; raise exception 'FAILED: a version was deleted';
  exception when insufficient_privilege then raise notice 'ok  a version is never deleted'; end;
  begin update crm.landing_pages set slug = 'other' where id = (select page_id from crm.landing_page_versions where id = v); raise exception 'FAILED: an address changed';
  exception when insufficient_privilege then raise notice 'ok  a page''s address is fixed'; end;
  insert into crm.landing_pages (organization_id, name, slug) values ('00000000-0000-4000-8000-000000000001', 'Forgery page', 'forgery-page') returning id into pg;
  insert into crm.landing_page_versions (organization_id, page_id, version, content, whatsapp_number, public_url, content_hash, created_by_type)
    values ('00000000-0000-4000-8000-000000000001', pg, 1, '{"a":1}', '+14155550100', 'https://lp.example.com/f', repeat('f', 64), 'human') returning content_hash into h;
  if h = repeat('f', 64) then raise exception 'FAILED: a forged hash was kept'; end if;
  raise notice 'ok  a hash supplied by the caller is replaced by the derived one';
end $$;

-- ═══ C. checks: a failure, a real source, then a pass ═════════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.submit_landing_version(:'ORG', (select v from fx where k = 'v1'))) = 'not_checked', 'an unchecked version cannot be submitted');
insert into fx select 'bad', version_id from crm.add_landing_version(:'ORG', (select v from fx where k = 'pg'), replace(:'GOOD', '0000000000f1', '0000000000ee')::jsonb, 'https://lp.example.com/website-leads');
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'v1')) = 'SUPERSEDED', 'a newer draft supersedes the older unlaunched one');
select pg_temp.check((select problems::text like '%proof_is_not_a_portfolio_item%' from crm.check_landing_version(:'ORG', (select v from fx where k = 'bad'))), 'proof pointing at nothing the agency owns fails the check');
insert into fx select 'bad2', version_id from crm.add_landing_version(:'ORG', (select v from fx where k = 'pg'), replace(:'GOOD', '0000000000f1', '0000000000f2')::jsonb, 'https://lp.example.com/website-leads');
select pg_temp.check((select problems::text like '%proof_is_not_a_portfolio_item%' from crm.check_landing_version(:'ORG', (select v from fx where k = 'bad2'))), 'proof pointing at an INACTIVE portfolio item fails too');
insert into fx select 'v2', version_id from crm.add_landing_version(:'ORG', (select v from fx where k = 'pg'), :'GOOD'::jsonb, 'https://lp.example.com/website-leads');
select pg_temp.check((select outcome from crm.check_landing_version(:'ORG', (select v from fx where k = 'v2'))) = 'checked', 'sound content with real proof passes');
insert into fx select 'req2', approval_request_id from crm.submit_landing_version(:'ORG', (select v from fx where k = 'v2'));
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'v2')) = 'ADMIN_REVIEW', 'a submitted page waits for approval');
select pg_temp.check((select summary from approvals.approval_requests where id = (select v from fx where k = 'req2')) like '%Deploy landing page%Website leads page%lp.example.com%', 'the approval card names the page, the address and the headline');

-- ═══ D. deploy is governed and once; deployed is not verified ═════════════
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome || ':' || reason from crm.begin_landing_deploy(:'ORG', (select v from fx where k = 'v2'))) = 'blocked:integration_not_active', 'with no Hostinger connection the deploy is refused');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'host', integration_id from crm.register_integration('hostinger', 'production', null, true);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select crm.store_connector_secret((select v from fx where k = 'host'), 'api_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'host', null);
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'host'), true);
select crm.record_integration_check(:'ORG', (select v from fx where k = 'host'), true, 'host-1', '{"DEPLOY_PAGE":"AUTOMATED"}', null, null);
select pg_temp.check((select outcome || ':' || reason from crm.begin_landing_deploy(:'ORG', (select v from fx where k = 'v2'))) = 'not_covered:state_pending', 'a connected host still needs the approval');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from approvals.decide_approval((select v from fx where k = 'req2'), 'approved', 'on message')) = 'decided', 'an admin approves version 2');
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'x2', execution_id from crm.begin_landing_deploy(:'ORG', (select v from fx where k = 'v2'));
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'v2')) = 'DEPLOYING', 'the approved page is DEPLOYING');
select pg_temp.check((select outcome from crm.begin_landing_deploy(:'ORG', (select v from fx where k = 'v2'))) = 'in_progress', 'a second worker finds the deploy in progress');
select pg_temp.check((select outcome from crm.record_landing_deploy(:'ORG', (select v from fx where k = 'v2'), (select v from fx where k = 'x2'), 'executed', 'https://lp.example.com/website-leads', null)) = 'needs_evidence', 'a deploy without the hash of what was sent is not recorded as done');
select pg_temp.check((select outcome from crm.record_landing_deploy(:'ORG', (select v from fx where k = 'v2'), (select v from fx where k = 'x2'), 'executed', 'https://elsewhere.example.com/page', pg_temp.sha('html'))) = 'url_differs_from_approved', 'the host may serve only the address that was approved');
select pg_temp.check((select outcome from crm.record_landing_deploy(:'ORG', (select v from fx where k = 'v2'), (select v from fx where k = 'x2'), 'executed', 'https://lp.example.com/website-leads', pg_temp.sha('html'))) = 'recorded', 'the deploy is recorded with the hash of the HTML sent');
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'v2')) = 'DEPLOYED', 'the version is DEPLOYED - not VERIFIED');
select pg_temp.check((select (status, live_version_id) = ('active', (select v from fx where k = 'v2')) from crm.landing_pages where id = (select v from fx where k = 'pg')), 'the page is active on that version');
select pg_temp.check((select outcome from crm.begin_landing_deploy(:'ORG', (select v from fx where k = 'v2'))) = 'already_deployed', 'a deployed version is never deployed again');

-- ═══ E. verification records what was FOUND ═══════════════════════════════
select pg_temp.check((select outcome from crm.record_landing_verification(:'ORG', (select v from fx where k = 'v2'), '{"reachable":true}')) = 'invalid', 'a verification missing a check is refused');
select pg_temp.check((select outcome from crm.record_landing_verification(:'ORG', (select v from fx where k = 'v2'), '{"reachable":true,"carries_approved_version":false,"links_to_approved_whatsapp":true,"captures_tracking":true}')) = 'failed', 'a page that does not carry the approved version fails verification');
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'v2')) = 'VERIFY_FAILED', '…and is VERIFY_FAILED');
select pg_temp.check((select outcome from crm.record_landing_verification(:'ORG', (select v from fx where k = 'v2'), '{"reachable":true,"carries_approved_version":true,"links_to_approved_whatsapp":false,"captures_tracking":true}')) = 'failed', 'a page that links to a different number fails verification');
select pg_temp.check((select outcome from crm.record_landing_verification(:'ORG', (select v from fx where k = 'v2'), '{"reachable":true,"carries_approved_version":true,"links_to_approved_whatsapp":true,"captures_tracking":true}')) = 'verified', 'a page that carries everything is VERIFIED');
select pg_temp.check((select count(*) from crm.landing_verifications) = 3, 'every check is kept (append-only)');
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'v2')) = 'VERIFIED', 'the version is VERIFIED');

-- ═══ F. a Google ad needs a VERIFIED page, read at execution time ═════════
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_settings('google_ads', true, 20, 500000000, 50);
\set GPLAN_HEAD '{"destination":{"type":"landing_page","landing_page_version_id":"'
\set GPLAN_TAIL '"},"ad_groups":[{"name":"g","keywords":[{"text":"web design agency","match":"phrase"},{"text":"website developer","match":"exact"},{"text":"ecommerce website","match":"phrase"}]}],"negative_keywords":["free","jobs"],"ads":[{"headlines":["Fast Websites","Built For Retail","Talk To Us"],"descriptions":["We design and build fast storefronts.","Message us on WhatsApp to plan a launch."]}]}'
insert into fx select 'gc', campaign_id from crm.create_ad_campaign(:'ORG', 'google_ads', 'Website search');
insert into fx select 'gbad', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'gc'), (:'GPLAN_HEAD' || '00000000-0000-4000-8000-0000000000aa' || :'GPLAN_TAIL')::jsonb, 100000, null, null, null);
select pg_temp.check((select problems::text like '%landing_page_not_verified%' from crm.check_ad_version(:'ORG', (select v from fx where k = 'gbad'))), 'a Google plan naming a page that does not exist fails its check');
insert into fx select 'gv', version_id from crm.add_ad_version(:'ORG', (select v from fx where k = 'gc'), (:'GPLAN_HEAD' || (select v from fx where k = 'v2')::text || :'GPLAN_TAIL')::jsonb, 100000, null, null, null);
select pg_temp.check((select outcome from crm.check_ad_version(:'ORG', (select v from fx where k = 'gv'))) = 'checked', 'a Google plan naming a VERIFIED page passes its check');
insert into fx select 'greq', approval_request_id from crm.submit_ad_version(:'ORG', (select v from fx where k = 'gv'));
select approvals.decide_approval((select v from fx where k = 'greq'), 'approved', 'ok');
reset role;
set local role service_role;
select pg_temp.as_service();
-- the page stops being verified between approval and launch
select crm.record_landing_verification(:'ORG', (select v from fx where k = 'v2'), '{"reachable":false,"carries_approved_version":true,"links_to_approved_whatsapp":true,"captures_tracking":true}');
select pg_temp.check((select outcome || ':' || reason from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'gv'))) = 'blocked:landing_page_not_verified', 'an approved Google launch is refused when its page is no longer verified (re-read at execution)');
select crm.record_landing_verification(:'ORG', (select v from fx where k = 'v2'), '{"reachable":true,"carries_approved_version":true,"links_to_approved_whatsapp":true,"captures_tracking":true}');
select pg_temp.check((select outcome || ':' || reason from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'gv'))) = 'blocked:integration_not_active', 'with the page verified the launch still needs the Google connection');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'ggl', integration_id from crm.register_integration('google_ads', 'production', null, true);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select crm.store_connector_secret((select v from fx where k = 'ggl'), 'refresh_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'g', null);
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'ggl'), true);
select crm.record_integration_check(:'ORG', (select v from fx where k = 'ggl'), true, 'cust-1', '{"CREATE_CAMPAIGN":"AUTOMATED"}', null, null);
insert into fx select 'gx', execution_id from crm.begin_ad_apply(:'ORG', (select v from fx where k = 'gv'));
select pg_temp.check((select outcome from crm.record_ad_apply(:'ORG', (select v from fx where k = 'gv'), (select v from fx where k = 'gx'), 'executed', '777001', '[]')) = 'recorded', 'with a verified page and a connection the Google launch goes ahead');

-- ═══ G. a visit that becomes a WhatsApp message stays attributable ════════
insert into fx select 'ct1', contact_id from crm.resolve_identity(:'ORG', '{"name":"Visitor One","email":"v1@lpco.example"}', 'whatsapp');
insert into fx select 'ct2', contact_id from crm.resolve_identity(:'ORG', '{"name":"Visitor Two","email":"v2@lpco.example"}', 'whatsapp');
insert into fx select 'ct3', contact_id from crm.resolve_identity(:'ORG', '{"name":"Visitor Three","email":"v3@lpco.example"}', 'whatsapp');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000c1', :'ORG', (select v from fx where k = 'ct1'), 'Visitor one', 'whatsapp', 'wa:lp1', 'new'),
  ('00000000-0000-4000-8000-0000000000c2', :'ORG', (select v from fx where k = 'ct2'), 'Visitor two', 'whatsapp', 'wa:lp2', 'new'),
  ('00000000-0000-4000-8000-0000000000c3', :'ORG', (select v from fx where k = 'ct3'), 'Visitor three', 'whatsapp', 'wa:lp3', 'new');
set local role service_role;
select pg_temp.as_service();
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000c3', 'email', null, 'outreach_sent', '{}', '{}', 'em:c3', now() - interval '6 days');
select pg_temp.check((select outcome from crm.record_landing_arrival(:'ORG', '00000000-0000-4000-8000-0000000000c1', 'Hi, I want a website')) = 'no_tag', 'a message with no tag records nothing');
select pg_temp.check((select outcome from crm.record_landing_arrival(:'ORG', '00000000-0000-4000-8000-0000000000c1', 'Hi LP-deadbeef-777001 I want a website')) = 'unknown_landing', 'a tag for no page of ours is refused');
select pg_temp.check((select outcome from crm.record_landing_arrival(:'ORG', gen_random_uuid(), 'Hi LP-' || left((select v from fx where k = 'v2')::text, 8) || '-777001')) = 'unknown_lead', 'an unknown lead is refused');
select pg_temp.check((select outcome from crm.record_landing_arrival(:'ORG', '00000000-0000-4000-8000-0000000000c1', 'Hi LP-' || left((select v from fx where k = 'v2')::text, 8) || '-777001 I want a website')) = 'recorded', 'a tagged first message records the visit');
select crm.record_landing_arrival(:'ORG', '00000000-0000-4000-8000-0000000000c1', 'Hi LP-' || left((select v from fx where k = 'v2')::text, 8) || '-777001 again');
select pg_temp.check((select count(*) from crm.lead_touchpoints where lead_id = '00000000-0000-4000-8000-0000000000c1' and external_ref = 'landing:00000000-0000-4000-8000-0000000000c1') = 1, 'a repeated message adds no second visit');
select pg_temp.check((select channel from crm.lead_touchpoints where lead_id = '00000000-0000-4000-8000-0000000000c1' order by occurred_at, recorded_at limit 1) = 'google_ads', 'the visit is the FIRST touch (it came before the WhatsApp message it produced)');
select crm.record_landing_arrival(:'ORG', '00000000-0000-4000-8000-0000000000c3', 'Hi LP-' || left((select v from fx where k = 'v2')::text, 8) || '-777001');
select pg_temp.check((select channel from crm.lead_touchpoints where lead_id = '00000000-0000-4000-8000-0000000000c3' order by occurred_at, recorded_at limit 1) = 'email', 'a lead who was emailed first keeps email as first touch');
select pg_temp.check((select (leads) = 1 from crm.ad_outcomes((select v from fx where k = 'gc'))), 'the Google campaign is credited with the lead whose first touch was its landing page - and not the one emailed first');
insert into fx select 'ctb', contact_id from crm.resolve_identity(:'ORGB', '{"name":"Other Visitor","email":"ov@other.example"}', 'whatsapp');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000c9', :'ORGB', (select v from fx where k = 'ctb'), 'Other org visitor', 'whatsapp', 'wa:lpb', 'new');
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.record_landing_arrival(:'ORGB', '00000000-0000-4000-8000-0000000000c9', 'LP-' || left((select v from fx where k = 'v2')::text, 8) || '-777001')) = 'unknown_landing', 'another organisation''s message cannot claim OUR landing page');
select pg_temp.check((select outcome from crm.record_landing_arrival(:'ORG', '00000000-0000-4000-8000-0000000000c9', 'LP-' || left((select v from fx where k = 'v2')::text, 8) || '-777001')) = 'unknown_lead', 'and we cannot tag another organisation''s lead');
select pg_temp.check((select outcome from crm.record_landing_arrival(:'ORG', '00000000-0000-4000-8000-0000000000c2', 'LP-' || left((select v from fx where k = 'v2')::text, 8) || '-999999')) = 'recorded', 'a tag naming an ad campaign we do not run is still just a touch');
select pg_temp.check((select (leads) = 1 from crm.ad_outcomes((select v from fx where k = 'gc'))), '…and credits no campaign of ours');

-- ═══ H. retire, tenancy and privileges ════════════════════════════════════
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.retire_landing_page(:'ORG', (select v from fx where k = 'pg'), 'x')) = 'needs_reason', 'retiring needs a reason');
select pg_temp.check((select outcome from crm.retire_landing_page(:'ORG', (select v from fx where k = 'pg'), 'campaign ended')) = 'retired', 'an admin retires a page');
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'v2')) = 'RETIRED', '…and its live version is RETIRED');
select pg_temp.check((select outcome from crm.add_landing_version(:'ORG', (select v from fx where k = 'pg'), :'GOOD'::jsonb, 'https://lp.example.com/website-leads')) = 'page_retired', 'a retired page takes no new version');
reset role;
do $$
declare t text; n integer; f text;
begin
  foreach t in array array['landing_pages', 'landing_page_versions', 'landing_deployments', 'landing_verifications'] loop
    select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'crm' and c.relname = t and c.relrowsecurity and c.relforcerowsecurity;
    if n <> 1 then raise exception 'FAILED: % is not under forced RLS', t; end if;
    if has_table_privilege('anon', 'crm.' || t, 'select') or has_table_privilege('authenticated', 'crm.' || t, 'insert') or has_table_privilege('authenticated', 'crm.' || t, 'update') or has_table_privilege('authenticated', 'crm.' || t, 'delete') then
      raise exception 'FAILED: % grants more than internal reads', t;
    end if;
    select count(*) into n from pg_trigger g where g.tgrelid = ('crm.' || t)::regclass and g.tgname like 'freeze_org_%';
    if n <> 1 then raise exception 'FAILED: % does not freeze its organisation', t; end if;
  end loop;
  raise notice 'ok  all four landing tables: forced RLS, no anon read, no authenticated write, organisation frozen';
  foreach f in array array['begin_landing_deploy(uuid,uuid,uuid)', 'record_landing_deploy(uuid,uuid,uuid,text,text,text,jsonb)', 'record_landing_verification(uuid,uuid,jsonb)', 'sync_landing_approvals(integer)', 'record_landing_arrival(uuid,uuid,text,timestamp with time zone)'] loop
    if has_function_privilege('authenticated', 'crm.' || f, 'execute') or has_function_privilege('anon', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is callable by a signed-in user', f; end if;
    if not has_function_privilege('service_role', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is not callable by the engine', f; end if;
  end loop;
  raise notice 'ok  the machine doors are the engine''s alone';
  begin update crm.landing_deployments set deployed_url = 'https://x.example.com'; raise exception 'FAILED: a deployment was edited';
  exception when insufficient_privilege then raise notice 'ok  a deployment record is history'; end;
  begin update crm.landing_verifications set passed = true; raise exception 'FAILED: a verification was edited';
  exception when insufficient_privilege then raise notice 'ok  a verification is history'; end;
end $$;

select 'ALL CHECKS PASSED' as result;
rollback;
