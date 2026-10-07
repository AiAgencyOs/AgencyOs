-- ═══════════════════════════════════════════════════════════════════════════
-- P1-BLUEPRINT-021 (A15) and P1-BLUEPRINT-035 (A29): the negotiation queue and the incident / recovery queue (migration 20261204300000).
-- Both are reads of records that already exist. Real rows, real functions, scratch Postgres; rolls back. Everything is asserted for this verifier's own
-- organizations only (the CI database holds committed rows from earlier checks).
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1s-negotiation-and-incident-queues.sql
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

\set QORG '00000000-0000-4000-8000-0000000b0700'
\set QMEM '00000000-0000-4000-8000-0000000b0701'
\set QOTH '00000000-0000-4000-8000-0000000b0710'
\set QOTHU '00000000-0000-4000-8000-0000000b0711'

insert into auth.users (id, email) values (:'QMEM', 'p1s-q-mem@example.test'), (:'QOTHU', 'p1s-q-oth@example.test');
insert into core.users (id, email, full_name) values (:'QMEM', 'p1s-q-mem@example.test', 'Q Member'), (:'QOTHU', 'p1s-q-oth@example.test', 'Q Other') on conflict do nothing;
insert into core.organizations (id, name, slug, settings) values (:'QORG', 'zztest p1s queues', 'zztest-p1s-queues', '{"negotiation_max_rounds":"2"}'::jsonb), (:'QOTH', 'zztest p1s queues other', 'zztest-p1s-queues-other', '{}'::jsonb);
insert into core.memberships (organization_id, user_id, role) values (:'QORG', :'QMEM', 'member'), (:'QOTH', :'QOTHU', 'owner');
insert into core.client_accounts (organization_id, name) values (:'QORG', 'zztest p1s queue client') returning id as acct \gset

-- ═══════════ A15: the negotiation queue ═══════════
insert into crm.leads (organization_id, title) values (:'QORG', 'p1s lead one') returning id as l1 \gset
insert into crm.leads (organization_id, title) values (:'QORG', 'p1s lead two') returning id as l2 \gset
insert into crm.leads (organization_id, title) values (:'QORG', 'p1s lead three') returning id as l3 \gset
insert into sales.opportunities (organization_id, client_account_id, lead_id, name, stage) values (:'QORG', :'acct', :'l1', 'p1s deal objection', 'negotiation') returning id as o1 \gset
insert into sales.opportunities (organization_id, client_account_id, lead_id, name, stage) values (:'QORG', :'acct', :'l2', 'p1s deal sent quietly', 'proposal') returning id as o2 \gset
insert into sales.opportunities (organization_id, client_account_id, lead_id, name, stage, lost_reason, lost_category, closed_at) values (:'QORG', :'acct', :'l3', 'p1s deal lost', 'lost', 'went elsewhere', 'chose_competitor', now()) returning id as o3 \gset
insert into sales.opportunities (organization_id, client_account_id, name, stage) values (:'QORG', :'acct', 'p1s deal untouched', 'discovery') returning id as o4 \gset
insert into sales.opportunities (organization_id, client_account_id, name, stage) values (:'QORG', :'acct', 'p1s deal unclear yes', 'proposal') returning id as o5 \gset
-- fixtures: quotations in the states the queue reads, without walking each through the approval path (the user triggers are off for these inserts only)
alter table sales.proposals disable trigger user;
insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, status) values (:'QORG', :'o1', 1, 'p1s q1', 1000000, 0, 1000000, 'superseded') returning id as pa1 \gset
insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, status) values (:'QORG', :'o1', 2, 'p1s q1 v2', 1000000, 100000, 900000, 'sent') returning id as pa2 \gset
insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, status) values (:'QORG', :'o2', 1, 'p1s q2', 500000, 0, 500000, 'sent') returning id as pb1 \gset
insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, status) values (:'QORG', :'o3', 1, 'p1s q3', 500000, 0, 500000, 'rejected') returning id as pc1 \gset
insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, status) values (:'QORG', :'o5', 1, 'p1s q5 a', 500000, 0, 500000, 'sent') returning id as pe1 \gset
alter table sales.proposals enable trigger user;
-- two rounds on lead one: the first answered, the second open
insert into sales.objections (organization_id, lead_id, round, kind, concern, response, outcome, proposal_id, created_at) values (:'QORG', :'l1', 1, 'price', 'it is too expensive for us', 'we reduced it', 'resolved', :'pa1', now() - interval '2 hours');
insert into sales.objections (organization_id, lead_id, round, kind, concern, proposal_id) values (:'QORG', :'l1', 2, 'timeline', 'we need it a month sooner', :'pa2');
-- the lost deal also carries an objection: it is the stage, not the lack of activity, that keeps it out
insert into sales.objections (organization_id, lead_id, round, kind, concern, outcome) values (:'QORG', :'l3', 1, 'price', 'p1s too expensive, we went elsewhere', 'lost');
insert into sales.discount_decisions (organization_id, proposal_id, original_amount_minor, discount_minor, discount_pct, reason, requested_by_type, requested_by_user, status)
  values (:'QORG', :'pa2', 1000000, 100000, 10, 'asked twice', 'human', :'QMEM', 'pending_approval');
-- an unclear yes on deal five
alter table sales.proposals disable trigger user;
insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor, status, plan_slot) values (:'QORG', :'o5', 2, 'p1s q5 b', 400000, 0, 400000, 'sent', 1) returning id as pe2 \gset
alter table sales.proposals enable trigger user;
insert into sales.p1o_acceptance_clarifications (organization_id, opportunity_id, proposal_ids) values (:'QORG', :'o5', array[:'pe1'::uuid, :'pe2'::uuid]);

select pg_temp.p1s_as_user(:'QMEM', :'QORG', 'member');
set local role authenticated;
select count(*) as n from sales.p1s_negotiation_queue() \gset
select pg_temp.p1s_check(:n = 3, 'the queue lists the three deals in play (objections, a sent quotation, an unclear yes); not the lost deal, not the untouched one');
select pg_temp.p1s_check((select count(*) from sales.p1s_negotiation_queue() where opportunity_id = :'o3') = 0, 'NEGATIVE: a lost deal is not being negotiated');
select pg_temp.p1s_check((select count(*) from sales.p1s_negotiation_queue() where opportunity_id = :'o4') = 0, 'NEGATIVE: a deal with nothing in play is not listed');
select pg_temp.p1s_check((select proposal_version from sales.p1s_negotiation_queue() where opportunity_id = :'o1') = 2 and (select proposal_status from sales.p1s_negotiation_queue() where opportunity_id = :'o1') = 'sent', 'the current version is the newest one');
select pg_temp.p1s_check((select rounds from sales.p1s_negotiation_queue() where opportunity_id = :'o1') = 2 and (select open_objections from sales.p1s_negotiation_queue() where opportunity_id = :'o1') = 1, 'two rounds, one still open');
select pg_temp.p1s_check((select latest_objection_kind from sales.p1s_negotiation_queue() where opportunity_id = :'o1') = 'timeline', 'the latest objection is shown');
select pg_temp.p1s_check((select at_round_cap from sales.p1s_negotiation_queue() where opportunity_id = :'o1') and (select round_cap from sales.p1s_negotiation_queue() where opportunity_id = :'o1') = 2, 'two rounds against a cap of two is at the cap');
select pg_temp.p1s_check(not (select at_round_cap from sales.p1s_negotiation_queue() where opportunity_id = :'o2'), 'POSITIVE twin: a deal with no rounds is not at the cap');
select pg_temp.p1s_check((select pending_discount_decisions from sales.p1s_negotiation_queue() where opportunity_id = :'o1') = 1, 'a discount waiting for approval is counted');
select pg_temp.p1s_check((select next_action from sales.p1s_negotiation_queue() where opportunity_id = :'o1') = 'Answer the open objection', 'the next action for an open objection is to answer it');
select pg_temp.p1s_check((select next_action from sales.p1s_negotiation_queue() where opportunity_id = :'o2') = 'Waiting for the client', 'a quietly sent quotation is waiting for the client');
select pg_temp.p1s_check((select acceptance_unclear from sales.p1s_negotiation_queue() where opportunity_id = :'o5') and (select next_action from sales.p1s_negotiation_queue() where opportunity_id = :'o5') like 'Ask the client which version%', 'an unclear yes asks which version, and nothing is accepted');
select pg_temp.p1s_check((select opportunity_id from sales.p1s_negotiation_queue() limit 1) in (:'o1', :'o5'), 'deals that need a person come first');
reset role;

select pg_temp.p1s_as_user(:'QOTHU', :'QOTH', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from sales.p1s_negotiation_queue()) = 0, 'NEGATIVE: another organization sees none of these deals');
reset role;
select pg_temp.p1s_as_user('00000000-0000-4000-8000-0000000b09fd', :'QORG', 'client_admin');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from sales.p1s_negotiation_queue()) = 0, 'NEGATIVE: a client user sees none');
reset role;

-- ═══════════ A29: the incident / recovery queue ═══════════
-- fixtures: tasks in the states the queue reads (the user triggers are off for these inserts only: the registry would refuse the made-up agent pairs)
alter table ai.handoffs disable trigger user;
insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, objective, status, priority, previous_failure_summary)
  values (:'QORG', gen_random_uuid(), 'sales', 'proposal_drafter', 'p1s draft the quotation that failed', 'failed_permanent', 'normal', 'the model returned nothing usable') returning id as h1 \gset
insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, objective, status, priority, side_effect_uncertain, blocker)
  values (:'QORG', gen_random_uuid(), 'sales', 'handover', 'p1s book the meeting (may have been booked)', 'running', 'normal', true, 'the calendar call timed out') returning id as h2 \gset
insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, objective, status, priority, side_effect_uncertain, verification, completed_at)
  values (:'QORG', gen_random_uuid(), 'sales', 'handover', 'p1s a task that was reconciled and completed', 'completed', 'normal', true, '{"ok":true}'::jsonb, now()) returning id as h3 \gset
insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, objective, status, priority, created_at)
  values (:'QORG', gen_random_uuid(), 'sales', 'handover', 'p1s an old failure nobody is waiting on', 'failed_permanent', 'normal', now() - interval '30 days') returning id as h4 \gset
insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, objective, status, priority)
  values (:'QORG', gen_random_uuid(), 'sales', 'project_manager', 'p1s refused and urgent', 'rejected', 'urgent') returning id as h5 \gset
insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, objective, status)
  values (:'QORG', gen_random_uuid(), 'sales', 'project_manager', 'p1s a healthy running task', 'running') returning id as h6 \gset
alter table ai.handoffs enable trigger user;
insert into security.incidents (organization_id, kind, severity, summary, opened_by) values (:'QORG', 'suspicious_activity', 'critical', 'p1s a sign-in from an unexpected place', :'QMEM') returning id as i1 \gset
insert into security.incidents (organization_id, kind, severity, summary, opened_by, resolved_by, resolved_at, resolution)
  values (:'QORG', 'policy_violation', 'low', 'p1s an already closed incident', :'QMEM', :'QMEM', now(), 'checked and fine') returning id as i2 \gset
insert into core.escalations (organization_id, subject_type, subject_key, title, from_user, to_role, reason) values (:'QORG', 'lead', 'p1s-key', 'p1s needs the owner', :'QMEM', 'owner', 'a discount over my limit') returning id as e1 \gset
insert into core.jobs (organization_id, kind, status, last_error) values (:'QORG', 'p1s.some_job', 'dead', 'out of attempts after 5 tries') returning id as j1 \gset
insert into core.p13_circuit_breakers (organization_id, provider, state, opened_at, last_error_class) values (:'QORG', 'p1s-provider', 'open', now(), 'timeout') returning id as b1 \gset
insert into core.p13_circuit_breakers (organization_id, provider, state) values (:'QORG', 'p1s-healthy', 'closed');

select pg_temp.p1s_as_user(:'QMEM', :'QORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue()) = 7, 'the queue holds exactly the seven things that need a person (failed task, uncertain task, refused task, security, escalation, dead job, outage)');
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h6') = 0, 'NEGATIVE: a healthy running task is not an incident');
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h3') = 0, 'NEGATIVE: an uncertain task that was reconciled and completed is not an incident');
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h4') = 0, 'NEGATIVE: a failure from a month ago that nobody is waiting on is not in the open queue');
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue() where incident_key = 'security:' || :'i2') = 0, 'NEGATIVE: a closed security incident is not in the open queue');
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue() where source = 'outage' and outage_provider = 'p1s-healthy') = 0, 'NEGATIVE: a closed circuit is no outage');
select pg_temp.p1s_check((select uncertain_side_effect from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h2') and (select severity from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h2') = 'high', 'an uncertain side effect is flagged and high');
select pg_temp.p1s_check((select runbook_key from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h2') = 'uncertain_side_effect', 'and points at the uncertain-side-effect runbook');
select pg_temp.p1s_check((select runbook_key from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h1') = 'task_failed' and (select severity from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h1') = 'medium', 'an ordinary failed task is medium with the task-failed runbook');
select pg_temp.p1s_check((select severity from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h5') = 'high' and (select runbook_key from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h5') = 'task_rejected', 'an urgent refused task is high with the refusal runbook');
select pg_temp.p1s_check((select source_task_id from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h1') = :'h1', 'the source task is named, so the controls can act on it');
select pg_temp.p1s_check((select severity from ai.p1s_incident_queue() where incident_key = 'security:' || :'i1') = 'critical', 'a security incident keeps its own severity');
select pg_temp.p1s_check((select owner_label from ai.p1s_incident_queue() where incident_key = 'security:' || :'i1') = 'p1s-q-mem@example.test', 'and its owner');
select pg_temp.p1s_check((select outage_provider from ai.p1s_incident_queue() where source = 'outage') = 'p1s-provider', 'an open circuit shows as an outage naming the provider');
select pg_temp.p1s_check((select severity from ai.p1s_incident_queue() limit 1) = 'critical', 'the most severe open item is first');
select pg_temp.p1s_check((select age_minutes from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h1') between 0 and 5, 'age is measured from when it opened');
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue(true)) = 9, 'including closed and older items adds the closed incident and the month-old failure');
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue(true) where state = 'closed') = 1 and (select state from ai.p1s_incident_queue(true) where incident_key = 'security:' || :'i2') = 'closed', 'the closed security incident is marked closed; the old failure is still open (nothing records it as handled)');
reset role;

select pg_temp.p1s_as_user(:'QOTHU', :'QOTH', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue(true)) = 0, 'NEGATIVE: another organization sees none of it, closed or open');
reset role;
select pg_temp.p1s_as_user('00000000-0000-4000-8000-0000000b09fd', :'QORG', 'client_admin');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue(true)) = 0, 'NEGATIVE: a client user sees none');
reset role;
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue(true)) = 0, 'NEGATIVE: with no signed-in user (an agent / service principal) the queue answers nothing');
reset role;

-- ═══════════ red-proofs ═══════════
select pg_temp.p1s_mutate('ai.p1s_incident_queue(boolean, integer)'::regprocedure, 'where x.organization_id = v_org and x.status = ''dead''', 'where x.status = ''dead''');
select pg_temp.p1s_as_user(:'QOTHU', :'QOTH', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue() where source = 'job' and source_id = :'j1') = 1, 'RED-PROOF: with the organization filter removed from the dead-job leg another organization sees this one''s job (the isolation check above depends on it)');
reset role;
select pg_temp.p1s_mutate('ai.p1s_incident_queue(boolean, integer)'::regprocedure, 'or (x.status in (''failed_permanent'', ''rejected'') and (p_include_closed or x.created_at > now() - interval ''14 days''))', 'or (x.status in (''failed_permanent'', ''rejected''))');
select pg_temp.p1s_as_user(:'QMEM', :'QORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from ai.p1s_incident_queue() where incident_key = 'handoff:' || :'h4') = 1, 'RED-PROOF: with the 14-day window removed the month-old failure is back in the open queue');
reset role;
select pg_temp.p1s_mutate('sales.p1s_negotiation_queue(integer)'::regprocedure, 'o.stage not in (''won'', ''lost'')', 'true');
select pg_temp.p1s_as_user(:'QMEM', :'QORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from sales.p1s_negotiation_queue() where opportunity_id = :'o3') = 1, 'RED-PROOF: with the stage filter removed the lost deal is listed (the won-deal check above depends on it)');
reset role;

rollback;
\echo 'verify-p1s-negotiation-and-incident-queues: ALL CHECKS PASSED'
