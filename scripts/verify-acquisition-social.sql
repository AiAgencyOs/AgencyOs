-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 7 — Social content is approved as exactly what is
-- published, and it is published once. The spec's mandatory social test (§79),
-- driven through the REAL approval engine and the governed execution door.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-social.sql
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

-- ── setup: approval policies, an ACTIVE LinkedIn connection (through the real registry doors) ──
set local role authenticated;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.ensure_acquisition_defaults();
select crm.ensure_acquisition_approval_policies();
insert into fx select 'li', integration_id from crm.register_integration('linkedin', 'production', null, true);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select crm.store_connector_secret((select v from fx where k = 'li'), 'access_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'link', null);
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.record_social_audit(:'ORG', 'linkedin', 'adapter', (select v from fx where k = 'li'), '{}', '{}', 'agent')) = 'integration_not_verified', 'an audit claiming an adapter read the account needs a VERIFIED connection');
select crm.record_integration_check(:'ORG', (select v from fx where k = 'li'), true, 'urn:li:org:1', '{"PUBLISH_CONTENT":"AUTOMATED","READ_PROFILE":"AUTOMATED"}', null, null);

-- ═══ A. audits and strategies ═════════════════════════════════════════════
select pg_temp.check((select outcome from crm.record_social_audit(:'ORG', 'linkedin', 'adapter', (select v from fx where k = 'li'), '{"followers":1200}', '{"gaps":["no case studies"]}', 'agent')) = 'recorded', 'with a verified connection an adapter audit is recorded');
insert into fx select 'audit', audit_id from crm.record_social_audit(:'ORG', 'linkedin', 'assisted', null, '{"note":"entered by the owner"}', '{"strengths":["clear positioning"]}', 'human');
select pg_temp.check((select source from crm.social_audits where id = (select v from fx where k = 'audit')) = 'assisted', 'a person-entered audit says so honestly (assisted)');
select pg_temp.check((select outcome from crm.record_social_audit(:'ORG', 'tiktok', 'assisted', null, '{}', '{}')) = 'invalid', 'an unknown platform is refused');
select pg_temp.check((select (outcome, version) = ('created', 1) from crm.create_social_strategy(:'ORG', 'linkedin', 3, '{"pillars":["authority","portfolio"],"cadence":"3 a week"}', 'start with proof', (select v from fx where k = 'audit'))), 'a 3-month LinkedIn strategy is created as version 1');
insert into fx select 's1', strategy_id from crm.create_social_strategy(:'ORG', 'instagram', 6, '{"pillars":["education"]}', null, null);
select pg_temp.check((select outcome from crm.create_social_strategy(:'ORG', 'linkedin', 4, '{"x":1}', null, null)) = 'invalid', 'a 4-month horizon is refused (3, 6 or 9)');
select pg_temp.check((select outcome from crm.create_social_strategy(:'ORG', 'linkedin', 3, '{}', null, null)) = 'invalid', 'an empty strategy is refused');
select pg_temp.check((select outcome from crm.create_social_strategy(:'ORG', 'instagram', 3, '{"x":1}', null, (select v from fx where k = 'audit'))) = 'unknown_audit', 'evidence must be an audit of THE SAME platform');
insert into fx select 'li3_v2', strategy_id from crm.create_social_strategy(:'ORG', 'linkedin', 3, '{"pillars":["authority"],"cadence":"2 a week"}', 'revised after the first month', null);
select pg_temp.check((select version from crm.social_strategies where id = (select v from fx where k = 'li3_v2')) = 2, 'a revision is the NEXT version (never an overwrite)');
reset role;
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from crm.activate_social_strategy((select v from fx where k = 'li3_v2'))) = 'forbidden', 'a member cannot activate a strategy');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.activate_social_strategy((select v from fx where k = 'li3_v2'))) = 'activated', 'an admin activates version 2');
select pg_temp.check((select outcome from crm.activate_social_strategy((select v from fx where k = 'li3_v2'))) = 'not_a_draft', '…once');
reset role;
do $$
declare s uuid;
begin
  select id into s from crm.social_strategies limit 1;
  begin update crm.social_strategies set content = '{"x":2}' where id = s; raise exception 'FAILED: a strategy was edited';
  exception when insufficient_privilege then raise notice 'ok  a strategy''s content is frozen'; end;
  begin delete from crm.social_strategies where id = s; raise exception 'FAILED: a strategy was deleted';
  exception when insufficient_privilege then raise notice 'ok  a strategy is never deleted'; end;
end $$;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'li3_v3', strategy_id from crm.create_social_strategy(:'ORG', 'linkedin', 3, '{"pillars":["authority","leads"]}', 'v3', null);
select pg_temp.check((select outcome from crm.activate_social_strategy((select v from fx where k = 'li3_v3'))) = 'activated', 'version 3 is activated');
select pg_temp.check((select status from crm.social_strategies where id = (select v from fx where k = 'li3_v2')) = 'superseded', '…which SUPERSEDES version 2');
select pg_temp.check((select count(*) from crm.social_strategies where platform = 'linkedin' and horizon_months = 3 and status = 'active') = 1, 'exactly one strategy is active per platform and horizon');

-- ═══ B. references, assets, items ═════════════════════════════════════════
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'ref1', reference_id from crm.add_content_reference(:'ORG', 'copy_example', 'https://example.com/post', 'We help growing retailers turn slow websites into fast storefronts that customers love to use every single day of the year', 'good hook', '{}', 'human');
select pg_temp.check((select outcome from crm.add_content_reference(:'ORG', 'post_link', null, null, null)) = 'invalid', 'a reference must hold something');
select pg_temp.check((select outcome from crm.add_content_reference(:'ORG', 'post_link', 'ftp://x', null, null)) = 'invalid', '…and a link must be http(s)');
insert into fx select 'asset1', asset_id from crm.add_content_asset(:'ORG', 'image', 'storage/images/a1.png', 'designed', '{"w":1200,"h":627}', pg_temp.sha('image-one'));
insert into fx select 'asset2', asset_id from crm.add_content_asset(:'ORG', 'image', 'storage/images/a2.png', 'designed', '{"w":1200,"h":627}', pg_temp.sha('image-two'));
select pg_temp.check((select outcome from crm.add_content_asset(:'ORG', 'image', 'storage/images/a3.png', 'designed', '{}', 'not-a-hash')) = 'invalid', 'an asset needs a real content hash');
select pg_temp.check((select outcome from crm.create_content_item(:'ORG', 'linkedin', 'virality', 'text', null, null, 'A post')) = 'invalid', 'an unknown objective is refused');
select pg_temp.check((select outcome from crm.create_content_item(:'ORG', 'linkedin', 'authority', 'text', gen_random_uuid(), null, 'A post')) = 'unknown_strategy', 'an unknown strategy is refused');
insert into fx select 'item1', item_id from crm.create_content_item(:'ORG', 'linkedin', 'lead_generation', 'text', null, 'Website Development', 'Website launch offer post');
select pg_temp.check((select outcome from crm.add_content_version(:'ORG', gen_random_uuid(), 'x', null, '{}', '{}', '{}')) = 'unknown_item', 'a version of an unknown item is refused');
select pg_temp.check((select outcome from crm.add_content_version(:'ORG', (select v from fx where k = 'item1'), repeat('a', 3001), null, '{}', '{}', '{}')) = 'invalid', 'a LinkedIn post over 3,000 characters is refused');
select pg_temp.check((select outcome from crm.add_content_version(:'ORG', (select v from fx where k = 'item1'), 'x', null, '{}', array[gen_random_uuid()], '{}')) = 'unknown_asset_or_reference', 'an unknown asset is refused');

-- ═══ C. versions are frozen and their hash cannot be forged ═══════════════
insert into fx select 'v1', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item1'),
  'Website Development for growing retailers: we design and build fast, accessible storefronts. See how we approach a launch and talk to us about yours.',
  'Message us to plan your website', array['#webdevelopment', '#retail'], '{}', '{}', 'human');
select pg_temp.check((select version from crm.content_versions where id = (select v from fx where k = 'v1')) = 1, 'the first version is 1');
select pg_temp.check((select content_hash from crm.content_versions where id = (select v from fx where k = 'v1')) = pg_temp.sha(jsonb_build_object(
  'platform', 'linkedin', 'objective', 'lead_generation', 'format', 'text',
  'body', 'Website Development for growing retailers: we design and build fast, accessible storefronts. See how we approach a launch and talk to us about yours.',
  'cta', 'Message us to plan your website', 'hashtags', to_jsonb(array['#webdevelopment', '#retail']), 'assets', '[]'::jsonb)::text), 'the hash is the SHA-256 of the canonical content, platform, objective and format');
reset role;
-- a throwaway item, so the forged row cannot disturb the version numbering of the scenarios below (a version can never be deleted)
insert into crm.content_items (id, organization_id, platform, objective, format, title, created_by_type)
  values ('00000000-0000-4000-8000-0000000000f9', :'ORG', 'linkedin', 'authority', 'text', 'Forge test', 'human');
insert into crm.content_versions (organization_id, item_id, version, body, content_hash, created_by_type)
  values (:'ORG', '00000000-0000-4000-8000-0000000000f9', 1, 'forged hash attempt for this item', repeat('a', 64), 'human');
select pg_temp.check((select content_hash from crm.content_versions where item_id = '00000000-0000-4000-8000-0000000000f9') <> repeat('a', 64), 'a hash supplied by the caller is DISCARDED: the trigger derives it');
select pg_temp.check((select content_hash from crm.content_versions where item_id = '00000000-0000-4000-8000-0000000000f9') = crm.content_version_hash('00000000-0000-4000-8000-0000000000f9', 'forged hash attempt for this item', null, '{}', '{}'), '…and the stored one is the true one');
do $$
declare v uuid;
begin
  select id into v from crm.content_versions order by created_at limit 1;
  begin update crm.content_versions set body = 'edited after the fact' where id = v; raise exception 'FAILED: a version''s body was edited';
  exception when insufficient_privilege then raise notice 'ok  a version''s words cannot be edited'; end;
  begin update crm.content_versions set content_hash = repeat('b', 64) where id = v; raise exception 'FAILED: a hash was edited';
  exception when insufficient_privilege then raise notice 'ok  its hash cannot be edited'; end;
  begin update crm.content_versions set cta = 'new cta' where id = v; raise exception 'FAILED: a cta was edited';
  exception when insufficient_privilege then raise notice 'ok  nor its call to action'; end;
  begin update crm.content_versions set state = 'APPROVED' where id = v; raise exception 'FAILED: a state was set directly';
  exception when insufficient_privilege or check_violation then raise notice 'ok  a state cannot be set directly'; end;
  begin update crm.content_versions set state = 'SCHEDULED' where id = v; raise exception 'FAILED: a version was scheduled directly';
  exception when insufficient_privilege then raise notice 'ok  a version cannot be SCHEDULED by a direct write'; end;
  begin delete from crm.content_versions where id = v; raise exception 'FAILED: a version was deleted';
  exception when insufficient_privilege then raise notice 'ok  a version is never deleted'; end;
end $$;

-- ═══ D. the AI review: it can fail a draft; it can never approve one ═════
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select (outcome, passed) = ('reviewed', true) from crm.review_content_version(:'ORG', (select v from fx where k = 'v1'))), 'a clean draft passes the automated review');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'v1')) = 'AI_REVIEWED', '…and becomes AI_REVIEWED');
select pg_temp.check(crm.content_status((select v from fx where k = 'v1')) = 'AI_REVIEW_PASSED', 'its label is AI_REVIEW_PASSED - not approved');
select pg_temp.check((select outcome from crm.review_content_version(:'ORG', (select v from fx where k = 'v1'))) = 'wrong_state', 'a version is reviewed once');
select pg_temp.check((select count(*) from crm.content_versions where state in ('ADMIN_REVIEW', 'SCHEDULED', 'PUBLISHED')) = 0, 'AI REVIEW PASSED is not ADMIN_APPROVED: nothing moved past review');

insert into fx select 'bad_item', item_id from crm.create_content_item(:'ORG', 'linkedin', 'lead_generation', 'image', null, 'Website Development', 'Bad drafts');
select pg_temp.check((select blocking @> '["missing_cta", "missing_asset"]'::jsonb from crm.review_content_version(:'ORG', (select version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'bad_item'), 'Website Development made simple for any business that wants to grow online this year.', null, '{}', '{}', '{}')))), 'a lead-generation image post with no call to action and no image fails');
select pg_temp.check((select blocking::text like '%manufactured_urgency:act now%' from crm.review_content_version(:'ORG', (select version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'bad_item'), 'Act now: limited time website offer for every retailer who reads this post today.', 'Book now', '{}', array[(select v from fx where k = 'asset1')], '{}')))), 'manufactured urgency fails the review');
select pg_temp.check((select blocking::text like '%unsupported_claim:award-winning%' from crm.review_content_version(:'ORG', (select version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'bad_item'), 'We are an award-winning website agency trusted by retailers all over the country.', 'Book now', '{}', array[(select v from fx where k = 'asset1')], '{}')))), 'an unsupported superlative fails');
select pg_temp.check((select blocking @> '["unverified_statistic"]'::jsonb from crm.review_content_version(:'ORG', (select version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'bad_item'), 'Our redesigns lift conversion by 300% for retailers who work with the team here.', 'Book now', '{}', array[(select v from fx where k = 'asset1')], '{}')))), 'an unverified statistic fails');
select pg_temp.check((select blocking::text like '%copies_reference%' from crm.review_content_version(:'ORG', (select version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'bad_item'), 'Here is our take: we help growing retailers turn slow websites into fast storefronts that customers love to use, honestly.', 'Book now', '{}', array[(select v from fx where k = 'asset1')], array[(select v from fx where k = 'ref1')])))), 'REFERENCES INSPIRE, THEY ARE NOT COPY: ten consecutive words of one fail the review');
select pg_temp.check((select passed from crm.review_content_version(:'ORG', (select version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'bad_item'), 'Retail sites that load quickly keep shoppers browsing, and our team builds them from the first sketch to launch day.', 'Book a call', '{}', array[(select v from fx where k = 'asset1')], array[(select v from fx where k = 'ref1')])))), 'an original post that cites the same reference PASSES');
select pg_temp.check((select (warnings @> '["does_not_mention_the_target_service"]'::jsonb and warnings @> '["no_hashtags"]'::jsonb) from crm.content_versions cv, lateral (select review -> 'warnings' as warnings) w where cv.id = (select current_version_id from crm.content_items where id = (select v from fx where k = 'bad_item'))), 'warnings are recorded, and are not failures');
select pg_temp.check((select (review ->> 'reviewed_hash') = content_hash from crm.content_versions where id = (select current_version_id from crm.content_items where id = (select v from fx where k = 'bad_item'))), 'the review records the exact hash it reviewed');
insert into fx select 'car_item', item_id from crm.create_content_item(:'ORG', 'instagram', 'engagement', 'carousel', null, null, 'Carousel');
select pg_temp.check((select blocking @> '["carousel_needs_two_or_more_slides"]'::jsonb from crm.review_content_version(:'ORG', (select version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'car_item'), 'Five things to check before you launch a new retail website this quarter.', null, array['#web'], array[(select v from fx where k = 'asset1')], '{}')))), 'a carousel needs two or more slides');

-- ═══ E. CASE 1 - nothing publishes without approval ══════════════════════
select pg_temp.check((select outcome from crm.begin_content_publish(:'ORG', (select v from fx where k = 'v1'))) = 'not_scheduled', 'CASE 1 - an AI-reviewed, unapproved version cannot be published');
select pg_temp.check((select outcome from crm.schedule_content(:'ORG', (select v from fx where k = 'v1'), now())) = 'wrong_state', '…nor scheduled');
insert into fx select 'fail_v', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'bad_item'), 'Act now: limited time website offer for every retailer who reads this post today.', 'Book now', '{}', array[(select v from fx where k = 'asset1')], '{}');
select crm.review_content_version(:'ORG', (select v from fx where k = 'fail_v'));
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'fail_v')) = 'AI_REVIEW_FAILED', 'a draft that failed review is AI_REVIEW_FAILED');
select pg_temp.check((select outcome from crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'fail_v'))) = 'not_reviewed', 'a version that FAILED review cannot go to an admin');
select pg_temp.check((select outcome from crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'v1'))) = 'submitted', 'a passing version is submitted for admin review');
insert into fx select 'req1', approval_request_id from crm.content_versions where id = (select v from fx where k = 'v1');
select pg_temp.check(crm.content_status((select v from fx where k = 'v1')) = 'ADMIN_REVIEW', 'its label is ADMIN_REVIEW');
select pg_temp.check((select reason from crm.schedule_content(:'ORG', (select v from fx where k = 'v1'), now())) = 'state_pending', '…and scheduling it before an admin has decided is refused');
select pg_temp.check((select outcome from crm.begin_content_publish(:'ORG', (select v from fx where k = 'v1'))) = 'not_scheduled', '…as is publishing it');
select pg_temp.check((select summary from approvals.approval_requests where id = (select v from fx where k = 'req1')) like '%linkedin%lead_generation%Website Development for growing retailers%', 'the approval card carries the platform, objective and the actual words');

-- ═══ F. CASE 2 - an approved version, then a change: V1's approval cannot publish V2 ═══
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from approvals.decide_approval((select v from fx where k = 'req1'), 'approved', 'on brand')) = 'decided', 'an admin approves VERSION 1');
select pg_temp.check(crm.content_status((select v from fx where k = 'v1')) = 'APPROVED', 'its label is now APPROVED - derived from the engine, not stored');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'v1')) = 'ADMIN_REVIEW', '…while the stored state is still ADMIN_REVIEW (nothing can drift)');
reset role;
set local role service_role;
select pg_temp.as_service();
-- the author changes ONE word
insert into fx select 'v2', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item1'),
  'Website Development for growing retailers: we design and build fast, accessible storefronts. See how we approach a launch and talk with us about yours.',
  'Message us to plan your website', array['#webdevelopment', '#retail'], '{}', '{}', 'human');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'v1')) = 'SUPERSEDED', 'CASE 2 - the approved version 1 is SUPERSEDED the moment version 2 exists');
select pg_temp.check((select content_hash from crm.content_versions where id = (select v from fx where k = 'v1')) <> (select content_hash from crm.content_versions where id = (select v from fx where k = 'v2')), 'a one-word change is a DIFFERENT hash');
select pg_temp.check((select outcome from crm.schedule_content(:'ORG', (select v from fx where k = 'v1'), now())) = 'wrong_state', 'version 1 can no longer be scheduled');
select pg_temp.check((select outcome from crm.begin_content_publish(:'ORG', (select v from fx where k = 'v1'))) = 'not_scheduled', '…or published');
select pg_temp.check((select outcome from crm.schedule_content(:'ORG', (select v from fx where k = 'v2'), now())) = 'wrong_state', 'version 2 starts at DRAFT: it has been neither reviewed nor approved');
select crm.review_content_version(:'ORG', (select v from fx where k = 'v2'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'v2'));
select pg_temp.check((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'v2')) <> (select v from fx where k = 'req1'), 'version 2 has its OWN approval request');
select pg_temp.check((select reason from crm.schedule_content(:'ORG', (select v from fx where k = 'v2'), now())) = 'state_pending', 'version 2 cannot be scheduled on version 1''s approval');
select pg_temp.check((select (outcome, reason) = ('not_covered', 'artifact_mismatch') from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'v2'), (select content_hash from crm.content_versions where id = (select v from fx where k = 'v2')), 'social_publish', 'social')), 'even asked at the lowest layer, version 1''s approval refuses version 2');
select pg_temp.check((select (outcome, reason) = ('not_covered', 'content_changed') from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'v1'), (select content_hash from crm.content_versions where id = (select v from fx where k = 'v2')), 'social_publish', 'social')), '…and version 1''s id with version 2''s text is a content mismatch');

-- ═══ G. CASE 3 - approve V2 exactly; it publishes; CASE 4 - a replay does not repost ═══
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'req2', approval_request_id from crm.content_versions where id = (select v from fx where k = 'v2');
select pg_temp.check((select outcome from approvals.decide_approval((select v from fx where k = 'req2'), 'approved', 'fine')) = 'decided', 'an admin approves VERSION 2');
select pg_temp.check(crm.content_status((select v from fx where k = 'v2')) = 'APPROVED', 'it is APPROVED');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.schedule_content(:'ORG', (select v from fx where k = 'v2'), now())) = 'forbidden', 'a member cannot schedule even an approved version');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.schedule_content(:'ORG', (select v from fx where k = 'v2'), now() - interval '1 day')) = 'invalid_time', 'a time in the past is refused');
select pg_temp.check((select outcome from crm.schedule_content(:'ORG', (select v from fx where k = 'v2'), now())) = 'scheduled', 'CASE 3 - an admin schedules the approved version');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check(crm.content_status((select v from fx where k = 'v2')) = 'SCHEDULED', '…its label is SCHEDULED');
insert into fx select 'exec2', execution_id from crm.begin_content_publish(:'ORG', (select v from fx where k = 'v2'));
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'v2')) = 'PUBLISHING', 'the governed door lets it proceed: PUBLISHING');
select pg_temp.check((select outcome from crm.begin_content_publish(:'ORG', (select v from fx where k = 'v2'))) = 'in_progress', 'a duplicate worker meanwhile sees IN PROGRESS');
select pg_temp.check((select outcome from crm.add_content_version(:'ORG', (select v from fx where k = 'item1'), 'a new idea while we are posting the old one', null, '{}', '{}', '{}')) = 'publishing_in_progress', 'a new version cannot be made while one is mid-publication');
select pg_temp.check((select outcome from crm.record_publish(:'ORG', (select v from fx where k = 'v2'), (select v from fx where k = 'exec2'), 'executed', '', null)) = 'needs_reference', 'a publication needs the provider''s reference');
select pg_temp.check((select outcome from crm.record_publish(:'ORG', (select v from fx where k = 'v2'), (select v from fx where k = 'exec2'), 'executed', 'urn:li:share:7001', 'https://www.linkedin.com/feed/update/urn:li:share:7001')) = 'recorded', 'the provider accepted it: recorded');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'v2')) = 'PUBLISHED', 'version 2 is PUBLISHED');
select pg_temp.check((select count(*) from crm.social_publications where version_id = (select v from fx where k = 'v2')) = 1, 'exactly one publication row exists');
select pg_temp.check((select amount from crm.acquisition_usage where ref = 'publish:' || (select v from fx where k = 'v2')::text) = 1, 'the post counted against the channel''s daily limit');
select pg_temp.check((select outcome from crm.begin_content_publish(:'ORG', (select v from fx where k = 'v2'))) = 'already_published', 'CASE 4 - a REPLAYED publish job does not post again');
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req2'), 'social_content', (select v from fx where k = 'v2'), (select content_hash from crm.content_versions where id = (select v from fx where k = 'v2')), 'social_publish', 'social')) = 'already_executed', '…and the governed door agrees');
select pg_temp.check((select outcome from crm.record_publish(:'ORG', (select v from fx where k = 'v2'), (select v from fx where k = 'exec2'), 'executed', 'urn:li:share:7001', null)) = 'wrong_state', 'recording the same publication twice is refused');
select pg_temp.check((select outcome from crm.verify_governed_execution(:'ORG', (select v from fx where k = 'exec2'), '{"found":true}')) = 'verified', 'the post is confirmed to exist: VERIFIED, a separate step from published');
select pg_temp.check((select count(*) from crm.social_publications) = 1, 'one post in total');
reset role;
do $$
begin
  begin
    insert into crm.social_publications (organization_id, version_id, execution_id, platform, external_ref)
      select organization_id, version_id, execution_id, platform, 'urn:li:share:duplicate' from crm.social_publications limit 1;
    raise exception 'FAILED: a second publication row was stored for one version';
  exception when unique_violation then raise notice 'ok  the TABLE itself refuses a second publication of one version (a second line behind the governed door)'; end;
end $$;
set local role service_role;
select pg_temp.as_service();

-- ═══ H. other ways it must not publish ════════════════════════════════════
-- a duplicate of something posted recently
insert into fx select 'dup_item', item_id from crm.create_content_item(:'ORG', 'linkedin', 'authority', 'text', null, null, 'Same again');
select pg_temp.check((select blocking @> '["duplicate_of_recent_post"]'::jsonb from crm.review_content_version(:'ORG', (select version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'dup_item'),
  'Website Development for growing retailers: we design and build fast, accessible storefronts. See how we approach a launch and talk with us about yours.', null, array['#x'], '{}', '{}')))), 'reposting what was published in the last 30 days fails the review');

-- a fresh approved + scheduled version for the remaining scenarios
create temp table mk (k text primary key, item uuid, ver uuid, req uuid);
grant all on mk to public;
-- pause at execution time, integration, due time, retry, reconciliation, expiry, rejection
insert into fx select 'item2', item_id from crm.create_content_item(:'ORG', 'linkedin', 'education', 'text', null, null, 'Pause test');
insert into fx select 'p1', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item2'), 'Three questions to ask before you commission a new retail website this year.', null, array['#web'], '{}', '{}');
select crm.review_content_version(:'ORG', (select v from fx where k = 'p1'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'p1'));
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'p1')), 'approved', 'ok');
select crm.schedule_content(:'ORG', (select v from fx where k = 'p1'), now());
select crm.set_channel_pause('social', true, 'stop posting');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select (outcome, reason) = ('blocked', 'channel_paused') from crm.begin_content_publish(:'ORG', (select v from fx where k = 'p1'))), 'an APPROVED, SCHEDULED post is BLOCKED when the channel is paused at execution time');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'p1')) = 'SCHEDULED', '…and stays SCHEDULED (nothing was spent)');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_pause('social', false, null);
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select core.set_kill_switch('acquisition_paused', true, 'global test');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select reason from crm.begin_content_publish(:'ORG', (select v from fx where k = 'p1'))) = 'acquisition_paused', 'the GLOBAL stop blocks it too');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select core.set_kill_switch('acquisition_paused', false, 'released');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.set_integration_state((select v from fx where k = 'li'), 'DISABLED', 'account review');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select (outcome, reason) = ('blocked', 'integration_not_active') from crm.begin_content_publish(:'ORG', (select v from fx where k = 'p1'))), 'with the LinkedIn connection disabled, nothing is published');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_integration_state((select v from fx where k = 'li'), 'CONFIGURED', 're-enabled');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select (outcome, reason) = ('blocked', 'integration_not_active') from crm.begin_content_publish(:'ORG', (select v from fx where k = 'p1'))), 'a re-enabled connection is NOT trusted until it is re-tested');
select crm.record_integration_check(:'ORG', (select v from fx where k = 'li'), true, 'urn:li:org:1', null, null, null);

-- a post scheduled for later is not due
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'item3', item_id from crm.create_content_item(:'ORG', 'linkedin', 'portfolio_proof', 'text', null, null, 'Later');
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'l1', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item3'), 'A look at how we structured a retail catalogue so shoppers find things in two clicks.', null, array['#ux'], '{}', '{}');
select crm.review_content_version(:'ORG', (select v from fx where k = 'l1'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'l1'));
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'l1')), 'approved', 'ok');
select crm.schedule_content(:'ORG', (select v from fx where k = 'l1'), now() + interval '2 days');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.begin_content_publish(:'ORG', (select v from fx where k = 'l1'))) = 'not_yet_due', 'a post scheduled for the future is not yet due');

-- failure -> governed retry -> exhaustion
insert into fx select 'e1', execution_id from crm.begin_content_publish(:'ORG', (select v from fx where k = 'p1'));
select pg_temp.check((select outcome from crm.record_publish(:'ORG', (select v from fx where k = 'p1'), (select v from fx where k = 'e1'), 'failed', null, null)) = 'recorded', 'a failed attempt is recorded');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'p1')) = 'SCHEDULED', '…and the post goes back to SCHEDULED');
select pg_temp.check((select (outcome, reason) = ('proceed', 'retry_after_failure') from crm.begin_content_publish(:'ORG', (select v from fx where k = 'p1'))), 'the governed door allows a retry');
select crm.record_publish(:'ORG', (select v from fx where k = 'p1'), (select v from fx where k = 'e1'), 'failed', null, null);
select crm.begin_content_publish(:'ORG', (select v from fx where k = 'p1'));
select crm.record_publish(:'ORG', (select v from fx where k = 'p1'), (select v from fx where k = 'e1'), 'failed', null, null);
select pg_temp.check((select outcome from crm.begin_content_publish(:'ORG', (select v from fx where k = 'p1'))) = 'exhausted', 'after three failed attempts it is EXHAUSTED, not looped');

-- an uncertain outcome is reconciled, never re-posted
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'item4', item_id from crm.create_content_item(:'ORG', 'facebook', 'reach', 'text', null, null, 'Uncertain');
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'u1', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item4'), 'Here is how a small retailer can plan the first ninety days of a new storefront.', null, '{}', '{}', '{}');
select crm.review_content_version(:'ORG', (select v from fx where k = 'u1'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'u1'));
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'u1')), 'approved', 'ok');
select crm.schedule_content(:'ORG', (select v from fx where k = 'u1'), now());
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'e_u', execution_id from crm.begin_content_publish(:'ORG', (select v from fx where k = 'u1'));
select crm.record_publish(:'ORG', (select v from fx where k = 'u1'), (select v from fx where k = 'e_u'), 'unknown', null, null, '{"timeout":true}');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'u1')) = 'PUBLISHING', 'a timeout after a possible post leaves it PUBLISHING (not failed, not retried)');
select pg_temp.check((select outcome from crm.begin_content_publish(:'ORG', (select v from fx where k = 'u1'))) = 'needs_reconciliation', 'a second attempt is NOT allowed: it needs reconciliation with the provider');
select pg_temp.check((select outcome from crm.record_publish(:'ORG', (select v from fx where k = 'u1'), (select v from fx where k = 'e_u'), 'executed', 'urn:li:share:7002', null, '{"found_at_provider":true}')) = 'recorded', 'reconciling (the post IS there) settles it as published');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'u1')) = 'PUBLISHED', '…without posting a second time');
select pg_temp.check((select count(*) from crm.social_publications where version_id = (select v from fx where k = 'u1')) = 1, '…exactly one post');

-- an approval that has run out
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'item5', item_id from crm.create_content_item(:'ORG', 'linkedin', 'education', 'text', null, null, 'Expiry');
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'x1', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item5'), 'What a good brief for a retail website looks like, in six short paragraphs.', null, '{}', '{}', '{}');
select crm.review_content_version(:'ORG', (select v from fx where k = 'x1'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'x1'));
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'x1')), 'approved', 'ok');
reset role;
alter table crm.approval_bindings disable trigger approval_bindings_immutable;
update crm.approval_bindings set valid_until = now() - interval '1 minute' where approval_request_id = (select approval_request_id from crm.content_versions where id = (select v from fx where k = 'x1'));
alter table crm.approval_bindings enable trigger approval_bindings_immutable;
select pg_temp.check(crm.content_status((select v from fx where k = 'x1')) = 'APPROVAL_LAPSED', 'an approval past its validity window reads APPROVAL_LAPSED, not APPROVED');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select reason from crm.schedule_content(:'ORG', (select v from fx where k = 'x1'), now())) = 'expired', '…and cannot be scheduled');

-- a rejection
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'item6', item_id from crm.create_content_item(:'ORG', 'linkedin', 'authority', 'text', null, null, 'Reject');
insert into fx select 'r1', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item6'), 'Why a fast website is really a sales conversation in disguise, in plain words.', null, '{}', '{}', '{}');
select crm.review_content_version(:'ORG', (select v from fx where k = 'r1'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'r1'));
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select approval_request_id from crm.content_versions where id = (select v from fx where k = 'r1')), 'rejected', 'not on brand');
select pg_temp.check(crm.content_status((select v from fx where k = 'r1')) = 'REJECTED', 'a rejected approval reads REJECTED');
select pg_temp.check((select outcome from crm.schedule_content(:'ORG', (select v from fx where k = 'r1'), now())) in ('not_approved', 'wrong_state'), '…and cannot be scheduled');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check(crm.sync_content_approvals(100) >= 1, 'the sweep moves a rejected version out of the review queue');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'r1')) = 'REJECTED', '…its stored state follows the engine');

-- cancel withdraws the pending approval
insert into fx select 'item7', item_id from crm.create_content_item(:'ORG', 'linkedin', 'authority', 'text', null, null, 'Cancel');
insert into fx select 'c1', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item7'), 'The quiet cost of a slow checkout, and what to measure before you fix it.', null, '{}', '{}', '{}');
select crm.review_content_version(:'ORG', (select v from fx where k = 'c1'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 'c1'));
select pg_temp.check((select outcome from crm.cancel_content_version(:'ORG', (select v from fx where k = 'c1'), '')) = 'needs_reason', 'cancelling needs a reason');
select pg_temp.check((select outcome from crm.cancel_content_version(:'ORG', (select v from fx where k = 'c1'), 'no longer relevant')) = 'cancelled', 'a version can be cancelled');
select pg_temp.check((select state from approvals.approval_requests where id = (select approval_request_id from crm.content_versions where id = (select v from fx where k = 'c1'))) = 'cancelled', '…which WITHDRAWS its pending approval from the queue');
select pg_temp.check((select outcome from crm.cancel_content_version(:'ORG', (select v from fx where k = 'c1'), 'again')) = 'not_live', '…once');
select pg_temp.check((select outcome from crm.cancel_content_version(:'ORG', (select v from fx where k = 'u1'), 'too late')) = 'not_live', 'a published version cannot be cancelled');

-- a superseded draft withdraws its pending approval too
insert into fx select 'item8', item_id from crm.create_content_item(:'ORG', 'linkedin', 'authority', 'text', null, null, 'Supersede');
insert into fx select 's_v1', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item8'), 'Four signs your product pages are quietly losing you sales every week.', null, '{}', '{}', '{}');
select crm.review_content_version(:'ORG', (select v from fx where k = 's_v1'));
select crm.submit_for_admin_review(:'ORG', (select v from fx where k = 's_v1'));
insert into fx select 's_v2', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item8'), 'Four signs your product pages are quietly losing you sales every single week.', null, '{}', '{}', '{}');
select pg_temp.check((select state from approvals.approval_requests where id = (select approval_request_id from crm.content_versions where id = (select v from fx where k = 's_v1'))) = 'cancelled', 'superseding a version WITHDRAWS the approval still waiting on it');

-- an asset change is a new version (the asset hash is in the version hash)
insert into fx select 'item9', item_id from crm.create_content_item(:'ORG', 'instagram', 'reach', 'image', null, null, 'Assets');
insert into fx select 'a_v1', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item9'), 'A tidy storefront starts with a tidy brief for the team building it.', null, array['#web'], array[(select v from fx where k = 'asset1')], '{}');
insert into fx select 'a_v2', version_id from crm.add_content_version(:'ORG', (select v from fx where k = 'item9'), 'A tidy storefront starts with a tidy brief for the team building it.', null, array['#web'], array[(select v from fx where k = 'asset2')], '{}');
select pg_temp.check((select (select content_hash from crm.content_versions where id = (select v from fx where k = 'a_v1')) <> (select content_hash from crm.content_versions where id = (select v from fx where k = 'a_v2'))), 'the SAME words with a DIFFERENT image are a different artifact: the image needs its own approval');

-- ═══ I. metrics and performance ═══════════════════════════════════════════
select pg_temp.check((select outcome from crm.record_social_metrics(:'ORG', (select id from crm.social_publications where version_id = (select v from fx where k = 'v2')), 1000, 800, 60, 25, 10)) = 'recorded', 'metrics are recorded for a publication');
select pg_temp.check((select outcome from crm.record_social_metrics(:'ORG', (select id from crm.social_publications where version_id = (select v from fx where k = 'v2')), 1500, 1100, 90, 40, 15)) = 'recorded', '…again later (a time series, never an overwrite)');
select pg_temp.check((select outcome from crm.record_social_metrics(:'ORG', (select id from crm.social_publications where version_id = (select v from fx where k = 'v2')), -1, 0, 0, 0, 0)) = 'invalid', 'a negative count is refused');
select pg_temp.check((select outcome from crm.record_social_metrics(:'ORG', gen_random_uuid(), 1, 1, 1, 1, 1)) = 'not_found', 'metrics for an unknown publication are refused');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select (published, impressions) = (1, 1500) from crm.social_performance() where platform = 'linkedin' and objective = 'lead_generation'), 'performance by what the content was FOR uses the LATEST metrics per post');
select pg_temp.check((select sum(published) from crm.social_performance()) = 2, 'two posts are published in total (v2 and the reconciled one)');

-- ═══ J. who may call what; tenancy; privileges ═════════════════════════════
do $$
begin
  begin perform * from crm.begin_content_publish(gen_random_uuid(), gen_random_uuid()); raise exception 'FAILED: a session called begin_content_publish';
  exception when insufficient_privilege then raise notice 'ok  publishing is the engine''s door: a session cannot call it'; end;
  begin perform * from crm.record_publish(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'executed', 'x', null); raise exception 'FAILED: a session called record_publish';
  exception when insufficient_privilege then raise notice 'ok  nor can it record a publication'; end;
  begin perform * from crm.record_social_metrics(gen_random_uuid(), gen_random_uuid(), 1, 1, 1, 1, 1); raise exception 'FAILED: a session recorded metrics';
  exception when insufficient_privilege then raise notice 'ok  nor metrics'; end;
  begin perform crm.sync_content_approvals(1); raise exception 'FAILED: a session ran the sweep';
  exception when insufficient_privilege then raise notice 'ok  nor the sweep'; end;
  begin perform * from crm._withdraw_version(gen_random_uuid(), 'CANCELLED'); raise exception 'FAILED: a session withdrew a version';
  exception when insufficient_privilege then raise notice 'ok  the internal withdraw is not callable'; end;
end $$;
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.create_content_item(:'ORG', 'linkedin', 'authority', 'text', null, null, 'Member draft')) = 'created', 'a member can start a draft');
select pg_temp.check((select outcome from crm.cancel_content_version(:'ORG', (select v from fx where k = 'a_v1'), 'member cancelling')) = 'forbidden', '…but cannot cancel or schedule');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.content_items) = 0, 'organisation B sees none of A''s content items');
select pg_temp.check((select count(*) from crm.content_versions) = 0, '…versions');
select pg_temp.check((select count(*) from crm.social_publications) = 0, '…publications');
select pg_temp.check((select count(*) from crm.social_strategies) = 0, '…strategies');
select pg_temp.check((select count(*) from crm.social_audits) = 0, '…audits');
select pg_temp.check((select count(*) from crm.content_assets) = 0 and (select count(*) from crm.content_references) = 0, '…assets and references');
select pg_temp.check((select outcome from crm.create_content_item(:'ORG', 'linkedin', 'authority', 'text', null, null, 'Cross tenant')) = 'forbidden', 'B cannot create content in A');
select pg_temp.check((select outcome from crm.add_content_version(:'ORG', (select v from fx where k = 'item1'), 'cross tenant body text here', null, '{}', '{}', '{}')) = 'forbidden', '…nor a version');
select pg_temp.check(crm.content_status((select v from fx where k = 'v2')) is null, '…nor read its status');
reset role;
select pg_temp.check(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'crm' and c.relname in ('social_audits', 'social_strategies', 'content_references', 'content_assets', 'content_items', 'content_versions', 'social_publications', 'social_metrics')
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert')
          or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete'))
), 'no social table is readable by anon or writable by authenticated');

select pg_temp.check((select count(*) from audit.audit_log where action = 'content.version_created') >= 10, 'every version is audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('content.submitted_for_approval', 'content.scheduled', 'content.cancelled')) >= 6, 'submission, scheduling and cancellation are audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('content.publish_executed', 'content.publish_failed', 'content.publish_unknown')) >= 6, 'every publish outcome is audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('social.strategy_created', 'social.strategy_activated', 'social.audit_recorded')) >= 5, 'strategies and audits are audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('email.adopt_failed', 'identity.key_sync_failed', 'identity.touch_failed', 'subtask.carry_failed')) = 0, 'no bookkeeping trigger failed silently');

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;
rollback;
