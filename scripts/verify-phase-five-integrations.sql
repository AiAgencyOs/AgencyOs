-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 Integration spec: CONFIGURED != VERIFIED; a mock success is not a real integration; verification is the adapter's result with
-- evidence, never a person typing "verified"; a change or failure drops the proof.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-five-integrations.sql      (rolls back)
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
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set U '00000000-0000-4000-8000-00000000f541'
insert into auth.users (id, email) values (:'U', 'p5i-member@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'U', 'p5i-member@example.test', 'P5 Member') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'U', 'member') on conflict do nothing;
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p5 integrations client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p5 integrations', 'ZP5-INT') returning id \gset P_

select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select connection_id as c1 from projects.register_integration(:'P_id', 'whatsapp', 'WhatsApp Business') \gset W_
select connection_id as c2 from projects.register_integration(:'P_id', 'payment', 'Razorpay sandbox', true) \gset M_
select pg_temp.check((select health from projects.integration_connections where id = :'W_c1') = 'unknown', 'a new integration is UNKNOWN');
select pg_temp.check((select outcome from projects.register_integration(:'P_id', 'whatsapp', 'WhatsApp Business')) = 'already_registered', 'registering twice registers once');
select pg_temp.check((select outcome from projects.set_integration_state(:'W_c1', 'configured', 'token pasted')) = 'set', 'a person can say it is CONFIGURED');
select pg_temp.check((select outcome from projects.set_integration_state(:'W_c1', 'verified')) = 'only_an_adapter_verifies', 'a person cannot say it is VERIFIED');
reset role;
-- (each real call is its own transaction; in this one script the doors' transaction-local flag must be cleared by hand)
select set_config('projects.integration_sanctioned', '', true);
select pg_temp.check(pg_temp.refused(format('update projects.integration_connections set health = ''verified'' where id = %L', :'W_c1'), 'integration doors'), 'a direct write cannot move health');
select pg_temp.check(pg_temp.refused(format('update projects.integration_connections set is_mock = true, health = ''verified'', verification_evidence = ''x'', verified_at = now(), verified_by_adapter = ''a'' where id = %L', :'W_c1'), 'integration doors'), 'nor can a forged evidence row');

-- an authenticated person (even an owner) cannot call the adapter door
select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
do $$ begin
  begin perform projects.record_integration_check((select id from projects.integration_connections where name = 'WhatsApp Business'), 'whatsapp-adapter', true, 'delivered test message wamid.123');
        raise exception 'FAILED: a signed-in person called the adapter door';
  exception when insufficient_privilege then raise notice 'ok  a signed-in person cannot call the adapter-result door'; end;
end $$;
reset role;

-- the adapter (service role) reports real results
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c1', 'whatsapp-adapter', true, '')) = 'no_evidence', 'a pass with no evidence is refused');
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c1', 'whatsapp-adapter', true, 'delivered test message wamid.123')) = 'verified', 'the adapter''s real result VERIFIES it, with evidence');
select pg_temp.check((select outcome from projects.record_integration_check(:'M_c2', 'razorpay-sandbox', true, 'test charge ok')) = 'mock_cannot_verify', 'a MOCK can never be verified');
select pg_temp.check((select health from projects.integration_connections where id = :'M_c2') <> 'verified', 'the mock stays unverified');
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c1', 'whatsapp-adapter', false, 'HTTP 401 from provider')) = 'degraded', 'a failing check DEGRADES it and drops the proof');
select pg_temp.check((select verification_evidence is null and verified_at is null from projects.integration_connections where id = :'W_c1'), 'the old evidence is gone: it described a connection that no longer works');
reset role;

select pg_temp.as_user(:'U', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.set_integration_state(:'W_c1', 'blocked', 'provider account suspended')) = 'set', 'a person can mark it BLOCKED');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_integration_check(:'W_c1', 'whatsapp-adapter', true, 'again')) = 'not_checkable', 'a blocked integration is not silently re-verified');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000f5ff', '00000000-0000-4000-8000-0000000000b2', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.integration_connections) = 0, 'another organization sees none of them');
reset role;

rollback;
\echo ALL PHASE 5 INTEGRATION CHECKS PASSED
