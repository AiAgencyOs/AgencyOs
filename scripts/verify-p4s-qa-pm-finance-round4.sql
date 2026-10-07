-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 round 4 (migration 20261202000000): defect QA_RETEST / DEFERRED states, uploaded QA evidence, the traceability read, masked agent logs, a task-less
-- fallback record, an `unknown` delivery and the receipt page read. Every control is driven through its real door, then RED-PROVED: the live function definition is
-- mutated inside a sub-block that is rolled back, the probe must now fail, and a mutation that changes nothing raises.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p4s-qa-pm-finance-round4.sql
--
-- Helper names carry the p4s_ prefix so they cannot collide with another verifier chained in the same psql session. Counts are scoped to this script's own rows.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.p4s_check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.p4s_check(boolean, text) to public;
create or replace function pg_temp.p4s_as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.p4s_as_user(uuid, uuid, text) to public;
create or replace function pg_temp.p4s_as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true); end $$;
grant execute on function pg_temp.p4s_as_service() to public;
create or replace function pg_temp.p4s_as_nobody() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '', true); end $$;
grant execute on function pg_temp.p4s_as_nobody() to public;
create temp table p4s_fx (k text primary key, v text);
grant all on p4s_fx to public;
create or replace function pg_temp.p4s_fx(p text) returns uuid language sql stable as $$ select v::uuid from p4s_fx where k = p $$;
grant execute on function pg_temp.p4s_fx(text) to public;
create or replace function pg_temp.p4s_key() returns text language sql immutable as $$ select 'sk-' || 'ant-api03-' || 'abcdefghijklmnopqrstuvwxyz' || '0123456789' $$;
grant execute on function pg_temp.p4s_key() to public;
-- RED-PROOF: mutate the LIVE definition, run the probe (true = the control still holds), restore by rolling the block back. A no-op mutation raises.
create or replace function pg_temp.p4s_red(p_what text, p_fn text, p_from text, p_to text, p_probe text) returns void language plpgsql as $$
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
grant execute on function pg_temp.p4s_red(text, text, text, text, text) to public;
create or replace function pg_temp.p4s_direct(p_sql text, p_role text default null) returns text language plpgsql as $$
begin
  if p_role is not null then execute format('set local role %I', p_role); end if;
  begin execute p_sql; exception when others then reset role; return 'refused'; end;
  reset role;
  return 'allowed';
end $$;
grant execute on function pg_temp.p4s_direct(text, text) to public;

create or replace function pg_temp.p4s_lc(p_defect uuid) returns text language plpgsql volatile as $$
begin return projects.p4s_defect_lifecycle(p_defect); end $$;
grant execute on function pg_temp.p4s_lc(uuid) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000000c4'
\set OWNER '00000000-0000-4000-8000-00000000f711'
\set OWNER2 '00000000-0000-4000-8000-00000000f712'
\set BUILDER '00000000-0000-4000-8000-00000000f713'
\set BUILDER2 '00000000-0000-4000-8000-00000000f714'
\set REVIEWER '00000000-0000-4000-8000-00000000f715'

insert into auth.users (id, email) values (:'OWNER', 'p4s-owner@example.test'), (:'OWNER2', 'p4s-owner2@example.test'), (:'BUILDER', 'p4s-builder@example.test'),
  (:'BUILDER2', 'p4s-builder2@example.test'), (:'REVIEWER', 'p4s-reviewer@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4s-owner@example.test', 'P4S Owner'), (:'OWNER2', 'p4s-owner2@example.test', 'P4S Owner Two'),
  (:'BUILDER', 'p4s-builder@example.test', 'P4S Builder'), (:'BUILDER2', 'p4s-builder2@example.test', 'P4S Builder Two'), (:'REVIEWER', 'p4s-reviewer@example.test', 'P4S Reviewer') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'BUILDER', 'member'), (:'ORG', :'BUILDER2', 'member'), (:'ORG', :'REVIEWER', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p4s other org', 'zztest-p4s-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4s client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4s', 'ZP4S-1') returning id \gset P_
insert into p4s_fx values ('P', :'P_id');

set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, payload, phase_four_ready, readiness_note)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', false, 'fixture') returning id \gset H_
insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id, state) values (:'ORG', :'P_id', :'H_id', 'prototype_build') returning id \gset F_
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P_id', :'F_id', :'H_id', 1, 'locked', now(), '[
    {"screenKey":"home","layoutSummary":"x","keyComponents":["a"],"statesAddressed":["default","empty","error"]},
    {"screenKey":"list","layoutSummary":"x","keyComponents":["a"],"statesAddressed":["default"]},
    {"screenKey":"detail","layoutSummary":"x","keyComponents":["a"],"statesAddressed":["default","error"]}]') returning id \gset V_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 1, 'zztest p4s build 1') returning id \gset D1_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 2, 'zztest p4s build 2') returning id \gset D2_
set local session_replication_role = origin;

-- build 1: the detail screen is missing and one route is broken
select pg_temp.p4s_as_user(:'BUILDER', :'ORG', 'member');
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, platform, screens) values (:'ORG', :'P_id', :'V_id', :'D1_id', 'web', '[
  {"screenKey":"home","elements":[{"type":"heading","label":"Welcome"},{"type":"text","label":"Nothing here yet - empty"},{"type":"text","label":"Something went wrong - error"},{"type":"button","label":"Open list","navigatesTo":"list"}]},
  {"screenKey":"list","elements":[{"type":"text","label":"Your items"},{"type":"link","label":"Help","navigatesTo":"ghost"},{"type":"link","label":"Back","navigatesTo":"home"}]}]') returning id \gset PA1_
update projects.prototype_artifacts set created_at = now() - interval '2 days' where id = :'PA1_id';
select pg_temp.p4s_as_service();
select r.run_id as r1_run, r.verdict as r1_verdict from projects.p4q_run_prototype_qa(:'PA1_id') r \gset
insert into p4s_fx values ('PA1', :'PA1_id'), ('R1', :'r1_run');
select d.defect_id as def_detail from projects.p4q_prototype_defects d where d.artifact_id = :'PA1_id' and d.check_key = 'coverage:screen:detail' \gset
select d.defect_id as def_route from projects.p4q_prototype_defects d where d.artifact_id = :'PA1_id' and d.check_key = 'navigation:route:list->ghost' \gset
insert into p4s_fx values ('DEF_DETAIL', :'def_detail'), ('DEF_ROUTE', :'def_route');
select pg_temp.p4s_check(:'r1_verdict' = 'qa_changes_required' and :'def_detail' is not null and :'def_route' is not null, 'fixture: build 1 failed QA and raised defects');

-- ═══ 1. QAP-019: DEFERRED ═════════════════════════════════════════════════════
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_check(pg_temp.p4s_lc(:'def_detail') = 'open', 'a new prototype defect is open');
select pg_temp.p4s_as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.p4s_check(pg_temp.p4s_lc(:'def_detail') is null, 'another organisation reads no lifecycle');
select pg_temp.p4s_as_user(:'BUILDER', :'ORG', 'member');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'The client accepted this gap for the first release')) = 'not_authorized', 'a member cannot defer a defect: deferral is an Admin act');
select pg_temp.p4s_as_service();
select pg_temp.p4s_check(pg_temp.p4s_direct('select * from projects.p4s_defer_defect(''' || :'def_detail' || ''', ''The client accepted this gap for the first release'')', 'service_role') = 'refused', 'the service role (an agent) cannot call the deferral door at all');
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'short')) = 'reason_required', 'a deferral needs a real reason');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'the key is ' || pg_temp.p4s_key())) = 'contains_secret', 'a deferral reason carrying a credential is refused');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'The client accepted this gap for the first release', current_date - 1)) = 'until_in_past', 'a deferral date in the past is refused');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'The client accepted this gap for the first release', current_date + 30)) = 'deferred', 'an Admin defers an open defect with a reason and a date');
select pg_temp.p4s_check(pg_temp.p4s_lc(:'def_detail') = 'deferred', 'the lifecycle reads deferred');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'The client accepted this gap for the first release')) = 'already_deferred', 'a deferred defect is not deferred twice');
select pg_temp.p4s_check((select lifecycle from projects.p4s_prototype_defect_board(:'P_id') where defect_id = :'def_detail') = 'deferred'
  and (select deferral_reason from projects.p4s_prototype_defect_board(:'P_id') where defect_id = :'def_detail') like 'The client accepted%', 'the board shows the state and the reason');
select pg_temp.p4s_check((select status from qa.defects where id = :'def_detail') = 'open' and (select outcome from projects.p4q_prototype_qa_runs r join projects.prototype_artifacts a on a.id = r.artifact_id where r.id = pg_temp.p4s_fx('R1')) = 'qa_changes_required', 'deferring edits neither the defect status nor the QA verdict: the build still does not pass');
select pg_temp.p4s_check((select outcome from projects.p4s_request_defect_retest(:'def_detail')) = 'deferred', 'a deferred defect cannot be asked for retest');
select pg_temp.p4s_check(pg_temp.p4s_direct('update projects.p4q_prototype_defects set deferred_at = null, deferral_reason = null where defect_id = ''' || :'def_detail' || '''', 'authenticated') = 'refused', 'a direct update of the deferral is refused: only the door writes it');
select pg_temp.p4s_as_user(:'BUILDER', :'ORG', 'member');
select pg_temp.p4s_check((select outcome from projects.p4s_undefer_defect(:'def_detail')) = 'not_authorized', 'a member cannot bring a deferred defect back');
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_check((select outcome from projects.p4s_undefer_defect(:'def_detail')) = 'undeferred' and pg_temp.p4s_lc(:'def_detail') = 'open', 'an Admin brings it back: open again');
select pg_temp.p4s_check((select outcome from projects.p4s_undefer_defect(:'def_detail')) = 'not_deferred', 'a defect that is not deferred cannot be undeferred');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'Deferred again after the second review')) = 'deferred' and (select outcome from projects.p4s_undefer_defect(:'def_detail')) = 'undeferred', 'a defect may be deferred again after it came back');

-- ═══ 2. QAP-019: FIX_READY -> QA_RETEST -> retest passed -> VERIFIED ═══════════
select pg_temp.p4s_check((select outcome from projects.p4s_request_defect_retest(:'def_detail')) = 'no_fix_build', 'a retest cannot be asked for a defect that has no fix build');
select pg_temp.p4s_as_user(:'BUILDER2', :'ORG', 'member');
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, platform, screens) values (:'ORG', :'P_id', :'V_id', :'D2_id', 'web', '[
  {"screenKey":"home","elements":[{"type":"heading","label":"Welcome"},{"type":"text","label":"Nothing here yet - empty"},{"type":"text","label":"Something went wrong - error"},{"type":"button","label":"Open list","navigatesTo":"list"}]},
  {"screenKey":"list","elements":[{"type":"text","label":"Your items"},{"type":"link","label":"Details","navigatesTo":"detail"},{"type":"link","label":"Back","navigatesTo":"home"}]},
  {"screenKey":"detail","elements":[{"type":"text","label":"An item"},{"type":"text","label":"Something went wrong - error"},{"type":"link","label":"Back","navigatesTo":"list"}]}]') returning id \gset PA2_
insert into p4s_fx values ('PA2', :'PA2_id');
select pg_temp.p4s_check((select outcome from projects.p4q_declare_prototype_intake(:'PA2_id', array['home'], array['mobile'], null, '{}', null, 'qa_correction', array[:'def_detail'::uuid])) = 'declared'
  and pg_temp.p4s_lc(:'def_detail') = 'fix_ready', 'a claimed fix reads fix_ready');
select pg_temp.p4s_as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.p4s_check((select outcome from projects.p4s_request_defect_retest(:'def_detail')) = 'forbidden', 'another organisation cannot ask for a retest');
select pg_temp.p4s_as_user(:'REVIEWER', :'ORG', 'member');
select pg_temp.p4s_check((select outcome from projects.p4s_request_defect_retest(:'def_route')) = 'no_fix_build', 'a defect with no claimed fix cannot be put into retest');
select pg_temp.p4s_check((select outcome from projects.p4s_request_defect_retest(:'def_detail')) = 'requested' and pg_temp.p4s_lc(:'def_detail') = 'qa_retest', 'QA asks for the retest of the exact fix build: qa_retest');
select pg_temp.p4s_check((select outcome from projects.p4s_request_defect_retest(:'def_detail')) = 'already_requested', 'asking twice changes nothing');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'Trying to defer a defect that has a fix')) = 'not_authorized', 'a member still cannot defer');
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'Trying to defer a defect that has a fix')) = 'not_open', 'a defect that has a claimed fix is not open: it cannot be deferred away from its retest');
select pg_temp.p4s_as_service();
select r.run_id as r2_run, r.verdict as r2_verdict from projects.p4q_run_prototype_qa(:'PA2_id') r \gset
select pg_temp.p4s_check((select retest_result from projects.p4q_prototype_defects where defect_id = :'def_detail') = 'pass' and pg_temp.p4s_lc(:'def_detail') is null, 'fixture: build 2 passed the originating check (the lifecycle read is internal-only, so the service role reads null)');
select pg_temp.p4s_as_user(:'REVIEWER', :'ORG', 'member');
select pg_temp.p4s_check(pg_temp.p4s_lc(:'def_detail') = 'retest_passed', 'the lifecycle reads retest_passed until a person verifies');
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_check((select outcome from projects.p4q_verify_retested_defect(:'def_detail')) = 'verified' and pg_temp.p4s_lc(:'def_detail') = 'verified', 'a person verifies it: verified');
select pg_temp.p4s_check((select outcome from projects.p4s_defer_defect(:'def_detail', 'Deferring a verified defect makes no sense')) = 'not_open', 'a verified defect cannot be deferred');

-- red-proofs for the lifecycle doors
select pg_temp.p4s_as_user(:'BUILDER', :'ORG', 'member');
select pg_temp.p4s_red('the Admin-only deferral', 'projects.p4s_defer_defect(uuid,text,date)',
  $f$if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;$f$, '',
  'select (select outcome from projects.p4s_defer_defect(''' || :'def_route' || ''', ''The client accepted this gap for the first release'')) = ''not_authorized''');
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_red('only an open defect can be deferred', 'projects.p4s_defer_defect(uuid,text,date)',
  $f$if v_st <> 'open' then return query select 'not_open'::text; return; end if;$f$, '',
  'select (select outcome from projects.p4s_defer_defect(''' || :'def_detail' || ''', ''Deferring a verified defect makes no sense'')) = ''not_open''');
select pg_temp.p4s_red('a retest needs a claimed fix build', 'projects.p4s_request_defect_retest(uuid)',
  $f$if v_st <> 'fixed' or v_pd.fix_artifact_id is null then return query select 'no_fix_build'::text; return; end if;$f$, '',
  'select (select outcome from projects.p4s_request_defect_retest(''' || :'def_route' || ''')) = ''no_fix_build''');
create or replace function pg_temp.p4s_defer_then_state(p_defect uuid) returns text language plpgsql as $$
begin
  perform projects.p4s_defer_defect(p_defect, 'Deferred inside a probe to read its state');
  return projects.p4s_defect_lifecycle(p_defect);
end $$;
grant execute on function pg_temp.p4s_defer_then_state(uuid) to public;
select pg_temp.p4s_red('a deferred defect reads deferred', 'projects.p4s_defect_lifecycle(uuid)',
  $f$then return 'deferred'; end if;$f$, $f$then return 'open'; end if;$f$,
  'select pg_temp.p4s_defer_then_state(''' || :'def_route' || ''') = ''deferred''');

-- ═══ 3. QAP-043: uploaded evidence ═════════════════════════════════════════════
select pg_temp.p4s_as_user(:'BUILDER', :'ORG', 'member');
create or replace function pg_temp.p4s_ev(p_run uuid, p_path text, p_name text, p_kind text default 'screenshot', p_size bigint default 2048, p_check text default null, p_defect uuid default null, p_note text default null)
returns text language sql as $$ select outcome from projects.p4s_attach_qa_evidence(p_run, p_path, p_name, p_kind, 'image/png', p_size, p_check, p_defect, p_note) $$;
grant execute on function pg_temp.p4s_ev(uuid, text, text, text, bigint, text, uuid, text) to public;
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r1_run' || '/home.png', 'home.png') = 'attached', 'a screenshot of the run is attached');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r1_run' || '/list.png', 'list.png', 'screenshot', 4096, 'navigation:route:list->ghost', :'def_route', 'the broken Help link') = 'attached', 'evidence can name the check and the defect it shows');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r2_run' || '/home.png', 'home.png') = 'bad_path', 'a path under another run is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG2' || '/evidence/' || :'r1_run' || '/home.png', 'home.png') = 'bad_path', 'a path under another organisation is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/builds/' || :'r1_run' || '/home.png', 'home.png') = 'bad_path', 'a path outside the evidence area is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r1_run' || '/run.exe', 'run.exe') = 'bad_file_type', 'a file that is not evidence is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r1_run' || '/.env.log', '.env.log') = 'credential_name', 'a credential-looking file name is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r1_run' || '/a.png', 'a.png', 'screenshot', 0) = 'bad_size', 'an empty file is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r1_run' || '/a.png', 'a.png', 'screenshot', 60000000) = 'bad_size', 'a file over the ceiling is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r1_run' || '/a.png', 'a.png', 'video') = 'bad_kind', 'an unknown kind is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r1_run' || '/a.png', 'a.png', 'screenshot', 2048, 'no:such:check') = 'unknown_check', 'a check the run never made is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG' || '/evidence/' || :'r1_run' || '/a.png', 'a.png', 'screenshot', 2048, null, :'def_route'::uuid, 'my key ' || pg_temp.p4s_key()) = 'contains_secret', 'a note carrying a credential is refused');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r2_run', :'ORG' || '/evidence/' || :'r2_run' || '/a.png', 'a.png', 'screenshot', 2048, null, :'def_route') = 'defect_not_from_this_run', 'a defect raised by another run is refused');
select pg_temp.p4s_as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.p4s_check(pg_temp.p4s_ev(:'r1_run', :'ORG2' || '/evidence/' || :'r1_run' || '/x.png', 'x.png') = 'unknown_run', 'another organisation cannot attach to this run');
select pg_temp.p4s_as_service();
select pg_temp.p4s_check(pg_temp.p4s_direct('select * from projects.p4s_attach_qa_evidence(''' || :'r1_run' || ''', ''p'', ''a.png'', ''screenshot'', null, 10)', 'service_role') = 'refused', 'the service role cannot call the attach door');
select pg_temp.p4s_check(pg_temp.p4s_direct('insert into projects.p4s_prototype_qa_evidence (organization_id, project_id, run_id, kind, storage_path, file_name, size_bytes) values (''' || :'ORG' || ''', ''' || :'P_id' || ''', ''' || :'r1_run' || ''', ''log'', ''' || :'ORG' || '/evidence/' || :'r1_run' || '/direct.log'', ''direct.log'', 10)', 'authenticated') = 'refused', 'a direct insert is refused: only the door writes evidence');
select pg_temp.p4s_check(pg_temp.p4s_direct('delete from projects.p4s_prototype_qa_evidence where run_id = ''' || :'r1_run' || '''', 'authenticated') = 'refused', 'evidence is never deleted');
select pg_temp.p4s_check(pg_temp.p4s_direct('update projects.p4s_prototype_qa_evidence set note = ''edited'' where run_id = ''' || :'r1_run' || '''', 'authenticated') = 'refused', 'evidence is never edited');
select pg_temp.p4s_check((select count(*) from projects.p4s_prototype_qa_evidence where run_id = :'r1_run') = 2, 'only the two valid files were stored');
select pg_temp.p4s_as_user(:'BUILDER', :'ORG', 'member');
select pg_temp.p4s_red('the evidence path is tied to the run', 'projects.p4s_attach_qa_evidence(uuid,text,text,text,text,bigint,text,uuid,text)',
  $f$split_part(p_storage_path, '/', 3) <> p_run_id::text$f$, $f$false$f$,
  'select pg_temp.p4s_ev(''' || :'r1_run' || ''', ''' || :'ORG' || '/evidence/' || :'r2_run' || '/z.png'', ''z.png'') = ''bad_path''');
select pg_temp.p4s_red('the evidence file type is checked', 'projects.p4s_attach_qa_evidence(uuid,text,text,text,text,bigint,text,uuid,text)',
  $f$if lower(v_name) !~ '\.(png|jpe?g|gif|webp|heic|txt|log|md|json|csv|xml|html|pdf|zip|har|mp4|mov|webm)$' then$f$, $f$if false then$f$,
  'select pg_temp.p4s_ev(''' || :'r1_run' || ''', ''' || :'ORG' || '/evidence/' || :'r1_run' || '/y.exe'', ''y.exe'') = ''bad_file_type''');

-- ═══ 4. QAP-004: the traceability matrix ═══════════════════════════════════════
select pg_temp.p4s_as_service();
set local session_replication_role = replica;
insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at, source) values (:'ORG', :'P_id', 1, 'active', now(), 'onboarding') returning id \gset SV_
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SV_id', 'Browse the items', 'included') returning id \gset SI1_
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SV_id', 'Pay online', 'included') returning id \gset SI2_
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SV_id', 'Loyalty points', 'excluded') returning id \gset SI3_
insert into projects.screens (organization_id, project_id, screen_key, name, user_role) values (:'ORG', :'P_id', 'list', 'List', 'client') returning id \gset SC1_
insert into projects.screens (organization_id, project_id, screen_key, name, user_role) values (:'ORG', :'P_id', 'detail', 'Detail', 'client') returning id \gset SC2_
insert into projects.screen_scope_items (screen_id, scope_item_id, organization_id) values (:'SC1_id', :'SI1_id', :'ORG'), (:'SC2_id', :'SI1_id', :'ORG');
set local session_replication_role = origin;
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_check((select count(*) from projects.p4s_prototype_traceability(:'PA1_id')) = 3, 'build 1: the covered requirement has one row per screen and the uncovered one a row of its own; the excluded one has none');
select pg_temp.p4s_check((select gap from projects.p4s_prototype_traceability(:'PA1_id') where requirement = 'Pay online') = 'no screen covers this requirement', 'a requirement no screen covers is a gap, not a blank');
select pg_temp.p4s_check((select screen_built and screen_designed and qa_result = 'pass' and built_elements = 3 and gap is null from projects.p4s_prototype_traceability(:'PA1_id') where screen_key = 'list'), 'a designed and built screen carries its states, elements and the QA result of its coverage check');
select pg_temp.p4s_check((select gap from projects.p4s_prototype_traceability(:'PA1_id') where screen_key = 'detail') = 'the screen is not built in this prototype'
  and (select designed_states from projects.p4s_prototype_traceability(:'PA1_id') where screen_key = 'detail') = array['default', 'error'], 'a designed screen the prototype does not build is a gap, with the states that were designed for it');
select pg_temp.p4s_check((select count(*) from projects.p4s_prototype_traceability(:'PA2_id') where gap is null) = 2, 'build 2 builds both screens: only the uncovered requirement stays a gap');
select pg_temp.p4s_check((select count(*) from projects.p4s_prototype_traceability(:'PA1_id') where requirement = 'Loyalty points') = 0, 'an excluded scope item is not part of the matrix');
select pg_temp.p4s_as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.p4s_check((select count(*) from projects.p4s_prototype_traceability(:'PA1_id')) = 0, 'another organisation reads no matrix');
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_red('an excluded scope item stays out of the matrix', 'projects.p4s_prototype_traceability(uuid)', $f$si.inclusion <> 'excluded'$f$, $f$true$f$,
  'select (select count(*) from projects.p4s_prototype_traceability(''' || :'PA1_id' || ''') where requirement = ''Loyalty points'') = 0');
select pg_temp.p4s_red('a screen that is not built is flagged', 'projects.p4s_prototype_traceability(uuid)', $f$then 'the screen is not built in this prototype'$f$, $f$then null$f$,
  'select (select gap from projects.p4s_prototype_traceability(''' || :'PA1_id' || ''') where screen_key = ''detail'') = ''the screen is not built in this prototype''');

-- ═══ 5. ORCH-T11: the model and tool logs are masked ═══════════════════════════
select pg_temp.p4s_as_service();
insert into ai.agent_runs (organization_id, agent_key, work_class, trigger, status, input, output, error)
  values (:'ORG', 'project_manager', 'read', 'event:p4s.test', 'failed', jsonb_build_object('prompt', 'use this key ' || pg_temp.p4s_key(), 'projectId', :'P_id', 'n', 3, 'ok', true, 'items', jsonb_build_array('a', 'password: hunter2hunter2', 'c')),
          jsonb_build_object('text', 'done'), 'the call failed with ' || pg_temp.p4s_key()) returning id \gset RUN_
select pg_temp.p4s_check((select input ->> 'prompt' from ai.agent_runs where id = :'RUN_id') = 'use this key [masked]', 'a credential in a run input is masked in the database');
select pg_temp.p4s_check((select error from ai.agent_runs where id = :'RUN_id') = 'the call failed with [masked]', 'a credential in a run error is masked');
select pg_temp.p4s_check((select input -> 'items' from ai.agent_runs where id = :'RUN_id') = '["a", "[masked]", "c"]'::jsonb, 'an array keeps its order and its other elements; a name=value credential inside one is masked');
select pg_temp.p4s_check((select input ->> 'projectId' from ai.agent_runs where id = :'RUN_id') = :'P_id' and (select (input ->> 'n')::int from ai.agent_runs where id = :'RUN_id') = 3 and (select (input ->> 'ok')::boolean from ai.agent_runs where id = :'RUN_id'), 'ids, numbers and booleans are untouched');
insert into ai.agent_steps (organization_id, run_id, seq, kind, request, response, error)
  values (:'ORG', :'RUN_id', 0, 'tool_call', jsonb_build_object('args', jsonb_build_object('token', 'Bearer abcdefghijklmnopqrstuvwxyz0123')), jsonb_build_object('body', 'ok ' || pg_temp.p4s_key()), 'x ' || pg_temp.p4s_key());
select pg_temp.p4s_check((select response ->> 'body' from ai.agent_steps where run_id = :'RUN_id') = 'ok [masked]' and (select error from ai.agent_steps where run_id = :'RUN_id') = 'x [masked]'
  and (select request::text from ai.agent_steps where run_id = :'RUN_id') not like '%abcdefghijklmnopqrstuvwxyz0123%', 'a credential in a tool request, response or error is masked');
update ai.agent_runs set output = jsonb_build_object('text', 'leaked ' || pg_temp.p4s_key()) where id = :'RUN_id';
select pg_temp.p4s_check((select output ->> 'text' from ai.agent_runs where id = :'RUN_id') = 'leaked [masked]', 'an update is masked as well as an insert');
select pg_temp.p4s_check((select output ->> 'text' from ai.agent_runs where id = :'RUN_id' and status = 'failed') is not null, 'the run is otherwise unchanged');
create or replace function pg_temp.p4s_step_masked(p_org uuid, p_run uuid) returns boolean language plpgsql as $$
declare r jsonb;
begin
  insert into ai.agent_steps (organization_id, run_id, seq, kind, response) values (p_org, p_run, 9, 'tool_call', jsonb_build_object('b', 'z ' || pg_temp.p4s_key())) returning response into r;
  return r ->> 'b' = 'z [masked]';
end $$;
grant execute on function pg_temp.p4s_step_masked(uuid, uuid) to public;
create or replace function pg_temp.p4s_run_masked(p_org uuid) returns boolean language plpgsql as $$
declare e text;
begin
  insert into ai.agent_runs (organization_id, agent_key, work_class, trigger, status, error) values (p_org, 'project_manager', 'read', 'event:p4s.red', 'failed', 'e ' || pg_temp.p4s_key()) returning error into e;
  return e = 'e [masked]';
end $$;
grant execute on function pg_temp.p4s_run_masked(uuid) to public;
select pg_temp.p4s_red('the step response is masked', 'projects.p4s_mask_agent_step()', 'new.response := projects.p4s_mask_json(new.response);', 'new.response := new.response;',
  'select pg_temp.p4s_step_masked(''' || :'ORG' || ''', ''' || :'RUN_id' || ''')');
select pg_temp.p4s_red('the run error is masked', 'projects.p4s_mask_agent_run()', 'new.error := projects.mask_secrets(new.error);', 'new.error := new.error;',
  'select pg_temp.p4s_run_masked(''' || :'ORG' || ''')');

-- ═══ 6. ORCH-026: a considered fallback is recorded ════════════════════════════
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_check(pg_temp.p4s_direct('select * from projects.p4s_record_agent_fallback(''' || :'P_id' || ''', ''ui_designer'', ''bug_fix'', ''x'')', 'authenticated') = 'refused', 'a signed-in person cannot write a fallback record: the door is the service role''s');
select pg_temp.p4s_as_service();
select pg_temp.p4s_check((select outcome from projects.p4s_record_agent_fallback(:'P_id', 'ui_designer', 'ui_designer', 'same agent')) = 'same_agent', 'a fallback onto the same agent is a retry, not a fallback');
select pg_temp.p4s_check((select outcome from projects.p4s_record_agent_fallback(gen_random_uuid(), 'ui_designer', 'ui_prototype', 'x')) = 'not_found', 'an unknown project is refused');
select pg_temp.p4s_check((select outcome from projects.p4s_record_agent_fallback(:'P_id', 'ui_designer', 'ui_prototype', 'x', '[{"code":"capability_gap","detail":"ui_prototype lacks multimodal"}]')) = 'rejected', 'a fallback with violations is recorded as rejected');
select pg_temp.p4s_check((select outcome from projects.p4s_record_agent_fallback(:'P_id', 'ui_designer', 'ui_prototype', 'x', '[{"code":"capability_gap","detail":"ui_prototype lacks multimodal"}]')) = 'already_recorded', 'a redelivered hop records the same consideration once');
select pg_temp.p4s_check((select outcome from projects.p4s_record_agent_fallback(:'P_id', 'ui_designer', 'ui_designer_two', 'a safe equal', '[]')) = 'accepted', 'a fallback with no violation is recorded as accepted');
select pg_temp.p4s_check((select count(*) from projects.fallback_records where project_id = :'P_id' and task_id is null) = 2 and (select count(*) from projects.fallback_records where project_id = :'P_id' and outcome = 'accepted') = 1, 'two rows, one accepted and one rejected, with no task');
select pg_temp.p4s_red('a rejected fallback is not recorded as accepted', 'projects.p4s_record_agent_fallback(uuid,text,text,text,jsonb,text)', $f$case when jsonb_array_length(p_violations) = 0 then 'accepted' else 'rejected' end$f$, $f$'accepted'$f$,
  'select (select outcome from projects.p4s_record_agent_fallback(''' || :'P_id' || ''', ''finance'', ''finance_close'', ''y'', ''[{"code":"tool_widened","detail":"x"}]'')) = ''rejected''');
select pg_temp.p4s_red('a redelivery is deduplicated', 'projects.p4s_record_agent_fallback(uuid,text,text,text,jsonb,text)', 'if v_id is not null then return query select ''already_recorded''::text, v_id; return; end if;', '',
  'select (select outcome from projects.p4s_record_agent_fallback(''' || :'P_id' || ''', ''ui_designer'', ''ui_prototype'', ''x'', ''[{"code":"capability_gap","detail":"d"}]'')) = ''already_recorded''');

-- ═══ 7. PM-036: a delivery can be unknown ══════════════════════════════════════
select pg_temp.p4s_as_service();
set local session_replication_role = replica;
insert into crm.contacts (organization_id, full_name, email) values (:'ORG', 'P4S Person', 'p4s-person@example.test') returning id \gset CT_
insert into crm.leads (organization_id, contact_id, title, source, source_ref, status) values (:'ORG', :'CT_id', 'P4S lead', 'email', 'p4s:1', 'new') returning id \gset LD_
insert into crm.conversations (organization_id, lead_id, contact_id, channel, external_ref, status) values (:'ORG', :'LD_id', :'CT_id', 'whatsapp', 'p4s-conv', 'active') returning id \gset CV_
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata) values (:'ORG', :'CV_id', 1, 'agent', 'one', '{"direction":"outbound","delivery":"pending"}') returning id \gset M1_
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata) values (:'ORG', :'CV_id', 2, 'agent', 'two', '{"direction":"outbound","delivery":"pending"}') returning id \gset M2_
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata) values (:'ORG', :'CV_id', 3, 'client', 'inbound', '{}') returning id \gset M3_
set local session_replication_role = origin;
create or replace function pg_temp.p4s_mark(p_id uuid, p_status text, p_note text default null) returns text language plpgsql as $$
begin return crm.mark_outbound_delivery(p_id, p_status, null, p_note)::text; exception when check_violation then return 'refused'; end $$;
grant execute on function pg_temp.p4s_mark(uuid, text, text) to public;
create or replace function pg_temp.p4s_dlv(p_id uuid) returns text language plpgsql volatile as $$ begin return (select metadata ->> 'delivery' from crm.conversation_messages where id = p_id); end $$;
grant execute on function pg_temp.p4s_dlv(uuid) to public;
select pg_temp.p4s_check(pg_temp.p4s_mark(:'M1_id', 'unknown') = 'refused', 'an unknown delivery with no note is refused: it must say why it is unknown');
select pg_temp.p4s_check(pg_temp.p4s_mark(:'M1_id', 'maybe', 'x') = 'refused', 'a status that is not sent, failed or unknown is still refused');
select pg_temp.p4s_check(pg_temp.p4s_mark(:'M1_id', 'unknown', 'WhatsApp could not be reached: the request may have gone out') = 'true' and pg_temp.p4s_dlv(:'M1_id') = 'unknown', 'a pending message becomes unknown, with the note on the record');
select pg_temp.p4s_check((select metadata ->> 'error' from crm.conversation_messages where id = :'M1_id') like 'WhatsApp could not be reached%', 'the note is kept where the failed-delivery screens read it');
select pg_temp.p4s_check(pg_temp.p4s_mark(:'M1_id', 'sent') = 'true' and pg_temp.p4s_dlv(:'M1_id') = 'sent', 'reconciled with evidence it went out: sent');
select pg_temp.p4s_check((select metadata ? 'error' from crm.conversation_messages where id = :'M1_id') is false, 'the old note is gone once it is sent');
select pg_temp.p4s_check(pg_temp.p4s_mark(:'M1_id', 'unknown', 'a late report') = 'false' and pg_temp.p4s_dlv(:'M1_id') = 'sent', 'sent stays terminal: a late unknown report cannot overturn it');
select pg_temp.p4s_check(pg_temp.p4s_mark(:'M2_id', 'unknown', 'timed out after the request was sent') = 'true' and pg_temp.p4s_mark(:'M2_id', 'failed', 'the provider confirmed it was not accepted') = 'true' and pg_temp.p4s_dlv(:'M2_id') = 'failed', 'an unknown delivery can be settled as failed');
select pg_temp.p4s_check(pg_temp.p4s_mark(:'M3_id', 'unknown', 'wrong id') = 'false' and pg_temp.p4s_dlv(:'M3_id') is null, 'a client''s own inbound message is never stamped');
select pg_temp.p4s_red('an unknown delivery can be settled', 'crm.mark_outbound_delivery(uuid,text,text,text)', $f$and metadata->>'delivery' in ('pending', 'failed', 'unknown')$f$, $f$and metadata->>'delivery' in ('pending', 'failed')$f$,
  'select (with m as (insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata) values (''' || :'ORG' || ''', ''' || :'CV_id' || ''', 9, ''agent'', ''z'', ''{"direction":"outbound","delivery":"unknown"}'') returning id) select crm.mark_outbound_delivery(m.id, ''sent'') from m)');
select pg_temp.p4s_red('an unknown delivery needs a note', 'crm.mark_outbound_delivery(uuid,text,text,text)', $f$if p_status = 'unknown' and nullif(btrim(coalesce(p_error, '')), '') is null then$f$, $f$if false then$f$,
  'select pg_temp.p4s_mark(''' || :'M3_id' || ''', ''unknown'') = ''refused''');

-- ═══ 8. FIN-042 / 057: the receipt page read ═══════════════════════════════════
select pg_temp.p4s_as_service();
set local session_replication_role = replica;
insert into finance.invoices (organization_id, client_account_id, project_id, number, kind, status, currency, subtotal_minor, tax_minor, total_minor, issued_at, due_at)
  values (:'ORG', :'A_id', :'P_id', 'ZP4S-INV-1', 'milestone', 'issued', 'INR', 100000, 0, 100000, now(), now() + interval '5 days') returning id \gset INV_
insert into finance.payments (organization_id, invoice_id, provider, provider_payment_id, amount_minor, currency, status) values (:'ORG', :'INV_id', 'manual', 'p4s-pay-1', 100000, 'INR', 'captured') returning id \gset PAY_
insert into finance.receipts (organization_id, invoice_id, payment_id, number, amount_minor, currency) values (:'ORG', :'INV_id', :'PAY_id', 'RCP-P4S-1', 100000, 'INR') returning id \gset RC_
set local session_replication_role = origin;
select pg_temp.p4s_check((select outcome from finance.p4q_record_receipt_delivery(:'RC_id', 'whatsapp', 'unknown', 'provider timed out after the send')) = 'recorded', 'fixture: a receipt delivery is recorded unknown');
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4s_check(finance.p4s_receipt_page(:'RC_id') #>> '{document,receiptNumber}' = 'RCP-P4S-1' and finance.p4s_receipt_page(:'RC_id') #>> '{deliveries,0,state}' = 'unknown'
  and finance.p4s_receipt_page(:'RC_id') #>> '{deliveries,0,channel}' = 'whatsapp', 'the page read returns the receipt document and its delivery state, unknown shown as unknown');
select pg_temp.p4s_as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.p4s_check(finance.p4s_receipt_page(:'RC_id') is null, 'another organisation reads no receipt page');
select pg_temp.p4s_as_nobody();
select pg_temp.p4s_check(finance.p4s_receipt_page(:'RC_id') is null, 'no caller reads no receipt page');
select pg_temp.p4s_as_user(:'OWNER', :'ORG', 'owner');
-- the tenant gate is held twice (this function and p4q_receipt_document), so it is tested through the page above; what only this function decides is what the delivery state says
select pg_temp.p4s_red('the page shows the delivery state as recorded, unknown is not flattened to sent', 'finance.p4s_receipt_page(uuid)', $f$'state', d.state$f$, $f$'state', 'sent'$f$,
  'select finance.p4s_receipt_page(''' || :'RC_id' || ''') #>> ''{deliveries,0,state}'' = ''unknown''');

select pg_temp.p4s_check((select count(*) from core.unguarded_org_fks()) = 0, 'every foreign key the migration added is tenancy-guarded');

rollback;
\echo 'verify-p4s-qa-pm-finance-round4: all checks passed'
