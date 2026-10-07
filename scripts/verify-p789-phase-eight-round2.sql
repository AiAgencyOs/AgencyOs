-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8A / 8B round two (migration 20261129100000), through the REAL doors on a scratch Postgres, then RED-PROVEN by mutating the LIVE function definition
-- (a mutation that matches nothing raises). Rolls back.
--
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p789-phase-eight-round2.sql
--
-- Needs migrations 20261129000000 and 20261129100000. No model, provider or client ran; nothing was sent.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.door_off() returns void language plpgsql as $$
begin perform set_config('projects.p789_door', 'off', true); end $$;
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
create or replace function pg_temp.mutate(p_fn regprocedure, p_from text, p_to text) returns text language plpgsql as $$
declare v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_from in v_def) = 0 then raise exception 'RED-PROOF NO-OP: % does not contain %', p_fn, p_from; end if;
  execute replace(v_def, p_from, p_to);
  return v_def;
end $$;
create or replace function pg_temp.restore(p_def text) returns void language plpgsql as $$ begin execute p_def; end $$;
create or replace function pg_temp.red(p_what text, p_fn regprocedure, p_from text, p_to text, p_probe text) returns void language plpgsql as $$
declare v_def text; v_ok boolean := true;
begin
  v_def := pg_temp.mutate(p_fn, p_from, p_to);
  begin
    execute p_probe into v_ok;
    raise exception 'p789_probe_rollback';
  exception when others then
    if sqlerrm <> 'p789_probe_rollback' then v_ok := false; end if;
  end;
  perform pg_temp.restore(v_def);
  if v_ok then raise exception 'RED-PROOF STAYED GREEN: %', p_what; end if;
  raise notice 'red %', p_what;
end $$;

\set ORG '00000000-0000-4000-8000-000000789c01'
\set ORGB '00000000-0000-4000-8000-000000789d01'
\set OWNER '00000000-0000-4000-8000-00000789e901'
\set ADM '00000000-0000-4000-8000-00000789e902'
\set DL '00000000-0000-4000-8000-00000789e903'
\set MEM '00000000-0000-4000-8000-00000789e904'
\set UB '00000000-0000-4000-8000-00000789e905'
insert into core.organizations (id, name, slug) values (:'ORG', 'P789B Agency', 'p789b-agency'), (:'ORGB', 'P789B Other', 'p789b-other');
insert into auth.users (id, email) values (:'OWNER','p789b-o@example.test'),(:'ADM','p789b-a@example.test'),(:'DL','p789b-d@example.test'),(:'MEM','p789b-m@example.test'),(:'UB','p789b-b@example.test');
insert into core.memberships (organization_id, user_id, role) values (:'ORG',:'OWNER','owner'),(:'ORG',:'ADM','ops_admin'),(:'ORG',:'DL','delivery_lead'),(:'ORG',:'MEM','member'),(:'ORGB',:'UB','owner');
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p789b client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p789b live', 'ZP789B-1') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p789b no workspace', 'ZP789B-2') returning id \gset PN_

set local session_replication_role = replica;
insert into projects.phase_eight (organization_id, project_id, client_account_id, intake_id, no_warranty_reason) values (:'ORG', :'P_id', :'A_id', gen_random_uuid(), 'fixture: no warranty');
insert into projects.support_tickets (organization_id, project_id, client_account_id, source, title, priority, response_breached_at) values (:'ORG', :'P_id', :'A_id', 'portal', 'checkout fails <badly>', 'p1', now()) returning id \gset T1_
insert into projects.support_tickets (organization_id, project_id, client_account_id, source, title, priority, response_breached_at) values (:'ORG', :'P_id', :'A_id', 'portal', 'slow search', 'p2', now()) returning id \gset T2_
insert into projects.support_tickets (organization_id, project_id, client_account_id, source, title, priority, resolution_breached_at) values (:'ORG', :'P_id', :'A_id', 'email', 'wrong tax', 'p4', now()) returning id \gset T3_
insert into projects.support_tickets (organization_id, project_id, client_account_id, source, title, priority) values (:'ORG', :'P_id', :'A_id', 'email', 'logo blurry', 'p3') returning id \gset T4_
insert into projects.support_tickets (organization_id, project_id, client_account_id, source, title, priority) values (:'ORG', :'P_id', :'A_id', 'email', 'another one', 'p3') returning id \gset T5_
insert into projects.support_handoff_requests (organization_id, ticket_id, target, reason, payload, status, requested_by) values (:'ORG', :'T1_id', 'developer', 'the checkout fails for every card', '{}', 'acknowledged', :'DL') returning id \gset HR1_
insert into projects.support_handoff_requests (organization_id, ticket_id, target, reason, payload, status, requested_by) values (:'ORG', :'T2_id', 'developer', 'search takes ten seconds', '{}', 'requested', :'DL') returning id \gset HR2_
insert into projects.support_handoff_requests (organization_id, ticket_id, target, reason, payload, status, requested_by) values (:'ORG', :'T3_id', 'quality_assurance', 'verify the tax on the invoice', '{}', 'acknowledged', :'DL') returning id \gset HR3_
insert into projects.support_handoff_requests (organization_id, ticket_id, target, reason, payload, status, requested_by, resolved_by, resolved_at, resolution_note) values (:'ORG', :'T4_id', 'developer', 'replace the logo file', '{}', 'completed', :'DL', :'DL', now(), 'done already') returning id \gset HR4_
insert into projects.support_handoff_requests (organization_id, ticket_id, target, reason, payload, status, requested_by) values (:'ORG', :'T5_id', 'developer', 'redproof request one', '{}', 'acknowledged', :'DL') returning id \gset HR5_
insert into projects.cs_check_ins (organization_id, project_id, kind, period_key, due_on) values (:'ORG', :'P_id', 'scheduled', 'p789-a', '2020-01-01'), (:'ORG', :'P_id', 'scheduled', 'p789-b', '2020-02-01');
insert into projects.recovery_plans (organization_id, project_id) values (:'ORG', :'P_id');
insert into projects.client_communication_ledger (organization_id, client_account_id, channel, purpose, entry_kind, summary, occurred_at, created_at, drafted_by_agent) values (:'ORG', :'A_id', 'email', 'operational', 'drafted_by_agent', 'old note', '2020-01-01', '2020-01-01', 'customer_success');
insert into projects.client_feedback (organization_id, client_account_id, kind, source, entered_by, sentiment, body, recorded_by, created_at) values (:'ORG', :'A_id', 'feedback', 'call', 'staff', 'positive', 'liked it a great deal', :'DL', '2020-01-01');
insert into projects.client_feedback (organization_id, client_account_id, kind, source, entered_by, sentiment, body, recorded_by, created_at) values (:'ORG', :'A_id', 'feedback', 'call', 'staff', 'positive', 'liked it again very much', :'DL', now());
set local session_replication_role = origin;
select pg_temp.door_off();

-- ═════════ 1. 8A activation: a major release raises the major_release check-in ═════════
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from projects.p789_record_major_release(:'P_id', 'v2.0', 'a big new checkout flow', 'https://notes.example.test/v2', current_date)) = 'not_found', 'another organization cannot record a release on this project');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_record_major_release(:'P_id', '  ', 'a big new checkout flow', 'https://notes.example.test/v2', current_date)) = 'version_required', 'a version label is required');
select pg_temp.check((select outcome from projects.p789_record_major_release(:'P_id', 'v2.0', 'short', 'https://notes.example.test/v2', current_date)) = 'summary_required', 'a summary of substance is required');
select pg_temp.check((select outcome from projects.p789_record_major_release(:'P_id', 'v2.0', 'a big new checkout flow', ' ', current_date)) = 'release_ref_required', 'where the release notes live is required');
select pg_temp.check((select outcome from projects.p789_record_major_release(:'P_id', 'v2.0', 'password=hunter2hunter2 in the notes', 'ref', current_date)) = 'contains_secret', 'a secret is refused');
select pg_temp.check((select outcome from projects.p789_record_major_release(:'P_id', 'v2.0', 'a big new checkout flow', 'ref', current_date + 30)) = 'bad_release_date', 'a release cannot be dated in the future');
select pg_temp.check((select outcome from projects.p789_record_major_release(:'PN_id', 'v2.0', 'a big new checkout flow', 'ref', current_date)) = 'no_phase_eight', 'a project with no Customer Success workspace gets no check-in and no release record');
select pg_temp.check(not exists (select 1 from projects.p789_major_releases where project_id = :'PN_id'), 'and nothing was stored for it');
select release_id as "MR_id", check_in_id as "MRCI_id" from projects.p789_record_major_release(:'P_id', 'v2.0', 'a big new checkout flow', 'https://notes.example.test/v2', current_date) \gset
select pg_temp.check(:'MR_id' is not null and (select kind = 'major_release' and period_key = 'major:v2.0' and status = 'due' from projects.cs_check_ins where id = :'MRCI_id'), 'a major release is recorded and the major_release check-in is due');
select pg_temp.check((select outcome from projects.p789_record_major_release(:'P_id', 'v2.0', 'a big new checkout flow', 'https://notes.example.test/v2', current_date)) = 'already_recorded' and (select count(*) from projects.cs_check_ins where project_id = :'P_id' and kind = 'major_release') = 1, 'recording the same version again changes nothing');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.major_release_recorded' and subject_id = :'P_id'::uuid) = 1, 'one event');
select pg_temp.check((select outcome from projects.p789_record_major_release(:'P_id', 'v3.0', 'a second big release of search', 'ref2', current_date)) = 'recorded', 'a different version is a different release');
select pg_temp.check((select count(*) from projects.cs_check_ins where project_id = :'P_id' and kind = 'major_release') = 2, 'and its own check-in');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p789_major_releases set summary = %L where id = %L', 'rewritten history here', :'MR_id'), 'door'), 'a release record is not edited directly');

-- ═════════ 2. 8A P8-SEC-006: retention decisions per data set ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_set_retention_class('communication_ledger', false, 365, 'seven years is not needed here')) = 'not_authorized', 'a delivery lead cannot decide retention');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.p789_set_retention_class('diary', false, 365, 'seven years is not needed here')) = 'bad_data_set', 'only the Phase 8 data sets');
select pg_temp.check((select outcome from projects.p789_set_retention_class('communication_ledger', true, 365, 'seven years is not needed here')) = 'state_a_period_or_indefinite', 'indefinite and a period together are refused');
select pg_temp.check((select outcome from projects.p789_set_retention_class('communication_ledger', false, null, 'seven years is not needed here')) = 'state_a_period_or_indefinite', 'neither is refused');
select pg_temp.check((select outcome from projects.p789_set_retention_class('communication_ledger', false, 10, 'seven years is not needed here')) = 'bad_period', 'a period under 30 days is refused');
select pg_temp.check((select outcome from projects.p789_set_retention_class('communication_ledger', false, 365, 'short')) = 'basis_required', 'a basis is required');
select pg_temp.check((select version from projects.p789_set_retention_class('communication_ledger', false, 365, 'one year after the last contact')) = 1 and (select version from projects.p789_set_retention_class('client_feedback', false, 90, 'ninety days then review')) = 1, 'decisions are recorded per data set');
select pg_temp.check((select version from projects.p789_set_retention_class('communication_ledger', true, null, 'keep for the contract life')) = 2, 'a new decision is a new version');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select decided and version = 2 and indefinite and rows_held = 1 and rows_past_decision = 0 from projects.p789_retention_status() where data_set = 'communication_ledger'), 'the ledger: latest decision is indefinite, one row held, none past it');
select pg_temp.check((select decided and version = 1 and retention_days = 90 and rows_held = 2 and rows_past_decision = 1 from projects.p789_retention_status() where data_set = 'client_feedback'), 'feedback: two rows held, one older than the 90-day decision');
select pg_temp.check((select rows_past_decision from projects.p789_retention_status('2019-01-01 00:00:00+00') where data_set = 'client_feedback') = 0, 'the age is measured against the clock it is handed');
select pg_temp.check((select not decided and rows_past_decision = 0 from projects.p789_retention_status() where data_set = 'opportunities'), 'an undecided data set says so');
select pg_temp.check((select count(*) from projects.p789_retention_status()) = 5, 'all five data sets are listed');
reset role;
select pg_temp.check((select count(*) from projects.client_feedback) = 2, 'the status read deleted nothing');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select coalesce(sum(rows_held), 0) from projects.p789_retention_status()) = 0 and (select count(*) from projects.p789_phase_eight_retention_classes) = 0, 'another organization sees none of it');
reset role;
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('delete from projects.p789_phase_eight_retention_classes where data_set = %L', 'client_feedback'), 'never deleted'), 'a decision is history, never deleted');

-- ═════════ 3. CUS-IMP-009: alert rules and alert records ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_set_alert_rule('tickets_sla_breached', 3, 'three breached tickets is too many')) = 'not_authorized', 'a delivery lead cannot set an alert rule');
select pg_temp.check((select outcome from projects.p789_sweep_alerts()) = 'not_authorized', 'nor sweep as a person');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.p789_set_alert_rule('mood', 3, 'three breached tickets is too many')) = 'bad_metric', 'metric vocabulary is closed');
select pg_temp.check((select outcome from projects.p789_set_alert_rule('tickets_sla_breached', 0, 'three breached tickets is too many')) = 'bad_threshold', 'a threshold of zero would alert always');
select pg_temp.check((select outcome from projects.p789_set_alert_rule('tickets_sla_breached', 3, 'x')) = 'reason_required', 'a reason is required');
select pg_temp.check((select version from projects.p789_set_alert_rule('tickets_sla_breached', 3, 'three breached tickets is too many')) = 1, 'a rule is set');
select pg_temp.check((select version from projects.p789_set_alert_rule('check_ins_overdue', 5, 'five overdue check-ins')) = 1 and (select version from projects.p789_set_alert_rule('recovery_plans_open', 1, 'any open recovery plan')) = 1, 'more rules');
select pg_temp.as_service();
select pg_temp.check((select raised from projects.p789_sweep_alerts(:'ORG', now())) = 2, 'the first sweep raises two alerts');
select pg_temp.check((select count(*) from projects.p789_alerts where organization_id = :'ORG' and state = 'open') = 2 and exists (select 1 from projects.p789_alerts where metric = 'tickets_sla_breached' and observed = 3 and threshold = 3) and exists (select 1 from projects.p789_alerts where metric = 'recovery_plans_open' and observed = 1)
  and not exists (select 1 from projects.p789_alerts where metric = 'check_ins_overdue'), 'three breached tickets and one open recovery plan raise alerts; two overdue check-ins (threshold 5) do not');
select pg_temp.check((select raised from projects.p789_sweep_alerts(:'ORG', now())) = 0 and (select count(*) from projects.p789_alerts where state = 'open') = 2, 'a second sweep raises nothing: one live alert per metric');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.cs_alert_raised' and (payload ->> 'metric') in ('tickets_sla_breached', 'recovery_plans_open')) = 2, 'one event per raised alert');
-- the injected clock: a rule on overdue check-ins at 2; at a clock before the due dates nothing is overdue, at now both are
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select version from projects.p789_set_alert_rule('check_ins_overdue', 2, 'two overdue check-ins is the limit') \gset CK_
select pg_temp.as_service();
select pg_temp.check((select raised from projects.p789_sweep_alerts(:'ORG', '2019-06-01 00:00:00+00')) = 0 and not exists (select 1 from projects.p789_alerts where metric = 'check_ins_overdue'), 'with the clock before the due dates, nothing is overdue and no alert is raised');
select pg_temp.check((select raised from projects.p789_sweep_alerts(:'ORG', now())) = 1, 'with the real clock the overdue check-ins raise one');
select pg_temp.check(exists (select 1 from projects.p789_alerts where metric = 'check_ins_overdue' and observed = 2), 'and it records the figure it saw');
-- clearing: raise the recovery threshold above the figure, the alert clears; lower it again, a new alert is raised
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select version from projects.p789_set_alert_rule('recovery_plans_open', 2, 'two open recovery plans') \gset RC_
select pg_temp.as_service();
select pg_temp.check((select cleared from projects.p789_sweep_alerts(:'ORG', now())) = 1, 'a figure back under its threshold clears the alert');
select pg_temp.check((select state from projects.p789_alerts where metric = 'recovery_plans_open') = 'cleared', 'and the row says cleared');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select version from projects.p789_set_alert_rule('recovery_plans_open', 1, 'any open recovery plan again') \gset RC2_
select pg_temp.as_service();
select pg_temp.check((select raised from projects.p789_sweep_alerts(:'ORG', now())) = 1, 'a fresh crossing raises a new alert');
select pg_temp.check((select count(*) from projects.p789_alerts where metric = 'recovery_plans_open') = 2, 'and the cleared one stays as history');
-- acknowledgement
select id as "AL_id" from projects.p789_alerts where metric = 'tickets_sla_breached' and state = 'open' \gset
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_acknowledge_alert(:'AL_id', 'looking at the tickets')) = 'not_authorized', 'a delivery lead cannot acknowledge an alert');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.p789_acknowledge_alert(:'AL_id', 'x')) = 'note_required', 'a note is required');
select pg_temp.check((select outcome from projects.p789_acknowledge_alert(:'AL_id', 'looking at the tickets')) = 'acknowledged', 'an Admin acknowledges');
select pg_temp.check((select outcome from projects.p789_acknowledge_alert(:'AL_id', 'looking at the tickets')) = 'already_acknowledged', 'once');
select pg_temp.check((select outcome from projects.p789_acknowledge_alert(gen_random_uuid(), 'looking at the tickets')) = 'not_found', 'an unknown alert is not found');
select pg_temp.as_service();
select pg_temp.check((select raised from projects.p789_sweep_alerts(:'ORG', now())) = 0 and (select state from projects.p789_alerts where id = :'AL_id') = 'acknowledged', 'a sweep does not re-raise over an acknowledged alert');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from projects.p789_acknowledge_alert(:'AL_id', 'not my alert')) = 'not_found', 'another organization cannot acknowledge it');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p789_alerts) = 0 and (select count(*) from projects.p789_alert_rules) = 0, 'nor read alerts or rules');
reset role;
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p789_alerts set metric = %L where id = %L', 'check_ins_overdue', :'AL_id'), 'door'), 'an alert is not edited directly');

-- ═════════ 4. SUP-TST-006: a Developer task made by a person from an acknowledged follow-up ═════════
select pg_temp.as_user(:'MEM', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p789_create_task_from_followup(:'HR1_id')) = 'not_authorized', 'a plain member cannot make the task');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_create_task_from_followup(:'HR2_id')) = 'not_acknowledged_yet', 'a request nobody has acknowledged yields no task');
select pg_temp.check((select outcome from projects.p789_create_task_from_followup(:'HR3_id')) = 'not_a_developer_request', 'a QA request is not a Developer task');
select pg_temp.check((select outcome from projects.p789_create_task_from_followup(:'HR4_id')) = 'request_already_settled', 'a settled request yields no task');
select pg_temp.check((select outcome from projects.p789_create_task_from_followup(gen_random_uuid())) = 'not_found', 'an unknown request is not found');
select pg_temp.check((select outcome from projects.p789_create_task_from_followup(:'HR1_id', gen_random_uuid())) = 'assignee_not_in_organization', 'the assignee must belong to the organization');
select outcome as "TK_out", task_id as "TK_id" from projects.p789_create_task_from_followup(:'HR1_id', :'DL', current_date + 3) \gset
select pg_temp.check(:'TK_out' = 'created', 'a delivery lead turns the acknowledged developer request into a task');
select pg_temp.check((select t.project_id = :'P_id'::uuid and t.priority = 'p1' and t.assignee_id = :'DL'::uuid and t.status = 'todo' and position('checkout fails <badly>' in t.title) > 0 and position('the checkout fails for every card' in t.description) > 0 from projects.tasks t where t.id = :'TK_id'), 'the task is built from the ticket row: project, priority, title and the reason given');
select pg_temp.check((select outcome from projects.p789_create_task_from_followup(:'HR1_id')) = 'already_created' and (select count(*) from projects.tasks where title like 'Support follow-up%') = 1, 'one task per request');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.support_followup_task_created' and subject_id = :'T1_id'::uuid) = 1, 'one event');
select pg_temp.check(not has_function_privilege('service_role', 'projects.p789_create_task_from_followup(uuid, uuid, date)', 'execute'), 'the service role has no door to it: an agent cannot make this task');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from projects.p789_create_task_from_followup(:'HR5_id')) = 'not_found', 'another organization cannot make a task from this request');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('delete from projects.p789_support_followup_tasks where request_id = %L', :'HR1_id'), 'never deleted'), 'the link between request and task is history');

-- ═════════ 5. 8B routing cost evidence: honestly nothing ═════════
set local session_replication_role = replica;
insert into projects.maintenance_items (organization_id, client_account_id, project_id, title, coverage) values (:'ORG', :'A_id', :'P_id', 'p789 ticket', 'maintenance') returning id \gset MI_
insert into projects.maintenance_work_items (organization_id, client_account_id, project_id, kind, area, title, ticket_id, created_by) values (:'ORG', :'A_id', :'P_id', 'patch', 'frontend', 'p789 routed item', :'MI_id', :'DL') returning id \gset W_
insert into projects.maintenance_routing_decisions (organization_id, work_item_id, decision_key, outcome, priority, to_agent, reason) values (:'ORG', :'W_id', 'k1', 'routed', 'p2', 'developer', 'routed to the developer agent'), (:'ORG', :'W_id', 'k2', 'held', 'p2', null, 'held for a person');
set local session_replication_role = origin;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p789_maintenance_routing_cost_evidence(:'W_id')) = 2 and not exists (select 1 from projects.p789_maintenance_routing_cost_evidence(:'W_id') where model_call or cost_minor is not null), 'every routing decision says: no model call, no cost; no figure is returned');
select pg_temp.check(not exists (select 1 from information_schema.columns where table_schema = 'projects' and table_name = 'maintenance_routing_decisions' and column_name ilike '%cost%'), 'and no cost column exists to be filled with an invented number');
reset role;

-- ═════════ 6. earlier parts this part relies on, present and callable ═════════
select pg_temp.check(to_regprocedure('projects.set_client_designation(uuid, text, text, text)') is not null and to_regclass('projects.client_strategic_designations') is not null, 'VIP / strategic designation exists (earlier part)');
select pg_temp.check(to_regprocedure('projects.ticket_scope_comparison(uuid)') is not null and to_regclass('projects.ticket_scope_references') is not null, 'scope-item comparison exists (earlier part)');
select pg_temp.check(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname like 'p789\_%' and n.nspname in ('projects', 'finance') and has_function_privilege('anon', p.oid, 'execute') and p.proname <> 'p789_html_escape' and p.prorettype <> 'trigger'::regtype), 'anon can execute no p789 door');

-- ═════════ 7. RED-PROOFS ═════════
create or replace function pg_temp.p_release_new(p_proj uuid, p_user uuid, p_org uuid, p_label text) returns text language plpgsql as $$
declare o text;
begin perform pg_temp.as_user(p_user, p_org, 'delivery_lead'); select outcome into o from projects.p789_record_major_release(p_proj, p_label, 'another big release summary', 'ref', current_date); return o; end $$;
create or replace function pg_temp.p_below(p_org uuid, p_adm uuid) returns boolean language plpgsql as $$
begin
  perform pg_temp.as_user(p_adm, p_org, 'ops_admin');
  perform projects.p789_set_alert_rule('check_ins_overdue', 50, 'a high bar for overdue check-ins');
  perform pg_temp.as_service();
  update projects.p789_alerts set state = 'cleared', cleared_at = now() where metric = 'check_ins_overdue' and state <> 'cleared';
  perform projects.p789_sweep_alerts(p_org, now());
  return not exists (select 1 from projects.p789_alerts where metric = 'check_ins_overdue' and state <> 'cleared');
end $$;
create or replace function pg_temp.p_person_clock(p_org uuid, p_adm uuid) returns boolean language plpgsql as $$
begin
  perform pg_temp.as_user(p_adm, p_org, 'ops_admin');
  perform projects.p789_set_alert_rule('check_ins_overdue', 2, 'two overdue is the bar');
  perform pg_temp.as_service();
  update projects.p789_alerts set state = 'cleared', cleared_at = now() where metric = 'check_ins_overdue' and state <> 'cleared';
  perform pg_temp.as_user(p_adm, p_org, 'ops_admin');
  perform projects.p789_sweep_alerts(null, '2019-06-01 00:00:00+00');
  return exists (select 1 from projects.p789_alerts where metric = 'check_ins_overdue' and state <> 'cleared');
end $$;
create or replace function pg_temp.p_clears(p_org uuid, p_adm uuid) returns boolean language plpgsql as $$
begin
  perform pg_temp.as_user(p_adm, p_org, 'ops_admin');
  perform projects.p789_set_alert_rule('recovery_plans_open', 5, 'five open recovery plans');
  perform pg_temp.as_service();
  perform projects.p789_sweep_alerts(p_org, now());
  return not exists (select 1 from projects.p789_alerts where metric = 'recovery_plans_open' and state <> 'cleared');
end $$;
grant execute on function pg_temp.p_release_new(uuid, uuid, uuid, text), pg_temp.p_below(uuid, uuid), pg_temp.p_person_clock(uuid, uuid), pg_temp.p_clears(uuid, uuid) to public;

select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('release: a future date is refused', 'projects.p789_record_major_release(uuid, text, text, text, date)'::regprocedure, 'if p_released_on is null or p_released_on > current_date + 1 then', 'if p_released_on is null then',
  format($q$select (select outcome from projects.p789_record_major_release(%L, 'v9.0', 'a future release summary', 'ref', current_date + 30)) = 'bad_release_date'$q$, :'P_id'));
select pg_temp.red('release: a missing workspace stops the record', 'projects.p789_record_major_release(uuid, text, text, text, date)'::regprocedure, 'if v_ci.outcome not in (''created'', ''already_exists'') then', 'if false then',
  format($q$select (select outcome from projects.p789_record_major_release(%L, 'v9.0', 'a missing workspace summary', 'ref', current_date)) = 'no_phase_eight'$q$, :'PN_id'));
select pg_temp.red('release: recorded once per version', 'projects.p789_record_major_release(uuid, text, text, text, date)'::regprocedure, 'if v_id is not null then return query select ''already_recorded''::text', 'if false then return query select ''already_recorded''::text',
  format($q$select pg_temp.p_release_new(%L, %L, %L, 'v2.0') = 'already_recorded'$q$, :'P_id', :'DL', :'ORG'));
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.red('release: cross-tenant (probed as the other organization)', 'projects.p789_record_major_release(uuid, text, text, text, date)'::regprocedure, 'where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null', 'where p.id = p_project_id and p.deleted_at is null',
  format($q$select (select outcome from projects.p789_record_major_release(%L, 'v9.0', 'a cross tenant summary', 'ref', current_date)) = 'not_found'$q$, :'P_id'));
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('retention: Admin-only', 'projects.p789_set_retention_class(text, boolean, int, text)'::regprocedure, 'if not coalesce((select core.is_admin()), false) then return query select ''not_authorized''::text, null::int; return; end if;', '',
  $q$select (select outcome from projects.p789_set_retention_class('opportunities', false, 365, 'a year after the last deal')) = 'not_authorized'$q$);
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.red('retention: a period or indefinite, never both', 'projects.p789_set_retention_class(text, boolean, int, text)'::regprocedure, 'if p_indefinite is null or p_indefinite = (p_retention_days is not null) then', 'if p_indefinite is null then',
  $q$select (select outcome from projects.p789_set_retention_class('opportunities', true, 365, 'a year after the last deal')) = 'state_a_period_or_indefinite'$q$);
select pg_temp.red('retention: a short period is refused', 'projects.p789_set_retention_class(text, boolean, int, text)'::regprocedure, 'if p_retention_days is not null and (p_retention_days < 30 or p_retention_days > 36500) then', 'if false then',
  $q$select (select outcome from projects.p789_set_retention_class('opportunities', false, 5, 'a year after the last deal')) = 'bad_period'$q$);
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('retention status: rows past the decision are counted', 'projects.p789_retention_status(timestamptz)'::regprocedure, 'h.at < v_now - make_interval(days => c.retention_days)', 'false',
  $q$select (select rows_past_decision from projects.p789_retention_status() where data_set = 'client_feedback') = 1$q$);
select pg_temp.red('alert rule: Admin-only', 'projects.p789_set_alert_rule(text, int, text)'::regprocedure, 'if not coalesce((select core.is_admin()), false) then return query select ''not_authorized''::text, null::int; return; end if;', '',
  $q$select (select outcome from projects.p789_set_alert_rule('check_ins_overdue', 9, 'nine overdue check-ins')) = 'not_authorized'$q$);
select pg_temp.red('alert sweep by a person: Admin-only', 'projects.p789_sweep_alerts(uuid, timestamptz)'::regprocedure, 'if not coalesce((select core.is_admin()), false) then return query select ''not_authorized''::text, 0, 0; return; end if;', '',
  $q$select (select outcome from projects.p789_sweep_alerts()) = 'not_authorized'$q$);
select pg_temp.red('alert acknowledge: Admin-only', 'projects.p789_acknowledge_alert(uuid, text)'::regprocedure, 'if not coalesce((select core.is_admin()), false) then return query select ''not_authorized''::text; return; end if;', '',
  format($q$select (select outcome from projects.p789_acknowledge_alert(%L, 'looking at the tickets')) = 'not_authorized'$q$, :'AL_id'));
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.red('alert acknowledge: only once', 'projects.p789_acknowledge_alert(uuid, text)'::regprocedure, 'if v_a.state = ''acknowledged'' then return query select ''already_acknowledged''::text; return; end if;', '',
  format($q$select (select outcome from projects.p789_acknowledge_alert(%L, 'looking at the tickets')) = 'already_acknowledged'$q$, :'AL_id'));
select pg_temp.red('alert sweep: below the threshold nothing is raised', 'projects.p789_sweep_alerts(uuid, timestamptz)'::regprocedure, 'if v_fig >= r.threshold then', 'if true then',
  format($q$select pg_temp.p_below(%L, %L)$q$, :'ORG', :'ADM'));
select pg_temp.red('alert sweep: a person cannot move the clock', 'projects.p789_sweep_alerts(uuid, timestamptz)'::regprocedure, 'v_org := (select core.current_organization_id()); v_now := clock_timestamp();', 'v_org := (select core.current_organization_id()); v_now := coalesce(p_now, clock_timestamp());',
  format($q$select pg_temp.p_person_clock(%L, %L)$q$, :'ORG', :'ADM'));
select pg_temp.red('alert sweep: a recovered figure clears the alert', 'projects.p789_sweep_alerts(uuid, timestamptz)'::regprocedure, 'update projects.p789_alerts set state = ''cleared'', cleared_at = v_now where organization_id = r.organization_id and metric = r.metric and state <> ''cleared'';', '',
  format($q$select pg_temp.p_clears(%L, %L)$q$, :'ORG', :'ADM'));
select pg_temp.as_user(:'MEM', :'ORG', 'member');
select pg_temp.red('follow-up task: delivery rights', 'projects.p789_create_task_from_followup(uuid, uuid, date)'::regprocedure, 'if not coalesce((select core.can_manage_delivery()), false) then return query select ''not_authorized''::text, null::uuid; return; end if;', '',
  format($q$select (select outcome from projects.p789_create_task_from_followup(%L)) = 'not_authorized'$q$, :'HR5_id'));
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('follow-up task: the request must be acknowledged', 'projects.p789_create_task_from_followup(uuid, uuid, date)'::regprocedure, 'if v_r.status <> ''acknowledged'' then', 'if false then',
  format($q$select (select outcome from projects.p789_create_task_from_followup(%L)) = 'not_acknowledged_yet'$q$, :'HR2_id'));
select pg_temp.red('follow-up task: only a Developer request', 'projects.p789_create_task_from_followup(uuid, uuid, date)'::regprocedure, 'if v_r.target <> ''developer'' then', 'if false then',
  format($q$select (select outcome from projects.p789_create_task_from_followup(%L)) = 'not_a_developer_request'$q$, :'HR3_id'));
select pg_temp.red('follow-up task: one per request', 'projects.p789_create_task_from_followup(uuid, uuid, date)'::regprocedure, 'if exists (select 1 from projects.p789_support_followup_tasks f where f.request_id = p_request_id) then', 'if false then',
  format($q$select (select outcome from projects.p789_create_task_from_followup(%L)) = 'already_created'$q$, :'HR1_id'));
select pg_temp.red('follow-up task: the assignee belongs to the organization', 'projects.p789_create_task_from_followup(uuid, uuid, date)'::regprocedure, 'if p_assignee_id is not null and not exists', 'if false and not exists',
  format($q$select (select outcome from projects.p789_create_task_from_followup(%L, gen_random_uuid())) = 'assignee_not_in_organization'$q$, :'HR5_id'));
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('routing cost: no model call is ever claimed', 'projects.p789_maintenance_routing_cost_evidence(uuid)'::regprocedure, 'false, null::bigint', 'true, 1::bigint',
  format($q$select not exists (select 1 from projects.p789_maintenance_routing_cost_evidence(%L) where model_call or cost_minor is not null)$q$, :'W_id'));


select 'phase 8 round two verified OK' as result;
rollback;
