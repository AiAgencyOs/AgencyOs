-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 follow-up: the nine remaining development specialists PROPOSE through one service-only door, driven for real on a scratch Postgres.
-- (No model runs here: the workflow's model call is stood in for by the arguments it would pass to the door. This proves what the DATABASE
-- refuses, not what any model would write.)
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase5-specialists.sql          (rolls back)
-- Any failed check raises.
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
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;

-- true when the statement raises one of the named SQLSTATEs (comma separated); false when it runs, or raises anything else
create or replace function pg_temp.raises(p_sql text, p_states text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlstate = any (string_to_array(p_states, ','));
end $$;
grant execute on function pg_temp.raises(text, text) to public;

-- one call of the door, as the runner makes it (service role); the job's organization is an argument, never the caller's claim
create or replace function pg_temp.propose(p_task uuid, p_agent text, p_handoff uuid, p_outcome text, p_files text[], p_tests text[], p_ev text[],
  p_detail jsonb default '{}'::jsonb, p_summary text default 'Plan the change in small steps.', p_risks text[] default '{}', p_org uuid default '00000000-0000-4000-8000-000000000001')
returns text language plpgsql as $$
declare v text;
begin
  select r.outcome into v from projects.record_specialist_proposal(p_org, p_task, p_agent, p_handoff, p_outcome, p_summary, p_files, p_tests, p_risks, p_ev, p_detail) r;
  return v;
end $$;
grant execute on function pg_temp.propose(uuid, text, uuid, text, text[], text[], text[], jsonb, text, text[], uuid) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b6'
\set U '00000000-0000-4000-8000-00000000f6a1'
\set UC '00000000-0000-4000-8000-00000000f6a2'
\set UB '00000000-0000-4000-8000-00000000f6a3'

insert into auth.users (id, email) values (:'U', 'p5spec-owner@example.test'), (:'UC', 'p5spec-client@example.test'), (:'UB', 'p5spec-b@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'U', 'p5spec-owner@example.test', 'Spec Owner'), (:'UC', 'p5spec-client@example.test', 'Spec Client'),
  (:'UB', 'p5spec-b@example.test', 'Spec B') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORGB', 'Spec Other Agency', 'spec-other-agency') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'U', 'owner'), (:'ORGB', :'UB', 'owner') on conflict do nothing;

-- ── fixtures (service role): one routed task per specialist, each with the envelope's required evidence on its handoff ─────────────────────────
set local role service_role;
select pg_temp.as_service();
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest spec client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest spec', 'ZSPEC-1') returning id \gset P_
insert into core.client_accounts (organization_id, name) values (:'ORGB', 'zztest spec client b') returning id \gset AB_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORGB', :'AB_id', 'zztest spec b', 'ZSPEC-B') returning id \gset PB_

insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest frontend', 'todo', 'frontend_developer', '{src/ui,app/cart/page.tsx,supabase/migrations}') returning id \gset TF_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest backend', 'todo', 'backend_developer', '{src/api}') returning id \gset TB_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest database', 'todo', 'database_developer', '{supabase/migrations,src/db/**}') returning id \gset TD_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest mobile', 'todo', 'mobile_developer', '{mobile/lib}') returning id \gset TM_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest integration', 'todo', 'integration', '{src/integrations}') returning id \gset TI_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest devops', 'todo', 'devops_build', '{scripts/build}') returning id \gset TV_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest security', 'todo', 'security_review', '{src/auth}') returning id \gset TS_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest bug', 'todo', 'bug_fix', '{src/cart}') returning id \gset TX_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest bug other', 'todo', 'bug_fix', '{src/cart}') returning id \gset TY_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest refactor', 'todo', 'refactor_performance', '{src/perf}') returning id \gset TR_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest held backend (never routed)', 'todo', 'backend_developer', '{src/api}') returning id \gset TH_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORG', :'P_id', 'zztest no paths', 'todo', 'backend_developer', '{}') returning id \gset TN_
insert into projects.tasks (organization_id, project_id, title, status, required_capability, affected_paths) values (:'ORGB', :'PB_id', 'zztest other org frontend', 'todo', 'frontend_developer', '{src/ui}') returning id \gset TO_

insert into qa.defects (organization_id, project_id, severity, title, reproduction, task_id) values (:'ORG', :'P_id', 'major', 'zztest cart total wrong', 'add two items', :'TX_id') returning id \gset DX_
insert into qa.defects (organization_id, project_id, severity, title, reproduction, task_id) values (:'ORG', :'P_id', 'minor', 'zztest unrelated defect', 'open the page', :'TY_id') returning id \gset DY_

-- the shape of the handoff the Orchestrator writes: the envelope's requiredEvidence is what the door reads
create or replace function pg_temp.handoff(p_org uuid, p_project uuid, p_task uuid, p_agent text, p_evidence text) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, project_id, task_id, subject_type, subject_id, objective, context)
  values (p_org, gen_random_uuid(), 'orchestrator', p_agent, p_project, p_task, 'development_task', p_task, 'Development task', jsonb_build_object('envelope', jsonb_build_object('requiredEvidence', p_evidence::jsonb)))
  returning id into v;
  return v;
end $$;
grant execute on function pg_temp.handoff(uuid, uuid, uuid, text, text) to public;
select pg_temp.handoff(:'ORG', :'P_id', :'TF_id', 'frontend_developer', '["typecheck","lint","tests","build"]') as id \gset HF_
select pg_temp.handoff(:'ORG', :'P_id', :'TB_id', 'backend_developer', '["typecheck","lint","tests","build"]') as id \gset HB_
select pg_temp.handoff(:'ORG', :'P_id', :'TD_id', 'database_developer', '["tests","live","record"]') as id \gset HD_
select pg_temp.handoff(:'ORG', :'P_id', :'TM_id', 'mobile_developer', '["tests","build"]') as id \gset HM_
select pg_temp.handoff(:'ORG', :'P_id', :'TI_id', 'integration', '["tests","live"]') as id \gset HI_
select pg_temp.handoff(:'ORG', :'P_id', :'TV_id', 'devops_build', '["build"]') as id \gset HV_
select pg_temp.handoff(:'ORG', :'P_id', :'TS_id', 'security_review', '["record"]') as id \gset HS_
select pg_temp.handoff(:'ORG', :'P_id', :'TX_id', 'bug_fix', '["tests","build"]') as id \gset HX_
select pg_temp.handoff(:'ORG', :'P_id', :'TY_id', 'bug_fix', '["tests","build"]') as id \gset HY_
select pg_temp.handoff(:'ORG', :'P_id', :'TR_id', 'refactor_performance', '["tests","build"]') as id \gset HR_
select pg_temp.handoff(:'ORG', :'P_id', :'TN_id', 'backend_developer', '["typecheck","lint","tests","build"]') as id \gset HN_
select pg_temp.handoff(:'ORGB', :'PB_id', :'TO_id', 'frontend_developer', '["typecheck","lint","tests","build"]') as id \gset HO_
select pg_temp.handoff(:'ORG', :'P_id', :'TB_id', 'frontend_developer', '["typecheck","lint","tests","build"]') as id \gset HW_
reset role;

\set EVFE '{typecheck,lint,tests,build}'
\set EVTB '{tests,build}'

-- ── 1. a valid proposal is recorded, as a proposal, once ─────────────────────────────────────────────────────────────────────────────────────
set local role service_role;
select pg_temp.as_service();
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/button.tsx,app/cart/page.tsx}', '{tests/button.test.ts}', :'EVFE') as o1 \gset
select pg_temp.check(:'o1' = 'recorded', 'a frontend proposal inside the task''s affected paths, planning the required evidence, is recorded');
select pg_temp.check((select count(*) from projects.specialist_proposals where task_id = :'TF_id') = 1 and (select status from projects.specialist_proposals where task_id = :'TF_id') = 'proposed', 'it is stored as a proposal with status proposed');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/button.tsx,app/cart/page.tsx}', '{tests/button.test.ts}', :'EVFE') as o1b \gset
select pg_temp.check(:'o1b' = 'already_proposed', 'the same proposal again is not stored twice');
select pg_temp.check((select count(*) from projects.specialist_proposals where task_id = :'TF_id') = 1, 'still one row');

-- ── 2. whose task, whose agent, routed or not ────────────────────────────────────────────────────────────────────────────────────────────────
select pg_temp.propose(:'TO_id', 'frontend_developer', :'HO_id', 'proposal', '{src/ui/a.tsx}', '{}', :'EVFE') as o2 \gset
select pg_temp.check(:'o2' = 'not_found', 'a task of another organization is not found for the job''s organization');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/a.tsx}', '{}', :'EVFE', '{}', 'x', '{}', :'ORGB') as o2b \gset
select pg_temp.check(:'o2b' = 'not_found', 'the job''s organization is what scopes the task: this task is not in organization B');
select pg_temp.propose(:'TF_id', 'backend_developer', :'HB_id', 'proposal', '{src/ui/a.tsx}', '{}', :'EVFE') as o3 \gset
select pg_temp.check(:'o3' = 'wrong_agent', 'an agent that is not the task''s required capability is refused');
select pg_temp.propose(:'TH_id', 'backend_developer', :'HB_id', 'proposal', '{src/api/a.ts}', '{}', :'EVFE') as o4 \gset
select pg_temp.check(:'o4' = 'not_routed', 'a task with no handoff to this agent (held, never routed) is refused, even citing another task''s handoff');
select pg_temp.propose(:'TB_id', 'backend_developer', :'HW_id', 'proposal', '{src/api/a.ts}', '{}', :'EVFE') as o4a \gset
select pg_temp.check(:'o4a' = 'not_routed', 'a handoff to a different agent for the same task does not route this one');
select pg_temp.propose(:'TF_id', 'integration', :'HI_id', 'proposal', '{src/ui/a.tsx}', '{}', '{tests,live}') as o4b \gset
select pg_temp.check(:'o4b' = 'wrong_agent', 'a specialist the task was not planned for is refused');
select pg_temp.propose(:'TF_id', 'documentation', :'HF_id', 'proposal', '{src/ui/a.tsx}', '{}', :'EVFE') as o4c \gset
select pg_temp.check(:'o4c' = 'not_a_specialist', 'documentation and test automation have their own doors: this one is the nine others only');

-- ── 3. the planned files ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/api/pay.ts}', '{}', :'EVFE') as o5 \gset
select pg_temp.check(:'o5' = 'outside_affected_paths', 'a planned file outside affected_paths is refused');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/a.tsx,src/api/pay.ts}', '{}', :'EVFE') as o5b \gset
select pg_temp.check(:'o5b' = 'outside_affected_paths', 'one file outside among several refuses the whole proposal');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/../api/pay.ts}', '{}', :'EVFE') as o5c \gset
select pg_temp.check(:'o5c' = 'outside_affected_paths', 'a parent-directory segment cannot walk out of the affected path');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/uikit/x.tsx}', '{}', :'EVFE') as o5d \gset
select pg_temp.check(:'o5d' = 'outside_affected_paths', 'src/uikit is not inside src/ui (a prefix is not a parent)');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{/etc/passwd}', '{}', :'EVFE') as o5e \gset
select pg_temp.check(:'o5e' = 'outside_affected_paths', 'an absolute path is never inside');
select pg_temp.propose(:'TN_id', 'backend_developer', :'HN_id', 'proposal', '{src/api/a.ts}', '{}', '{typecheck,lint,tests,build}') as o5f \gset
select pg_temp.check(:'o5f' = 'outside_affected_paths', 'a task that names no affected path permits no file');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/.env.local}', '{}', :'EVFE') as o6 \gset
select pg_temp.check(:'o6' = 'forbidden_path', 'a .env file is refused even inside an affected path');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/secrets/keys.ts}', '{}', :'EVFE') as o6b \gset
select pg_temp.check(:'o6b' = 'forbidden_path', 'a secrets directory is refused even inside an affected path');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{supabase/migrations/20261103999999_x.sql}', '{}', :'EVFE') as o6c \gset
select pg_temp.check(:'o6c' = 'forbidden_path', 'a migration is refused for a frontend developer even when the task''s paths include migrations');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{}', '{}', :'EVFE') as o6d \gset
select pg_temp.check(:'o6d' = 'empty_plan', 'a proposal that plans no file is not a plan');

-- ── 4. forbidden actions in the text ─────────────────────────────────────────────────────────────────────────────────────────────────────────
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/a.tsx}', '{}', :'EVFE', '{}', 'Build it, then deploy to production.') as o7 \gset
select pg_temp.check(:'o7' = 'forbidden_action', 'planning a production deploy is refused');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/a.tsx}', '{}', :'EVFE', '{}', 'Then merge the branch into main.') as o7b \gset
select pg_temp.check(:'o7b' = 'forbidden_action', 'planning a merge to a protected branch is refused');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/a.tsx}', '{}', :'EVFE', '{}', 'The agent approves its own work afterwards.') as o7c \gset
select pg_temp.check(:'o7c' = 'forbidden_action', 'approving its own work is refused');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/a.tsx}', '{}', :'EVFE', '{}', 'Also widen the scope to include a wishlist.') as o7d \gset
select pg_temp.check(:'o7d' = 'forbidden_action', 'widening the scope is refused');
select pg_temp.propose(:'TB_id', 'backend_developer', :'HB_id', 'proposal', '{src/api/a.ts}', '{}', :'EVFE', '{}', 'Verify the payment as received.') as o7e \gset
select pg_temp.check(:'o7e' = 'forbidden_action', 'verifying a payment is refused');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/a.tsx}', '{}', :'EVFE', '{}', 'Wire it up.', array['uses ' || 'api_key=' || repeat('x', 20)]) as o7f \gset
select pg_temp.check(:'o7f' = 'forbidden_action', 'a secret value in the text is refused');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/a.tsx}', '{tests/a.test.ts}', :'EVFE', '{}', 'Add a button; the release notes stay unchanged.') as o7g \gset
select pg_temp.check(:'o7g' = 'recorded', 'ordinary words that merely resemble a forbidden action are not refused');

-- ── 5. the evidence plan comes from the envelope on the handoff ──────────────────────────────────────────────────────────────────────────────
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/b.tsx}', '{}', '{typecheck,lint,tests}') as o8 \gset
select pg_temp.check(:'o8' = 'missing_evidence', 'a proposal that does not plan a required evidence kind (build) is refused');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/b.tsx}', '{}', '{}') as o8b \gset
select pg_temp.check(:'o8b' = 'missing_evidence', 'a proposal that plans no evidence is refused');

-- ── 6. per-agent rules ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
select pg_temp.propose(:'TD_id', 'database_developer', :'HD_id', 'proposal', '{supabase/migrations/20261103800000_cart.sql,src/db/schema.ts}', '{tests/cart-rls.test.ts}', '{tests,live,record}', '{"migrations":["supabase/migrations/20261103800000_cart.sql"]}') as o9 \gset
select pg_temp.check(:'o9' = 'recorded', 'a database developer may plan a migration');
select pg_temp.propose(:'TD_id', 'database_developer', :'HD_id', 'proposal', '{src/db/schema.ts}', '{}', '{tests,live,record}', '{"migrations":["supabase/migrations/20261103800001_other.sql"]}') as o9b \gset
select pg_temp.check(:'o9b' = 'bad_input', 'a migration named in the detail but not in the planned files is refused');
select pg_temp.propose(:'TD_id', 'database_developer', :'HD_id', 'proposal', '{supabase/migrations/.env}', '{}', '{tests,live,record}') as o9c \gset
select pg_temp.check(:'o9c' = 'forbidden_path', 'even the database developer cannot plan a .env file');
select pg_temp.propose(:'TX_id', 'bug_fix', :'HX_id', 'proposal', '{src/cart/total.ts}', '{tests/total.test.ts}', :'EVTB', '{}') as o10 \gset
select pg_temp.check(:'o10' = 'defect_required', 'a bug fix that cites no defect is refused');
select pg_temp.propose(:'TX_id', 'bug_fix', :'HX_id', 'proposal', '{src/cart/total.ts}', '{tests/total.test.ts}', :'EVTB', jsonb_build_object('defectId', :'DY_id')) as o10b \gset
select pg_temp.check(:'o10b' = 'defect_required', 'a bug fix citing a defect linked to a different task is refused');
select pg_temp.propose(:'TX_id', 'bug_fix', :'HX_id', 'proposal', '{src/cart/total.ts}', '{tests/total.test.ts}', :'EVTB', jsonb_build_object('defectId', gen_random_uuid())) as o10c \gset
select pg_temp.check(:'o10c' = 'defect_required', 'a bug fix citing a defect that does not exist is refused');
select pg_temp.propose(:'TX_id', 'bug_fix', :'HX_id', 'proposal', '{src/cart/total.ts}', '{tests/total.test.ts}', :'EVTB', jsonb_build_object('defectId', :'DX_id', 'rootCause', 'rounding before summing')) as o10d \gset
select pg_temp.check(:'o10d' = 'recorded', 'a bug fix citing its own task''s defect is recorded');
select pg_temp.propose(:'TS_id', 'security_review', :'HS_id', 'proposal', '{src/auth/session.ts}', '{}', '{record}', '{"findings":[{"severity":"high","path":"src/auth/session.ts","description":"cookie not httpOnly"}]}') as o11 \gset
select pg_temp.check(:'o11' = 'review_must_not_edit', 'a security review that plans an edit is refused');
select pg_temp.propose(:'TS_id', 'security_review', :'HS_id', 'proposal', '{}', '{}', '{record}', '{"findings":[{"severity":"catastrophic","path":"x","description":"y"}]}') as o11b \gset
select pg_temp.check(:'o11b' = 'bad_input', 'a finding with a severity outside the classes is refused');
select pg_temp.propose(:'TS_id', 'security_review', :'HS_id', 'proposal', '{}', '{}', '{record}', '{}') as o11c \gset
select pg_temp.check(:'o11c' = 'bad_input', 'a security review with no findings array is refused');
select pg_temp.propose(:'TS_id', 'security_review', :'HS_id', 'proposal', '{}', '{}', '{record}', '{"findings":[{"severity":"high","path":"src/auth/session.ts","description":"cookie not httpOnly"}]}') as o11d \gset
select pg_temp.check(:'o11d' = 'recorded', 'a security review proposes findings with a severity class and no edits');
select pg_temp.propose(:'TM_id', 'mobile_developer', :'HM_id', 'not_required', '{}', '{}', '{}', '{}', 'The project has no mobile target: web only.') as o12 \gset
select pg_temp.check(:'o12' = 'recorded', 'a mobile developer may honestly record NOT_REQUIRED, with no plan');
select pg_temp.propose(:'TM_id', 'mobile_developer', :'HM_id', 'not_required', '{mobile/lib/a.dart}', '{}', '{}', '{}', 'No mobile target, but here are files.') as o12b \gset
select pg_temp.check(:'o12b' = 'not_required_has_a_plan', 'NOT_REQUIRED with a plan attached is refused');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'not_required', '{}', '{}', '{}', '{}', 'Nothing to do.') as o12c \gset
select pg_temp.check(:'o12c' = 'not_required_not_allowed', 'a frontend developer cannot decide its own task is not required');
select pg_temp.propose(:'TF_id', 'frontend_developer', :'HF_id', 'proposal', '{src/ui/c.tsx}', '{}', :'EVFE', '{"extra":1}') as o13 \gset
select pg_temp.check(:'o13' = 'detail_not_allowed', 'a detail key the agent has no business with is refused');
select pg_temp.propose(:'TV_id', 'devops_build', :'HV_id', 'proposal', '{scripts/build/run.sh}', '{}', '{build}') as o14 \gset
select pg_temp.check(:'o14' = 'recorded', 'a devops/build proposal is recorded');
select pg_temp.propose(:'TV_id', 'devops_build', :'HV_id', 'proposal', '{scripts/build/run.sh}', '{}', '{build}', '{}', 'Build, then push the artifact to production.') as o14b \gset
select pg_temp.check(:'o14b' = 'forbidden_action', 'devops/build never plans a deploy');
select pg_temp.propose(:'TI_id', 'integration', :'HI_id', 'proposal', '{src/integrations/maps.ts}', '{tests/maps.test.ts}', '{tests,live}') as o15 \gset
select pg_temp.check(:'o15' = 'recorded', 'an integration proposal is recorded');
select pg_temp.propose(:'TR_id', 'refactor_performance', :'HR_id', 'proposal', '{src/perf/index.ts}', '{tests/perf.test.ts}', :'EVTB', '{"measurement":{"metric":"p95 ms","baseline":"420","target":"300"}}') as o16 \gset
select pg_temp.check(:'o16' = 'recorded', 'a refactor/performance proposal with a measurement is recorded');
select pg_temp.propose(:'TB_id', 'backend_developer', :'HB_id', 'proposal', '{src/api/pay.ts}', '{tests/pay.test.ts}', :'EVFE') as o17 \gset
select pg_temp.check(:'o17' = 'recorded', 'a backend proposal is recorded');
reset role;

-- ── 7. append-only, and nothing but this door writes ─────────────────────────────────────────────────────────────────────────────────────────
select pg_temp.check(pg_temp.raises('update projects.specialist_proposals set plan_summary = ''rewritten''', '23001'), 'a proposal is never edited (even by the owner role)');
select pg_temp.check(pg_temp.raises('delete from projects.specialist_proposals', '23001'), 'a proposal is never deleted directly');
select pg_temp.check(pg_temp.raises(format('update projects.specialist_proposals set status = ''approved'' where task_id = %L', :'TF_id'), '23001,23514'), 'a proposal cannot become approved');
select pg_temp.check(pg_temp.raises(format($q$insert into projects.specialist_proposals (organization_id, project_id, task_id, handoff_id, agent_key, plan_summary, status, content_hash)
  values (%L, %L, %L, %L, 'frontend_developer', 'x', 'approved', 'h')$q$, :'ORG', :'P_id', :'TF_id', :'HF_id'), '23514'), 'the status check admits only proposed');
select pg_temp.check(pg_temp.raises(format($q$insert into projects.specialist_proposals (organization_id, project_id, task_id, handoff_id, agent_key, plan_summary, content_hash)
  values (%L, %L, %L, %L, 'frontend_developer', 'x', 'h2')$q$, :'ORGB', :'P_id', :'TF_id', :'HF_id'), '23514,42501,23000,P0001'), 'a row for the wrong organization is refused by the tenancy guard');
select pg_temp.check((select count(*) from projects.specialist_proposals where outcome = 'proposal' and agent_key = 'frontend_developer') = 2, 'the refused attempts left nothing behind (two valid frontend proposals only)');
select pg_temp.check((select count(*) from qa.test_runs where project_id = :'P_id') = 0, 'a proposal is never a test run or a result');

-- the door itself: not for an authenticated person, not for anon, and a non-service claim is refused inside the function
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.raises(format($q$select * from projects.record_specialist_proposal(%L, %L, 'frontend_developer', %L, 'proposal', 's', '{src/ui/z.tsx}', '{}', '{}', '{typecheck,lint,tests,build}')$q$, :'ORG', :'TF_id', :'HF_id'), '42501'), 'an authenticated person cannot call the door (permission denied)');
select pg_temp.check(pg_temp.raises(format($q$insert into projects.specialist_proposals (organization_id, project_id, task_id, handoff_id, agent_key, plan_summary, content_hash) values (%L, %L, %L, %L, 'frontend_developer', 'x', 'h3')$q$, :'ORG', :'P_id', :'TF_id', :'HF_id'), '42501'), 'an authenticated person cannot insert a proposal directly');
select pg_temp.check((select count(*) from projects.specialist_proposals where task_id = :'TF_id') >= 1, 'an internal user of the organization reads its proposals');
select pg_temp.check((select count(*) from projects.specialist_proposals where task_id = :'TO_id') = 0, 'and none of another organization''s');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.specialist_proposals) = 0, 'organization B sees none of organization A''s proposals');
reset role;
select pg_temp.as_user(:'UC', :'ORG', 'client');
set local role authenticated;
select pg_temp.check((select count(*) from projects.specialist_proposals) = 0, 'a client sees no proposal: they are internal');
reset role;
select pg_temp.as_user(:'U', :'ORG', 'owner');
select pg_temp.check((select o from (select outcome as o from projects.record_specialist_proposal(:'ORG', :'TF_id', 'frontend_developer', :'HF_id', 'proposal', 's', '{src/ui/z.tsx}', '{}', '{}', '{typecheck,lint,tests,build}')) q) = 'not_authorized', 'a caller whose claim is not service_role is told not_authorized by the function itself');

-- a deleted task takes its proposals with it (the parent cascade is allowed; a direct delete is not)
select pg_temp.as_service();
set local role service_role;
delete from projects.tasks where id = :'TI_id';
reset role;
select pg_temp.check((select count(*) from projects.specialist_proposals where task_id = :'TI_id') = 0, 'a parent cascade is the only way a proposal goes');

\echo phase 5 specialists: OK
rollback;
