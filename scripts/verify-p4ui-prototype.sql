-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 Prototype gaps (migration 20261125100000, rows P4-PROTO-*): driven through the REAL doors, including the existing prototype QA / Admin / client
-- doors, on a scratch Postgres; rolls back. Scoped to one project of one organization.
--
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p4ui-prototype.sql
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
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.fails_with(text, text) to public;
create or replace function pg_temp.ver(p_f uuid, p_n int) returns uuid language sql as $$ select id from projects.ui_versions where phase_four_id = p_f and version = p_n $$;
grant execute on function pg_temp.ver(uuid, int) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set OWNER '00000000-0000-4000-8000-00000000f551'
\set MEMBER '00000000-0000-4000-8000-00000000f552'
\set ORG2 '00000000-0000-4000-8000-0000000000b5'
\set OWNER2 '00000000-0000-4000-8000-00000000f553'

insert into auth.users (id, email) values (:'OWNER', 'p4pr-owner@example.test'), (:'MEMBER', 'p4pr-member@example.test'), (:'OWNER2', 'p4pr-owner2@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4pr-owner@example.test', 'P4PR Owner'), (:'MEMBER', 'p4pr-member@example.test', 'P4PR Member'),
  (:'OWNER2', 'p4pr-owner2@example.test', 'P4PR Owner Two') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'MEMBER', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p4pr other org', 'zztest-p4pr-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;
insert into approvals.approval_policies (organization_id, subject_type, required_role, sla_hours, audience) values (:'ORG', 'ui_version', 'owner', 24, 'internal') on conflict do nothing;
insert into approvals.approval_policies (organization_id, subject_type, required_role, sla_hours, audience) values (:'ORG', 'deliverable', 'owner', 24, 'client') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4pr client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4pr', 'ZP4PR-1') returning id \gset P_
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'M1', 1, 50000, 'INR'), (:'ORG', :'P_id', 'M2', 2, 100000, 'INR');
set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, figma_node_id, payload, phase_four_ready, locked_at)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '1:2',
          '{"screenBaseline":{"screens":[{"screenKey":"home"},{"screenKey":"checkout"}]}}', true, now()) returning id \gset H_
set local session_replication_role = origin;

select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.start_phase_four(:'P_id')) = 'started', 'fixture: Task 2 starts');
reset role;
select id as "F_id" from projects.phase_four where project_id = :'P_id' \gset

-- ═════════ 1. a build is planned only from the EXACT LOCKED UI (P4-PROTO-002/014/018/074/075) ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_ui_version_draft(:'F_id', '[{"screenKey":"home","statesAddressed":["default"]},{"screenKey":"checkout","statesAddressed":["default"]}]')) = 'drafted', 'fixture: v1 drafted');
select outcome as o, detail as d from projects.p4ui_plan_prototype_build(pg_temp.ver(:'F_id', 1), 'web', 'in_app_preview', 'review', '{}') \gset PL_
select pg_temp.check(:'PL_o' = 'ui_not_locked' and :'PL_d' = 'draft', 'NEGATIVE: a draft UI is refused, by name');
select projects.record_ui_version_qa_verdict(pg_temp.ver(:'F_id', 1), 'qa_pass', '{}');
select outcome as o, detail as d from projects.p4ui_plan_prototype_build(pg_temp.ver(:'F_id', 1), 'web', 'in_app_preview', 'review', '{}') \gset PL_
select pg_temp.check(:'PL_o' = 'ui_not_locked' and :'PL_d' = 'qa_pass', 'NEGATIVE: a QA-passed UI is refused');
select projects.request_ui_version_admin_review(pg_temp.ver(:'F_id', 1));
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select id as "R1_id" from approvals.approval_requests where subject_type = 'ui_version' and subject_id = pg_temp.ver(:'F_id', 1) \gset
select approvals.decide_approval(:'R1_id', 'approved', 'good', null, null);
select projects.sync_ui_version_decision(pg_temp.ver(:'F_id', 1));
select outcome as o, detail as d from projects.p4ui_plan_prototype_build(pg_temp.ver(:'F_id', 1), 'web', 'in_app_preview', 'review', '{}') \gset PL_
select pg_temp.check(:'PL_o' = 'ui_not_locked' and :'PL_d' = 'admin_approved', 'NEGATIVE: an Admin-approved but not client-approved UI is refused');
select projects.share_ui_version_with_client(pg_temp.ver(:'F_id', 1), 'whatsapp:p4pr-1');
select projects.record_ui_version_client_decision(pg_temp.ver(:'F_id', 1), 'final_confirmed', 'approved', 'whatsapp:p4pr-2', null);
select pg_temp.check((select outcome from projects.lock_ui_version(pg_temp.ver(:'F_id', 1))) = 'locked', 'fixture: v1 is locked by the client');
reset role;
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_plan_prototype_build(pg_temp.ver(:'F_id', 1), 'web', 'in_app_preview', 'review', '{}')) = 'unknown_version', 'cross-tenant: another organization cannot see the UI version, so cannot plan a build from it');
reset role;
select id as "UV_id" from projects.ui_versions where phase_four_id = :'F_id' and version = 1 \gset
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_plan_prototype_build(:'UV_id', 'web', 'in_app_preview', 'review', '{}')) = 'forbidden', 'cross-tenant: even holding the id, the door answers forbidden (T005)');
reset role;

-- ═════════ 2. input validation: blockers, a failed build is a row, never a fake BUILD_READY (P4-PROTO-004/005/018/055/056/082) ═════════
select pg_temp.as_service();
set local role service_role;
select outcome as o, ref_id as b from projects.p4ui_plan_prototype_build(:'UV_id', null, 'in_app_preview', 'review',
  '{"requiredAssets":[{"name":"logo","assetId":"00000000-0000-4000-8000-0000000000aa","screens":["home"]}],"limitations":["no real payments"]}') \gset B1_
select pg_temp.check(:'B1_o' = 'planned', 'a build is planned with its plan recorded before review');
select pg_temp.check((select outcome from projects.p4ui_plan_prototype_build(:'UV_id', 'web', 'in_app_preview', 'review', '{}')) = 'exists', 'a second plan for the same UI returns the active build: no duplicate');
select pg_temp.check((select outcome from projects.p4ui_plan_prototype_build(:'UV_id', 'amiga', 'in_app_preview', 'review', '{}')) = 'bad_platform', 'an unknown platform is refused');
select outcome as o, detail as d from projects.p4ui_validate_build_inputs(:'B1_b') \gset V1_
select pg_temp.check(:'V1_o' = 'blocked', 'validation finds the build blocked');
select pg_temp.check((select d like '%asset_missing%' and d like '%platform_missing%' from (select :'V1_d'::text as d) x), 'by a missing platform and a missing asset (no inferred behaviour)');
select pg_temp.check((select status = 'blocked' from projects.p4ui_prototype_builds where id = :'B1_b'), 'the build row is BLOCKED');
select pg_temp.check(exists (select 1 from projects.p4ui_prototype_blockers where build_id = :'B1_b' and kind = 'asset_missing' and affected_screens = array['home'] and owner_role = 'designer' and not external), 'the asset blocker names the affected screen and an owner');
select pg_temp.check((select outcome from projects.p4ui_resolve_prototype_blocker((select id from projects.p4ui_prototype_blockers where build_id = :'B1_b' and kind = 'platform_missing'), 'x')) = 'person_required', 'NEGATIVE: an agent cannot clear a prototype blocker');
select pg_temp.check((select outcome from projects.p4ui_fail_build(:'B1_b', 'cannot proceed without the logo asset')) = 'failed', 'the build is failed with a reason');
select pg_temp.check((select status = 'failed' and failure_reason like 'cannot proceed%' and prototype_artifact_id is null from projects.p4ui_prototype_builds where id = :'B1_b'), 'FAILED is persisted with its reason; no artifact, no BUILD_READY');
select pg_temp.check((select outcome from projects.p4ui_fail_build(:'B1_b', 'again')) = 'already_failed', 'a replayed failure is idempotent');
select pg_temp.check(pg_temp.fails_with($q$update projects.p4ui_prototype_builds set status = 'build_ready' where id = '$q$ || :'B1_b' || $q$'$q$, '23514'), 'NEGATIVE: a failed build cannot be moved to BUILD_READY');

-- production-logic requests are blockers, not invented behaviour (P4-PROTO-007)
select pg_temp.check((select outcome from projects.p4ui_report_prototype_request(:'B1_b', 'production_logic', 'make the payment actually charge the card')) = 'opened', 'a production-logic request becomes a blocker');
select pg_temp.check(exists (select 1 from projects.p4ui_prototype_blockers where build_id = :'B1_b' and kind = 'production_logic_request' and status = 'open'), 'recorded as production_logic_request');

-- round 2: a corrected plan (approved placeholder) and native package honesty
select outcome as o, ref_id as b from projects.p4ui_plan_prototype_build(:'UV_id', 'web', 'in_app_preview', 'review',
  '{"requiredAssets":[{"name":"logo","placeholderApproved":true,"screens":["home"]}],"limitations":["no real payments","sign-in is simulated"],"simulatedIntegrations":["payment gateway","sign-in"],"criticalFlows":[["home","checkout"]],"testInstructions":"Open home, press Checkout, press Back."}') \gset B2_
select pg_temp.check(:'B2_o' = 'planned', 'a failed build does not block a corrected plan');
select pg_temp.check((select build_number = 2 and revision_of_build_id = :'B1_b' from projects.p4ui_prototype_builds where id = :'B2_b'), 'build 2 records that it follows build 1');
select pg_temp.check((select outcome from projects.p4ui_validate_build_inputs(:'B2_b')) = 'ready', 'validation passes with the approved placeholder');
select pg_temp.check((select status = 'building' from projects.p4ui_prototype_builds where id = :'B2_b'), 'build 2 is BUILDING');
select outcome as o, ref_id as r from projects.p4ui_record_build_artifact(:'B2_b', 'android_apk', 's3://bucket/app.apk', repeat('a', 64), 'uploaded') \gset AP_
select pg_temp.check(:'AP_o' = 'environment_missing', 'an agent claiming an APK is uploaded gets environment_missing instead');
select pg_temp.check((select upload_status = 'environment_missing' and failure_reason is not null from projects.p4ui_artifact_records where id = :'AP_r'), 'the row says why');
select pg_temp.check(exists (select 1 from projects.p4ui_prototype_blockers where build_id = :'B2_b' and kind = 'credential_missing' and external and status = 'open'), 'and an EXTERNAL credential blocker is open: owner accounts are needed');
select pg_temp.check(pg_temp.fails_with($q$insert into projects.p4ui_artifact_records (organization_id, project_id, build_id, kind, storage_ref, upload_status) values ('$q$ || :'ORG' || $q$', '$q$ || :'P_id' || $q$', '$q$ || :'B2_b' || $q$', 'ios_package', 'x', 'uploaded')$q$, '23514'), 'NEGATIVE: a native package cannot be uploaded without a hash, even by direct insert');

-- test data
select pg_temp.check((select outcome from projects.p4ui_record_test_data(:'B2_b', 'sample cart', '{"items":[{"sku":"A1","qty":2}]}', false, 'happy path')) = 'recorded', 'mock test data is recorded');
select pg_temp.check((select outcome from projects.p4ui_record_test_data(:'B2_b', 'empty cart', '{"items":[]}', true)) = 'recorded', 'and an edge case');
select pg_temp.check((select outcome from projects.p4ui_record_test_data(:'B2_b', 'bad', '{"apiKey":"sk_live_abcdefghijklmnop"}')) = 'secret_detected', 'NEGATIVE: a secret-shaped value is refused');
select pg_temp.check((select outcome from projects.p4ui_record_test_data(:'B2_b', 'bad2', '{"password":"hunter2hunter2"}')) = 'secret_detected', 'NEGATIVE: a credential-shaped field is refused');
select pg_temp.check((select outcome from projects.p4ui_record_test_data(:'B2_b', 'sample cart', '{"items":[]}')) = 'exists', 'a replay is idempotent');
select pg_temp.check(pg_temp.fails_with($q$update projects.p4ui_test_data set is_mock = false where build_id = '$q$ || :'B2_b' || $q$'$q$, '23514'), 'mock data cannot be relabelled as production data');

-- ═════════ 3. the artifact: coverage self-check, BUILD_READY (P4-PROTO-011/031/040/056/061) ═════════
select outcome as o, prototype_artifact_id as a, deliverable_id as d from projects.record_prototype_build(:'UV_id', '[{"screenKey":"home","elements":[{"type":"button","label":"Checkout","navigatesTo":"ghost"}]},{"screenKey":"extra_screen","elements":[{"type":"text","label":"Surprise"}]}]') \gset A1_
select pg_temp.check(:'A1_o' = 'built', 'the Prototype Agent records a flawed artifact (A1) through the existing door');
select pg_temp.check((select outcome from projects.p4ui_attach_build_artifact(:'B2_b', (select id from projects.prototype_artifacts limit 0))) = 'unknown_artifact', 'an unknown artifact is refused');
select outcome as o, detail as d from projects.p4ui_attach_build_artifact(:'B2_b', :'A1_a') \gset AT1_
select pg_temp.check(:'AT1_o' = 'self_check_failed', 'the build fails its OWN coverage self-check');
select pg_temp.check((select string_agg(coverage, ',' order by coverage) from projects.p4ui_route_coverage where build_id = :'B2_b') = 'broken_target,extra_placeholder,missing', 'coverage: checkout missing, extra_screen is a placeholder the UI does not have, home has a broken target');
select pg_temp.check((select status = 'failed' from projects.p4ui_prototype_builds where id = :'B2_b'), 'so it is FAILED, not BUILD_READY');
select pg_temp.check(exists (select 1 from projects.p4ui_prototype_blockers where build_id = :'B2_b' and kind = 'build_failure' and owner_role = 'prototype_agent'), 'with a build_failure blocker owned by the Prototype Agent');
select pg_temp.check((select eligible from projects.p4ui_build_share_eligibility(:'B2_b')) = false, 'and it is not share-eligible');

-- QA finds the flaws; the Prototype Agent builds a corrected round
select projects.record_prototype_qa_verdict(:'A1_a', 'qa_changes_required', '[{"defect":"checkout missing; ghost route"}]');
select outcome as o, prototype_artifact_id as a, deliverable_id as d from projects.revise_prototype_build(:'UV_id', '[{"screenKey":"home","elements":[{"type":"button","label":"Checkout","navigatesTo":"checkout"}]},{"screenKey":"checkout","elements":[{"type":"button","label":"Back","navigatesTo":"home"},{"type":"input","label":"Card"}]}]') \gset A2_
select pg_temp.check(:'A2_o' = 'revised', 'fixture: a corrected artifact A2 (existing door)');
select outcome as o, ref_id as b from projects.p4ui_plan_prototype_build(:'UV_id', 'web', 'in_app_preview', 'review',
  '{"limitations":["no real payments","sign-in is simulated"],"simulatedIntegrations":["payment gateway","sign-in"],"criticalFlows":[["home","checkout"]],"testInstructions":"Open home, press Checkout, press Back."}') \gset B3_
select pg_temp.check(:'B3_o' = 'planned', 'build 3 is planned');
select pg_temp.check((select outcome from projects.p4ui_validate_build_inputs(:'B3_b')) = 'ready', 'and validated');
select pg_temp.check((select outcome from projects.p4ui_record_build_revision(:'B3_b')) = 'recorded', 'its revision record is derived');
select pg_temp.check((select r.origin = 'qa_defect' and r.evidence -> 'qaFindings' -> 0 ->> 'defect' like 'checkout missing%' and r.from_build_id = :'B2_b' from projects.p4ui_prototype_revisions r where r.to_build_id = :'B3_b'),
  'the revision: origin qa_defect, the QA finding is the evidence, from build 2 to build 3');
select pg_temp.check((select outcome from projects.p4ui_attach_build_artifact(:'B3_b', :'A1_a')) = 'artifact_already_attached', 'NEGATIVE: an artifact cannot belong to two builds');
select pg_temp.check((select outcome from projects.p4ui_attach_build_artifact(:'B3_b', :'A2_a')) = 'build_ready', 'build 3 passes its self-check: BUILD_READY');
select pg_temp.check((select count(*) filter (where coverage = 'covered') = 2 and count(*) = 2 from projects.p4ui_route_coverage where build_id = :'B3_b'), 'coverage: both locked screens covered, per screen');
select pg_temp.check((select outcome from projects.p4ui_attach_build_artifact(:'B3_b', :'A2_a')) = 'already_attached', 'a replayed attach is a no-op');

-- ═════════ 4. QA handoff package (P4-PROTO-023) ═════════
select pg_temp.check((select outcome from projects.p4ui_assemble_qa_handoff(:'B2_b')) = 'not_build_ready', 'NEGATIVE: no handoff for a build that is not BUILD_READY');
select outcome as o from projects.p4ui_record_build_artifact(:'B3_b', 'hosted_url', 'https://preview.example.test/b3', null, 'failed', 'upload timed out') \gset U1_
select pg_temp.check((select outcome from projects.p4ui_assemble_qa_handoff(:'B3_b')) = 'artifact_upload_failed', 'NEGATIVE: a failed artifact upload blocks the handoff and share eligibility');
select pg_temp.check((select eligible = false and 'an artifact upload failed or is pending' = any (reasons) from projects.p4ui_build_share_eligibility(:'B3_b')), 'and the eligibility says why');
select pg_temp.check((select outcome from projects.p4ui_record_build_artifact(:'B3_b', 'hosted_url', 'https://preview.example.test/b3', null, 'uploaded')) in ('recorded', 'exists'), 'the upload is retried');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as o, detail as d from projects.p4ui_assemble_qa_handoff(:'B3_b') \gset AH_
\echo AH :AH_o :AH_d
select pg_temp.check(:'AH_o' = 'assembled', 'a person can assemble the handoff');
reset role;
select package::text as pk from projects.p4ui_qa_handoffs where build_id = :'B3_b' \gset
\echo :pk
select pg_temp.check((select package ->> 'sourceUiVersionId' = :'UV_id' and package -> 'limitations' @> '["no real payments"]'::jsonb and jsonb_array_length(package -> 'coverage') = 2 and package ->> 'testInstructions' is not null
   from projects.p4ui_qa_handoffs where build_id = :'B3_b'), 'the package carries the source UI, platform, coverage, flows, limitations and test instructions');
select pg_temp.check((select status = 'qa_review' from projects.p4ui_prototype_builds where id = :'B3_b'), 'the build is in QA_REVIEW');
select pg_temp.check(pg_temp.fails_with($q$update projects.p4ui_qa_handoffs set package = '{}' where build_id = '$q$ || :'B3_b' || $q$'$q$, '23001'), 'the package is immutable');

-- ═════════ 5. the build follows the real gates and cannot pass them itself (P4-PROTO-024/029/049/088) ═════════
select pg_temp.check(pg_temp.fails_with($q$update projects.p4ui_prototype_builds set status = 'qa_pass' where id = '$q$ || :'B3_b' || $q$'$q$, '23514'), 'NEGATIVE: the build cannot be moved to qa_pass without Prototype QA''s verdict on the artifact');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_sync_build_status(:'B3_b')) = 'unchanged', 'sync before any verdict changes nothing');
select projects.record_prototype_qa_verdict(:'A2_a', 'qa_pass', '[]');
select pg_temp.check((select outcome from projects.p4ui_sync_build_status(:'B3_b')) = 'synced', 'after Prototype QA passes the artifact, sync follows it');
select pg_temp.check((select status = 'qa_pass' from projects.p4ui_prototype_builds where id = :'B3_b'), 'the build is qa_pass because QA said so');
select pg_temp.check((select eligible from projects.p4ui_build_share_eligibility(:'B3_b')), 'and it is share-eligible once nothing else is open');
reset role;
select pg_temp.check(pg_temp.fails_with($q$update projects.p4ui_prototype_builds set status = 'locked' where id = '$q$ || :'B3_b' || $q$'$q$, '23514'), 'NEGATIVE: nobody can jump the build to locked');
select pg_temp.check(pg_temp.fails_with($q$update projects.p4ui_prototype_builds set status = 'admin_approved' where id = '$q$ || :'B3_b' || $q$'$q$, '23514'), 'NEGATIVE: nor to admin_approved before an Admin approved the deliverable');

select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.decide_prototype_admin(:'A2_d', 'approved', 'ok')) = 'decided', 'the Admin approves build 3''s deliverable (existing door)');
select outcome as o from projects.p4ui_sync_build_status(:'B3_b') \gset SY_
select pg_temp.check(:'SY_o' = 'synced' and (select status from projects.p4ui_prototype_builds where id = :'B3_b') = 'admin_approved', 'the build reflects admin_approved');
select pg_temp.check((select outcome from projects.send_prototype_for_client_review(:'A2_d', null, 'build 3')) = 'submitted', 'the PM shares the exact build (existing door)');
select outcome as o from projects.p4ui_sync_build_status(:'B3_b') \gset SY_
select pg_temp.check(:'SY_o' = 'synced' and (select status from projects.p4ui_prototype_builds where id = :'B3_b') = 'client_review', 'the build reflects client_review');
reset role;
select pg_temp.check(pg_temp.fails_with($q$update projects.p4ui_prototype_builds set status = 'locked' where id = '$q$ || :'B3_b' || $q$'$q$, '23514'), 'NEGATIVE: a build in client review cannot be locked until the client''s approval exists (the gate, not just the edge)');
set local role authenticated;
select projects.p4ui_prototype_client_notice(:'A2_d') as notice \gset
select pg_temp.check((select (:'notice'::jsonb ->> 'label') like '%simulated data and a simulated sign-in%' and (:'notice'::jsonb -> 'limitations') @> '["sign-in is simulated"]'::jsonb), 'the client view carries the simulated/not-production label and the limitations');
select id as "RB_id" from approvals.approval_requests where subject_type = 'deliverable' and subject_id = :'A2_d' \gset
select approvals.decide_approval(:'RB_id', 'changes_requested', 'please add a loyalty-points screen', 'whatsapp:p4pr-9', null);
select projects.sync_deliverable_decision(:'A2_d');
reset role;

-- ═════════ 6. the client asks for a NEW FEATURE: not implemented in the prototype (P4-PROTO-027/086) ═════════
select pg_temp.as_service();
set local role service_role;
select outcome as o from projects.p4ui_sync_build_status(:'B3_b') \gset SY_
select pg_temp.check(:'SY_o' = 'synced' and (select status from projects.p4ui_prototype_builds where id = :'B3_b') = 'changes_requested', 'the build reflects the client''s changes_requested');
select outcome as o, route as r from projects.p4ui_route_prototype_feedback(:'A2_d', 'POSSIBLE_SCOPE_CHANGE', 'a loyalty screen is new scope') \gset RT_
select pg_temp.check(:'RT_o' = 'routed' and :'RT_r' = 'change_request', 'a new-feature ask routes to a Change Request');
select pg_temp.check((select state from projects.phase_four where id = :'F_id') = 'scope_escalation', 'and the workspace stops at scope_escalation');
select pg_temp.check((select outcome from projects.p4ui_route_prototype_feedback(:'A2_d', 'CORRECTION', 'x')) = 'already_routed', 'a deliverable is classified once');
select outcome as o, prototype_artifact_id as a, deliverable_id as d from projects.revise_prototype_build(:'UV_id', '[{"screenKey":"home","elements":[{"type":"button","label":"Checkout","navigatesTo":"checkout"}]},{"screenKey":"checkout","elements":[{"type":"button","label":"Back","navigatesTo":"home"}]}]') \gset A3_
select outcome as o, ref_id as b from projects.p4ui_plan_prototype_build(:'UV_id', 'web', 'in_app_preview', 'review', '{"limitations":["no real payments"]}') \gset B4_
select pg_temp.check(:'B4_o' = 'planned' and (select status from projects.p4ui_prototype_builds where id = :'B3_b') = 'superseded', 'planning the next round supersedes the build that was sent back');
select pg_temp.check((select outcome from projects.p4ui_record_build_revision(:'B4_b')) = 'not_a_prototype_revision', 'NEGATIVE: the new feature is not built - the revision record refuses a scope-change round');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_resolve_prototype_blocker((select id from projects.p4ui_prototype_blockers where kind = 'scope_change' and status = 'open' and project_id = :'P_id'), 'client dropped the loyalty screen')) = 'resolved', 'a person clears the scope question');
select pg_temp.check((select state from projects.phase_four where id = :'F_id') = 'prototype_build', 'and the Prototype stage continues');
select pg_temp.check((select outcome from projects.p4ui_resolve_prototype_blocker((select id from projects.p4ui_prototype_blockers where build_id = :'B2_b' and kind = 'credential_missing'), 'owner provides accounts')) = 'resolved', 'the Admin clears the external credential blocker');
reset role;
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_open_prototype_blocker(:'UV_id', 'credential_missing', 'owner', 'Apple developer account needed', 'owner supplies it', :'B4_b', true)) = 'opened', 'a member opens an external blocker');
select pg_temp.check((select outcome from projects.p4ui_resolve_prototype_blocker((select id from projects.p4ui_prototype_blockers where build_id = :'B4_b' and kind = 'credential_missing'), 'ok')) = 'admin_required', 'NEGATIVE: a member cannot clear an external credential blocker');
reset role;

-- ═════════ 7. client correction round: a classified correction is built, with the client''s words as evidence (P4-PROTO-033/046) ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_validate_build_inputs(:'B4_b')) is not null, 'build 4 validation runs');
select pg_temp.check((select status from projects.p4ui_prototype_builds where id = :'B4_b') = 'blocked', 'build 4 is blocked by the open credential blocker a member raised');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select projects.p4ui_resolve_prototype_blocker((select id from projects.p4ui_prototype_blockers where build_id = :'B4_b' and kind = 'credential_missing' and status = 'open'), 'build as an in-app preview');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select status from projects.p4ui_prototype_builds where id = :'B4_b') = 'input_validation', 'resolving the last blocker returns the build to input validation');
select pg_temp.check((select outcome from projects.p4ui_validate_build_inputs(:'B4_b')) = 'ready', 'and it validates');
select pg_temp.check((select outcome from projects.p4ui_attach_build_artifact(:'B4_b', :'A3_a')) = 'build_ready', 'build 4 attaches artifact A3: BUILD_READY');
select pg_temp.check((select outcome from projects.p4ui_record_test_data(:'B4_b', 'cart', '{"items":[]}')) = 'recorded', 'test data on build 4');
select pg_temp.check((select outcome from projects.p4ui_assemble_qa_handoff(:'B4_b')) = 'assembled', 'handoff assembled for build 4');
select projects.record_prototype_qa_verdict(:'A3_a', 'qa_pass', '[]');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select projects.decide_prototype_admin(:'A3_d', 'approved', 'ok');
select projects.send_prototype_for_client_review(:'A3_d', null, 'build 4');
select id as "RC_id" from approvals.approval_requests where subject_type = 'deliverable' and subject_id = :'A3_d' \gset
select approvals.decide_approval(:'RC_id', 'changes_requested', 'the checkout button should be green', 'whatsapp:p4pr-11', null);
select projects.sync_deliverable_decision(:'A3_d');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_route_prototype_feedback(:'A3_d', 'CORRECTION', 'a colour correction is included')) = 'routed', 'the PM classifies the second client round as a correction');
select outcome as o from projects.p4ui_sync_build_status(:'B4_b') \gset SY4_
select outcome as o from projects.revise_prototype_build(:'UV_id', '[{"screenKey":"home","elements":[{"type":"button","label":"Checkout","navigatesTo":"checkout"}]},{"screenKey":"checkout","elements":[{"type":"button","label":"Back","navigatesTo":"home"}]}]') \gset A4_
select outcome as o, ref_id as b from projects.p4ui_plan_prototype_build(:'UV_id', 'web', 'in_app_preview', 'review', '{"limitations":["no real payments"]}') \gset B5_
select pg_temp.check(:'A4_o' = 'revised' and :'B5_o' = 'planned', 'a corrected round is revised and planned');
select outcome as o, detail as d from projects.p4ui_record_build_revision(:'B5_b') \gset RV_
select pg_temp.check(:'RV_o' = 'recorded' and :'RV_d' = 'client_change', 'the revision: origin client_change');
select pg_temp.check((select r.evidence ->> 'clientWords' = 'the checkout button should be green' and r.evidence ->> 'classification' = 'CORRECTION' from projects.p4ui_prototype_revisions r where r.to_build_id = :'B5_b'), 'with the client''s own words and the PM''s classification as evidence');
reset role;
select pg_temp.check((select count(*) from projects.p4ui_prototype_builds where project_id = :'P_id') = 5, 'five build rows exist for the project (history is never overwritten)');
select pg_temp.check((select string_agg(status, ',' order by build_number) from projects.p4ui_prototype_builds where project_id = :'P_id') like 'failed,failed,superseded,%', 'old builds keep their final status: failed, failed, superseded');

-- ═════════ 8. tenancy and read boundary ═════════
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p4ui_prototype_builds where project_id = :'P_id') = 0, 'cross-tenant: builds are invisible');
select pg_temp.check((select count(*) from projects.p4ui_route_coverage where project_id = :'P_id') = 0 and (select count(*) from projects.p4ui_prototype_blockers where project_id = :'P_id') = 0, 'cross-tenant: coverage and blockers are invisible');
select pg_temp.check((select projects.p4ui_prototype_client_notice(:'A2_d')) is null, 'cross-tenant: the client notice is null for a deliverable of another organization');
select pg_temp.check((select outcome from projects.p4ui_record_test_data(:'B4_b', 'x', '{}')) = 'forbidden', 'cross-tenant: nor can they write test data');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.fails_with($q$insert into projects.p4ui_prototype_builds (organization_id, project_id, phase_four_id, ui_version_id, build_number) values ('$q$ || :'ORG' || $q$', '$q$ || :'P_id' || $q$', '$q$ || :'F_id' || $q$', '$q$ || :'UV_id' || $q$', 99)$q$, '42501'), 'NEGATIVE: no write policy - a raw insert is refused; the door is the only way in');
reset role;
select pg_temp.check((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'projects' and c.relname = any (array['p4ui_prototype_builds','p4ui_route_coverage','p4ui_test_data','p4ui_artifact_records','p4ui_prototype_blockers','p4ui_prototype_revisions','p4ui_prototype_feedback_routes','p4ui_qa_handoffs'])
    and t.tgname like 'freeze\_org\_%') = 8, 'all eight prototype tables carry freeze_organization_id');

rollback;
\echo 'verify-p4ui-prototype: PASS'
