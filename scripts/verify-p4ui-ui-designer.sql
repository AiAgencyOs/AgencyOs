-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 UI Designer gaps (migration 20261125000000, rows P4-UID-*): every control driven through the REAL doors on a scratch Postgres; rolls back.
--
--   KEEP=1 scripts/apply-migrations-locally.sh          (port 55432; any port works)
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p4ui-ui-designer.sql
--
-- Fixtures that no door can make (a Phase 3 hand-off row, a scope version) are inserted with FK triggers relaxed for that statement only, exactly like
-- verify-phase-four-e2e.sql; everything after that goes through a door. Scoped to one project of one organization (CI shares the database).
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
\set OWNER '00000000-0000-4000-8000-00000000f541'
\set MEMBER '00000000-0000-4000-8000-00000000f542'
\set ORG2 '00000000-0000-4000-8000-0000000000b4'
\set OWNER2 '00000000-0000-4000-8000-00000000f543'

insert into auth.users (id, email) values (:'OWNER', 'p4ui-owner@example.test'), (:'MEMBER', 'p4ui-member@example.test'), (:'OWNER2', 'p4ui-owner2@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4ui-owner@example.test', 'P4UI Owner'), (:'MEMBER', 'p4ui-member@example.test', 'P4UI Member'),
  (:'OWNER2', 'p4ui-owner2@example.test', 'P4UI Owner Two') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'MEMBER', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p4ui other org', 'zztest-p4ui-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;
insert into approvals.approval_policies (organization_id, subject_type, required_role, sla_hours, audience) values (:'ORG', 'ui_version', 'owner', 24, 'internal') on conflict do nothing;
insert into approvals.approval_policies (organization_id, subject_type, required_role, sla_hours, audience) values (:'ORG', 'deliverable', 'owner', 24, 'client') on conflict do nothing;

-- ── fixture: a finished Phase 3 (hand-off with three baseline screens), an active scope with two included items ──
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4ui client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4ui', 'ZP4UI-1') returning id \gset P_
insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) values (:'ORG', :'P_id', 'M1', 1, 50000, 'INR'), (:'ORG', :'P_id', 'M2', 2, 100000, 'INR');
set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, figma_node_id, payload, phase_four_ready, locked_at)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '1:2',
          '{"screenBaseline":{"screens":[{"screenKey":"home","states":{"empty":true,"error":true}},{"screenKey":"checkout","states":{"error":true}},{"screenKey":"settings","states":{}}]}}',
          true, now()) returning id \gset H_
insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at) values (:'ORG', :'P_id', 1, 'active', now()) returning id \gset SV_
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SV_id', 'Browse the catalogue', 'included') returning id \gset SI1_
insert into projects.scope_items (organization_id, scope_version_id, title, inclusion) values (:'ORG', :'SV_id', 'Pay online', 'included') returning id \gset SI2_
insert into projects.screens (organization_id, project_id, screen_key, name, user_role, device_targets) values (:'ORG', :'P_id', 'home', 'Home', 'visitor', array['mobile','desktop']) returning id \gset SC1_
insert into projects.screen_scope_items (screen_id, scope_item_id, organization_id) values (:'SC1_id', :'SI1_id', :'ORG');
set local session_replication_role = origin;

select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.start_phase_four(:'P_id')) = 'started', 'fixture: Task 2 starts from the locked baseline');
reset role;
select id as "F_id" from projects.phase_four where project_id = :'P_id' \gset

-- ═════════ 1. the Designer wakes only for a named condition (P4-UID-001/004/005/011/026/044/045/054) ═════════
select pg_temp.as_service();
set local role service_role;
select outcome as o, ref_id as j from projects.p4ui_request_design_job(:'F_id', 'prototype_code_bug', null, 'checkout button does nothing') \gset RF_
select pg_temp.check(:'RF_o' = 'refused', 'a prototype code bug does NOT activate the Designer: it is recorded as a refusal');
select pg_temp.check((select status = 'refused' and activation_reason is null and route_to = 'Prototype Agent fixes it' and refusal_reason is not null from projects.p4ui_design_jobs where id = :'RF_j'),
  'the refusal names its owner and carries no activation reason (non-activations are visible in Admin history)');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'prototype_code_bug', null, '  Checkout   button does nothing ')) = 'exists', 'the same refusal replayed (normalised request) is the same row: idempotent');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'make_it_pink')) = 'refused', 'an invented seventh reason is refused too, never guessed at');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'payment_issue')) = 'refused', 'a payment issue is refused');
select pg_temp.check((select route_to from projects.p4ui_design_jobs where phase_four_id = :'F_id' and refused_trigger = 'payment_issue') = 'Finance', 'and goes to Finance');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'initial_phase_four', gen_random_uuid())) = 'wrong_workspace', 'a source version of another workspace is refused');

-- an ambiguous rule is a blocker + a clarification, not a guess (P4-UID-005/057/049)
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'ambiguous_business_rule', null, 'Does a refund restore the stock?')) = 'refused', 'an ambiguous business rule is refused');
select pg_temp.check((select state from projects.phase_four where id = :'F_id') = 'blocked_requirement', 'and the workspace is blocked, with a reason');
select pg_temp.check(exists (select 1 from projects.clarification_requests where project_id = :'P_id' and question like 'Does a refund%'), 'and a clarification is asked of the PM');
select id as "B_id" from projects.p4ui_design_blockers where phase_four_id = :'F_id' and kind = 'ambiguity' and status = 'open' \gset
select pg_temp.check(:'B_id' is not null, 'an open ambiguity blocker names an owner and a resume condition');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'initial_phase_four')) = 'phase_blocked', 'NEGATIVE: no design job while the workspace is blocked');
select pg_temp.check((select outcome from projects.p4ui_resolve_design_blocker(:'B_id', 'client answered')) = 'person_required', 'NEGATIVE: an agent cannot clear its own blocker');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_resolve_design_blocker(:'B_id', 'the client said refunds restore stock')) = 'resolved', 'a person resolves it');
select pg_temp.check((select state from projects.phase_four where id = :'F_id') = 'task2_started', 'and the workspace state it stopped is restored');
select pg_temp.check((select outcome from projects.p4ui_resolve_design_blocker(:'B_id', 'again')) = 'already_resolved', 'a replayed resolve is idempotent');
reset role;

-- the initial activation: reason, scope version, idempotency key; a baseline with no screens would block instead
select pg_temp.as_service();
set local role service_role;
select outcome as o, ref_id as j from projects.p4ui_request_design_job(:'F_id', 'initial_phase_four', null, 'full UI from the locked baseline') \gset J1_
select pg_temp.check(:'J1_o' = 'requested', 'the initial activation is recorded with its reason');
select pg_temp.check((select activation_reason = 'initial_phase_four' and scope_version = 1 and length(idempotency_key) = 32 and status = 'requested' from projects.p4ui_design_jobs where id = :'J1_j'), 'it stores the reason, the active scope version and an idempotency key');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'initial_phase_four', null, 'full UI from the locked baseline')) = 'exists', 'a replayed activation returns the same job: no second AI run');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.ui_design_job_requested' and subject_id = :'J1_j'), 'the activation is an event');

-- the draft (existing door), then the job is delivered by the version it produced; lineage is derived
select pg_temp.check((select outcome from projects.record_ui_version_draft(:'F_id', '[{"screenKey":"home","statesAddressed":["default","empty"]},{"screenKey":"checkout","statesAddressed":["default","error"]}]')) = 'drafted', 'the Designer drafts v1 (home, checkout; settings missing)');
select pg_temp.check((select outcome from projects.p4ui_complete_design_job(:'J1_j', pg_temp.ver(:'F_id', 1))) = 'delivered', 'the job is delivered by v1');
select pg_temp.check((select outcome from projects.p4ui_complete_design_job(:'J1_j', pg_temp.ver(:'F_id', 1))) = 'already_delivered', 'and a replay is a no-op');
select pg_temp.check((select outcome from projects.p4ui_derive_version_meta(pg_temp.ver(:'F_id', 1), null, :'J1_j')) = 'recorded', 'v1 lineage is derived');
select pg_temp.check((select origin = 'initial' and activation_reason = 'initial_phase_four' and parent_ui_version_id is null and added_screens = array['checkout','home'] and design_job_id = :'J1_j'
  from projects.p4ui_version_meta where ui_version_id = pg_temp.ver(:'F_id', 1)), 'v1: initial, no parent, both screens added, the job recorded');
select pg_temp.check((select outcome from projects.p4ui_derive_version_meta(pg_temp.ver(:'F_id', 1))) = 'exists', 'deriving lineage twice writes it once');
select pg_temp.check((select figma_state = 'manual_figma_required' and figma_write_state = 'not_attempted' from projects.p4ui_version_meta where ui_version_id = pg_temp.ver(:'F_id', 1)), 'Figma is stated honestly: manual, not attempted');
select pg_temp.check(pg_temp.fails_with($q$update projects.p4ui_version_meta set figma_write_state = 'written' where ui_version_id = (select id from projects.ui_versions where phase_four_id = '$q$ || :'F_id' || $q$' and version = 1)$q$, '23514'), 'NEGATIVE: there is no value that claims Figma was written');

-- ═════════ 2. screen specs, completeness, requirement trace, Figma refs (P4-UID-015..022/047/030/043/051) ═════════
select pg_temp.check((select outcome from projects.p4ui_record_screen_spec(pg_temp.ver(:'F_id', 1), 'ghost', '{"purpose":"x"}')) = 'unknown_screen', 'NEGATIVE: a spec for a screen the version does not design is refused');
select pg_temp.check((select outcome from projects.p4ui_record_screen_spec(pg_temp.ver(:'F_id', 1), 'home', '{"states":["sparkly"]}')) = 'bad_spec', 'NEGATIVE: a state outside the UID 6.3 vocabulary is refused');
select pg_temp.check((select outcome from projects.p4ui_record_screen_spec(pg_temp.ver(:'F_id', 1), 'home', '{"responsiveVariants":["watch"]}')) = 'bad_spec', 'NEGATIVE: a platform variant outside the vocabulary is refused');
select pg_temp.check((select outcome from projects.p4ui_record_screen_spec(pg_temp.ver(:'F_id', 1), 'home',
  '{"purpose":"Browse","entryPoints":["app open"],"exitPoints":["checkout"],"dataShown":["products"],"actions":["add to cart"],"validationRules":[],"states":["error","offline","permission_denied"],"responsiveVariants":["mobile"],"roleVariants":[{"role":"admin","differences":"edit button"}],"nodeRef":"1:20"}')) = 'recorded',
  'a full screen spec is recorded (purpose, entry/exit, data, actions, states, variants, role variant, node)');
select pg_temp.check((select outcome from projects.p4ui_record_screen_spec(pg_temp.ver(:'F_id', 1), 'home', '{"purpose":"Browse again","states":["error"],"responsiveVariants":["mobile","desktop"]}')) = 'updated', 'a draft spec may be rewritten');
select pg_temp.check((projects.p4ui_design_completeness(pg_temp.ver(:'F_id', 1)) ->> 'complete')::boolean = false, 'completeness: a version with a spec-less screen is not complete');
select pg_temp.check(exists (select 1 from jsonb_array_elements(projects.p4ui_design_completeness(pg_temp.ver(:'F_id', 1)) -> 'screens') s
  where s ->> 'screenKey' = 'checkout' and (s ->> 'hasSpec')::boolean = false), 'completeness names checkout as having no spec');
select pg_temp.check(exists (select 1 from jsonb_array_elements(projects.p4ui_design_completeness(pg_temp.ver(:'F_id', 1)) -> 'screens') s
  where s ->> 'screenKey' = 'home' and s -> 'missingStates' = '[]'::jsonb and s -> 'missingVariants' = '[]'::jsonb), 'home needs default+empty+error and mobile+desktop, and has all of them (drafted states + spec states)');
select outcome as o from projects.p4ui_record_screen_spec(pg_temp.ver(:'F_id', 1), 'checkout', '{"purpose":"Pay","states":["validation_error"]}') \gset SP_
select pg_temp.check(:'SP_o' = 'recorded', 'checkout spec recorded');
select pg_temp.check(exists (select 1 from jsonb_array_elements(projects.p4ui_design_completeness(pg_temp.ver(:'F_id', 1)) -> 'screens') s
  where s ->> 'screenKey' = 'checkout' and (s ->> 'hasSpec')::boolean and s -> 'missingStates' = '[]'::jsonb), 'checkout: spec present, required states met');

select pg_temp.check((projects.p4ui_requirement_trace(pg_temp.ver(:'F_id', 1)) -> 'orphanScreens') = '["checkout"]'::jsonb, 'requirement trace: checkout maps to no scope item (an orphan), home does');
select pg_temp.check((projects.p4ui_requirement_trace(pg_temp.ver(:'F_id', 1)) -> 'uncoveredRequirements') = '["Pay online"]'::jsonb, 'requirement trace: the included scope item "Pay online" has no screen');
select pg_temp.check((projects.p4ui_requirement_trace(pg_temp.ver(:'F_id', 1)) -> 'screens' -> 0 ->> 'screenKey') is not null, 'requirement trace lists every designed screen with its requirements');

select pg_temp.check((select outcome from projects.p4ui_record_figma_refs(pg_temp.ver(:'F_id', 1), 'figd-abc', 'Page 1', '{"home":"1:20"}')) = 'person_required', 'NEGATIVE: an agent cannot assert a Figma link');
select pg_temp.check((select outcome from projects.p4ui_mark_figma_unavailable(pg_temp.ver(:'F_id', 1), 'environment_missing', 'no Figma credentials in this environment')) = 'recorded', 'Figma unavailability is recorded (environment_missing)');
select pg_temp.check((select figma_state = 'unavailable' and figma_write_state = 'environment_missing' from projects.p4ui_version_meta where ui_version_id = pg_temp.ver(:'F_id', 1)), 'the version says so; nothing claims a write');
select pg_temp.check(exists (select 1 from projects.p4ui_design_blockers where ui_version_id = pg_temp.ver(:'F_id', 1) and kind = 'figma_unavailable' and status = 'open' and not stops_phase), 'and a non-stopping blocker is visible');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_record_figma_refs(pg_temp.ver(:'F_id', 1), 'figd-abc', 'Page 1', '{"ghost":"1:2"}')) = 'unknown_screen', 'NEGATIVE: a node reference to a screen the version does not design is refused');
select pg_temp.check((select outcome from projects.p4ui_record_figma_refs(pg_temp.ver(:'F_id', 1), 'figd-abc', 'Page 1', '{"home":"1:20"}', 'https://www.figma.com/file/abc')) = 'recorded', 'a person records the Figma references');
select pg_temp.check((select figma_state = 'linked' and figma_write_state = 'manual_required' and figma_node_refs = '{"home":"1:20"}' from projects.p4ui_version_meta where ui_version_id = pg_temp.ver(:'F_id', 1)), 'linked, and the write stays manual_required');
select pg_temp.check((select outcome from projects.p4ui_record_figma_refs(pg_temp.ver(:'F_id', 1), 'figd-other')) = 'would_replace', 'NEGATIVE: a different Figma file is not silently swapped in');
select pg_temp.check((select outcome from projects.p4ui_record_figma_refs(pg_temp.ver(:'F_id', 1), 'figd-other', null, '{}', null, 'file moved to the client team')) = 'recorded', 'with a stated reason it is replaced (audited)');
reset role;

-- ═════════ 3. coverage gap, QA defects as rows, fix_ready is a claim, verified is QA's (P4-UID-004/023/040/050/048/029) ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'missing_approved_ui', pg_temp.ver(:'F_id', 1), 'settings is not designed')) = 'requested', 'a confirmed coverage gap (settings; home/checkout states) activates the Designer');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.ui_coverage_gap_confirmed' and payload ->> 'uiVersionId' = pg_temp.ver(:'F_id', 1)::text), 'UICoverageGapConfirmed is emitted');
select pg_temp.check((select change_set -> 0 -> 'missingScreens' from projects.p4ui_design_jobs where phase_four_id = :'F_id' and activation_reason = 'missing_approved_ui') = '["settings"]'::jsonb, 'and the change set carries the gap');
select projects.record_ui_version_qa_verdict(pg_temp.ver(:'F_id', 1), 'qa_changes_required',
  '{"missingScreens":["settings"],"stateGaps":["home is missing states: error"],"verdictReasons":[]}');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'design_qa_defect', pg_temp.ver(:'F_id', 1), 'fix the QA defects')) = 'requested', 'a QA-returned version activates the Designer (design_qa_defect)');
select pg_temp.check((select detail from projects.p4ui_import_qa_findings(pg_temp.ver(:'F_id', 1))) = '2', 'the stored QA verdict becomes two defect rows');
select pg_temp.check((select detail from projects.p4ui_import_qa_findings(pg_temp.ver(:'F_id', 1))) = '0', 'importing again adds nothing');
select pg_temp.check((select outcome from projects.p4ui_open_qa_defect(pg_temp.ver(:'F_id', 1), 'ghost', 'content', 'x')) = 'unknown_screen', 'NEGATIVE: a defect on a screen the version does not design is refused');
select pg_temp.check((select count(*) from projects.p4ui_qa_defects where ui_version_id = pg_temp.ver(:'F_id', 1) and status = 'open') = 2, 'both defects are open');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'design_qa_defect', pg_temp.ver(:'F_id', 1), 'fix the QA defects')) = 'exists', 'the QA-defect activation is idempotent');
select id as "JQ_j" from projects.p4ui_design_jobs where phase_four_id = :'F_id' and activation_reason = 'design_qa_defect' \gset

select pg_temp.check((select outcome from projects.revise_ui_version(:'F_id', '[{"screenKey":"home","statesAddressed":["default","empty","error"]},{"screenKey":"checkout","statesAddressed":["default","error"]},{"screenKey":"settings","statesAddressed":["default"]}]')) = 'revised', 'the Designer fixes the defects as v2 (existing door)');
select pg_temp.check((select outcome from projects.p4ui_derive_version_meta(pg_temp.ver(:'F_id', 2), 'Added settings; home now has an error state.', :'JQ_j')) = 'recorded', 'v2 lineage is derived');
select pg_temp.check((select parent_ui_version_id = pg_temp.ver(:'F_id', 1) and origin = 'qa_defect' and activation_reason = 'design_qa_defect' and added_screens = array['settings'] and changed_screens = array['home']
  and content_changed and change_summary like 'Added settings%' from projects.p4ui_version_meta where ui_version_id = pg_temp.ver(:'F_id', 2)), 'v2: parent v1, origin qa_defect, settings added, home changed, the summary stored');
select pg_temp.check((select origin = 'qa_defect' and jsonb_array_length(evidence -> 'defectIds') = 2 and affected_screens @> array['home','settings'] from projects.p4ui_revisions where to_ui_version_id = pg_temp.ver(:'F_id', 2)),
  'the revision record carries the defect ids and affected screens');
select pg_temp.check((select count(*) from projects.p4ui_qa_defects where ui_version_id = pg_temp.ver(:'F_id', 1) and status = 'fix_ready' and fix_ui_version_id = pg_temp.ver(:'F_id', 2)) = 2, 'the defects are fix_ready against v2: a claim');
select pg_temp.check((select outcome from projects.p4ui_complete_design_job(:'JQ_j', pg_temp.ver(:'F_id', 1))) = 'not_a_newer_version', 'NEGATIVE: a job is not delivered by the version it started from');
select pg_temp.check((select outcome from projects.p4ui_complete_design_job(:'JQ_j', pg_temp.ver(:'F_id', 2))) = 'delivered', 'the job is delivered by v2');
select id as "D1_id" from projects.p4ui_qa_defects where ui_version_id = pg_temp.ver(:'F_id', 1) order by created_at, id limit 1 \gset
select pg_temp.check((select outcome from projects.p4ui_record_defect_retest(:'D1_id', true, 'looks fixed')) = 'fix_not_reviewed_by_qa', 'NEGATIVE: the Designer''s fix is not verified until QA has reviewed the fix version');
select projects.record_ui_version_qa_verdict(pg_temp.ver(:'F_id', 2), 'qa_pass', '{}');
-- the producer of the fix cannot verify it
reset role;
update projects.ui_versions set produced_by = :'MEMBER' where id = pg_temp.ver(:'F_id', 2);
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_record_defect_retest(:'D1_id', true, 'mine')) = 'self_review', 'NEGATIVE: the person who produced the fix cannot verify it');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_record_defect_retest(:'D1_id', true, 'QA retest passed on v2')) = 'verified', 'QA verifies the defect against the fix version');
select pg_temp.check((select status = 'verified' and verified_at is not null from projects.p4ui_qa_defects where id = :'D1_id'), 'verified carries a date');
reset role;

-- ═════════ 4. client feedback is classified first; a scope change is not a redesign (P4-UID-008/009/025/027) ═════════
select pg_temp.as_service();
set local role service_role;
select projects.request_ui_version_admin_review(pg_temp.ver(:'F_id', 2));
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select id as "R2_id" from approvals.approval_requests where subject_type = 'ui_version' and subject_id = pg_temp.ver(:'F_id', 2) \gset
select approvals.decide_approval(:'R2_id', 'approved', 'good', null, null);
select projects.sync_ui_version_decision(pg_temp.ver(:'F_id', 2));
select projects.share_ui_version_with_client(pg_temp.ver(:'F_id', 2), 'whatsapp:p4ui-1');
select pg_temp.check((select outcome from projects.record_ui_version_client_decision(pg_temp.ver(:'F_id', 2), 'change_requested', 'add a loyalty-points programme and make the buy button green', 'whatsapp:p4ui-2', null)) = 'recorded', 'the client asks for a change on v2');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'client_visual_revision', pg_temp.ver(:'F_id', 2), 'client revision')) = 'classification_required',
  'NEGATIVE: a client revision cannot activate the Designer before the PM has classified it');
select pg_temp.check((select outcome from projects.p4ui_route_ui_feedback(pg_temp.ver(:'F_id', 2), 'WHATEVER', 'x')) = 'bad_classification', 'an unknown classification is refused');
select outcome as o, route as r from projects.p4ui_route_ui_feedback(pg_temp.ver(:'F_id', 2), 'POSSIBLE_SCOPE_CHANGE', 'a loyalty programme is not in the agreed scope') \gset RT_
select pg_temp.check(:'RT_o' = 'routed' and :'RT_r' = 'change_request', 'a possible scope change routes to a Change Request, not a redesign');
select pg_temp.check((select state from projects.phase_four where id = :'F_id') = 'scope_escalation', 'and the workspace stops at scope_escalation with a reason');
select pg_temp.check(exists (select 1 from projects.p4ui_design_blockers where ui_version_id = pg_temp.ver(:'F_id', 2) and kind = 'scope_conflict' and status = 'open' and stops_phase), 'with a scope_conflict blocker owned by the PM');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'client_visual_revision', pg_temp.ver(:'F_id', 2), 'client revision')) = 'phase_blocked', 'NEGATIVE: the Designer does not activate for a scope change');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'approved_scope_change', pg_temp.ver(:'F_id', 2), 'loyalty programme', '[]', gen_random_uuid())) = 'no_approved_change', 'NEGATIVE: scope-change reason needs an APPROVED change request');
select pg_temp.check((select outcome from projects.p4ui_route_ui_feedback(pg_temp.ver(:'F_id', 2), 'CORRECTION', 'x')) = 'already_routed', 'a version is classified once');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select id as "B2_id" from projects.p4ui_design_blockers where ui_version_id = pg_temp.ver(:'F_id', 2) and kind = 'scope_conflict' and status = 'open' \gset
select projects.p4ui_resolve_design_blocker(:'B2_id', 'client dropped the loyalty ask');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'client_visual_revision', pg_temp.ver(:'F_id', 2), 'client revision')) = 'not_a_design_revision', 'a version routed to a Change Request is not a design revision even after the stop is cleared');
reset role;

-- v3 (a correction): classified CORRECTION first, then the Designer is allowed
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.revise_ui_version(:'F_id', '[{"screenKey":"home","statesAddressed":["default","empty","error"],"buyButton":"green"},{"screenKey":"checkout","statesAddressed":["default","error"]},{"screenKey":"settings","statesAddressed":["default"]}]')) = 'revised', 'v3: the allowed visual correction (existing door)');
select pg_temp.check((select outcome from projects.p4ui_derive_version_meta(pg_temp.ver(:'F_id', 3))) = 'recorded', 'v3 lineage is derived without a job');
select pg_temp.check((select m.origin = 'client_change' and m.activation_reason = 'client_visual_revision' and m.changed_screens = array['home'] and r.evidence ->> 'clientWords' like 'add a loyalty%'
  and r.evidence ->> 'classification' = 'POSSIBLE_SCOPE_CHANGE' from projects.p4ui_version_meta m join projects.p4ui_revisions r on r.to_ui_version_id = m.ui_version_id where m.ui_version_id = pg_temp.ver(:'F_id', 3)),
  'v3: origin client_change, home changed, the client''s own words and the classification are in the revision evidence');
select projects.record_ui_version_qa_verdict(pg_temp.ver(:'F_id', 3), 'qa_pass', '{}');
select projects.request_ui_version_admin_review(pg_temp.ver(:'F_id', 3));
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select id as "R3_id" from approvals.approval_requests where subject_type = 'ui_version' and subject_id = pg_temp.ver(:'F_id', 3) \gset
select approvals.decide_approval(:'R3_id', 'changes_requested', 'make the header sticky', null, null);
select projects.sync_ui_version_decision(pg_temp.ver(:'F_id', 3));
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'admin_edit', pg_temp.ver(:'F_id', 3), 'Admin EDIT')) = 'requested', 'an Admin EDIT activates the Designer (admin_edit)');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'design_qa_defect', pg_temp.ver(:'F_id', 3), 'not returned by QA')) = 'not_returned', 'NEGATIVE: design_qa_defect needs a version QA actually returned');
select outcome as o from projects.revise_ui_version(:'F_id', '[{"screenKey":"home","statesAddressed":["default","empty","error"],"buyButton":"green","sticky":true},{"screenKey":"checkout","statesAddressed":["default","error"]},{"screenKey":"settings","statesAddressed":["default"]}]') \gset V4_
select pg_temp.check((select outcome from projects.p4ui_derive_version_meta(pg_temp.ver(:'F_id', 4))) = 'recorded', 'v4 lineage derived');
select pg_temp.check((select m.origin = 'admin_edit' and r.evidence ->> 'adminNote' = 'make the header sticky' from projects.p4ui_version_meta m join projects.p4ui_revisions r on r.to_ui_version_id = m.ui_version_id where m.ui_version_id = pg_temp.ver(:'F_id', 4)),
  'v4: origin admin_edit, the Admin''s own note is the evidence');
select projects.record_ui_version_qa_verdict(pg_temp.ver(:'F_id', 4), 'qa_pass', '{}');
select projects.request_ui_version_admin_review(pg_temp.ver(:'F_id', 4));
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select id as "R4_id" from approvals.approval_requests where subject_type = 'ui_version' and subject_id = pg_temp.ver(:'F_id', 4) \gset
select approvals.decide_approval(:'R4_id', 'approved', 'good', null, null);
select projects.sync_ui_version_decision(pg_temp.ver(:'F_id', 4));
select projects.share_ui_version_with_client(pg_temp.ver(:'F_id', 4), 'whatsapp:p4ui-3');
select projects.record_ui_version_client_decision(pg_temp.ver(:'F_id', 4), 'final_confirmed', 'approved', 'whatsapp:p4ui-4', null);
select pg_temp.check((select outcome from projects.lock_ui_version(pg_temp.ver(:'F_id', 4))) = 'locked', 'v4 is locked by the client''s confirmation (existing gates untouched)');
reset role;

-- ═════════ 5. a locked UI is never overwritten; a post-lock change needs an Admin (P4-UID-013/034/035) ═════════
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'client_visual_revision', pg_temp.ver(:'F_id', 4), 'make the logo red after lock')) = 'locked', 'NEGATIVE: a post-lock colour change does not activate the Designer');
select pg_temp.check(exists (select 1 from projects.p4ui_design_jobs where phase_four_id = :'F_id' and refused_trigger = 'locked_ui_overwrite' and status = 'refused'), 'and the refusal is a visible record');
select pg_temp.check((select outcome from projects.p4ui_request_post_lock_revision(pg_temp.ver(:'F_id', 4), 'colour_change', 'client wants a red logo')) = 'requested', 'a post-lock request is recorded');
select id as "PL_id" from projects.p4ui_post_lock_requests where ui_version_id = pg_temp.ver(:'F_id', 4) \gset
select pg_temp.check((select outcome from projects.p4ui_request_post_lock_revision(pg_temp.ver(:'F_id', 3), 'colour_change', 'x')) = 'not_locked', 'NEGATIVE: only a locked version can be the subject of a post-lock request');
select pg_temp.check((select outcome from projects.p4ui_decide_post_lock_revision(:'PL_id', true, 'ok')) = 'admin_required', 'NEGATIVE: an agent cannot approve a post-lock change');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'approved_scope_change', pg_temp.ver(:'F_id', 4), 'red logo', '[]', :'PL_id')) = 'no_approved_change', 'NEGATIVE: an undecided request is not an approval');
reset role;
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_decide_post_lock_revision(:'PL_id', true, 'ok')) = 'admin_required', 'NEGATIVE: a member who is not an Admin cannot approve it either');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_decide_post_lock_revision(:'PL_id', true, 'approved: brand refresh in the plan')) = 'approved', 'an Admin approves');
reset role;
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.ui_post_lock_revision_decided' and subject_id = :'PL_id'), 'the decision is an event');

-- ═════════ 6. the prototype stage: a code bug leaves the Designer asleep, a source-UI defect wakes it (P4-UID-011/012) ═════════
select pg_temp.as_service();
set local role service_role;
select outcome as o, prototype_artifact_id as a from projects.record_prototype_build(pg_temp.ver(:'F_id', 4), '[{"screenKey":"home"},{"screenKey":"checkout"}]') \gset PB_
select pg_temp.check(:'PB_o' = 'built', 'fixture: a prototype is built from locked v4');
select outcome as o, ref_id as i from projects.p4ui_report_prototype_issue(:'PB_a', 'checkout', 'the pay button is dead') \gset PI1_
select pg_temp.check(:'PI1_o' = 'reported', 'a prototype issue is reported');
select pg_temp.check((select outcome from projects.p4ui_confirm_prototype_design_issue(:'PI1_i', false, 'x')) = 'person_required', 'NEGATIVE: the agent that built the prototype cannot classify the issue');
select outcome as o, ref_id as i from projects.p4ui_report_prototype_issue(:'PB_a', 'home', 'the layout cannot hold the product grid') \gset PI2_
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_confirm_prototype_design_issue(:'PI1_i', false, 'handler missing: a code bug')) = 'dismissed_as_code_bug', 'a person classifies the dead button as a code bug');
select pg_temp.check(exists (select 1 from audit.audit_log where action = 'ui_design.designer_not_activated' and subject_id = :'PI1_i'), 'and the non-activation of the Designer is audited');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'source_ui_design_defect', pg_temp.ver(:'F_id', 4), 'dead button', '[]', :'PI1_i')) = 'no_confirmed_issue', 'NEGATIVE: a dismissed code bug cannot re-activate the Designer');
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'source_ui_design_defect', pg_temp.ver(:'F_id', 4), 'layout', '[]', :'PI2_i')) = 'no_confirmed_issue', 'NEGATIVE: an unconfirmed issue cannot either');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_confirm_prototype_design_issue(:'PI2_i', true, 'the approved layout genuinely cannot hold the grid')) = 'confirmed', 'a person confirms a source-UI defect');
reset role;
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.prototype_design_issue_confirmed' and subject_id = :'PI2_i'), 'PrototypeDesignIssueConfirmed is emitted');
select pg_temp.as_service();
set local role service_role;
select outcome as o, ref_id as j from projects.p4ui_request_design_job(:'F_id', 'source_ui_design_defect', pg_temp.ver(:'F_id', 4), 'layout', '[]', :'PI2_i') \gset JS_
select pg_temp.check(:'JS_o' = 'requested', 'only the confirmed source-UI defect re-activates the Designer (reason source_ui_design_defect)');
select outcome as o, ref_id as j from projects.p4ui_request_design_job(:'F_id', 'approved_scope_change', pg_temp.ver(:'F_id', 4), 'red logo', '[]', :'PL_id') \gset JC_
select pg_temp.check(:'JC_o' = 'requested', 'and an Admin-approved post-lock request activates it for approved_scope_change');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.ui_scope_change_approved' and subject_id = :'JC_j'), 'ScopeChangeApprovedForUI is emitted');

-- the governed new version: the locked row is untouched
select pg_temp.check((select outcome from projects.p4ui_start_governed_revision(:'JS_j', '[]')) = 'empty_screens', 'NEGATIVE: a governed revision with no screens is refused');
select pg_temp.check((select outcome from projects.p4ui_start_governed_revision(:'J1_j', '[{"screenKey":"home"}]')) = 'already_delivered', 'a delivered job cannot start a version');
select outcome as o, ref_id as v from projects.p4ui_start_governed_revision(:'JS_j', '[{"screenKey":"home","statesAddressed":["default","empty","error"],"grid":"wider"},{"screenKey":"checkout","statesAddressed":["default","error"]},{"screenKey":"settings","statesAddressed":["default"]}]') \gset G_
select pg_temp.check(:'G_o' = 'revised', 'a governed v5 is created for the confirmed source-UI defect');
select pg_temp.check((select status = 'locked' and version = 4 from projects.ui_versions where id = pg_temp.ver(:'F_id', 4)) and (select screens::text not like '%wider%' from projects.ui_versions where id = pg_temp.ver(:'F_id', 4)), 'the locked v4 is untouched');
select pg_temp.check((select status = 'draft' and version = 5 from projects.ui_versions where id = :'G_v'), 'v5 is an unreviewed draft: it goes through Design QA, Admin and the client from scratch');
select pg_temp.check((select origin = 'source_ui_defect' and activation_reason = 'source_ui_design_defect' and parent_ui_version_id = pg_temp.ver(:'F_id', 4) from projects.p4ui_version_meta where ui_version_id = :'G_v'), 'v5 lineage: source_ui_defect, parent v4');
select pg_temp.check((select state from projects.phase_four where id = :'F_id') = 'ui_design', 'the workspace is back at ui_design');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.ui_version_drafted' and subject_id = :'G_v'), 'the existing ui_version_drafted event fires: Design QA reviews it');
select pg_temp.check((select outcome from projects.p4ui_start_governed_revision(:'JC_j', '[{"screenKey":"home"}]')) = 'source_not_the_locked_latest', 'NEGATIVE: a second post-lock job cannot start from a version that is no longer the locked latest');

-- ═════════ 7. tenancy, read boundary, append-only ═════════
reset role;
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.p4ui_request_design_job(:'F_id', 'prototype_code_bug')) = 'forbidden', 'cross-tenant: another organization cannot activate this workspace');
select pg_temp.check((select outcome from projects.p4ui_record_screen_spec(:'G_v', 'home', '{}')) = 'forbidden', 'cross-tenant: nor write a screen spec');
select pg_temp.check((select count(*) from projects.p4ui_design_jobs where project_id = :'P_id') = 0, 'cross-tenant: nor read the jobs');
select pg_temp.check((select count(*) from projects.p4ui_version_meta where project_id = :'P_id') = 0 and (select count(*) from projects.p4ui_qa_defects where project_id = :'P_id') = 0, 'cross-tenant: nor lineage or defects');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p4ui_design_jobs where project_id = :'P_id') >= 8, 'an internal member reads the project''s jobs, including refusals');
select pg_temp.check(pg_temp.fails_with($q$insert into projects.p4ui_design_jobs (organization_id, project_id, phase_four_id, status, idempotency_key, refused_trigger, refusal_reason, route_to) values ('$q$ || :'ORG' || $q$', '$q$ || :'P_id' || $q$', '$q$ || :'F_id' || $q$', 'refused', 'abcdefabcdefabcdefabcdefabcdefab', 'x', 'x', 'x')$q$, '42501'), 'NEGATIVE: no write policy - a raw insert is refused; the door is the only way in');
reset role;
select pg_temp.check(pg_temp.fails_with($q$update projects.p4ui_revisions set summary = 'rewritten' where project_id = '$q$ || :'P_id' || $q$'$q$, '23001'), 'append-only: a revision record cannot be rewritten');
select pg_temp.check(pg_temp.fails_with($q$delete from projects.p4ui_revisions where project_id = '$q$ || :'P_id' || $q$'$q$, '23001'), 'append-only: nor deleted');
select pg_temp.check((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'projects' and c.relname = any (array['p4ui_design_jobs','p4ui_version_meta','p4ui_revisions','p4ui_screen_specs','p4ui_design_blockers','p4ui_qa_defects','p4ui_feedback_routes','p4ui_post_lock_requests','p4ui_prototype_design_issues']) and t.tgname like 'freeze\_org\_%') = 9, 'all nine p4ui tables carry freeze_organization_id');

rollback;
\echo 'verify-p4ui-ui-designer: PASS'
