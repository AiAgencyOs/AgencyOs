-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 UI Designer and Prototype, round 4 (migration 20261201000000; docs/phase-4-ui-prototype-round4-log.md): driven through the REAL doors, including the
-- existing Prototype QA / Admin / client doors, on a scratch Postgres; rolls back. Scoped to one project of one organization. Helper names are prefixed p4r_.
--
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p4r-ui-prototype.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.p4r_check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.p4r_check(boolean, text) to public;
create or replace function pg_temp.p4r_as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.p4r_as_user(uuid, uuid, text) to public;
create or replace function pg_temp.p4r_as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.p4r_as_service() to public;
create or replace function pg_temp.p4r_fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.p4r_fails_with(text, text) to public;
create or replace function pg_temp.p4r_ver(p_f uuid, p_n int) returns uuid language sql as $$ select id from projects.ui_versions where phase_four_id = p_f and version = p_n $$;
grant execute on function pg_temp.p4r_ver(uuid, int) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set OWNER '00000000-0000-4000-8000-00000000f651'
\set MEMBER '00000000-0000-4000-8000-00000000f652'
\set ORG2 '00000000-0000-4000-8000-0000000000b6'
\set OWNER2 '00000000-0000-4000-8000-00000000f653'

insert into auth.users (id, email) values (:'OWNER', 'p4r-owner@example.test'), (:'MEMBER', 'p4r-member@example.test'), (:'OWNER2', 'p4r-owner2@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4r-owner@example.test', 'P4R Owner'), (:'MEMBER', 'p4r-member@example.test', 'P4R Member'),
  (:'OWNER2', 'p4r-owner2@example.test', 'P4R Owner Two') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'MEMBER', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p4r other org', 'zztest-p4r-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;
insert into approvals.approval_policies (organization_id, subject_type, required_role, sla_hours, audience) values (:'ORG', 'ui_version', 'owner', 24, 'internal') on conflict do nothing;
insert into approvals.approval_policies (organization_id, subject_type, required_role, sla_hours, audience) values (:'ORG', 'deliverable', 'owner', 24, 'client') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4r client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4r', 'ZP4R-1') returning id \gset P_
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'M1', 1, 50000, 'INR'), (:'ORG', :'P_id', 'M2', 2, 100000, 'INR');
set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, figma_node_id, payload, phase_four_ready, locked_at)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '1:2',
          '{"screenBaseline":{"screens":[{"screenKey":"home"},{"screenKey":"checkout"}]},"colors":{"primaryHex":"#112233","accentHex":"#445566"},"tokens":{"fontFamilyHeading":"Inter","baseSpacingPx":8,"radiusStyle":"soft"}}',
          true, now()) returning id \gset H_
set local session_replication_role = origin;

select pg_temp.p4r_as_service();
set local role service_role;
select pg_temp.p4r_check((select outcome from projects.start_phase_four(:'P_id')) = 'started', 'fixture: Task 2 starts');
reset role;
select id as "F_id" from projects.phase_four where project_id = :'P_id' \gset

-- ═════════ 1. Designer planning and brand inputs (P4-UID-015/016) and the design-side asset-missing path (P4-UID-057) ═════════
select pg_temp.p4r_as_service();
set local role service_role;
select pg_temp.p4r_check((select outcome from projects.p4r_record_design_inputs(:'F_id', '[]', '{}', '{}', 'x')) = 'person_required', 'NEGATIVE: an agent does not invent the Designer''s inputs');
reset role;
select pg_temp.p4r_as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select outcome as o, ref_id as r, detail as d from projects.p4r_record_design_inputs(:'F_id',
  '[{"name":"client logo (SVG)"},{"name":"brand pattern","placeholderApproved":true}]', array['wcag_aa','keyboard_only'], array['mobile','desktop'], 'Mobile first; the client is a clinic chain.') \gset DI_
select pg_temp.p4r_check(:'DI_o' = 'recorded' and :'DI_d' = '1', 'a person records brand assets, accessibility and device targets and a planning note; one asset is neither stored nor a placeholder');
select pg_temp.p4r_check(exists (select 1 from projects.p4ui_design_blockers where phase_four_id = :'F_id' and kind = 'asset_missing' and status = 'open' and owner_role = 'designer' and reason like '%client logo%'),
  'that asset opens a design asset_missing blocker with an owner and a resume condition');
select pg_temp.p4r_check(not exists (select 1 from projects.p4ui_design_blockers where phase_four_id = :'F_id' and reason like '%brand pattern%'), 'the asset with an approved placeholder opens nothing');
select pg_temp.p4r_check((select outcome from projects.p4r_record_design_inputs(:'F_id', '[]', array['wcag_zz'], '{}', null)) = 'bad_inputs', 'NEGATIVE: an accessibility target outside the vocabulary is refused');
select pg_temp.p4r_check((select outcome from projects.p4r_record_design_inputs(:'F_id', '[]', '{}', array['watch'], null)) = 'bad_inputs', 'NEGATIVE: a device outside the vocabulary is refused');
select pg_temp.p4r_check((select outcome from projects.p4r_record_design_inputs(:'F_id', '[{"placeholderApproved":true}]', '{}', '{}', null)) = 'bad_brand_assets', 'NEGATIVE: a brand asset with no name is refused');
select pg_temp.p4r_check((select outcome from projects.p4r_record_design_inputs(:'F_id', '[{"name":"logo","placeholderApproved":true}]', array['wcag_aa'], array['mobile'], 'v2')) = 'recorded', 'recording again is accepted');
select pg_temp.p4r_check((select revision = 2 and brand_assets -> 0 ->> 'name' = 'logo' from projects.p4r_design_inputs where phase_four_id = :'F_id') and (select count(*) = 1 from projects.p4r_design_inputs where phase_four_id = :'F_id'),
  'and it replaces the one row for the workspace and counts the revision');
select pg_temp.p4r_check((select planning_note from projects.p4r_design_inputs where phase_four_id = :'F_id') = 'v2', 'the row carries the latest planning note');
reset role;
select pg_temp.p4r_as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.p4r_check((select outcome from projects.p4r_record_design_inputs(:'F_id', '[]', '{}', '{}', null)) = 'forbidden', 'cross-tenant: another organization cannot record inputs for this workspace');
select pg_temp.p4r_check((select count(*) from projects.p4r_design_inputs) = 0, 'cross-tenant: the inputs are invisible');
reset role;

-- ═════════ 2. draft v1; Design QA token consistency (P4-UID-021) ═════════
select pg_temp.p4r_as_service();
set local role service_role;
select pg_temp.p4r_check((select outcome from projects.record_ui_version_draft(:'F_id', '[{"screenKey":"home","statesAddressed":["default"]},{"screenKey":"checkout","statesAddressed":["default"]}]')) = 'drafted', 'fixture: v1 drafted');
select pg_temp.p4r_check((select outcome from projects.p4r_check_token_consistency(pg_temp.p4r_ver(:'F_id', 1))) = 'no_specs', 'with no screen spec naming a token there is nothing to check, and it says so');
select pg_temp.p4r_check((select outcome from projects.p4ui_record_screen_spec(pg_temp.p4r_ver(:'F_id', 1), 'home',
  '{"purpose":"Browse","tokensUsed":["color.primary","color.warning","#FF0000","gradient.fancy"],"states":["default"],"responsiveVariants":["mobile"]}')) in ('recorded', 'updated'), 'fixture: the home spec names two sound tokens and three that are not');
select pg_temp.p4r_check((select outcome from projects.p4ui_record_screen_spec(pg_temp.p4r_ver(:'F_id', 1), 'checkout',
  '{"purpose":"Pay","tokensUsed":["spacing.base","radius.card","typography.body","Color.Accent"],"validationRules":["card number is 16 digits"]}')) in ('recorded', 'updated'), 'fixture: the checkout spec');
select outcome as o, detail as d from projects.p4r_check_token_consistency(pg_temp.p4r_ver(:'F_id', 1)) \gset TK_
select pg_temp.p4r_check(:'TK_o' = 'inconsistent' and :'TK_d' = '4', 'four inconsistent tokens are found: an undefined colour, a raw hex, an unknown token and a primitive the direction does not define');
select pg_temp.p4r_check(exists (select 1 from projects.p4ui_qa_defects where ui_version_id = pg_temp.p4r_ver(:'F_id', 1) and description like '%#FF0000%raw value, not a token%')
  and exists (select 1 from projects.p4ui_qa_defects where ui_version_id = pg_temp.p4r_ver(:'F_id', 1) and description like '%gradient.fancy%is not a token of the locked direction%'), 'a raw hex is called a raw value (a second design system) and an invented name is called not a token');
select pg_temp.p4r_check((select count(*) = 4 and bool_and(category = 'token' and status = 'open') from projects.p4ui_qa_defects where ui_version_id = pg_temp.p4r_ver(:'F_id', 1)), 'each is a token QA defect on the version');
select pg_temp.p4r_check((select string_agg(screen_key, ',' order by screen_key) from projects.p4ui_qa_defects where ui_version_id = pg_temp.p4r_ver(:'F_id', 1)) = 'checkout,home,home,home', 'on the right screens (home x3, checkout x1)');
select pg_temp.p4r_check(not exists (select 1 from projects.p4ui_qa_defects where ui_version_id = pg_temp.p4r_ver(:'F_id', 1) and (description like '%color.primary%' or description like '%spacing.base%' or description like '%radius.card%' or description like '%Color.Accent%')),
  'the tokens the direction does define (primary, accent in any case, spacing, radius) raise nothing');
select pg_temp.p4r_check((select detail from projects.p4r_check_token_consistency(pg_temp.p4r_ver(:'F_id', 1))) = '4' and (select count(*) from projects.p4ui_qa_defects where ui_version_id = pg_temp.p4r_ver(:'F_id', 1)) = 4, 'running it again adds no defect');
reset role;
select pg_temp.p4r_as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.p4r_check((select outcome from projects.p4r_check_token_consistency(pg_temp.p4r_ver(:'F_id', 1))) = 'forbidden' or (select outcome from projects.p4r_check_token_consistency(pg_temp.p4r_ver(:'F_id', 1))) = 'unknown_version', 'cross-tenant: another organization cannot run it');
reset role;

-- ═════════ 3. a revision that changes nothing is not a version (P4-UID-054) ═════════
select pg_temp.p4r_as_service();
set local role service_role;
select projects.record_ui_version_qa_verdict(pg_temp.p4r_ver(:'F_id', 1), 'qa_changes_required', '{"missingScreens":[],"stateGaps":[]}');
select pg_temp.p4r_check((select outcome from projects.revise_ui_version(:'F_id', '[{"screenKey":"home","statesAddressed":["default"]},{"screenKey":"checkout","statesAddressed":["default"]}]')) = 'no_content_change',
  'NEGATIVE: the Designer returns the same screens: the door refuses a new version');
select pg_temp.p4r_check((select count(*) from projects.ui_versions where phase_four_id = :'F_id') = 1 and (select ui_qa_fix_count from projects.phase_four where id = :'F_id') = 0, 'and no version exists, and no QA-fix round was spent');
select pg_temp.p4r_check((select outcome from projects.revise_ui_version(:'F_id', '[{"screenKey":"checkout","statesAddressed":["default","error"]},{"screenKey":"home","statesAddressed":["default","error","loading"]}]')) = 'revised',
  'POSITIVE twin: the same screens in another order are a different document, so a real revision is not mistaken for none');
select pg_temp.p4r_check((select count(*) from projects.ui_versions where phase_four_id = :'F_id') = 2, 'v2 exists');
reset role;

-- v2 goes through Design QA, Admin review, the client, and the lock
select pg_temp.p4r_as_service();
set local role service_role;
select projects.record_ui_version_qa_verdict(pg_temp.p4r_ver(:'F_id', 2), 'qa_pass', '{}');
select projects.request_ui_version_admin_review(pg_temp.p4r_ver(:'F_id', 2));
reset role;
select pg_temp.p4r_as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select id as "R1_id" from approvals.approval_requests where subject_type = 'ui_version' and subject_id = pg_temp.p4r_ver(:'F_id', 2) \gset
select approvals.decide_approval(:'R1_id', 'approved', 'good', null, null);
select projects.sync_ui_version_decision(pg_temp.p4r_ver(:'F_id', 2));
select projects.share_ui_version_with_client(pg_temp.p4r_ver(:'F_id', 2), 'whatsapp:p4r-1');
select projects.record_ui_version_client_decision(pg_temp.p4r_ver(:'F_id', 2), 'final_confirmed', 'approved', 'whatsapp:p4r-2', null);
select pg_temp.p4r_check((select outcome from projects.lock_ui_version(pg_temp.p4r_ver(:'F_id', 2))) = 'locked', 'fixture: v2 is locked by the client');
reset role;
select id as "UV_id" from projects.ui_versions where phase_four_id = :'F_id' and version = 2 \gset

-- ═════════ 4. the revised prototype gets its own build (the revised-prototype gap) ═════════
select pg_temp.p4r_as_service();
set local role service_role;
select outcome as o, ref_id as b from projects.p4ui_plan_prototype_build(:'UV_id', 'web', 'in_app_preview', 'review',
  '{"limitations":["no real payments"],"simulatedIntegrations":["payment gateway"],"routes":[{"screenKey":"home","route":"/home"},{"screenKey":"checkout","route":"/checkout"}],"testInstructions":"Open home, press Checkout, press Back."}') \gset B1_
select pg_temp.p4r_check(:'B1_o' = 'planned' and (select outcome from projects.p4ui_validate_build_inputs(:'B1_b')) = 'ready', 'fixture: build 1 is planned at lock time and validated');
select pg_temp.p4r_check((select outcome from projects.p4ui_record_test_data(:'B1_b', 'cart', '{"items":[]}', true, 'empty cart')) = 'recorded', 'fixture: build 1 carries test data');
select outcome as o, prototype_artifact_id as a, deliverable_id as d from projects.record_prototype_build(:'UV_id', '[{"screenKey":"home","elements":[{"type":"button","label":"Checkout","navigatesTo":"ghost"}]}]') \gset A1_
select pg_temp.p4r_check(:'A1_o' = 'built', 'fixture: the first artifact is flawed (one screen, a ghost target)');
select pg_temp.p4r_check((select outcome from projects.p4ui_attach_build_artifact(:'B1_b', :'A1_a')) = 'self_check_failed', 'fixture: build 1 fails its own self-check (FAILED, with its artifact attached)');
select pg_temp.p4r_check((select outcome from projects.p4r_plan_revision_build(:'A1_a')) = 'already_attached', 'NEGATIVE: the artifact a build already holds is not planned a second build');
select pg_temp.p4r_check((select outcome from projects.p4r_plan_revision_build(gen_random_uuid())) = 'unknown_artifact', 'NEGATIVE: an unknown artifact is refused');
select projects.record_prototype_qa_verdict(:'A1_a', 'qa_changes_required', '[{"defect":"checkout screen missing; ghost target"}]');
select outcome as o, prototype_artifact_id as a, deliverable_id as d from projects.revise_prototype_build(:'UV_id',
  '[{"screenKey":"home","states":["error","loading"],"elements":[{"type":"button","label":"Checkout","navigatesTo":"checkout"}]},{"screenKey":"checkout","states":["error","validation_error"],"elements":[{"type":"button","label":"Back","navigatesTo":"home"},{"type":"input","label":"Card number","validation":"16 digits"}]}]') \gset A2_
select pg_temp.p4r_check(:'A2_o' = 'revised', 'the Prototype Agent''s corrected artifact A2 is recorded by the existing revision door');
select pg_temp.p4r_check((select count(*) = 1 from projects.p4ui_prototype_builds where ui_version_id = :'UV_id'), 'before the fix: the revised artifact has NO build (the gap this closes)');
select outcome as o, ref_id as b, detail as d from projects.p4r_plan_revision_build(:'A2_a') \gset R2_
select pg_temp.p4r_check(:'R2_o' = 'planned' and :'R2_d' = '2', 'the revision build is planned for the revised artifact');
select pg_temp.p4r_check((select status = 'building' and revision_of_build_id = :'B1_b' and platform = 'web' and limitations = array['no real payments'] and prototype_artifact_id is null
   from projects.p4ui_prototype_builds where id = :'R2_b'), 'it inherits the plan, says which build it revises, and is BUILDING (validation already passed for the same locked UI)');
select pg_temp.p4r_check((select count(*) = 1 from projects.p4ui_test_data where build_id = :'R2_b' and name = 'cart' and edge_case), 'the test data came with it');
select pg_temp.p4r_check((select outcome from projects.p4r_plan_revision_build(:'A2_a')) = 'prior_build_has_no_artifact' and (select count(*) = 2 from projects.p4ui_prototype_builds where ui_version_id = :'UV_id'), 'a replay plans nothing more: still two builds');
select pg_temp.p4r_check((select outcome from projects.p4ui_attach_build_artifact(:'R2_b', :'A2_a')) = 'build_ready', 'the revised artifact attaches to its build and passes its self-check');
select pg_temp.p4r_check((select outcome from projects.p4ui_record_build_revision(:'R2_b')) = 'recorded', 'and the revision record can now fire for a real revision');
select pg_temp.p4r_check((select r.origin = 'qa_defect' and r.from_build_id = :'B1_b' and r.to_build_id = :'R2_b' and r.evidence -> 'qaFindings' -> 0 ->> 'defect' like 'checkout screen missing%' from projects.p4ui_prototype_revisions r where r.to_build_id = :'R2_b'),
  'origin qa_defect, the QA finding on the prior artifact is the evidence');
select pg_temp.p4r_check((select outcome from projects.p4ui_assemble_qa_handoff(:'R2_b')) in ('assembled', 'exists'), 'the QA handoff package is assembled for the revised build');

-- state vocabulary, responsive and deep-link report (P4-PROTO-010/066/097/072)
select projects.p4r_prototype_state_report(:'R2_b') as rep \gset
select pg_temp.p4r_check(:'rep'::jsonb ->> 'outcome' = 'report' and jsonb_array_length(:'rep'::jsonb -> 'screens') = 2, 'the state report covers both locked screens');
select pg_temp.p4r_check((:'rep'::jsonb ->> 'inputsWithoutValidation')::int = 0 and jsonb_array_length(:'rep'::jsonb -> 'deepLinkProblems') = 0, 'the one input states its validation and every planned route resolves');
select projects.p4r_prototype_state_report(:'B1_b') as rep1 \gset
select pg_temp.p4r_check(:'rep1'::jsonb ->> 'outcome' = 'report' and (:'rep1'::jsonb ->> 'missingStates')::int = 2, 'DETECTION: the flawed first artifact omits the error and loading states its locked UI addressed for home (a missing screen is the coverage record''s finding, not counted twice)');
select pg_temp.p4r_check(:'rep'::jsonb ->> 'outcome' = 'report' and (:'rep'::jsonb ->> 'missingStates')::int = 0, 'and the revised artifact, which lists them, has none missing');

-- the QA-fix loop: the revised build is sent back, the limit holds (P4-PROTO-087), the next revision gets its own build
select projects.record_prototype_qa_verdict(:'A2_a', 'qa_changes_required', '[{"defect":"card field accepts letters"}]');
reset role;
update projects.phase_four set prototype_qa_fix_count = prototype_qa_fix_limit where id = :'F_id';
select pg_temp.p4r_as_service();
set local role service_role;
select pg_temp.p4r_check((select outcome from projects.revise_prototype_build(:'UV_id', '[{"screenKey":"home","elements":[{"type":"button","label":"Checkout","navigatesTo":"checkout"}]},{"screenKey":"checkout","elements":[{"type":"button","label":"Back","navigatesTo":"home"}]}]')) = 'revision_limit_reached',
  'LIVE (P4-PROTO-087): at the prototype QA-fix limit the next revision is refused');
select pg_temp.p4r_check((select state = 'revision_limit_escalation' and blocked_reason like 'Prototype QA fix limit reached%' from projects.phase_four where id = :'F_id'), 'the workspace is escalated to a human with the reason');
select pg_temp.p4r_check((select count(*) = 2 from projects.prototype_artifacts where ui_version_id = :'UV_id'), 'and no third artifact was made');
select pg_temp.p4r_check(exists (select 1 from core.outbox_events where type = 'project.revision_limit_escalated' and subject_id = :'F_id'), 'the escalation is announced (existing event)');
reset role;
update projects.phase_four set prototype_qa_fix_count = 1, state = 'prototype_build', blocked_reason = null where id = :'F_id';
select pg_temp.p4r_as_service();
set local role service_role;
select outcome as o, prototype_artifact_id as a, deliverable_id as d from projects.revise_prototype_build(:'UV_id',
  '[{"screenKey":"home","states":["error","loading"],"elements":[{"type":"button","label":"Checkout","navigatesTo":"checkout"}]},{"screenKey":"checkout","states":["error","validation_error"],"elements":[{"type":"button","label":"Back","navigatesTo":"home"},{"type":"input","label":"Card number","validation":"digits only, 16"}]}]') \gset A3_
select pg_temp.p4r_check(:'A3_o' = 'revised', 'once a person lifts the stop, the next fix is revised');
select outcome as o, ref_id as b from projects.p4r_plan_revision_build(:'A3_a') \gset R3_
\echo R3 :R3_o
select pg_temp.p4r_check(:'R3_o' = 'planned', 'a revision of a revision gets a build too (the prior one was sent back by QA)');
select pg_temp.p4r_check((select string_agg(status, ',' order by build_number) from projects.p4ui_prototype_builds where ui_version_id = :'UV_id') = 'failed,superseded,building', 'the sent-back build is superseded; history is kept: failed, superseded, building');
select pg_temp.p4r_check((select outcome from projects.p4ui_attach_build_artifact(:'R3_b', :'A3_a')) = 'build_ready' and (select outcome from projects.p4ui_record_build_revision(:'R3_b')) = 'recorded', 'it attaches and its revision is recorded');
select pg_temp.p4r_check((select r.origin = 'qa_defect' and r.from_build_id = :'R2_b' from projects.p4ui_prototype_revisions r where r.to_build_id = :'R3_b'), 'from the build that was sent back');
select pg_temp.p4r_check((select outcome from projects.p4ui_assemble_qa_handoff(:'R3_b')) in ('assembled', 'exists'), 'handoff assembled');
-- a build that was NOT sent back is never superseded by a stray artifact (the artifact is made inside a savepoint and rolled back)
savepoint p4r_stray;
select deliverable_id as xd from projects.add_deliverable(:'P_id', 'prototype', 'Prototype build', '/projects/x/prototype/preview/x', null, null, null) \gset X_
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, screens) values (:'ORG', :'P_id', :'UV_id', :'X_xd', '[{"screenKey":"home","elements":[{"type":"text","label":"x"}]}]') returning id as xa \gset X_
select pg_temp.p4r_check((select outcome from projects.p4r_plan_revision_build(:'X_xa')) = 'prior_build_not_sent_back' and (select count(*) = 3 from projects.p4ui_prototype_builds where ui_version_id = :'UV_id'),
  'NEGATIVE: an artifact that follows a build which was not sent back plans nothing and supersedes nothing');
rollback to savepoint p4r_stray;
select projects.record_prototype_qa_verdict(:'A3_a', 'qa_pass', '[]');
reset role;

-- ═════════ 5. phase_four.state follows the build (P4-PROTO-028) and an approved prototype cannot be changed (P4-PROTO-088) ═════════
select pg_temp.p4r_check((select state from projects.phase_four where id = :'F_id') = 'prototype_build', 'before review the workspace is prototype_build');
select pg_temp.p4r_as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select projects.decide_prototype_admin(:'A3_d', 'approved', 'ok');
select pg_temp.p4r_check((select outcome from projects.send_prototype_for_client_review(:'A3_d', null, 'build 3')) = 'submitted', 'the PM shares the exact revised build');
reset role;
select pg_temp.p4r_as_service();
set local role service_role;
select projects.p4ui_sync_build_status(:'R3_b');
select pg_temp.p4r_check((select status = 'client_review' from projects.p4ui_prototype_builds where id = :'R3_b'), 'the build reflects client_review');
select pg_temp.p4r_check((select state = 'prototype_review' from projects.phase_four where id = :'F_id'), 'and the workspace state is prototype_review');
reset role;
select pg_temp.p4r_as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select id as "RB_id" from approvals.approval_requests where subject_type = 'deliverable' and subject_id = :'A3_d' \gset
select approvals.decide_approval(:'RB_id', 'approved', 'looks right', 'whatsapp:p4r-9', null);
select projects.sync_deliverable_decision(:'A3_d');
reset role;
select pg_temp.p4r_as_service();
set local role service_role;
select pg_temp.p4r_check((select status = 'approved' from projects.deliverables where id = :'A3_d'), 'the client approved the exact deliverable');
select projects.p4ui_sync_build_status(:'R3_b');
select pg_temp.p4r_check((select status = 'locked' from projects.p4ui_prototype_builds where id = :'R3_b'), 'the build is locked because the deliverable is approved');
select pg_temp.p4r_check((select state = 'prototype_locked' from projects.phase_four where id = :'F_id'), 'and the workspace state is prototype_locked');
select pg_temp.p4r_check((select outcome from projects.revise_prototype_build(:'UV_id', '[{"screenKey":"home","elements":[{"type":"text","label":"x"}]}]')) = 'already_revised' and (select count(*) = 3 from projects.prototype_artifacts where ui_version_id = :'UV_id'),
  'LIVE (P4-PROTO-088): an approved prototype is not revised under its approval: no new artifact');
select pg_temp.p4r_check(pg_temp.p4r_fails_with($q$update projects.prototype_artifacts set screens = '[]' where id = '$q$ || :'A3_a' || $q$'$q$, '23001'), 'LIVE (P4-PROTO-088): even the service role cannot rewrite the approved artifact''s screens');
reset role;
select pg_temp.p4r_as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
with u as (update projects.prototype_artifacts set screens = '[]' where id = :'A3_a' returning 1) select count(*) as touched from u \gset OW_
select pg_temp.p4r_check(:'OW_touched' = 0, 'LIVE: an owner session reaches no row at all (no write policy)');
reset role;
select pg_temp.p4r_check(pg_temp.p4r_fails_with($q$update projects.deliverables set title = 'edited' where id = '$q$ || :'A3_d' || $q$'$q$, '23001'), 'LIVE: the approved deliverable''s content is immutable even to a table owner');
select pg_temp.p4r_check(pg_temp.p4r_fails_with($q$update projects.deliverables set status = 'draft' where id = '$q$ || :'A3_d' || $q$'$q$, '23001'), 'LIVE: and it cannot leave approved');
select pg_temp.p4r_check(pg_temp.p4r_fails_with($q$update projects.p4ui_prototype_builds set status = 'building' where id = '$q$ || :'R3_b' || $q$'$q$, '23514'), 'LIVE: the locked build cannot be moved back');
select pg_temp.p4r_check((select state from projects.phase_four where id = :'F_id') = 'prototype_locked', 'a refused change left the state alone');

-- ═════════ 6. what a client can see (P4-UID-035/055): export-leak assertions ═════════
select pg_temp.p4r_as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select projects.p4ui_prototype_client_notice(:'A3_d') as notice \gset
reset role;
select pg_temp.p4r_check((select array_agg(k order by k) from jsonb_object_keys(:'notice'::jsonb) k) = array['label', 'limitations', 'platform', 'simulated'], 'the client notice has exactly four keys: no internals can ride along');
select pg_temp.p4r_check(:'notice' !~* '(anthropic|openai|openrouter|claude|gpt|gemini|llama|mistral|prompt|api[_ -]?key|qaFindings|self_?check|blocker|credential|sk_live)', 'and no provider, prompt, QA or credential vocabulary appears in it');
select pg_temp.p4r_check((select count(*) = 0 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'projects' and (c.relname like 'p4ui\_%' or c.relname like 'p4r\_%') and c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity)), 'every p4ui_/p4r_ table has row level security enabled and forced');
select pg_temp.p4r_check((select count(*) = 0 from pg_policies p where p.schemaname = 'projects' and (p.tablename like 'p4ui\_%' or p.tablename like 'p4r\_%') and p.cmd = 'SELECT' and p.qual not like '%is_internal%'),
  'every read policy on them requires an internal caller, so no client session reads a p4ui_/p4r_ row');
select pg_temp.p4r_check((select count(*) = 0 from pg_policies p where p.schemaname = 'projects' and (p.tablename like 'p4ui\_%' or p.tablename like 'p4r\_%') and p.cmd <> 'SELECT'), 'and none of them has a write policy: every write is a door');
select pg_temp.p4r_check((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and (c.relname like 'p4ui\_%' or c.relname like 'p4r\_%') and c.relkind = 'r') >= 18, 'the sweep covers the whole family (not an empty match)');

-- ═════════ 7. tenancy ═════════
select pg_temp.p4r_check((select count(*) = 0 from core.unguarded_org_fks() where child like 'projects.p4r\_%'), 'tenancy guard: every org-scoped FK of a p4r_ table is guarded');
select pg_temp.p4r_as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.p4r_check((select outcome from projects.p4r_plan_revision_build(:'A3_a')) = 'forbidden', 'cross-tenant: another organization cannot plan a build for this artifact');
select pg_temp.p4r_check((select projects.p4r_prototype_state_report(:'R3_b') ->> 'outcome') = 'forbidden', 'cross-tenant: nor read its state report');
reset role;
select pg_temp.p4r_as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.p4r_check(not has_function_privilege('anon', 'projects.p4r_plan_revision_build(uuid)', 'execute') and not has_function_privilege('anon', 'projects.p4r_record_design_inputs(uuid,jsonb,text[],text[],text)', 'execute'), 'the new doors are not callable by anon');

rollback;
\echo PASS verify-p4r-ui-prototype
