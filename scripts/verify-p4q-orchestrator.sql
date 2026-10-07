-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 Orchestrator doors (migration 20261126300000): the persisted envelope with exact references, classed failures with a bounded retry that escalates, the disabled-specialist
-- escalation, the capability profiles and task taxonomy, the joined trace and failure queue. Red-proofs mutate the live definitions.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p4q-orchestrator.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;
\ir p4q-verify-prelude.sql

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000000b7'
\set OWNER '00000000-0000-4000-8000-00000000f641'
\set OWNER2 '00000000-0000-4000-8000-00000000f642'
\set MEMBER '00000000-0000-4000-8000-00000000f643'

insert into auth.users (id, email) values (:'OWNER', 'p4qo-owner@example.test'), (:'OWNER2', 'p4qo-owner2@example.test'), (:'MEMBER', 'p4qo-member@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4qo-owner@example.test', 'O Owner'), (:'OWNER2', 'p4qo-owner2@example.test', 'O Owner Two'), (:'MEMBER', 'p4qo-member@example.test', 'O Member') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'MEMBER', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p4qo other org', 'zztest-p4qo-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4qo client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4qo', 'ZP4QO-1') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4qo other', 'ZP4QO-2') returning id \gset P2_
set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, payload, phase_four_ready, readiness_note)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', false, 'fixture') returning id \gset H_
insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id, state) values (:'ORG', :'P_id', :'H_id', 'ui_design') returning id \gset F_
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P_id', :'F_id', :'H_id', 1, 'draft', null, '[{"screenKey":"home"}]') returning id \gset V_
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, payload, phase_four_ready, readiness_note)
  values (:'ORG', :'P2_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', false, 'fixture') returning id \gset H2_
insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id, state) values (:'ORG', :'P2_id', :'H2_id', 'ui_design') returning id \gset F2_
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P2_id', :'F2_id', :'H2_id', 1, 'draft', null, '[{"screenKey":"home"}]') returning id \gset V2_
set local session_replication_role = origin;
insert into fx values ('P', :'P_id'), ('V', :'V_id'), ('V2', :'V2_id'), ('F', :'F_id'), ('ORG', :'ORG'), ('OWNER', :'OWNER'), ('MEMBER', :'MEMBER');

-- ═══ taxonomy and profiles ═════════════════════════════════════════════════
select pg_temp.check((select count(*) from projects.p4q_task_types) >= 11 and (select count(distinct agent_key) from projects.p4q_task_types) >= 6, 'the Phase 4 task taxonomy is data');
select pg_temp.check((select count(*) from projects.p4q_agent_capability_profiles) = 6 and (select workload_tier from projects.p4q_agent_capability_profiles where agent_key = 'ui_designer') = 'MULTIMODAL_LONG_CONTEXT'
  and (select workload_tier from projects.p4q_agent_capability_profiles where agent_key = 'ui_prototype') = 'CODING_HIGH_TOOL_AGENT', 'each Phase 4 agent has its spec workload tier and model capabilities');

-- ═══ the envelope: exact references only ═══════════════════════════════════
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.p4q_open_envelope(:'P_id', 'nonsense.task', jsonb_build_object('uiVersionId', :'V_id'), 'key-aaaaa')) = 'unknown_task_type', 'an unknown task type is refused');
select pg_temp.check((select outcome from projects.p4q_open_envelope(:'P_id', 'ui.qa_review', '{}'::jsonb, 'key-aaaaa')) = 'refs_required', 'an envelope without references is refused');
select pg_temp.check((select outcome from projects.p4q_open_envelope(:'P_id', 'ui.qa_review', '{"uiVersionId":"latest"}'::jsonb, 'key-aaaaa')) = 'ref_not_exact', '"latest" is not a reference');
select pg_temp.check((select outcome from projects.p4q_open_envelope(:'P_id', 'ui.qa_review', '{"mood":"x"}'::jsonb, 'key-aaaaa')) = 'unknown_ref_key', 'an unknown reference key is refused');
select pg_temp.check((select outcome from projects.p4q_open_envelope(:'P_id', 'ui.qa_review', jsonb_build_object('uiVersionId', :'V2_id'), 'key-aaaaa')) = 'ref_not_in_project', 'another project''s version is not a reference of this project');
select e.envelope_id as env1 from projects.p4q_open_envelope(:'P_id', 'ui.qa_review', jsonb_build_object('uiVersionId', :'V_id'), 'key-aaaaa', 3, 'phase4-routing-1') e \gset
select pg_temp.check((select agent_key from projects.p4q_execution_envelopes where id = :'env1') = 'quality_assurance' and (select correlation_id from projects.p4q_execution_envelopes where id = :'env1') = :'F_id', 'the envelope names the agent from the taxonomy and correlates to the Phase 4 workspace');
select pg_temp.check((select outcome from projects.p4q_open_envelope(:'P_id', 'ui.qa_review', jsonb_build_object('uiVersionId', :'V_id'), 'key-aaaaa')) = 'already_open', 'the idempotency key returns the same envelope');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check((select outcome from projects.p4q_open_envelope(:'P_id', 'ui.qa_review', jsonb_build_object('uiVersionId', :'V_id'), 'key-bbbbb')) = 'forbidden', 'another organisation cannot open an envelope here');

-- ═══ classed failures and bounded retry ════════════════════════════════════
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.p4q_record_failure(:'env1', 'transient', 'provider timeout')) = 'retry', 'a transient failure retries while the budget lasts');
select pg_temp.check((select outcome from projects.p4q_record_failure(:'env1', 'uncertain_side_effect', 'the send may have gone out; key ' || pg_temp.k() || '')) = 'reconcile_first', 'an uncertain side effect is reconciled, never blind-retried');
select pg_temp.check((select detail from projects.p4q_failure_records where envelope_id = :'env1' and failure_class = 'uncertain_side_effect') not like '%sk-ant%', 'a credential in a failure detail is scrubbed before it is stored');
select outcome as f3, escalation_id as esc3 from projects.p4q_record_failure(:'env1', 'transient', 'provider timeout again') \gset
select pg_temp.check(:'f3' = 'escalated' and :'esc3' is not null, 'the budget (3 attempts) is exhausted: escalated to a person');
select pg_temp.check((select cause from projects.p4q_escalations where id = :'esc3') = 'repeated_failure' and (select raised_by_agent from projects.p4q_escalations where id = :'esc3') = 'orchestrator', 'the escalation is a durable row naming the cause and the Orchestrator');
select outcome as f5 from projects.p4q_record_failure(:'env1', 'transient', 'x') \gset
select pg_temp.check((select status from projects.p4q_execution_envelopes where id = :'env1') = 'escalated' and :'f5' = 'envelope_closed', 'an escalated envelope takes no more attempts');
select pg_temp.check((select count(*) from projects.p4q_prior_failures(:'env1')) = 3, 'a retry can read the prior failures of the task');
select e.envelope_id as env2 from projects.p4q_open_envelope(:'P_id', 'prototype.build', jsonb_build_object('uiVersionId', :'V_id'), 'key-ccccc', 3) e \gset
select outcome as f4 from projects.p4q_record_failure(:'env2', 'no_capable_agent', 'no enabled agent can build') \gset
select pg_temp.check(:'f4' = 'escalated' and (select cause from projects.p4q_escalations where project_id = :'P_id' and subject_id = :'env2') = 'no_capable_agent', 'no capable agent is escalated at once with its own cause');
select e.envelope_id as env3 from projects.p4q_open_envelope(:'P_id', 'ui.revise', jsonb_build_object('uiVersionId', :'V_id'), 'key-ddddd', 3) e \gset
select pg_temp.check((select outcome from projects.p4q_record_failure(:'env3', 'permanent', 'the design brief is invalid')) = 'escalated', 'a permanent failure is not retried');
select e.envelope_id as env4 from projects.p4q_open_envelope(:'P_id', 'ui.draft', jsonb_build_object('uiVersionId', :'V_id'), 'key-eeeee', 3) e \gset
insert into fx values ('ENV4', :'env4');
select outcome as c1 from projects.p4q_complete_envelope(:'env4') \gset
select outcome as c2 from projects.p4q_complete_envelope(:'env4') \gset
select pg_temp.check(:'c1' = 'succeeded' and :'c2' = 'already_succeeded', 'completing an envelope is idempotent');

-- a disabled specialist is escalated, not routed around
update ai.agents set enabled = false, disabled_reason = 'fixture' where key = 'ui_prototype';
select outcome as d1 from projects.p4q_open_envelope(:'P_id', 'prototype.revise', jsonb_build_object('uiVersionId', :'V_id'), 'key-fffff') \gset
select pg_temp.check(:'d1' = 'agent_disabled', 'a disabled specialist yields no envelope');
select pg_temp.check((select count(*) from projects.p4q_escalations where project_id = :'P_id' and cause = 'disabled_specialist' and state = 'open') = 1, 'and a disabled_specialist escalation for a person');
update ai.agents set enabled = true, disabled_reason = null where key = 'ui_prototype';

-- ═══ trace and failure queue ═══════════════════════════════════════════════
insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, objective, project_id) values (:'ORG', :'F_id', 'orchestrator', 'frontend_developer', 'Hand a task to a developer', :'P_id');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select count(distinct source) from projects.p4q_phase4_trace(:'P_id')) >= 4 and exists (select 1 from projects.p4q_phase4_trace(:'P_id') where source = 'handoff') and exists (select 1 from projects.p4q_phase4_trace(:'P_id') where source = 'envelope')
  and exists (select 1 from projects.p4q_phase4_trace(:'P_id') where source = 'failure') and exists (select 1 from projects.p4q_phase4_trace(:'P_id') where source = 'escalation'), 'one trace joins the handoff, envelopes, failures and escalations');
select pg_temp.check((select count(*) from projects.p4q_failure_queue(:'P_id')) = 3, 'the failure queue lists the envelopes with failures and no success');
select pg_temp.check((select last_class from projects.p4q_failure_queue(:'P_id') where envelope_id = :'env2') = 'no_capable_agent', 'with the last failure class');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check((select count(*) from projects.p4q_phase4_trace(:'P_id')) = 0 and (select count(*) from projects.p4q_failure_queue(:'P_id')) = 0, 'another organisation reads neither');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.direct('update projects.p4q_execution_envelopes set attempts = 0') = 'refused' and pg_temp.direct('delete from projects.p4q_failure_records') = 'refused', 'envelopes and failures take no direct write');
select pg_temp.check(pg_temp.direct('update projects.p4q_task_types set agent_key = ''finance''') = 'refused', 'the taxonomy is not editable by a user');
reset role;
select pg_temp.as_nobody();

-- ═══ RED-PROOFS ════════════════════════════════════════════════════════════
select pg_temp.red('"latest" is accepted as a reference', 'projects.p4q_open_envelope(uuid,text,jsonb,text,integer,text,text)', 'if v_v is null or v_v !~* ', 'if false and v_v !~* ',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from projects.p4q_open_envelope(pg_temp.fx('P'), 'ui.qa_review', '{"uiVersionId":"latest"}'::jsonb, 'key-red-1')) = 'ref_not_exact' $p$);
select pg_temp.red('another project''s version is accepted', 'projects.p4q_open_envelope(uuid,text,jsonb,text,integer,text,text)', 'when ''uiVersionId'' then exists (select 1 from projects.ui_versions x where x.id = v_v::uuid and x.project_id = p_project_id)', 'when ''uiVersionId'' then true',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from projects.p4q_open_envelope(pg_temp.fx('P'), 'ui.qa_review', jsonb_build_object('uiVersionId', pg_temp.fx('V2')), 'key-red-2')) = 'ref_not_in_project' $p$);
select pg_temp.red('an uncertain side effect is retried', 'projects.p4q_record_failure(uuid,text,text)', 'if p_failure_class = ''uncertain_side_effect'' then', 'if false then',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from projects.p4q_record_failure((select envelope_id from projects.p4q_open_envelope(pg_temp.fx('P'), 'ui.qa_review', jsonb_build_object('uiVersionId', pg_temp.fx('V')), 'key-red-3', 5)), 'uncertain_side_effect', 'maybe sent')) = 'reconcile_first' $p$);
select pg_temp.red('the retry budget is not enforced', 'projects.p4q_record_failure(uuid,text,text)', 'and v_n < v_e.retry_budget then', 'and true then',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from projects.p4q_record_failure((select envelope_id from projects.p4q_open_envelope(pg_temp.fx('P'), 'ui.qa_review', jsonb_build_object('uiVersionId', pg_temp.fx('V')), 'key-red-4', 1)), 'transient', 'timeout')) = 'escalated' $p$);
create or replace function pg_temp.detail_scrubbed() returns boolean language plpgsql as $$
declare e uuid; r text;
begin
  perform pg_temp.as_service();
  select envelope_id into e from projects.p4q_open_envelope(pg_temp.fx('P'), 'ui.qa_review', jsonb_build_object('uiVersionId', pg_temp.fx('V')), 'key-red-5', 5);
  perform * from projects.p4q_record_failure(e, 'transient', 'key ' || pg_temp.k() || '');
  select detail into r from projects.p4q_failure_records where envelope_id = e order by attempt desc limit 1;
  return r is not null and r not like '%sk-ant%';
end $$;
grant execute on function pg_temp.detail_scrubbed() to public;
select pg_temp.check(pg_temp.detail_scrubbed(), 'a credential in a failure detail never reaches the table');
select pg_temp.red('a failure detail keeps its credential', 'projects.p4q_record_failure(uuid,text,text)', 'v_det   text := projects.mask_secrets(btrim(coalesce(p_detail, '''')));', 'v_det   text := btrim(coalesce(p_detail, ''''));',
  $p$ select pg_temp.detail_scrubbed() $p$);
select pg_temp.red('a disabled specialist still gets an envelope', 'projects.p4q_open_envelope(uuid,text,jsonb,text,integer,text,text)', 'if v_agent.enabled is not true then', 'if false then',
  $p$ select (with u as (update ai.agents set enabled = false where key = 'finance' returning 1) select count(*) from u) = 1 and (pg_temp.as_service() is not null)
        and (select outcome from projects.p4q_open_envelope(pg_temp.fx('P'), 'finance.m2_invoice', jsonb_build_object('phaseFourId', pg_temp.fx('F')), 'key-red-6')) = 'agent_disabled' $p$);

rollback;
\echo ALL P4Q ORCHESTRATOR CHECKS PASSED
