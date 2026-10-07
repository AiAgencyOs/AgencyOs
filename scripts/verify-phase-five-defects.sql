-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 Bug Fix spec: FIX_READY != VERIFIED; the fixer does not verify their own fix; a fix claim does not lift the gate;
-- cannot-reproduce / needs-evidence are explicit states, never a silent close.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-five-defects.sql      (rolls back)
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
-- a statement that must be refused, and the refusal must be the guard's
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set DEV '00000000-0000-4000-8000-00000000f531'
\set QA '00000000-0000-4000-8000-00000000f532'
insert into auth.users (id, email) values (:'DEV', 'p5d-dev@example.test'), (:'QA', 'p5d-qa@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'DEV', 'p5d-dev@example.test', 'P5 Dev'), (:'QA', 'p5d-qa@example.test', 'P5 QA') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'DEV', 'member'), (:'ORG', :'QA', 'member') on conflict do nothing;
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p5 defects client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p5 defects', 'ZP5-DEF') returning id \gset P_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'build', 1, 'zztest build') returning id \gset D_
insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by)
  values (:'ORG', :'P_id', :'D_id', 'blocker', 'checkout crashes', 'tap pay', :'QA') returning id \gset X_
insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by)
  values (:'ORG', :'P_id', :'D_id', 'major', 'cannot repro', 'n/a', :'QA') returning id \gset Y_

select pg_temp.check((select count(*) from qa.blocking_defects(:'D_id')) = 2, 'an open blocker and an open major block the build');

-- the developer claims the fix: FIX_READY
select pg_temp.as_user(:'DEV', :'ORG', 'member');
update qa.defects set status = 'fixed', resolution = 'null check added' where id = :'X_id';
select pg_temp.check((select fixed_by from qa.defects where id = :'X_id') = :'DEV', 'the fix claim records who made it');
select pg_temp.check((select count(*) from qa.blocking_defects(:'D_id')) = 2, 'FIX_READY does NOT lift the gate: the blocker still blocks until verified');

-- the fixer cannot verify; nobody can verify in someone else's name
select pg_temp.check(pg_temp.refused(format('update qa.defects set status = ''verified'', verified_by = %L, verified_at = now() where id = %L', :'DEV', :'X_id'), 'FIX_READY is not VERIFIED'), 'the fixer cannot verify their own fix');
select pg_temp.check(pg_temp.refused(format('update qa.defects set status = ''verified'', verified_by = %L, verified_at = now() where id = %L', :'QA', :'X_id'), 'not by someone named'), 'a verification cannot be filed in another person''s name');

-- independent retest FAILS: reopened, claim cleared
select pg_temp.as_user(:'QA', :'ORG', 'member');
update qa.defects set status = 'open' where id = :'X_id';
select pg_temp.check((select fixed_by is null and verified_by is null from qa.defects where id = :'X_id'), 'a failed retest REOPENS the defect and clears the fix claim');

-- second fix, independent pass
select pg_temp.as_user(:'DEV', :'ORG', 'member');
update qa.defects set status = 'fixed', resolution = 'second fix' where id = :'X_id';
select pg_temp.as_user(:'QA', :'ORG', 'member');
update qa.defects set status = 'verified', verified_by = :'QA', verified_at = now() where id = :'X_id';
select pg_temp.check((select status from qa.defects where id = :'X_id') = 'verified', 'an independent person verifies the second fix');
select pg_temp.check((select count(*) from qa.blocking_defects(:'D_id')) = 1, 'only the verified blocker stops blocking');

-- cannot reproduce is explicit, still blocks, and goes back to open
update qa.defects set status = 'not_reproduced', resolution = 'could not reproduce on build 1' where id = :'Y_id';
select pg_temp.check((select count(*) from qa.blocking_defects(:'D_id')) = 1, 'NOT_REPRODUCED is not a silent close: the major still blocks');
update qa.defects set status = 'open' where id = :'Y_id';
update qa.defects set status = 'needs_evidence', resolution = 'need the device log' where id = :'Y_id';
select pg_temp.check((select status from qa.defects where id = :'Y_id') = 'needs_evidence', 'NEEDS_EVIDENCE is its own state, with its reason');
select pg_temp.check(pg_temp.refused(format('update qa.defects set status = ''verified'', verified_by = %L, verified_at = now() where id = %L', :'QA', :'Y_id'), 'does not move'), 'an unreproduced / evidence-less defect cannot jump to verified');

rollback;
\echo ALL PHASE 5 DEFECT CHECKS PASSED
