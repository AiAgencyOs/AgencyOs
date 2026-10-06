-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 DevOps/Build depth - build logs masked in SQL, versioned build config + stale_config gate, reproducibility, the client build package,
-- cancelled / expired build requests - driven through the REAL doors on a scratch Postgres.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase5-build-depth.sql          (rolls back)
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
create or replace function pg_temp.as_client(p_sub uuid, p_org uuid, p_account uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated',
      'app_metadata', jsonb_build_object('organization_id', p_org, 'role', 'client_admin', 'client_account_id', p_account))::text, true);
end $$;
grant execute on function pg_temp.as_client(uuid, uuid, uuid) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
-- a statement that must be refused: by a trigger (restrict_violation / check_violation / unique_violation) or by a grant (insufficient_privilege)
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation or unique_violation or insufficient_privilege then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set OWNER '00000000-0000-4000-8000-00000000f591'
\set CREATOR '00000000-0000-4000-8000-00000000f592'
\set CLIENT '00000000-0000-4000-8000-00000000f593'
\set CLIENT2 '00000000-0000-4000-8000-00000000f594'
\set MEMBER '00000000-0000-4000-8000-00000000f595'
\set ORG2 '00000000-0000-4000-8000-0000000000b2'
\set OWNER2 '00000000-0000-4000-8000-00000000f596'

insert into auth.users (id, email) values (:'OWNER', 'bd-owner@example.test'), (:'CREATOR', 'bd-creator@example.test'), (:'CLIENT', 'bd-client@example.test'),
  (:'CLIENT2', 'bd-client2@example.test'), (:'MEMBER', 'bd-member@example.test'), (:'OWNER2', 'bd-owner2@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'bd-owner@example.test', 'BD Owner'), (:'CREATOR', 'bd-creator@example.test', 'BD Creator'),
  (:'CLIENT', 'bd-client@example.test', 'BD Client'), (:'CLIENT2', 'bd-client2@example.test', 'BD Client 2'), (:'MEMBER', 'bd-member@example.test', 'BD Member'),
  (:'OWNER2', 'bd-owner2@example.test', 'BD Owner 2') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'CREATOR', 'member'), (:'ORG', :'MEMBER', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest bd org 2', 'zztest-bd-org-2') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;
insert into approvals.approval_policies (organization_id, subject_type, required_role, sla_hours, audience) values (:'ORG', 'deliverable', 'owner', 24, 'client') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest bd client') returning id \gset A_
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest bd other client') returning id \gset A2_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest bd project A', 'ZBD-A') returning id \gset PA_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest bd project B', 'ZBD-B') returning id \gset PB_

-- helpers that make a build and bring it through the gates, as the real doors would (the creator is not the reviewer)
create or replace function pg_temp.mk_build(p_project uuid, p_commit text, p_creator uuid) returns uuid language plpgsql as $$
declare v uuid;
begin
  select deliverable_id into v from projects.add_deliverable(p_project, 'build', 'zztest build ' || p_commit, null, null, null, p_creator);
  perform projects.set_deliverable_details(v, 'web', p_commit, 'bn-' || p_commit);
  return v;
end $$;
grant execute on function pg_temp.mk_build(uuid, text, uuid) to public;
create or replace function pg_temp.manual_run(p_d uuid, p_hash text, p_fp jsonb, p_key text) returns text language plpgsql as $$
declare v text;
begin
  select outcome into v from projects.record_build_run(p_d, 'review', 'succeeded', null, '[{"name":"build","status":"ok"},{"name":"artifact_verify","status":"ok"}]'::jsonb, p_fp, p_hash, null, p_key, 'https://ci.example.test/run');
  return v;
end $$;
grant execute on function pg_temp.manual_run(uuid, text, jsonb, text) to public;
create or replace function pg_temp.pass_review_gates(p_d uuid) returns void language plpgsql as $$
begin
  perform projects.record_smoke_check(p_d, 'not_tested', '[]', null, 'verifier: no launch test');
  perform projects.record_code_review(p_d, 'passed');
end $$;
grant execute on function pg_temp.pass_review_gates(uuid) to public;

-- ══ 1. build logs: masked in SQL, append-only, internal only ══════════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.mk_build(:'PA_id', 'aaa1111', :'CREATOR') as "BA1" \gset
select pg_temp.manual_run(:'BA1', repeat('a', 64), '{"node":"22"}', 'ba1-r1') as "BA1_run_o" \gset
select id as "BA1_run" from projects.build_runs where deliverable_id = :'BA1' order by created_at desc limit 1 \gset
reset role;

-- the secret-looking fixtures are assembled here, never written whole
select pg_temp.as_service();
set local role service_role;
select 'sk-' || repeat('a', 24) as f_sk, 'ghp_' || repeat('b', 30) as f_ghp, 'gho_' || repeat('c', 30) as f_gho, 'xoxb-' || repeat('1', 14) as f_xox,
       'AKIA' || repeat('Q', 16) as f_aws, 'eyJ' || repeat('h', 14) || '.' || repeat('p', 14) || '.' || repeat('s', 10) as f_jwt,
       'postgres://user:' || 'hunter' || '22@db.example.test/app' as f_url, 'pass' || 'word=' || 'swordfish1' as f_pw, 'tok' || 'en: ' || 'abcdef123456' as f_tok,
       'Bearer ' || repeat('z', 20) as f_bearer,
       '-----BEGIN ' || 'RSA PRIVATE KEY-----' || E'\nMIIEvQIBADANBgkq\nabcdef\n' || '-----END ' || 'RSA PRIVATE KEY-----' as f_pem,
       '-----BEGIN ' || 'PRIVATE KEY-----' || E'\nTRUNCATEDBODYLINE' as f_pem_cut \gset
select outcome as o from projects.append_build_log(:'BA1_run', 'install',
  'npm ci ok' || E'\n' || :'f_sk' || E'\n' || :'f_ghp' || ' ' || :'f_gho' || E'\n' || :'f_xox' || E'\n' || :'f_aws' || E'\n' || :'f_jwt' || E'\n' || :'f_url' || E'\n' || :'f_pw' || E'\n' || :'f_tok' || E'\n' || :'f_bearer' || E'\n' || :'f_pem' || E'\nafter-pem line\n' || :'f_pem_cut') \gset L1_
select pg_temp.check(:'L1_o' = 'recorded', 'the runner records a build log through the service-role door');
reset role;
select masked_text as "L1_text" from projects.build_logs where build_run_id = :'BA1_run' \gset
select pg_temp.check(position('npm ci ok' in :'L1_text') > 0 and position('after-pem line' in :'L1_text') > 0, 'masking keeps the ordinary text of the log');
select pg_temp.check(position(:'f_sk' in :'L1_text') = 0 and position(:'f_ghp' in :'L1_text') = 0 and position(:'f_gho' in :'L1_text') = 0 and position(:'f_xox' in :'L1_text') = 0
  and position(:'f_aws' in :'L1_text') = 0 and position(:'f_jwt' in :'L1_text') = 0, 'SQL re-masks api keys, ghp_/gho_ tokens, xox tokens, AWS keys and JWTs');
select pg_temp.check(position('hunter' in :'L1_text') = 0 and position('swordfish1' in :'L1_text') = 0 and position('abcdef123456' in :'L1_text') = 0 and position(repeat('z', 20) in :'L1_text') = 0,
  'SQL re-masks URL passwords, password=/token: pairs and bearer credentials');
select pg_temp.check(position('MIIEvQIBADANBgkq' in :'L1_text') = 0 and position('TRUNCATEDBODYLINE' in :'L1_text') = 0 and position('PRIVATE KEY' in :'L1_text') = 0, 'SQL masks a PEM private key block, and one that was cut off');
select pg_temp.check((select attempt from projects.build_logs where build_run_id = :'BA1_run') = 1 and (select stage from projects.build_logs where build_run_id = :'BA1_run') = 'install', 'the log carries the run, the stage and the attempt of that run');

-- a writer that skips the door still cannot store a secret (the table masks on insert)
select pg_temp.as_service();
set local role service_role;
insert into projects.build_logs (organization_id, project_id, build_run_id, stage, attempt, masked_text) values (:'ORG', :'PA_id', :'BA1_run', 'build', 1, 'direct write ' || :'f_sk' || ' end');
reset role;
select pg_temp.check((select masked_text from projects.build_logs where build_run_id = :'BA1_run' and stage = 'build') = 'direct write [masked] end', 'a direct service-role insert is masked by the table itself');

select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.append_build_log(:'BA1_run', 'deploy', 'x')) = 'bad_stage', 'an unknown stage is refused');
select pg_temp.check((select outcome from projects.append_build_log(gen_random_uuid(), 'build', 'x')) = 'not_found', 'a log for a run that does not exist is refused');
select pg_temp.check((select outcome from projects.append_build_log(:'BA1_run', 'build', '   ')) = 'empty', 'an empty log is refused');
select pg_temp.check(pg_temp.refused(format('update projects.build_logs set masked_text = %L where build_run_id = %L', 'rewritten', :'BA1_run'), 'never rewritten'), 'a build log is never rewritten (even by the service role)');
select pg_temp.check(pg_temp.refused(format('delete from projects.build_logs where build_run_id = %L', :'BA1_run'), 'never rewritten'), 'a build log is never deleted');
reset role;

-- who may write and read
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.refused(format('select projects.append_build_log(%L, %L, %L)', :'BA1_run', 'build', 'a person writing a log'), 'permission denied'), 'a person (even the owner) cannot write a build log: the door is the runner''s');
select pg_temp.check(pg_temp.refused(format('insert into projects.build_logs (organization_id, project_id, build_run_id, stage, attempt, masked_text) values (%L, %L, %L, %L, 1, %L)', :'ORG', :'PA_id', :'BA1_run', 'build', 'x'), 'permission denied'), 'and cannot insert into the table');
select pg_temp.check((select count(*) from projects.build_logs_for_run(:'BA1_run')) = 2, 'staff read the logs of a run through the read function (in order)');
select pg_temp.check((select count(*) from projects.build_logs) = 2, 'and through the table (internal-only policy)');
select pg_temp.check((select count(*) from projects.build_runs_client_safe where deliverable_id = :'BA1') = 1, 'staff see the run in the client-safe view as well');
reset role;
select pg_temp.as_client(:'CLIENT', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.build_logs) = 0, 'NEGATIVE: a client reads no build log from the table');
select pg_temp.check((select count(*) from projects.build_logs_for_run(:'BA1_run')) = 0, 'NEGATIVE: a client reads no build log through the read function');
select pg_temp.check((select count(*) from projects.build_runs_client_safe where deliverable_id = :'BA1') = 0, 'NEGATIVE: the client-safe run view shows a client nothing of a build that was not shared');
select pg_temp.check(not exists (select 1 from information_schema.columns where table_schema = 'projects' and table_name = 'build_runs_client_safe' and column_name in ('stages', 'fingerprint', 'masked_text', 'failure_class', 'artifact_sha256', 'commit_ref', 'evidence_url')),
  'and has no log, stage, fingerprint, failure or commit column at all');
reset role;
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.build_logs_for_run(:'BA1_run')) = 0 and (select count(*) from projects.build_logs) = 0, 'NEGATIVE: staff of another organization read none of them');
reset role;

-- ══ 2. build config: versioned, Admin-written, audited; runs are stamped; a stale run is not shared ═════════════════════════════════════════
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select outcome as o from projects.set_build_config(:'PA_id', '{"node_version":"22"}') \gset C0_
select pg_temp.check(:'C0_o' = 'not_authorized', 'NEGATIVE: only an Admin writes the build config');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_build_config(:'PA_id', '{"foo":"bar"}')) = 'unknown_key', 'a key outside the allowed list is refused');
select pg_temp.check((select outcome from projects.set_build_config(:'PA_id', '{}')) = 'bad_config', 'an empty config is refused');
select pg_temp.check((select outcome from projects.set_build_config(:'PA_id', '{"env_names":["lower_case"]}')) = 'bad_config', 'environment variables are named in upper case, as names');
select pg_temp.check((select outcome from projects.set_build_config(:'PA_id', '{"build_command":"npm publish"}')) = 'deploy_is_not_a_build', 'a config whose command publishes is refused');
select pg_temp.check((select outcome from projects.set_build_config(:'PA_id', jsonb_build_object('install_command', 'npm ci --token=' || 'abcdef1234567890'))) = 'secret_in_config', 'a config that carries a secret value is refused');
select outcome as o, version as v from projects.set_build_config(:'PA_id', '{"node_version":"22","package_manager":"npm","env_names":["NEXT_PUBLIC_URL"]}', 'first') \gset C1_
select pg_temp.check(:'C1_o' = 'recorded' and :'C1_v' = 1, 'the Admin writes build config version 1');
reset role;
select pg_temp.check(exists (select 1 from audit.audit_log where action = 'build.config_set' and subject_id = :'PA_id'), 'and it is audited');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_build_config(:'PA_id', '{"node_version":"22","package_manager":"npm","env_names":["NEXT_PUBLIC_URL"]}')) = 'unchanged', 'the same config again is not a new version');
reset role;

-- a run recorded by the runner is stamped; the stamp can be older than the current version but never newer
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.mk_build(:'PA_id', 'bbb2222', :'CREATOR') as "BA2" \gset
reset role;
select pg_temp.as_service();
set local role service_role;
select outcome as o, run_id as r from projects.record_build_run(:'BA2', 'review', 'succeeded', null, '[{"name":"build","status":"passed"},{"name":"artifact_verify","status":"passed"}]', '{"node":"22","config_version":99}', repeat('b', 64), null, 'ba2-r1', null) \gset R2_
reset role;
select pg_temp.check(:'R2_o' = 'recorded' and (select fingerprint ->> 'config_version' from projects.build_runs where id = :'R2_r') = '1', 'record_build_run stamps the fingerprint with config_version (a claim of a newer version is clamped to the current)');
-- a project with no config gets no stamp
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.mk_build(:'PB_id', 'ccc3333', :'CREATOR') as "BB1" \gset
select pg_temp.manual_run(:'BB1', repeat('c', 64), '{"node":"22","config_version":"7"}', 'bb1-r1') as "BB1_o" \gset
reset role;
select pg_temp.check(:'BB1_o' = 'recorded' and not (select fingerprint ? 'config_version' from projects.build_runs where deliverable_id = :'BB1'), 'a project with no build config gets no config_version stamp (a claimed one is dropped)');

-- bring BA2 to the bar and prove the stale gate: version 2 is written AFTER the run
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.pass_review_gates(:'BA2');
select projects.record_build_qa_verdict(:'BA2', 'passed', null, 'https://ci.example.test/qa');
select projects.decide_build_admin(:'BA2', 'approved');
select outcome as o, version as v from projects.set_build_config(:'PA_id', '{"node_version":"24","package_manager":"npm","env_names":["NEXT_PUBLIC_URL"]}', 'bump node') \gset C2_
select pg_temp.check(:'C2_o' = 'recorded' and :'C2_v' = 2, 'a changed config is version 2');
reset role;
select pg_temp.check((select count(*) from projects.build_configs where project_id = :'PA_id' and current) = 1 and (select version from projects.build_configs where project_id = :'PA_id' and current) = 2
  and (select not current from projects.build_configs where project_id = :'PA_id' and version = 1), 'exactly one config is current: v2; v1 is superseded, not deleted');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as o from projects.submit_deliverable(:'BA2') \gset ST1_
select pg_temp.check(:'ST1_o' = 'stale_config', 'a build whose run used an OLDER config than the current one is refused: stale_config');
select pg_temp.check((select status from projects.deliverables where id = :'BA2') = 'draft', 'and it stays a draft');
reset role;
-- the fresh run under v2 (positive twin)
select pg_temp.as_service();
set local role service_role;
select outcome as o from projects.record_build_run(:'BA2', 'review', 'succeeded', null, '[{"name":"build","status":"passed"},{"name":"artifact_verify","status":"passed"}]', '{"node":"24"}', repeat('d', 64), null, 'ba2-r2', null) \gset R3_
reset role;
select pg_temp.check(:'R3_o' = 'recorded' and (select fingerprint ->> 'config_version' from projects.build_runs where deliverable_id = :'BA2' and idempotency_key = 'ba2-r2') = '2', 'a run recorded under v2 is stamped 2');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as o from projects.submit_deliverable(:'BA2') \gset ST2_
select pg_temp.check(:'ST2_o' = 'submitted', 'the same build, with a run under the current config, is shared (got ' || :'ST2_o' || ')');
reset role;

-- history is not edited
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.refused(format('update projects.build_configs set config = %L where project_id = %L and version = 1', '{"node_version":"1"}', :'PA_id'), 'superseded, never edited'), 'a config version is never edited');
select pg_temp.check(pg_temp.refused(format('delete from projects.build_configs where project_id = %L', :'PA_id'), 'part of the record'), 'a config version is never deleted');
select pg_temp.check(pg_temp.refused(format('insert into projects.build_configs (organization_id, project_id, version, config) values (%L, %L, 9, %L)', :'ORG', :'PA_id', '{"node_version":"9"}'), 'build_configs_one_current'), 'a second current config for one project is impossible');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.refused(format('insert into projects.build_configs (organization_id, project_id, version, config) values (%L, %L, 10, %L)', :'ORG', :'PA_id', '{"node_version":"9"}'), 'permission denied'), 'a person cannot write the table directly');
reset role;

-- ══ 3. reproducibility: never claimed from one run ════════════════════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(projects.build_reproducibility(:'BB1', 'ccc3333') = 'single_run', 'one succeeded run is single_run, never reproduced');
select pg_temp.check(pg_temp.manual_run(:'BB1', repeat('c', 64), '{"node":"22","config_version":"7"}', 'bb1-r2') = 'recorded', 'a second run of the same commit is recorded');
select pg_temp.check(projects.build_reproducibility(:'BB1', 'ccc3333') = 'reproduced', 'two runs, same artifact hash and same fingerprint: reproduced');
select pg_temp.check(projects.build_reproducibility(:'BB1', 'zzz9999') = 'single_run', 'a commit with no run is single_run too');
select pg_temp.check(pg_temp.manual_run(:'BB1', repeat('e', 64), '{"node":"22"}', 'bb1-r3') = 'recorded', 'a third run with a different hash is recorded');
select pg_temp.check(projects.build_reproducibility(:'BB1', 'ccc3333') = 'differs', 'a different artifact hash for the same commit and config: differs');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.mk_build(:'PB_id', 'ddd4444', :'CREATOR') as "BB2" \gset
select pg_temp.manual_run(:'BB2', repeat('f', 64), '{"node":"22"}', 'bb2-r1') as "BB2_o1" \gset
select pg_temp.manual_run(:'BB2', repeat('f', 64), '{"node":"20"}', 'bb2-r2') as "BB2_o2" \gset
select pg_temp.check(projects.build_reproducibility(:'BB2', 'ddd4444') = 'differs', 'the same hash under a different toolchain fingerprint is not claimed as reproduced');
reset role;
select pg_temp.as_client(:'CLIENT', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check(projects.build_reproducibility(:'BB2', 'ddd4444') is null, 'NEGATIVE: a client is told nothing about reproducibility');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.mk_build(:'PB_id', 'hhh1010', :'CREATOR') as "BB3" \gset
select pg_temp.manual_run(:'BB3', repeat('7', 64), '{"node":"22"}', 'bb3-r1') as "BB3_o1" \gset
select pg_temp.manual_run(:'BB3', repeat('7', 64), '{"node":"22"}', 'bb3-r2') as "BB3_o2" \gset
select outcome as o from projects.record_build_run(:'BB3', 'review', 'failed', 'test_failed', '[{"name":"test","status":"failed"}]', '{"node":"22"}', repeat('8', 64), null, 'bb3-r3', null) \gset BB3F_
select pg_temp.check(:'BB3F_o' = 'recorded', 'a failed run carrying another hash is recorded');
select pg_temp.check(projects.build_reproducibility(:'BB3', 'hhh1010') = 'reproduced', 'a failed run is not compared: only succeeded runs count');
reset role;
-- different config versions are not mixed: BA2 has runs under v1 and v2, the newest group has one run
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(projects.build_reproducibility(:'BA2', 'bbb2222') = 'single_run', 'runs under different config versions are not compared with each other');
reset role;

-- ══ 4. the client build package ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.mk_build(:'PB_id', 'eee5555', :'CREATOR') as "BP" \gset
select pg_temp.manual_run(:'BP', repeat('1', 64), '{"node":"22"}', 'bp-r1') as "BP_o" \gset
select pg_temp.pass_review_gates(:'BP');
select outcome as o from projects.create_client_build_package(:'BP', 'Web only; no payments', 'Open the link and sign in with the test login') \gset K1_
select pg_temp.check(:'K1_o' = 'not_qa_passed', 'NEGATIVE: no package before QA passed');
select projects.record_build_qa_verdict(:'BP', 'passed', null, 'https://ci.example.test/qa');
select outcome as o from projects.create_client_build_package(:'BP', 'Web only; no payments', 'Open the link and sign in with the test login') \gset K2_
select pg_temp.check(:'K2_o' = 'not_admin_approved', 'NEGATIVE: no package before the Admin approved');
select projects.decide_build_admin(:'BP', 'approved');
select outcome as o from projects.create_client_build_package(:'BP', 'Web only; no payments', 'Open the link and sign in with the test login') \gset K3_
select pg_temp.check(:'K3_o' = 'no_artifact', 'NEGATIVE: no package while the run has no artifact record');
reset role;
select pg_temp.as_service();
set local role service_role;
select id as "BP_run1" from projects.build_runs where deliverable_id = :'BP' limit 1 \gset
select outcome as o from projects.record_build_artifact(:'BP_run1', 'web_bundle', 's3://bucket/bp-1.zip', 'web', 1024, true, null) \gset AR1_
reset role;
select pg_temp.check(:'AR1_o' = 'recorded', 'the artifact of the first run is recorded');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.create_client_build_package(:'BP', '', 'x')) = 'limitations_required', 'the package must state its limitations');
select pg_temp.check((select outcome from projects.create_client_build_package(:'BP', 'x', '  ')) = 'instructions_required', 'and the testing instructions');
select pg_temp.check((select outcome from projects.create_client_build_package(:'BP', 'x', 'login with ' || 'pass' || 'word=' || 'swordfish1')) = 'secret_in_text', 'and carries no secret');
select outcome as o, package_id as k from projects.create_client_build_package(:'BP', 'Web only; no payments', 'Open the link and sign in with the test login') \gset K4_
select pg_temp.check(:'K4_o' = 'recorded', 'with QA passed, Admin approved, the newest artifact and a shareable smoke verdict the package is ready');
reset role;
select pg_temp.as_client(:'CLIENT', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_build_package(:'BP')) = 0, 'NEGATIVE: a client sees nothing before the build is shared');
select pg_temp.check((select outcome from projects.create_client_build_package(:'BP', 'x', 'y')) = 'not_authorized', 'NEGATIVE: a client cannot write a package');
select pg_temp.check((select count(*) from projects.client_build_packages) = 0, 'NEGATIVE: a client reads no package row (only the read function)');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_build_package(:'BP')) = 1, 'staff preview exactly what the client will see');
select outcome as o from projects.submit_deliverable(:'BP') \gset ST3_
select pg_temp.check(:'ST3_o' = 'submitted', 'the build is shared with the client');
reset role;
select pg_temp.as_client(:'CLIENT', :'ORG', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_build_package(:'BP')) = 1, 'the client now reads the package');
select pg_temp.check((select count(*) from projects.build_runs_client_safe where deliverable_id = :'BP') = 1, 'and the client-safe run view shows the shared build''s succeeded run (verdict only)');
select pg_temp.check((select label from projects.client_build_package(:'BP')) = 'Development build, not production', 'it is labelled a development build, not production');
select pg_temp.check((select limitations from projects.client_build_package(:'BP')) = 'Web only; no payments' and (select testing_instructions from projects.client_build_package(:'BP')) like 'Open the link%', 'with its limitations and testing instructions');
select pg_temp.check((select proargnames from pg_proc where oid = 'projects.client_build_package(uuid)'::regprocedure) =array['p_deliverable_id', 'title', 'version', 'label', 'platform', 'artifact_type', 'distributable', 'artifact_limitation', 'limitations', 'testing_instructions', 'packaged_at'],
  'and the read returns only those fields: no log, stage, fingerprint, commit, run id or artifact id');
reset role;
select pg_temp.as_client(:'CLIENT2', :'ORG', :'A2_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_build_package(:'BP')) = 0, 'NEGATIVE: a client of another account reads nothing');
select pg_temp.check((select count(*) from projects.build_runs_client_safe where deliverable_id = :'BP') = 0, 'NEGATIVE: nor the runs of it');
reset role;
select pg_temp.as_client(:'CLIENT', :'ORG2', :'A_id');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_build_package(:'BP')) = 0, 'NEGATIVE: a client of another organization (even carrying this account id) reads nothing');
reset role;

-- a newer run makes the old package stale: the artifact is no longer the newest for the build
select pg_temp.as_service();
set local role service_role;
select outcome as o, run_id as r from projects.record_build_run(:'BP', 'review', 'succeeded', null, '[{"name":"build","status":"passed"},{"name":"artifact_verify","status":"passed"}]', '{"node":"22"}', repeat('2', 64), null, 'bp-r2', null) \gset BPR2_
reset role;
select pg_temp.check(:'BPR2_o' = 'build_already_shared', 'a shared build takes no new run (the existing gate still holds)');
-- the package of a draft build: a second run before sharing (BB3 follows the same walk and stays a draft)
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.mk_build(:'PB_id', 'fff6666', :'CREATOR') as "BQ" \gset
select pg_temp.manual_run(:'BQ', repeat('3', 64), '{"node":"22"}', 'bq-r1') as "BQ_o" \gset
select pg_temp.pass_review_gates(:'BQ');
select projects.record_build_qa_verdict(:'BQ', 'passed', null, 'https://ci.example.test/qa');
select projects.decide_build_admin(:'BQ', 'approved');
reset role;
select pg_temp.as_service();
set local role service_role;
select id as "BQ_run1" from projects.build_runs where deliverable_id = :'BQ' limit 1 \gset
select outcome as o from projects.record_build_artifact(:'BQ_run1', 'web_bundle', 's3://bucket/bq-1.zip', 'web', 10, true, null) \gset BQA1_
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.create_client_build_package(:'BQ', 'Web only', 'Open the link')) = 'recorded', 'a draft build is packaged once ready');
select pg_temp.check(pg_temp.manual_run(:'BQ', repeat('4', 64), '{"node":"22"}', 'bq-r2') = 'recorded', 'a newer run of the same commit is recorded');
select pg_temp.check((select outcome from projects.create_client_build_package(:'BQ', 'Web only', 'Open the link')) = 'artifact_not_newest', 'NEGATIVE: the newest run has no artifact, the older artifact is not the newest: no package');
select pg_temp.check((select count(*) from projects.client_build_package(:'BQ')) = 0, 'and the package written earlier is no longer served');
reset role;
select pg_temp.as_service();
set local role service_role;
select id as "BQ_run2" from projects.build_runs where deliverable_id = :'BQ' and idempotency_key = 'bq-r2' \gset
select outcome as o from projects.record_build_artifact(:'BQ_run2', 'web_bundle', 's3://bucket/bq-2.zip', 'web', 11, true, null) \gset BQA2_
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.client_build_package(:'BQ')) = 0, 'a package for the OLD artifact is still not served once the new artifact exists');
select pg_temp.check((select outcome from projects.create_client_build_package(:'BQ', 'Web only', 'Open the link v2')) = 'recorded', 'a new package for the newest artifact is recorded');
select pg_temp.check((select testing_instructions from projects.client_build_package(:'BQ')) = 'Open the link v2', 'and the newest package is the one served');
reset role;

-- the commit moves on after the artifact was built: the artifact is not this build's any more
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.mk_build(:'PB_id', 'iii2020', :'CREATOR') as "BC" \gset
select pg_temp.manual_run(:'BC', repeat('5', 64), '{"node":"22"}', 'bc-r1') as "BC_o" \gset
select pg_temp.pass_review_gates(:'BC');
select projects.record_build_qa_verdict(:'BC', 'passed', null, 'https://ci.example.test/qa');
select projects.decide_build_admin(:'BC', 'approved');
reset role;
select pg_temp.as_service();
set local role service_role;
select id as "BC_run1" from projects.build_runs where deliverable_id = :'BC' limit 1 \gset
select outcome as o from projects.record_build_artifact(:'BC_run1', 'web_bundle', 's3://bucket/bc-1.zip', 'web', 10, true, null) \gset BCA1_
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.create_client_build_package(:'BC', 'Web only', 'Open the link')) = 'recorded', 'a build on its commit is packaged');
select pg_temp.check((select outcome from projects.set_deliverable_details(:'BC', 'web', 'iii2021', 'bn-iii2021')) = 'set', 'the commit moves on (a new commit is set)');
select pg_temp.check((select outcome from projects.create_client_build_package(:'BC', 'Web only', 'Open the link')) = 'not_qa_passed', 'a new commit starts without the old commit''s QA verdict');
select projects.record_build_qa_verdict(:'BC', 'passed', null, 'https://ci.example.test/qa2');
select projects.decide_build_admin(:'BC', 'approved');
select outcome as o from projects.create_client_build_package(:'BC', 'Web only', 'Open the link') \gset BCK_
select pg_temp.check(:'BCK_o' = 'artifact_not_newest', 'NEGATIVE: the newest run built the OLD commit: its artifact is not this build''s, no package (got ' || :'BCK_o' || ')');
select pg_temp.check((select count(*) from projects.client_build_package(:'BC')) = 0, 'and nothing is served for it');
reset role;

-- smoke: a failed smoke verdict withdraws readiness
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select projects.record_smoke_check(:'BQ', 'failed', '[{"name":"launch"}]', null, 'crashed on launch');
select pg_temp.check((select outcome from projects.create_client_build_package(:'BQ', 'Web only', 'Open the link v3')) = 'no_smoke', 'NEGATIVE: a build whose smoke verdict is not shareable is not packaged');
reset role;

-- a config written after the run makes the package stale (BP is shared; PB gets a config now)
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select projects.set_build_config(:'PB_id', '{"node_version":"22"}', 'late config');
select pg_temp.check((select count(*) from projects.client_build_package(:'BP')) = 0, 'a build config newer than the run takes the package away (stale_config)');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select reason from projects.client_build_package_readiness(:'BP')) = 'stale_config', 'the readiness helper (service role) names why: stale_config');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.refused(format('select * from projects.client_build_package_readiness(%L)', :'BP'), 'permission denied'), 'but not by a person');
reset role;

select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.refused(format('update projects.client_build_packages set limitations = %L where id = %L', 'none', :'K4_k'), 'never rewritten'), 'a package is never rewritten');
select pg_temp.check(pg_temp.refused(format('delete from projects.client_build_packages where id = %L', :'K4_k'), 'never rewritten'), 'a package is never deleted');
select pg_temp.check(pg_temp.refused(format('update projects.client_build_packages set label = %L where id = %L', 'Production release', :'K4_k'), 'never rewritten'), 'the label cannot be changed to say production');
select pg_temp.check(pg_temp.refused(format('insert into projects.client_build_packages (organization_id, project_id, deliverable_id, build_run_id, build_artifact_id, commit_ref, label, limitations, testing_instructions) select organization_id, project_id, deliverable_id, build_run_id, build_artifact_id, commit_ref, %L, limitations, testing_instructions from projects.client_build_packages where id = %L', 'Production release', :'K4_k'), 'client_build_packages'), 'a package cannot be written with another label');
reset role;

-- ══ 5. build requests: cancelled, and expired by the sweeper ══════════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.mk_build(:'PB_id', 'ggg7777', :'CREATOR') as "BR1" \gset
select outcome as o, request_id as r from projects.request_build(:'BR1') \gset Q1_
select pg_temp.check(:'Q1_o' = 'requested', 'a build is requested');
reset role;
update projects.build_requests set created_at = now() - interval '5 hours' where id = :'Q1_r';
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.cancel_build_request(:'Q1_r')) = 'not_found', 'NEGATIVE: an Admin of another organization cannot cancel it');
reset role;
select pg_temp.check((select status from projects.build_requests where id = :'Q1_r') = 'requested', 'it is still requested');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.cancel_build_request(:'Q1_r')) = 'not_authorized', 'NEGATIVE: only an Admin cancels a build request');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.cancel_build_request(gen_random_uuid())) = 'not_found', 'a request that does not exist is not found');
select outcome as o from projects.cancel_build_request(:'Q1_r', 'wrong commit') \gset X1_
select pg_temp.check(:'X1_o' = 'cancelled', 'the Admin cancels it');
select pg_temp.check((select status from projects.build_requests where id = :'Q1_r') = 'cancelled' and (select detail from projects.build_requests where id = :'Q1_r') = 'wrong commit' and (select settled_at is not null from projects.build_requests where id = :'Q1_r'), 'cancelled, with the reason and the time');
select pg_temp.check((select outcome from projects.cancel_build_request(:'Q1_r')) = 'already_settled', 'a settled request cannot be cancelled again');
reset role;
select pg_temp.check(exists (select 1 from audit.audit_log where action = 'build.request_cancelled' and subject_id = :'Q1_r'), 'the cancellation is audited');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select count(*) from projects.open_build_request_for(:'BR1', 'ggg7777')) = 0, 'a cancelled request is no longer open: a report for it finds no request');
select pg_temp.check((select outcome from projects.settle_build_request(:'Q1_r', 'reported')) = 'already_settled', 'and it cannot be settled as reported afterwards');
reset role;

select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select outcome as o, request_id as r from projects.request_build(:'BR1') \gset Q2_
select pg_temp.check(:'Q2_o' = 'requested', 'a cancelled request does not block asking again');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.expire_stale_build_requests('0 seconds')) = 'bad_interval', 'the sweeper refuses an interval that would settle everything');
select pg_temp.check((select expired from projects.expire_stale_build_requests('1 hour')) = 0, 'a fresh request is not swept');
select pg_temp.check((select status from projects.build_requests where id = :'Q2_r') = 'requested', 'it stays requested');
reset role;
update projects.build_requests set created_at = now() - interval '3 hours' where id = :'Q2_r';
select pg_temp.as_service();
set local role service_role;
select outcome as o, expired as n from projects.expire_stale_build_requests('1 hour') \gset SW_
reset role;
select pg_temp.check(:'SW_o' = 'swept' and :'SW_n' = 1, 'the sweeper settles the request nobody answered');
select pg_temp.check((select status from projects.build_requests where id = :'Q2_r') = 'dispatch_failed' and (select detail from projects.build_requests where id = :'Q2_r') = 'no report received'
  and (select settled_at is not null from projects.build_requests where id = :'Q2_r'), 'as dispatch_failed with the detail: no report received');
select pg_temp.check((select status from projects.build_requests where id = :'Q1_r') = 'cancelled', 'a cancelled request is left as it was');
select pg_temp.check(exists (select 1 from audit.audit_log where action = 'build.request_expired' and subject_id = :'Q2_r'), 'the sweep is audited');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.refused('select * from projects.expire_stale_build_requests(interval ''1 hour'')', 'permission denied'), 'NEGATIVE: a person cannot run the sweeper');
select pg_temp.check(pg_temp.refused(format('select projects.append_build_log(%L, %L, %L)', :'BA1_run', 'build', 'x'), 'permission denied'), 'NEGATIVE: nor write a build log');
reset role;
-- the service-role check lives in the live bodies of both service-only doors as well as in their grants (two layers, each asserted)
select pg_temp.check((select prosrc ~ 'auth\.role\(\)\), ''''\) <> ''service_role''' from pg_proc where oid = 'projects.append_build_log(uuid,text,text)'::regprocedure), 'append_build_log refuses a non-service caller in its own body');
select pg_temp.check((select prosrc ~ 'auth\.role\(\)\), ''''\) <> ''service_role''' from pg_proc where oid = 'projects.expire_stale_build_requests(interval)'::regprocedure), 'expire_stale_build_requests refuses a non-service caller in its own body');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
reset role;

rollback;
\echo PHASE 5 BUILD DEPTH OK
