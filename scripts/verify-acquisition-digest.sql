-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, follow-up - the week is told once (scheduled digest).
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-digest.sql      Rolls back. Any failed check raises.
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
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.as_service() to public;

\set DORG '00000000-0000-4000-8000-0000000000f1'
\set DQUIET '00000000-0000-4000-8000-0000000000f2'
\set DOWN '00000000-0000-4000-8000-00000000f101'
insert into auth.users (id, email) values (:'DOWN', 'lg-digest-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'DOWN', 'lg-digest-owner@example.test', 'Digest Owner') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'DORG', 'Digest Agency', 'digest-agency'), (:'DQUIET', 'Quiet Agency', 'quiet-agency');

select pg_temp.as_user(:'DOWN', :'DORG', 'owner');
set local role authenticated;
select crm.ensure_acquisition_defaults();
select pg_temp.check((select count(*) from pg_proc p where p.proname = 'run_acquisition_digest' and has_function_privilege('authenticated', p.oid, 'execute')) = 0, 'a signed-in session cannot run the digest');
reset role;
-- the quiet organisation has set lead generation up and has nothing happening
insert into crm.acquisition_channels (organization_id, channel) values (:'DQUIET', 'email');
-- the busy one has a lead first touched by email, and a post waiting for a person
insert into crm.contacts (id, organization_id, full_name, email) values ('00000000-0000-4000-8000-0000000f0001', :'DORG', 'Digest Person', 'digest-person@example.test');
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values ('00000000-0000-4000-8000-0000000f0002', :'DORG', '00000000-0000-4000-8000-0000000f0001', 'Digest lead', 'email', 'dg:1', 'new');
set local role service_role;
select pg_temp.as_service();
select crm.record_touchpoint(:'DORG', '00000000-0000-4000-8000-0000000f0002', 'email', null, 'outreach_sent', '{}', '{}', 'digest:1', now() - interval '1 day');
insert into crm.content_items (id, organization_id, platform, objective, format, title, created_by_type) values ('00000000-0000-4000-8000-0000000f0003', :'DORG', 'linkedin', 'authority', 'text', 'Waiting post', 'agent');
reset role;
insert into crm.content_versions (organization_id, item_id, version, body, state, created_by_type, content_hash) select :'DORG', '00000000-0000-4000-8000-0000000f0003', 1, 'A post that waits for a person.', 'ADMIN_REVIEW', 'agent', repeat('a', 64);

set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select told from crm.run_acquisition_digest(timestamptz '2026-10-05 08:00+00') limit 1) >= 1, 'the digest tells at least the organisation with something to say');
select pg_temp.check((select count(*) from core.alerts where organization_id = :'DORG' and fingerprint = 'acquisition-digest:2026-W41') = 1, 'one digest alert for the week, named by ISO week');
select pg_temp.check((select summary from core.alerts where organization_id = :'DORG' and source = 'acquisition') like '%email: 1 lead%', 'it says what the CRM counted by first touch');
select pg_temp.check((select summary from core.alerts where organization_id = :'DORG' and source = 'acquisition') like '%to approve: 1.%', '…and how many drafts wait for a person');
select pg_temp.check((select severity from core.alerts where organization_id = :'DORG' and source = 'acquisition') = 'info', 'it is information, not a failure');
select pg_temp.check((select count(*) from core.alerts where organization_id = :'DQUIET') = 0, 'an organisation with nothing happening and nothing waiting is not told: silence is a real answer');
select crm.run_acquisition_digest(timestamptz '2026-10-06 08:00+00');
select pg_temp.check((select count(*) from core.alerts where organization_id = :'DORG' and source = 'acquisition') = 1, 'running it again the same week raises nothing new');
reset role;
update core.alerts set acknowledged_at = now(), acknowledged_by = :'DOWN', acknowledge_reason = 'read' where organization_id = :'DORG' and source = 'acquisition';
set local role service_role;
select pg_temp.as_service();
select crm.run_acquisition_digest(timestamptz '2026-10-07 08:00+00');
select pg_temp.check((select count(*) from core.alerts where organization_id = :'DORG' and source = 'acquisition') = 1, '…even after the first was acknowledged');
select crm.run_acquisition_digest(timestamptz '2026-10-12 08:00+00');
select pg_temp.check((select count(*) from core.alerts where organization_id = :'DORG' and source = 'acquisition') = 2, 'the next ISO week is told again');
reset role;
select 'ALL CHECKS PASSED' as result;
rollback;
