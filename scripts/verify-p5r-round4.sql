-- ═════════════════════════════════════════════════════════════════
-- Round 4 (migration 20261205000000): a how-to closes only on a cited APPROVED article; the Phase 8 handoff package carries contact preferences;
-- a finance agent run has a derived completion report. Driven through the REAL doors on a scratch Postgres; rolls back.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p5r-round4.sql
-- Every table-wide count is scoped to this verifier's own organization rows.
-- ═════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;

create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;

create or replace function pg_temp.as_client(p_sub uuid, p_org uuid, p_account uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', 'client_member', 'client_account_id', p_account))::text, true);
end $$;
grant execute on function pg_temp.as_client(uuid, uuid, uuid) to public;

create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;

-- true when the statement fails and the message contains the needle
create or replace function pg_temp.errs(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.errs(text, text) to public;
-- a direct write with NO door announced in this transaction (the doors' transaction-local flag is cleared first)
create or replace function pg_temp.direct(stmt text, needle text) returns boolean language plpgsql as $$
begin perform set_config('projects.p8_sanctioned', 'off', true); return pg_temp.errs(stmt, needle); end $$;
grant execute on function pg_temp.direct(text, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000005e2'
\set OWNER '00000000-0000-4000-8000-00000000fe01'
\set ADMIN '00000000-0000-4000-8000-00000000fe02'
\set STAFF '00000000-0000-4000-8000-00000000fe03'
\set STAFF2 '00000000-0000-4000-8000-00000000fe04'
\set CLIENTU '00000000-0000-4000-8000-00000000fe05'
\set BSTAFF '00000000-0000-4000-8000-00000000fe07'

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency (p5r)', 'other-agency-p5r') on conflict (id) do nothing;
insert into auth.users (id, email) values (:'OWNER', 'p5r-owner@example.test'), (:'ADMIN', 'p5r-admin@example.test'), (:'STAFF', 'p5r-staff@example.test'), (:'STAFF2', 'p5r-staff2@example.test'),
  (:'CLIENTU', 'p5r-client@example.test'), (:'BSTAFF', 'p5r-bstaff@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p5r-owner@example.test', 'P5R Owner'), (:'ADMIN', 'p5r-admin@example.test', 'P5R Admin'), (:'STAFF', 'p5r-staff@example.test', 'P5R Staff'),
  (:'STAFF2', 'p5r-staff2@example.test', 'P5R Staff Two'), (:'CLIENTU', 'p5r-client@example.test', 'P5R Client'), (:'BSTAFF', 'p5r-bstaff@example.test', 'P5R Other Staff') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'ADMIN', 'ops_admin'), (:'ORG', :'STAFF', 'member'), (:'ORG', :'STAFF2', 'member'), (:'ORGB', :'BSTAFF', 'member')
  on conflict do nothing;
select set_config('p8.org', :'ORG', true);
select set_config('p8.staff', :'STAFF', true);

-- fixture: a COMPLETED project with the facts the Phase 8 intake reads (as in the 8A verifier) and a passed production verification
create or replace function pg_temp.mk(p_code text, p_org uuid default null)
returns table (client uuid, project uuid)
language plpgsql as $$
declare v_org uuid := coalesce(p_org, current_setting('p8.org')::uuid); v_a uuid; v_p uuid; v_sv uuid;
begin
  insert into core.client_accounts (organization_id, name) values (v_org, 'zztest p5r ' || p_code) returning id into v_a;
  insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (v_org, v_a, 'zztest p5r ' || p_code, p_code, 'completed') returning id into v_p;
  insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at) values (v_org, v_p, 1, 'active', now()) returning id into v_sv;
  alter table projects.handovers disable trigger user;
  insert into projects.handovers (organization_id, project_id, status, delivered_at, accepted_at) values (v_org, v_p, 'accepted', now(), now());
  alter table projects.handovers enable trigger user;
  insert into projects.release_verifications (organization_id, project_id, environment, outcome, evidence_url) values (v_org, v_p, 'production', 'passed', 'https://evidence.example.test/' || lower(p_code));
  insert into crm.contacts (organization_id, client_account_id, full_name, email) values (v_org, v_a, 'Contact ' || p_code, lower(p_code) || '@client.example.test');
  alter table projects.completion_records disable trigger user;
  insert into projects.completion_records (organization_id, project_id, client_account_id, scope_version_id, scope_version, invoiced_minor, verified_minor, completed_at, known_limitations)
  values (v_org, v_p, v_a, v_sv, 1, 0, 0, now(), 'none known');
  alter table projects.completion_records enable trigger user;
  return query select v_a, v_p;
end $$;
grant execute on function pg_temp.mk(text, uuid) to public;
-- a how-to ticket taken to IN PROGRESS through the real doors (not closed)
create or replace function pg_temp.p5r_howto(p_project uuid, p_ref text) returns uuid language plpgsql as $$
declare v_t uuid; v_o text;
begin
  perform pg_temp.as_service();
  select ticket_id into v_t from projects.open_support_ticket(current_setting('p8.org')::uuid, p_project, 'ticket ' || p_ref, 'the client asked how to export', 'portal', p_ref);
  perform pg_temp.as_user(current_setting('p8.staff')::uuid, current_setting('p8.org')::uuid, 'member');
  select outcome into v_o from projects.classify_support_ticket(v_t, 'how_to', 'included_support', 'because ' || p_ref, 'p4', null);
  if v_o <> 'classified' then raise exception 'fixture % not classified: %', p_ref, v_o; end if;
  select outcome into v_o from projects.assign_support_ticket(v_t, current_setting('p8.staff')::uuid);
  if v_o <> 'assigned' then raise exception 'fixture % not assigned: %', p_ref, v_o; end if;
  select outcome into v_o from projects.advance_support_ticket(v_t, 'in_progress');
  if v_o <> 'advanced' then raise exception 'fixture % not started: %', p_ref, v_o; end if;
  return v_t;
end $$;
grant execute on function pg_temp.p5r_howto(uuid, text) to public;

select client as "A_id", project as "PA_id" from pg_temp.mk('P5R-A') \gset
select client as "A2_id", project as "PA2_id" from pg_temp.mk('P5R-A2') \gset
select client as "A3_id", project as "PA3_id" from pg_temp.mk('P5R-A3') \gset
-- client A has a live Phase 8 workspace (tickets need one)
select pg_temp.as_service();
select outcome as "FILL_out" from projects.fill_phase_eight_intake(:'ORG', :'PA_id') \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "START_out" from projects.start_phase_eight(:'PA_id', current_date - 1, current_date + 89, 'defects in the delivered scope', 'new features, third-party outages', null, :'STAFF2') \gset
reset role;
select pg_temp.check(:'FILL_out' = 'ready' and :'START_out' = 'started', 'fixture: client A has a live Phase 8 workspace');

-- ═════════ 1. a how-to closes on a cited APPROVED article ═════════
select pg_temp.p5r_howto(:'PA_id', 'p5r-h1') as "H1" \gset
select pg_temp.p5r_howto(:'PA_id', 'p5r-h2') as "H2" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.advance_support_ticket(:'H1', 'closed')) = 'answer_and_source_required', 'no answer recorded: answer_and_source_required');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'H1', 'closed', 'Explained the export button')) = 'approved_knowledge_citation_required', 'an answer without a cited article is refused');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'H1', 'closed', 'Explained the export button', 'knowledge: exports-guide v2')) = 'approved_knowledge_citation_required', 'NEGATIVE: free-text evidence is not a citation');
select outcome as "KA_out", article_id as "KA_id" from projects.propose_knowledge_article('p5r-export-guide', 'Exporting your data', 'Open Settings, choose Export, pick a format and press the Export button.', true) \gset
select pg_temp.check(:'KA_out' = 'proposed', 'fixture: a draft article is proposed by a person');
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(:'H1', :'KA_id')) = 'article_not_approved', 'NEGATIVE: a DRAFT article cannot be cited');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'H1', 'closed', 'Explained the export button')) = 'approved_knowledge_citation_required', 'a draft does not open the door');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.approve_knowledge_article(:'KA_id')) = 'approved', 'a different Admin approves the article');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(:'H1', :'KA_id')) = 'cited', 'the approved article is cited for H1');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'H2', 'closed', 'Explained the export button')) = 'approved_knowledge_citation_required', 'a citation on ANOTHER ticket does not count');
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(:'H2', :'KA_id')) = 'cited', 'the same article is cited for H2');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.retire_knowledge_article(:'KA_id', 'superseded by a newer guide')) = 'retired', 'the Admin retires the article');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'H2', 'closed', 'Explained the export button')) = 'cited_knowledge_no_longer_approved', 'NEGATIVE: a retired article no longer answers a ticket');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'H1', 'closed', 'Explained the export button')) = 'cited_knowledge_no_longer_approved', 'the same holds for H1: nothing closes on a retired article');
select outcome as "KB_out", article_id as "KB_id" from projects.propose_knowledge_article('p5r-export-guide', 'Exporting your data', 'Open Settings, choose Export, pick a format and press Export. Version two of the guide.', true) \gset
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.approve_knowledge_article(:'KB_id')) = 'approved', 'the current version is approved by a different Admin');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(:'H2', :'KB_id')) = 'cited', 'the current version is cited');
select pg_temp.check((select outcome from projects.advance_support_ticket(:'H2', 'closed', 'Explained the export button')) = 'advanced', 'H2 closes on the current approved article');
reset role;
select pg_temp.check((select status = 'closed' and close_reason = 'answered' from projects.support_tickets where id = :'H2'), 'H2 ended closed as answered');
select pg_temp.check((select status = 'in_progress' from projects.support_tickets where id = :'H1'), 'H1 stayed open: its only citation is retired');

-- ═════════ 2. contact preferences in the handoff package ═════════
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.fill_phase_eight_intake(:'ORG', :'PA2_id')) in ('ready', 'incomplete'), 'the intake is built');
select pg_temp.check((select jsonb_typeof(package -> 'preferences') = 'string' and (package ->> 'preferences') like 'none recorded:%' from projects.phase_eight_intake where project_id = :'PA2_id'),
                     'no preference recorded: the package says so in words');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_contact_preferences(:'A2_id', 'email', 'hi', array['call'], null, 'no calls before noon')) = 'set', 'a person records the preferences');
reset role;
select pg_temp.as_service();
select outcome as "REFILL" from projects.fill_phase_eight_intake(:'ORG', :'PA2_id') \gset
select pg_temp.check((select jsonb_typeof(package -> 'preferences') = 'object' and package -> 'preferences' ->> 'preferredChannel' = 'email' and package -> 'preferences' ->> 'language' = 'hi'
                             and package -> 'preferences' -> 'avoidChannels' = '["call"]'::jsonb and package -> 'preferences' ->> 'note' = 'no calls before noon' from projects.phase_eight_intake where project_id = :'PA2_id'),
                     'the refreshed package carries the channel, language, avoided channel and note');
select outcome as "FILL3" from projects.fill_phase_eight_intake(:'ORG', :'PA3_id') \gset
select pg_temp.check(:'FILL3' in ('ready', 'incomplete')
                     and (select jsonb_typeof(package -> 'preferences') = 'string' from projects.phase_eight_intake where project_id = :'PA3_id'),
                     'another client''s package does not inherit them');
select pg_temp.check((select count(*) from projects.phase_eight_intake where project_id = :'PA2_id') = 1, 'preferences are advice: still one intake row for the project');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(pg_temp.errs(format('select projects.p5r_intake_preferences(%L, %L)', :'A2_id', :'ORG'), 'permission denied'), 'NEGATIVE: the preference reader is not callable by a signed-in person');
reset role;

-- ═════════ 3. a finance agent run has a completion report ═════════
insert into finance.finance_agent_requests (organization_id, project_id, agent_key, requested_by) values (:'ORG', :'PA_id', 'finance_close', :'ADMIN') returning id as "R1" \gset
insert into finance.finance_agent_requests (organization_id, project_id, agent_key, requested_by) values (:'ORG', :'PA_id', 'finance_close', :'ADMIN') returning id as "R2" \gset
insert into finance.finance_proposals (organization_id, request_id, project_id, agent_key, kind, summary, requested_by) values (:'ORG', :'R1', :'PA_id', 'finance_close', 'close_readiness_note', 'Everything is invoiced and verified', :'ADMIN') returning id as "PR1" \gset
insert into finance.finance_proposals (organization_id, request_id, project_id, agent_key, kind, summary, requested_by) values (:'ORG', :'R1', :'PA_id', 'finance_close', 'close_readiness_note', 'One credit note is pending', :'ADMIN') returning id as "PR2" \gset
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select (r ->> 'state') = 'awaiting_decision' and (r ->> 'proposalCount')::int = 2 and jsonb_array_length(r -> 'blockers') = 1 and r -> 'proposals' -> 0 ->> 'decision' = 'awaiting'
                             and r -> 'policyRef' ->> 'agent' = 'finance_close' and r ->> 'handoff' like 'not complete%' from (select finance.p5r_finance_agent_completion_report(:'R1') r) x), 'two undecided proposals: awaiting_decision, one blocker, handoff not complete');
select pg_temp.check((select finance.p5r_finance_agent_completion_report(:'R2') ->> 'state') = 'no_output' and (select jsonb_array_length(finance.p5r_finance_agent_completion_report(:'R2') -> 'blockers')) = 1, 'a run with no proposal reports no_output and says so');
reset role;
insert into finance.finance_proposal_decisions (organization_id, proposal_id, decision, decided_by, note, recorded_outcome) values (:'ORG', :'PR1', 'accepted', :'ADMIN', null, 'noted'), (:'ORG', :'PR2', 'rejected', :'ADMIN', 'not a real finding', 'rejected');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select (r ->> 'state') = 'decided' and jsonb_array_length(r -> 'blockers') = 0 and r -> 'proposals' -> 0 ->> 'decision' = 'accepted' and r -> 'proposals' -> 1 ->> 'decision' = 'rejected'
                             and r ->> 'handoff' = 'every proposal has a person''s decision' from (select finance.p5r_finance_agent_completion_report(:'R1') r) x), 'every proposal decided: state decided, no blocker, decisions listed');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
select pg_temp.check((select finance.p5r_finance_agent_completion_report(:'R1')) is null, 'NEGATIVE: a plain member gets nothing');
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'ops_admin');
select pg_temp.check((select finance.p5r_finance_agent_completion_report(:'R1')) is null, 'NEGATIVE: another organization''s Admin gets nothing');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select finance.p5r_finance_agent_completion_report(gen_random_uuid())) is null, 'an unknown run reports null');
reset role;
select pg_temp.check((select count(*) from finance.finance_agent_requests where organization_id = :'ORG' and project_id = :'PA_id') = 2, 'the report stored nothing: still exactly the two runs');

\echo Round 4 (how-to citation, handoff preferences, finance completion report) verified OK
rollback;
