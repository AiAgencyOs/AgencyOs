-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 prototype QA as a recorded run of named checks (migration 20261126000000).
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p4q-prototype-qa.sql
--
-- Every control is driven through the real doors on a real Postgres, then RED-PROVED: the live function definition is mutated, the probe must now fail, and a mutation
-- that changes nothing raises (a red-proof that silently did not run proves nothing). Scoped to one project; rolls back.
-- ═══════════════════════════════════════════════════════════════════════════
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
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.as_nobody() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '', true); end $$;
grant execute on function pg_temp.as_nobody() to public;

-- fixtures by name, so a probe can find them inside a mutated, rolled-back block
create temp table fx (k text primary key, v text);
grant all on fx to public;
create or replace function pg_temp.k() returns text language sql immutable as $$ select 'sk-' || 'ant-api03-' || 'abcdefghijklmnopqrstuvwxyz' || '0123456789' $$;
grant execute on function pg_temp.k() to public;
create or replace function pg_temp.fx(p text) returns uuid language sql stable as $$ select v::uuid from fx where k = p $$;
grant execute on function pg_temp.fx(text) to public;

-- RED-PROOF: mutate the LIVE definition, run the probe (it must now be false or raise), restore by rolling the block back. A no-op mutation raises.
create or replace function pg_temp.red(p_what text, p_fn text, p_from text, p_to text, p_probe text) returns void language plpgsql as $$
declare d text; m text; held boolean := false; ok boolean;
begin
  d := pg_get_functiondef(p_fn::regprocedure);
  m := replace(d, p_from, p_to);
  if m = d then raise exception 'RED-PROOF DID NOT RUN (the mutation changed nothing): %', p_what; end if;
  begin
    execute m;
    begin execute p_probe into ok; exception when others then ok := false; end;
    held := coalesce(ok, false);
    raise exception 'restore';
  exception when others then
    if sqlerrm <> 'restore' then raise; end if;
  end;
  if held then raise exception 'RED-PROOF FAILED: the control still holds with % mutated (%)', p_fn, p_what; end if;
  raise notice 'red %', p_what;
end $$;
grant execute on function pg_temp.red(text, text, text, text, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000000b4'
\set OWNER '00000000-0000-4000-8000-00000000f611'
\set OWNER2 '00000000-0000-4000-8000-00000000f612'
\set BUILDER '00000000-0000-4000-8000-00000000f613'
\set BUILDER2 '00000000-0000-4000-8000-00000000f614'
\set REVIEWER '00000000-0000-4000-8000-00000000f615'

insert into auth.users (id, email) values (:'OWNER', 'p4q-owner@example.test'), (:'OWNER2', 'p4q-owner2@example.test'), (:'BUILDER', 'p4q-builder@example.test'),
  (:'BUILDER2', 'p4q-builder2@example.test'), (:'REVIEWER', 'p4q-reviewer@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4q-owner@example.test', 'P4Q Owner'), (:'OWNER2', 'p4q-owner2@example.test', 'P4Q Owner Two'),
  (:'BUILDER', 'p4q-builder@example.test', 'P4Q Builder'), (:'BUILDER2', 'p4q-builder2@example.test', 'P4Q Builder Two'), (:'REVIEWER', 'p4q-reviewer@example.test', 'P4Q Reviewer') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'BUILDER', 'member'), (:'ORG', :'BUILDER2', 'member'), (:'ORG', :'REVIEWER', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p4q other org', 'zztest-p4q-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4q client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4q', 'ZP4Q-1') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4q other project', 'ZP4Q-2') returning id \gset P2_
insert into fx values ('P', :'P_id');

set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, payload, phase_four_ready, readiness_note)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', false, 'fixture') returning id \gset H_
insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id, state) values (:'ORG', :'P_id', :'H_id', 'prototype_build') returning id \gset F_
-- the locked UI: three screens, home designs an empty and an error state
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P_id', :'F_id', :'H_id', 1, 'locked', now(), '[
    {"screenKey":"home","layoutSummary":"x","keyComponents":["a"],"statesAddressed":["default","empty","error"]},
    {"screenKey":"list","layoutSummary":"x","keyComponents":["a"],"statesAddressed":["default"]},
    {"screenKey":"detail","layoutSummary":"x","keyComponents":["a"],"statesAddressed":["default"]}]') returning id \gset V_
-- a second UI version that is NOT locked (an artifact on it is an invalid intake)
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P_id', :'F_id', :'H_id', 2, 'qa_pass', now(), '[{"screenKey":"home","statesAddressed":["default"]}]') returning id \gset VU_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 1, 'zztest build 1') returning id \gset D1_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 2, 'zztest build 2') returning id \gset D2_
set local session_replication_role = origin;

-- build 1: flawed on purpose
select pg_temp.as_user(:'BUILDER', :'ORG', 'member');
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, platform, screens) values (:'ORG', :'P_id', :'V_id', :'D1_id', 'web', '[
  {"screenKey":"home","elements":[{"type":"heading","label":"Welcome"},{"type":"input","label":"Email"},{"type":"button","label":"Open list","navigatesTo":"list"}]},
  {"screenKey":"list","elements":[{"type":"text","label":"Your items; contact jo@acme-real.com"},{"type":"button","label":"Save"},{"type":"link","label":"Help","navigatesTo":"ghost"},{"type":"link","label":"Back","navigatesTo":"home"}]},
  {"screenKey":"orphan","elements":[{"type":"text","label":"Nobody links here"}]}]') returning id \gset PA1_
update projects.prototype_artifacts set created_at = now() - interval '2 days' where id = :'PA1_id';
insert into fx values ('PA1', :'PA1_id'), ('D1', :'D1_id'), ('V', :'V_id'), ('VU', :'VU_id');
select pg_temp.as_nobody();

-- ═══ the door: who may call it ═════════════════════════════════════════════
select pg_temp.check((select outcome from projects.p4q_run_prototype_qa(:'PA1_id')) = 'no_actor', 'no caller: no_actor');
select pg_temp.as_user(:'BUILDER', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p4q_run_prototype_qa(:'PA1_id')) = 'self_review', 'the person who built the prototype cannot run its QA (ADM-82)');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check((select outcome from projects.p4q_run_prototype_qa(:'PA1_id')) = 'forbidden', 'another organisation cannot run this build''s QA');
select pg_temp.check((select count(*) from projects.p4q_prototype_qa_runs where artifact_id = :'PA1_id') = 0, 'a refused call left no run behind');

-- ═══ intake and limitation (before QA) ═════════════════════════════════════
select pg_temp.as_user(:'BUILDER', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p4q_declare_prototype_intake(:'PA1_id', array['home'], array['watch'])) = 'bad_viewport', 'an unknown viewport is refused');
select pg_temp.check((select outcome from projects.p4q_declare_prototype_intake(:'PA1_id', array['nowhere'], array['mobile'])) = 'unknown_critical_screen', 'a critical screen the UI never designed is refused');
select pg_temp.check((select outcome from projects.p4q_declare_prototype_intake(:'PA1_id', array['home'], array['mobile'], 'mock data uses example.test addresses')) = 'declared', 'the intake is declared');
select pg_temp.check((select outcome from projects.p4q_declare_prototype_limitation(:'PA1_id', 'The detail view is not built yet', 'detail')) = 'declared', 'a limitation naming a required screen is recorded');
select pg_temp.check((select outcome from projects.p4q_declare_prototype_limitation(:'PA1_id', 'The detail view is not built yet', 'detail')) = 'already_declared', 'a repeated limitation is the same limitation');
select pg_temp.check((select outcome from projects.p4q_declare_prototype_limitation(:'PA1_id', 'my key is ' || pg_temp.k() || '', null)) = 'contains_secret', 'a limitation carrying a credential is refused');

-- ═══ the run on the flawed build 1 ═════════════════════════════════════════
select pg_temp.as_service();
select r.run_id, r.verdict from projects.p4q_run_prototype_qa(:'PA1_id') r \gset R1_
insert into fx values ('R1', :'R1_run_id');
select pg_temp.check(:'R1_verdict' = 'qa_changes_required', 'a flawed build gets qa_changes_required');
select pg_temp.check((select status from projects.prototype_artifacts where id = :'PA1_id') = 'qa_changes_required', 'the existing artifact status moved through record_prototype_qa_verdict');
select pg_temp.check((select qa_findings ->> 'runId' from projects.prototype_artifacts where id = :'PA1_id') = :'R1_run_id', 'the findings name the run');
select pg_temp.check((select qa_findings -> 'missingScreens' from projects.prototype_artifacts where id = :'PA1_id') ? 'detail', 'the legacy findings keep missingScreens');
create or replace function pg_temp.chk(p_run uuid, p_key text) returns text language sql stable as $$ select result || '/' || severity from projects.p4q_prototype_qa_checks where run_id = p_run and check_key = p_key $$;
grant execute on function pg_temp.chk(uuid, text) to public;
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'coverage:screen:home') = 'pass/P0', 'a built critical screen passes');
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'coverage:screen:detail') = 'fail/P1', 'a missing NON-critical screen is P1 (home was the declared critical one)');
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'coverage:extra:orphan') = 'fail/P1', 'a screen the UI never designed is a defect');
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'navigation:route:list->ghost') = 'fail/P1', 'a broken route is P1');
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'navigation:unreachable:orphan') = 'fail/P2', 'a screen no route reaches is flagged');
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'interaction:decorative:list:1') = 'fail/P2', 'a button with no target is decorative');
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'states:home:empty') = 'fail/P2' and pg_temp.chk(:'R1_run_id', 'states:home:error') = 'fail/P2', 'designed states the build does not show are flagged');
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'data:real_contact') = 'fail/P2', 'a real-looking email is flagged (mock data must use reserved addresses)');
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'data:secrets') = 'pass/P0' and pg_temp.chk(:'R1_run_id', 'data:cross_project') = 'pass/P0', 'no secret and no other project''s id in this build');
select pg_temp.check(pg_temp.chk(:'R1_run_id', 'layout:render') = 'not_verifiable/P3' and pg_temp.chk(:'R1_run_id', 'visual:fidelity') = 'not_verifiable/P3' and pg_temp.chk(:'R1_run_id', 'role:behaviour') = 'not_verifiable/P3',
  'what the structured build cannot answer is recorded not_verifiable, never a pass');
select pg_temp.check((select count(*) from projects.p4q_prototype_qa_checks c where c.run_id = :'R1_run_id' and c.result = 'fail' and c.disposition is null) = 0, 'every failure carries a disposition');
select pg_temp.check((select disposition from projects.p4q_prototype_qa_checks where run_id = :'R1_run_id' and check_key = 'coverage:extra:orphan') = 'must_fix'
  and (select disposition from projects.p4q_prototype_qa_checks where run_id = :'R1_run_id' and check_key = 'data:real_contact') = 'admin_decides', 'P1 must be fixed, P2 is the Admin''s call');
select pg_temp.check((select qa_accuracy from projects.p4q_prototype_limitations where artifact_id = :'PA1_id') = 'hides_required_screen', 'a limitation that names a missing required screen is judged: it hides it');
select pg_temp.check((select count(*) from projects.p4q_prototype_defects where artifact_id = :'PA1_id') = (select count(*) from qa.defects d join projects.p4q_prototype_defects pd on pd.defect_id = d.id where pd.artifact_id = :'PA1_id'), 'every failure became a qa.defects row with a prototype record');
select pg_temp.check((select count(*) from qa.blocking_defects(:'D1_id')) >= 3, 'qa.blocking_defects now blocks the build (the existing submit gate sees them)');
select pg_temp.check((select source_ui_version_id from projects.p4q_prototype_defects where check_key = 'navigation:route:list->ghost' and artifact_id = :'PA1_id') = :'V_id', 'a defect carries the source UI version it was found against');
select r.run_id as again from projects.p4q_run_prototype_qa(:'PA1_id') r \gset RR_
select pg_temp.check((select outcome from projects.p4q_run_prototype_qa(:'PA1_id')) = 'already_reviewed' and :'RR_again' = :'R1_run_id', 'a replay returns the same run and writes nothing');
select pg_temp.check((select count(*) from projects.p4q_prototype_qa_runs where artifact_id = :'PA1_id') = 1, 'one verdict run per build');
select pg_temp.check((select outcome from projects.p4q_declare_prototype_intake(:'PA1_id')) = 'already_reviewed', 'the intake cannot be rewritten after QA ran');

-- the admin cannot approve a build QA has not passed
select pg_temp.as_service();
insert into projects.deliverable_details (deliverable_id, organization_id, project_id) values (:'D1_id', :'ORG', :'P_id');
create or replace function pg_temp.approve(p_d uuid) returns text language plpgsql as $$
begin
  update projects.deliverable_details set admin_status = 'approved', admin_decided_at = now() where deliverable_id = p_d;
  return 'approved';
exception when restrict_violation then return 'refused: ' || sqlerrm;
end $$;
grant execute on function pg_temp.approve(uuid) to public;
select pg_temp.check(pg_temp.approve(:'D1_id') like 'refused: the Admin receives only a QA-passed build%', 'an Admin cannot approve a build whose QA is qa_changes_required');

-- ═══ build 2 fixes what build 1 broke ══════════════════════════════════════
select pg_temp.as_user(:'BUILDER2', :'ORG', 'member');
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, platform, screens)
  values (:'ORG', :'P_id', :'V_id', :'D2_id', 'web', '[
  {"screenKey":"home","elements":[{"type":"heading","label":"Welcome"},{"type":"text","label":"Nothing here yet - empty"},{"type":"text","label":"Something went wrong - error"},{"type":"button","label":"Open list","navigatesTo":"list"}]},
  {"screenKey":"list","elements":[{"type":"text","label":"Your items"},{"type":"link","label":"Details","navigatesTo":"detail"},{"type":"button","label":"Save"},{"type":"link","label":"Back","navigatesTo":"home"}]},
  {"screenKey":"detail","elements":[{"type":"text","label":"An item"},{"type":"link","label":"Back","navigatesTo":"list"}]}]')
  returning id \gset PA2_

insert into fx values ('PA2', :'PA2_id'), ('D2', :'D2_id');
select d.defect_id as dfx_detail from projects.p4q_prototype_defects d where d.artifact_id = :'PA1_id' and d.check_key = 'coverage:screen:detail' \gset
select d.defect_id as dfx_route from projects.p4q_prototype_defects d where d.artifact_id = :'PA1_id' and d.check_key = 'navigation:route:list->ghost' \gset
select d.defect_id as dfx_deco from projects.p4q_prototype_defects d where d.artifact_id = :'PA1_id' and d.check_key = 'interaction:decorative:list:1' \gset
insert into fx values ('DEF_DETAIL', :'dfx_detail'), ('DEF_ROUTE', :'dfx_route'), ('DEF_DECO', :'dfx_deco');
insert into fx values ('BUILDER2', :'BUILDER2');

-- a claimed fix must name a real, open prototype defect found on an EARLIER build of this project
select pg_temp.check((select outcome from projects.p4q_declare_prototype_intake(:'PA2_id', '{}', array['mobile','desktop'], null, '{}', null, 'qa_correction', array[gen_random_uuid()])) = 'unknown_defect', 'a claimed fix of a defect that does not exist is refused');
select pg_temp.check((select outcome from projects.p4q_declare_prototype_intake(:'PA2_id', array['home'], array['mobile','desktop'], 'mock data uses example.test addresses', '{}', '{"selfCheck":"routes walked"}', 'qa_correction', array[:'dfx_detail'::uuid, :'dfx_route'::uuid])) = 'declared',
  'build 2 declares itself a qa_correction and claims two fixes');
select pg_temp.check((select status from qa.defects where id = :'dfx_detail') = 'fixed' and (select fix_artifact_id from projects.p4q_prototype_defects where defect_id = :'dfx_detail') = :'PA2_id', 'FIX_READY is a claim tied to the exact fix build, not a verification');
select pg_temp.check((select status from qa.defects where id = :'dfx_deco') = 'open', 'an unclaimed defect stays open');
select pg_temp.check((select count(*) from qa.blocking_defects(:'D1_id') where id = :'dfx_detail') = 1, 'a fix claim still blocks the old build: FIX_READY is not VERIFIED');

-- retest refusals
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.p4q_retest_prototype_defect(:'dfx_deco', :'PA2_id')) = 'no_fix_build', 'a defect with no declared fix build cannot be retested');
select pg_temp.check((select outcome from projects.p4q_retest_prototype_defect(:'dfx_detail', :'PA1_id')) = 'wrong_build', 'a retest against any build but the declared fix build is refused');
select pg_temp.check((select outcome from projects.p4q_retest_prototype_defect(:'dfx_detail', :'PA2_id')) = 'fix_build_not_tested', 'a fix build QA has not run cannot verify anything');
select pg_temp.check((select outcome from projects.p4q_link_fix_build(:'dfx_deco', :'PA1_id')) = 'same_build', 'a build cannot be the fix of its own defect');

-- the run on build 2: passes, retests the two claimed fixes
select r.run_id, r.verdict from projects.p4q_run_prototype_qa(:'PA2_id') r \gset R2_
insert into fx values ('R2', :'R2_run_id');
select pg_temp.check(:'R2_verdict' = 'qa_pass', 'build 2 has no P0/P1 failure: qa_pass (P2 findings stay for the Admin)');
select pg_temp.check((select status from projects.prototype_artifacts where id = :'PA2_id') = 'qa_pass', 'the artifact status is qa_pass');
select pg_temp.check((select status from qa.defects where id = :'dfx_detail') = 'fixed' and (select retest_result from projects.p4q_prototype_defects where defect_id = :'dfx_detail') = 'pass', 'an agent run records the retest pass but leaves the defect at FIX_READY: verification needs a named person');
select pg_temp.check((select retest_run_id from projects.p4q_prototype_defects where defect_id = :'dfx_detail') = :'R2_run_id', 'the retest names the run that proved it');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select count(*) from projects.p4q_defects_awaiting_verification(:'P_id')) = 2, 'the two retested fixes wait for a person to verify them');
select pg_temp.as_user(:'BUILDER2', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p4q_verify_retested_defect(:'dfx_detail')) = 'self_review', 'the person who built the fix cannot verify it');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from projects.p4q_verify_retested_defect(:'dfx_detail')) = 'verified' and (select outcome from projects.p4q_verify_retested_defect(:'dfx_route')) = 'verified', 'a different person verifies both retested fixes');
select pg_temp.check((select verified_by from qa.defects where id = :'dfx_detail') = :'OWNER', 'the verifier is on the defect');
select pg_temp.check((select outcome from projects.p4q_verify_retested_defect(:'dfx_deco')) = 'not_retested', 'a defect that was never retested cannot be verified');
select pg_temp.as_service();
select pg_temp.check((select status from qa.defects where id = :'dfx_deco') = 'open', 'the unclaimed decorative-button defect is still open (a pass does not sweep defects)');
select pg_temp.check((select count(*) from qa.blocking_defects(:'D1_id') where id in (:'dfx_detail', :'dfx_route')) = 0, 'the verified defects no longer block');
select pg_temp.check(array_length((select changed_screens from projects.p4q_prototype_qa_runs where id = :'R2_run_id'), 1) >= 2 and (select previous_run_id from projects.p4q_prototype_qa_runs where id = :'R2_run_id') = :'R1_run_id', 'the run records the changed area and the run it follows');
select pg_temp.as_user(:'BUILDER2', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p4q_retest_prototype_defect(:'dfx_detail', :'PA2_id')) = 'self_review', 'the person who built the fix cannot be the one who verifies it');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from projects.p4q_retest_prototype_defect(:'dfx_detail', :'PA2_id')) = 'already_verified', 'a verified defect is not retested twice');

-- the admin may now approve the QA-passed build
select pg_temp.as_service();
insert into projects.deliverable_details (deliverable_id, organization_id, project_id) values (:'D2_id', :'ORG', :'P_id');
select pg_temp.check(pg_temp.approve(:'D2_id') = 'approved', 'an Admin can approve the QA-passed build');

-- ═══ build 3: a fix claim that does not hold, and a regression ══════════════
set local session_replication_role = replica;
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 3, 'zztest build 3') returning id \gset D3_
set local session_replication_role = origin;
update projects.prototype_artifacts set created_at = now() - interval '1 day' where id = :'PA2_id';
select pg_temp.as_user(:'BUILDER', :'ORG', 'member');
-- still has the decorative Save button, and brings the broken route back
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, platform, screens)
  values (:'ORG', :'P_id', :'V_id', :'D3_id', 'web', '[
  {"screenKey":"home","elements":[{"type":"heading","label":"Welcome"},{"type":"text","label":"Nothing here yet - empty"},{"type":"text","label":"Something went wrong - error"},{"type":"button","label":"Open list","navigatesTo":"list"}]},
  {"screenKey":"list","elements":[{"type":"text","label":"Your items"},{"type":"button","label":"Save"},{"type":"link","label":"Details","navigatesTo":"detail"},{"type":"link","label":"Help","navigatesTo":"ghost"},{"type":"link","label":"Back","navigatesTo":"home"}]},
  {"screenKey":"detail","elements":[{"type":"text","label":"An item"},{"type":"link","label":"Back","navigatesTo":"list"}]}]')
  returning id \gset PA3_
insert into fx values ('PA3', :'PA3_id');
select pg_temp.check((select outcome from projects.p4q_declare_prototype_intake(:'PA3_id', array['home'], array['mobile'], null, '{}', null, 'qa_correction', array[:'dfx_deco'::uuid])) = 'declared', 'build 3 claims it fixes the decorative button');
select pg_temp.as_user(:'REVIEWER', :'ORG', 'member');
select r.run_id, r.verdict from projects.p4q_run_prototype_qa(:'PA3_id') r \gset R3_
select pg_temp.check(:'R3_verdict' = 'qa_changes_required', 'the broken route is back: build 3 needs changes');
select pg_temp.check((select retest_result from projects.p4q_prototype_defects where defect_id = :'dfx_deco') = 'still_failing' and (select status from qa.defects where id = :'dfx_deco') = 'open', 'a fix claim that did not hold reopens the defect (still_failing)');
select pg_temp.check((select fix_artifact_id from projects.p4q_prototype_defects where defect_id = :'dfx_deco') is null, 'the failed claim is cleared; a new claim is needed');
select pg_temp.check((select count(*) from projects.p4q_prototype_defects pd join qa.defects d on d.id = pd.defect_id where pd.artifact_id = :'PA3_id' and pd.reappears_defect_id = :'dfx_route' and d.title like 'Regression:%') = 1, 'a previously verified defect that reappears is recorded as a regression of it');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select count(*) from jsonb_array_elements(projects.p4q_prototype_admin_handoff(:'PA3_id') -> 'regressions')) = 1, 'the Admin handoff package lists the regression');

-- ═══ BLOCKED_EXTERNAL and INVALID_INTAKE are not passes ═════════════════════
set local session_replication_role = replica;
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 4, 'zztest build 4') returning id \gset D4_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 5, 'zztest build 5') returning id \gset D5_
set local session_replication_role = origin;
select pg_temp.as_user(:'BUILDER2', :'ORG', 'member');
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, platform, screens)
  values (:'ORG', :'P_id', :'V_id', :'D4_id', 'web', '[{"screenKey":"home","elements":[{"type":"heading","label":"Hi"}]}]') returning id \gset PA4_
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, platform, screens)
  values (:'ORG', :'P_id', :'VU_id', :'D5_id', 'web', '[{"screenKey":"home","elements":[{"type":"heading","label":"Hi"}]}]') returning id \gset PA5_
insert into fx values ('PA4', :'PA4_id'), ('PA5', :'PA5_id');
select pg_temp.as_user(:'REVIEWER', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p4q_run_prototype_qa(:'PA4_id', 'the test environment is down', 'admin', 'the environment is back')) = 'blocked', 'an external blocker is recorded as blocked');
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.p4q_run_prototype_qa(:'PA4_id', 'second attempt', 'admin')) = 'already_blocked', 'one open blocker per build');
select pg_temp.check((select status from projects.prototype_artifacts where id = :'PA4_id') = 'draft' and (select qa_reviewed_at from projects.prototype_artifacts where id = :'PA4_id') is null, 'a blocked build has no verdict and no pass');
select pg_temp.check((select count(*) from projects.p4q_prototype_qa_blockers where artifact_id = :'PA4_id' and kind = 'blocked_external' and owner = 'admin' and resolved_at is null) = 1, 'the blocker names its kind, owner and open state');
select pg_temp.check((select count(*) from core.outbox_events where subject_id = :'PA4_id' and type = 'project.p4q_prototype_qa_blocked') = 1, 'a blocked run emits project.p4q_prototype_qa_blocked');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select qa_state from projects.p4q_prototype_qa_overview(:'P_id') where artifact_id = :'PA4_id') = 'blocked_external', 'the Admin overview shows the build as blocked_external');
select b.id as blk from projects.p4q_prototype_qa_blockers b where b.artifact_id = :'PA4_id' \gset
select pg_temp.check((select outcome from projects.p4q_resolve_qa_blocker(:'blk', 'ok')) = 'note_required', 'resolving needs a real note');
select pg_temp.check((select outcome from projects.p4q_resolve_qa_blocker(:'blk', 'the test environment is back up')) = 'resolved', 'a person resolves the blocker');
select pg_temp.check((select status from projects.prototype_artifacts where id = :'PA4_id') = 'draft', 'resolving a blocker does not pass the build');
select pg_temp.as_user(:'REVIEWER', :'ORG', 'member');
select pg_temp.check((select verdict from projects.p4q_run_prototype_qa(:'PA4_id')) is not null, 'after the blocker is resolved QA can run the build');
-- invalid intake: the source UI is not locked
select pg_temp.as_service();
select pg_temp.check((select verdict from projects.p4q_run_prototype_qa(:'PA5_id')) = 'invalid_intake', 'a build on a UI version that is not locked is an INVALID_INTAKE, not a pass');
select pg_temp.check((select owner from projects.p4q_prototype_qa_blockers where artifact_id = :'PA5_id') = 'ui_designer' and (select status from projects.prototype_artifacts where id = :'PA5_id') = 'draft', 'its blocker is owned by the designer and the build stays a draft');

-- ═══ the Admin reads ═══════════════════════════════════════════════════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check(projects.p4q_prototype_admin_handoff(:'PA2_id') -> 'qa' ->> 'outcome' = 'qa_pass' and projects.p4q_prototype_admin_handoff(:'PA2_id') -> 'sourceUi' ->> 'version' = '1', 'the handoff package names the exact build, source UI and QA outcome');
select pg_temp.check(jsonb_typeof(projects.p4q_prototype_admin_handoff(:'PA1_id') -> 'openDefectsBySeverity') = 'object' and jsonb_array_length(projects.p4q_prototype_admin_handoff(:'PA1_id') -> 'limitations') = 1, 'the package carries open defects by severity and the limitations');
select pg_temp.check((select count(*) from projects.p4q_prototype_qa_overview(:'P_id')) = 5, 'the build history lists every build with its state');
select pg_temp.check((select why from projects.p4q_prototype_qa_overview(:'P_id') where artifact_id = :'PA1_id') like '%navigation:route:list->ghost%', 'the history says WHY a build failed');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check(projects.p4q_prototype_admin_handoff(:'PA2_id') is null and (select count(*) from projects.p4q_prototype_qa_overview(:'P_id')) = 0, 'another organisation reads neither the package nor the history');

-- ═══ the tables take no direct write ═══════════════════════════════════════
create or replace function pg_temp.direct(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'allowed'; exception when others then return 'refused'; end $$;
grant execute on function pg_temp.direct(text) to public;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.direct('insert into projects.p4q_prototype_qa_checks (organization_id, run_id, check_key, category, target, expected, actual, result, severity) values (gen_random_uuid(), gen_random_uuid(), ''x:y'', ''smoke'', ''t'', ''e'', ''a'', ''pass'', ''P3'')') = 'refused', 'a check cannot be inserted directly');
select pg_temp.check(pg_temp.direct('update projects.p4q_prototype_qa_checks set result = ''pass''') = 'refused', 'a check cannot be edited to pass');
select pg_temp.check(pg_temp.direct('delete from projects.p4q_prototype_qa_runs') = 'refused', 'a run cannot be deleted');
select pg_temp.check(pg_temp.direct('update projects.p4q_prototype_defects set retest_result = ''pass''') = 'refused', 'a defect cannot be marked retested by a direct statement');
select pg_temp.check((select count(*) from projects.p4q_prototype_qa_checks) > 0, 'internal staff can read the checks');
reset role;
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p4q_prototype_qa_checks) = 0 and (select count(*) from projects.p4q_prototype_qa_runs) = 0, 'another organisation reads none of the runs or checks');
reset role;
select pg_temp.as_nobody();

-- ═══ the pure evaluator on its own ═════════════════════════════════════════
create or replace function pg_temp.ev(p_design text, p_build text, p_crit text[] default '{}', p_lims text default '[]') returns table (k text, r text, s text) language sql stable as $$
  select check_key, result, severity from projects.p4q_evaluate_prototype(pg_temp.fx('P'), p_design::jsonb, p_build::jsonb, p_crit, p_lims::jsonb) $$;
grant execute on function pg_temp.ev(text, text, text[], text) to public;
select pg_temp.check((select r from pg_temp.ev('[{"screenKey":"a"}]', '[{"screenKey":"a","elements":[{"type":"text","label":"key ' || pg_temp.k() || '"}]}]') where k = 'data:secrets') = 'fail', 'a credential in ANY string of the build is a P0 (not only labels)');
select pg_temp.check((select r from pg_temp.ev('[{"screenKey":"a"}]', format('[{"screenKey":"a","elements":[{"type":"text","label":"see %s"}]}]', :'P2_id')) where k = 'data:cross_project') = 'fail', 'another project''s id inside the build is a P0');
select pg_temp.check((select r from pg_temp.ev('[{"screenKey":"a"}]', format('[{"screenKey":"a","elements":[{"type":"text","label":"see %s"}]}]', :'P_id')) where k = 'data:cross_project') = 'pass', 'this project''s own id is not cross-project data');
select pg_temp.check((select r from pg_temp.ev('[{"screenKey":"a"}]', '[{"screenKey":"a","elements":[{"type":"text","label":"lorem ipsum dolor"}]}]') where k = 'coverage:blank:a') = 'fail', 'placeholder text is a blank screen');
select pg_temp.check((select r from pg_temp.ev('[{"screenKey":"a"}]', '[{"screenKey":"a","elements":[{"type":"input","label":"Name"}]}]') where k = 'interaction:form:a') = 'fail', 'a form with no way to submit or leave is flagged');
select pg_temp.check((select r from pg_temp.ev('[{"screenKey":"a"},{"screenKey":"b"},{"screenKey":"c"}]',
  '[{"screenKey":"a","elements":[{"type":"link","label":"to b","navigatesTo":"b"}]},{"screenKey":"b","elements":[{"type":"link","label":"to c","navigatesTo":"c"}]},{"screenKey":"c","elements":[{"type":"link","label":"stay","navigatesTo":"c"}]}]') where k = 'navigation:trap:c') = 'fail',
  'a screen whose every way out loops on itself traps the reviewer');
select pg_temp.check((select r from pg_temp.ev('[{"screenKey":"a"}]', '[{"screenKey":"a","elements":[{"type":"text","label":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}]') where k = 'layout:overflow:a:0') = 'fail', 'an unbroken 40+ character run is an overflow risk');
select pg_temp.check((select r from pg_temp.ev('[{"screenKey":"a","statesAddressed":["default","loading"]}]', '[{"screenKey":"a","elements":[{"type":"text","label":"Hi"}]},{"screenKey":"a.loading","elements":[{"type":"text","label":"..."}]}]') where k = 'states:a:loading') = 'pass'
  and (select count(*) from pg_temp.ev('[{"screenKey":"a","statesAddressed":["default","loading"]}]', '[{"screenKey":"a","elements":[{"type":"text","label":"Hi"}]},{"screenKey":"a.loading","elements":[{"type":"text","label":"..."}]}]') where k = 'coverage:extra:a.loading') = 0,
  'a state variant screen satisfies its state and is not an extra screen');
select pg_temp.check((select s from pg_temp.ev('[{"screenKey":"a"},{"screenKey":"b"}]', '[{"screenKey":"a","elements":[{"type":"text","label":"Hi"}]}]', array['a','b']) where k = 'coverage:screen:b') = 'P0', 'a missing declared-critical screen is P0');
select pg_temp.check((select r from pg_temp.ev('[{"screenKey":"a"}]', '[{"screenKey":"a","elements":[{"type":"text","label":"Hi"}]}]', '{}', '[{"id":"l1","screen_key":"zzz","statement":"x"}]') where k = 'limitation:l1') = 'fail', 'a limitation naming a screen that was never designed is flagged');
select pg_temp.check((select r from pg_temp.ev('[]', '[]') where k = 'smoke:opens') = 'fail' and (select s from pg_temp.ev('[]', '[]') where k = 'smoke:opens') = 'P0', 'an empty build does not open: P0');

-- ═══ RED-PROOFS: each control, mutated in its LIVE definition, must now fail ══
set local session_replication_role = replica;
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 6, 'zztest build 6') returning id \gset D6_
set local session_replication_role = origin;
select pg_temp.as_user(:'BUILDER', :'ORG', 'member');
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, platform, screens)
  values (:'ORG', :'P_id', :'V_id', :'D6_id', 'web', '[{"screenKey":"home","elements":[{"type":"link","label":"x","navigatesTo":"ghost"}]}]') returning id \gset PA6_
set local session_replication_role = replica;
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 7, 'zztest build 7') returning id \gset D7_
set local session_replication_role = origin;
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, platform, screens)
  values (:'ORG', :'P_id', :'VU_id', :'D7_id', 'web', '[{"screenKey":"home","elements":[{"type":"heading","label":"Hi"}]}]') returning id \gset PA7_
insert into fx values ('PA7', :'PA7_id');
insert into fx values ('PA6', :'PA6_id'), ('BUILDER', :'BUILDER'), ('REVIEWER', :'REVIEWER'), ('ORG', :'ORG'), ('OWNER', :'OWNER');
select pg_temp.as_nobody();

select pg_temp.red('a builder can run the QA of their own build', 'projects.p4q_run_prototype_qa(uuid,text,text,text)',
  'v_actor is not distinct from v_art.produced_by then return query select ''self_review''', 'false and v_actor is not distinct from v_art.produced_by then return query select ''self_review''',
  $p$ select (pg_temp.as_user(pg_temp.fx('BUILDER'), pg_temp.fx('ORG'), 'member') is not null) and (select outcome from projects.p4q_run_prototype_qa(pg_temp.fx('PA6'))) = 'self_review' $p$);
select pg_temp.red('a failing build passes', 'projects.p4q_run_prototype_qa(uuid,text,text,text)',
  'when v_blocking > 0 then ''qa_changes_required''', 'when false then ''qa_changes_required''',
  $p$ select (pg_temp.as_user(pg_temp.fx('REVIEWER'), pg_temp.fx('ORG'), 'member') is not null) and (select verdict from projects.p4q_run_prototype_qa(pg_temp.fx('PA6'))) = 'qa_changes_required' $p$);
select pg_temp.red('a broken route is not seen', 'projects.p4q_evaluate_prototype(uuid,jsonb,jsonb,text[],jsonb)',
  'if (v_el ->> ''navigatesTo'') = any (v_bkeys) then', 'if true then',
  $p$ select (select count(*) from projects.p4q_evaluate_prototype(pg_temp.fx('P'), '[{"screenKey":"a"}]', '[{"screenKey":"a","elements":[{"type":"link","label":"x","navigatesTo":"ghost"}]}]', '{}', '[]') where check_key like 'navigation:route:%' and result = 'fail') = 1 $p$);
select pg_temp.red('a secret passes unseen', 'projects.p4q_evaluate_prototype(uuid,jsonb,jsonb,text[],jsonb)',
  'v_ok := not projects.p7_has_secret(v_text);', 'v_ok := true;',
  $p$ select (select result from projects.p4q_evaluate_prototype(pg_temp.fx('P'), '[{"screenKey":"a"}]', '[{"screenKey":"a","elements":[{"type":"text","label":"' || pg_temp.k() || '"}]}]', '{}', '[]') where check_key = 'data:secrets') = 'fail' $p$);
select pg_temp.red('an unlocked UI is accepted as an intake', 'projects.p4q_run_prototype_qa(uuid,text,text,text)',
  'v_ui.status <> ''locked''', 'false',
  $p$ select (pg_temp.as_service() is not null) and (select verdict from projects.p4q_run_prototype_qa(pg_temp.fx('PA7'))) = 'invalid_intake' $p$);
select pg_temp.red('a retest against any build verifies', 'projects.p4q_retest_prototype_defect(uuid,uuid)',
  'if v_pd.fix_artifact_id is distinct from p_artifact_id then', 'if false then',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from projects.p4q_retest_prototype_defect(pg_temp.fx('DEF_DETAIL'), pg_temp.fx('PA1'))) = 'wrong_build' $p$);
select pg_temp.red('the fixer verifies their own fix', 'projects.p4q_retest_prototype_defect(uuid,uuid)',
  'if v_actor is not null and v_actor is not distinct from v_art.produced_by then', 'if false then',
  $p$ select (pg_temp.as_user(pg_temp.fx('BUILDER2'), pg_temp.fx('ORG'), 'member') is not null) and (select outcome from projects.p4q_retest_prototype_defect(pg_temp.fx('DEF_DETAIL'), pg_temp.fx('PA2'))) = 'self_review' $p$);
select pg_temp.red('an Admin approves a build QA has not passed', 'projects.p4q_admin_approval_needs_qa_pass()',
  'if v_status is not null and v_status <> ''qa_pass'' then', 'if false then',
  $p$ select pg_temp.approve(pg_temp.fx('D1')) like 'refused:%' $p$);
select pg_temp.red('a repeated run writes a second verdict', 'projects.p4q_run_prototype_qa(uuid,text,text,text)',
  'if v_existing.id is not null or v_art.qa_reviewed_at is not null then', 'if false then',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from projects.p4q_run_prototype_qa(pg_temp.fx('PA1'))) = 'already_reviewed' $p$);

rollback;
\echo ALL P4Q PROTOTYPE QA CHECKS PASSED
