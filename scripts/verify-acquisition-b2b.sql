-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 10 — B2B: a marketplace's own rule decides whether a
-- conversation may leave it; a proposal or profile change goes out as EXACTLY
-- what was approved. Driven through the REAL approval engine and governed door.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-b2b.sql
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
select crm.set_channel_settings('b2b', true, 20, null, 50);
select pg_temp.check((select outcome from crm.ensure_b2b_defaults()) = 'ready', 'an admin readies the B2B settings and the eight marketplace rules');
reset role;
insert into crm.portfolio_items (id, organization_id, kind, title, url) values
  ('00000000-0000-4000-8000-0000000000f1', :'ORG', 'past_work', 'Retail storefront rebuild', 'https://example.com/work/storefront'),
  ('00000000-0000-4000-8000-0000000000f2', :'ORG', 'sample', 'Retired sample', 'https://example.com/work/old');
update crm.portfolio_items set is_active = false where id = '00000000-0000-4000-8000-0000000000f2';
insert into core.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000b2', 'Other Agency', 'other-agency') on conflict do nothing;

-- ═══ A. a marketplace's rule: restrictive by default, loosened only by the owner ═══
select pg_temp.check((select count(*) from crm.b2b_platform_rules where offplatform_contact = 'forbidden' and automation_mode = 'manual') = 8, 'every marketplace starts as: no contact off the platform, manual only');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.set_b2b_platform_rule('upwork', 'allowed', 'manual', 'x')) = 'not_owner', 'an admin cannot allow contact off a platform');
select pg_temp.check((select outcome from crm.set_b2b_platform_rule('upwork', 'forbidden', 'automated', 'x')) = 'not_owner', '…nor allow automation');
select pg_temp.check((select outcome from crm.set_b2b_platform_rule('upwork', 'forbidden', 'assisted', 'x')) = 'not_owner', '…nor loosen manual to assisted');
select pg_temp.check((select outcome from crm.set_b2b_platform_rule('upwork', 'forbidden', 'manual', 'confirmed in the terms')) = 'saved', 'an admin can restate the same or a tighter rule');
select pg_temp.check((select outcome from crm.set_b2b_platform_rule('myspace', 'forbidden', 'manual', null)) = 'unknown_platform', 'an unknown platform is refused');
select pg_temp.check((select outcome from crm.set_b2b_platform_rule('upwork', 'sometimes', 'manual', null)) = 'invalid', 'an unknown value is refused');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.set_b2b_settings(1000, '{}', 50, 10)) = 'forbidden', 'a member cannot change the thresholds');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.set_b2b_settings(100000, array['wordpress theme'], 50, 6)) = 'saved', 'an admin sets the minimum budget, an excluded term, the score threshold and the connects budget');
select pg_temp.check((select outcome from crm.set_b2b_settings(100000, '{}', 150, 6)) = 'invalid', 'a threshold above 100 is refused');
reset role;

-- ═══ B. opportunities: facts are frozen, the judgement is explainable ═══════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'good', opportunity_id from crm.record_b2b_opportunity(:'ORG', 'upwork', 'job-1', 'https://www.upwork.com/jobs/1', 'Website Development for a retail shop',
  repeat('We need a modern, fast storefront for our shop with a catalogue, a basket and simple payments. ', 3), 300000, 500000, 'usd', 'India', now() - interval '2 hours');
select pg_temp.check((select (status, fit_score) = ('scored', 100) from crm.b2b_opportunities where id = (select v from fx where k = 'good')), 'a job that matches a target service, meets the budget and is detailed scores 100');
select pg_temp.check((select fit_reasons::text like '%service_match:Website Development%' and fit_reasons::text like '%budget_ok%' and fit_reasons::text like '%enough_detail%' from crm.b2b_opportunities where id = (select v from fx where k = 'good')), '…and says why');
select pg_temp.check((select currency from crm.b2b_opportunities where id = (select v from fx where k = 'good')) = 'USD', 'the currency is normalised');
insert into fx select 'low', opportunity_id from crm.record_b2b_opportunity(:'ORG', 'upwork', 'job-2', null, 'Need a logo', 'Quick logo please.', 1000, 5000, 'USD', null, null);
select pg_temp.check((select (status, fit_score) = ('below_threshold', 0) from crm.b2b_opportunities where id = (select v from fx where k = 'low')), 'a job that matches nothing and pays below the minimum is below the threshold');
insert into fx select 'excl', opportunity_id from crm.record_b2b_opportunity(:'ORG', 'freelancer', 'job-3', null, 'Quick WordPress theme tweak for Website Development', 'Please adjust my wordpress theme.', 500000, 900000, 'USD', null, null);
select pg_temp.check((select (status, fit_score, fit_reasons::text like '%excluded_term:wordpress theme%') = ('excluded', 0, true) from crm.b2b_opportunities where id = (select v from fx where k = 'excl')), 'an excluded term is a refusal, not a low score - even when a target service is named');
select pg_temp.check((select outcome from crm.record_b2b_opportunity(:'ORG', 'upwork', 'job-1', null, 'Same job again', '', null, null, 'USD', null, null)) = 'duplicate', 'the same job on the same platform is recorded once');
select pg_temp.check((select outcome from crm.record_b2b_opportunity(:'ORG', 'upwork', 'job-9', null, 'x', '', null, null, 'USD', null, null)) = 'invalid', 'a title under 3 characters is refused');
select pg_temp.check((select outcome from crm.record_b2b_opportunity(:'ORG', 'upwork', 'job-9', null, 'A fine title', '', 500, 100, 'USD', null, null)) = 'invalid', 'a maximum below the minimum is refused');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.record_b2b_opportunity(:'ORG', 'upwork', 'job-10', null, 'A member job', '', null, null, 'USD', null, null)) = 'forbidden', 'a member cannot record an opportunity');
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.b2b_opportunities) = 0, 'another organisation sees none of the opportunities');
select pg_temp.check((select count(*) from crm.b2b_outcomes()) = 0, '…nor their results');
reset role;
do $$
declare o uuid;
begin
  select id into o from crm.b2b_opportunities limit 1;
  begin update crm.b2b_opportunities set title = 'renamed' where id = o; raise exception 'FAILED: a fact was edited';
  exception when insufficient_privilege then raise notice 'ok  what an opportunity said when found is frozen'; end;
  begin update crm.b2b_opportunities set status = 'shortlisted' where id = o; raise exception 'FAILED: a status moved outside the doors';
  exception when insufficient_privilege then raise notice 'ok  a status moves only through the doors'; end;
  begin delete from crm.b2b_opportunities where id = o; raise exception 'FAILED: an opportunity was deleted';
  exception when insufficient_privilege then raise notice 'ok  an opportunity is never deleted'; end;
end $$;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.decide_b2b_opportunity(:'ORG', (select v from fx where k = 'excl'), 'shortlist')) = 'excluded', 'an excluded job cannot be shortlisted');
select pg_temp.check((select outcome from crm.decide_b2b_opportunity(:'ORG', (select v from fx where k = 'low'), 'skip')) = 'needs_reason', 'skipping needs a reason');
select pg_temp.check((select outcome from crm.decide_b2b_opportunity(:'ORG', (select v from fx where k = 'low'), 'skip', 'not our work')) = 'decided', 'a person skips a job and says why');
select pg_temp.check((select outcome from crm.decide_b2b_opportunity(:'ORG', (select v from fx where k = 'good'), 'shortlist')) = 'decided', 'a person shortlists the good job');

-- ═══ C. proposals: derived hash, no contact off-platform, no agent pricing ═══
select pg_temp.check((select outcome from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'low'), 'A proposal body that is long enough to be a proposal for this job.', 100000, 10, 0, '{}')) = 'not_shortlisted', 'a proposal needs a shortlisted opportunity');
select pg_temp.check((select outcome from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'good'), 'Agent body that is long enough to be taken seriously as a proposal.', 100000, 10, 0, '{}', 'agent')) = 'invalid', 'an agent''s draft cannot carry a price');
insert into fx select 'agentv', version_id from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'good'), repeat('We would build this storefront with you, starting from how your customers buy. ', 2), null, 14, 0, '{}', 'agent');
select pg_temp.check((select problems::text like '%needs_a_price_from_a_person%' from crm.check_b2b_proposal(:'ORG', (select v from fx where k = 'agentv'))), 'an agent''s draft cannot pass the check: a person must price it');
insert into fx select 'bad', version_id from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'good'),
  'Hello! Email me at someone@example.com or call +91 98765 43210, or message on WhatsApp. See https://example.com/work. Act now: limited time, we guarantee results!',
  100000, 14, 2, array['00000000-0000-4000-8000-0000000000f2'::uuid]);
select pg_temp.check((select state from crm.b2b_proposal_versions where id = (select v from fx where k = 'agentv')) = 'SUPERSEDED', 'a newer draft supersedes the older one');
select pg_temp.check((select problems::text like '%contains_an_email_address%' and problems::text like '%contains_a_phone_number%' and problems::text like '%names_a_messaging_app%' and problems::text like '%contains_an_external_link%' and problems::text like '%manufactured_urgency%' and problems::text like '%past_work_is_not_a_portfolio_item%' from crm.check_b2b_proposal(:'ORG', (select v from fx where k = 'bad'))), 'where the platform forbids contact off it, a proposal with an email, a phone, a messaging app, a link, urgency or inactive past work fails');
insert into fx select 'v1', version_id from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'good'),
  repeat('We would build this storefront with you, starting from how your customers actually buy. ', 2), 150000, 21, 4, array['00000000-0000-4000-8000-0000000000f1'::uuid]);
select pg_temp.check((select content_hash = pg_temp.sha(jsonb_build_object('platform', 'upwork', 'external_ref', 'job-1', 'body', repeat('We would build this storefront with you, starting from how your customers actually buy. ', 2), 'currency', 'USD', 'price', 150000, 'timeline', 21, 'connects', 4, 'portfolio', array['00000000-0000-4000-8000-0000000000f1'::uuid])::text) from crm.b2b_proposal_versions where id = (select v from fx where k = 'v1')), 'the hash is derived from the platform, job, words, price, timeline, connects and past work');
select pg_temp.check((select outcome from crm.check_b2b_proposal(:'ORG', (select v from fx where k = 'v1'))) = 'checked', 'a clean, priced proposal with real past work passes');
reset role;
do $$
declare v uuid; h text; o uuid;
begin
  select id into v from crm.b2b_proposal_versions where state = 'CHECKED' limit 1;
  begin update crm.b2b_proposal_versions set body = 'edited' where id = v; raise exception 'FAILED: words were edited';
  exception when insufficient_privilege then raise notice 'ok  what a proposal says is frozen'; end;
  begin update crm.b2b_proposal_versions set price_minor = 1 where id = v; raise exception 'FAILED: the price was edited';
  exception when insufficient_privilege then raise notice 'ok  the price is frozen with the version'; end;
  begin update crm.b2b_proposal_versions set state = 'SUBMITTED' where id = v; raise exception 'FAILED: a state moved outside the doors';
  exception when insufficient_privilege then raise notice 'ok  a state moves only through the doors'; end;
  begin update crm.b2b_proposal_versions set external_ref = 'forged' where id = v; raise exception 'FAILED: a submission reference was written outside the doors';
  exception when insufficient_privilege then raise notice 'ok  a submission is recorded only through the doors'; end;
  begin delete from crm.b2b_proposal_versions where id = v; raise exception 'FAILED: a version was deleted';
  exception when insufficient_privilege then raise notice 'ok  a version is never deleted'; end;
  select opportunity_id into o from crm.b2b_proposal_versions where id = v;
  insert into crm.b2b_proposal_versions (organization_id, opportunity_id, version, body, currency, content_hash, created_by_type)
    values ('00000000-0000-4000-8000-000000000001', o, 99, 'x', 'USD', repeat('f', 64), 'agent') returning content_hash into h;
  if h = repeat('f', 64) then raise exception 'FAILED: a forged hash was kept'; end if;
  raise notice 'ok  a hash supplied by the caller is replaced by the derived one';
  begin insert into crm.b2b_proposal_versions (organization_id, opportunity_id, version, body, currency, price_minor, content_hash, created_by_type)
      values ('00000000-0000-4000-8000-000000000001', o, 98, 'x', 'USD', 5, repeat('0', 64), 'agent');
    raise exception 'FAILED: an agent priced a proposal';
  exception when check_violation then raise notice 'ok  the database itself refuses an agent-priced proposal'; end;
end $$;
-- the forged row above sits as a DRAFT of the same opportunity; remove it from play by superseding through a new version later
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
-- (adding a version supersedes the drafts - including the forged probe - and the CHECKED one)
insert into fx select 'v2', version_id from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'good'),
  repeat('We would build this storefront with you, starting from how your customers actually buy. ', 2), 150000, 21, 4, array['00000000-0000-4000-8000-0000000000f1'::uuid]);
select pg_temp.check((select state from crm.b2b_proposal_versions where id = (select v from fx where k = 'v1')) = 'SUPERSEDED', 'a corrected version supersedes the checked one before it was sent');
select crm.check_b2b_proposal(:'ORG', (select v from fx where k = 'v2'));
select pg_temp.check((select outcome from crm.submit_b2b_proposal(:'ORG', (select v from fx where k = 'v1'))) = 'not_checked', 'a superseded version cannot be submitted');
insert into fx select 'req2', approval_request_id from crm.submit_b2b_proposal(:'ORG', (select v from fx where k = 'v2'));
select pg_temp.check((select summary from approvals.approval_requests where id = (select v from fx where k = 'req2')) like '%upwork%Website Development for a retail shop%150000%We would build this storefront%', 'the approval card carries the platform, the job, the price and the actual words');

-- ═══ D. sending: once, as approved, with the budget and the stops re-read NOW ═══
select pg_temp.check((select outcome || ':' || reason from crm.record_manual_b2b_submission(:'ORG', (select v from fx where k = 'v2'), 'prop-1')) = 'not_covered:state_pending', 'before approval a recorded submission is refused');
select pg_temp.check((select outcome from approvals.decide_approval((select v from fx where k = 'req2'), 'approved', 'good proposal')) = 'decided', 'an admin approves version 2');
select pg_temp.check((select outcome from crm.record_manual_b2b_submission(:'ORG', (select v from fx where k = 'v2'), ' ')) = 'needs_reference', 'a submission needs the platform''s own reference');
select crm.set_channel_pause('b2b', true, 'verifier stop');
select pg_temp.check((select outcome || ':' || reason from crm.record_manual_b2b_submission(:'ORG', (select v from fx where k = 'v2'), 'prop-1')) = 'blocked:channel_paused', 'a stopped channel refuses even a person''s recorded submission');
select crm.set_channel_pause('b2b', false, null);
select crm.set_b2b_settings(100000, array['wordpress theme'], 50, 3);
select pg_temp.check((select outcome || ':' || reason from crm.record_manual_b2b_submission(:'ORG', (select v from fx where k = 'v2'), 'prop-1')) = 'blocked:monthly_connects_exceeded', 'a connects budget lowered after approval still binds (re-read at the moment)');
select crm.set_b2b_settings(100000, array['wordpress theme'], 50, 6);
select pg_temp.check((select outcome from crm.record_manual_b2b_submission(:'ORG', (select v from fx where k = 'v2'), 'prop-1')) = 'recorded', 'with the stop lifted and budget available, the approved proposal is recorded as sent');
select pg_temp.check((select (state, external_ref, submitted_via) = ('SUBMITTED', 'prop-1', 'manual') from crm.b2b_proposal_versions where id = (select v from fx where k = 'v2')), 'the version is SUBMITTED with the platform reference, by a person');
select pg_temp.check((select status from crm.b2b_opportunities where id = (select v from fx where k = 'good')) = 'submitted', 'the opportunity is submitted');
select pg_temp.check((select outcome from crm.record_manual_b2b_submission(:'ORG', (select v from fx where k = 'v2'), 'prop-1-again')) = 'already_submitted', 'a proposal is recorded as sent once');
select pg_temp.check((select sum(amount) from crm.acquisition_usage where channel = 'b2b' and metric = 'connect') = 4, 'its connects are counted: 4');
select pg_temp.check((select sum(amount) from crm.acquisition_usage where channel = 'b2b' and metric = 'action') = 1, 'and it is one counted action');
select pg_temp.check((select outcome from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'good'), repeat('Another go at the same job, which should not be allowed again. ', 2), 100, 5, 0, '{}')) = 'not_shortlisted', 'a submitted job takes no further proposal');

-- the connects budget (6 a month): 4 are spent
insert into fx select 'good2', opportunity_id from crm.record_b2b_opportunity(:'ORG', 'guru', 'job-20', null, 'Website Development for a clinic', repeat('A clinic website with bookings and a simple content area for the team to update. ', 3), 300000, 400000, 'USD', null, null);
select crm.decide_b2b_opportunity(:'ORG', (select v from fx where k = 'good2'), 'shortlist');
insert into fx select 'c1', version_id from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'good2'), repeat('We would build the clinic site around how patients book, starting with a call. ', 2), 120000, 20, 4, '{}');
select pg_temp.check((select problems::text like '%over_the_monthly_connects_budget%' from crm.check_b2b_proposal(:'ORG', (select v from fx where k = 'c1'))), 'a proposal that would overspend the monthly connects budget fails its check');
insert into fx select 'c2', version_id from crm.add_b2b_proposal_version(:'ORG', (select v from fx where k = 'good2'), repeat('We would build the clinic site around how patients book, starting with a call. ', 2), 120000, 20, 2, '{}');
select pg_temp.check((select outcome from crm.check_b2b_proposal(:'ORG', (select v from fx where k = 'c2'))) = 'checked', 'with 2 connects it fits the budget');
insert into fx select 'creq', approval_request_id from crm.submit_b2b_proposal(:'ORG', (select v from fx where k = 'c2'));
select approvals.decide_approval((select v from fx where k = 'creq'), 'approved', 'ok');

-- the adapter path is the engine's, and only where the platform may be automated
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome || ':' || reason from crm.begin_b2b_submit(:'ORG', (select v from fx where k = 'c2'))) = 'blocked:platform_not_automated', 'the engine cannot send to a platform marked manual');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from crm.set_b2b_platform_rule('guru', 'forbidden', 'automated', 'terms permit it')) = 'saved', 'the owner allows automation on one platform');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome || ':' || reason from crm.begin_b2b_submit(:'ORG', (select v from fx where k = 'c2'))) = 'blocked:integration_not_active', 'even then, with no connector connected the engine is refused');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_settings('b2b', true, 20, null, 1);
select pg_temp.check((select outcome || ':' || reason from crm.record_manual_b2b_submission(:'ORG', (select v from fx where k = 'c2'), 'prop-2')) = 'blocked:daily_limit', 'the daily action limit binds a person''s recorded submission too');
select crm.set_channel_settings('b2b', true, 20, null, 50);
select pg_temp.check((select outcome from crm.record_manual_b2b_submission(:'ORG', (select v from fx where k = 'c2'), 'prop-2')) = 'recorded', 'within the limits it is recorded');
select pg_temp.check((select sum(amount) from crm.acquisition_usage where channel = 'b2b' and metric = 'connect') = 6, 'the connects total is 6');

-- ═══ E. outcomes and the lead link ═══════════════════════════════════════
select pg_temp.check((select outcome from crm.record_b2b_outcome(:'ORG', (select v from fx where k = 'low'), 'won', 100, null)) = 'not_submitted', 'only a submitted job can be won or lost');
select pg_temp.check((select outcome from crm.record_b2b_outcome(:'ORG', (select v from fx where k = 'good'), 'won', 0, null)) = 'invalid', 'a win needs a value');
select pg_temp.check((select outcome from crm.record_b2b_outcome(:'ORG', (select v from fx where k = 'good'), 'won', 1500000, 'signed')) = 'recorded', 'a person records the win');
select pg_temp.check((select outcome from crm.record_b2b_outcome(:'ORG', (select v from fx where k = 'good2'), 'lost', null, 'chose another agency')) = 'recorded', 'and the loss');
select pg_temp.check((select outcome from crm.record_b2b_outcome(:'ORG', (select v from fx where k = 'good'), 'lost', null, null)) = 'not_submitted', 'a won job does not become lost');
select pg_temp.check((select sum(won) from crm.b2b_outcomes()) = 1 and (select sum(lost) from crm.b2b_outcomes()) = 1 and (select sum(revenue_minor) from crm.b2b_outcomes()) = 1500000 and (select sum(connects_spent) from crm.b2b_outcomes()) = 6, 'wins, losses, revenue and connects spent are derived from the records');
select pg_temp.check((select bool_and(insufficient_data) from crm.b2b_outcomes()), 'a handful of decided jobs is marked too thin to judge');
reset role;
do $$
begin
  begin update crm.b2b_opportunities set status = 'lost' where status = 'won'; raise exception 'FAILED: a won job was reopened';
  exception when insufficient_privilege then raise notice 'ok  a won job cannot be reopened outside the doors'; end;
end $$;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'ct', contact_id from crm.resolve_identity(:'ORG', '{"name":"Marketplace Client","email":"client@mkt.example"}', 'whatsapp');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values
  ('00000000-0000-4000-8000-0000000000d1', :'ORG', (select v from fx where k = 'ct'), 'Marketplace client', 'whatsapp', 'wa:mkt1', 'new'),
  ('00000000-0000-4000-8000-0000000000d2', :'ORG', (select v from fx where k = 'ct'), 'Another lead', 'whatsapp', 'wa:mkt2', 'new');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.link_b2b_opportunity_lead(:'ORG', (select v from fx where k = 'good'), gen_random_uuid())) = 'unknown_lead', 'a lead that does not exist cannot be linked');
select pg_temp.check((select outcome from crm.link_b2b_opportunity_lead(:'ORG', (select v from fx where k = 'good'), '00000000-0000-4000-8000-0000000000d1')) = 'linked', 'a person links the lead the conversation became');
select pg_temp.check((select outcome from crm.link_b2b_opportunity_lead(:'ORG', (select v from fx where k = 'good'), '00000000-0000-4000-8000-0000000000d2')) = 'already_linked', '…once');
select pg_temp.check((select count(*) from crm.lead_touchpoints where lead_id = '00000000-0000-4000-8000-0000000000d1' and channel = 'b2b' and platform = 'upwork') = 1, 'the marketplace is recorded as a touchpoint on the lead');

-- ═══ F. the tracked WhatsApp handoff honours the marketplace's rule ═══════
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.sha('h1'), '00000000-0000-4000-8000-0000000000d1', 'b2b', null, 'b2b_opportunity')) = 'platform_required', 'a B2B handoff must say which marketplace');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.sha('h2'), '00000000-0000-4000-8000-0000000000d1', 'b2b', 'upwork', 'b2b_opportunity')) = 'offplatform_forbidden', 'a marketplace that forbids contact off it gets no WhatsApp handoff');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.sha('h3'), '00000000-0000-4000-8000-0000000000d1', 'b2b', 'contra', 'b2b_opportunity')) = 'offplatform_forbidden', '…and so does one with no rule of its own (the default is forbidden)');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.sha('h4'), '00000000-0000-4000-8000-0000000000d1', 'email', null, 'email_outreach')) = 'created', 'other channels are untouched by the marketplace rule');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select crm.cancel_channel_handoff((select id from crm.channel_handoffs where lead_id = '00000000-0000-4000-8000-0000000000d1' limit 1), 'verifier: make room for the next');
select crm.set_b2b_platform_rule('upwork', 'after_award', 'manual', 'only once awarded');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.sha('h5'), '00000000-0000-4000-8000-0000000000d2', 'b2b', 'upwork', 'b2b_opportunity')) = 'offplatform_forbidden', 'after_award: a lead with no won job on that marketplace is refused');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.sha('h6'), '00000000-0000-4000-8000-0000000000d1', 'b2b', 'upwork', 'b2b_opportunity')) = 'created', 'after_award: the lead whose job was WON may be taken to WhatsApp');

-- ═══ G. profile changes ═══════════════════════════════════════════════════
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
\set PROFILE '{"headline":"Websites and apps for growing businesses","summary":"We design and build fast, accessible websites and mobile apps for small and mid-sized businesses, and stay on to improve them after launch."}'
insert into fx select 'pbad', version_id from crm.add_b2b_profile_version(:'ORG', 'upwork', (:'PROFILE')::jsonb || '{"testimonials":[{"q":"great"}]}'::jsonb);
select pg_temp.check((select problems::text like '%claims_a_platform_could_not_confirm%' from crm.check_b2b_profile(:'ORG', (select v from fx where k = 'pbad'))), 'a profile claiming testimonials, reviews, ratings or badges fails (nothing can confirm them)');
insert into fx select 'p1', version_id from crm.add_b2b_profile_version(:'ORG', 'upwork', :'PROFILE'::jsonb);
select pg_temp.check((select state from crm.b2b_profile_versions where id = (select v from fx where k = 'pbad')) = 'SUPERSEDED', 'a newer profile draft supersedes the older');
select pg_temp.check((select outcome from crm.check_b2b_profile(:'ORG', (select v from fx where k = 'p1'))) = 'checked', 'a sound profile passes');
insert into fx select 'preq', approval_request_id from crm.submit_b2b_profile(:'ORG', (select v from fx where k = 'p1'));
select pg_temp.check((select outcome from crm.record_manual_profile_update(:'ORG', (select v from fx where k = 'p1'), 'https://www.upwork.com/freelancers/x')) = 'not_covered', 'before approval a recorded profile update is refused');
select approvals.decide_approval((select v from fx where k = 'preq'), 'approved', 'ok');
select pg_temp.check((select outcome from crm.record_manual_profile_update(:'ORG', (select v from fx where k = 'p1'), 'http://insecure')) = 'needs_evidence', 'a profile update needs an https link as evidence');
select pg_temp.check((select outcome from crm.record_manual_profile_update(:'ORG', (select v from fx where k = 'p1'), 'https://www.upwork.com/freelancers/x')) = 'recorded', 'with approval and evidence it is recorded');
select pg_temp.check((select outcome from crm.record_manual_profile_update(:'ORG', (select v from fx where k = 'p1'), 'https://www.upwork.com/freelancers/x')) = 'already_applied', '…once');
select pg_temp.check((select state from crm.b2b_profile_versions where id = (select v from fx where k = 'p1')) = 'APPLIED', 'the version is APPLIED');
reset role;
do $$
begin
  begin update crm.b2b_profile_versions set content = '{"headline":"edited headline"}' where state = 'APPLIED'; raise exception 'FAILED: a profile was edited';
  exception when insufficient_privilege then raise notice 'ok  what a profile says is frozen'; end;
  begin update crm.b2b_profile_versions set evidence_url = 'https://forged.example.com' where state = 'APPLIED'; raise exception 'FAILED: evidence was forged';
  exception when insufficient_privilege then raise notice 'ok  evidence is recorded only through the doors'; end;
end $$;

-- ═══ H. tenancy and privileges ════════════════════════════════════════════
do $$
declare t text; n integer; f text;
begin
  foreach t in array array['b2b_platform_rules', 'b2b_settings', 'b2b_opportunities', 'b2b_proposal_versions', 'b2b_profile_versions'] loop
    select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'crm' and c.relname = t and c.relrowsecurity and c.relforcerowsecurity;
    if n <> 1 then raise exception 'FAILED: % is not under forced RLS', t; end if;
    if has_table_privilege('anon', 'crm.' || t, 'select') or has_table_privilege('authenticated', 'crm.' || t, 'insert') or has_table_privilege('authenticated', 'crm.' || t, 'update') or has_table_privilege('authenticated', 'crm.' || t, 'delete') then
      raise exception 'FAILED: % grants more than internal reads', t;
    end if;
    select count(*) into n from pg_trigger g where g.tgrelid = ('crm.' || t)::regclass and g.tgname like 'freeze_org_%';
    if n <> 1 then raise exception 'FAILED: % does not freeze its organisation', t; end if;
  end loop;
  raise notice 'ok  all five B2B tables: forced RLS, no anon read, no authenticated write, organisation frozen';
  foreach f in array array['begin_b2b_submit(uuid,uuid,uuid)', 'record_b2b_submit(uuid,uuid,uuid,text,text,jsonb)', 'sync_b2b_approvals(integer)', 'b2b_fit(uuid,text,text,bigint,bigint)'] loop
    if has_function_privilege('authenticated', 'crm.' || f, 'execute') or has_function_privilege('anon', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is callable by a signed-in user', f; end if;
    if not has_function_privilege('service_role', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is not callable by the engine', f; end if;
  end loop;
  foreach f in array array['_b2b_begin_submit(uuid,uuid,text,uuid)', '_b2b_finish_submit(uuid,uuid,uuid,text,text,text,jsonb)', '_b2b_set(text,uuid,text)'] loop
    if has_function_privilege('authenticated', 'crm.' || f, 'execute') or has_function_privilege('service_role', 'crm.' || f, 'execute') then raise exception 'FAILED: crm.% is reachable from outside', f; end if;
  end loop;
  raise notice 'ok  the machine doors are the engine''s alone and the internals are reachable by nobody';
end $$;

select 'ALL CHECKS PASSED' as result;
rollback;
