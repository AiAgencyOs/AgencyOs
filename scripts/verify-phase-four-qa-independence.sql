-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 QA spec, "Creator != Validator", at the database door.
--
-- A person who drafted a UI version or built a prototype cannot record its QA verdict; a different
-- person can; the AI workflow (service role) can; a replay cannot overwrite a verdict.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-four-qa-independence.sql
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

-- ── the designer (a person) drafts: the stamp is theirs ───────────────────
-- (rows are inserted as the table owner with the designer's identity in the claims - the stamp trigger reads auth.uid(); RLS admits writes only through the doors)
select pg_temp.as_user(:'DESIGNER', :'ORG', 'member');
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, screens, version)
  values (:'ORG', :'P_id', :'F_id', :'H_id', '[{"key":"home"}]', 1) returning id \gset V_
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, screens, version)
  values (:'ORG', :'P_id', :'F_id', :'H_id', '[{"key":"home"}]', 2) returning id \gset V2_
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, screens)
  values (:'ORG', :'P_id', :'V_id', :'D_id', '[{"key":"home"}]') returning id \gset PA_
set local role authenticated;
select pg_temp.check((select produced_by from projects.ui_versions where id = :'V_id') = :'DESIGNER', 'a UI version records the person who drafted it');
select pg_temp.check((select produced_by from projects.prototype_artifacts where id = :'PA_id') = :'DESIGNER', 'a prototype build records the person who built it');

select pg_temp.check((select outcome from projects.record_ui_version_qa_verdict(:'V_id', 'qa_pass', '[]')) = 'self_review', 'the drafter cannot pass their own UI version');
select pg_temp.check((select outcome from projects.record_prototype_qa_verdict(:'PA_id', 'qa_pass', '[]')) = 'self_review', 'the builder cannot pass their own prototype');
select pg_temp.check((select status from projects.ui_versions where id = :'V_id') = 'draft', 'the refused UI version is still a draft');
reset role;

-- ── a different person can ────────────────────────────────────────────────
select pg_temp.as_user(:'REVIEWER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.record_ui_version_qa_verdict(:'V_id', 'qa_changes_required', '[{"f":"x"}]')) = 'recorded', 'a different person records the UI verdict');
select pg_temp.check((select outcome from projects.record_ui_version_qa_verdict(:'V_id', 'qa_pass', '[]')) = 'already_reviewed', 'a replay cannot overwrite the verdict');
select pg_temp.check((select outcome from projects.record_prototype_qa_verdict(:'PA_id', 'qa_pass', '[]')) = 'recorded', 'a different person records the prototype verdict');
reset role;

-- ── the AI workflow (service role) still can, and its own draft carries no person ──
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
select pg_temp.check((select outcome from projects.record_ui_version_qa_verdict(:'V2_id', 'qa_pass', '[]')) = 'recorded', 'the quality_assurance workflow (service role) records a verdict');
reset role;

rollback;
\echo ALL PHASE 4 QA INDEPENDENCE CHECKS PASSED
