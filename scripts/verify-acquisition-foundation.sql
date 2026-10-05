-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 1 — the doors, driven for real.
--
--   KEEP=1 scripts/apply-migrations-locally.sh        (leaves a scratch Postgres up)
--   psql -h <dir> -p 55432 -U postgres -d agencyos_local -v ON_ERROR_STOP=1 \
--        -f scripts/verify-acquisition-foundation.sql
--
-- Runs as the real request roles with real JWT claims, so it proves what a
-- regex cannot: which caller is refused, what is audited, what another tenant
-- can see. It rolls everything back, so it can be re-run. Any failed check
-- raises, which ends the script non-zero.
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

-- ── fixtures (as the superuser) ────────────────────────────────────────────
insert into core.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000b2', 'Other Agency', 'other-agency')
  on conflict do nothing;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000a001', 'lg-owner@example.test'),
  ('00000000-0000-4000-8000-00000000a002', 'lg-admin@example.test'),
  ('00000000-0000-4000-8000-00000000a003', 'lg-member@example.test'),
  ('00000000-0000-4000-8000-00000000a004', 'lg-other-owner@example.test')
  on conflict do nothing;
insert into core.users (id, email, full_name) values
  ('00000000-0000-4000-8000-00000000a001', 'lg-owner@example.test', 'LG Owner'),
  ('00000000-0000-4000-8000-00000000a002', 'lg-admin@example.test', 'LG Admin'),
  ('00000000-0000-4000-8000-00000000a003', 'lg-member@example.test', 'LG Member'),
  ('00000000-0000-4000-8000-00000000a004', 'lg-other-owner@example.test', 'LG Other')
  on conflict do nothing;

set local role authenticated;

-- ── 1. who may seed ────────────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-000000000001', 'member');
select pg_temp.check((select outcome from crm.ensure_acquisition_defaults()) = 'forbidden', 'a member cannot seed the acquisition defaults');

select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-000000000001', 'ops_admin');
select pg_temp.check((select outcome from crm.ensure_acquisition_defaults()) = 'seeded', 'an admin seeds the defaults');
select pg_temp.check((select count(*) from crm.acquisition_channels) = 5, 'five channel rows exist');
select pg_temp.check((select count(*) from crm.acquisition_channels where enabled) = 0, 'every channel is seeded DISABLED');
select pg_temp.check((select count(*) from crm.target_services) = 3, 'the three default services exist as ordinary rows');
select pg_temp.check((select outcome from crm.ensure_acquisition_defaults()) = 'ready', 'seeding twice is a no-op');
select pg_temp.check((select count(*) from crm.target_services) = 3, '…and does not duplicate the services');

-- ── 2. target services are data ────────────────────────────────────────────
select pg_temp.check((select outcome from crm.set_target_service(null, 'SEO', 'Search engine optimisation', 5, true)) = 'saved', 'an admin adds SEO as a target service');
select pg_temp.check((select outcome from crm.set_target_service(null, 'seo', null, 5, true)) = 'duplicate', 'a case-variant duplicate is refused');
select pg_temp.check((select outcome from crm.set_target_service(null, 'x', null, 5, true)) = 'invalid', 'a one-letter name is refused');
select pg_temp.check((select outcome from crm.set_target_service(null, 'Valid', null, 0, true)) = 'invalid', 'priority 0 is refused');
select pg_temp.check((select outcome from crm.set_target_service((select id from crm.target_services where name = 'App Development'), 'App Development', null, 20, false)) = 'saved', 'a default can be deactivated');
select pg_temp.check((select count(*) from crm.target_services where active) = 3, 'three services are active (SEO + two defaults) — nothing in code assumed the defaults');
select pg_temp.check((select name from crm.target_services where active order by priority limit 1) = 'SEO', 'priority orders the active services');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-000000000001', 'member');
select pg_temp.check((select outcome from crm.set_target_service(null, 'Nope Service', null, 5, true)) = 'forbidden', 'a member cannot add a service');

-- ── 3. per-channel settings and pause ──────────────────────────────────────
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-000000000001', 'ops_admin');
select pg_temp.check((select outcome from crm.set_channel_settings('email', true, 20, 5000000, 50)) = 'saved', 'an admin enables email with a goal, a budget and a daily limit');
select pg_temp.check((select monthly_budget_minor from crm.acquisition_channels where channel = 'email') = 5000000, '…and the budget is stored');
select pg_temp.check((select outcome from crm.set_channel_settings('tiktok', true, 1, 1, 1)) = 'invalid', 'an unknown channel is refused');
select pg_temp.check((select outcome from crm.set_channel_settings('email', true, -1, 1, 1)) = 'invalid', 'a negative goal is refused');
select pg_temp.check(crm.acquisition_blocked('00000000-0000-4000-8000-000000000001', 'email') is null, 'a live channel is not blocked');
select pg_temp.check((select outcome from crm.set_channel_pause('email', true, '')) = 'no_reason', 'pausing needs a reason');
select pg_temp.check((select outcome from crm.set_channel_pause('email', true, 'bounce spike')) = 'set', 'an admin pauses a channel with a reason');
select pg_temp.check(crm.acquisition_blocked('00000000-0000-4000-8000-000000000001', 'email') = 'channel_paused', 'a paused channel is blocked');
select pg_temp.check(crm.acquisition_blocked('00000000-0000-4000-8000-000000000001', 'social') is null, '…and only that channel');
select pg_temp.check((select outcome from crm.set_channel_pause('email', true, 'again')) = 'unchanged', 'pausing twice is unchanged');
select pg_temp.check((select outcome from crm.set_channel_pause('email', false, null)) = 'set', 'resuming needs no reason');
select pg_temp.check(crm.acquisition_blocked('00000000-0000-4000-8000-000000000001', 'email') is null, 'a resumed channel is free again');
select pg_temp.check((select pause_reason from crm.acquisition_channels where channel = 'email') is null, '…and the stale reason is cleared');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-000000000001', 'member');
select pg_temp.check((select outcome from crm.set_channel_pause('email', true, 'nope')) = 'forbidden', 'a member cannot pause a channel');
select pg_temp.check((select outcome from crm.set_channel_settings('email', false, 1, 1, 1)) = 'forbidden', 'a member cannot change channel settings');

-- ── 4. the global brake, and that the old three still work ─────────────────
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-000000000001', 'ops_admin');
select pg_temp.check((select outcome from core.set_kill_switch('acquisition_paused', true, 'test')) = 'not_owner', 'an ops_admin cannot engage the global acquisition stop');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-000000000001', 'owner');
select pg_temp.check((select outcome from core.set_kill_switch('acquisition_paused', true, '')) = 'no_reason', 'the global stop needs a reason');
select pg_temp.check((select outcome from core.set_kill_switch('nonsense_paused', true, 'x')) = 'bad_switch', 'an unknown switch is still refused');
select pg_temp.check((select outcome from core.set_kill_switch('acquisition_paused', true, 'something is wrong')) = 'set', 'the owner engages the global acquisition stop');
select pg_temp.check(crm.acquisition_blocked('00000000-0000-4000-8000-000000000001', 'social') = 'acquisition_paused', 'it blocks a channel that was never individually paused');
select pg_temp.check(crm.acquisition_blocked('00000000-0000-4000-8000-000000000001', 'b2b') = 'acquisition_paused', '…every channel');
select pg_temp.check(not core.org_paused('00000000-0000-4000-8000-000000000001', 'outbound_paused'), 'it does not engage the WhatsApp outbound stop');
select pg_temp.check((select outcome from core.set_kill_switch('jobs_paused', true, 'regression check')) = 'set', 'the existing jobs_paused switch still works');
select pg_temp.check((select outcome from core.set_kill_switch('jobs_paused', false, 'regression check')) = 'set', '…and releases');
select pg_temp.check((select outcome from core.set_kill_switch('acquisition_paused', false, 'resolved')) = 'set', 'the owner releases the global stop');
select pg_temp.check(crm.acquisition_blocked('00000000-0000-4000-8000-000000000001', 'social') is null, 'channels are free again');
select pg_temp.check(crm.acquisition_blocked('00000000-0000-4000-8000-000000000001', 'tiktok') = 'unknown_channel', 'an unknown channel fails closed');
select pg_temp.check(crm.acquisition_blocked('00000000-0000-4000-8000-0000000000b2', 'social') = 'tenant_mismatch', 'a session cannot probe another organisation''s pause state');

-- ── 5. the ICP is history ──────────────────────────────────────────────────
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-000000000001', 'ops_admin');
select pg_temp.check((select (r.outcome, r.version) = ('saved', 1) from crm.save_icp('{"industries":["retail"],"min_qualification_score":60}', 'first') r), 'ICP v1 is saved');
select pg_temp.check((select (r.outcome, r.version) = ('saved', 2) from crm.save_icp('{"industries":["retail","logistics"],"geographies":["IN"]}', 'wider') r), 'a change is the NEXT version');
select pg_temp.check((select count(*) from crm.icp_versions) = 2, 'both versions are kept');
select pg_temp.check((select outcome from crm.save_icp('{"industrys":["x"]}', null)) = 'invalid', 'an unknown key is refused (a typo would never be read)');
select pg_temp.check((select outcome from crm.save_icp('{"industries":"retail"}', null)) = 'invalid', 'a non-array list is refused');
select pg_temp.check((select outcome from crm.save_icp('{"min_qualification_score":101}', null)) = 'invalid', 'a score above 100 is refused');
select pg_temp.check((select outcome from crm.save_icp('[]', null)) = 'invalid', 'a non-object is refused');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-000000000001', 'member');
select pg_temp.check((select outcome from crm.save_icp('{}', null)) = 'forbidden', 'a member cannot save an ICP');

reset role;
do $$
begin
  begin
    update crm.icp_versions set note = 'rewritten' where version = 1;
    raise exception 'FAILED: an ICP version was edited';
  exception when insufficient_privilege then raise notice 'ok  an ICP version cannot be edited'; end;
  begin
    delete from crm.icp_versions where version = 1;
    raise exception 'FAILED: an ICP version was deleted';
  exception when insufficient_privilege then raise notice 'ok  an ICP version cannot be deleted'; end;
end $$;

-- ── 6. another tenant sees nothing and changes nothing ─────────────────────
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-00000000a004', '00000000-0000-4000-8000-0000000000b2', 'owner');
select pg_temp.check((select count(*) from crm.target_services) = 0, 'org B sees none of org A''s target services');
select pg_temp.check((select count(*) from crm.icp_versions) = 0, '…ICP versions');
select pg_temp.check((select count(*) from crm.acquisition_channels) = 0, '…channel settings');
select pg_temp.check((select outcome from crm.set_target_service(null, 'Hijack', null, 1, true)) = 'saved', 'org B with a null id creates in ITS OWN org only');
reset role;
select pg_temp.check((select count(*) from crm.target_services where organization_id = '00000000-0000-4000-8000-0000000000b2') = 1, '…and that row belongs to org B');
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-00000000a004', '00000000-0000-4000-8000-0000000000b2', 'owner');
select pg_temp.check((select outcome from crm.set_target_service((select id from crm.target_services limit 1), 'renamed', null, 1, true)) = 'saved', 'org B edits its own service');
reset role;
select pg_temp.check((select count(*) from crm.target_services where organization_id = '00000000-0000-4000-8000-000000000001' and name = 'renamed') = 0, 'org B''s edit never touched org A');

do $$
declare a uuid;
begin
  select id into a from crm.target_services where organization_id = '00000000-0000-4000-8000-000000000001' limit 1;
  set local role authenticated;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '00000000-0000-4000-8000-00000000a004', 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', '00000000-0000-4000-8000-0000000000b2', 'role', 'owner'))::text, true);
  if (select outcome from crm.set_target_service(a, 'Cross tenant', null, 1, true)) <> 'not_found' then
    raise exception 'FAILED: org B edited org A''s service by id';
  end if;
  raise notice 'ok  org B cannot edit org A''s service by id (not_found)';
  reset role;
end $$;

-- ── 7. everything was audited ──────────────────────────────────────────────
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'acquisition.defaults_seeded') = 1, 'seeding is audited');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action in ('acquisition.channel_paused', 'acquisition.channel_resumed')) = 2, 'pause and resume are audited');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action in ('kill_switch.engaged', 'kill_switch.released') and after::text like '%acquisition_paused%') = 2, 'the global stop is audited both ways');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'acquisition.icp_saved') = 2, 'each ICP version is audited');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'acquisition.channel_settings_changed') = 1, 'channel settings are audited');

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;
rollback;
