-- ═══════════════════════════════════════════════════════════════════════════
-- P4-PM-008/023/024: projects.phase_four_pm_state derives the fifteen PM states from the rows that decide them.
-- Rows are written directly (triggers relaxed for the fixture only: this file tests the READ, the doors that move these rows have their own verifier,
-- verify-phase-four-e2e.sql). Scoped to one project of one organization; rolls back.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-four-pm-state.sql
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
-- the state as the owner sees it
create or replace function pg_temp.st(p uuid) returns text language sql as $$ select pm_state from projects.phase_four_pm_state(p) $$;
grant execute on function pg_temp.st(uuid) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set OWNER '00000000-0000-4000-8000-00000000f541'
\set ORG2 '00000000-0000-4000-8000-0000000000b3'
\set OWNER2 '00000000-0000-4000-8000-00000000f542'
\set CLIENTU '00000000-0000-4000-8000-00000000f543'

insert into auth.users (id, email) values (:'OWNER', 'p4pm-owner@example.test'), (:'OWNER2', 'p4pm-owner2@example.test'), (:'CLIENTU', 'p4pm-client@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4pm-owner@example.test', 'P4 PM Owner'), (:'OWNER2', 'p4pm-owner2@example.test', 'P4 PM Owner Two'), (:'CLIENTU', 'p4pm-client@example.test', 'P4 PM Client') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p4pm other org', 'zztest-p4pm-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4pm client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4pm', 'ZP4-PM') returning id \gset P_

select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.st(:'P_id') = 'READY_TO_START', 'no workspace yet: READY_TO_START');
reset role;

set local session_replication_role = replica;
insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id, state) values (:'ORG', :'P_id', gen_random_uuid(), 'task2_started') returning id \gset F_
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');

-- UI stage: no version, then each status of the latest version
set local role authenticated;
select pg_temp.check(pg_temp.st(:'P_id') = 'WAITING_DESIGN', 'a workspace with no UI version: WAITING_DESIGN');
reset role;
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, screens, qa_reviewed_at)
  values (:'ORG', :'P_id', :'F_id', gen_random_uuid(), 1, 'draft', '[{"screenKey":"home"}]', null) returning id \gset V1_

create or replace function pg_temp.ui(p_id uuid, p_status text) returns text language plpgsql security definer as $$
begin
  update projects.ui_versions set status = p_status, qa_reviewed_at = case when p_status = 'draft' then null else now() end where id = p_id;
  return (select pm_state || '/' || owner from projects.phase_four_pm_state((select project_id from projects.ui_versions where id = p_id)));
end $$;
grant execute on function pg_temp.ui(uuid, text) to public;

set local role authenticated;
select pg_temp.check(pg_temp.ui(:'V1_id', 'draft') = 'WAITING_QA/quality_assurance', 'a drafted UI waits on Design QA (no premature client share)');
select pg_temp.check(pg_temp.ui(:'V1_id', 'qa_changes_required') = 'WAITING_DESIGN/ui_designer', 'QA changes required: back with the Designer');
select pg_temp.check(pg_temp.ui(:'V1_id', 'qa_pass') = 'WAITING_ADMIN/admin', 'QA passed: waiting on the Admin');
select pg_temp.check(pg_temp.ui(:'V1_id', 'admin_edit') = 'WAITING_DESIGN/ui_designer', 'Admin EDIT: back with the Designer');
select pg_temp.check(pg_temp.ui(:'V1_id', 'admin_approved') = 'WAITING_CLIENT_UI/project_manager', 'Admin approved: the PM must share the exact version');
select pg_temp.check(pg_temp.ui(:'V1_id', 'client_review') = 'WAITING_CLIENT_UI/client', 'shared: waiting on the client');
select pg_temp.check(pg_temp.ui(:'V1_id', 'client_change') = 'UI_REVISION/ui_designer', 'the client asked for a change: UI_REVISION');
select pg_temp.check((select blocker is not null from projects.phase_four_pm_state(:'P_id')) = false, 'an ordinary waiting state carries no blocker');
select pg_temp.check(pg_temp.ui(:'V1_id', 'client_approved') = 'WAITING_CLIENT_UI/admin', 'the client approved but the lock is not recorded: the state says so');
reset role;

-- locked UI -> the prototype stage
update projects.ui_versions set status = 'locked' where id = :'V1_id';
set local role authenticated;
select pg_temp.check(pg_temp.st(:'P_id') = 'WAITING_PROTOTYPE', 'locked UI, no build yet: WAITING_PROTOTYPE');
reset role;
insert into projects.deliverables (organization_id, project_id, kind, version, title, status) values (:'ORG', :'P_id', 'prototype', 1, 'zztest prototype', 'draft') returning id \gset D_
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, screens, status) values (:'ORG', :'P_id', :'V1_id', :'D_id', '[{"screenKey":"home"}]', 'draft') returning id \gset B_

create or replace function pg_temp.pr(p_art text, p_del text, p_admin text) returns text language plpgsql security definer as $$
begin
  update projects.prototype_artifacts set status = p_art where id = current_setting('pm.b')::uuid;
  update projects.deliverables set status = p_del where id = current_setting('pm.d')::uuid;
  delete from projects.deliverable_details where deliverable_id = current_setting('pm.d')::uuid;
  if p_admin is not null then
    insert into projects.deliverable_details (deliverable_id, organization_id, project_id, admin_status, admin_decided_at) values (current_setting('pm.d')::uuid, current_setting('pm.o')::uuid, current_setting('pm.p')::uuid, p_admin, now());
  end if;
  return (select pm_state || '/' || owner from projects.phase_four_pm_state(current_setting('pm.p')::uuid));
end $$;
grant execute on function pg_temp.pr(text, text, text) to public;
select set_config('pm.b', :'B_id', false), set_config('pm.d', :'D_id', false), set_config('pm.o', :'ORG', false), set_config('pm.p', :'P_id', false);

set local role authenticated;
select pg_temp.check(pg_temp.pr('draft', 'draft', null) = 'WAITING_PROTOTYPE_QA/quality_assurance', 'a built prototype waits on Prototype QA');
select pg_temp.check(pg_temp.pr('qa_changes_required', 'draft', null) = 'WAITING_PROTOTYPE/ui_prototype', 'QA changes required: back with the Prototype Agent');
select pg_temp.check(pg_temp.pr('qa_pass', 'draft', null) = 'WAITING_ADMIN_PROTOTYPE/admin', 'QA passed: waiting on the Admin');
select pg_temp.check(pg_temp.pr('qa_pass', 'draft', 'changes_required') = 'WAITING_PROTOTYPE/ui_prototype', 'Admin EDIT on the build: back with the Prototype Agent');
select pg_temp.check(pg_temp.pr('qa_pass', 'in_review', 'approved') = 'WAITING_CLIENT_PROTOTYPE/client', 'shared: waiting on the client');
select pg_temp.check(pg_temp.pr('qa_pass', 'changes_requested', 'approved') = 'PROTOTYPE_REVISION/ui_prototype', 'the client asked for a change: PROTOTYPE_REVISION');
select pg_temp.check(pg_temp.pr('qa_pass', 'approved', 'approved') = 'READY_TO_COMPLETE/project_manager', 'the client approved the build: READY_TO_COMPLETE');
reset role;

-- stop states are BLOCKED with the exact blocker, an owner and a resume condition
update projects.phase_four set state = 'revision_limit_escalation', blocked_reason = 'verifier: three rounds used' where id = :'F_id';
set local role authenticated;
select pg_temp.check((select pm_state || '/' || blocker || '/' || (resume_condition is not null)::text from projects.phase_four_pm_state(:'P_id')) = 'BLOCKED/verifier: three rounds used/true', 'a stop state is BLOCKED and names the blocker and how to resume');
reset role;

-- completed: WAITING_M2 until the Admin has verified the payment
update projects.phase_four set state = 'completed', blocked_reason = null, completed_at = now() where id = :'F_id';
set local role authenticated;
select pg_temp.check(pg_temp.st(:'P_id') = 'WAITING_M2', 'completed with no verified M2 payment: WAITING_M2 (Finance owns it)');
reset role;

-- who may ask
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.st(:'P_id') is null, 'NEGATIVE: another organization reads nothing');
reset role;
select pg_temp.as_user(:'CLIENTU', :'ORG', 'client_user');
set local role authenticated;
select pg_temp.check(pg_temp.st(:'P_id') is null, 'NEGATIVE: a client-role caller reads nothing');
reset role;
select set_config('request.jwt.claims', '{}', true);
set local role anon;
select pg_temp.check(not has_function_privilege('anon', 'projects.phase_four_pm_state(uuid)', 'execute'), 'NEGATIVE: anon has no execute');
reset role;

rollback;
\echo 'verify-phase-four-pm-state: all checks passed'
