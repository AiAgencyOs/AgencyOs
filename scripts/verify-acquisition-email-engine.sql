-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 6 — the Email engine's decisions. Driven through the
-- REAL send chokepoint (crm.claim_outreach_sends) and the REAL inbound-email
-- function (crm.ingest_inbound_email), as the real request roles.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-email-engine.sql
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

-- ═══ setup: ICP, services, the model, prospects ═══════════════════════════
set local role authenticated;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.ensure_acquisition_defaults();
select pg_temp.check((select outcome from crm.save_icp('{"industries":["retail","logistics"],"geographies":["IN","AE"],"exclusions":["gambling","blocked co"],"min_qualification_score":60}', 'v1')) = 'saved', 'setup: the ICP names industries, geographies, exclusions and a threshold');

select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.save_qualification_model('{"need_clarity":30}', 'x')) = 'forbidden', 'a member cannot change the qualification weights');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.save_qualification_model('{"vibes":30}', null)) = 'invalid', 'an unknown factor is refused');
select pg_temp.check((select outcome from crm.save_qualification_model('{"need_clarity":-5}', null)) = 'invalid', 'a negative weight is refused');
select pg_temp.check((select outcome from crm.save_qualification_model('{"need_clarity":0}', null)) = 'invalid', 'weights that sum to zero are refused');
select pg_temp.check((select outcome from crm.save_qualification_model('{}', null)) = 'invalid', 'an empty model is refused');
select pg_temp.check((select outcome from crm.save_qualification_model('{"need_clarity":10,"service_fit":10}', 'first')) = 'saved', 'the Admin saves model v1 (no code change)');
select pg_temp.check((select (outcome, version) = ('saved', 2) from crm.save_qualification_model('{"need_clarity":30,"service_fit":30,"budget_fit":20,"engagement":20}', 'second')) , 'a change is the NEXT version');

select (select inserted from crm.add_outreach_prospects('[
  {"email":"asha@shopco.example","fullName":"Asha","company":"ShopCo","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"ravi@casino.example","fullName":"Ravi","company":"Lucky","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"lee@us-retail.example","fullName":"Lee","company":"US Retail","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"mia@blocked.example.com","fullName":"Mia","company":"Anything","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"tom@bank.example","fullName":"Tom","company":"Big Bank","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"unsub@shopco.example","fullName":"Una","company":"ShopCo","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"low@shopco.example","fullName":"Lola","company":"ShopCo","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"blockedco@shopco.example","fullName":"Bo","company":"Blocked Co","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"}]'));
reset role;
insert into fx select 'asha', id from crm.outreach_prospects where email = 'asha@shopco.example';
insert into fx select 'ravi', id from crm.outreach_prospects where email = 'ravi@casino.example';
insert into fx select 'lee', id from crm.outreach_prospects where email = 'lee@us-retail.example';
insert into fx select 'mia', id from crm.outreach_prospects where email = 'mia@blocked.example.com';
insert into fx select 'tom', id from crm.outreach_prospects where email = 'tom@bank.example';
insert into fx select 'una', id from crm.outreach_prospects where email = 'unsub@shopco.example';
insert into fx select 'lola', id from crm.outreach_prospects where email = 'low@shopco.example';
insert into fx select 'bo', id from crm.outreach_prospects where email = 'blockedco@shopco.example';

-- ═══ A. qualification: arithmetic first, then rules that outrank it ═══════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select (decision, score, disqualifiers = '[]'::jsonb) = ('qualified', 95, true) from crm.qualify_prospect(:'ORG', (select v from fx where k = 'asha'),
  '{"need_clarity":95,"service_fit":95,"budget_fit":95,"engagement":95}', 'clear need, strong fit', '{"industry":"retail","country":"IN","service":"Website Development"}')), 'a strong, in-profile prospect is QUALIFIED at 95');
select pg_temp.check((select (model_version, icp_version, threshold) = (2, 1, 60) from crm.prospect_qualifications where prospect_id = (select v from fx where k = 'asha')), '…recording the model and ICP versions it was decided under');
select pg_temp.check((select reasoning from crm.prospect_qualifications where prospect_id = (select v from fx where k = 'asha')) = 'clear need, strong fit', '…and its reasoning');

select pg_temp.check((select (decision, disqualifiers ? 'icp_exclusion:gambling') = ('disqualified', true) from crm.qualify_prospect(:'ORG', (select v from fx where k = 'ravi'),
  '{"need_clarity":100,"service_fit":100,"budget_fit":100,"engagement":100}', 'perfect on paper', '{"industry":"gambling","country":"IN","service":"Website Development"}')), 'A 100 SCORE DOES NOT OVERRIDE AN EXCLUSION: disqualified anyway');
select pg_temp.check((select score from crm.prospect_qualifications where prospect_id = (select v from fx where k = 'ravi')) = 100, '…and the score is still recorded as 100 (the rule decided, not the arithmetic)');
select pg_temp.check((select (decision, disqualifiers ? 'outside_target_geography') = ('disqualified', true) from crm.qualify_prospect(:'ORG', (select v from fx where k = 'lee'),
  '{"need_clarity":95,"service_fit":95,"budget_fit":95,"engagement":95}', null, '{"industry":"retail","country":"US","service":"Website Development"}')), 'a prospect outside the target geography is disqualified at any score');
select pg_temp.check((select (decision, disqualifiers ? 'outside_target_industry') = ('disqualified', true) from crm.qualify_prospect(:'ORG', (select v from fx where k = 'tom'),
  '{"need_clarity":95,"service_fit":95,"budget_fit":95,"engagement":95}', null, '{"industry":"banking","country":"IN","service":"Website Development"}')), '…and one outside the target industries');
select pg_temp.check((select (decision, disqualifiers ? 'service_not_targeted') = ('disqualified', true) from crm.qualify_prospect(:'ORG', (select v from fx where k = 'tom'),
  '{"need_clarity":95,"service_fit":95,"budget_fit":95,"engagement":95}', null, '{"industry":"retail","country":"IN","service":"SEO"}')), '…and one for a service the agency is NOT targeting right now');
select pg_temp.check((select (decision, missing) = ('needs_more_info', '["engagement"]'::jsonb) from crm.qualify_prospect(:'ORG', (select v from fx where k = 'lola'),
  '{"need_clarity":95,"service_fit":95,"budget_fit":95}', null, '{"industry":"retail","country":"IN","service":"Website Development"}')), 'a missing factor makes it NEEDS_MORE_INFO and names what is missing');
select pg_temp.check((select score from crm.prospect_qualifications where prospect_id = (select v from fx where k = 'lola') order by created_at desc limit 1) = 76, '…and the missing factor LOWERS the score (95 on 80% of the weight = 76) (it counts in the denominator)');
select pg_temp.check((select (decision, disqualifiers ? 'below_threshold') = ('disqualified', true) from crm.qualify_prospect(:'ORG', (select v from fx where k = 'lola'),
  '{"need_clarity":20,"service_fit":20,"budget_fit":20,"engagement":20}', null, '{"industry":"retail","country":"IN","service":"Website Development"}')), 'complete but weak is disqualified as below_threshold');
select pg_temp.check((select (decision, missing @> '["industry","country","service"]'::jsonb) = ('needs_more_info', true) from crm.qualify_prospect(:'ORG', (select v from fx where k = 'lola'),
  '{"need_clarity":95,"service_fit":95,"budget_fit":95,"engagement":95}', null, '{}')), 'when the ICP restricts industry and geography, not knowing them is MISSING information - not a pass');

-- the block list, suppression, do-not-contact
select pg_temp.check((select outcome from crm.block_prospect('domain', 'blocked.example.com', 'competitor')) = 'blocked', 'an admin blocks a domain');
select pg_temp.check((select outcome from crm.block_prospect('domain', 'blocked.example.com', 'again')) = 'already_blocked', '…once');
select pg_temp.check((select outcome from crm.block_prospect('company', 'blocked co', 'bad history')) = 'blocked', '…or a company');
select pg_temp.check((select outcome from crm.block_prospect('domain', 'not a domain', 'x')) = 'invalid', 'a malformed value is refused');
select pg_temp.check((select (decision, disqualifiers ? 'blocked') = ('disqualified', true) from crm.qualify_prospect(:'ORG', (select v from fx where k = 'mia'),
  '{"need_clarity":99,"service_fit":99,"budget_fit":99,"engagement":99}', null, '{"industry":"retail","country":"IN","service":"Website Development"}')), 'a blocked domain is disqualified at 99');
select pg_temp.check((select disqualifiers ? 'blocked' from crm.qualify_prospect(:'ORG', (select v from fx where k = 'bo'),
  '{"need_clarity":99,"service_fit":99,"budget_fit":99,"engagement":99}', null, '{"industry":"retail","country":"IN","service":"Website Development"}')), '…and a blocked company');
select crm.suppress_email('unsub@shopco.example', 'manual', 'asked to stop');
select pg_temp.check((select disqualifiers ? 'suppressed' from crm.qualify_prospect(:'ORG', (select v from fx where k = 'una'),
  '{"need_clarity":99,"service_fit":99,"budget_fit":99,"engagement":99}', null, '{"industry":"retail","country":"IN","service":"Website Development"}')), 'a suppressed address is disqualified: opting out is permanent');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.lift_prospect_block((select id from crm.blocked_prospects where value = 'blocked.example.com'), 'cleared')) = 'not_owner', 'an admin cannot lift a block (the owner decides)');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from crm.lift_prospect_block((select id from crm.blocked_prospects where value = 'blocked.example.com'), '')) = 'needs_reason', 'lifting needs a reason');
select pg_temp.check((select outcome from crm.lift_prospect_block((select id from crm.blocked_prospects where value = 'blocked.example.com'), 'cleared with legal')) = 'lifted', 'the owner lifts it');
select pg_temp.check(not (select disqualifiers ? 'blocked' from crm.qualify_prospect(:'ORG', (select v from fx where k = 'mia'), '{"need_clarity":99,"service_fit":99,"budget_fit":99,"engagement":99}', null, '{"industry":"retail","country":"IN","service":"Website Development"}')), '…and the prospect is no longer blocked');
select pg_temp.check((select count(*) from crm.blocked_prospects where value = 'blocked.example.com') = 1, '…while the block row is kept');

-- a later ICP does not rewrite the past
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.save_icp('{"industries":["retail"],"min_qualification_score":90}', 'tighter');
select pg_temp.check((select threshold from crm.prospect_qualifications where prospect_id = (select v from fx where k = 'asha') order by created_at limit 1) = 60, 'a past decision keeps the threshold it was made under');
insert into fx select 'q_new', qualification_id from crm.qualify_prospect(:'ORG', (select v from fx where k = 'asha'), '{"need_clarity":85,"service_fit":85,"budget_fit":85,"engagement":85}', null, '{"industry":"retail","country":"IN","service":"Website Development"}');
select pg_temp.check((select (icp_version, threshold) = (2, 90) from crm.prospect_qualifications where id = (select v from fx where k = 'q_new')), 'a new decision uses the NEW ICP version');
select crm.save_icp('{"industries":["retail","logistics"],"geographies":["IN","AE"],"exclusions":["gambling","blocked co"],"min_qualification_score":60}', 'restored');

-- invalid input
select pg_temp.check((select outcome from crm.qualify_prospect(:'ORG', (select v from fx where k = 'asha'), '{"need_clarity":101}', null, '{}')) = 'invalid', 'a factor above 100 is refused');
select pg_temp.check((select outcome from crm.qualify_prospect(:'ORG', (select v from fx where k = 'asha'), '{"charisma":50}', null, '{}')) = 'invalid', 'an unknown factor is refused');
select pg_temp.check((select outcome from crm.qualify_prospect(:'ORG', (select v from fx where k = 'asha'), '[]', null, '{}')) = 'invalid', 'a non-object is refused');
select pg_temp.check((select outcome from crm.qualify_prospect(:'ORG', gen_random_uuid(), '{"need_clarity":50}', null, '{}')) = 'unknown_prospect', 'an unknown prospect is refused');
reset role;
do $$
begin
  begin insert into crm.prospect_qualifications (organization_id, prospect_id, model_version, score, factor_scores, decision, threshold, evaluated_by_type, disqualifiers)
          select organization_id, id, 1, 99, '{}', 'qualified', 50, 'human', '["blocked"]' from crm.outreach_prospects limit 1;
    raise exception 'FAILED: a qualified decision with a disqualifier was stored';
  exception when check_violation then raise notice 'ok  "qualified" with a disqualifier is unrepresentable in the table itself'; end;
  begin update crm.prospect_qualifications set score = 1; raise exception 'FAILED: a qualification was edited';
  exception when insufficient_privilege then raise notice 'ok  a qualification is history'; end;
  begin update crm.qualification_models set note = 'x'; raise exception 'FAILED: a model was edited';
  exception when insufficient_privilege then raise notice 'ok  a model version is history'; end;
end $$;

-- ═══ B. a message may only say what the research supports ═════════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.add_prospect_fact(:'ORG', (select v from fx where k = 'asha'), 'ShopCo launched a mobile app in March', 'website', null)) = 'needs_source', 'a researched fact needs a source URL');
select pg_temp.check((select outcome from crm.add_prospect_fact(:'ORG', (select v from fx where k = 'asha'), 'ShopCo launched a mobile app in March', 'website', 'ftp://x')) = 'invalid', 'a source must be http(s)');
insert into fx select 'fact1', fact_id from crm.add_prospect_fact(:'ORG', (select v from fx where k = 'asha'), 'ShopCo launched a mobile app in March', 'website', 'https://shopco.example/news');
select pg_temp.check((select outcome from crm.add_prospect_fact(:'ORG', (select v from fx where k = 'asha'), 'x', 'manual', null)) = 'invalid', 'a fact of one character is refused');
insert into fx select 'fact_ravi', fact_id from crm.add_prospect_fact(:'ORG', (select v from fx where k = 'ravi'), 'Lucky runs an online casino', 'website', 'https://casino.example/about');
select pg_temp.check((select valid from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'Your new app', 'Hi Asha, congratulations on the mobile app you launched in March - we build apps for retailers like ShopCo.',
  jsonb_build_array(jsonb_build_object('text', 'mobile app you launched in March', 'fact_id', (select v from fx where k = 'fact1'))))), 'a message whose claim cites a recorded fact, and says it, is VALID');
select pg_temp.check((select problems from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'Your new app', 'Hi Asha, congratulations on the app you launched in March - we build apps for retailers.',
  jsonb_build_array(jsonb_build_object('text', 'the app you launched in March', 'fact_id', gen_random_uuid())))) ->> 0 like 'unsupported_claim:%', 'a claim citing NO such fact is refused');
select pg_temp.check((select problems from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'Your new app', 'Hi Asha, we build apps for retailers and would love to talk about your plans for this year.',
  jsonb_build_array(jsonb_build_object('text', 'raised a series A', 'fact_id', (select v from fx where k = 'fact1'))))) ->> 0 like 'claim_not_in_message:%', 'a claim that is not actually in the message is refused');
select pg_temp.check((select problems from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'Your new app', 'Hi Asha, we saw that Lucky runs an online casino and think you would benefit from an app.',
  jsonb_build_array(jsonb_build_object('text', 'Lucky runs an online casino', 'fact_id', (select v from fx where k = 'fact_ravi'))))) ->> 0 like 'unsupported_claim:%', 'ANOTHER prospect''s fact cannot be used to personalise this one (no cross-prospect leakage)');
select pg_temp.check((select valid from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'A quick idea', 'Hi Asha, act now - this is a limited time offer and only a few spots remain for new clients this month.', '[]')) = false, 'manufactured urgency is refused');
select pg_temp.check((select problems::text like '%manufactured_urgency:limited time%' from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'A quick idea', 'Hi Asha, act now - this is a limited time offer and only a few spots remain for new clients this month.', '[]')), '…naming the phrase');
select pg_temp.check((select problems::text like '%manufactured_urgency:guaranteed results%' from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'A quick idea', 'Hi Asha, we offer guaranteed results for every website we build for retail clients.', '[]')), 'a guarantee is refused');
select pg_temp.check((select problems::text like '%familiarity_without_a_fact%' from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'A quick idea', 'Hi Asha, I noticed your recent growth and wanted to introduce our website practice to you.', '[]')), 'familiarity ("I noticed your recent...") with no fact behind it is refused');
select pg_temp.check((select valid from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'Hi', 'short', '[]')) = false, 'a message that is too short is refused');
select pg_temp.check((select problems::text like '%claims_must_be_a_list%' from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'A quick idea', 'Hi Asha, we build websites for retailers and would like to share some examples.', '{}')), 'claims must be a list');
select pg_temp.check((select problems from crm.validate_outreach_draft(:'ORG', gen_random_uuid(), 'A quick idea', 'Hi, we build websites for retailers and would like to share some examples.', '[]')) ->> 0 = 'unknown_prospect', 'an unknown prospect is refused');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select outcome from crm.add_prospect_fact(:'ORG', (select v from fx where k = 'asha'), 'a fact about another tenant', 'manual', null)) = 'forbidden', 'another organisation cannot add a fact to this prospect');
select pg_temp.check((select problems ->> 0 from crm.validate_outreach_draft(:'ORG', (select v from fx where k = 'asha'), 'x y z', 'long enough message body to pass the length rule here', '[]')) = 'forbidden', '…nor validate against it');

-- ═══ C. a reply is adopted: one identity, one lead, the email agent as owner ══
-- Real send path: settings, an approved template, a running campaign, the REAL chokepoint, a recorded send.
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select crm.set_outreach_settings('Asha Team', '1 Test Road, Pune 411001', null, 500, 5, true);
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
insert into fx select 'tpl', template_id from crm.create_email_template('Intro', 'en', 'A thought for {{company}}', 'Hello {{first_name}}, we build websites for retailers. - {{sender_name}}');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select crm.approve_email_template((select v from fx where k = 'tpl'));
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.add_outreach_prospects('[
  {"email":"reply@replyco.example","fullName":"Rhea Reply","company":"ReplyCo","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"wa@whatsco.example","fullName":"Walt Whats","company":"WhatsCo","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"won@wonco.example","fullName":"Wanda Won","company":"WonCo","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"},
  {"email":"plain@plainco.example","fullName":"Pete Plain","company":"PlainCo","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"}]');
reset role;
-- Walt is ALREADY a lead through WhatsApp, owned by Sales; Wanda is an existing client (a WON lead).
set local role service_role;
select pg_temp.as_service();
insert into fx select 'walt_contact', contact_id from crm.resolve_identity(:'ORG', '{"name":"Walt Whats","email":"wa@whatsco.example","phone":"+14155550311"}', 'whatsapp');
insert into fx select 'wanda_contact', contact_id from crm.resolve_identity(:'ORG', '{"name":"Wanda Won","email":"won@wonco.example"}', 'whatsapp');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000d7', :'ORG', (select v from fx where k = 'walt_contact'), 'Walt via WhatsApp', 'whatsapp', 'wa:+14155550311', 'qualifying');
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status, qualified_at, converted_at) values
  ('00000000-0000-4000-8000-0000000000d8', :'ORG', (select v from fx where k = 'wanda_contact'), 'Wanda client', 'whatsapp', 'wa:+14155550312', 'converted', now(), now());
set local role service_role;
select pg_temp.as_service();
select crm.transfer_conversation_owner(:'ORG', '00000000-0000-4000-8000-0000000000d7', null, 'sales', 'WhatsApp lead owned by Sales');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'camp', campaign_id from crm.create_email_campaign('Engine test', '{}', jsonb_build_array(jsonb_build_object('templateId', (select v from fx where k = 'tpl'), 'delayDays', 0)));
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from crm.approve_email_campaign((select v from fx where k = 'camp'))) = 'approved', 'a second person approves the campaign');
select crm.set_email_campaign_state((select v from fx where k = 'camp'), 'running', null);
reset role;

-- THE CHOKEPOINT: Walt (owned by Sales on WhatsApp) and Wanda (a WON client) must NOT be emailed; the others are.
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select count(*) from crm.claim_outreach_sends(:'ORG', 1000)) >= 1, 'the real chokepoint reserves sends for the people it may email');
reset role;
select pg_temp.check((select r.status from crm.email_campaign_recipients r join crm.outreach_prospects p on p.id = r.prospect_id where p.email = 'wa@whatsco.example') = 'refused', 'WALT, a lead Sales owns on WhatsApp, is NOT cold-emailed: the recipient is refused');
select pg_temp.check((select r.refusal_reason from crm.email_campaign_recipients r join crm.outreach_prospects p on p.id = r.prospect_id where p.email = 'wa@whatsco.example') = 'prospect_stopped', '…as prospect_stopped');
select pg_temp.check((select r.status from crm.email_campaign_recipients r join crm.outreach_prospects p on p.id = r.prospect_id where p.email = 'won@wonco.example') = 'refused', 'WANDA, an existing client (WON), is NOT cold-emailed either');
select pg_temp.check((select count(*) from crm.email_outreach_sends s where s.email in ('wa@whatsco.example', 'won@wonco.example')) = 0, '…and nothing was reserved for either');
select pg_temp.check((select status from crm.email_outreach_sends where email = 'reply@replyco.example') = 'reserved', 'while Rhea, who is nobody''s lead yet, was reserved');
select pg_temp.check(crm.email_followup_blockers(:'ORG', (select v from fx where k = 'una')) @> array['suppressed'], 'the blocker list names suppression too');
select pg_temp.check((select crm.email_followup_blockers(:'ORG', (select id from crm.outreach_prospects where email = 'wa@whatsco.example'))) @> array['owner_moved'], 'Walt''s blocker is owner_moved (the cross-channel one)');
select pg_temp.check((select crm.email_followup_blockers(:'ORG', (select id from crm.outreach_prospects where email = 'won@wonco.example'))) @> array['lead_closed'], 'Wanda''s is lead_closed');

-- send Rhea's email (the real result door), then she answers (the REAL inbound function)
set local role service_role;
select pg_temp.as_service();
select crm.record_outreach_result((select id from crm.email_outreach_sends where email = 'reply@replyco.example'), 'sent', 'msg-rhea-1', '');
reset role;
-- days pass between the email and the reply (inside one test transaction every now() is equal, which would make the order meaningless)
update crm.email_outreach_sends set sent_at = now() - interval '3 days' where email = 'reply@replyco.example';
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.ingest_inbound_email(:'ORG', 'outreach', 'inbound-msg-rhea-1', 'reply@replyco.example', 'Re: A thought for ReplyCo', 'Hi, yes, this sounds interesting - can we talk?', now(), 'reply')) = 'prospect_replied', 'Rhea replies, through the REAL inbound function');
reset role;
select pg_temp.check((select status from crm.outreach_prospects where email = 'reply@replyco.example') = 'replied', 'the prospect is REPLIED (the sequence stops)');
select pg_temp.check((select lead_id is not null and contact_id is not null from crm.outreach_prospects where email = 'reply@replyco.example'), 'she was ADOPTED: the prospect now carries a contact and a lead');
insert into fx select 'rhea_lead', lead_id from crm.outreach_prospects where email = 'reply@replyco.example';
select pg_temp.check((select (source, status) = ('email', 'new') from crm.leads where id = (select v from fx where k = 'rhea_lead')), 'the lead is an email-sourced new lead');
select pg_temp.check((select count(*) from crm.contacts where organization_id = :'ORG' and lower(email) = 'reply@replyco.example') = 1, 'exactly ONE contact exists for her');
select pg_temp.check((select owner from crm.lead_conversation_owner where lead_id = (select v from fx where k = 'rhea_lead')) = 'email_outreach', 'the EMAIL AGENT owns the conversation');
select pg_temp.check((select first_channel from crm.lead_attribution((select v from fx where k = 'rhea_lead'))) = 'email', 'first touch is email');
select pg_temp.check((select touch_type from crm.lead_touchpoints where lead_id = (select v from fx where k = 'rhea_lead') order by occurred_at, recorded_at limit 1) = 'outreach_sent', '…and the FIRST touch is the first outreach email, not the reply');
select pg_temp.check((select count(*) from crm.lead_touchpoints where lead_id = (select v from fx where k = 'rhea_lead') and touch_type = 'outreach_sent') = 1, 'the send is recorded as a touchpoint once');
select pg_temp.check((select count(*) from crm.lead_touchpoints where lead_id = (select v from fx where k = 'rhea_lead') and touch_type = 'reply_received') = 1, 'and so is the reply');
select pg_temp.check((select count(*) from crm.communication_consent where contact_id = (select contact_id from crm.outreach_prospects where email = 'reply@replyco.example')) = 0, 'adopting her granted NO consent: becoming a lead is not agreeing to be marketed to');
select pg_temp.check((select count(*) from audit.audit_log where action = 'email.prospect_adopted') = 1, 'the adoption is audited');

-- a second reply changes nothing
set local role service_role;
select pg_temp.as_service();
select crm.ingest_inbound_email(:'ORG', 'outreach', 'inbound-msg-rhea-2', 'reply@replyco.example', 'Re: Re: A thought', 'Following up on my earlier message, are you there?', now(), 'reply');
reset role;
select pg_temp.check((select count(*) from crm.leads where contact_id = (select contact_id from crm.outreach_prospects where email = 'reply@replyco.example')) = 1, 'a SECOND reply creates no second lead');
select pg_temp.check((select count(*) from crm.lead_touchpoints where lead_id = (select v from fx where k = 'rhea_lead') and touch_type = 'reply_received') = 1, '…and no second reply touch');
select pg_temp.check((select count(*) from crm.conversation_owner_transfers where lead_id = (select v from fx where k = 'rhea_lead')) = 1, '…and no second ownership transition');

-- a person who is ALREADY a lead elsewhere: the reply attaches to THAT lead and Sales keeps it
update crm.outreach_prospects set status = 'contacted' where email = 'wa@whatsco.example';
update crm.outreach_prospects set status = 'replied' where email = 'wa@whatsco.example';
select pg_temp.check((select lead_id from crm.outreach_prospects where email = 'wa@whatsco.example') = '00000000-0000-4000-8000-0000000000d7', 'WALT''S reply attaches to the lead he already has (no second lead for one person)');
select pg_temp.check((select owner from crm.lead_conversation_owner where lead_id = '00000000-0000-4000-8000-0000000000d7') = 'sales', '…and the email agent did NOT take the conversation from Sales');
select pg_temp.check((select count(*) from crm.leads where contact_id = (select v from fx where k = 'walt_contact')) = 1, '…so he still has exactly one lead');
select pg_temp.check((select count(*) from crm.lead_touchpoints where lead_id = '00000000-0000-4000-8000-0000000000d7' and channel = 'email') >= 1, '…with the email history added to his touchpoints');

-- a manual reply (a person marks it) is adopted by the same path
update crm.outreach_prospects set status = 'contacted' where email = 'plain@plainco.example';
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.mark_prospect_replied((select id from crm.outreach_prospects where email = 'plain@plainco.example'))) = 'replied', 'a person marks a prospect as replied');
reset role;
select pg_temp.check((select lead_id is not null from crm.outreach_prospects where email = 'plain@plainco.example'), '…and that adopts them too (the member path, no service role)');

-- ═══ D. the funnel comes from the records, not from a counter ═════════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select n from crm.email_funnel() where stage = 'discovered') = (select count(*) from crm.outreach_prospects), 'discovered = every prospect');
select pg_temp.check((select n from crm.email_funnel() where stage = 'replied') >= 3, 'replied counts Rhea, Walt and Pete');
select pg_temp.check((select n from crm.email_funnel() where stage = 'qualified') = (select count(*) from (select distinct on (q.prospect_id) q.decision from crm.prospect_qualifications q order by q.prospect_id, q.created_at desc, q.id desc) l where l.decision = 'qualified'), 'qualified = prospects whose LATEST decision is qualified');
select pg_temp.check((select n from crm.email_funnel() where stage = 'won') = 0, 'won is 0: no prospect''s lead has been won');
select pg_temp.check((select n from crm.email_funnel(now() + interval '1 day') where stage = 'discovered') = 0, 'the window filters');

-- ═══ E. tenancy, privileges, audit ════════════════════════════════════════
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.prospect_qualifications) = 0, 'organisation B sees none of A''s qualifications');
select pg_temp.check((select count(*) from crm.prospect_facts) = 0, '…facts');
select pg_temp.check((select count(*) from crm.blocked_prospects) = 0, '…blocks');
select pg_temp.check((select count(*) from crm.qualification_models) = 0, '…models');
select pg_temp.check((select outcome from crm.qualify_prospect(:'ORG', (select v from fx where k = 'asha'), '{"need_clarity":50}', null, '{}')) = 'forbidden', '…and cannot qualify A''s prospect');
do $$
begin
  begin perform crm.email_followup_blockers(gen_random_uuid(), gen_random_uuid()); raise exception 'FAILED: a session called the blocker check';
  exception when insufficient_privilege then raise notice 'ok  the follow-up blocker check is the chokepoint''s, not a session''s'; end;
end $$;
reset role;
select pg_temp.check(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'crm' and c.relname in ('qualification_models', 'blocked_prospects', 'prospect_facts', 'prospect_qualifications')
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert')
          or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete'))
), 'no new table is readable by anon or writable by authenticated');
select pg_temp.check((select count(*) from audit.audit_log where action = 'prospect.qualified') >= 12, 'every qualification is audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('qualification.model_saved', 'prospect.blocked', 'prospect.block_lifted')) >= 5, 'models and blocks are audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('email.adopt_failed', 'identity.key_sync_failed', 'identity.touch_failed', 'subtask.carry_failed')) = 0, 'no bookkeeping trigger failed silently');

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;
rollback;
