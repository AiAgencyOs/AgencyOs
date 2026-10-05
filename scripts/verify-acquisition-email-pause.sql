-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 1 — the stops reach the one engine that exists.
--
-- Drives a real campaign through crm.claim_outreach_sends (the email send
-- chokepoint) and proves a pause stops the NEXT send, that the recipient is not
-- consumed by being refused, and that resuming sends it. Needs the scratch
-- Postgres from `KEEP=1 scripts/apply-migrations-locally.sh`. Rolls back.
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

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000a001', 'lg-owner@example.test'),
  ('00000000-0000-4000-8000-00000000a002', 'lg-admin@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values
  ('00000000-0000-4000-8000-00000000a001', 'lg-owner@example.test', 'LG Owner'),
  ('00000000-0000-4000-8000-00000000a002', 'lg-admin@example.test', 'LG Admin') on conflict do nothing;

set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-000000000001', 'owner');
select pg_temp.check((select outcome from crm.set_outreach_settings('Asha', '1 Test Road, Pune 411001', null, 20, 5, true)) = 'saved', 'owner saves the sender identity and allows cold outreach');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-000000000001', 'ops_admin');
create temp table fx (k text primary key, v uuid);
grant all on fx to public;
insert into fx select 'tpl', template_id from crm.create_email_template('Intro', 'en', 'A thought for {{company}}', 'Hello {{first_name}}, we build websites. - {{sender_name}}');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-000000000001', 'owner');
select pg_temp.check((select outcome from crm.approve_email_template((select v from fx where k = 'tpl'))) = 'approved', 'a second person approves the template');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-000000000001', 'ops_admin');
select pg_temp.check((select inserted from crm.add_outreach_prospects('[{"email":"buyer@example.test","fullName":"Buyer","company":"Acme","provenance":"public website","lawfulBasis":"b2b_legitimate_interest"}]')) = 1, 'a prospect is added');
insert into fx select 'camp', campaign_id from crm.create_email_campaign('Pause test', '{}', jsonb_build_array(jsonb_build_object('templateId', (select v from fx where k = 'tpl'), 'delayDays', 0)));
select pg_temp.as_user('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-000000000001', 'owner');
select pg_temp.check((select outcome from crm.approve_email_campaign((select v from fx where k = 'camp'))) = 'approved', 'a second person approves the campaign');
select pg_temp.check((select outcome from crm.set_email_campaign_state((select v from fx where k = 'camp'), 'running', null)) = 'running', 'the campaign runs');

reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);

-- 1. the global stop
reset role;
update core.kill_switches set active = false where false;  -- (no-op; keeps the shape obvious)
insert into core.kill_switches (organization_id, switch, active, reason, set_by, set_at)
  values ('00000000-0000-4000-8000-000000000001', 'acquisition_paused', true, 'test', '00000000-0000-4000-8000-00000000a001', now())
  on conflict (organization_id, switch) do update set active = true, reason = 'test';
set local role service_role;
select pg_temp.check((select count(*) from crm.claim_outreach_sends('00000000-0000-4000-8000-000000000001', 10) c where c.campaign_id = (select v from fx where k = 'camp')) = 0, 'with the global stop engaged the email chokepoint sends nothing');
reset role;
select pg_temp.check((select status from crm.email_campaign_recipients where campaign_id = (select v from fx where k = 'camp') limit 1) = 'pending', '…and the recipient is still waiting, not refused or consumed');
select pg_temp.check((select count(*) from crm.email_outreach_sends where campaign_id = (select v from fx where k = 'camp')) = 0, '…and nothing was reserved');
update core.kill_switches set active = false, reason = 'released' where switch = 'acquisition_paused';

-- 2. the channel stop
insert into crm.acquisition_channels (organization_id, channel, paused, pause_reason)
  values ('00000000-0000-4000-8000-000000000001', 'email', true, 'bounce spike')
  on conflict (organization_id, channel) do update set paused = true, pause_reason = 'bounce spike';
set local role service_role;
select pg_temp.check((select count(*) from crm.claim_outreach_sends('00000000-0000-4000-8000-000000000001', 10) c where c.campaign_id = (select v from fx where k = 'camp')) = 0, 'with the email channel paused the chokepoint sends nothing');
reset role;
update crm.acquisition_channels set paused = false, pause_reason = null where channel = 'email';

-- 3. a pause on ANOTHER channel does not stop email
insert into crm.acquisition_channels (organization_id, channel, paused, pause_reason)
  values ('00000000-0000-4000-8000-000000000001', 'social', true, 'unrelated')
  on conflict (organization_id, channel) do update set paused = true, pause_reason = 'unrelated';
set local role service_role;
select pg_temp.check((select count(*) from crm.claim_outreach_sends('00000000-0000-4000-8000-000000000001', 10) c where c.campaign_id = (select v from fx where k = 'camp')) = 1, 'a paused SOCIAL channel does not stop email: the queued send is reserved once everything is clear');
reset role;
select pg_temp.check((select count(*) from crm.email_outreach_sends where status = 'reserved' and campaign_id = (select v from fx where k = 'camp')) = 1, '…as exactly one reservation');

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;
rollback;
