-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, follow-up — what an acquisition agent can and cannot do through the doors it is given (ADM-112, ADM-113).
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-agents.sql
-- Rolls back. Any failed check raises. Runs as the SERVICE ROLE with by_type 'agent', which is how the job runner calls them.
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

\set AORG '00000000-0000-4000-8000-0000000000e1'
\set AOWN '00000000-0000-4000-8000-00000000e101'
insert into auth.users (id, email) values (:'AOWN', 'lg-agents-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'AOWN', 'lg-agents-owner@example.test', 'Agents Owner') on conflict do nothing;
insert into core.organizations (id, name, slug, settings) values (:'AORG', 'Agents Agency', 'agents-agency', '{"whatsapp_phone_number_id":"pnid-agents"}');
create temp table fx (k text primary key, v uuid);
grant all on fx to public;

-- a person sets the organisation up: the same Admin steps that exist for it
select pg_temp.as_user(:'AOWN', :'AORG', 'owner');
set local role authenticated;
select crm.ensure_acquisition_defaults();
select crm.set_handoff_settings('+14155550100', 14);
select crm.ensure_b2b_defaults();
select crm.ensure_acquisition_approval_policies();
select crm.set_channel_settings('meta_ads', true, 5, 500000000, 50);
select crm.set_channel_settings('social', true, 5, null, 50);
select crm.set_channel_settings('b2b', true, 5, null, 50);
select crm.set_channel_settings('google_ads', true, 5, 500000000, 50);

-- the agent's results door is closed to every request role
select pg_temp.check((select count(*) from pg_proc p where p.proname = 'agent_results' and has_function_privilege('authenticated', p.oid, 'execute')) = 0, 'a signed-in session cannot open the agent results door');
select pg_temp.check((select count(*) from pg_proc p where p.proname = 'agent_results' and has_function_privilege('anon', p.oid, 'execute')) = 0, '…nor anon');
reset role;

set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select count(*) from crm.agent_results(:'AORG', 30)) = 5, 'the service role reads five channels for one organisation');
select pg_temp.check((select coalesce(sum(leads + qualified + won + spend_minor), 0) from crm.agent_results('00000000-0000-4000-8000-0000000000ff', 30)) = 0, '…and only zeros for an organisation that does not exist');

-- social: draft -> review -> submit, all stamped agent
insert into fx select 'ci', item_id from crm.create_content_item(:'AORG', 'linkedin', 'authority', 'text', null, null, 'Planning a storefront', 'agent');
insert into fx select 'cv', version_id from crm.add_content_version(:'AORG', (select v from fx where k = 'ci'), 'Here is how a small retailer can plan the first ninety days of a new storefront, week by week.', null, '{}', '{}', '{}', 'agent');
select pg_temp.check((select v from fx where k = 'cv') is not null, 'an agent drafts a post');
select pg_temp.check((select created_by_type from crm.content_versions where id = (select v from fx where k = 'cv')) = 'agent', '…stamped as the agent''s');
select pg_temp.check((select outcome is not null from crm.review_content_version(:'AORG', (select v from fx where k = 'cv'))), 'an agent runs the review');
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'cv')) in ('DRAFT', 'AI_REVIEWED'), '…and the review never approves');
select outcome from crm.submit_for_admin_review(:'AORG', (select v from fx where k = 'cv'));

-- ads: draft -> check -> submit
insert into fx select 'ac', campaign_id from crm.create_ad_campaign(:'AORG', 'meta_ads', 'Agent campaign');
insert into fx select 'av', version_id from crm.add_ad_version(:'AORG', (select v from fx where k = 'ac'), '{"destination":{"type":"whatsapp"},"adsets":[{"name":"a","audience":{"locations":["IN"],"age_min":25},"placements":["feed"]}],"creatives":[{"headline":"Fast sites","primary_text":"We build fast, accessible websites for growing retailers. Message us.","cta":"WHATSAPP_MESSAGE"}]}'::jsonb, 100000, null, null, null, 'agent');
select pg_temp.check((select created_by_type from crm.ad_campaign_versions where id = (select v from fx where k = 'av')) = 'agent', 'an agent drafts a campaign version, stamped agent');
select pg_temp.check((select outcome from crm.check_ad_version(:'AORG', (select v from fx where k = 'av')) limit 1) is not null, 'an agent checks it');
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'av')) = 'CHECKED', '…and it is only checked: nothing approved or launched it');
select outcome from crm.submit_ad_version(:'AORG', (select v from fx where k = 'av'));

-- landing page
insert into fx select 'pg', page_id from crm.create_landing_page(:'AORG', 'Agent page', 'agent-page');
insert into fx select 'lv', version_id from crm.add_landing_version(:'AORG', (select v from fx where k = 'pg'), '{"headline":"Agent headline here","benefits":[{"title":"One","text":"A benefit text."},{"title":"Two","text":"Another benefit."},{"title":"Three","text":"A third benefit."}],"cta_text":"Chat now","privacy_url":"https://example.com/p","contact_email":"a@example.com"}'::jsonb, 'https://lp.example.com/agent', 'agent');
select pg_temp.check((select created_by_type from crm.landing_page_versions where id = (select v from fx where k = 'lv')) = 'agent', 'an agent drafts a landing page version, stamped agent');
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'lv')) = 'DRAFT', '…and it is only a draft: nothing approved or deployed it');
select crm.check_landing_version(:'AORG', (select v from fx where k = 'lv'));
select outcome from crm.submit_landing_version(:'AORG', (select v from fx where k = 'lv'));

-- b2b: a proposal an agent drafts has no price, and the door refuses an agent that tries to set one
insert into fx select 'bo', opportunity_id from crm.record_b2b_opportunity(:'AORG', 'upwork', 'agent-1', null, 'Website Development for a shop', 'A request for a new storefront.', 100, 200, 'USD', null, null);
select pg_temp.check((select outcome from crm.add_b2b_proposal_version(:'AORG', (select v from fx where k = 'bo'), repeat('We would build this storefront with you. ', 3), 150000, 21, 0, '{}', 'agent')) = 'invalid', 'a price from an agent is refused by the door (ADM-22)');
select pg_temp.check((select outcome from crm.add_b2b_proposal_version(:'AORG', (select v from fx where k = 'bo'), repeat('We would build this storefront with you. ', 3), null, 21, 0, '{}', 'agent')) is distinct from 'invalid', 'the same draft without a price is accepted or refused on its merits, not as a price');
select pg_temp.check((select count(*) from crm.b2b_proposal_versions where organization_id = :'AORG' and price_minor is not null) = 0, 'no proposal an agent made carries a price');

-- submitting asks a person: it never approves. After every submit the version waits, and no state here is an approved one.
select pg_temp.check((select state from crm.content_versions where id = (select v from fx where k = 'cv')) = 'ADMIN_REVIEW', 'a submitted post waits for a person (ADMIN_REVIEW), not approved');
select pg_temp.check((select state from crm.ad_campaign_versions where id = (select v from fx where k = 'av')) = 'ADMIN_REVIEW', 'a submitted campaign waits for a person, not approved or applied');
select pg_temp.check((select state from crm.landing_page_versions where id = (select v from fx where k = 'lv')) = 'ADMIN_REVIEW', 'a submitted page waits for a person, not approved or deployed');
select pg_temp.check((select count(*) from approvals.approval_requests r where r.organization_id = :'AORG' and r.state = 'pending') = 3, 'each submit opened one pending approval request for a person');
select pg_temp.check((select count(*) from approvals.approval_requests r where r.organization_id = :'AORG' and r.decided_by is not null) = 0, '…and none has been decided');
select pg_temp.check((select count(*) from fx where k in ('cv', 'av', 'lv')) = 3, 'all three agent drafts exist');
reset role;

-- asking an agent for work: a door, admin-only, one organisation, off until the owner turns the agent on, and once per identical task
\set AMEMBER '00000000-0000-4000-8000-00000000e102'
\set AOTHER '00000000-0000-4000-8000-00000000e103'
insert into auth.users (id, email) values (:'AMEMBER', 'lg-agents-member@example.test'), (:'AOTHER', 'lg-agents-other@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'AMEMBER', 'lg-agents-member@example.test', 'Agents Member'), (:'AOTHER', 'lg-agents-other@example.test', 'Agents Other') on conflict do nothing;
select pg_temp.as_user(:'AOWN', :'AORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from crm.request_agent_task(:'AORG', 'social_media', 'Draft three posts about planning a storefront.')) = 'agent_disabled', 'an agent that is installed disabled is not asked: the owner turns it on first');
reset role;
update ai.agents set enabled = true, disabled_reason = null where key in ('social_media', 'email_outreach');
select pg_temp.as_user(:'AMEMBER', :'AORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from crm.request_agent_task(:'AORG', 'social_media', 'Draft three posts about planning a storefront.')) = 'forbidden', 'a member cannot ask an agent for work');
select pg_temp.as_user(:'AOTHER', '00000000-0000-4000-8000-0000000000e2', 'owner');
select pg_temp.check((select outcome from crm.request_agent_task(:'AORG', 'social_media', 'Draft three posts about planning a storefront.')) = 'forbidden', 'an admin of another organisation cannot ask for work in this one');
select pg_temp.as_user(:'AOWN', :'AORG', 'owner');
select pg_temp.check((select outcome from crm.request_agent_task(:'AORG', 'finance', 'Draft three posts about planning a storefront.')) = 'unknown_agent', 'only the four acquisition agents can be asked');
select pg_temp.check((select outcome from crm.request_agent_task(:'AORG', 'social_media', 'hi')) = 'invalid', 'a task of a few characters is refused');
select pg_temp.check((select outcome from crm.request_agent_task(:'AORG', 'social_media', 'Draft three posts about planning a storefront.')) = 'queued', 'an admin queues a task for an enabled agent');
select pg_temp.check((select outcome from crm.request_agent_task(:'AORG', 'social_media', 'Draft three posts about planning a storefront.')) = 'already_queued', 'the same task is queued once, not twice');
select pg_temp.check((select count(*) from core.jobs where organization_id = :'AORG' and kind = 'social.assist' and status = 'queued') = 1, '…and exactly one job exists');
select crm.set_channel_pause('social', true, 'testing the stop');
select pg_temp.check((select outcome from crm.request_agent_task(:'AORG', 'social_media', 'A different task about carousels.')) = 'stopped', 'a stopped channel is not given work');
select pg_temp.check((select outcome from crm.request_agent_task(:'AORG', 'email_outreach', 'Score the newest prospects.')) = 'queued', '…and another channel still is');
reset role;

select 'ALL CHECKS PASSED' as result;
rollback;
