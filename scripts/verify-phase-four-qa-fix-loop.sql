-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 QA defect flow: QA DEFECT -> DESIGNER FIX -> QA RETEST (FIXED is not VERIFIED), bounded.
--
-- A UI version / prototype build QA sent back is fixed by a NEW version / build that is reviewed from scratch; the
-- fix has its own counter that does not consume the client's revision rounds; at its limit the workspace escalates.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-four-qa-fix-loop.sql
-- Rolls back. Any failed check raises.
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

\set ORG '00000000-0000-4000-8000-000000000001'
\set DESIGNER '00000000-0000-4000-8000-00000000f511'
\set REVIEWER '00000000-0000-4000-8000-00000000f512'

insert into auth.users (id, email) values (:'DESIGNER', 'p4-designer@example.test'), (:'REVIEWER', 'p4-reviewer@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'DESIGNER', 'p4-designer@example.test', 'P4 Designer'), (:'REVIEWER', 'p4-reviewer@example.test', 'P4 Reviewer') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'DESIGNER', 'member'), (:'ORG', :'REVIEWER', 'member') on conflict do nothing;

-- Fixture chain (foreign keys to Phase 3 history are not what is under test, so they are not rebuilt here).
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4 qa client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4 qa', 'ZP4-QA') returning id \gset P_
set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, payload, phase_four_ready, readiness_note)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', false, 'fixture: FK history not rebuilt') returning id \gset H_
insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id) values (:'ORG', :'P_id', :'H_id') returning id \gset F_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 1, 'zztest prototype') returning id \gset D_
set local session_replication_role = origin;


-- The workflows run as the service role.
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);

insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, screens, version)
  values (:'ORG', :'P_id', :'F_id', :'H_id', '[{"key":"home"}]', 1) returning id \gset V1_
select pg_temp.check((select outcome from projects.revise_ui_version(:'F_id', '[{"key":"home","fixed":1}]')) = 'already_revised', 'a draft nobody has reviewed is not revisable (no QA defect yet)');

select projects.record_ui_version_qa_verdict(:'V1_id', 'qa_changes_required', '[{"defect":"home has no empty state"}]');
select pg_temp.check((select status from projects.ui_versions where id = :'V1_id') = 'qa_changes_required', 'Design QA sends the version back');

-- DESIGNER FIX = a new version
select pg_temp.check((select outcome from projects.revise_ui_version(:'F_id', '[{"key":"home","fixed":1}]')) = 'revised', 'the Designer fixes a QA defect: a NEW version is drafted');
select pg_temp.check((select count(*) from projects.ui_versions where phase_four_id = :'F_id') = 2, 'two versions exist: the defective one is not mutated');
select pg_temp.check((select status from projects.ui_versions where phase_four_id = :'F_id' and version = 1) = 'qa_changes_required', 'the old version keeps its verdict');
select pg_temp.check((select status from projects.ui_versions where phase_four_id = :'F_id' and version = 2) = 'draft', 'the fix is a DRAFT: FIXED is not VERIFIED, it needs QA again');
select pg_temp.check((select ui_qa_fix_count from projects.phase_four where id = :'F_id') = 1 and (select ui_revision_count from projects.phase_four where id = :'F_id') = 0, 'the QA fix is counted on its own counter, not the client revision budget');
select pg_temp.check((select outcome from projects.revise_ui_version(:'F_id', '[{"key":"home","fixed":2}]')) = 'already_revised', 'a replayed fix event drafts nothing more');

-- QA RETEST fails again, then the bounded limit
update projects.phase_four set ui_qa_fix_limit = 1 where id = :'F_id';
select projects.record_ui_version_qa_verdict((select id from projects.ui_versions where phase_four_id = :'F_id' and version = 2), 'qa_changes_required', '[{"defect":"still no empty state"}]');
select pg_temp.check((select outcome from projects.revise_ui_version(:'F_id', '[{"key":"home","fixed":3}]')) = 'revision_limit_reached', 'past the QA-fix limit the loop stops');
select pg_temp.check((select state from projects.phase_four where id = :'F_id') = 'revision_limit_escalation', 'the workspace is escalated to a human');
select pg_temp.check((select count(*) from projects.ui_versions where phase_four_id = :'F_id') = 2, 'and no third version was drafted');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.revision_limit_escalated' and subject_id = :'F_id'), 'the escalation reuses the existing announcement event');

-- ── prototype ─────────────────────────────────────────────────────────────
update projects.phase_four set state = 'prototype_build' where id = :'F_id';
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, screens)
  values (:'ORG', :'P_id', :'V1_id', :'D_id', '[{"key":"home"}]') returning id \gset PA_
select projects.record_prototype_qa_verdict(:'PA_id', 'qa_changes_required', '[{"defect":"broken route"}]');
select pg_temp.check((select outcome from projects.revise_prototype_build(:'V1_id', '[{"key":"home","fixed":1}]')) = 'revised', 'the Prototype Agent fixes a QA defect: a NEW build');
select pg_temp.check((select count(*) from projects.prototype_artifacts where ui_version_id = :'V1_id') = 2, 'two builds: the defective one is not mutated');
select pg_temp.check((select status from projects.prototype_artifacts where id = :'PA_id') = 'qa_changes_required', 'the old build keeps its verdict');
select pg_temp.check((select status from projects.deliverables where id = :'D_id') = 'superseded', 'the QA-failed build was never shown to anyone: its deliverable is superseded');
select pg_temp.check((select a.status from projects.prototype_artifacts a join projects.deliverables d on d.id = a.deliverable_id where a.ui_version_id = :'V1_id' and d.version = (select max(version) from projects.deliverables where project_id = :'P_id' and kind = 'prototype') ) = 'draft', 'the new build is a draft needing its own QA: the old pass/fail is not inherited');
select pg_temp.check((select prototype_qa_fix_count from projects.phase_four where id = :'F_id') = 1 and (select prototype_revision_count from projects.phase_four where id = :'F_id') = 0, 'counted on the QA-fix counter, not the client revision budget');
select pg_temp.check((select outcome from projects.revise_prototype_build(:'V1_id', '[{"key":"home","fixed":2}]')) = 'already_revised', 'a replay builds nothing more');
reset role;

rollback;
\echo ALL PHASE 4 QA FIX LOOP CHECKS PASSED
