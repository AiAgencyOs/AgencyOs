-- ═══════════════════════════════════════════════════════════════════════════
-- P1-CRM-045 / P1-CRM-063: the commercial report counts what the deals, discounts, objections, leads and agent runs already record (migration 20261204400000).
-- Real rows, real function, scratch Postgres; rolls back. Scoped to this verifier's own organizations (the CI database holds committed rows).
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1s-commercial-report.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.p1s_check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
grant execute on function pg_temp.p1s_check(boolean, text) to public;
create or replace function pg_temp.p1s_as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
grant execute on function pg_temp.p1s_as_user(uuid, uuid, text) to public;
create or replace function pg_temp.p1s_as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.p1s_as_service() to public;
create or replace function pg_temp.p1s_mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if; execute n; end $$;
grant execute on function pg_temp.p1s_mutate(regprocedure, text, text) to public;

\set RORG '00000000-0000-4000-8000-0000000b0800'
\set RMEM '00000000-0000-4000-8000-0000000b0801'
\set ROTH '00000000-0000-4000-8000-0000000b0810'
\set ROTHU '00000000-0000-4000-8000-0000000b0811'

insert into auth.users (id, email) values (:'RMEM', 'p1s-r-mem@example.test'), (:'ROTHU', 'p1s-r-oth@example.test');
insert into core.users (id, email, full_name) values (:'RMEM', 'p1s-r-mem@example.test', 'R Member'), (:'ROTHU', 'p1s-r-oth@example.test', 'R Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'RORG', 'zztest p1s report', 'zztest-p1s-report'), (:'ROTH', 'zztest p1s report other', 'zztest-p1s-report-other');
insert into core.memberships (organization_id, user_id, role) values (:'RORG', :'RMEM', 'member'), (:'ROTH', :'ROTHU', 'owner');
insert into core.client_accounts (organization_id, name) values (:'RORG', 'zztest p1s report client') returning id as acct \gset

-- fixtures are written with the user triggers off (the won gate and the proposal guard refuse a row built outside their paths); the report reads rows, not paths
alter table sales.opportunities disable trigger user;
alter table sales.proposals disable trigger user;
alter table crm.leads disable trigger user;

insert into sales.payment_structures (organization_id, name, kind, active) values (:'RORG', 'Trust start', 'lower_advance', true);

-- leads
insert into crm.leads (organization_id, title, source) values (:'RORG', 'p1s lead referral', 'referral') returning id as l1 \gset
insert into crm.leads (organization_id, title, source) values (:'RORG', 'p1s lead web', 'web_form') returning id as l2 \gset
insert into crm.leads (organization_id, title, source) values (:'RORG', 'p1s lead web 2', 'web_form') returning id as l3 \gset
insert into crm.leads (organization_id, title, source, status, nurture_reason, qualified_at) values (:'RORG', 'p1s lead nurtured then won', 'whatsapp', 'nurture', 'budget_later', now()) returning id as l4 \gset
insert into crm.leads (organization_id, title, source, status, nurture_reason, qualified_at) values (:'RORG', 'p1s lead nurtured still', 'whatsapp', 'nurture', 'not_ready_now', now()) returning id as l5 \gset

-- closed deals inside the window: three won (1,000 / 2,000 / 3,000 rupees), two lost
insert into sales.opportunities (organization_id, client_account_id, lead_id, name, stage, value_minor, closed_at) values (:'RORG', :'acct', :'l1', 'p1s won discounted', 'won', 100000, now() - interval '5 days') returning id as w1 \gset
insert into sales.opportunities (organization_id, client_account_id, lead_id, name, stage, value_minor, closed_at) values (:'RORG', :'acct', :'l2', 'p1s won trust', 'won', 200000, now() - interval '6 days') returning id as w2 \gset
insert into sales.opportunities (organization_id, client_account_id, lead_id, name, stage, value_minor, closed_at) values (:'RORG', :'acct', :'l4', 'p1s won plain (nurtured)', 'won', 300000, now() - interval '7 days') returning id as w3 \gset
insert into sales.opportunities (organization_id, client_account_id, lead_id, name, stage, value_minor, closed_at, lost_reason, lost_category) values (:'RORG', :'acct', :'l3', 'p1s lost discounted', 'lost', 50000, now() - interval '8 days', 'too dear', 'price_too_high') returning id as x1 \gset
insert into sales.opportunities (organization_id, client_account_id, name, stage, value_minor, closed_at, lost_reason, lost_category) values (:'RORG', :'acct', 'p1s lost plain', 'lost', 40000, now() - interval '9 days', 'ghosted', 'no_response') returning id as x2 \gset
-- one closed long ago: counted at 365 days, not at 90
insert into sales.opportunities (organization_id, client_account_id, name, stage, value_minor, closed_at) values (:'RORG', :'acct', 'p1s won long ago', 'won', 900000, now() - interval '200 days') returning id as w4 \gset

-- quotations: w1 and x1 carry a discount that took effect; w2 printed the lower-advance structure
insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, status) values (:'RORG', :'w1', 1, 'p1s q w1', 110000, 10000, 100000, 'accepted') returning id as pw1 \gset
insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, status, document) values (:'RORG', :'w2', 1, 'p1s q w2', 200000, 0, 200000, 'accepted', '{"paymentStructure":{"name":"Trust start","milestones":[{"label":"Advance","pct":10}]}}'::jsonb) returning id as pw2 \gset
insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, status) values (:'RORG', :'x1', 1, 'p1s q x1', 55000, 5000, 50000, 'rejected') returning id as px1 \gset
insert into sales.discount_decisions (organization_id, proposal_id, original_amount_minor, discount_minor, discount_pct, reason, requested_by_type, requested_by_user, status, final_amount_minor, decided_at)
  values (:'RORG', :'pw1', 110000, 10000, 9.09, 'loyal', 'human', :'RMEM', 'autonomous', 100000, now());
insert into sales.discount_decisions (organization_id, proposal_id, original_amount_minor, discount_minor, discount_pct, reason, requested_by_type, requested_by_user, status, final_amount_minor, decided_at)
  values (:'RORG', :'px1', 55000, 5000, 9.09, 'tried to win', 'human', :'RMEM', 'approved', 50000, now());
insert into sales.discount_decisions (organization_id, proposal_id, original_amount_minor, discount_minor, discount_pct, reason, requested_by_type, requested_by_user, status)
  values (:'RORG', :'pw2', 200000, 20000, 10, 'asked', 'human', :'RMEM', 'pending_approval');

-- objections
insert into sales.objections (organization_id, lead_id, round, kind, concern, outcome) values (:'RORG', :'l3', 1, 'price', 'too expensive for us', 'lost');
insert into sales.objections (organization_id, lead_id, round, kind, concern, outcome) values (:'RORG', :'l1', 1, 'price', 'can you do better', 'conceded');
insert into sales.objections (organization_id, lead_id, round, kind, concern) values (:'RORG', :'l2', 1, 'timeline', 'we need it sooner');
-- agent runs (the autonomy guard asks for a work class; the report does not)
alter table ai.agent_runs disable trigger user;
insert into ai.agent_runs (organization_id, agent_key, trigger, status, cost_minor, latency_ms) values (:'RORG', 'sales', 'p1s', 'succeeded', 120, 1000), (:'RORG', 'sales', 'p1s', 'succeeded', 80, 3000), (:'RORG', 'sales', 'p1s', 'failed', 10, 500), (:'RORG', 'project_manager', 'p1s', 'succeeded', 5, 200);

alter table ai.agent_runs enable trigger user;
alter table sales.opportunities enable trigger user;
alter table sales.proposals enable trigger user;
alter table crm.leads enable trigger user;

select pg_temp.p1s_as_user(:'RMEM', :'RORG', 'member');
set local role authenticated;
select sales.p1s_commercial_report(90) as r90 \gset
select sales.p1s_commercial_report(365) as r365 \gset
reset role;

select pg_temp.p1s_check((:'r90'::jsonb -> 'deals' ->> 'won') = '3' and (:'r90'::jsonb -> 'deals' ->> 'lost') = '2', '90 days: three won and two lost (the deal closed 200 days ago is outside the window)');
select pg_temp.p1s_check((:'r365'::jsonb -> 'deals' ->> 'won') = '4', '365 days: the old deal is counted');
select pg_temp.p1s_check((:'r90'::jsonb -> 'deals' ->> 'avgWonValueMinor') = '200000' and (:'r90'::jsonb -> 'deals' ->> 'wonValueMinor') = '600000', 'average won deal is 2,000 rupees and the won total 6,000');
select pg_temp.p1s_check((:'r365'::jsonb -> 'deals' ->> 'avgWonValueMinor') = '375000', 'the average moves with the window (1,000 + 2,000 + 3,000 + 9,000 over four = 3,750 rupees)');

select pg_temp.p1s_check((:'r90'::jsonb -> 'discount' -> 'decisions' ->> 'autonomous') = '1' and (:'r90'::jsonb -> 'discount' -> 'decisions' ->> 'approved') = '1' and (:'r90'::jsonb -> 'discount' -> 'decisions' ->> 'pending_approval') = '1', 'discount decisions are counted by status');
select pg_temp.p1s_check((:'r90'::jsonb -> 'discount' ->> 'takenEffectMinor') = '15000', 'only decisions that took effect add to the money given away (a pending one does not)');
select pg_temp.p1s_check((:'r90'::jsonb -> 'discount' ->> 'discountedWon') = '1' and (:'r90'::jsonb -> 'discount' ->> 'discountedLost') = '1' and (:'r90'::jsonb -> 'discount' ->> 'plainWon') = '2' and (:'r90'::jsonb -> 'discount' ->> 'plainLost') = '1', 'closed deals split into discounted and plain, won and lost');
select pg_temp.p1s_check((:'r90'::jsonb -> 'trustOffer' ->> 'won') = '1' and (:'r90'::jsonb -> 'trustOffer' ->> 'lost') = '0' and (:'r90'::jsonb -> 'trustOffer' ->> 'standardWon') = '2' and (:'r90'::jsonb -> 'trustOffer' ->> 'standardLost') = '2', 'a deal whose quotation printed the lower-advance structure is the trust-offer deal');
select pg_temp.p1s_check((:'r90'::jsonb -> 'repeat' ->> 'newWon') = '3' and (:'r90'::jsonb -> 'repeat' ->> 'won') = '0', 'no renewal or upsell in this data: repeat won is 0, new won is 3');
select pg_temp.p1s_check((:'r90'::jsonb -> 'nurture' ->> 'leads') = '2' and (:'r90'::jsonb -> 'nurture' ->> 'converted') = '1', 'two nurtured leads, one of which has a won deal');

select pg_temp.p1s_check((:'r90'::jsonb -> 'objections' -> 0 ->> 'kind') = 'price' and (:'r90'::jsonb -> 'objections' -> 0 ->> 'raised') = '2' and (:'r90'::jsonb -> 'objections' -> 0 ->> 'lost') = '1', 'top objection is price, raised twice, once ending in a lost deal');
select pg_temp.p1s_check((:'r90'::jsonb -> 'objections' -> 1 ->> 'kind') = 'timeline' and (:'r90'::jsonb -> 'objections' -> 1 ->> 'open') = '1', 'timeline is next and still open');
select pg_temp.p1s_check((select (s ->> 'leads')::int from jsonb_array_elements(:'r90'::jsonb -> 'sources') s where s ->> 'source' = 'web_form') = 2 and (select (s ->> 'won')::int from jsonb_array_elements(:'r90'::jsonb -> 'sources') s where s ->> 'source' = 'web_form') = 1, 'web form brought two leads and one is won');
select pg_temp.p1s_check((select (s ->> 'won')::int from jsonb_array_elements(:'r90'::jsonb -> 'sources') s where s ->> 'source' = 'referral') = 1, 'referral: one lead, won');
select pg_temp.p1s_check((select (a ->> 'runs')::int from jsonb_array_elements(:'r90'::jsonb -> 'agents') a where a ->> 'agent' = 'sales') = 3
  and (select (a ->> 'failed')::int from jsonb_array_elements(:'r90'::jsonb -> 'agents') a where a ->> 'agent' = 'sales') = 1
  and (select (a ->> 'costMinor')::int from jsonb_array_elements(:'r90'::jsonb -> 'agents') a where a ->> 'agent' = 'sales') = 210
  and (select (a ->> 'avgLatencyMs')::int from jsonb_array_elements(:'r90'::jsonb -> 'agents') a where a ->> 'agent' = 'sales') = 1500, 'the sales agent: 3 runs, 1 failed, 210 minor units, 1.5 s average');
select pg_temp.p1s_check((:'r90'::jsonb -> 'agents' -> 0 ->> 'agent') = 'sales', 'agents are listed busiest first');

-- isolation and who may
select pg_temp.p1s_as_user(:'ROTHU', :'ROTH', 'owner');
set local role authenticated;
select sales.p1s_commercial_report(90) as rother \gset
reset role;
select pg_temp.p1s_check((:'rother'::jsonb -> 'deals' ->> 'won') = '0' and (:'rother'::jsonb -> 'discount' ->> 'takenEffectMinor') = '0' and (:'rother'::jsonb -> 'deals' ->> 'avgWonValueMinor') is null, 'NEGATIVE: another organization sees none of these deals, and an average with nothing to average is null, not zero');
select pg_temp.p1s_check(jsonb_array_length(:'rother'::jsonb -> 'sources') = 0 and jsonb_array_length(:'rother'::jsonb -> 'agents') = 0, 'NEGATIVE: nor these sources or agent runs');
select pg_temp.p1s_as_user('00000000-0000-4000-8000-0000000b09fc', :'RORG', 'client_admin');
set local role authenticated;
select pg_temp.p1s_check(sales.p1s_commercial_report(90) is null, 'NEGATIVE: a client user gets nothing');
reset role;
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check(sales.p1s_commercial_report(90) is null, 'NEGATIVE: with no signed-in user (an agent / service principal) the report is null');
reset role;
select pg_temp.p1s_as_user(:'RMEM', :'RORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((sales.p1s_commercial_report(100000) ->> 'days') = '730' and (sales.p1s_commercial_report(0) ->> 'days') = '1', 'the window is clamped to 1..730 days');
reset role;

-- red-proofs
select pg_temp.p1s_mutate('sales.p1s_commercial_report(integer)'::regprocedure, $m$where o.organization_id = v_org and o.stage in ('won', 'lost') and o.closed_at >= v_since$m$, $m$where o.stage in ('won', 'lost') and o.closed_at >= v_since$m$);
select pg_temp.p1s_as_user(:'ROTHU', :'ROTH', 'owner');
set local role authenticated;
select pg_temp.p1s_check((sales.p1s_commercial_report(90) -> 'deals' ->> 'won') = '3', 'RED-PROOF: with the organization filter removed another organization sees this one''s won deals (the isolation check above depends on it)');
reset role;
select pg_temp.p1s_mutate('sales.p1s_commercial_report(integer)'::regprocedure, $m$where d.organization_id = v_org and d.status in ('autonomous', 'approved')$m$, $m$where d.organization_id = v_org and d.status in ('autonomous', 'approved', 'pending_approval')$m$);
select pg_temp.p1s_as_user(:'RMEM', :'RORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((sales.p1s_commercial_report(90) -> 'discount' ->> 'discountedWon') = '2', 'RED-PROOF: counting a pending discount as taken makes the second won deal "discounted" (the discounted-split check above depends on the status filter)');
reset role;

rollback;
\echo 'verify-p1s-commercial-report: ALL CHECKS PASSED'
