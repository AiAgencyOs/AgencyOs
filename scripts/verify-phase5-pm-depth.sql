-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 PM depth: the client build share, revision rounds and the allowance. Driven through the REAL doors on a scratch Postgres.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase5-pm-depth.sql          (rolls back)
--
-- Red-proofs: pass -v MUTATE_SQL="drop trigger ..." (raw statement run after the fixture) or
-- -v MUTATE_FN="projects.fn(args)" -v MUTATE_FROM="text" -v MUTATE_TO="text" (the live function with one snippet replaced; a replacement that
-- changes nothing RAISES). The mutated run must FAIL.
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

-- act as a user (authenticated + JWT claims) or as the service role; always from a clean role
create or replace function pg_temp.act(p_sub uuid, p_role text, p_client_account uuid default null) returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_strip_nulls(jsonb_build_object('organization_id', '00000000-0000-4000-8000-000000000001', 'role', p_role, 'client_account_id', p_client_account)))::text, true);
  execute 'set local role authenticated';
end $$;
grant execute on function pg_temp.act(uuid, text, uuid) to public;
create or replace function pg_temp.service() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  execute 'set local role service_role';
end $$;
grant execute on function pg_temp.service() to public;
create or replace function pg_temp.root() returns void language plpgsql as $$ begin execute 'reset role'; end $$;
grant execute on function pg_temp.root() to public;
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation or unique_violation then return position(needle in sqlerrm) > 0 or needle = ''; end $$;
grant execute on function pg_temp.refused(text, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set OWNER '00000000-0000-4000-8000-00000000f541'
\set BUILDER '00000000-0000-4000-8000-00000000f542'
\set OPS '00000000-0000-4000-8000-00000000f543'
\set LEAD '00000000-0000-4000-8000-00000000f544'
\set MEMBER '00000000-0000-4000-8000-00000000f545'
\set CLIENTU '00000000-0000-4000-8000-00000000f546'
\set CLIENT2U '00000000-0000-4000-8000-00000000f547'

insert into auth.users (id, email) values (:'OWNER', 'pd-owner@example.test'), (:'BUILDER', 'pd-builder@example.test'), (:'OPS', 'pd-ops@example.test'), (:'LEAD', 'pd-lead@example.test'),
  (:'MEMBER', 'pd-member@example.test'), (:'CLIENTU', 'pd-client@example.test'), (:'CLIENT2U', 'pd-client2@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'pd-owner@example.test', 'PD Owner'), (:'BUILDER', 'pd-builder@example.test', 'PD Builder'), (:'OPS', 'pd-ops@example.test', 'PD Ops'),
  (:'LEAD', 'pd-lead@example.test', 'PD Lead'), (:'MEMBER', 'pd-member@example.test', 'PD Member'), (:'CLIENTU', 'pd-client@example.test', 'PD Client'), (:'CLIENT2U', 'pd-client2@example.test', 'PD Client 2') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'BUILDER', 'member'), (:'ORG', :'OPS', 'ops_admin'),
  (:'ORG', :'LEAD', 'delivery_lead'), (:'ORG', :'MEMBER', 'member') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest pd client') returning id \gset CA_
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest pd other client') returning id \gset CB_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'CA_id', 'zztest pd', 'ZPD-1') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'CB_id', 'zztest pd other', 'ZPD-2') returning id \gset Q_
insert into projects.modules (organization_id, project_id, name) values (:'ORG', :'P_id', 'zztest module') returning id \gset M_
insert into projects.features (organization_id, project_id, module_id, name) values (:'ORG', :'P_id', :'M_id', 'zztest checkout') returning id \gset F1_
insert into projects.features (organization_id, project_id, module_id, name) values (:'ORG', :'P_id', :'M_id', 'zztest cart') returning id \gset F2_
insert into projects.modules (organization_id, project_id, name) values (:'ORG', :'Q_id', 'zztest other module') returning id \gset MQ_
insert into projects.features (organization_id, project_id, module_id, name) values (:'ORG', :'Q_id', :'MQ_id', 'zztest foreign feature') returning id \gset FQ_
-- the Phase 5 workspace and two change requests (fixtures: the upstream phases are not what is under test, so their FKs are not enforced here)
set local session_replication_role = replica;
insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id) values (:'ORG', :'P_id', gen_random_uuid()) returning id \gset P4_
insert into projects.phase_five (organization_id, project_id, phase_four_id, state) values (:'ORG', :'P_id', :'P4_id', 'in_development') returning id \gset PF_
insert into projects.change_requests (organization_id, project_id, scope_version_id, requested, classification, status) values (:'ORG', :'P_id', gen_random_uuid(), 'zztest add wishlist', 'free_change', 'approved') returning id \gset CRA_
insert into projects.change_requests (organization_id, project_id, scope_version_id, requested, status) values (:'ORG', :'P_id', gen_random_uuid(), 'zztest maybe later', 'submitted') returning id \gset CRS_
insert into projects.change_requests (organization_id, project_id, scope_version_id, requested, classification, status) values (:'ORG', :'Q_id', gen_random_uuid(), 'zztest foreign cr', 'free_change', 'approved') returning id \gset CRQ_
set local session_replication_role = origin;

-- a build taken through the real doors as far as `stage` says: draft | details | run | smoke | qa | approved
create or replace function pg_temp.mk_build(p_title text, p_number text, p_commit text, p_sha text, p_stage text, p_project uuid default null) returns uuid
language plpgsql as $$
declare v_id uuid; v_p uuid := coalesce(p_project, current_setting('pd.p')::uuid);
begin
  perform pg_temp.service();
  select deliverable_id into v_id from projects.add_deliverable(v_p, 'build', p_title, 'https://builds.example.test/' || p_number, 'initial', null, '00000000-0000-4000-8000-00000000f542', null, null);
  if p_stage = 'draft' then perform pg_temp.root(); return v_id; end if;
  perform pg_temp.act('00000000-0000-4000-8000-00000000f541', 'owner');
  perform projects.set_deliverable_details(v_id, 'web', p_commit, p_number, null, null);
  if p_stage = 'details' then perform pg_temp.root(); return v_id; end if;
  perform pg_temp.service();
  perform projects.record_build_run(v_id, 'review', 'succeeded', null, '[{"name":"build","status":"ok"},{"name":"artifact_verify","status":"ok"}]', '{"os":"linux","node":"22"}', p_sha, null, null, 'https://ci.example.test/' || p_number);
  if p_stage = 'run' then perform pg_temp.root(); return v_id; end if;
  perform projects.record_smoke_check(v_id, 'not_tested', '[]', null, 'a web build with no launch test: no device lab is bound');
  if p_stage = 'smoke' then perform pg_temp.root(); return v_id; end if;
  perform pg_temp.act('00000000-0000-4000-8000-00000000f543', 'ops_admin');
  perform projects.record_build_qa_verdict(v_id, 'passed', 'regression green');
  if p_stage = 'qa' then perform pg_temp.root(); return v_id; end if;
  perform pg_temp.act('00000000-0000-4000-8000-00000000f541', 'owner');
  perform projects.decide_build_admin(v_id, 'approved', 'ok');
  perform pg_temp.root();
  return v_id;
end $$;
grant execute on function pg_temp.mk_build(text, text, text, text, text, uuid) to public;
select set_config('pd.p', :'P_id', false);
select set_config('pd.q', :'Q_id', false);

-- ═════════ the live-definition mutation hook (red-proofs) ═════════
\if :{?MUTATE_SQL}
  select pg_temp.root();
  :MUTATE_SQL
  \echo >>> mutated with raw SQL
\endif
\if :{?MUTATE_FN}
  create or replace function pg_temp.mutate(p_fn text, p_from text, p_to text) returns void language plpgsql as $$
  declare d text; n text;
  begin
    d := pg_get_functiondef(p_fn::regprocedure);
    n := replace(d, p_from, p_to);
    if n = d then raise exception 'MUTATION CHANGED NOTHING: % has no "%"', p_fn, p_from; end if;
    execute n;
  end $$;
  select pg_temp.mutate(:'MUTATE_FN', :'MUTATE_FROM', :'MUTATE_TO');
  \echo >>> mutated function
\endif

-- ═════════ 1. the client build share ═════════
select pg_temp.mk_build('zztest build A', 'pd-1', 'aaa1111', repeat('a', 64), 'approved') as "A" \gset
select pg_temp.mk_build('zztest build NOSMOKE', 'pd-2', 'bbb2222', repeat('b', 64), 'run') as "NS" \gset
select pg_temp.mk_build('zztest build NOQA', 'pd-3', 'ccc3333', repeat('c', 64), 'smoke') as "NQ" \gset
select pg_temp.mk_build('zztest build NORUN', 'pd-4', 'ddd4444', null, 'details') as "NR" \gset
select pg_temp.mk_build('zztest build NOADMIN', 'pd-5', 'eee5555', repeat('e', 64), 'qa') as "NA" \gset

-- who may share: a delivery manager (owner, ops_admin, delivery_lead); a member who only writes may not; a client may not
select pg_temp.act(:'MEMBER', 'member');
select pg_temp.check((select outcome from projects.share_build_with_client(:'A', 'Web', 'https://review.example.test/a', 'Open the link and sign in with the demo account.')) = 'not_authorized', 'a member cannot share a build with the client');
select pg_temp.act(:'CLIENTU', 'client_member', :'CA_id');
select pg_temp.check((select outcome from projects.share_build_with_client(:'A', 'Web', 'https://review.example.test/a', 'x')) = 'not_authorized', 'a portal client cannot share a build');

select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.share_build_with_client(:'A', '', 'https://review.example.test/a', 'x')) = 'platform_required', 'the review platform is required');
select pg_temp.check((select outcome from projects.share_build_with_client(:'A', 'Web', 'http://review.example.test/a', 'x')) = 'url_must_be_https', 'the review URL must be https');
select pg_temp.check((select outcome from projects.share_build_with_client(:'A', 'Web', 'https://review.example.test/a', '   ')) = 'instructions_required', 'testing instructions are required');
select pg_temp.check((select outcome from projects.share_build_with_client(gen_random_uuid(), 'Web', 'https://review.example.test/a', 'x')) = 'not_found', 'an unknown build is not found');
select pg_temp.check((select outcome from projects.share_build_with_client(:'NS', 'Web', 'https://review.example.test/ns', 'x')) = 'not_admin_approved', 'a build the Admin has not approved is not shared');
select pg_temp.check((select outcome from projects.share_build_with_client(:'NQ', 'Web', 'https://review.example.test/nq', 'x')) = 'not_admin_approved', 'a build QA has not passed is not shared');
select pg_temp.check((select outcome from projects.share_build_with_client(:'NA', 'Web', 'https://review.example.test/na', 'x')) = 'not_admin_approved', 'a QA-passed build with no Admin decision is not shared');

-- QA-passed and approved but the other gates missing: build the rows directly so each gate is tested on its own
select pg_temp.root();
update projects.deliverable_details set qa_status = 'passed', qa_decided_at = now(), qa_decided_by = :'OPS' where deliverable_id = :'NS';
update projects.deliverable_details set admin_status = 'approved', admin_decided_at = now(), admin_decided_by = :'OWNER' where deliverable_id in (:'NS', :'NR');
select pg_temp.check((select admin_approved_commit from projects.deliverable_details where deliverable_id = :'NS') = 'bbb2222', 'the Admin approval stamps the commit it approved');
select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.share_build_with_client(:'NS', 'Web', 'https://review.example.test/ns', 'x')) = 'no_smoke', 'a build with no smoke verdict on its commit is not shared');
select pg_temp.check((select outcome from projects.share_build_with_client(:'NR', 'Web', 'https://review.example.test/nr', 'x')) = 'not_qa_passed', 'a build that did not pass QA is not shared (no run, no QA)');
select pg_temp.root();
update projects.deliverable_details set qa_status = 'passed', qa_decided_at = now(), qa_decided_by = :'OPS' where deliverable_id = :'NR';
insert into projects.build_smoke_checks (organization_id, project_id, deliverable_id, commit_ref, result, reason) values (:'ORG', :'P_id', :'NR', 'ddd4444', 'not_tested', 'no device lab');
select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.share_build_with_client(:'NR', 'Web', 'https://review.example.test/nr', 'x')) = 'no_build_run', 'a build with no succeeded run on its commit is not shared');

-- a blocker that is still open stops the share
select pg_temp.root();
insert into projects.build_blockers (organization_id, project_id, deliverable_id, blocker_type, resume_condition) values (:'ORG', :'P_id', :'A', 'environment_missing', 'bind an environment');
select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.share_build_with_client(:'A', 'Web', 'https://review.example.test/a', 'x')) = 'open_blocker', 'an open build blocker stops the share');
select pg_temp.root();
update projects.build_blockers set status = 'resolved', resolved_at = now() where deliverable_id = :'A';

-- the commit moved after the Admin approved it. The ordinary route resets the approval (an earlier control) and the share refuses;
-- the share door ALSO compares the commit to the one the approval stamped, so a bypass of that reset (simulated with replica mode) still refuses
select pg_temp.root();
update projects.deliverable_details set commit_ref = 'zzz9999' where deliverable_id = :'A';
select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.share_build_with_client(:'A', 'Web', 'https://review.example.test/a', 'x')) = 'not_admin_approved', 'an ordinary commit change drops the approval, so the build is not shared');
select pg_temp.root();
update projects.deliverable_details set commit_ref = 'aaa1111' where deliverable_id = :'A';
select pg_temp.check((select admin_status = 'pending' from projects.deliverable_details where deliverable_id = :'A'), 'the approval was dropped by the commit change and does not come back by itself');
update projects.deliverable_details set qa_status = 'passed', qa_decided_at = now(), qa_decided_by = :'OPS' where deliverable_id = :'A';
update projects.deliverable_details set admin_status = 'approved', admin_decided_at = now(), admin_decided_by = :'OWNER' where deliverable_id = :'A';
set local session_replication_role = replica;
update projects.deliverable_details set commit_ref = 'zzz9999' where deliverable_id = :'A';
set local session_replication_role = origin;
select pg_temp.check((select admin_status = 'approved' and admin_approved_commit = 'aaa1111' and commit_ref = 'zzz9999' from projects.deliverable_details where deliverable_id = :'A'), 'fixture: an approved build whose commit moved without the reset');
select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.share_build_with_client(:'A', 'Web', 'https://review.example.test/a', 'x')) = 'commit_changed_since_approval', 'a commit that is not the Admin-approved commit is not shared');
select pg_temp.root();
set local session_replication_role = replica;
update projects.deliverable_details set commit_ref = 'aaa1111' where deliverable_id = :'A';
set local session_replication_role = origin;

-- the succeeded run must be ON the commit that is shared: an approved, QA-passed, smoke-checked build whose only run is for an older commit
select pg_temp.mk_build('zztest build OLDRUN', 'pd-7', 'hhh7777', repeat('d', 64), 'approved') as "OR" \gset
select pg_temp.root();
set local session_replication_role = replica;
update projects.deliverable_details set commit_ref = 'ggg8888', admin_approved_commit = 'ggg8888' where deliverable_id = :'OR';
set local session_replication_role = origin;
insert into projects.build_smoke_checks (organization_id, project_id, deliverable_id, commit_ref, result, reason) values (:'ORG', :'P_id', :'OR', 'ggg8888', 'not_tested', 'no device lab');
select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.share_build_with_client(:'OR', 'Web', 'https://review.example.test/or', 'x')) = 'no_build_run', 'a build whose only succeeded run is for another commit is not shared');

-- the happy path
select pg_temp.act(:'LEAD', 'delivery_lead');
select outcome as o, share_id as s from projects.share_build_with_client(:'A', 'Web', 'https://review.example.test/a', 'Open the link and sign in with the demo account.') \gset S1_
select pg_temp.check(:'S1_o' = 'shared', 'the exact approved, QA-passed, smoke-checked, built commit is shared');
select pg_temp.check((select s.commit_ref = 'aaa1111' and s.artifact_sha256 = repeat('a', 64) and s.label = 'Development review build, not production' and s.delivery_state = 'pending' and s.shared_by = :'LEAD'
                       and s.build_run_id = (select r.id from projects.build_runs r where r.deliverable_id = :'A' and r.status = 'succeeded') from projects.client_build_shares s where s.id = :'S1_s'),
  'the share records the exact commit, the artifact hash of the succeeded run, the run, the label, the sharer and a pending delivery');
select pg_temp.check((select outcome from projects.share_build_with_client(:'A', 'Web', 'https://review.example.test/a', 'again')) = 'already_shared', 'one share per build and commit: a retry returns the existing share');
select pg_temp.check((select share_id from projects.share_build_with_client(:'A', 'Web', 'https://review.example.test/a', 'again')) = :'S1_s', 'the retry names the same share');
select pg_temp.check((select count(*) from projects.client_build_shares where deliverable_id = :'A') = 1, 'exactly one share row exists');
select pg_temp.root();
select pg_temp.check(exists (select 1 from audit.audit_log where action = 'build.client_share_recorded' and subject_id = :'A'), 'the share is audited');

-- append-only: the share is never rewritten or deleted; the unique key holds
select pg_temp.check(pg_temp.refused(format('update projects.client_build_shares set review_url = ''https://elsewhere.example.test/x'' where id = %L', :'S1_s'), 'never rewritten'), 'a share''s URL cannot be rewritten');
select pg_temp.check(pg_temp.refused(format('update projects.client_build_shares set commit_ref = ''fff0000'' where id = %L', :'S1_s'), 'never rewritten'), 'a share''s commit cannot be rewritten');
select pg_temp.check(pg_temp.refused(format('delete from projects.client_build_shares where id = %L', :'S1_s'), 'never deleted'), 'a share cannot be deleted');
select pg_temp.check(pg_temp.refused(format('update projects.client_build_shares set label = ''Production'' where id = %L', :'S1_s'), ''), 'the label is fixed');
do $$ begin
  begin
    insert into projects.client_build_shares (organization_id, project_id, deliverable_id, build_run_id, commit_ref, artifact_sha256, review_platform, review_url, testing_instructions)
    select organization_id, project_id, deliverable_id, build_run_id, commit_ref, artifact_sha256, review_platform, review_url, testing_instructions from projects.client_build_shares limit 1;
    raise exception 'FAILED: a second share for the same build and commit was inserted';
  exception when unique_violation then raise notice 'ok  the table itself holds one share per (build, commit)'; end;
end $$;
-- a direct write by an authenticated user is not a door
select pg_temp.act(:'OWNER', 'owner');
select pg_temp.check(not has_table_privilege('authenticated', 'projects.client_build_shares', 'insert') and not has_table_privilege('authenticated', 'projects.client_build_shares', 'update'), 'authenticated has no direct write on shares');

-- the client sees nothing until staff relay it
select pg_temp.act(:'CLIENTU', 'client_member', :'CA_id');
select pg_temp.check((select count(*) from projects.client_build_shares_for_client(:'P_id')) = 0, 'a pending share is invisible to the client');
select pg_temp.check((select count(*) from projects.client_build_shares) = 0, 'a client cannot read the share table');
-- delivery
select pg_temp.act(:'MEMBER', 'member');
select pg_temp.check((select outcome from projects.record_build_share_delivery(:'S1_s', 'relayed')) = 'not_authorized', 'a member cannot record delivery');
select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.record_build_share_delivery(:'S1_s', 'pending')) = 'bad_state', 'pending is not a delivery outcome');
select pg_temp.check((select outcome from projects.record_build_share_delivery(:'S1_s', 'failed', 'the client did not receive the WhatsApp message')) = 'recorded', 'a failed relay is recorded honestly');
select pg_temp.act(:'CLIENTU', 'client_member', :'CA_id');
select pg_temp.check((select count(*) from projects.client_build_shares_for_client(:'P_id')) = 0, 'a failed relay is invisible to the client');
select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.record_build_share_delivery(:'S1_s', 'relayed', 'sent by the delivery lead')) = 'recorded', 'a relayed share is recorded');
select pg_temp.check((select outcome from projects.record_build_share_delivery(:'S1_s', 'failed')) = 'already_recorded', 'a relayed share does not move back');
select pg_temp.act(:'CLIENTU', 'client_member', :'CA_id');
select pg_temp.check((select count(*) from projects.client_build_shares_for_client(:'P_id')) = 1, 'the client now reads the relayed share');
select pg_temp.check((select string_agg(v.value, ' ') from projects.client_build_shares_for_client(:'P_id') c, json_each_text(row_to_json(c)) v) !~* 'aaa1111|[0-9a-f]{40,}|[0-9a-f]{8}-[0-9a-f]{4}-', 'the client-safe values carry no commit, hash or internal id');
select pg_temp.check(pg_get_function_result('projects.client_build_shares_for_client(uuid)'::regprocedure) !~* 'commit|artifact|run_id|_by|note|deliverable_id|share_id', 'the client-safe read declares no commit, artifact, run, actor, note or id column');
select pg_temp.check((select c.label = 'Development review build, not production' and c.review_platform = 'Web' and c.review_url = 'https://review.example.test/a' and c.build_version = 1 from projects.client_build_shares_for_client(:'P_id') c), 'the client reads the label, platform, url, instructions and version');
select pg_temp.check((select count(*) from projects.client_build_shares_for_client(:'Q_id')) = 0, 'a client reads nothing of another client''s project');
select pg_temp.act(:'CLIENT2U', 'client_member', :'CB_id');
select pg_temp.check((select count(*) from projects.client_build_shares_for_client(:'P_id')) = 0, 'another client account reads nothing of this project');

-- a new commit is a new share, and the old share stays
select pg_temp.root();
select pg_temp.mk_build('zztest build B', 'pd-6', 'bbb6666', repeat('f', 64), 'approved') as "B" \gset
select pg_temp.act(:'OWNER', 'owner');
select pg_temp.check((select outcome from projects.share_build_with_client(:'B', 'Web', 'https://review.example.test/b', 'Test the revised checkout.')) = 'shared', 'an owner shares the revised build');
select pg_temp.root();
select pg_temp.check((select count(*) from projects.client_build_shares where project_id = :'P_id') = 2, 'the first share is preserved beside the second');

-- ═════════ 2. revision rounds and the allowance ═════════
select pg_temp.mk_build('zztest rev 1', 'pd-r1', 'r111111', repeat('1', 64), 'draft') as "R1" \gset
select pg_temp.mk_build('zztest rev 2', 'pd-r2', 'r222222', repeat('2', 64), 'draft') as "R2" \gset
select pg_temp.mk_build('zztest rev 3', 'pd-r3', 'r333333', repeat('3', 64), 'draft') as "R3" \gset
select pg_temp.mk_build('zztest rev 4', 'pd-r4', 'r444444', repeat('4', 64), 'draft') as "R4" \gset
select pg_temp.mk_build('zztest rev 5', 'pd-r5', 'r555555', repeat('5', 64), 'draft') as "R5" \gset
select pg_temp.mk_build('zztest rev 6', 'pd-r6', 'r666666', repeat('6', 64), 'draft') as "R6" \gset
select pg_temp.mk_build('zztest rev 7', 'pd-r7', 'r777777', repeat('7', 64), 'draft') as "R7" \gset
select pg_temp.mk_build('zztest foreign build', 'pd-q1', 'q111111', repeat('9', 64), 'draft', :'Q_id') as "QB" \gset

select pg_temp.act(:'CLIENTU', 'client_member', :'CA_id');
select pg_temp.check((select count(*) from projects.build_revision_allowance(:'P_id')) = 0, 'a client reads no allowance');
select pg_temp.check((select count(*) from projects.build_revision_timeline(:'P_id')) = 0, 'a client reads no revision timeline');
select pg_temp.check((select count(*) from projects.build_revisions) = 0 and (select count(*) from projects.build_revision_escalations) = 0, 'a client reads no revision table');
select pg_temp.act(:'MEMBER', 'member');
select pg_temp.check((select rounds_used = 0 and round_limit = 3 and remaining = 3 and not exceeded from projects.build_revision_allowance(:'P_id')), 'the allowance starts at 0 of 3');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'whim', :'A', :'R1', 'x')) = 'bad_origin', 'an unknown origin is refused');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'A', :'R1', '  ')) = 'reason_required', 'a revision names why');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'A', :'QB', 'x')) = 'build_not_on_project', 'a build of another project is refused');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'R1', :'A', 'x')) = 'not_a_later_build', 'the to-build must be later than the from-build');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'A', :'R1', 'x', array[:'FQ_id']::uuid[])) = 'feature_not_on_project', 'a feature of another project is refused');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'A', :'R1', 'x', '{}', :'CRA_id')) = 'change_request_only_for_approved_change', 'a change request belongs only to an approved-change revision');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'approved_change_request', :'A', :'R1', 'x')) = 'change_request_not_approved', 'an approved-change revision names its change request');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'approved_change_request', :'A', :'R1', 'x', '{}', :'CRS_id')) = 'change_request_not_approved', 'a change request that is not approved is refused');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'approved_change_request', :'A', :'R1', 'x', '{}', :'CRQ_id')) = 'change_request_not_approved', 'a change request of another project is refused');

-- an approved change request does NOT consume the allowance
select outcome as o, revision_id as r, rounds_used as u from projects.record_build_revision(:'P_id', 'approved_change_request', :'A', :'R1', 'The client paid for a wishlist.', array[:'F1_id']::uuid[], :'CRA_id') \gset V1_
select pg_temp.check(:'V1_o' = 'recorded' and :'V1_u' = 0, 'an approved Change Request round is recorded and spends nothing');
select pg_temp.check((select rounds_used = 0 and remaining = 3 from projects.build_revision_allowance(:'P_id')), 'the derived count still reads 0 of 3');
-- an Admin edit and a QA correction do not consume it either
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'admin', :'R1', :'R2', 'The Admin asked for a copy change before the client saw it.')) = 'recorded', 'an Admin revision is recorded');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'qa_correction', :'R2', :'R3', 'QA found a missed requirement: the agency corrects it.', array[:'F2_id']::uuid[])) = 'recorded', 'a QA correction is recorded');
select pg_temp.check((select rounds_used = 0 and not exceeded from projects.build_revision_allowance(:'P_id')), 'Admin, QA-correction and approved-change rounds spend no allowance');
select pg_temp.check((select count(*) from projects.build_revisions where project_id = :'P_id' and not consumes_allowance) = 3, 'three non-consuming rounds are on the record');
-- idempotent: the same to-build records once
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'R2', :'R3', 'the client again')) = 'already_recorded', 'a to-build is recorded once: a retry does not open a second round');
-- the row rule, on its own
select pg_temp.root();
select pg_temp.check(pg_temp.refused(format('insert into projects.build_revisions (organization_id, project_id, round_number, origin, from_deliverable_id, to_deliverable_id, consumes_allowance, reason) values (%L, %L, 90, ''admin'', %L, %L, true, ''x'')', :'ORG', :'P_id', :'R3', :'R4'), ''), 'the table refuses an Admin revision that claims to consume the allowance');
select pg_temp.check(pg_temp.refused(format('insert into projects.build_revisions (organization_id, project_id, round_number, origin, from_deliverable_id, to_deliverable_id, consumes_allowance, reason) values (%L, %L, 91, ''client'', %L, %L, false, ''x'')', :'ORG', :'P_id', :'R3', :'R4'), ''), 'the table refuses a client revision that claims it is free');
select pg_temp.check(pg_temp.refused(format('update projects.build_revisions set reason = ''rewritten'' where id = %L', :'V1_r'), 'never rewritten'), 'a recorded round is never rewritten');
select pg_temp.check(pg_temp.refused(format('delete from projects.build_revisions where id = %L', :'V1_r'), 'never rewritten'), 'a recorded round is never deleted');

select pg_temp.check(pg_temp.refused(format('insert into projects.build_revisions (organization_id, project_id, round_number, origin, from_deliverable_id, to_deliverable_id, consumes_allowance, reason) values (%L, %L, 92, ''approved_change_request'', %L, %L, false, ''x'')', :'ORG', :'P_id', :'R3', :'R4'), ''), 'the table refuses an approved-change revision that names no change request');
select pg_temp.check(pg_temp.refused(format('insert into projects.build_revisions (organization_id, project_id, round_number, origin, from_deliverable_id, to_deliverable_id, consumes_allowance, reason, change_request_id) values (%L, %L, 93, ''qa_correction'', %L, %L, false, ''x'', %L)', :'ORG', :'P_id', :'R3', :'R4', :'CRA_id'), ''), 'the table refuses a change request on a revision that is not an approved change');
-- the client's own rounds spend the allowance: three included
select pg_temp.act(:'MEMBER', 'member');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'R3', :'R4', 'The client wants a different button colour.', array[:'F1_id']::uuid[])) = 'recorded', 'client round 1');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'R4', :'R5', 'The client wants the cart reordered.')) = 'recorded', 'client round 2');
select pg_temp.check((select rounds_used = 2 and remaining = 1 and not exceeded from projects.build_revision_allowance(:'P_id')), 'two of three client rounds are spent');
select outcome as o, rounds_used as u, round_limit as l from projects.record_build_revision(:'P_id', 'client', :'R5', :'R6', 'The client wants the header changed.') \gset V3_
select pg_temp.check(:'V3_o' = 'recorded' and :'V3_u' = 3 and :'V3_l' = 3, 'client round 3 is the last included one');
select pg_temp.check((select rounds_used = 3 and remaining = 0 and exceeded from projects.build_revision_allowance(:'P_id')), 'the allowance is exhausted');
-- the 4th client round is not opened: a person decides
select pg_temp.root();
select count(*) as ev0 from core.outbox_events where type = 'project.revision_limit_escalated' and subject_id = :'PF_id' \gset
select pg_temp.act(:'MEMBER', 'member');
select outcome as o, revision_id as e, rounds_used as u, round_limit as l from projects.record_build_revision(:'P_id', 'client', :'R6', :'R7', 'A fourth change from the client.') \gset V4_
select pg_temp.check(:'V4_o' = 'revision_limit_reached' and :'V4_u' = 3, 'the fourth client round is not opened: it is escalated');
select pg_temp.check(not exists (select 1 from projects.build_revisions where to_deliverable_id = :'R7'), 'no round was recorded for the escalated request');
select pg_temp.check((select count(*) from projects.build_revision_escalations where project_id = :'P_id' and status = 'open' and rounds_used = 3 and round_limit = 3) = 1, 'one open escalation names the count and the limit');
select pg_temp.root();
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.revision_limit_escalated' and subject_id = :'PF_id') = :'ev0' + 1, 'the escalation emits the revision-limit event the team is told by');
select pg_temp.check((select (payload ->> 'revisionCount')::int = 3 and (payload ->> 'revisionLimit')::int = 3 from core.outbox_events where type = 'project.revision_limit_escalated' and subject_id = :'PF_id' order by created_at desc limit 1), 'the event carries the count and the limit');
select pg_temp.root();
select pg_temp.check(pg_temp.refused(format('insert into projects.build_revision_escalations (organization_id, project_id, rounds_used, round_limit, requested_reason) values (%L, %L, 3, 3, ''a second open one'')', :'ORG', :'P_id'), ''), 'the table holds one open escalation per project');
select pg_temp.act(:'MEMBER', 'member');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'R6', :'R7', 'asking again')) = 'escalated_awaiting_decision', 'while a decision is waiting no further client round opens');
select pg_temp.root();
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.revision_limit_escalated' and subject_id = :'PF_id') = :'ev0' + 1, 'the waiting escalation does not re-announce itself');
-- but a non-consuming revision still records (the agency may always correct its own work)
select pg_temp.act(:'MEMBER', 'member');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'qa_correction', :'R6', :'R7', 'QA found a regression: the agency fixes it.')) = 'recorded', 'a QA correction records past the limit and spends nothing');
select pg_temp.check((select rounds_used = 3 from projects.build_revision_allowance(:'P_id')), 'the count is still 3');

-- resolving the escalation
select pg_temp.act(:'LEAD', 'delivery_lead');
select pg_temp.check((select outcome from projects.resolve_build_revision_escalation(:'V4_e', 'extra_rounds_granted', 'ok', 1)) = 'not_authorized', 'a delivery lead cannot grant extra rounds: it is a commercial decision');
select pg_temp.act(:'OPS', 'ops_admin');
select pg_temp.check((select outcome from projects.resolve_build_revision_escalation(:'V4_e', 'maybe', 'ok')) = 'bad_decision', 'an unknown decision is refused');
select pg_temp.check((select outcome from projects.resolve_build_revision_escalation(:'V4_e', 'declined', '  ')) = 'note_required', 'a decision names its reason');
select pg_temp.check((select outcome from projects.resolve_build_revision_escalation(:'V4_e', 'extra_rounds_granted', 'goodwill', 0)) = 'extra_rounds_mismatch', 'extra rounds must be stated for a grant');
select pg_temp.check((select outcome from projects.resolve_build_revision_escalation(:'V4_e', 'declined', 'no', 2)) = 'extra_rounds_mismatch', 'extra rounds are only for a grant');
select pg_temp.check((select outcome from projects.resolve_build_revision_escalation(:'V4_e', 'extra_rounds_granted', 'Goodwill: one more round, agreed with the client.', 1)) = 'resolved', 'an Admin grants one more round');
select pg_temp.check((select outcome from projects.resolve_build_revision_escalation(:'V4_e', 'declined', 'again')) = 'already_resolved', 'a resolved escalation is final');
select pg_temp.check((select round_limit = 4 and remaining = 1 and not exceeded from projects.build_revision_allowance(:'P_id')), 'the limit rose to 4 and one round remains');
select pg_temp.root();
select pg_temp.check(pg_temp.refused(format('update projects.build_revision_escalations set rounds_used = 0 where id = %L', :'V4_e'), 'final'), 'a resolved escalation cannot be edited');
select pg_temp.check(pg_temp.refused(format('delete from projects.build_revision_escalations where id = %L', :'V4_e'), 'never deleted'), 'an escalation cannot be deleted');
select pg_temp.mk_build('zztest rev 8', 'pd-r8', 'r888888', repeat('8', 64), 'draft') as "R8" \gset
select pg_temp.act(:'MEMBER', 'member');
select pg_temp.check((select outcome from projects.record_build_revision(:'P_id', 'client', :'R7', :'R8', 'The extra, granted round.')) = 'recorded', 'the granted round opens');

-- the timeline reads QA and Admin re-approval from the to-build, live
select pg_temp.act(:'OPS', 'ops_admin');
select pg_temp.check((select count(*) from projects.build_revision_timeline(:'P_id')) = 8, 'the timeline lists every round');
select pg_temp.check((select t.origin = 'approved_change_request' and t.from_version = 1 and not t.consumes_allowance and t.affected_feature_ids = array[:'F1_id']::uuid[] and t.round_number = 1 from projects.build_revision_timeline(:'P_id') t order by t.round_number limit 1), 'round 1 shows origin, versions, features and allowance impact');
select pg_temp.check((select t.qa_status = 'not_reviewed' and t.admin_status is null from projects.build_revision_timeline(:'P_id') t where t.round_number = 2) is not false, 'a revised build not yet reviewed reads as such');
select pg_temp.act(:'CLIENTU', 'client_member', :'CA_id');
select pg_temp.check((select count(*) from projects.build_revision_timeline(:'P_id')) = 0 and (select count(*) from projects.build_revision_allowance(:'P_id')) = 0, 'with rounds on the record a client still reads no timeline and no allowance');
select pg_temp.root();
select pg_temp.check((select count(*) from projects.build_revisions where project_id = :'Q_id') = 0, 'nothing was recorded on the other project');

-- tenancy: the lineage must belong to the project's own organization
select pg_temp.check((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'build_revisions' and t.tgname like 'build_revisions_parent_org_%') = 4, 'four tenancy guards on the revision FKs');
select pg_temp.check((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'client_build_shares' and t.tgname like 'client_build_shares_parent_org_%') = 3, 'three tenancy guards on the share FKs');
select pg_temp.check((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'projects' and c.relname in ('client_build_shares', 'build_revisions', 'build_revision_escalations')), 'RLS is on for all three tables');
select pg_temp.check((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname in ('client_build_shares', 'build_revisions', 'build_revision_escalations') and t.tgname like 'freeze_org_%') = 3, 'the organization is frozen on all three tables');

rollback;
\echo phase5-pm-depth verifier OK
