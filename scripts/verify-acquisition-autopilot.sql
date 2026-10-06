-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, follow-up - the weekly autopilot (ADM-114). Opt-in, drafts only, once a week.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-autopilot.sql      Rolls back. Any failed check raises.
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

\set PORG '00000000-0000-4000-8000-0000000000a1'
\set POFF '00000000-0000-4000-8000-0000000000a2'
\set POWN '00000000-0000-4000-8000-00000000a101'
\set PMEM '00000000-0000-4000-8000-00000000a102'
insert into auth.users (id, email) values (:'POWN', 'lg-autopilot-owner@example.test'), (:'PMEM', 'lg-autopilot-member@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'POWN', 'lg-autopilot-owner@example.test', 'Autopilot Owner'), (:'PMEM', 'lg-autopilot-member@example.test', 'Autopilot Member') on conflict do nothing;
insert into core.organizations (id, name, slug, timezone) values (:'PORG', 'Autopilot Agency', 'autopilot-agency', 'Asia/Kolkata'), (:'POFF', 'Autopilot Off Agency', 'autopilot-off-agency', 'Asia/Kolkata');
-- the agents are installed disabled; the owner has enabled two of them
update ai.agents set enabled = true, disabled_reason = null where key in ('social_media', 'email_outreach');

select pg_temp.as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select crm.ensure_acquisition_defaults();
select crm.set_channel_settings('social', true, null, null, 3);
select crm.set_channel_settings('email', false, null, null, null);
select crm.set_channel_settings('meta_ads', true, null, null, null);
select pg_temp.check((select count(*) from pg_proc p where p.proname = 'run_acquisition_autopilot' and has_function_privilege('authenticated', p.oid, 'execute')) = 0, 'a signed-in session cannot run the autopilot');
select pg_temp.check((select enabled from crm.acquisition_autopilot where organization_id = :'PORG') is null, 'it is off until an admin turns it on (no row)');
reset role;
-- an organisation that never opted in, with everything else ready
insert into crm.acquisition_channels (organization_id, channel, enabled) values (:'POFF', 'social', true) on conflict do nothing;
insert into crm.acquisition_autopilot (organization_id, enabled) values (:'POFF', false);

set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select queued from crm.run_acquisition_autopilot(timestamptz '2026-10-05 04:00+00') limit 1) = 0, 'nothing is queued for an organisation that did not opt in');
reset role;

-- opting in: admin only, own organisation only
select pg_temp.as_user(:'PMEM', :'PORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from crm.set_acquisition_autopilot(:'PORG', true)) = 'forbidden', 'a member cannot turn the autopilot on');
select pg_temp.as_user(:'POWN', :'POFF', 'owner');
select pg_temp.check((select outcome from crm.set_acquisition_autopilot(:'PORG', true)) = 'forbidden', 'an admin of another organisation cannot turn it on here');
select pg_temp.as_user(:'POWN', :'PORG', 'owner');
select pg_temp.check((select outcome from crm.set_acquisition_autopilot(:'PORG', true)) = 'saved', 'an admin turns it on');
reset role;

set local role service_role;
select pg_temp.as_service();
-- Monday 2026-10-05 03:00 UTC is 08:30 in Kolkata: the week has not opened yet
select pg_temp.check((select queued from crm.run_acquisition_autopilot(timestamptz '2026-10-05 03:00+00') limit 1) = 0, 'before Monday 09:00 local nothing is queued');
-- 04:00 UTC is 09:30 in Kolkata
select crm.run_acquisition_autopilot(timestamptz '2026-10-05 04:00+00');
select pg_temp.check((select count(*) from core.jobs where organization_id = :'PORG' and kind = 'social.assist') = 1, 'Monday 09:30 local: the Social Media agent is given its weekly task');
select pg_temp.check((select count(*) from core.jobs where organization_id = :'PORG' and kind = 'email.assist') = 0, '…an enabled agent whose channel is not in the plan is not');
select pg_temp.check((select count(*) from core.jobs where organization_id = :'PORG' and kind = 'ads.assist') = 0, '…and a channel in the plan whose agent is switched off is not');
select pg_temp.check((select count(*) from core.jobs where organization_id = :'PORG' and kind = 'marketplace.assist') = 0, '…nor an agent whose channel was never set up');
select pg_temp.check((select (payload ->> 'autopilot')::boolean from core.jobs where organization_id = :'PORG' and kind = 'social.assist'), 'the job says it was the autopilot, not a person');
select pg_temp.check((select payload ->> 'task' from core.jobs where organization_id = :'PORG' and kind = 'social.assist') like '%submit only those that pass%', 'its task asks for drafts and approval, nothing else');
select crm.run_acquisition_autopilot(timestamptz '2026-10-05 05:00+00');
select crm.run_acquisition_autopilot(timestamptz '2026-10-08 10:00+00');
select pg_temp.check((select count(*) from core.jobs where organization_id = :'PORG' and kind = 'social.assist') = 1, 'running it again in the same week queues nothing more');
select crm.run_acquisition_autopilot(timestamptz '2026-10-12 04:00+00');
select pg_temp.check((select count(*) from core.jobs where organization_id = :'PORG' and kind = 'social.assist') = 2, 'the next week is given its own task');
select pg_temp.check((select count(*) from core.jobs where organization_id = :'POFF') = 0, 'the organisation that did not opt in was never given one');
reset role;

-- a stop beats the autopilot
select pg_temp.as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select crm.set_channel_pause('social', true, 'testing the stop');
reset role;
set local role service_role;
select pg_temp.as_service();
select crm.run_acquisition_autopilot(timestamptz '2026-10-19 04:00+00');
select pg_temp.check((select count(*) from core.jobs where organization_id = :'PORG' and kind = 'social.assist') = 2, 'a paused channel is not given the next week''s task');
reset role;

select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'agent.autopilot_queued') >= 2, 'each queued task is audited');
select 'ALL CHECKS PASSED' as result;
rollback;
