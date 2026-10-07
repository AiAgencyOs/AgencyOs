-- ═════════════════════════════════════════════════════════════════
-- Phase 8A gaps log 1: audited denials, ticket event correlation, retention status, client feedback, strategic designation, contact preferences, cadence,
-- the approved knowledge base, scope references, developer/QA requests, the next-action queue, discovery briefs, metric reconciliation.
-- Driven through the REAL doors on a scratch Postgres.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-eight-a-gaps-1.sql          (rolls back)
--
-- Nothing here sends anything. Fixtures are inserted as the table owner only where an upstream engine is not what is under test. Counts are scoped to this verifier's rows
-- or compared between two reads of the SAME organization.
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

create or replace function pg_temp.errs(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.errs(text, text) to public;
-- a direct write with NO door announced
create or replace function pg_temp.direct(stmt text, needle text) returns boolean language plpgsql as $$
begin perform set_config('projects.p8_sanctioned', 'off', true); return pg_temp.errs(stmt, needle); end $$;
grant execute on function pg_temp.direct(text, text) to public;
-- a write as if a door had announced itself (so only the table's OWN rules can refuse it)
create or replace function pg_temp.sanctioned(stmt text, needle text) returns boolean language plpgsql as $$
begin perform set_config('projects.p8_sanctioned', 'on', true); return pg_temp.errs(stmt, needle); end $$;
grant execute on function pg_temp.sanctioned(text, text) to public;
-- a new request: the correlation id restarts
create or replace function pg_temp.new_request() returns void language plpgsql as $$
begin perform set_config('projects.p8_correlation', '', true); end $$;
grant execute on function pg_temp.new_request() to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000008e2'
\set OWNER '00000000-0000-4000-8000-00000000fe01'
\set ADMIN '00000000-0000-4000-8000-00000000fe02'
\set STAFF '00000000-0000-4000-8000-00000000fe03'
\set STAFF2 '00000000-0000-4000-8000-00000000fe04'
\set CLIENTU '00000000-0000-4000-8000-00000000fe05'
\set CLIENTBU '00000000-0000-4000-8000-00000000fe06'
\set BSTAFF '00000000-0000-4000-8000-00000000fe07'

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency (8a-g1)', 'other-agency-8a-g1') on conflict (id) do nothing;
insert into auth.users (id, email) values (:'OWNER', 'g1-owner@example.test'), (:'ADMIN', 'g1-admin@example.test'), (:'STAFF', 'g1-staff@example.test'), (:'STAFF2', 'g1-staff2@example.test'),
  (:'CLIENTU', 'g1-client@example.test'), (:'CLIENTBU', 'g1-clientb@example.test'), (:'BSTAFF', 'g1-bstaff@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'g1-owner@example.test', 'G1 Owner'), (:'ADMIN', 'g1-admin@example.test', 'G1 Admin'), (:'STAFF', 'g1-staff@example.test', 'G1 Staff'),
  (:'STAFF2', 'g1-staff2@example.test', 'G1 Staff Two'), (:'CLIENTU', 'g1-client@example.test', 'G1 Client'), (:'CLIENTBU', 'g1-clientb@example.test', 'G1 Client B'), (:'BSTAFF', 'g1-bstaff@example.test', 'G1 Other Staff') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'ADMIN', 'ops_admin'), (:'ORG', :'STAFF', 'member'), (:'ORG', :'STAFF2', 'member'), (:'ORGB', :'BSTAFF', 'member')
  on conflict do nothing;
select set_config('p8.org', :'ORG', true);
select set_config('p8.staff', :'STAFF', true);

create or replace function pg_temp.mk(p_code text, p_org uuid default null)
returns table (client uuid, project uuid, sv uuid)
language plpgsql as $$
declare v_org uuid := coalesce(p_org, current_setting('p8.org')::uuid); v_a uuid; v_p uuid; v_sv uuid;
begin
  insert into core.client_accounts (organization_id, name) values (v_org, 'zztest g1 ' || p_code) returning id into v_a;
  insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (v_org, v_a, 'zztest g1 ' || p_code, p_code, 'completed') returning id into v_p;
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
  return query select v_a, v_p, v_sv;
end $$;
grant execute on function pg_temp.mk(text, uuid) to public;

-- a live Phase 8 workspace for a fixture project
create or replace function pg_temp.live(p_project uuid) returns void language plpgsql as $$
declare v_o text;
begin
  perform pg_temp.as_service();
  select outcome into v_o from projects.fill_phase_eight_intake(current_setting('p8.org')::uuid, p_project);
  if v_o <> 'ready' then raise exception 'fixture intake not ready: %', v_o; end if;
  perform pg_temp.as_user(current_setting('p8.staff')::uuid, current_setting('p8.org')::uuid, 'member');
  set local role authenticated;
  select outcome into v_o from projects.start_phase_eight(p_project, current_date - 1, current_date + 89, 'defects in the delivered scope', 'new features, third-party outages', null, current_setting('p8.staff')::uuid);
  reset role;
  if v_o <> 'started' then raise exception 'fixture workspace not started: %', v_o; end if;
end $$;
grant execute on function pg_temp.live(uuid) to public;

create or replace function pg_temp.ticket(p_project uuid, p_ref text) returns uuid language plpgsql as $$
declare v_t uuid;
begin
  perform pg_temp.as_service();
  select ticket_id into v_t from projects.open_support_ticket(current_setting('p8.org')::uuid, p_project, 'ticket ' || p_ref, 'the client reported a problem with ' || p_ref, 'portal', p_ref);
  return v_t;
end $$;
grant execute on function pg_temp.ticket(uuid, text) to public;

-- ═════════ 0. fixtures ═════════
select client as "A_id", project as "PA_id", sv as "SVA_id" from pg_temp.mk('G1-A') \gset
select client as "A2_id", project as "PA2_id", sv as "SVA2_id" from pg_temp.mk('G1-A2') \gset
select client as "X_id", project as "PX_id", sv as "SVX_id" from pg_temp.mk('G1-X', :'ORGB') \gset
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest g1 plain client B') returning id as "B_id" \gset
insert into crm.contacts (organization_id, client_account_id, full_name, email) values (:'ORG', :'B_id', 'Contact B', 'gb@client.example.test') returning id as "BCT_id" \gset
select id as "ACT_id" from crm.contacts where client_account_id = :'A_id' \gset
select pg_temp.live(:'PA_id');
select pg_temp.live(:'PA2_id');
select pg_temp.check((select count(*) from projects.phase_eight where project_id in (:'PA_id', :'PA2_id') and state = 'active') = 2, 'fixture: two live Phase 8 workspaces');

-- ═════════ 1. P8-SEC-004: ticket events carry a correlation id ═════════
select pg_temp.new_request();
select pg_temp.ticket(:'PA_id', 'G1-T1') as "T1_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "T1_class" from projects.classify_support_ticket(:'T1_id', 'warranty_bug', 'covered_warranty', 'login is broken in the delivered scope', 'p2', null) \gset
reset role;
select pg_temp.check(:'T1_class' = 'classified', 'fixture: ticket T1 classified');
select pg_temp.check((select count(*) from projects.support_ticket_events where ticket_id = :'T1_id') >= 2
                     and (select count(*) from projects.support_ticket_events where ticket_id = :'T1_id' and correlation_id is null) = 0, 'every ticket event written now carries a correlation id');
select pg_temp.check((select count(distinct correlation_id) from projects.support_ticket_events where ticket_id = :'T1_id') = 1, 'the events one request wrote share ONE correlation id');
select correlation_id as "T1_corr" from projects.support_ticket_events where ticket_id = :'T1_id' limit 1 \gset
select pg_temp.new_request();
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "T1_asg" from projects.assign_support_ticket(:'T1_id', :'STAFF') \gset
reset role;
select pg_temp.check(:'T1_asg' = 'assigned' and (select count(distinct correlation_id) from projects.support_ticket_events where ticket_id = :'T1_id') = 2
                     and (select correlation_id from projects.support_ticket_events where ticket_id = :'T1_id' and kind = 'assigned') <> :'T1_corr'::uuid, 'a later request gets a DIFFERENT correlation id');
select pg_temp.check(pg_temp.direct(format('update projects.support_ticket_events set correlation_id = gen_random_uuid() where ticket_id = %L', :'T1_id'), 'history'), 'a correlation id is history: it is never edited');
select pg_temp.check((select count(*) from pg_trigger where tgrelid = 'projects.support_ticket_events'::regclass and tgname = 'support_ticket_events_correlation' and not tgisinternal) = 1, 'the stamping trigger is in place');

-- ═════════ 2. E2E-13: a denied read is audited ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.guard_phase_eight_project(:'PA_id', 'project_workspace')) = 'allowed', 'staff of the owning organization are allowed');
reset role;
select pg_temp.check((select count(*) from projects.phase_eight_access_denials where subject_id = :'PA_id') = 0, 'and an allowed read writes no denial');
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.guard_phase_eight_project(:'PA_id', 'customer_360')) = 'denied', 'staff of ANOTHER organization asking for the project are denied');
select pg_temp.check((select outcome from projects.guard_phase_eight_project(:'PA_id', 'customer_360')) = 'denied', 'and are denied again');
select pg_temp.check((select outcome from projects.guard_phase_eight_project(gen_random_uuid(), 'project_workspace')) = 'denied', 'a project that does not exist is denied the same way');
select pg_temp.check((select outcome from projects.guard_phase_eight_project(null, 'project_workspace')) = 'denied', 'a null subject is denied');
select pg_temp.check((select outcome from projects.guard_phase_eight_project(:'PA_id', 'not-a-surface')) = 'denied', 'an unknown surface is still denied');
reset role;
select pg_temp.check((select count(*) from projects.phase_eight_access_denials where organization_id = :'ORGB' and subject_id = :'PA_id' and surface = 'customer_360') = 1, 'the denial is recorded in the CALLER''s organization, once (a refresh does not flood the log)');
select pg_temp.check((select count(*) from projects.phase_eight_access_denials where organization_id = :'ORG' and actor_user = :'BSTAFF') = 0, 'and nothing is written into the owning organization''s log');
select pg_temp.check((select count(*) from projects.phase_eight_access_denials where actor_user = :'BSTAFF' and surface = 'other') = 1, 'an unknown surface is stored as other');
select pg_temp.check((select count(distinct reason) from projects.phase_eight_access_denials where actor_user = :'BSTAFF') = 1,
                     'a foreign project and a missing one are stored with the SAME reason: the log never says whether the subject exists elsewhere');
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.guard_phase_eight_project(:'PA_id', 'project_workspace')) = 'allowed', 'a client is allowed its OWN project');
reset role;
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest g1 client B2') returning id as "B2_id" \gset
select pg_temp.as_client(:'CLIENTBU', :'ORG', :'B2_id');
set local role authenticated;
select pg_temp.check((select outcome from projects.guard_phase_eight_project(:'PA_id', 'project_workspace')) = 'denied', 'another client of the same organization is denied');
reset role;
select pg_temp.check((select count(*) from projects.phase_eight_access_denials where actor_user = :'CLIENTBU' and actor_kind = 'client' and reason = 'not_your_clients_project') = 1, 'recorded as a client denial');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from projects.phase_eight_access_denials) >= 1 and (select count(*) from projects.phase_eight_access_denials where organization_id = :'ORGB') = 0, 'an Admin reads their own organization''s denials and never another''s');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.phase_eight_access_denials) = 0, 'a non-admin member reads no denials');
select pg_temp.check(pg_temp.errs('insert into projects.phase_eight_access_denials (organization_id, actor_kind, surface, reason, correlation_id) values (' || quote_literal(:'ORG') || ', ''staff'', ''other'', ''not_your_clients_project'', gen_random_uuid())', 'permission denied'), 'nobody writes a denial directly');
reset role;
select pg_temp.check(pg_temp.errs(format('update projects.phase_eight_access_denials set surface = %L where organization_id = %L', 'other', :'ORGB'), 'history'), 'the denial log is append-only (update)');
select pg_temp.check(pg_temp.errs(format('delete from projects.phase_eight_access_denials where organization_id = %L', :'ORGB'), 'history'), 'the denial log is append-only (delete)');
select pg_temp.as_service();
select pg_temp.check(not has_function_privilege('service_role', 'projects.guard_phase_eight_project(uuid,text)', 'execute'), 'the service role has no guard door');

-- ═════════ 3. P8-SEC-006: retention status (reads, deletes nothing) ═════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from projects.phase_eight_retention_status()) = 10, 'ten Phase 8 data sets are reported');
select pg_temp.check((select record_class = 'support_warranty_records' and not policy_set from projects.phase_eight_retention_status() where data_set = 'support_tickets'), 'support tickets map to the support/warranty class, and no policy is set yet');
select pg_temp.check((select record_class is null and not policy_set from projects.phase_eight_retention_status() where data_set = 'client_communication_ledger'), 'the communication ledger says NO record class covers it');
select pg_temp.check((select rows_held from projects.phase_eight_retention_status() where data_set = 'support_tickets') = (select count(*) from projects.support_tickets where organization_id = :'ORG'), 'rows held equals the real count');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from projects.set_retention_policy('support_warranty_records', false, 2555, null, 'seven years plus margin')) = 'set', 'fixture: an Admin sets the support/warranty retention');
select pg_temp.check((select policy_set and policy_version = 1 and not indefinite and retention_days = 2555 from projects.phase_eight_retention_status() where data_set = 'support_tickets'), 'once an Admin sets a policy the status shows it');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select rows_held from projects.phase_eight_retention_status() where data_set = 'support_tickets') = 0 and (select not policy_set from projects.phase_eight_retention_status() where data_set = 'support_tickets'), 'another organization sees its own (empty) numbers and not this policy');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.phase_eight_retention_status()) = 0, 'a client reads nothing');
reset role;
select pg_temp.check((select count(*) from projects.support_tickets where id = :'T1_id') = 1, 'nothing was deleted by the status read');

-- ═════════ 4. client feedback and goals ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "FB1_out", feedback_id as "FB1_id" from projects.record_client_feedback(:'A_id', 'feedback', 'call', 'negative', 2, 'The client said the reports page is slow and confusing', :'PA_id') \gset
select pg_temp.check(:'FB1_out' = 'recorded', 'a person records negative feedback from a call');
select outcome as "FG1_out", feedback_id as "FG1_id" from projects.record_client_feedback(:'A_id', 'goal', 'meeting', null, null, 'Wants to double online orders by next spring', null) \gset
select pg_temp.check(:'FG1_out' = 'recorded', 'and a goal (no score)');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'goal', 'meeting', 'positive', null, 'Wants to double online orders by next spring')) = 'a_goal_has_no_score', 'a goal refuses a sentiment (door)');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'goal', 'meeting', null, 3, 'Wants to double online orders by next spring')) = 'a_goal_has_no_score', 'a goal refuses a rating (door)');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'feedback', 'call', null, null, 'The client said something about the product')) = 'sentiment_required', 'feedback needs a sentiment');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'feedback', 'client_portal', 'positive', null, 'The client said something nice about us')) = 'bad_source', 'a person cannot record something AS the client portal');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'feedback', 'call', 'positive', 9, 'The client said something nice about us')) = 'rating_out_of_range', 'rating 1 to 5');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'feedback', 'call', 'positive', 5, 'short')) = 'body_required', 'a body is required');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'feedback', 'call', 'positive', 5, 'The client password: hunter2hunter2 was read out loud')) = 'contains_secret', 'a secret is refused');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'bogus', 'call', 'positive', 5, 'The client said something nice about us')) = 'bad_kind', 'bad kind');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'feedback', 'call', 'positive', 5, 'The client said something nice about us', :'PA2_id')) = 'project_not_the_clients', 'a project of another client is refused');
select pg_temp.check((select outcome from projects.record_client_feedback(:'X_id', 'feedback', 'call', 'positive', 5, 'The client said something nice about us')) = 'not_found', 'a client of another organization is not found');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'feedback', 'call', 'positive', 5, 'The client said something nice about us', null, current_date + 2)) = 'in_the_future', 'not dated in the future');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_feedback (organization_id, client_account_id, kind, source, entered_by, sentiment, body, recorded_by) values (%L, %L, ''feedback'', ''call'', ''staff'', ''positive'', ''a body that is long enough'', %L)', :'ORG', :'A_id', :'STAFF'), 'permission denied'), 'no direct insert');
reset role;
select pg_temp.check(pg_temp.errs(format('update projects.client_feedback set body = %L where id = %L', 'rewritten history text', :'FB1_id'), 'history'), 'feedback is append-only (update)');
select pg_temp.check(pg_temp.errs(format('delete from projects.client_feedback where id = %L', :'FB1_id'), 'history'), 'feedback is append-only (delete)');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_feedback (organization_id, client_account_id, kind, source, entered_by, sentiment, rating, body, recorded_by) values (%L, %L, ''goal'', ''call'', ''staff'', null, 4, ''a body that is long enough'', %L)', :'ORG', :'A_id', :'STAFF'), 'client_feedback_goal_has_no_score'), 'CHECK: a goal has no score (table layer)');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_feedback (organization_id, client_account_id, kind, source, entered_by, sentiment, body, recorded_by) values (%L, %L, ''feedback'', ''client_portal'', ''staff'', ''positive'', ''a body that is long enough'', %L)', :'ORG', :'A_id', :'STAFF'), 'client_feedback_portal_is_the_clients'), 'CHECK: only the client enters through the portal (table layer)');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_feedback (organization_id, client_account_id, kind, source, entered_by, body, recorded_by) values (%L, %L, ''feedback'', ''call'', ''staff'', ''a body that is long enough'', %L)', :'ORG', :'A_id', :'STAFF'), 'client_feedback_feedback_has_a_sentiment'), 'CHECK: feedback has a sentiment (table layer)');
-- the client's own door
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select outcome as "CF1_out", feedback_id as "CF1_id" from projects.submit_client_feedback('feedback', 'negative', 1, 'Nobody answered my email for three days', :'PA_id') \gset
select pg_temp.check(:'CF1_out' = 'submitted', 'a client submits feedback through its portal');
select pg_temp.check((select outcome from projects.submit_client_feedback('feedback', 'positive', 5, 'Great work on the launch', :'PA2_id')) = 'not_found', 'NEGATIVE: not about another client''s project');
select pg_temp.check((select outcome from projects.submit_client_feedback('goal', 'positive', null, 'We want to open a second shop', null)) = 'a_goal_has_no_score', 'a client goal carries no score either');
select pg_temp.check((select outcome from projects.submit_client_feedback('goal', null, null, 'We want to open a second shop abroad', null)) = 'submitted', 'a client states a goal');
select pg_temp.check((select count(*) from projects.client_feedback_for_client()) = 2 and (select count(*) from projects.client_feedback_for_client() where body like 'Wants to double%' or body like 'The client said%') = 0, 'the client reads only ITS OWN submissions, never a staff-entered row');
select pg_temp.check((select count(*) from projects.client_feedback) = 0, 'a client cannot read the feedback table');
select pg_temp.check((select outcome from projects.record_client_feedback(:'A_id', 'feedback', 'call', 'positive', 5, 'The client said something nice about us')) = 'not_authorized', 'NEGATIVE: a client cannot record staff feedback');
reset role;
select pg_temp.as_client(:'CLIENTBU', :'ORG', :'B2_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_feedback_for_client()) = 0, 'another client sees none of it');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.submit_client_feedback('feedback', 'positive', 5, 'Great work on the launch', null)) = 'not_a_client', 'NEGATIVE: staff cannot submit as a client');
select pg_temp.check((select outcome from projects.acknowledge_client_feedback(:'FB1_id', 'x')) = 'note_required', 'an acknowledgement needs a note');
select pg_temp.check((select outcome from projects.acknowledge_client_feedback(gen_random_uuid(), 'looked into it')) = 'not_found', 'unknown feedback');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.acknowledge_client_feedback(:'FB1_id', 'looked into it')) = 'not_found', 'another organization cannot acknowledge it');
reset role;

-- ═════════ 5. strategic / VIP designation: an Admin decision ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_designation(:'A_id', 'vip', 'Top five by recurring revenue', 'The owner decided after the renewal call')) = 'not_authorized', 'NEGATIVE: a member cannot designate');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_designation(:'A_id', 'bogus', 'Top five by recurring revenue', 'The owner decided after the renewal call')) = 'bad_designation', 'bad designation');
select pg_temp.check((select outcome from projects.set_client_designation(:'A_id', 'vip', 'short', 'The owner decided after the renewal call')) = 'criteria_required', 'the rule it was decided under is required');
select pg_temp.check((select outcome from projects.set_client_designation(:'A_id', 'vip', 'Top five by recurring revenue', 'short')) = 'reason_required', 'a reason is required');
select pg_temp.check((select outcome from projects.set_client_designation(:'X_id', 'vip', 'Top five by recurring revenue', 'The owner decided after the renewal call')) = 'not_found', 'another organization''s client is not found');
select status as "HEALTH_before" from projects.customer_health_status(:'PA_id') \gset
select pg_temp.check((select outcome from projects.set_client_designation(:'A_id', 'vip', 'Top five by recurring revenue', 'The owner decided after the renewal call')) = 'designated', 'an Admin designates a client VIP with a rule and a reason');
select pg_temp.check((select outcome from projects.set_client_designation(:'A_id', 'vip', 'Top five by recurring revenue', 'The owner decided after the renewal call')) = 'already_designated', 'once');
select pg_temp.check((select outcome from projects.set_client_designation(:'A_id', 'strategic', 'Reference customer for the retail vertical', 'Agreed in the quarterly review')) = 'designated', 'strategic is separate from vip');
select pg_temp.check((select status from projects.customer_health_status(:'PA_id')) = :'HEALTH_before', 'a designation changes no health');
select pg_temp.check((select outcome from projects.end_client_designation(:'A_id', 'vip', 'x')) = 'reason_required', 'ending needs a reason');
select pg_temp.check((select outcome from projects.end_client_designation(:'A_id', 'vip', 'Contract ended, no longer top five')) = 'ended', 'an Admin ends it with a reason');
select pg_temp.check((select outcome from projects.end_client_designation(:'A_id', 'vip', 'Contract ended, no longer top five')) = 'not_found', 'an ended designation cannot be ended again');
select pg_temp.check((select outcome from projects.set_client_designation(:'A_id', 'vip', 'Reinstated after renewal', 'Renewed for three years, owner reinstated')) = 'designated', 'after ending, a new designation is allowed and the old row is kept');
select pg_temp.check((select count(*) from projects.client_strategic_designations where client_account_id = :'A_id' and designation = 'vip') = 2, 'both vip rows exist');
reset role;
select pg_temp.check(pg_temp.direct(format('update projects.client_strategic_designations set reason = %L where client_account_id = %L', 'rewritten by hand', :'A_id'), 'through its door'), 'a direct write to a designation is refused');
select pg_temp.check(not has_function_privilege('service_role', 'projects.set_client_designation(uuid,text,text,text)', 'execute') and not has_function_privilege('service_role', 'projects.end_client_designation(uuid,text,text)', 'execute'), 'an agent (the service role) has no designation door');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_strategic_designations (organization_id, client_account_id, designation, criteria, reason, active, set_by) values (%L, %L, ''strategic'', ''a criteria text'', ''a reason that is long'', false, %L)', :'ORG', :'B_id', :'ADMIN'), 'client_designation_ended_says_why'), 'CHECK: an ended designation says why (table layer)');
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_strategic_designations) = 0, 'a client cannot see that it is designated');
reset role;

-- ═════════ 6. contact preferences ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_client_contact_preferences(:'B_id', 'whatsapp', 'hi', array['email'], :'BCT_id', 'told us on a call')) = 'set', 'a person records how the client wants to be contacted');
select pg_temp.check((select outcome from projects.set_client_contact_preferences(:'B_id', 'email', 'hi', array['email'])) = 'prefers_and_avoids_the_same_channel', 'one cannot both prefer and avoid a channel');
select pg_temp.check((select outcome from projects.set_client_contact_preferences(:'B_id', 'whatsapp', 'English', '{}')) = 'bad_language', 'a language is a code');
select pg_temp.check((select outcome from projects.set_client_contact_preferences(:'B_id', 'telegram', 'hi', '{}')) = 'bad_channel', 'bad channel');
select pg_temp.check((select outcome from projects.set_client_contact_preferences(:'B_id', 'whatsapp', 'hi', array['smoke'])) = 'bad_avoid_channel', 'bad avoided channel');
select pg_temp.check((select outcome from projects.set_client_contact_preferences(:'B_id', 'whatsapp', 'hi', '{}', :'ACT_id')) = 'contact_not_the_clients', 'the preferred contact must be the client''s own');
select pg_temp.check((select outcome from projects.set_client_contact_preferences(:'X_id', 'whatsapp', 'hi', '{}')) = 'not_found', 'another organization''s client is not found');
select pg_temp.check((select preferred_channel = 'whatsapp' and language = 'hi' and avoid_channels = array['email'] and source = 'person_recorded' from projects.client_contact_preferences where client_account_id = :'B_id'), 'the preference is stored with its source');
select pg_temp.check((select allowed is false and exists (select 1 from unnest(reasons) r where r like '%asked not to be contacted by email%') from projects.can_contact_now_with_preferences(:'B_id', 'email', 'relationship', :'BCT_id')), 'a channel the client asked us to avoid is a REASON not to contact');
select pg_temp.check((select allowed and 'the client prefers whatsapp' = any (advisories) and 'write in hi' = any (advisories) from projects.can_contact_now_with_preferences(:'B_id', 'call', 'relationship', :'BCT_id')), 'a preferred channel and language are ADVISORIES, not refusals');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.my_contact_preferences()) = 0, 'a client with no recorded preference reads none');
select pg_temp.check((select outcome from projects.set_my_contact_preferences('portal', 'en', array['call'], 'email me, do not ring')) = 'set', 'a client states its own preference');
select pg_temp.check((select preferred_channel = 'portal' and avoid_channels = array['call'] from projects.my_contact_preferences()), 'and reads it back');
select pg_temp.check((select count(*) from projects.client_contact_preferences) = 0, 'the table itself is not readable by a client');
reset role;
select pg_temp.check((select source = 'client_stated' from projects.client_contact_preferences where client_account_id = :'A_id'), 'the client''s own statement is marked as the client''s');
select pg_temp.as_client(:'CLIENTBU', :'ORG', :'B2_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.my_contact_preferences()) = 0, 'another client reads none of it');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_my_contact_preferences('portal', 'en', '{}')) = 'not_a_client', 'NEGATIVE: staff cannot use the client door');
reset role;
select pg_temp.check(pg_temp.direct(format('update projects.client_contact_preferences set language = %L where client_account_id = %L', 'fr', :'B_id'), 'through its door'), 'a direct write to a preference is refused');
select pg_temp.check(pg_temp.errs(format('insert into projects.client_contact_preferences (organization_id, client_account_id, preferred_channel, avoid_channels, source, set_by) values (%L, %L, ''email'', array[''email''], ''person_recorded'', %L)', :'ORG', :'A2_id', :'STAFF'), 'client_contact_preferences_consistent'), 'CHECK: prefer and avoid never the same (table layer)');

-- ═════════ 7. cadence per message category: Admin-set, no default ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_communication_cadence_rule('relationship', null, 7)) = 'not_authorized', 'NEGATIVE: a member cannot set a cadence');
select pg_temp.check((select outcome from projects.record_client_communication(:'B_id', 'call', 'relationship', 'Rang the client about the new feature', null, null, now() - interval '3 days')) = 'recorded', 'fixture: a relationship call three days ago');
select pg_temp.check((select allowed from projects.can_contact_now_with_preferences(:'B_id', 'call', 'relationship', :'BCT_id')), 'with no cadence rule there is no cadence (no default number)');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_communication_cadence_rule('relationship', null, 0)) = 'out_of_range', 'range refused');
select pg_temp.check((select outcome from projects.set_communication_cadence_rule('gossip', null, 7)) = 'bad_purpose', 'bad purpose refused');
select pg_temp.check((select outcome from projects.set_communication_cadence_rule('relationship', 'pigeon', 7)) = 'bad_channel', 'bad channel refused');
select pg_temp.check((select outcome from projects.set_communication_cadence_rule('relationship', null, 7)) = 'set', 'an Admin sets a minimum gap of seven days for relationship contacts');
select pg_temp.check((select not allowed and exists (select 1 from unnest(reasons) r where r like 'cadence:%') from projects.can_contact_now_with_preferences(:'B_id', 'call', 'relationship', :'BCT_id')), 'a relationship contact three days after the last is refused for cadence');
select pg_temp.check((select allowed from projects.can_contact_now_with_preferences(:'B_id', 'call', 'relationship', :'BCT_id', now() + interval '5 days')), 'and allowed once the gap has passed');
select pg_temp.check((select allowed from projects.can_contact_now_with_preferences(:'B_id', 'call', 'commercial', :'BCT_id')) and (select allowed from projects.can_contact_now_with_preferences(:'B_id', 'call', 'operational', :'BCT_id')), 'the rule is per purpose: commercial and operational are not held by it');
select pg_temp.check((select outcome from projects.set_communication_cadence_rule('commercial', 'email', 30)) = 'set', 'a channel-specific rule');
select pg_temp.check((select outcome from projects.clear_communication_cadence_rule('relationship', null)) = 'cleared', 'an Admin clears it');
select pg_temp.check((select outcome from projects.clear_communication_cadence_rule('relationship', null)) = 'not_found', 'once');
select pg_temp.check((select allowed from projects.can_contact_now_with_preferences(:'B_id', 'call', 'relationship', :'BCT_id')), 'after clearing the cadence no longer holds');
reset role;
select pg_temp.as_service();
select outcome as "DR_out" from projects.record_agent_communication_draft(:'ORG', :'B_id', 'call', 'relationship', 'Draft: a check-in call script for the client', 'customer_success') \gset
select pg_temp.check(:'DR_out' = 'drafted', 'fixture: an agent drafts a contact');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_communication_cadence_rule('relationship', null, 1)) = 'set', 'rule back on');
select pg_temp.check((select allowed from projects.can_contact_now_with_preferences(:'A2_id', 'call', 'relationship')), 'a client with no person-sent contact is not held by it (and an agent draft is not a contact)');
reset role;
select pg_temp.check(pg_temp.direct(format('update projects.communication_cadence_rules set min_gap_days = 99 where organization_id = %L', :'ORG'), 'through its door'), 'a direct write to a cadence rule is refused');
select pg_temp.check(not has_function_privilege('service_role', 'projects.set_communication_cadence_rule(text,text,integer)', 'execute'), 'the service role has no cadence door');

-- ═════════ 8. the approved knowledge base ═════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.propose_knowledge_article('Bad Key!', 'Exporting your data', 'Open Settings, choose Export, pick a format and press the Export button.')) = 'bad_key', 'a key is a slug');
select pg_temp.check((select outcome from projects.propose_knowledge_article('export-data', 'Exporting your data', 'too short')) = 'bad_body', 'a body is required');
select pg_temp.check((select outcome from projects.propose_knowledge_article('export-data', 'Exporting your data', 'Open Settings, choose Export, and we can give you a discount on it.')) = 'names_a_price', 'an article names no price or discount');
select pg_temp.check((select outcome from projects.propose_knowledge_article('export-data', 'Exporting your data', 'Use the password: hunter2hunter2 to log in and then press Export.')) = 'contains_secret', 'an article holds no secret');
select outcome as "KA1_out", article_id as "KA1_id", version as "KA1_v" from projects.propose_knowledge_article('export-data', 'Exporting your data', 'Open Settings, choose Export, pick a format and press the Export button.', true) \gset
select pg_temp.check(:'KA1_out' = 'proposed' and :'KA1_v' = '1', 'a person proposes version 1 as a draft');
select pg_temp.check((select outcome from projects.propose_knowledge_article('export-data', 'Exporting your data', 'Open Settings, choose Export, pick a format and press Export again.')) = 'draft_exists', 'one draft per article at a time');
select pg_temp.check((select outcome from projects.approve_knowledge_article(:'KA1_id')) = 'author_cannot_approve', 'the AUTHOR cannot approve their own article');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.approve_knowledge_article(:'KA1_id')) = 'not_authorized', 'NEGATIVE: a member cannot approve');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.approve_knowledge_article(gen_random_uuid())) = 'not_found', 'unknown article');
select pg_temp.check((select outcome from projects.approve_knowledge_article(:'KA1_id')) = 'approved', 'an independent Admin approves');
select pg_temp.check((select outcome from projects.approve_knowledge_article(:'KA1_id')) = 'not_a_draft', 'once');
reset role;
select pg_temp.check(pg_temp.sanctioned(format('update projects.support_knowledge_articles set body = %L where id = %L', 'An edited body that is long enough to pass', :'KA1_id'), 'never edited'), 'an approved body is never edited (the table''s own rule)');
select pg_temp.check(pg_temp.direct(format('update projects.support_knowledge_articles set retire_reason = %L where id = %L', 'Edited by hand', :'KA1_id'), 'through its door'), 'and no direct write at all');
select pg_temp.check(pg_temp.errs(format('insert into projects.support_knowledge_articles (organization_id, article_key, version, title, body, status, proposed_by, approved_by, approved_at) values (%L, ''self-approved'', 1, ''Self approved'', ''A body that is long enough to pass the length check'', ''approved'', %L, %L, now())', :'ORG', :'ADMIN', :'ADMIN'), 'knowledge_approved_by_an_independent_person'), 'CHECK: approval is never the author (table layer)');
select pg_temp.check(pg_temp.errs(format('insert into projects.support_knowledge_articles (organization_id, article_key, version, title, body, status, proposed_by, approved_by, approved_at) values (%L, ''export-data'', 9, ''Second approved'', ''A body that is long enough to pass the length check'', ''approved'', %L, %L, now())', :'ORG', :'ADMIN', :'OWNER'), 'knowledge_one_approved_per_key'), 'one approved version per article (table layer)');
-- version 2 retires version 1 on approval
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select outcome as "KA2_out", article_id as "KA2_id", version as "KA2_v" from projects.propose_knowledge_article('export-data', 'Exporting your data', 'Open Settings, choose Export, pick CSV or PDF and press the Export button.', true) \gset
select pg_temp.check(:'KA2_out' = 'proposed' and :'KA2_v' = '2', 'a change is a NEW version');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.approve_knowledge_article(:'KA2_id')) = 'approved', 'version 2 is approved');
reset role;
select pg_temp.check((select status = 'retired' and retire_reason = 'superseded by version 2' from projects.support_knowledge_articles where id = :'KA1_id')
                     and (select count(*) from projects.support_knowledge_articles where organization_id = :'ORG' and article_key = 'export-data' and status = 'approved') = 1, 'approving version 2 retired version 1 (and only one version is approved)');
select pg_temp.check(pg_temp.sanctioned(format('update projects.support_knowledge_articles set status = ''approved'' where id = %L', :'KA1_id'), 'stays retired'), 'a retired article stays retired');
-- the support agent proposes; only the support agent
select pg_temp.as_service();
select outcome as "KA3_out", article_id as "KA3_id" from projects.propose_knowledge_article_as_agent(:'ORG', 'support', 'reset-password', 'Resetting your password', 'Choose Forgot password on the sign in page and follow the email link we send you.', false) \gset
select pg_temp.check(:'KA3_out' = 'proposed' and (select proposed_by_agent = 'support' and proposed_by is null and status = 'draft' from projects.support_knowledge_articles where id = :'KA3_id'), 'the support agent proposes a DRAFT, attributed to it');
select pg_temp.check((select outcome from projects.propose_knowledge_article_as_agent(:'ORG', 'customer_success', 'reset-two', 'Another one', 'Choose Forgot password on the sign in page and follow the email link we send you.')) = 'not_the_support_agent', 'no other agent proposes knowledge');
select pg_temp.check((select outcome from projects.propose_knowledge_article_as_agent(gen_random_uuid(), 'support', 'reset-three', 'Another one', 'Choose Forgot password on the sign in page and follow the email link we send you.')) = 'not_found', 'an unknown organization');
select pg_temp.check((select status from projects.support_knowledge_articles where id = :'KA3_id') = 'draft', 'an agent''s draft is not approved by being written');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.approve_knowledge_article(:'KA3_id')) = 'approved', 'an Admin approves the agent''s draft');
select pg_temp.check((select outcome from projects.retire_knowledge_article(:'KA3_id', 'x')) = 'reason_required', 'retiring needs a reason');
reset role;
-- citing: only an approved article
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(:'T1_id', :'KA2_id')) = 'cited', 'a person cites an approved article for a ticket');
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(:'T1_id', :'KA2_id')) = 'already_cited', 'once');
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(:'T1_id', :'KA1_id')) = 'article_not_approved', 'a retired article cannot be cited');
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(gen_random_uuid(), :'KA2_id')) = 'ticket_not_found', 'unknown ticket');
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(:'T1_id', gen_random_uuid())) = 'article_not_found', 'unknown article');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket(:'T1_id', :'KA2_id')) = 'ticket_not_found', 'another organization cannot cite for this ticket');
reset role;
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket_as_agent(:'ORG', 'support', :'T1_id', :'KA3_id')) = 'cited', 'the support agent cites an approved article');
select pg_temp.check((select count(*) from projects.ticket_knowledge_citations where ticket_id = :'T1_id' and cited_by_agent = 'support' and cited_by is null) = 1, 'and the citation is attributed to the agent, not to a person');
select pg_temp.check((select outcome from projects.cite_knowledge_for_ticket_as_agent(:'ORG', 'finance', :'T1_id', :'KA3_id')) = 'not_the_support_agent', 'no other agent cites');
select pg_temp.check(pg_temp.errs(format('update projects.ticket_knowledge_citations set article_version = 9 where ticket_id = %L', :'T1_id'), 'history'), 'a citation is history');
-- the client reads approved + client-safe articles only
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_knowledge_articles() where article_key = 'export-data' and version = 2) = 1
                     and (select count(*) from projects.client_knowledge_articles() where article_key = 'reset-password') = 0
                     and (select count(*) from projects.client_knowledge_articles() where version = 1) = 0, 'a client reads only APPROVED, client-safe articles (not a retired version, not an internal one)');
select pg_temp.check((select count(*) from projects.support_knowledge_articles) = 0, 'and not the table');
reset role;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_knowledge_articles()) = 0, 'staff get nothing from the client read');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.retire_knowledge_article(:'KA3_id', 'Replaced by a better guide')) = 'retired' and (select outcome from projects.retire_knowledge_article(:'KA3_id', 'Replaced by a better guide')) = 'already_retired', 'an Admin retires an article, once');
select pg_temp.check((select outcome from projects.approve_knowledge_article(:'KA3_id')) = 'not_a_draft', 'a retired article is not approved again');
reset role;

-- ═════════ 9. scope reference ═════════
alter table projects.scope_items disable trigger refuse_frozen_scope_item;
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SVA_id', 'Online checkout', 'included') returning id as "SI_in" \gset
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SVA_id', 'Native mobile app', 'excluded') returning id as "SI_ex" \gset
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SVA2_id', 'Other project item', 'included') returning id as "SI_other" \gset
alter table projects.scope_items enable trigger refuse_frozen_scope_item;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'inside_scope', :'SI_in', 'The checkout failure is behaviour the approved scope promises')) = 'recorded', 'a person records that the behaviour is INSIDE the approved scope');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'inside_scope', :'SI_in', 'The checkout failure is behaviour the approved scope promises')) = 'already_recorded', 'once');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'inside_scope', :'SI_ex', 'The native app is promised by the approved scope')) = 'item_is_not_included', 'inside_scope cannot rest on an excluded item');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'excluded', :'SI_in', 'The checkout is explicitly excluded from the scope')) = 'item_is_not_excluded', 'excluded cannot rest on an included item');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'excluded', :'SI_ex', 'The native app is explicitly excluded from the approved scope')) = 'recorded', 'an explicit exclusion is recorded');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'inside_scope', null, 'Believed to be inside the scope but no item named')) = 'scope_item_required', 'inside_scope names its item');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'outside_scope', :'SI_in', 'Nothing in the scope covers this new request')) = 'outside_scope_names_no_item', 'outside_scope names none');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'outside_scope', null, 'Nothing in the scope covers this new request')) = 'recorded', 'outside scope, with no item');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'inside_scope', :'SI_other', 'An item that belongs to a different project entirely')) = 'item_not_in_the_approved_scope', 'an item outside THIS project''s approved scope version is refused');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'unclear', null, 'short')) = 'note_required', 'a note is required');
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'sideways', null, 'A note that is long enough here')) = 'bad_relation', 'bad relation');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T1_id', 'unclear', null, 'Trying to reach another tenant''s ticket')) = 'ticket_not_found', 'another organization cannot reference a ticket');
reset role;
-- a ticket whose workspace has no approved scope version
select pg_temp.ticket(:'PA2_id', 'G1-T2') as "T2_id" \gset
alter table projects.phase_eight_intake disable trigger user;
update projects.phase_eight_intake set scope_version_id = null where project_id = :'PA2_id';
alter table projects.phase_eight_intake enable trigger user;
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_ticket_scope_reference(:'T2_id', 'unclear', null, 'There is no approved scope version to compare to')) = 'no_approved_scope_version', 'with no approved scope version there is nothing to compare against');
reset role;
select pg_temp.as_service();
select outcome as "SR_out", reference_id as "SR_id" from projects.propose_ticket_scope_reference_as_agent(:'ORG', 'support', :'T1_id', 'unclear', null, 'The report might be about the reporting module, which the scope does not name') \gset
select pg_temp.check(:'SR_out' = 'proposed' and (select status = 'proposed' and proposed_by_agent = 'support' and confirmed_by is null from projects.ticket_scope_references where id = :'SR_id'), 'the support agent PROPOSES a comparison (unconfirmed)');
select pg_temp.check((select outcome from projects.propose_ticket_scope_reference_as_agent(:'ORG', 'upsell', :'T1_id', 'unclear', null, 'The report might be about something else entirely')) = 'not_the_support_agent', 'no other agent proposes one');
select pg_temp.as_user(:'STAFF2', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.ticket_scope_comparison(:'T1_id')) = 4 and (select count(*) from projects.ticket_scope_comparison(:'T1_id') where scope_item_title = 'Native mobile app' and scope_item_inclusion = 'excluded') = 1, 'the comparison read returns the references with the item''s title and inclusion');
select pg_temp.check((select outcome from projects.confirm_ticket_scope_reference(:'SR_id')) = 'confirmed' and (select outcome from projects.confirm_ticket_scope_reference(:'SR_id')) = 'already_confirmed', 'a person confirms the proposal, once');
reset role;
select pg_temp.check((select classification = 'warranty_bug' from projects.support_tickets where id = :'T1_id'), 'a scope reference never reclassifies the ticket');
select pg_temp.check(pg_temp.errs(format('update projects.ticket_scope_references set status = ''confirmed'' where id = %L', :'SR_id'), 'ticket_scope_references_p8_guard') or pg_temp.direct(format('update projects.ticket_scope_references set note = %L where id = %L', 'rewritten by hand to say otherwise', :'SR_id'), 'through its door'), 'no direct write to a reference');
select pg_temp.check(pg_temp.errs(format('insert into projects.ticket_scope_references (organization_id, ticket_id, scope_version_id, relation, note, status, proposed_by_agent) values (%L, %L, %L, ''outside_scope'', ''a note that is long enough'', ''confirmed'', ''support'')', :'ORG', :'T1_id', :'SVA_id'), 'scope_ref_confirmed_is_a_person'), 'CHECK: confirmed means a person confirmed (table layer)');
select pg_temp.check(pg_temp.errs(format('insert into projects.ticket_scope_references (organization_id, ticket_id, scope_version_id, relation, note, status, proposed_by_agent) values (%L, %L, %L, ''inside_scope'', ''a note that is long enough'', ''proposed'', ''support'')', :'ORG', :'T1_id', :'SVA_id'), 'scope_ref_names_its_item'), 'CHECK: inside_scope names its item (table layer)');
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.ticket_scope_comparison(:'T1_id')) = 0 and (select count(*) from projects.ticket_scope_references) = 0, 'a client sees no scope comparison');
reset role;

-- ═════════ 10. developer / QA requests ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "H1_out", request_id as "H1_id" from projects.request_ticket_handoff(:'T1_id', 'developer', 'The login failure needs a code fix in the delivered scope') \gset
select pg_temp.check(:'H1_out' = 'requested', 'a person asks for a developer on a classified fault');
select pg_temp.check((select payload ->> 'ticketRef' = t.ticket_ref and payload ->> 'classification' = 'warranty_bug' and payload ->> 'priority' = 'p2' and payload ->> 'projectId' = t.project_id::text
                        from projects.support_handoff_requests r join projects.support_tickets t on t.id = r.ticket_id where r.id = :'H1_id'), 'the payload is the TICKET ROW''s facts, not the caller''s');
select pg_temp.check((select outcome from projects.request_ticket_handoff(:'T1_id', 'developer', 'The login failure needs a code fix in the delivered scope')) = 'already_requested', 'a retried request is the same request');
select pg_temp.check((select outcome from projects.request_ticket_handoff(:'T1_id', 'quality_assurance', 'Please verify the login fix before release')) = 'nothing_to_verify_yet', 'QA is asked only once there is work to verify');
select pg_temp.check((select outcome from projects.request_ticket_handoff(:'T1_id', 'sales', 'Please take this one over from support')) = 'bad_target', 'only developer and QA');
select pg_temp.check((select outcome from projects.request_ticket_handoff(:'T1_id', 'developer', 'short')) = 'reason_required', 'a reason is required');
select pg_temp.check((select outcome from projects.request_ticket_handoff(:'T2_id', 'developer', 'This ticket has not been classified at all')) = 'classification_does_not_need_a_developer', 'an unclassified ticket is not yet known to need a developer');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.request_ticket_handoff(:'T1_id', 'developer', 'Reaching into another tenant''s ticket')) = 'ticket_not_found', 'another organization cannot ask for work on this ticket');
select pg_temp.check((select outcome from projects.settle_ticket_handoff(:'H1_id', 'acknowledged')) = 'not_found', 'nor settle it');
reset role;
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.request_ticket_handoff_as_agent(:'ORG', 'support', :'T1_id', 'developer', 'Another go at the same developer request')) = 'already_requested', 'the agent door is idempotent on the live request');
select pg_temp.check((select outcome from projects.request_ticket_handoff_as_agent(:'ORG', 'customer_success', :'T1_id', 'developer', 'Customer success has no edge to the developer')) = 'no_handoff_edge', 'an agent may hand work only along an edge the roster allows');
select pg_temp.check((select outcome from projects.request_ticket_handoff_as_agent(:'ORG', 'finance', :'T1_id', 'developer', 'Finance is not a support or customer success agent')) = 'not_a_support_or_customer_success_agent', 'only support and customer success agents');
select pg_temp.ticket(:'PA_id', 'G1-T3') as "T3_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.classify_support_ticket(:'T3_id', 'how_to', 'included_support', 'a how-to question about exports', 'p4', null)) = 'classified', 'fixture: T3 is a how-to');
select pg_temp.check((select outcome from projects.request_ticket_handoff(:'T3_id', 'developer', 'A how-to question is not a developer task')) = 'classification_does_not_need_a_developer', 'a how-to is never a developer task');
select outcome as "T3_asg" from projects.assign_support_ticket(:'T3_id', :'STAFF') \gset
select outcome as "T3_adv" from projects.advance_support_ticket(:'T3_id', 'in_progress') \gset
select pg_temp.check(:'T3_asg' = 'assigned' and :'T3_adv' = 'advanced', 'fixture: T3 is in progress');
select pg_temp.check((select outcome from projects.request_ticket_handoff(:'T3_id', 'quality_assurance', 'Please verify the answer given on this ticket')) = 'requested', 'once in progress, QA can be asked');
reset role;
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.request_ticket_handoff_as_agent(:'ORG', 'support', :'T3_id', 'developer', 'A how-to question is not a developer task')) = 'classification_does_not_need_a_developer', 'and the agent door says the same');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.settle_ticket_handoff(:'H1_id', 'acknowledged')) = 'acknowledged', 'a person acknowledges the request');
select pg_temp.check((select outcome from projects.settle_ticket_handoff(:'H1_id', 'acknowledged')) = 'already_acknowledged', 'once');
select pg_temp.check((select outcome from projects.settle_ticket_handoff(:'H1_id', 'completed')) = 'note_required', 'completing needs a note');
select pg_temp.check((select outcome from projects.settle_ticket_handoff(:'H1_id', 'maybe', 'a note that is fine')) = 'bad_decision', 'bad decision');
select pg_temp.check((select outcome from projects.settle_ticket_handoff(:'H1_id', 'completed', 'Developer fixed it and released')) = 'completed', 'completed with a note');
select pg_temp.check((select outcome from projects.settle_ticket_handoff(:'H1_id', 'declined', 'Changed my mind about it')) = 'already_settled', 'a settled request is history');
select pg_temp.check((select outcome from projects.request_ticket_handoff(:'T1_id', 'developer', 'A second fault surfaced on the same ticket')) = 'requested', 'after settling, a new request can be made');
reset role;
select pg_temp.check(pg_temp.direct(format('update projects.support_handoff_requests set status = ''completed'' where id = %L', :'H1_id'), 'through its door'), 'no direct write to a request');
select pg_temp.check((select count(*) from projects.maintenance_items where organization_id = :'ORG') = 0, 'no maintenance task was created by any request (a person creates the work through its own door)');
select pg_temp.check(pg_temp.errs(format('insert into projects.support_handoff_requests (organization_id, ticket_id, target, reason, payload, status, requested_by) values (%L, %L, ''developer'', ''a reason that is long enough'', ''{}'', ''completed'', %L)', :'ORG', :'T3_id', :'STAFF'), 'handoff_request_settled_is_a_persons'), 'CHECK: settled means a person settled it with a note (table layer)');

-- ═════════ 11. the next-action queue ═════════
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.escalate_support_ticket(:'T1_id', 'ops_admin', 'The client is very upset about this one')) = 'escalated', 'fixture: T1 is escalated to an Admin');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from projects.cs_next_actions() where action_kind = 'escalation_unacknowledged' and subject_id = :'T1_id' and rank = 1) = 1, 'an escalation nobody acknowledged is rank 1');
select pg_temp.check((select count(*) from projects.cs_next_actions() where action_kind = 'negative_feedback_unacknowledged' and subject_id = :'FB1_id') = 1 and (select count(*) from projects.cs_next_actions() where action_kind = 'negative_feedback_unacknowledged' and subject_id = :'CF1_id') = 1, 'negative feedback (staff-recorded and client-submitted) is a next action');
select pg_temp.check((select count(*) from projects.cs_next_actions() where action_kind = 'handoff_request_pending') >= 1, 'a pending developer request is a next action');
select pg_temp.check((select designation from projects.cs_next_actions() where action_kind = 'escalation_unacknowledged' and subject_id = :'T1_id') = 'strategic', 'the client''s designation is shown beside the action');
select pg_temp.check((select count(*) from projects.cs_next_actions() where action_kind = 'ticket_awaiting_first_response' and subject_id = :'T3_id') = 1, 'a ticket awaiting its first response is listed');
select pg_temp.check((select outcome from projects.acknowledge_support_escalation(:'T1_id', 'on it')) = 'acknowledged', 'fixture: an Admin acknowledges the escalation');
select pg_temp.check((select count(*) from projects.cs_next_actions() where action_kind = 'escalation_unacknowledged' and subject_id = :'T1_id') = 0, 'and it leaves the queue');
select pg_temp.check((select outcome from projects.acknowledge_client_feedback(:'FB1_id', 'Called the client and apologised')) = 'acknowledged', 'fixture: negative feedback acknowledged');
select pg_temp.check((select count(*) from projects.cs_next_actions() where subject_id = :'FB1_id') = 0 and (select count(*) from projects.cs_next_actions() where subject_id = :'CF1_id') = 1, 'it leaves the queue, and only that one');
select pg_temp.check((select count(*) from projects.cs_next_actions() where action_kind = 'scope_reference_to_confirm') = 0, 'a confirmed scope reference is not a next action');
reset role;
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.propose_ticket_scope_reference_as_agent(:'ORG', 'support', :'T3_id', 'outside_scope', null, 'The how-to question mentions a feature the scope does not name')) = 'proposed', 'fixture: an unconfirmed proposal');
select outcome as "CI_out" from projects.create_check_in(:'PA_id', 'adoption', 'g1-adoption', current_date, null, null, :'ORG') \gset
select pg_temp.check(:'CI_out' = 'created', 'fixture: a check-in due today');
select response_breaches as "SW_resp" from projects.sweep_support_sla(:'ORG', now() + interval '400 hours') \gset
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from projects.cs_next_actions() where action_kind = 'scope_reference_to_confirm') >= 1, 'an unconfirmed agent proposal is a next action');
select pg_temp.check((select count(*) from projects.cs_next_actions() where action_kind = 'check_in_due' and project_id = :'PA_id') >= 1, 'a due check-in is a next action');
select pg_temp.check((select count(*) from projects.cs_next_actions() where action_kind = 'ticket_sla_breached' and subject_id = :'T3_id') = 1, 'a ticket past its SLA is a next action (rank 2)');
select pg_temp.check((select array_agg(rank) from projects.cs_next_actions()) = (select array_agg(rank order by rank) from projects.cs_next_actions()), 'the queue is ordered by the fixed rank');
select pg_temp.check((select count(*) from projects.cs_next_actions() where project_id = :'PX_id') = 0, 'another organization''s work is never in the queue');
reset role;
select pg_temp.as_user(:'BSTAFF', :'ORGB', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.cs_next_actions()) = 0, 'staff of another organization see none of it');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.cs_next_actions()) = 0, 'a client sees no queue');
reset role;

-- ═════════ 12. the post-launch Sales discovery brief ═════════
select pg_temp.ticket(:'PA_id', 'G1-T4') as "T4_id" \gset
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "T4_class" from projects.classify_support_ticket(:'T4_id', 'change_request', 'not_covered', 'a new loyalty feature is new scope', 'p4', null) \gset
reset role;
select pg_temp.check(:'T4_class' = 'classified', 'fixture: T4 is a change request');
select pg_temp.as_service();
select outcome as "OP_out", opportunity_id as "OP_id" from sales.record_phase_eight_opportunity(:'PA_id', 'change_request', 'The client has asked twice for a loyalty points programme for returning customers',
  jsonb_build_array(jsonb_build_object('type', 'ticket', 'id', :'T4_id')), 'loyalty points', 'normal', null, null, 'upsell', :'ORG') \gset
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief for an opportunity nobody qualified yet', '["What reports do you need each month?"]', jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id')))) = 'opportunity_not_qualified', 'the Sales agent does not work an opportunity a person has not qualified');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select outcome as "Q_out" from sales.qualify_phase_eight_opportunity(:'OP_id', 'qualify', 'a genuine reporting need') \gset
reset role;
select pg_temp.check(:'Q_out' in ('qualified', 'recovery_first'), 'fixture: qualification attempted: ' || :'Q_out');
-- recovery_first would block qualification; force the state for the brief only when the account is held
update sales.phase_eight_opportunities set status = 'qualified', qualified_by = :'STAFF', qualified_at = now() where id = :'OP_id' and status <> 'qualified';
select pg_temp.as_service();
select count(*) as "SALES_deals_before" from sales.opportunities where organization_id = :'ORG' \gset
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'upsell', 'A brief that comes from the wrong agent entirely', '["What reports do you need each month?"]', jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id')))) = 'not_the_sales_agent', 'only the sales agent drafts a brief');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief that offers a discount on the reporting module', '["What reports do you need each month?"]', jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id')))) = 'names_a_price', 'a brief names no discount');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '["Would 5000 rupees a month be fine for you?"]', jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id')))) = 'names_a_price', 'nor a price in a question');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '[]', jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id')))) = 'bad_questions', 'at least one question');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '["short"]', jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id')))) = 'bad_questions', 'a real question');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '["What reports do you need each month?"]', '{}')) = 'context_required', 'it must cite the Customer 360 records it used');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '["What reports do you need each month?"]', jsonb_build_object('colour', 'red'))) = 'unknown_context_key', 'only known citations');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '["What reports do you need each month?"]', jsonb_build_object('ticketIds', jsonb_build_array(:'T2_id')))) = 'context_not_this_clients', 'a ticket of ANOTHER project is refused');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '["What reports do you need each month?"]', jsonb_build_object('ticketIds', jsonb_build_array(gen_random_uuid())))) = 'context_not_this_clients', 'an unknown id is refused');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORGB', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '["What reports do you need each month?"]', jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id')))) = 'not_found', 'the opportunity is read for the claimed organization only');
select outcome as "B1_out", brief_id as "B1_id" from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '["What reports do you need each month?", "Who reads these reports today?"]',
  jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id'), 'checkInIds', (select jsonb_agg(id) from projects.cs_check_ins where project_id = :'PA_id' and period_key = 'g1-adoption'))) \gset
select pg_temp.check(:'B1_out' = 'drafted', 'the sales agent drafts a brief citing real records');
select pg_temp.check((select outcome from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A brief about the reporting module the client wants', '["What reports do you need each month?", "Who reads these reports today?"]',
  jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id')))) = 'already_recorded', 'the same brief is not recorded twice');
select outcome as "B2_out", brief_id as "B2_id" from projects.record_discovery_brief_draft(:'ORG', :'OP_id', 'sales', 'A better brief about the reporting module the client wants', '["What reports do you need each month?"]', jsonb_build_object('ticketIds', jsonb_build_array(:'T3_id'))) \gset
select pg_temp.check(:'B2_out' = 'drafted' and (select status from projects.sales_discovery_briefs where id = :'B1_id') = 'superseded' and (select count(*) from projects.sales_discovery_briefs where opportunity_id = :'OP_id' and status = 'draft') = 1, 'a changed brief is version 2 and supersedes the first draft');
select pg_temp.as_user(:'STAFF', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_discovery_brief(:'B1_id')) = 'not_a_draft', 'a superseded brief is not reviewed');
select pg_temp.check((select outcome from projects.review_discovery_brief(:'B2_id', 'Questions look right')) = 'reviewed', 'a person reviews the draft');
select pg_temp.check((select outcome from projects.review_discovery_brief(:'B2_id')) = 'already_reviewed', 'once');
select pg_temp.check(pg_temp.errs('select * from projects.record_discovery_brief_draft(' || quote_literal(:'ORG') || '::uuid, ' || quote_literal(:'OP_id') || '::uuid, ''sales'', ''A brief written by a signed-in person'', ''["What reports do you need?"]''::jsonb, ''{}''::jsonb)', 'permission denied'), 'NEGATIVE: a signed-in person cannot call the agent door');
reset role;
select pg_temp.as_client(:'CLIENTU', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.sales_discovery_briefs) = 0, 'a client reads no brief');
reset role;
select pg_temp.check((select count(*) from sales.opportunities where organization_id = :'ORG') = :'SALES_deals_before'::bigint, 'no deal was opened or changed by the brief doors');
select pg_temp.check(pg_temp.direct(format('update projects.sales_discovery_briefs set summary = %L where id = %L', 'A summary rewritten by hand with enough length', :'B2_id'), 'through its door'), 'no direct write to a brief');
select pg_temp.check(pg_temp.errs(format('insert into projects.sales_discovery_briefs (organization_id, opportunity_id, version, summary, questions, context_refs, drafted_by_agent) values (%L, %L, 9, ''We can give them a discount on it, say twenty percent'', ''["What reports do you need each month?"]'', ''{}'', ''sales'')', :'ORG', :'OP_id'), 'discovery_brief_names_no_price'), 'CHECK: no price in a brief (table layer)');
select pg_temp.check(pg_temp.errs(format('insert into projects.sales_discovery_briefs (organization_id, opportunity_id, version, summary, questions, context_refs, drafted_by_agent, status) values (%L, %L, 10, ''A summary that is certainly long enough'', ''["What reports do you need each month?"]'', ''{}'', ''sales'', ''reviewed'')', :'ORG', :'OP_id'), 'discovery_brief_reviewed_is_a_person'), 'CHECK: reviewed means a person reviewed (table layer)');

-- ═════════ 13. E2E-14: the metrics reconcile ═════════
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select coalesce(sum(open_tickets), 0) from projects.customer_success_overview())
                     = (select coalesce(sum(n), 0) from projects.phase_eight_observability() where metric = 'tickets_by_state' and bucket not in ('closed', 'cancelled')),
                     'RECONCILE: open tickets in the overview equal open tickets in the observability read');
select pg_temp.check((select coalesce(sum(open_tickets), 0) from projects.customer_success_overview())
                     = (select count(*) from projects.support_tickets t join projects.phase_eight w on w.project_id = t.project_id and w.state <> 'closed' where t.organization_id = :'ORG' and t.status not in ('closed', 'cancelled')),
                     'RECONCILE: and equal the raw count of open tickets in live workspaces');
select pg_temp.check((select coalesce(sum(open_recovery_plans), 0) from projects.customer_success_overview())
                     = (select coalesce(sum(n), 0) from projects.phase_eight_observability() where metric = 'recovery_plans'), 'RECONCILE: open recovery plans agree between the overview and the observability read');
select pg_temp.check((select coalesce(sum(due_check_ins), 0) from projects.customer_success_overview())
                     = (select count(*) from projects.cs_next_actions() where action_kind = 'check_in_due'), 'RECONCILE: due check-ins agree between the overview and the next-action queue');
select pg_temp.check((select count(*) from projects.customer_success_overview())
                     = (select coalesce(sum(n), 0) from projects.phase_eight_observability() where metric = 'health_distribution'), 'RECONCILE: live workspaces equal the health distribution total');
select pg_temp.check((select coalesce(sum(n), 0) from projects.phase_eight_observability() where metric = 'opportunities_by_stage' and bucket = 'qualified')
                     = (select count(*) from projects.cs_next_actions() where action_kind = 'opportunity_to_hand_off'), 'RECONCILE: qualified opportunities agree between observability and the queue');
reset role;

-- ═════════ 14. structure, grants and tenancy ═════════
create temp table g1_tables (tbl text);
insert into g1_tables values ('phase_eight_access_denials'), ('client_feedback'), ('client_feedback_acknowledgements'), ('client_strategic_designations'), ('client_contact_preferences'),
  ('communication_cadence_rules'), ('support_knowledge_articles'), ('ticket_knowledge_citations'), ('ticket_scope_references'), ('support_handoff_requests'), ('sales_discovery_briefs');
grant select on g1_tables to public;
select pg_temp.check((select count(*) from g1_tables t join pg_class c on c.relname = t.tbl join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'projects' where c.relrowsecurity) = 11, 'every new table has row security on');
select pg_temp.check((select count(*) from g1_tables t join pg_policies p on p.schemaname = 'projects' and p.tablename = t.tbl and p.cmd = 'SELECT' where p.qual like '%is_internal%' and p.qual like '%current_organization_id%') = 11, 'every new table has the internal-only, organization-scoped read policy');
select pg_temp.check((select count(*) from pg_policies p where p.schemaname = 'projects' and p.tablename = 'phase_eight_access_denials' and p.qual like '%is_admin%') = 1, 'and the denial log additionally requires an Admin');
select pg_temp.check((select count(*) from g1_tables t join pg_policies p on p.schemaname = 'projects' and p.tablename = t.tbl where p.cmd <> 'SELECT') = 0, 'and no write policy');
select pg_temp.check((select count(*) from g1_tables t where has_table_privilege('authenticated', 'projects.' || t.tbl, 'insert') or has_table_privilege('authenticated', 'projects.' || t.tbl, 'update') or has_table_privilege('authenticated', 'projects.' || t.tbl, 'delete')
                          or has_table_privilege('anon', 'projects.' || t.tbl, 'select') or not has_table_privilege('service_role', 'projects.' || t.tbl, 'select')) = 0, 'authenticated can only read, anon nothing, the service role everything');
select pg_temp.as_service();
select pg_temp.check((select count(*) from core.unguarded_org_fks() u where u.child in (select 'projects.' || tbl from g1_tables)) = 0, 'TENANCY: every org-scoped foreign key of the new tables has its parent-org guard');
select pg_temp.check((select count(*) from core.unfrozen_org_tables() u where u.org_table in (select 'projects.' || tbl from g1_tables)) = 0, 'TENANCY: every new table freezes its organization_id');
select pg_temp.check((select count(*) from pg_trigger tg join pg_class c on c.oid = tg.tgrelid where c.relname in ('phase_eight_access_denials', 'client_feedback', 'client_feedback_acknowledgements', 'ticket_knowledge_citations') and tg.tgname like '%append_only' and not tg.tgisinternal) = 4, 'the four history tables carry the append-only guard');
select pg_temp.check((select count(*) from pg_trigger tg join pg_class c on c.oid = tg.tgrelid where c.relname in ('client_strategic_designations', 'client_contact_preferences', 'communication_cadence_rules', 'support_knowledge_articles', 'ticket_scope_references', 'support_handoff_requests', 'sales_discovery_briefs') and tg.tgname like '%p8_guard' and not tg.tgisinternal) = 7, 'the seven door-only tables carry the door guard');
select pg_temp.check((select count(*) from information_schema.columns c join g1_tables t on t.tbl = c.table_name where c.table_schema = 'projects'
                       and c.column_name ~* '(^|_)(price|amount|quote|discount|cost|fee|total|score|minor|currency)(_|$)') = 0, 'the new tables have no price, amount, quote, discount, score or currency column');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('propose_knowledge_article_as_agent', 'cite_knowledge_for_ticket_as_agent', 'propose_ticket_scope_reference_as_agent', 'request_ticket_handoff_as_agent', 'record_discovery_brief_draft',
                                         'p8g_propose_article', 'p8g_cite', 'p8g_scope_reference', 'p8g_handoff_request', 'p8g_upsert_preferences')
                       and has_function_privilege('authenticated', p.oid, 'execute')) = 0, 'the agent-only doors and inner helpers are not executable by a signed-in user');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('record_client_feedback', 'submit_client_feedback', 'acknowledge_client_feedback', 'client_feedback_for_client', 'set_client_designation', 'end_client_designation', 'set_client_contact_preferences',
                                         'set_my_contact_preferences', 'my_contact_preferences', 'set_communication_cadence_rule', 'clear_communication_cadence_rule', 'propose_knowledge_article', 'approve_knowledge_article',
                                         'retire_knowledge_article', 'cite_knowledge_for_ticket', 'client_knowledge_articles', 'record_ticket_scope_reference', 'confirm_ticket_scope_reference', 'request_ticket_handoff',
                                         'settle_ticket_handoff', 'review_discovery_brief', 'guard_phase_eight_project', 'cs_next_actions', 'phase_eight_retention_status')
                       and has_function_privilege('service_role', p.oid, 'execute')) = 0, 'the person-only doors are not executable by the service role (an agent cannot record feedback, designate, approve, confirm, settle or review)');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.prosecdef and (p.proconfig is null or not p.proconfig::text like '%search_path=%')
                       and (p.proname like 'p8g_%' or p.proname in ('record_client_feedback', 'submit_client_feedback', 'acknowledge_client_feedback', 'set_client_designation', 'end_client_designation', 'propose_knowledge_article', 'approve_knowledge_article',
                                         'request_ticket_handoff', 'record_discovery_brief_draft', 'guard_phase_eight_project'))) = 0, 'every new SECURITY DEFINER function pins an empty search_path');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname in ('p8g_wire_table', 'p8g_wire_parent')) = 0, 'the migrations'' own wiring helpers were dropped');
select pg_temp.check((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('record_client_feedback', 'submit_client_feedback', 'acknowledge_client_feedback', 'set_client_designation', 'set_client_contact_preferences', 'propose_knowledge_article', 'approve_knowledge_article',
                                         'cite_knowledge_for_ticket', 'record_ticket_scope_reference', 'request_ticket_handoff', 'request_ticket_handoff_as_agent', 'settle_ticket_handoff', 'record_discovery_brief_draft',
                                         'review_discovery_brief', 'cs_next_actions', 'can_contact_now_with_preferences', 'guard_phase_eight_project', 'phase_eight_retention_status')
                       and pg_get_functiondef(p.oid) ~* 'net\.http|http_post|pg_notify|core\.emit_event|insert into crm\.|insert into finance\.|insert into sales\.|sales\.(quotations|proposals|deals|opportunities)\M') = 0,
                     'nothing here sends, quotes or touches a deal: no door or read inserts into crm, finance or sales, posts to the network, notifies or emits an event');
\echo Phase 8A gaps log 1 verified OK
rollback;
