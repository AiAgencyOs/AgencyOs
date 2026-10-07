-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7c and the Phase 8A completions, proved against a real Postgres:
--
--   1. the Phase 8A sweeps that nothing called: scheduled health snapshots, due check-in notices (never a message), the SLA sweep's role gate
--   2. a client's support message opens a ticket: only a project conversation, only an ACTIVE Phase 8 workspace, only the label support_request, idempotent, never a reply
--   3. ClientActionRequest: staff raise it, the client reads only its own and resolves it with a note (a claim), a person confirms with their own verification
--   4. the Phase 7 Failure Queue: a derived read of failed deployments, failed validations, open incidents, stale approvals and overdue client actions
--   5. the automatic DRAFT handover package on ProductionValidated: from the contract checklist only, never submitted, approved or delivered
--   6. the client's financial statement: facts for the caller's own account, no draft, no unverified money counted as received, no amount changed
--   7. structure: every new table is tenancy-guarded, RLS-on, internal-read, door-written; every service-only door is not granted to a person
--
-- Run it against a scratch database (KEEP=1 scripts/apply-migrations-locally.sh), then:
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-seven-c.sql        (rolls back; ends with "verified OK")
-- NOTHING IS SENT, DELIVERED OR DEPLOYED: every "runner" call below is the service-role door a real executor or cron tick would call, made by this script.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
create or replace function pg_temp.as_client(p_sub uuid, p_org uuid, p_account uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', 'client_member', 'client_account_id', p_account))::text, true); end $$;
grant execute on function pg_temp.as_client(uuid, uuid, uuid) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
-- a statement a rule must refuse (restrict / check violation); the needle is part of the rule's own message
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;
create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;
create or replace function pg_temp.errs(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.errs(text, text) to public;
-- a write that must change nothing: refused by privilege, or (under RLS) matching no row
create or replace function pg_temp.no_write(stmt text) returns boolean language plpgsql as $$
declare n bigint;
begin execute stmt; get diagnostics n = row_count; return n = 0;
exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.no_write(text) to public;
-- the doors set transaction-local flags; in ONE test transaction they would still be on, so a raw-write test clears them first
create or replace function pg_temp.door_off() returns void language plpgsql as $$
begin perform set_config('projects.p7_door', '', true); perform set_config('projects.p8_sanctioned', 'off', true); end $$;
grant execute on function pg_temp.door_off() to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000007c2'
\set OWNER '00000000-0000-4000-8000-00000000a7c1'
\set DL '00000000-0000-4000-8000-00000000a7c2'
\set QA '00000000-0000-4000-8000-00000000a7c3'
\set OPS '00000000-0000-4000-8000-00000000a7c4'
\set OTHER '00000000-0000-4000-8000-00000000a7c5'
\set CL1 '00000000-0000-4000-8000-00000000a7c6'
\set CL3 '00000000-0000-4000-8000-00000000a7c7'
\set ST8 '00000000-0000-4000-8000-00000000a7c8'
\set CSO '00000000-0000-4000-8000-00000000a7c9'
\set CL4 '00000000-0000-4000-8000-00000000a7ca'
\set H1 '1111111111111111111111111111111111111111111111111111111111111111'
\set H2 '2222222222222222222222222222222222222222222222222222222222222222'
\set H3 '3333333333333333333333333333333333333333333333333333333333333333'
\set H4 '4444444444444444444444444444444444444444444444444444444444444444'

insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p7c other org', 'zztest-p7c-other') on conflict do nothing;
insert into auth.users (id, email) values (:'OWNER', 'p7c-owner@example.test'), (:'DL', 'p7c-dl@example.test'), (:'QA', 'p7c-qa@example.test'), (:'OPS', 'p7c-ops@example.test'), (:'OTHER', 'p7c-other@example.test'),
  (:'CL1', 'p7c-cl1@example.test'), (:'CL3', 'p7c-cl3@example.test'), (:'ST8', 'p7c-st8@example.test'), (:'CSO', 'p7c-cso@example.test'), (:'CL4', 'p7c-cl4@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p7c-owner@example.test', 'P7C Owner'), (:'DL', 'p7c-dl@example.test', 'P7C Delivery Lead'), (:'QA', 'p7c-qa@example.test', 'P7C QA'),
  (:'OPS', 'p7c-ops@example.test', 'P7C Ops'), (:'OTHER', 'p7c-other@example.test', 'P7C Other'), (:'CL1', 'p7c-cl1@example.test', 'Asha Verma'), (:'CL3', 'p7c-cl3@example.test', 'Other Client'),
  (:'ST8', 'p7c-st8@example.test', 'P7C Staff'), (:'CSO', 'p7c-cso@example.test', 'P7C CS Owner'), (:'CL4', 'p7c-cl4@example.test', 'Statement Client') on conflict do nothing;
update core.users set full_name = case id when :'CL1' then 'Asha Verma' when :'CL3' then 'Other Client' else full_name end where id in (:'CL1', :'CL3');
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'DL', 'delivery_lead'), (:'ORG', :'QA', 'member'), (:'ORG', :'OPS', 'ops_admin'),
  (:'ORG2', :'OTHER', 'owner'), (:'ORG', :'ST8', 'member'), (:'ORG', :'CSO', 'member') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p7c client A') returning id \gset A_
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p7c client other') returning id \gset A2_
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p7c statement client') returning id \gset AS_
select set_config('p7c.org', :'ORG', false), set_config('p7c.dl', :'DL', false), set_config('p7c.ops', :'OPS', false), set_config('p7c.qa', :'QA', false), set_config('p7c.owner', :'OWNER', false),
       set_config('p7c.st8', :'ST8', false), set_config('p7c.cso', :'CSO', false);
insert into crm.contacts (organization_id, client_account_id, full_name, email) values (:'ORG', :'A_id', 'Asha Verma', 'asha-p7c@client.example.test');

-- @@MUTATE@@ (the red-proof harness injects a mutation right after BEGIN, above; nothing is injected here)

-- ══════════ fixtures ══════════
-- a project ready for Phase 7: the Phase 6 evidence (seeded with triggers off: Phase 6 itself is proven elsewhere), a paid and verified M4, the Phase 6 handoff
create or replace function pg_temp.seed_candidate(p_org uuid, p_project uuid, p_commit text, p_version int, p_hash text, p_owner uuid) returns uuid language plpgsql as $$
declare v_del uuid; v_plan uuid; v_c uuid;
begin
  insert into projects.deliverables (organization_id, project_id, kind, version, title, status) values (p_org, p_project, 'build', p_version, 'build v' || p_version, 'approved') returning id into v_del;
  insert into projects.deliverable_details (deliverable_id, organization_id, project_id, commit_ref, admin_status, admin_decided_at, qa_status, qa_decided_at) values (v_del, p_org, p_project, p_commit, 'approved', now(), 'passed', now());
  insert into qa.master_test_plans (organization_id, project_id, intake_id, version, status, commit_ref, required_categories, approved_by, approved_at) values (p_org, p_project, gen_random_uuid(), p_version, 'approved', p_commit, array['security'], p_owner, now()) returning id into v_plan;
  insert into qa.phase6_cases (organization_id, project_id, plan_id, title, acceptance_criterion, category, priority, status, result_commit, evidence_ref, executed_by, executed_at) values (p_org, p_project, v_plan, 'login works', 'a user can log in', 'security', 'critical', 'pass', p_commit, 'https://ci.example.test/case/1', p_owner, now());
  insert into projects.build_runs (organization_id, project_id, deliverable_id, commit_ref, environment, status, artifact_sha256, stages, fingerprint) values (p_org, p_project, v_del, p_commit, 'review', 'succeeded', p_hash, '[{"stage": "build"}]', '{"node": "22"}');
  insert into qa.release_candidates (organization_id, project_id, plan_id, intake_id, version, status, commit_ref, build_deliverable_id, artifact_sha256, config_version, rollback_plan, rollback_owner, observability_notes, known_limitations, approved_by, approved_at)
  values (p_org, p_project, v_plan, gen_random_uuid(), p_version, 'approved', p_commit, v_del, p_hash, 'cfg-' || p_version, 'redeploy the previous artifact', 'ops lead', 'error rate and latency dashboards', '["Export is slow above 10k rows"]', p_owner, now()) returning id into v_c;
  insert into qa.category_results (organization_id, candidate_id, category, status, commit_ref, evidence_ref) values (p_org, v_c, 'security', 'pass', p_commit, 'https://ci.example.test/security/' || p_version);
  return v_c;
end $$;
grant execute on function pg_temp.seed_candidate(uuid, uuid, text, int, text, uuid) to public;

create or replace function pg_temp.seed_p7(p_org uuid, p_acct uuid, p_project uuid, p_code text, p_commit text, p_hash text, p_owner uuid) returns uuid language plpgsql as $$
declare v_p uuid := p_project; v_c uuid; v_pc uuid; v_m4 uuid;
begin
  insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (p_org, v_p, 'M1', 1, 50000, 'INR'), (p_org, v_p, 'M2', 2, 100000, 'INR'), (p_org, v_p, 'M3', 3, 100000, 'INR');
  insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (p_org, v_p, 'M4', 4, 100000, 'INR') returning id into v_m4;
  insert into finance.invoices (organization_id, client_account_id, project_id, milestone_id, number, kind, status, currency, subtotal_minor, total_minor, paid_minor, verified_minor, issued_at, paid_at)
  values (p_org, p_acct, v_p, v_m4, 'ZP7C-M4-' || p_code, 'milestone', 'paid', 'INR', 100000, 100000, 100000, 100000, now(), now());
  v_c := pg_temp.seed_candidate(p_org, v_p, p_commit, 1, p_hash, p_owner);
  insert into projects.phase_completions (organization_id, project_id, phase, completed_by) values (p_org, v_p, 6, p_owner) returning id into v_pc;
  insert into projects.phase_six_handoffs (organization_id, project_id, phase_completion_id, candidate_id, commit_ref, artifact_sha256, payload)
  values (p_org, v_p, v_pc, v_c, p_commit, p_hash, jsonb_build_object('knownLimitations', jsonb_build_array('Export is slow above 10k rows'), 'scopeVersionId', gen_random_uuid(), 'readiness', jsonb_build_object('score', 90, 'band', 'strong')));
  return v_p;
end $$;
grant execute on function pg_temp.seed_p7(uuid, uuid, uuid, text, text, text, uuid) to public;

create or replace function pg_temp.ready_plan(p_plan uuid) returns void language plpgsql as $$
begin
  perform projects.record_readiness_item(p_plan, 'environment', 'production host', 'ready', 'https://runbook.example.test/env/prod');
  perform projects.record_readiness_item(p_plan, 'config_ref', 'DATABASE_URL', 'ready', 'present in the production secret store (name only)');
  perform projects.record_readiness_item(p_plan, 'secret_ref', 'STRIPE_SECRET_KEY', 'ready', 'present in the production secret store (name only)');
  perform projects.record_readiness_item(p_plan, 'monitoring', 'uptime probe', 'ready', 'https://monitor.example.test/probe/1');
  perform projects.record_readiness_item(p_plan, 'manual_dns', 'apex domain', 'ready', 'https://tickets.example.test/dns/77', 'client', 'the client points the A record at the production host');
end $$;
grant execute on function pg_temp.ready_plan(uuid) to public;

-- drive a Phase 7 project through the real doors to a stage: 'approval' (waiting for an Admin), 'started', 'failed', 'succeeded' (awaiting live validation). Returns the plan or the deployment.
create or replace function pg_temp.p7_drive(p_project uuid, p_stage text, p_hash text) returns uuid language plpgsql as $$
declare v_org uuid := current_setting('p7c.org')::uuid; v_dl uuid := current_setting('p7c.dl')::uuid; v_ops uuid := current_setting('p7c.ops')::uuid; v_plan uuid; v_dep uuid; v_o text;
begin
  perform pg_temp.as_service();
  select outcome into v_o from projects.open_phase_seven(p_project);
  if v_o is distinct from 'ready' then raise exception 'FAILED: fixture: phase seven not ready for %: %', p_project, v_o; end if;
  perform pg_temp.as_user(v_dl, v_org, 'delivery_lead');
  select t.plan_id into v_plan from projects.create_deployment_plan(p_project, 'prod-app-1', '{"none": true, "reason": "no schema change"}'::jsonb, 'redeploy the previous artifact', 'v0-previous-stable', 'ops lead', 'dashboards and alerting') t;
  if v_plan is null then raise exception 'FAILED: fixture: no plan'; end if;
  perform pg_temp.ready_plan(v_plan);
  select outcome into v_o from projects.request_deployment_approval(v_plan);
  if v_o is distinct from 'requested' then raise exception 'FAILED: fixture: approval not requested: %', v_o; end if;
  if p_stage = 'approval' then return v_plan; end if;
  perform pg_temp.as_user(v_ops, v_org, 'ops_admin');
  select outcome into v_o from projects.decide_deployment_plan(v_plan, 'approve', 'reviewed');
  if v_o is distinct from 'approved' then raise exception 'FAILED: fixture: plan not approved: %', v_o; end if;
  perform pg_temp.as_service();
  select t.deployment_id into v_dep from projects.request_deployment(v_plan, 'k1') t;
  perform projects.record_deployment_progress(v_dep, 'started', null, null, v_dl, p_hash);
  if p_stage = 'started' then return v_dep; end if;
  if p_stage = 'failed' then perform projects.record_deployment_progress(v_dep, 'failed', 'https://ci.example.test/deploy/f', 'the migration step timed out', v_dl, p_hash); return v_dep; end if;
  perform projects.record_deployment_progress(v_dep, 'succeeded_pending_validation', 'https://ci.example.test/deploy/1', 'deployed', v_dl, p_hash);
  return v_dep;
end $$;
grant execute on function pg_temp.p7_drive(uuid, text, text) to public;

create or replace function pg_temp.pass_all(p_run uuid, p_fail text default null) returns void language plpgsql as $$
declare k text;
begin
  foreach k in array array['app_starts', 'critical_routes', 'authentication', 'core_api', 'database', 'primary_workflow', 'monitoring_logging', 'no_critical_runtime_error'] loop
    if p_fail is not null and k = p_fail then perform projects.record_validation_check(p_run, k, 'failed', null, k || ' failed in production');
    else perform projects.record_validation_check(p_run, k, 'passed', 'https://smoke.example.test/' || p_run || '/' || k); end if;
  end loop;
end $$;
grant execute on function pg_temp.pass_all(uuid, text) to public;

-- an independent person (QA) runs the smoke test; p_fail names a check that fails (null: all pass)
create or replace function pg_temp.smoke(p_dep uuid, p_fail text default null) returns uuid language plpgsql as $$
declare v_org uuid := current_setting('p7c.org')::uuid; v_run uuid;
begin
  perform pg_temp.as_user(current_setting('p7c.qa')::uuid, v_org, 'member');
  select t.run_id into v_run from projects.open_validation_run(p_dep, 'smoke') t;
  perform pg_temp.pass_all(v_run, p_fail);
  perform projects.finish_validation_run(v_run, case when p_fail is null then null else 'a required check failed' end);
  return v_run;
end $$;
grant execute on function pg_temp.smoke(uuid, text) to public;

-- a completed project for Phase 8 (the facts the intake reads), then a started workspace
create or replace function pg_temp.mk8(p_code text, p_org uuid default null) returns table (client uuid, project uuid)
language plpgsql as $$
declare v_org uuid := coalesce(p_org, current_setting('p7c.org')::uuid); v_a uuid; v_p uuid; v_sv uuid;
begin
  insert into core.client_accounts (organization_id, name) values (v_org, 'zztest p7c ' || p_code) returning id into v_a;
  insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (v_org, v_a, 'zztest p7c ' || p_code, p_code, 'completed') returning id into v_p;
  insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at) values (v_org, v_p, 1, 'active', now()) returning id into v_sv;
  alter table projects.handovers disable trigger user;
  insert into projects.handovers (organization_id, project_id, status, delivered_at, accepted_at) values (v_org, v_p, 'accepted', now(), now());
  alter table projects.handovers enable trigger user;
  insert into projects.release_verifications (organization_id, project_id, environment, outcome) values (v_org, v_p, 'production', 'passed');
  insert into crm.contacts (organization_id, client_account_id, full_name, email) values (v_org, v_a, 'Contact ' || p_code, lower(p_code) || '@client.example.test');
  alter table projects.completion_records disable trigger user;
  insert into projects.completion_records (organization_id, project_id, client_account_id, scope_version_id, scope_version, invoiced_minor, verified_minor, completed_at, known_limitations)
  values (v_org, v_p, v_a, v_sv, 1, 0, 0, now(), 'none known at completion');
  alter table projects.completion_records enable trigger user;
  return query select v_a, v_p;
end $$;
grant execute on function pg_temp.mk8(text, uuid) to public;

create or replace function pg_temp.open8(p_code text) returns table (client uuid, project uuid) language plpgsql as $$
declare v_org uuid := current_setting('p7c.org')::uuid; v_a uuid; v_p uuid; v_o text;
begin
  select m.client, m.project into v_a, v_p from pg_temp.mk8(p_code) m;
  perform pg_temp.as_service();
  select outcome into v_o from projects.fill_phase_eight_intake(v_org, v_p);
  if v_o is distinct from 'ready' then raise exception 'FAILED: fixture: intake % is %', p_code, v_o; end if;
  perform pg_temp.as_user(current_setting('p7c.st8')::uuid, v_org, 'member');
  select outcome into v_o from projects.start_phase_eight(v_p, current_date - 10, current_date + 80, 'defects in the delivered scope', 'new features, third-party outages', null, current_setting('p7c.cso')::uuid);
  if v_o is distinct from 'started' then raise exception 'FAILED: fixture: phase eight % did not start: %', p_code, v_o; end if;
  return query select v_a, v_p;
end $$;
grant execute on function pg_temp.open8(text) to public;

-- ═════════ 1. the Phase 8A sweeps ═════════
select client as "E_a", project as "E_p" from pg_temp.open8('P7C-E8') \gset
select client as "F_a", project as "F_p" from pg_temp.open8('P7C-F8') \gset
select client as "G_a", project as "G_p" from pg_temp.open8('P7C-G8') \gset
select pg_temp.check((select count(*) = 1 from projects.phase_eight where project_id = :'E_p' and state = 'active') and (select count(*) = 1 from projects.phase_eight where project_id = :'F_p' and state = 'active'), 'fixture: three active Phase 8 workspaces');
-- G is paused by a person's decision (a direct, trigger-off fixture edit: the pause door is not part of this slice)
alter table projects.phase_eight disable trigger user;
update projects.phase_eight set state = 'paused', state_reason = 'the client asked us to pause support' where project_id = :'G_p';
alter table projects.phase_eight enable trigger user;

-- 1a. health: scheduled snapshots, written only when the status changed
select pg_temp.as_service();
select count(*) as "E_snap0" from projects.customer_health_snapshots where project_id = :'E_p' \gset
select count(*) as "G_snap0" from projects.customer_health_snapshots where project_id = :'G_p' \gset
select checked as "H1_checked", recorded as "H1_recorded" from projects.sweep_phase_eight_health(:'ORG') \gset
select pg_temp.check(:'H1_checked'::int = (select count(*) from projects.phase_eight where organization_id = :'ORG' and state = 'active') and :'H1_recorded'::int = 0, 'health sweep: exactly the ACTIVE workspaces are read, and an unchanged status writes no snapshot');
select pg_temp.check((select count(*) from projects.customer_health_snapshots where project_id = :'E_p') = :'E_snap0'::int, 'health sweep: a quiet account gained no snapshot');
select pg_temp.check((select count(*) from projects.customer_health_snapshots where project_id = :'G_p') = :'G_snap0'::int, 'health sweep: a PAUSED workspace is not read');
-- three open tickets move the account to WATCH (default threshold 3)
select ticket_id as "TE1" from projects.open_support_ticket(:'ORG', :'E_p', 'one', 'x', 'portal', 'p7c-e1') \gset
select ticket_id as "TE2" from projects.open_support_ticket(:'ORG', :'E_p', 'two', 'x', 'portal', 'p7c-e2') \gset
select ticket_id as "TE3" from projects.open_support_ticket(:'ORG', :'E_p', 'three', 'x', 'portal', 'p7c-e3') \gset
select pg_temp.check((select count(*) from projects.customer_health_snapshots where project_id = :'E_p') = :'E_snap0'::int + 0, 'a ticket opened by itself writes no snapshot: the scheduled sweep is what reads');
select recorded as "H2_recorded" from projects.sweep_phase_eight_health(:'ORG') \gset
select pg_temp.check(:'H2_recorded'::int >= 1 and (select status from projects.customer_health_snapshots where project_id = :'E_p' order by seq desc limit 1) = 'watch'
                     and (select trigger from projects.customer_health_snapshots where project_id = :'E_p' order by seq desc limit 1) = 'scheduled', 'health sweep: a changed status is recorded once as a SCHEDULED snapshot');
select recorded as "H3_recorded" from projects.sweep_phase_eight_health(:'ORG') \gset
select pg_temp.check((select count(*) from projects.customer_health_snapshots where project_id = :'E_p') = :'E_snap0'::int + 1, 'health sweep: a replay writes nothing twice');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select checked from projects.sweep_phase_eight_health(:'ORG')) = 0, 'NEGATIVE: a signed-in person calling the sweep gets nothing (the role is checked inside)');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.errs(format('select * from projects.sweep_phase_eight_health(%L)', :'ORG'), 'permission denied'), 'NEGATIVE: the health sweep is not granted to a signed-in role');
reset role;

-- 1b. check-ins that came due are NOTICED, once, and nobody is contacted
select pg_temp.as_service();
select md5(string_agg(to_jsonb(c)::text, '|' order by c.id)) as "CI_before" from projects.cs_check_ins c where c.project_id in (:'E_p', :'F_p', :'G_p') \gset
select checked as "C0_checked", noticed as "C0_noticed" from projects.sweep_checkins_due(:'ORG') \gset
select pg_temp.check((select count(*) from projects.cs_check_in_due_notices where project_id in (:'E_p', :'F_p', :'G_p')) = 0, 'check-in sweep: a check-in due in 7 days is not due today, and nothing is noticed');
-- an open P1 ticket on F: a relationship contact is not allowed while it is open
select ticket_id as "TF1" from projects.open_support_ticket(:'ORG', :'F_p', 'site is down', 'everything is down', 'phone', 'p7c-f1') \gset
select pg_temp.as_user(:'ST8', :'ORG', 'member');
select pg_temp.check((select outcome from projects.classify_support_ticket(:'TF1', 'warranty_bug', 'covered_warranty', 'the site is down as delivered', 'p1', null)) = 'classified', 'fixture: an open P1 ticket on F');
select pg_temp.as_service();
select checked as "C1_checked", noticed as "C1_noticed" from projects.sweep_checkins_due(:'ORG', now() + interval '9 days') \gset
select pg_temp.check(:'C1_noticed'::int >= 2, 'check-in sweep: two due check-ins are noticed (the paused workspace is not)');
select pg_temp.check((select count(*) from projects.cs_check_in_due_notices where project_id = :'E_p') = 1 and (select count(*) from projects.cs_check_in_due_notices where project_id = :'F_p') = 1, 'check-in sweep: one notice per due check-in');
select pg_temp.check((select count(*) from projects.cs_check_in_due_notices where project_id = :'G_p') = 0, 'check-in sweep: a PAUSED workspace gets no notice');
select pg_temp.check((select relationship_allowed and cardinality(reasons) = 0 and kind = 'post_handover' and cs_owner = :'CSO'::uuid from projects.cs_check_in_due_notices where project_id = :'E_p'), 'the notice for a calm account says a relationship contact is allowed, and names its Customer Success owner');
select pg_temp.check((select not relationship_allowed and array_to_string(reasons, '|') like '%open P1%' from projects.cs_check_in_due_notices where project_id = :'F_p'), 'the notice for an account with an open P1 says it is NOT allowed and why');
select pg_temp.check((select count(*) from core.outbox_events where type = 'customer.check_in_due' and subject_id in (select check_in_id from projects.cs_check_in_due_notices where project_id in (:'E_p', :'F_p'))) = 2, 'one customer.check_in_due event per notice');
select noticed as "C2_noticed", checked as "C2_checked" from projects.sweep_checkins_due(:'ORG', now() + interval '9 days') \gset
select pg_temp.check(:'C2_noticed'::int = 0 and :'C2_checked'::int = 0 and (select count(*) from projects.cs_check_in_due_notices where project_id in (:'E_p', :'F_p')) = 2, 'check-in sweep: a replay notices nothing twice');
select pg_temp.check((select md5(string_agg(to_jsonb(c)::text, '|' order by c.id)) from projects.cs_check_ins c where c.project_id in (:'E_p', :'F_p', :'G_p')) = :'CI_before', 'the sweep changed no check-in: it completes, skips and contacts nothing');
select pg_temp.check(pg_temp.errs(format('update projects.cs_check_in_due_notices set relationship_allowed = true where project_id = %L', :'F_p'), 'history'), 'a notice is history: it is never edited');
select pg_temp.check(pg_temp.errs(format('insert into projects.cs_check_in_due_notices (organization_id, project_id, check_in_id, kind, due_on, relationship_allowed) select organization_id, project_id, check_in_id, kind, due_on, true from projects.cs_check_in_due_notices where project_id = %L', :'F_p'), 'duplicate key'), 'a check-in has at most one notice (the database says so, not only the sweep)');
select check_in_id as "CIN" from projects.create_check_in(:'E_p', 'scheduled', 'p7c-negative', current_date, null, null, :'ORG') \gset
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select checked + noticed from projects.sweep_checkins_due(:'ORG', now() + interval '1 day')) = 0 and (select count(*) from projects.cs_check_in_due_notices where check_in_id = :'CIN') = 0, 'NEGATIVE: a signed-in person calling the check-in sweep, with a due check-in waiting, notices nothing');
select pg_temp.as_service();
select noticed as "CIN_noticed" from projects.sweep_checkins_due(:'ORG', now() + interval '1 day') \gset
select pg_temp.check(:'CIN_noticed'::int = 1 and (select count(*) from projects.cs_check_in_due_notices where check_in_id = :'CIN') = 1, 'and the service role notices it (a check-in due today is due)');
select pg_temp.as_user(:'ST8', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.cs_check_in_due_notices where project_id = :'E_p') = 2, 'staff of the organization read the notices (they are theirs to act on)');
select pg_temp.check(pg_temp.denied(format('insert into projects.cs_check_in_due_notices (organization_id, project_id, check_in_id, kind, due_on, relationship_allowed) select organization_id, project_id, id, kind, due_on, true from projects.cs_check_ins where project_id = %L', :'G_p')), 'a person cannot write a notice directly');
reset role;
select pg_temp.as_client(:'CL1', :'ORG', :'E_a');
set local role authenticated;
select pg_temp.check((select count(*) from projects.cs_check_in_due_notices) = 0, 'a client reads no internal notice');
reset role;
select pg_temp.as_user(:'OTHER', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.cs_check_in_due_notices) = 0, 'another organization reads no notice');
reset role;

-- 1c. the SLA sweep is still the service role's
select pg_temp.as_service();
select pg_temp.check((select response_breaches >= 0 and escalated >= 0 from projects.sweep_support_sla(:'ORG')) is true, 'the SLA sweep answers the service role');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select response_breaches + resolution_breaches + escalated from projects.sweep_support_sla(:'ORG')) = 0, 'NEGATIVE: a signed-in person calling the SLA sweep stamps nothing');

-- ═════════ 2. a client's support message opens a ticket (it never replies) ═════════
-- a project conversation of E (active), one of G (paused), one of a completed project with no workspace, and a post-project client thread
select pg_temp.as_service();
insert into crm.conversations (organization_id, kind, project_id, channel, title) values (:'ORG', 'project_group', :'E_p', 'whatsapp', 'E group') returning id \gset CE_
insert into crm.conversations (organization_id, kind, project_id, channel, title) values (:'ORG', 'project_group', :'G_p', 'whatsapp', 'G group') returning id \gset CG_
select project as "N_p" from pg_temp.mk8('P7C-NO8') \gset
insert into crm.conversations (organization_id, kind, project_id, channel, title) values (:'ORG', 'project_group', :'N_p', 'whatsapp', 'no workspace group') returning id \gset CN_
insert into crm.conversations (organization_id, kind, client_account_id, channel, title) values (:'ORG', 'client_account', :'E_a', 'whatsapp', 'E account thread') returning id \gset CA_
create or replace function pg_temp.msg(p_conv uuid, p_seq int, p_author text, p_intent text, p_body text, p_age interval default interval '1 hour') returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, intent, occurred_at, created_at)
  values (current_setting('p7c.org')::uuid, p_conv, p_seq, p_author, p_body, p_intent, now() - p_age, now() - p_age) returning id into v;
  return v;
end $$;
grant execute on function pg_temp.msg(uuid, int, text, text, text, interval) to public;
select count(*) as "MSG_before" from crm.conversation_messages where conversation_id = :'CE_id' \gset

select pg_temp.msg(:'CE_id', 1, 'client', 'support_request', 'The checkout button does nothing since Tuesday, please help') as "M1" \gset
select pg_temp.as_service();
select outcome as "O1", ticket_id as "T_M1" from projects.open_support_ticket_from_message(:'ORG', :'M1') \gset
select pg_temp.check(:'O1' = 'opened' and :'T_M1' is not null, 'a client support_request in an active workspace''s project conversation opens a ticket');
select pg_temp.check((select source = 'whatsapp' and source_ref = :'M1' and status = 'new' and project_id = :'E_p'::uuid and client_account_id = :'E_a'::uuid and title like 'Client message: The checkout button%' and description like 'The checkout button does nothing%' from projects.support_tickets where id = :'T_M1'),
                     'the ticket carries the project, the account, the channel, the message id as its source reference and the client''s words');
select pg_temp.check((select outcome = 'duplicate' and ticket_id = :'T_M1'::uuid from projects.open_support_ticket_from_message(:'ORG', :'M1')), 'a repeated delivery is the SAME ticket (duplicate)');
select pg_temp.check((select count(*) from projects.support_tickets where source_ref = :'M1') = 1, 'a repeated delivery created no second ticket');
select pg_temp.check((select count(*) from core.outbox_events where type = 'support.ticket_created' and subject_id = :'T_M1') = 1, 'SupportTicketCreated is emitted once');
select pg_temp.check((select count(*) from crm.conversation_messages where conversation_id = :'CE_id') = :'MSG_before'::int + 1, 'nothing replied: the conversation gained only the client''s own message');
select pg_temp.check((select status = 'new' and classification is null and priority is null and first_response_at is null from projects.support_tickets where id = :'T_M1'), 'the ticket is unclassified and unanswered: a person triages it');

select pg_temp.msg(:'CE_id', 2, 'client', 'price_inquiry', 'How much would a new feature cost?') as "M2" \gset
select pg_temp.msg(:'CE_id', 3, 'client', null, 'a message nobody has labelled yet', interval '1 minute') as "M3" \gset
select pg_temp.msg(:'CE_id', 4, 'client', null, 'a message nobody ever labelled', interval '2 hours') as "M4" \gset
select pg_temp.msg(:'CE_id', 5, 'user', 'support_request', 'a staff member wrote this and it is labelled') as "M5" \gset
select pg_temp.msg(:'CG_id', 1, 'client', 'support_request', 'support needed on the paused workspace') as "M6" \gset
select pg_temp.msg(:'CN_id', 1, 'client', 'support_request', 'support needed but no workspace exists') as "M7" \gset
select pg_temp.msg(:'CA_id', 1, 'client', 'support_request', 'support needed in the post-project account thread') as "M8" \gset
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', :'M2')) = 'not_a_support_request', 'NEGATIVE: another intent label opens nothing');
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', :'M3')) = 'intent_pending', 'NEGATIVE: a young message with no label yet opens nothing (the sweep catches a late label)');
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', :'M4')) = 'no_intent_label', 'NEGATIVE: an old message that was never labelled opens nothing');
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', :'M5')) = 'not_a_client_message', 'NEGATIVE: a staff message is never a client request');
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', :'M6')) = 'workspace_not_active', 'NEGATIVE: a PAUSED workspace opens no ticket from a message');
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', :'M7')) = 'no_phase_eight', 'NEGATIVE: a project with no Phase 8 workspace opens no ticket');
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', :'M8')) = 'not_a_project_conversation', 'NEGATIVE: a post-project account thread is not a project conversation');
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG2', :'M1')) = 'not_found', 'NEGATIVE: another organization''s service call cannot reach this message');
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', gen_random_uuid())) = 'not_found', 'an unknown message opens nothing');
select pg_temp.check((select count(*) from projects.support_tickets where source_ref in (:'M2', :'M3', :'M4', :'M5', :'M6', :'M7', :'M8')) = 0, 'none of the refused messages left a ticket');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', :'M1')) = 'not_authorized', 'NEGATIVE: a signed-in person cannot call the message door (the role is checked inside)');
set local role authenticated;
select pg_temp.check(pg_temp.errs(format('select * from projects.open_support_ticket_from_message(%L, %L)', :'ORG', :'M1'), 'permission denied'), 'NEGATIVE: the message door is not granted to a signed-in role');
reset role;

-- a label that arrives after the event was handled: the sweep opens the ticket once
select pg_temp.as_service();
select pg_temp.msg(:'CE_id', 6, 'client', null, 'the export fails every night, urgent', interval '1 hour') as "M9" \gset
select pg_temp.check((select outcome from projects.open_support_ticket_from_message(:'ORG', :'M9')) = 'no_intent_label', 'before its label arrives the late message opens nothing');
update crm.conversation_messages set intent = 'support_request' where id = :'M9';
select opened as "S1_opened" from projects.sweep_message_support_tickets(:'ORG') \gset
select pg_temp.check(:'S1_opened'::int = 1 and (select count(*) from projects.support_tickets where source_ref = :'M9') = 1, 'the sweep opens the ticket for a label that arrived late');
select pg_temp.check((select checked + opened from projects.sweep_message_support_tickets(:'ORG')) = 0, 'a replay of the sweep looks at nothing and opens nothing twice');
select pg_temp.msg(:'CE_id', 7, 'client', 'support_request', 'an old support request from last week', interval '5 days') as "M10" \gset
select pg_temp.check((select checked + opened from projects.sweep_message_support_tickets(:'ORG')) = 0 and (select count(*) from projects.support_tickets where source_ref = :'M10') = 0, 'the sweep ignores a message older than three days');
select pg_temp.msg(:'CG_id', 2, 'client', 'support_request', 'another one on the paused workspace', interval '1 hour') as "M11" \gset
select pg_temp.check((select checked + opened from projects.sweep_message_support_tickets(:'ORG')) = 0 and (select count(*) from projects.support_tickets where source_ref = :'M11') = 0, 'the sweep looks at nothing for a paused workspace');
select pg_temp.msg(:'CE_id', 8, 'client', 'support_request', 'the invoice page shows an error since this morning', interval '30 minutes') as "M12" \gset
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select checked + opened from projects.sweep_message_support_tickets(:'ORG')) = 0 and (select count(*) from projects.support_tickets where source_ref = :'M12') = 0, 'NEGATIVE: a signed-in person calling the message sweep, with a labelled message waiting, opens nothing');
select pg_temp.as_service();
select opened as "M12_opened" from projects.sweep_message_support_tickets(:'ORG') \gset
select pg_temp.check(:'M12_opened'::int = 1 and (select count(*) from projects.support_tickets where source_ref = :'M12') = 1, 'and the service role opens it');

-- ══════════ the Phase 7 fixtures: five projects (the Phase 6 evidence is seeded with triggers off; every Phase 7 rule below runs live) ══════════
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'A_id', 'zztest p7c P7C-A', null, 'active') returning id as p \gset PA_
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'A_id', 'zztest p7c P7C-B', null, 'active') returning id as p \gset PB_
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'A_id', 'zztest p7c P7C-C', null, 'active') returning id as p \gset PC_
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'A_id', 'zztest p7c P7C-D', null, 'active') returning id as p \gset PD_
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'A_id', 'zztest p7c P7C-E', null, 'active') returning id as p \gset PE_
set local session_replication_role = replica;
select pg_temp.seed_p7(:'ORG', :'A_id', :'PA_p', 'P7C-A', 'abc0001', :'H1', :'OWNER') as "PA_seeded" \gset
select pg_temp.seed_p7(:'ORG', :'A_id', :'PB_p', 'P7C-B', 'abc0002', :'H2', :'OWNER') as "PB_seeded" \gset
select pg_temp.seed_p7(:'ORG', :'A_id', :'PC_p', 'P7C-C', 'abc0003', :'H3', :'OWNER') as "PC_seeded" \gset
select pg_temp.seed_p7(:'ORG', :'A_id', :'PD_p', 'P7C-D', 'abc0004', :'H4', :'OWNER') as "PD_seeded" \gset
select pg_temp.seed_p7(:'ORG', :'A_id', :'PE_p', 'P7C-E', 'abc0005', '5555555555555555555555555555555555555555555555555555555555555555', :'OWNER') as "PE_seeded" \gset
set local session_replication_role = origin;
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'A_id', 'zztest p7c legacy', 'P7C-LEG', 'active') returning id \gset L_

select pg_temp.p7_drive(:'PA_p', 'succeeded', :'H1') as "DA_d" \gset
select pg_temp.p7_drive(:'PB_p', 'succeeded', :'H2') as "DB_d" \gset
select pg_temp.p7_drive(:'PC_p', 'failed', :'H3') as "DC_d" \gset
select pg_temp.p7_drive(:'PD_p', 'approval', :'H4') as "PLD_pl" \gset
select pg_temp.p7_drive(:'PE_p', 'succeeded', '5555555555555555555555555555555555555555555555555555555555555555') as "DE_d" \gset
select pg_temp.check((select count(*) = 5 from projects.phase_seven where project_id in (:'PA_p', :'PB_p', :'PC_p', :'PD_p', :'PE_p')), 'fixture: five projects are in Phase 7, driven through the real doors');
select pg_temp.check((select status = 'failed' from projects.p7_deployments where id = :'DC_d') and (select status = 'succeeded_pending_validation' from projects.p7_deployments where id = :'DA_d'), 'fixture: C has a failed deployment, A a deployment awaiting live validation');

-- ═════════ 3. ClientActionRequest ═════════
select pg_temp.as_user(:'QA', :'ORG', 'member');
select pg_temp.check((select outcome from projects.create_client_action_request(:'PB_p', 'dns_change', 'Point the apex domain', 'Point the A record at the production host', now() + interval '5 days')) = 'not_authorized', 'NEGATIVE: a member without delivery rights cannot raise a client action');
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select outcome from projects.create_client_action_request(:'PB_p', 'dns_change', 'Point the apex domain', 'Point the A record at the production host', now() + interval '5 days')) = 'not_authorized', 'NEGATIVE: a client cannot raise a request for itself');
select pg_temp.as_user(:'OTHER', :'ORG2', 'owner');
select pg_temp.check((select outcome from projects.create_client_action_request(:'PB_p', 'dns_change', 'Point the apex domain', 'Point the A record at the production host', now() + interval '5 days')) = 'not_found', 'NEGATIVE: another organization cannot raise a request on this project');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.create_client_action_request(:'PB_p', 'carrier_pigeon', 'x', 'y', now() + interval '5 days')) = 'bad_kind', 'an unknown kind is refused');
select pg_temp.check((select outcome from projects.create_client_action_request(:'PB_p', 'dns_change', '  ', 'Point the A record', now() + interval '5 days')) = 'bad_title', 'a request needs a title');
select pg_temp.check((select outcome from projects.create_client_action_request(:'PB_p', 'dns_change', 'Point the apex domain', '   ', now() + interval '5 days')) = 'instructions_required', 'a request needs its exact instruction');
select pg_temp.check((select outcome from projects.create_client_action_request(:'PB_p', 'account_access', 'Share the store login', 'send us the key ' || 'sk-' || repeat('a', 24), now() + interval '5 days')) = 'contains_secret', 'a request never carries a secret');
select pg_temp.check((select outcome from projects.create_client_action_request(:'PB_p', 'dns_change', 'Point the apex domain', 'Point the A record at the production host', now() - interval '1 day')) = 'due_in_the_past', 'a request needs a deadline in the future');
select pg_temp.check((select outcome from projects.create_client_action_request(:'PB_p', 'dns_change', 'Point the apex domain', 'Point the A record at the production host', null)) = 'due_in_the_past', 'a request without a deadline is refused');
select pg_temp.check((select outcome from projects.create_client_action_request(:'L_id', 'dns_change', 'Point the apex domain', 'Point the A record at the production host', now() + interval '5 days')) = 'not_in_phase_seven', 'a project outside the Phase 7 pipeline takes no request');
select outcome as "R1_o", request_id as "R1" from projects.create_client_action_request(:'PB_p', 'dns_change', 'Point the apex domain', 'Point the A record at the production host', now() + interval '5 days') \gset
select pg_temp.check(:'R1_o' = 'raised' and :'R1' is not null, 'staff raise a client action request with a deadline');
select pg_temp.check((select outcome = 'already_open' and request_id = :'R1'::uuid from projects.create_client_action_request(:'PB_p', 'dns_change', '  POINT the apex domain ', 'again', now() + interval '6 days')), 'a duplicate raise is the same live request');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.client_action_requested' and subject_id = :'R1') = 1, 'one ClientActionRequested event');
select pg_temp.check((select client_account_id = :'A_id'::uuid and status = 'open' and created_by = :'DL'::uuid from projects.p7c_client_action_requests where id = :'R1'), 'the request is for the project''s own client account and starts open');

-- what the client sees
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select count(*) = 1 and bool_and(status = 'open' and not overdue and title = 'Point the apex domain') from projects.client_action_requests_for_client(:'PB_p')), 'the client reads its own request, open and not overdue');
select pg_temp.check((select count(*) from projects.client_action_requests_for_client(:'PA_p')) = 0, 'a project with no request reads nothing');
select pg_temp.as_client(:'CL3', :'ORG', :'A2_id');
select pg_temp.check((select count(*) from projects.client_action_requests_for_client(:'PB_p')) = 0, 'NEGATIVE: a client of ANOTHER account reads nothing of this project''s requests');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R1', 'I changed the record yesterday evening')) = 'not_found', 'NEGATIVE: a client of another account cannot answer it (it does not exist for them)');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select count(*) from projects.client_action_requests_for_client(:'PB_p')) = 0, 'staff read nothing through the client function (it is the client''s read)');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R1', 'staff answering on the client''s behalf')) = 'not_a_client', 'NEGATIVE: staff cannot answer a request on the client''s behalf');
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p7c_client_action_requests) = 0 and (select count(*) from projects.p7c_client_action_events) = 0, 'a client reads no internal table directly (RLS: internal only)');
select pg_temp.check(pg_temp.denied(format('update projects.p7c_client_action_requests set status = %L where id = %L', 'confirmed', :'R1')), 'a client cannot write the request table');
select pg_temp.check(pg_temp.denied(format('insert into projects.p7c_client_action_events (organization_id, request_id, event, actor_kind) values (%L, %L, %L, %L)', :'ORG', :'R1', 'confirmed', 'client')), 'a client cannot write the event table');
reset role;
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R1', 'too short')) = 'note_required', 'the client must say what it did');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R1', 'I changed the record, key is ' || 'sk-' || repeat('b', 24))) = 'contains_secret', 'the client''s note never carries a secret');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R1', 'I changed the record yesterday evening', 'https://tickets.example.test/dns/77')) = 'submitted', 'the client resolves it with a note and a reference');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R1', 'I changed the record yesterday evening')) = 'already_submitted', 'a second resolve is refused: it is already waiting for a person');
select pg_temp.check((select status = 'submitted' and submitted_at is not null from projects.client_action_requests_for_client(:'PB_p') where request_id = :'R1'), 'the client sees it as submitted, not done');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select status = 'submitted' and submitted_by = :'CL1'::uuid and submitted_name = 'Asha Verma' and submission_note like 'I changed the record%' and submission_ref = 'https://tickets.example.test/dns/77' and confirmed_at is null from projects.p7c_client_action_requests where id = :'R1'),
                     'a submission is a CLAIM: the request is submitted, named, noted, and NOT confirmed');

-- a person decides
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R1', 'confirmed', 'I confirm my own work for the record')) = 'not_authorized', 'NEGATIVE: a client cannot confirm its own claim');
select pg_temp.as_user(:'OTHER', :'ORG2', 'owner');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R1', 'confirmed', 'another organization confirming this')) = 'not_found', 'NEGATIVE: another organization cannot settle it');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R1', 'confirmed', 'ok')) = 'verification_required', 'confirming needs the person''s own verification in words');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R1', 'confirmed', null)) = 'verification_required', 'confirming with no verification is refused');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R1', 'rejected', null)) = 'note_required', 'sending it back needs a note for the client');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R1', 'sideways', 'x')) = 'bad_decision', 'an unknown decision is refused');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R1', 'rejected', 'The record still points to the old host: please check the apex, not www')) = 'rejected', 'a person sends the claim back with a note');
select pg_temp.check((select status = 'open' and returned_note like 'The record still%' and submitted_by is null and submission_note is null from projects.p7c_client_action_requests where id = :'R1'), 'the request is open again, carries the note, and the old claim is cleared (the event row keeps it)');
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select status = 'open' and returned_note like 'The record still%' from projects.client_action_requests_for_client(:'PB_p') where request_id = :'R1'), 'the client sees what was wrong');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R1', 'I corrected the apex record this morning', 'https://tickets.example.test/dns/78')) = 'submitted', 'the client answers again');
select pg_temp.check((select returned_note is null from projects.client_action_requests_for_client(:'PB_p') where request_id = :'R1'), 'the old note is cleared once the client answered');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R1', 'confirmed', 'Checked the DNS answer: the apex A record now points at the production host')) = 'confirmed', 'a person confirms with what they checked');
select pg_temp.check((select status = 'confirmed' and confirmed_by = :'DL'::uuid and confirmation_note like 'Checked the DNS answer%' from projects.p7c_client_action_requests where id = :'R1'), 'the confirmation is recorded with the person and their verification');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R1', 'confirmed', 'Checked it again for good measure here')) = 'already_settled', 'a confirmed request is settled once');
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select status = 'confirmed' and confirmed_at is not null and returned_note is null from projects.client_action_requests_for_client(:'PB_p') where request_id = :'R1'), 'the client sees it confirmed, and never the person''s internal verification note');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R1', 'answering a request that is already confirmed')) = 'not_open', 'a confirmed request takes no further answer');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select array_agg(event order by at, id) from projects.p7c_client_action_events where request_id = :'R1') = array['raised', 'submitted', 'returned', 'submitted', 'confirmed'], 'every step is an event row, in order (raised, submitted, returned, submitted, confirmed)');
select pg_temp.check((select count(*) = 1 from audit.audit_log where action = 'client_action.confirmed' and subject_id = :'R1'::uuid), 'the confirmation is audited');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p7c_client_action_requests set status = %L where id = %L', 'open', :'R1'), 'Phase 7 door'), 'a request is changed only through its doors (a direct statement is refused)');
select set_config('projects.p7_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('update projects.p7c_client_action_requests set title = %L where id = %L', 'something else', :'R1'), 'keeps what was asked'), 'what was asked, of whom and by when never changes');
select pg_temp.check(pg_temp.refused(format('update projects.p7c_client_action_requests set returned_note = %L where id = %L', 'rewriting history', :'R1'), 'history'), 'a confirmed request is history');
select pg_temp.check(pg_temp.refused(format('delete from projects.p7c_client_action_events where request_id = %L', :'R1'), 'history'), 'an event row is history: never edited or deleted');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('delete from projects.p7c_client_action_requests where id = %L', :'R1'), 'never deleted'), 'a request is never deleted');

-- cancel, and an overdue one
select request_id as "R2" from projects.create_client_action_request(:'PB_p', 'store_account', 'Open the developer store account', 'Create the account and add us as admin', now() + interval '10 days') \gset
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R2', 'cancelled', 'no')) = 'reason_required', 'cancelling says why');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R2', 'confirmed', 'Checked it myself, nothing was submitted')) = 'nothing_to_confirm', 'nothing is confirmed before the client has said it is done');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R2', 'cancelled', 'the client chose another store')) = 'cancelled', 'a person cancels a request, with the reason');
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select count(*) from projects.client_action_requests_for_client(:'PB_p') where request_id = :'R2') = 0, 'a cancelled request is no longer shown to the client');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R2', 'I did create the store account already')) = 'not_open', 'a cancelled request takes no answer');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select request_id as "R3" from projects.create_client_action_request(:'PB_p', 'content_supply', 'Send the logo files', 'Send the logo in SVG and PNG', now() + interval '2 days') \gset
alter table projects.p7c_client_action_requests disable trigger user;
update projects.p7c_client_action_requests set due_at = now() - interval '3 days' where id = :'R3';
alter table projects.p7c_client_action_requests enable trigger user;
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select overdue and status = 'open' from projects.client_action_requests_for_client(:'PB_p') where request_id = :'R3'), 'a request past its date is OVERDUE (derived, never stored) and still open');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R3', 'The logo files were sent by email on Friday')) = 'submitted', 'an overdue request can still be answered');
-- put R3 back to open for the failure queue below (a person sends the claim back)
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.settle_client_action_request(:'R3', 'rejected', 'We did not receive any email: please send the files here')) = 'rejected', 'fixture: R3 is back to open and overdue');
select request_id as "R4" from projects.create_client_action_request(:'PB_p', 'approval_input', 'Confirm the launch copy', 'Reply with your approval of the launch copy', now() + interval '9 days') \gset
select set_config('projects.p7_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('update projects.p7c_client_action_requests set status = %L, confirmed_at = now() where id = %L', 'confirmed', :'R4'), 'p7c_car_confirmed_is_verified'), 'even a door-flagged write cannot confirm a request without a person and their verification (the table says so, not only the door)');
select pg_temp.door_off();
-- settled requests are long past their dates: only an OPEN request can be overdue
alter table projects.p7c_client_action_requests disable trigger user;
update projects.p7c_client_action_requests set due_at = now() - interval '2 days' where id in (:'R1', :'R2');
alter table projects.p7c_client_action_requests enable trigger user;

-- ═════════ 4. the Phase 7 Failure Queue ═════════
select pg_temp.smoke(:'DA_d', 'critical_routes') as "VA_r" \gset
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.project_id = :'PA_p' and q.kind = 'validation_failed') = 1, 'a failed validation run is in the queue');
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.project_id = :'PA_p' and q.kind = 'incident_open') = 1, 'the open incident it raised is in the queue');
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.project_id = :'PC_p' and q.kind = 'deployment_failed') = 1 and (select count(*) from projects.p7_failure_queue() q where q.project_id = :'PC_p' and q.kind = 'incident_open') = 1, 'a failed deployment and its incident are in the queue');
select pg_temp.check((select detail like 'deployment attempt 1 failed%' from projects.p7_failure_queue() q where q.project_id = :'PC_p' and q.kind = 'deployment_failed'), 'each item says what failed');
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.project_id = :'PB_p' and q.kind = 'client_action_overdue' and q.subject_id = :'R3'::uuid) = 1 and (select count(*) from projects.p7_failure_queue() q where q.subject_id in (:'R1'::uuid, :'R2'::uuid)) = 0,
                     'an overdue client action is in the queue; a confirmed and a cancelled one are not');
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.subject_id = :'R4'::uuid) = 0, 'an open client action that is not yet due is not in the queue');
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.project_id = :'PD_p') = 0, 'an approval that has waited under a day is not stale');
select pg_temp.check((select count(*) = 1 and bool_and(age_hours >= 30) from projects.p7_failure_queue(null, 24, now() + interval '30 hours') q where q.project_id = :'PD_p' and q.kind = 'approval_stale'), 'an approval that waited past the stated age is stale, with its age');
select pg_temp.check((select count(*) from projects.p7_failure_queue(null, 24, now() + interval '30 hours') q where q.project_id = :'PD_p') = 1 and (select count(*) from projects.p7_failure_queue(null, 48, now() + interval '30 hours') q where q.project_id = :'PD_p') = 0, 'the age is the caller''s to state');
select pg_temp.check((select bool_and(since <= next_since) from (select q.since, lead(q.since) over (order by q.since, q.subject_id) as next_since from projects.p7_failure_queue() q where q.project_id in (:'PA_p', :'PB_p', :'PC_p')) o where next_since is not null), 'the queue is oldest first');
-- it is derived: when the cause is gone the item leaves
select pg_temp.smoke(:'DA_d') as "VA2_r" \gset
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.project_id = :'PA_p' and q.kind = 'validation_failed') = 0 and (select count(*) from projects.p7_failure_queue() q where q.project_id = :'PA_p' and q.kind = 'incident_open') = 1,
                     'derived: once a later run passed, the failed validation leaves the queue (the open incident stays until a person closes it)');
-- a later deployment attempt after the failed one: the failed deployment is no longer the project's current state
alter table projects.p7_deployments disable trigger user;
insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key, status, executor, created_at, requested_at)
  select organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt + 1, 'p7c-later', 'requested', 'runner', clock_timestamp(), clock_timestamp() from projects.p7_deployments where id = :'DC_d';
alter table projects.p7_deployments enable trigger user;
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.project_id = :'PC_p' and q.kind = 'deployment_failed') = 0 and (select count(*) from projects.p7_failure_queue() q where q.project_id = :'PC_p' and q.kind = 'incident_open') = 1,
                     'derived: a failed deployment followed by another attempt leaves the queue');
alter table projects.p7_incidents disable trigger user;
update projects.p7_incidents set state = 'closed', closed_at = now(), reviewed_by = :'OPS', root_cause = 'the migration step timed out', corrective_actions = 'add a timeout alarm' where project_id = :'PC_p';
alter table projects.p7_incidents enable trigger user;
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.project_id = :'PC_p') = 0, 'derived: a closed incident leaves the queue');
-- who may read it
select pg_temp.as_user(:'OTHER', :'ORG2', 'owner');
select pg_temp.check((select count(*) from projects.p7_failure_queue()) = 0, 'NEGATIVE: another organization''s staff read none of this organization''s failures');
select pg_temp.check((select count(*) from projects.p7_failure_queue(:'ORG')) = 0, 'NEGATIVE: and cannot name this organization to read it');
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select count(*) from projects.p7_failure_queue()) = 0, 'NEGATIVE: a client reads nothing of the failure queue');
select pg_temp.as_service();
select pg_temp.check((select count(*) > 0 from projects.p7_failure_queue(:'ORG')) and (select count(*) = 0 from projects.p7_failure_queue(:'ORG2')), 'the service role reads one organization at a time');
select pg_temp.check(not has_function_privilege('anon', 'projects.p7_failure_queue(uuid,int,timestamptz)', 'execute'), 'anon cannot call the failure queue');

-- ═════════ 5. the automatic DRAFT handover package on ProductionValidated ═════════
select pg_temp.smoke(:'DB_d') as "VB_r" \gset
select pg_temp.smoke(:'DE_d') as "VE_r" \gset
select id as "PHB_id" from projects.phase_seven where project_id = :'PB_p' \gset
select id as "PHE_id" from projects.phase_seven where project_id = :'PE_p' \gset
select pg_temp.check((select state = 'production_validated' from projects.phase_seven where id = :'PHB_id') and (select count(*) = 1 from core.outbox_events where type = 'project.production_validated' and subject_id = :'PHB_id'::uuid), 'fixture: B is PRODUCTION VALIDATED (one ProductionValidated event, the event the subscriber reads)');
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.create_draft_handover_package_for_validated(:'ORG', :'PHB_id')) = 'contract_deliverables_missing', 'with no contract checklist nothing is invented: no draft is created');
select pg_temp.check((select count(*) from projects.p7_handover_packages where project_id = :'PB_p') = 0, 'and no package row exists');
select pg_temp.check((select outcome from projects.create_draft_handover_package_for_validated(:'ORG', (select id from projects.phase_seven where project_id = :'PA_p'))) = 'production_not_validated', 'a project with an open incident (not validated) gets no draft');
select pg_temp.check((select outcome from projects.create_draft_handover_package_for_validated(:'ORG2', :'PHB_id')) = 'not_found', 'NEGATIVE: another organization''s service call cannot reach this workspace');
select pg_temp.check((select outcome from projects.create_draft_handover_package_for_validated(:'ORG', gen_random_uuid())) = 'not_found', 'an unknown workspace creates nothing');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.create_draft_handover_package_for_validated(:'ORG', :'PHB_id')) = 'not_authorized', 'NEGATIVE: a signed-in person cannot call the automatic door (the role is checked inside)');
set local role authenticated;
select pg_temp.check(pg_temp.errs(format('select * from projects.create_draft_handover_package_for_validated(%L, %L)', :'ORG', :'PHB_id'), 'permission denied'), 'NEGATIVE: the automatic door is not granted to a signed-in role');
reset role;
-- the contract checklist is a person's record; the catch-up sweep then creates the draft
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select projects.record_contract_deliverable(:'PB_p', 'source_repository', 'Source repository ownership', true);
select projects.record_contract_deliverable(:'PB_p', 'deployment_docs', 'Deployment and configuration guide', true);
select projects.record_contract_deliverable(:'PB_p', 'training', 'Training sessions', false, 'training is not in this contract');
select projects.record_contract_deliverable(:'PA_p', 'source_repository', 'Source repository ownership', true);
select pg_temp.as_service();
select checked as "SW_checked", created as "SW_created" from projects.sweep_draft_handover_packages(:'ORG') \gset
select pg_temp.check(:'SW_created'::int = 1 and :'SW_checked'::int = 1, 'the catch-up sweep looks only at validated projects with a checklist and no package (B, not the unvalidated A, not the checklist-less E) and creates the draft');
select id as "PKB" from projects.p7_handover_packages where project_id = :'PB_p' \gset
select pg_temp.check((select status = 'draft' and version = 1 and created_by is null and commit_ref = 'abc0002' and artifact_sha256 = :'H2' and admin_approved_by is null and delivered_at is null and delivered_by is null from projects.p7_handover_packages where id = :'PKB'),
                     'the package is a DRAFT version 1 for the exact validated release, created by nobody, approved by nobody, delivered to nobody');
select pg_temp.check((select count(*) = 9 from projects.p7_handover_items where package_id = :'PKB') and (select count(*) = 6 from projects.p7_handover_items where package_id = :'PKB' and kind in ('scope', 'release', 'production_url', 'known_limitations', 'support_warranty', 'emergency_contacts')), 'six standing items plus one per contract deliverable');
select pg_temp.check((select status = 'not_required' and required = false and reason = 'training is not in this contract' from projects.p7_handover_items where package_id = :'PKB' and kind = 'training'), 'a contract exclusion is NOT_REQUIRED with its reason, never silently dropped');
select pg_temp.check((select count(*) = 0 from projects.p7_handover_items where package_id = :'PKB' and status = 'ready'), 'no item is ready: a person supplies every artifact');
select pg_temp.check((select state = 'handover_preparing' from projects.phase_seven where id = :'PHB_id'), 'the workspace moved to HANDOVER_PREPARING, no further');
select pg_temp.check((select count(*) = 1 from core.outbox_events where type = 'project.handover_draft_created' and subject_id = :'PKB'::uuid) and (select count(*) = 1 from audit.audit_log where action = 'handover_package.draft_created' and subject_id = :'PKB'::uuid), 'the draft is audited and announced once');
select pg_temp.check((select count(*) = 0 from core.outbox_events where subject_id = :'PKB'::uuid and type in ('project.handover_delivered', 'project.handover_admin_review_requested')) and (select count(*) = 0 from projects.p7_handover_reviews where package_id = :'PKB'), 'nothing was submitted, reviewed or delivered');
select pg_temp.check((select outcome = 'already_exists' and package_id = :'PKB'::uuid from projects.create_draft_handover_package_for_validated(:'ORG', :'PHB_id')), 'a replay of the event finds the package that exists');
-- a project can return to production_validated while its package exists (a change after launch, re-validated): the sweep must still see the package
alter table projects.phase_seven disable trigger user;
update projects.phase_seven set state = 'production_validated' where id = :'PHB_id';
alter table projects.phase_seven enable trigger user;
select pg_temp.check((select checked + created from projects.sweep_draft_handover_packages(:'ORG')) = 0 and (select count(*) from projects.p7_handover_packages where project_id = :'PB_p') = 1, 'a replay of the sweep looks at nothing and creates no second package, even for a project that is validated again');
alter table projects.phase_seven disable trigger user;
update projects.phase_seven set state = 'handover_preparing' where id = :'PHB_id';
alter table projects.phase_seven enable trigger user;
-- E: the event path (checklist recorded BEFORE the event is handled), and the money gate re-read at the moment of creation
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select projects.record_contract_deliverable(:'PE_p', 'source_repository', 'Source repository ownership', true);
alter table finance.invoices disable trigger user;
update finance.invoices set status = 'issued', paid_minor = 0, verified_minor = 0 where project_id = :'PE_p';
alter table finance.invoices enable trigger user;
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.create_draft_handover_package_for_validated(:'ORG', :'PHE_id')) = 'm4_not_verified', 'a project whose M4 is not verified gets no draft (the financial gate is re-read)');
alter table finance.invoices disable trigger user;
update finance.invoices set status = 'paid', paid_minor = 100000, verified_minor = 100000 where project_id = :'PE_p';
alter table finance.invoices enable trigger user;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select checked + created from projects.sweep_draft_handover_packages(:'ORG')) = 0 and (select count(*) from projects.p7_handover_packages where project_id = :'PE_p') = 0, 'NEGATIVE: a signed-in person calling the draft sweep, with a validated project waiting, creates nothing');
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.create_draft_handover_package_for_validated(:'ORG', :'PHE_id')) = 'created', 'the event door creates the draft for a validated project with a checklist');
select pg_temp.check((select count(*) = 7 from projects.p7_handover_items i join projects.p7_handover_packages k on k.id = i.package_id where k.project_id = :'PE_p'), 'E''s draft has the six standing items and its one deliverable');

-- a handover package waiting for an Admin review (a fixture edit with the package guard off) is a stale approval once it has waited past the stated age
alter table projects.p7_handover_packages disable trigger user;
update projects.p7_handover_packages set status = 'admin_review' where project_id = :'PE_p';
alter table projects.p7_handover_packages enable trigger user;
select pg_temp.as_user(:'OPS', :'ORG', 'ops_admin');
select pg_temp.check((select count(*) from projects.p7_failure_queue() q where q.project_id = :'PE_p') = 0, 'a handover review that has waited under a day is not stale');
select pg_temp.check((select count(*) = 1 and bool_and(detail like 'handover package v1 has waited%') from projects.p7_failure_queue(null, 24, now() + interval '30 hours') q where q.project_id = :'PE_p' and q.kind = 'approval_stale'), 'a handover review that waited past the stated age is a stale approval');
alter table projects.p7_handover_packages disable trigger user;
update projects.p7_handover_packages set status = 'draft' where project_id = :'PE_p';
alter table projects.p7_handover_packages enable trigger user;

-- ═════════ 6. the client's financial statement ═════════
select pg_temp.as_service();
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'AS_id', 'zztest p7c statement project', 'P7C-STMT', 'active') returning id \gset S_
insert into projects.projects (organization_id, client_account_id, name, project_code, status) values (:'ORG', :'A2_id', 'zztest p7c other statement project', 'P7C-STMT2', 'active') returning id \gset S2_
alter table finance.invoices disable trigger user;
alter table finance.payments disable trigger user;
insert into finance.invoices (organization_id, client_account_id, project_id, number, kind, status, currency, subtotal_minor, total_minor, paid_minor, verified_minor, issued_at, due_at) values
  (:'ORG', :'AS_id', :'S_id', 'ZP7C-S1', 'service', 'partially_paid', 'INR', 100000, 100000, 40000, 40000, now() - interval '30 days', now() - interval '10 days'),
  (:'ORG', :'AS_id', :'S_id', 'ZP7C-S2', 'service', 'draft', 'INR', 5000, 5000, 0, 0, null, null),
  (:'ORG', :'AS_id', :'S_id', 'ZP7C-S3', 'service', 'pending_approval', 'INR', 6000, 6000, 0, 0, null, null),
  (:'ORG', :'AS_id', :'S_id', 'ZP7C-S4', 'service', 'partially_paid', 'INR', 20000, 20000, 20000, 0, now() - interval '5 days', now() + interval '20 days'),
  (:'ORG', :'AS_id', :'S_id', 'ZP7C-S5', 'service', 'void', 'INR', 7000, 7000, 0, 0, now() - interval '40 days', null),
  (:'ORG', :'A2_id', :'S2_id', 'ZP7C-T1', 'service', 'issued', 'INR', 99999, 99999, 0, 0, now() - interval '3 days', now() + interval '9 days');
insert into finance.payments (organization_id, invoice_id, provider, provider_payment_id, amount_minor, currency, status, captured_at, verified_at, verified_by)
  select organization_id, id, 'manual', 'p7c-pay-1', 40000, 'INR', 'captured', now() - interval '12 days', now() - interval '11 days', :'OWNER' from finance.invoices where number = 'ZP7C-S1' and organization_id = :'ORG';
insert into finance.payments (organization_id, invoice_id, provider, provider_payment_id, amount_minor, currency, status, captured_at)
  select organization_id, id, 'manual', 'p7c-pay-2', 20000, 'INR', 'captured', now() - interval '4 days' from finance.invoices where number = 'ZP7C-S4' and organization_id = :'ORG';
insert into finance.payments (organization_id, invoice_id, provider, provider_payment_id, amount_minor, currency, status, captured_at, verified_at, verified_by)
  select organization_id, id, 'manual', 'p7c-pay-3', 9000, 'INR', 'refunded', now() - interval '4 days', now() - interval '3 days', :'OWNER' from finance.invoices where number = 'ZP7C-S1' and organization_id = :'ORG';
insert into finance.receipts (organization_id, invoice_id, payment_id, number, amount_minor, currency)
  select p.organization_id, p.invoice_id, p.id, 'ZP7C-RCPT-1', 40000, 'INR' from finance.payments p where p.provider_payment_id = 'p7c-pay-1';
alter table finance.invoices enable trigger user;
alter table finance.payments enable trigger user;
select md5(string_agg(to_jsonb(i)::text, '|' order by i.id)) as "INV_before" from finance.invoices i where i.client_account_id in (:'AS_id', :'A2_id') \gset
select md5(string_agg(to_jsonb(p)::text, '|' order by p.id)) as "PAY_before" from finance.payments p join finance.invoices i on i.id = p.invoice_id where i.client_account_id in (:'AS_id', :'A2_id') \gset

select pg_temp.as_client(:'CL4', :'ORG', :'AS_id');
select pg_temp.check((select array_agg(number order by number) from projects.client_financial_statement()) = array['ZP7C-S1', 'ZP7C-S4', 'ZP7C-S5'], 'the client''s statement lists its issued invoices: no draft, no invoice awaiting approval, no other account''s');
select pg_temp.check((select verified_minor = 40000 and outstanding_minor = 60000 and recorded_unverified_minor = 0 and overdue and project_name = 'zztest p7c statement project' from projects.client_financial_statement() where number = 'ZP7C-S1'), 'a partly paid, past-due invoice: total, verified money, outstanding and overdue are facts');
select pg_temp.check((select verified_minor = 0 and recorded_unverified_minor = 20000 and outstanding_minor = 20000 and not overdue from projects.client_financial_statement() where number = 'ZP7C-S4'), 'money recorded but not yet verified is NOT counted as received: it stays outstanding and is shown as awaiting verification');
select pg_temp.check((select outstanding_minor = 0 and status = 'void' from projects.client_financial_statement() where number = 'ZP7C-S5'), 'a void invoice owes nothing');
select pg_temp.check((select invoiced_minor = 120000 and verified_minor = 40000 and outstanding_minor = 80000 from projects.client_financial_statement_totals() where currency = 'INR'), 'the totals: invoiced (void excluded), verified received, outstanding');
select pg_temp.check((select count(*) = 1 and bool_and(amount_minor = 40000 and receipt_number = 'ZP7C-RCPT-1' and invoice_number = 'ZP7C-S1') from projects.client_financial_statement_payments()), 'payments received are only those a person VERIFIED (an unverified claim and a refunded payment are not listed), with their receipt');
select pg_temp.check((select count(*) = 3 from projects.client_financial_statement(:'S_id')) and (select count(*) = 0 from projects.client_financial_statement(:'S2_id')), 'a project filter returns the client''s own project and nothing for another account''s project');
select pg_temp.check((select count(*) = 0 from projects.client_financial_statement_payments(:'S2_id')) and (select count(*) = 0 from projects.client_financial_statement_totals(:'S2_id')), 'the same for payments and totals');
set local role authenticated;
select pg_temp.check(pg_temp.no_write(format('update finance.invoices set total_minor = 1 where client_account_id = %L', :'AS_id')), 'the client cannot change an amount');
select pg_temp.check((select count(*) from finance.invoices where client_account_id = :'A2_id') = 0, 'and the client''s role reads no other account''s invoices directly either');
reset role;
select pg_temp.as_client(:'CL3', :'ORG', :'A2_id');
select pg_temp.check((select array_agg(number) from projects.client_financial_statement()) = array['ZP7C-T1'] and (select count(*) from projects.client_financial_statement_payments()) = 0, 'NEGATIVE: another account''s client sees only its own invoice and none of the first account''s money');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select count(*) from projects.client_financial_statement()) = 0 and (select count(*) from projects.client_financial_statement_payments()) = 0 and (select count(*) from projects.client_financial_statement_totals()) = 0, 'staff read nothing through the client''s statement (it is the client''s read)');
select set_config('request.jwt.claims', jsonb_build_object('sub', :'OWNER'::uuid, 'role', 'authenticated', 'app_metadata', jsonb_build_object('organization_id', :'ORG'::uuid, 'role', 'owner', 'client_account_id', :'AS_id'::uuid))::text, true);
select pg_temp.check((select count(*) from projects.client_financial_statement()) = 0, 'NEGATIVE: a staff token that carries a client_account_id claim is still not a client');
select pg_temp.as_user(:'OTHER', :'ORG2', 'owner');
select pg_temp.check((select count(*) from projects.client_financial_statement()) = 0, 'another organization''s staff read nothing');
select pg_temp.as_client(:'CL4', :'ORG2', :'AS_id');
select pg_temp.check((select count(*) from projects.client_financial_statement()) = 0, 'NEGATIVE: a client claim naming the right account in the WRONG organization reads nothing');
select pg_temp.as_service();
select pg_temp.check((select md5(string_agg(to_jsonb(i)::text, '|' order by i.id)) from finance.invoices i where i.client_account_id in (:'AS_id', :'A2_id')) = :'INV_before'
                     and (select md5(string_agg(to_jsonb(p)::text, '|' order by p.id)) from finance.payments p join finance.invoices i on i.id = p.invoice_id where i.client_account_id in (:'AS_id', :'A2_id')) = :'PAY_before', 'reading the statement changed no invoice and no payment');
select pg_temp.check(not has_function_privilege('anon', 'projects.client_financial_statement(uuid)', 'execute') and not has_function_privilege('public', 'projects.client_financial_statement_payments(uuid)', 'execute') and not has_function_privilege('service_role', 'projects.client_financial_statement_totals(uuid)', 'execute'), 'the statement functions are the signed-in client''s only (not anon, not public, not the service role)');

-- the archive's portal policy (Phase 7b) is honoured: stub the helper inside this transaction, then restore its live definition
create temp table p7c_orig_pa as select pg_get_functiondef('projects.p7b_portal_access(uuid)'::regprocedure) as d;
create or replace function projects.p7b_portal_access(p_project_id uuid) returns text language sql stable security definer set search_path = '' as $$ select 'read_only'::text $$;
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select outcome from projects.resolve_client_action_request(:'R3', 'The logo files are now in the shared folder')) = 'portal_read_only', 'a READ-ONLY portal takes no answer to a client action');
select pg_temp.check((select count(*) from projects.client_action_requests_for_client(:'PB_p')) >= 1, 'but still shows the requests');
select pg_temp.as_client(:'CL4', :'ORG', :'AS_id');
select pg_temp.check((select count(*) from projects.client_financial_statement(:'S_id')) = 3, 'a read-only portal still shows the statement');
create or replace function projects.p7b_portal_access(p_project_id uuid) returns text language sql stable security definer set search_path = '' as $$ select 'expired'::text $$;
select pg_temp.as_client(:'CL1', :'ORG', :'A_id');
select pg_temp.check((select count(*) from projects.client_action_requests_for_client(:'PB_p')) = 0, 'an EXPIRED portal shows no client action');
select pg_temp.as_client(:'CL4', :'ORG', :'AS_id');
select pg_temp.check((select count(*) from projects.client_financial_statement(:'S_id')) = 0 and (select count(*) from projects.client_financial_statement_payments(:'S_id')) = 0 and (select count(*) from projects.client_financial_statement_totals(:'S_id')) = 0, 'an EXPIRED portal shows no statement for its project');
select pg_temp.as_service();
select d from p7c_orig_pa \gexec
drop table p7c_orig_pa;
select pg_temp.as_client(:'CL4', :'ORG', :'AS_id');
select pg_temp.check((select count(*) from projects.client_financial_statement(:'S_id')) = 3, 'the live portal-access definition is restored');

-- ═════════ 7. structure ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select count(*) = 0 from core.unguarded_org_fks() where child in ('projects.cs_check_in_due_notices', 'projects.p7c_client_action_requests', 'projects.p7c_client_action_events')), 'every org-scoped foreign key of the new tables (client_account_id included) is tenancy-guarded');
select pg_temp.check((select count(*) = 0 from core.unfrozen_org_tables() where org_table in ('projects.cs_check_in_due_notices', 'projects.p7c_client_action_requests', 'projects.p7c_client_action_events')), 'every new table has a frozen organization_id');
reset role;
select pg_temp.check((select count(*) = 3 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and c.relkind = 'r' and c.relname in ('cs_check_in_due_notices', 'p7c_client_action_requests', 'p7c_client_action_events') and c.relrowsecurity), 'all three new tables have row level security on');
select pg_temp.check((select count(*) = 0 from information_schema.role_table_grants g where g.grantee = 'authenticated' and g.table_schema = 'projects' and g.table_name in ('cs_check_in_due_notices', 'p7c_client_action_requests', 'p7c_client_action_events') and g.privilege_type <> 'SELECT'), 'authenticated holds SELECT only on every new table');
select pg_temp.check((select count(*) = 0 from information_schema.role_table_grants g where g.grantee in ('anon', 'public') and g.table_schema = 'projects' and g.table_name in ('cs_check_in_due_notices', 'p7c_client_action_requests', 'p7c_client_action_events')), 'anon and public hold nothing on a new table');
select pg_temp.check((select count(*) = 3 from pg_policies p where p.schemaname = 'projects' and p.tablename in ('cs_check_in_due_notices', 'p7c_client_action_requests', 'p7c_client_action_events') and p.cmd = 'SELECT' and p.qual like '%is_internal%'), 'each new table has exactly its internal-only read policy (a client reads through the safe functions only)');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('sweep_phase_eight_health', 'sweep_checkins_due', 'open_support_ticket_from_message', 'sweep_message_support_tickets', 'create_draft_handover_package_for_validated', 'sweep_draft_handover_packages')
                       and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))), 'the sweeps and the automatic doors are not executable by a signed-in person, anon or public');
select pg_temp.check((select count(*) = 6 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('sweep_phase_eight_health', 'sweep_checkins_due', 'open_support_ticket_from_message', 'sweep_message_support_tickets', 'create_draft_handover_package_for_validated', 'sweep_draft_handover_packages')
                       and has_function_privilege('service_role', p.oid, 'execute')), 'and the service role can call each of them');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('create_client_action_request', 'resolve_client_action_request', 'settle_client_action_request', 'client_action_requests_for_client', 'client_financial_statement', 'client_financial_statement_payments', 'client_financial_statement_totals')
                       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))), 'no client-action or statement door is executable by anon, public or the service role');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects'
                       and p.proname in ('sweep_phase_eight_health', 'sweep_checkins_due', 'open_support_ticket_from_message', 'sweep_message_support_tickets', 'create_draft_handover_package_for_validated', 'sweep_draft_handover_packages',
                                         'create_client_action_request', 'resolve_client_action_request', 'settle_client_action_request', 'client_action_requests_for_client', 'client_financial_statement', 'client_financial_statement_payments',
                                         'client_financial_statement_totals', 'p7_failure_queue', 'p7c_statement_account')
                       and (not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false))), 'every new door is SECURITY DEFINER with search_path pinned to empty');
select pg_temp.check((select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'projects' and p.proname = 'p7c_statement_account' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))), 'the statement helper stays unreachable except inside the statement functions');
select pg_temp.check((select count(*) = 0 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'finance' and t.tgname like 'p7c%' and not t.tgisinternal), 'nothing of this slice adds a trigger to a finance table: the statement can change nothing');

rollback;
\echo Phase 7c and the Phase 8A completions (scheduled sweeps, support ticket from a client message, client action requests, the failure queue, the automatic draft handover and the client statement): every gate, door and record verified - OK
