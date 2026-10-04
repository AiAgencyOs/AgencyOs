-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 4 — connectors, one policy question, exact-version
-- approvals - driven for real as the request roles, through the REAL approval
-- engine.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-governance.sql
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

create or replace function pg_temp.h(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
grant execute on function pg_temp.h(text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b2'
\set OWNER '00000000-0000-4000-8000-00000000a001'
\set ADMIN '00000000-0000-4000-8000-00000000a002'
\set MEMBER '00000000-0000-4000-8000-00000000a003'
\set OTHER '00000000-0000-4000-8000-00000000a004'

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency', 'other-agency') on conflict do nothing;
insert into auth.users (id, email) values
  (:'OWNER', 'lg-owner@example.test'), (:'ADMIN', 'lg-admin@example.test'), (:'MEMBER', 'lg-member@example.test'), (:'OTHER', 'lg-other-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values
  (:'OWNER', 'lg-owner@example.test', 'LG Owner'), (:'ADMIN', 'lg-admin@example.test', 'LG Admin'),
  (:'MEMBER', 'lg-member@example.test', 'LG Member'), (:'OTHER', 'lg-other-owner@example.test', 'LG Other') on conflict do nothing;
create temp table fx (k text primary key, v uuid);
grant all on fx to public;

-- ═══ A. the registry is honest about what it is ═══════════════════════════
set local role authenticated;
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from crm.register_integration('upwork', 'production', null, false)) = 'forbidden', 'a member cannot register an integration');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
insert into fx select 'upwork', integration_id from crm.register_integration('upwork', 'production', null, false);
select pg_temp.check((select (status, verification) = ('UNCONFIGURED', 'NOT_IMPLEMENTED') from crm.acquisition_integrations where id = (select v from fx where k = 'upwork')), 'an Upwork connection with no adapter is UNCONFIGURED and NOT_IMPLEMENTED');
select pg_temp.check((select outcome from crm.register_integration('upwork', 'production', null, false)) = 'duplicate', 'the same provider/environment/label cannot be registered twice');
select pg_temp.check((select outcome from crm.register_integration('tiktok', 'production', null, false)) = 'invalid', 'an unknown provider is refused');
select pg_temp.check((select outcome from crm.register_integration('upwork', 'prod', 'x', false)) = 'invalid', 'an unknown environment is refused');
select pg_temp.check((select integration_type from crm.acquisition_integrations where id = (select v from fx where k = 'upwork')) = 'marketplace', 'the type is derived from the provider, not typed');

reset role;
do $$
begin
  begin update crm.acquisition_integrations set verification = 'LIVE_VERIFIED' where provider = 'upwork'; raise exception 'FAILED: verification was written directly';
  exception when insufficient_privilege then raise notice 'ok  verification cannot be written except through the registry doors (a direct write is refused)'; end;
  begin update crm.acquisition_integrations set status = 'ACTIVE' where provider = 'upwork'; raise exception 'FAILED: status was written directly';
  exception when insufficient_privilege then raise notice 'ok  nor can status'; end;
end $$;

-- credentials: owner only, encrypted by the app, never readable by a session
set local role authenticated;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.store_connector_secret((select v from fx where k = 'upwork'), 'api_key', 'Y2lwaGVydGV4dC1vbmU=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'wxyz', null)) = 'not_owner', 'an ops admin cannot store a provider credential (owner only)');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from crm.store_connector_secret((select v from fx where k = 'upwork'), 'api_key', 'Y2lwaGVydGV4dC1vbmU=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'wxyz', null)) = 'stored', 'the owner stores a credential');
select pg_temp.check((select outcome from crm.store_connector_secret((select v from fx where k = 'upwork'), 'Bad Name', 'x', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', null, null)) = 'invalid', 'a malformed credential name is refused');
select pg_temp.check((select (status, verification) = ('CONFIGURED', 'NOT_IMPLEMENTED') from crm.acquisition_integrations where id = (select v from fx where k = 'upwork')), 'it becomes CONFIGURED, but stays NOT_IMPLEMENTED: a stored key does not make an unbuilt adapter look connected');
select pg_temp.check((select outcome from crm.store_connector_secret((select v from fx where k = 'upwork'), 'api_key', 'Y2lwaGVydGV4dC10d28=', 'aXYtdmFsdWUy', 'dGFnLXZhbHVlMg==', 'abcd', null)) = 'rotated', 'storing again ROTATES');
select pg_temp.check((select count(*) from crm.connector_credentials where integration_id = (select v from fx where k = 'upwork') and status = 'active') = 1, '…leaving exactly one active credential');
select pg_temp.check((select count(*) from crm.connector_credentials where integration_id = (select v from fx where k = 'upwork') and status = 'revoked') = 1, '…and the old one kept as revoked history');
select pg_temp.check((select hint from crm.connector_credentials where integration_id = (select v from fx where k = 'upwork') and status = 'active') = 'abcd', 'a session can read the hint');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
do $$
begin
  begin perform ciphertext from crm.connector_credentials limit 1; raise exception 'FAILED: a session read ciphertext';
  exception when insufficient_privilege then raise notice 'ok  not even the owner''s session can read the ciphertext'; end;
  begin perform iv from crm.connector_credentials limit 1; raise exception 'FAILED: a session read the iv';
  exception when insufficient_privilege then raise notice 'ok  nor the iv'; end;
  begin perform auth_tag from crm.connector_credentials limit 1; raise exception 'FAILED: a session read the tag';
  exception when insufficient_privilege then raise notice 'ok  nor the auth tag'; end;
end $$;
reset role;
select pg_temp.check((select count(*) from audit.audit_log where action in ('integration.secret_stored', 'integration.secret_rotated')) = 2, 'storing and rotating are audited');
select pg_temp.check((select count(*) from audit.audit_log where action like 'integration.%' and (after::text like '%Y2lwaGVydGV4dC%' or after::text like '%aXYtdmFsdWU%')) = 0, '…and no ciphertext or iv ever reached the audit log');

set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select outcome from crm.record_integration_check(:'ORG', (select v from fx where k = 'upwork'), true, 'acct', '{}', null, null)) = 'no_adapter', 'a check on a provider with NO adapter can never produce a verified state');

-- a provider whose adapter exists
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'meta', integration_id from crm.register_integration('meta_ads', 'production', null, true);
select pg_temp.check((select (verification, adapter_implemented) = ('NOT_IMPLEMENTED', false) from crm.acquisition_integrations where id = (select v from fx where k = 'meta')), 'a caller''s CLAIM that an adapter exists is ignored: the connection starts NOT_IMPLEMENTED');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'meta'), true);
select pg_temp.check((select verification from crm.acquisition_integrations where id = (select v from fx where k = 'meta')) = 'IMPLEMENTED_NOT_CONFIGURED', 'the ENGINE''s own sync is what says an adapter exists: only then does it start IMPLEMENTED_NOT_CONFIGURED');
select pg_temp.check((select outcome from crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), true, 'act_1', '{}', null, null)) = 'no_credential', 'a check with no credential stored is refused');
reset role;
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select crm.store_connector_secret((select v from fx where k = 'meta'), 'access_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'meta', null);
select pg_temp.check((select verification from crm.acquisition_integrations where id = (select v from fx where k = 'meta')) = 'CONFIGURED_NOT_VERIFIED', 'storing the credential makes it CONFIGURED_NOT_VERIFIED');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select outcome from crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), true, 'act_1', '{"READ_AD_METRICS":"AUTOMATED","CREATE_CAMPAIGN":"ASSISTED"}', null, null, 'v21')) = 'recorded', 'a passing adapter check is recorded');
select pg_temp.check((select (status, verification, account_ref, api_version) = ('ACTIVE', 'LIVE_VERIFIED', 'act_1', 'v21') from crm.acquisition_integrations where id = (select v from fx where k = 'meta')), '…production + passing = ACTIVE / LIVE_VERIFIED');
select pg_temp.check((select capabilities ->> 'CREATE_CAMPAIGN' from crm.acquisition_integrations where id = (select v from fx where k = 'meta')) = 'ASSISTED', '…with capabilities stored per mode');
select pg_temp.check((select outcome from crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), true, null, '{"FLY_TO_MOON":"AUTOMATED"}', null, null)) = 'invalid', 'an unknown capability is refused');
select pg_temp.check((select outcome from crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), true, null, '{"SEARCH":"MAGIC"}', null, null)) = 'invalid', '…as is an unknown mode');
select pg_temp.check((select outcome from crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), false, null, null, null, null)) = 'invalid', 'a failure must carry an error class');
select crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), false, null, null, 'transient', 'timeout talking to the provider');
select pg_temp.check((select (status, verification, last_error_class) = ('DEGRADED', 'DEGRADED', 'transient') from crm.acquisition_integrations where id = (select v from fx where k = 'meta')), 'a transient failure DEGRADES an active connection');
select crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), false, null, null, 'conditional', 'token expired');
select pg_temp.check((select verification from crm.acquisition_integrations where id = (select v from fx where k = 'meta')) = 'BLOCKED_BY_CREDENTIAL', 'a conditional failure (expired token) is BLOCKED_BY_CREDENTIAL');
select crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), false, null, null, 'permanent', 'app review not approved');
select pg_temp.check((select verification from crm.acquisition_integrations where id = (select v from fx where k = 'meta')) = 'BLOCKED_BY_PROVIDER', 'a permanent failure is BLOCKED_BY_PROVIDER');
select crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), true, 'act_1', null, null, null);
select pg_temp.check((select (status, verification) = ('ACTIVE', 'LIVE_VERIFIED') from crm.acquisition_integrations where id = (select v from fx where k = 'meta')), 'a passing check recovers it');

-- sandbox is not live
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
insert into fx select 'meta_stg', integration_id from crm.register_integration('meta_ads', 'staging', null, true);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select crm.store_connector_secret((select v from fx where k = 'meta_stg'), 'access_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'stg1', null);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'meta_stg'), true);
select crm.record_integration_check(:'ORG', (select v from fx where k = 'meta_stg'), true, 'act_sandbox', null, null, null);
select pg_temp.check((select verification from crm.acquisition_integrations where id = (select v from fx where k = 'meta_stg')) = 'SANDBOX_VERIFIED', 'a passing STAGING check is SANDBOX_VERIFIED, never LIVE_VERIFIED');

-- an adapter ships later
select pg_temp.check((select outcome from crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'upwork'), true)) = 'synced', 'when an adapter ships the registry is told');
select pg_temp.check((select verification from crm.acquisition_integrations where id = (select v from fx where k = 'upwork')) = 'CONFIGURED_NOT_VERIFIED', '…and a stored credential moves it to CONFIGURED_NOT_VERIFIED (still not verified)');
select pg_temp.check((select outcome from crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'upwork'), false)) = 'synced', 'an adapter removed moves it back to NOT_IMPLEMENTED');
select pg_temp.check((select verification from crm.acquisition_integrations where id = (select v from fx where k = 'upwork')) = 'NOT_IMPLEMENTED', '…honestly');

-- lifecycle: disable, re-enable, revoke
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.set_integration_state((select v from fx where k = 'meta'), 'DISABLED', '')) = 'needs_reason', 'disabling needs a reason');
select pg_temp.check((select outcome from crm.set_integration_state((select v from fx where k = 'meta'), 'DISABLED', 'pausing the account')) = 'set', 'an admin disables an integration');
select pg_temp.check((select (status, verification) = ('DISABLED', 'DISABLED') from crm.acquisition_integrations where id = (select v from fx where k = 'meta')), '…status and verification both say so');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select outcome from crm.record_integration_check(:'ORG', (select v from fx where k = 'meta'), true, null, null, null, null)) = 'not_live', 'a disabled integration cannot be checked back to life');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.set_integration_state((select v from fx where k = 'meta'), 'CONFIGURED', 're-enabling')) = 'set', 'it can be re-enabled');
select pg_temp.check((select verification from crm.acquisition_integrations where id = (select v from fx where k = 'meta')) = 'CONFIGURED_NOT_VERIFIED', '…but is NOT verified again until it is re-tested');
select pg_temp.check((select outcome from crm.set_integration_state((select v from fx where k = 'meta'), 'REVOKED', 'closing')) = 'not_owner', 'an ops admin cannot revoke (owner only)');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from crm.set_integration_state((select v from fx where k = 'meta'), 'REVOKED', 'account closed')) = 'set', 'the owner revokes');
select pg_temp.check((select count(*) from crm.connector_credentials where integration_id = (select v from fx where k = 'meta') and status = 'active') = 0, '…which revokes its credentials too');
select pg_temp.check((select outcome from crm.store_connector_secret((select v from fx where k = 'meta'), 'access_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', null, null)) = 'revoked', 'a revoked integration accepts no credential');
select pg_temp.check((select outcome from crm.set_integration_state((select v from fx where k = 'meta'), 'CONFIGURED', 'undo')) = 'revoked', 'REVOKED is terminal');

-- ═══ B. the policy decision ═══════════════════════════════════════════════
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.ensure_acquisition_defaults();
select pg_temp.check((select decision from crm.acquisition_decide(:'ORG', 'email_outreach')) = 'ADMIN_APPROVAL_REQUIRED', 'an action with NO policy needs approval (no policy is not permission)');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'email_outreach')) = 'no_policy_default', '…and says why');
select pg_temp.check((select decision from crm.acquisition_decide(:'ORG', 'launch_rocket')) = 'BLOCK', 'an unknown action is BLOCKED');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'ad_launch')) = 'channel_required', 'an ad action must say which ad channel');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORGB', 'email_outreach')) = 'tenant_mismatch', 'a session cannot ask about another organisation');

select pg_temp.check((select outcome from crm.set_acquisition_policy('social_publish', 'auto', null, null)) = 'never_auto', 'social publishing can never be set to auto');
select pg_temp.check((select outcome from crm.set_acquisition_policy('b2b_proposal_submit', 'auto', null, null)) = 'never_auto', '…nor a B2B proposal submission');
select pg_temp.check((select outcome from crm.set_acquisition_policy('ad_launch', 'auto', null, null)) = 'never_auto', '…nor a campaign launch');
select pg_temp.check((select outcome from crm.set_acquisition_policy('landing_page_deploy', 'auto', null, null)) = 'never_auto', '…nor a page deployment');
select pg_temp.check((select outcome from crm.set_acquisition_policy('profile_update', 'auto', null, null)) = 'never_auto', '…nor a profile update');
select pg_temp.check((select outcome from crm.set_acquisition_policy('launch_rocket', 'approval', null, null)) = 'invalid', 'an unknown action type is refused');
select pg_temp.check((select outcome from crm.set_acquisition_policy('email_outreach', 'auto', 1000, 5000)) = 'not_owner', 'an ops admin cannot LOOSEN governance to auto');
select pg_temp.check((select outcome from crm.set_acquisition_policy('email_outreach', 'approval', null, null)) = 'saved', 'an ops admin can tighten to approval');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from crm.set_acquisition_policy('email_outreach', 'auto', 1000, 5000)) = 'saved', 'the owner may set email outreach to auto, with thresholds');
select pg_temp.check((select decision from crm.acquisition_decide(:'ORG', 'email_outreach', null, 500)) = 'AUTO_APPROVE', 'within the threshold: AUTO_APPROVE');
select pg_temp.check((select decision from crm.acquisition_decide(:'ORG', 'email_outreach', null, 2000)) = 'ADMIN_APPROVAL_REQUIRED', 'above the auto threshold: ADMIN_APPROVAL_REQUIRED');
select pg_temp.check((select (decision, required_role) = ('ESCALATE', 'owner') from crm.acquisition_decide(:'ORG', 'email_outreach', null, 6000)), 'above the escalation threshold: ESCALATE to the owner');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.set_acquisition_policy('email_outreach', 'auto', 9000, 5000)) = 'not_owner', 'an admin cannot RAISE the auto threshold');
select pg_temp.check((select outcome from crm.set_acquisition_policy('email_outreach', 'auto', 200, 5000)) = 'saved', '…but can lower it');
select pg_temp.check((select decision from crm.acquisition_decide(:'ORG', 'email_outreach', null, 500)) = 'ADMIN_APPROVAL_REQUIRED', '…and the lowered threshold applies at once');
select pg_temp.check((select outcome from crm.set_acquisition_policy('discount', 'block', null, null)) = 'saved', 'an admin can block an action type');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'discount', null, 100)) = 'blocked_by_policy', '…and it is BLOCKED by policy');

-- the stops
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select core.set_kill_switch('acquisition_paused', true, 'governance test');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'email_outreach', null, 10)) = 'acquisition_paused', 'the global stop BLOCKS an outreach decision');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'social_outreach', null, 10)) = 'acquisition_paused', '…on every channel');
select pg_temp.check((select decision from crm.acquisition_decide(:'ORG', 'special_offer', null, 0)) <> 'BLOCK' or (select reason from crm.acquisition_decide(:'ORG', 'special_offer', null, 0)) <> 'acquisition_paused', 'a purely commercial action has no channel to pause');
select core.set_kill_switch('acquisition_paused', false, 'released');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select crm.set_channel_pause('email', true, 'bounce spike');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'email_followup', null, 0)) = 'channel_paused', 'a paused channel BLOCKS its actions');
select crm.set_channel_pause('email', false, null);

-- a connector the action needs
select crm.set_acquisition_policy('social_publish', 'approval', null, null);
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'social_publish')) = 'channel_not_enabled', 'a channel that is not part of the plan does not act, even before its connector is asked');
select crm.set_channel_settings('social', true, null, null, 100);
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'social_publish')) = 'integration_not_active', 'publishing with NO active social connector is BLOCKED');
insert into fx select 'li', integration_id from crm.register_integration('linkedin', 'production', null, true);
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select crm.store_connector_secret((select v from fx where k = 'li'), 'access_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', 'link', null);
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'social_publish')) = 'integration_not_active', '…a stored credential alone does not make it active');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select crm.sync_integration_adapter(:'ORG', (select v from fx where k = 'li'), true);
select crm.record_integration_check(:'ORG', (select v from fx where k = 'li'), true, 'urn:li:org:1', '{"PUBLISH_CONTENT":"AUTOMATED"}', null, null);
select pg_temp.check((select decision from crm.acquisition_decide(:'ORG', 'social_publish')) = 'ADMIN_APPROVAL_REQUIRED', 'once a connector passes a real check, publishing is ADMIN_APPROVAL_REQUIRED (never auto)');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'landing_page_deploy')) = 'channel_not_enabled', 'a page deployment under a channel that is not in the plan is refused');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_settings('google_ads', true, null, null, 100);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'landing_page_deploy')) = 'integration_not_active', 'a page deployment needs the Hostinger connector specifically');

-- limits
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_settings('social', true, 10, 1000000, 2);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select outcome from crm.record_acquisition_usage(:'ORG', 'social', 'action', 2, 'a-1')) = 'recorded', 'usage is recorded');
select pg_temp.check((select outcome from crm.record_acquisition_usage(:'ORG', 'social', 'action', 2, 'a-1')) = 'duplicate', '…idempotently by ref');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'social_publish', null, 0, 1)) = 'daily_limit', 'the daily action limit BLOCKS the next action');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_settings('social', true, 10, 1000000, 100);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select crm.record_acquisition_usage(:'ORG', 'social', 'spend_minor', 800000, 's-1');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'social_publish', null, 300000, 0)) = 'monthly_budget_exceeded', 'a spend past the monthly budget is BLOCKED (a cap is a cap)');
select pg_temp.check((select reason from crm.acquisition_decide(:'ORG', 'social_publish', null, 100000, 0)) <> 'monthly_budget_exceeded', '…while one inside it is not');
reset role;
do $$
begin
  begin update crm.acquisition_usage set amount = 0; raise exception 'FAILED: usage was edited';
  exception when insufficient_privilege then raise notice 'ok  the usage ledger is append-only'; end;
  begin delete from crm.acquisition_decisions; raise exception 'FAILED: decisions were deleted';
  exception when insufficient_privilege then raise notice 'ok  decisions are never deleted'; end;
end $$;
select pg_temp.check((select count(*) from crm.acquisition_decisions where organization_id = :'ORG') >= 15, 'every decision was logged');

-- ═══ C. approvals bound to the exact content ══════════════════════════════
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from crm.ensure_acquisition_approval_policies()) = 'forbidden', 'a member cannot seed the approval policies');
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.ensure_acquisition_approval_policies()) = 'ready', 'an admin seeds the approval policies for the new subject types');
select pg_temp.check((select outcome from crm.ensure_acquisition_approval_policies()) = 'ready', '…idempotently');
select pg_temp.check((select count(*) from approvals.approval_policies where organization_id = :'ORG' and subject_type = 'social_content') = 1, '…without duplicating a policy');
reset role;

insert into fx values ('a1', gen_random_uuid()), ('a2', gen_random_uuid()), ('a3', gen_random_uuid()), ('a4', gen_random_uuid()), ('a5', gen_random_uuid());
set local role service_role;
select set_config('request.jwt.claims', '', true);
insert into fx select 'req1', request_id from crm.bind_approval(:'ORG', 'social_content', (select v from fx where k = 'a1'), 1, pg_temp.h('post v1'), 'LinkedIn post v1', null, 'system', null);
select pg_temp.check((select outcome from crm.bind_approval(:'ORG', 'social_content', (select v from fx where k = 'a1'), 1, pg_temp.h('post v1'), 'LinkedIn post v1', null, 'system', null)) = 'already_pending', 'asking again for the same version finds the pending request');
select pg_temp.check((select outcome from crm.bind_approval(:'ORG', 'social_content', (select v from fx where k = 'a1'), 1, pg_temp.h('post v1 EDITED'), 'x', null, 'system', null)) = 'content_changed', 'the same version id with different content is REFUSED (versions are immutable; make a new one)');
select pg_temp.check((select outcome from crm.bind_approval(:'ORG', 'social_content', (select v from fx where k = 'a2'), 1, 'nothex', 'x', null, 'system', null)) = 'invalid', 'a malformed hash is refused');
select pg_temp.check((select outcome from crm.bind_approval(:'ORGB', 'social_content', gen_random_uuid(), 1, pg_temp.h('z'), 'x', null, 'system', null)) = 'no_policy', 'an organisation with no approval policy cannot raise one (never default-open)');
select pg_temp.check((select covered from crm.approval_check((select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v1'))) = false, 'before anyone decides, nothing is covered');
select pg_temp.check((select reason from crm.approval_check((select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v1'))) = 'state_pending', '…and the reason is the state');
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v1'), 'social_publish', 'social')) = 'not_covered', 'CASE 1 - publishing without approval is refused');

reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from approvals.decide_approval((select v from fx where k = 'req1'), 'approved', 'looks right')) = 'decided', 'a person approves version 1 through the REAL approval engine');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select covered from crm.approval_check((select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v1'))), 'the approval covers exactly that content');
select pg_temp.check((select reason from crm.approval_check((select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v2'))) = 'content_changed', 'CASE 2 - the same approval does NOT cover changed content');
select pg_temp.check((select reason from crm.approval_check((select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a2'), pg_temp.h('post v1'))) = 'artifact_mismatch', '…nor a different artifact with the same content');
select pg_temp.check((select reason from crm.approval_check((select v from fx where k = 'req1'), 'b2b_proposal', (select v from fx where k = 'a1'), pg_temp.h('post v1'))) = 'artifact_mismatch', '…nor a different kind of artifact');
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a2'), pg_temp.h('post v2'), 'social_publish', 'social')) = 'not_covered', 'version 2 cannot publish on version 1''s approval');
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORGB', (select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v1'), 'social_publish', 'social')) = 'not_covered', 'another organisation cannot execute this approval');

-- CASE 3/4: approve exactly, publish once, replay does nothing
insert into fx select 'exec1', execution_id from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v1'), 'social_publish', 'social');
select pg_temp.check((select status from crm.governed_executions where id = (select v from fx where k = 'exec1')) = 'executing', 'CASE 3 - the exact approved version proceeds (executing)');
select pg_temp.check((select (outcome, reason) = ('in_progress', 'executing') from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v1'), 'social_publish', 'social')), 'a duplicate job meanwhile sees IN PROGRESS and does not start a second');
select pg_temp.check((select outcome from crm.finish_governed_execution(:'ORG', (select v from fx where k = 'exec1'), 'executed', 'urn:li:share:123', '{"http":200}')) = 'recorded', 'the provider accepted it: EXECUTED');
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v1'), 'social_publish', 'social')) = 'already_executed', 'CASE 4 - a REPLAYED publish job does nothing: already executed');
select pg_temp.check((select count(*) from crm.governed_executions where approval_request_id = (select v from fx where k = 'req1')) = 1, '…and there is still exactly one execution row');
select pg_temp.check((select outcome from crm.verify_governed_execution(:'ORG', (select v from fx where k = 'exec1'), '{"found":true}')) = 'verified', 'the post is confirmed to exist: VERIFIED (a separate step from executed)');
select pg_temp.check((select outcome from crm.verify_governed_execution(:'ORG', (select v from fx where k = 'exec1'), '{}')) = 'already_verified', '…once');
select pg_temp.check((select outcome from crm.finish_governed_execution(:'ORG', (select v from fx where k = 'exec1'), 'failed', null, '{}')) = 'wrong_state', 'a verified execution cannot be marked failed');

-- the pause is re-read at EXECUTION time, not queue time
insert into fx select 'req2', request_id from crm.bind_approval(:'ORG', 'social_content', (select v from fx where k = 'a2'), 1, pg_temp.h('post two'), 'post two', null, 'system', null);
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select v from fx where k = 'req2'), 'approved', 'ok');
select crm.set_channel_pause('social', true, 'stop publishing');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select (outcome, reason) = ('blocked', 'channel_paused') from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req2'), 'social_content', (select v from fx where k = 'a2'), pg_temp.h('post two'), 'social_publish', 'social')), 'an APPROVED job queued before a pause is BLOCKED at execution time');
select pg_temp.check((select count(*) from crm.governed_executions where approval_request_id = (select v from fx where k = 'req2')) = 0, '…and nothing was reserved');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select crm.set_channel_pause('social', false, null);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req2'), 'social_content', (select v from fx where k = 'a2'), pg_temp.h('post two'), 'social_publish', 'social')) = 'proceed', 'after resume it proceeds (the approval was never spent)');

-- an approval that expired
insert into fx select 'req3', request_id from crm.bind_approval(:'ORG', 'social_content', (select v from fx where k = 'a3'), 1, pg_temp.h('post three'), 'post three', null, 'system', null, 1);
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select v from fx where k = 'req3'), 'approved', 'ok');
reset role;
alter table crm.approval_bindings disable trigger approval_bindings_immutable;
update crm.approval_bindings set valid_until = now() - interval '1 minute' where approval_request_id = (select v from fx where k = 'req3');
alter table crm.approval_bindings enable trigger approval_bindings_immutable;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select reason from crm.approval_check((select v from fx where k = 'req3'), 'social_content', (select v from fx where k = 'a3'), pg_temp.h('post three'))) = 'expired', 'an approval past its validity window no longer covers anything');
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req3'), 'social_content', (select v from fx where k = 'a3'), pg_temp.h('post three'), 'social_publish', 'social')) = 'not_covered', '…and cannot start an execution');

-- a rejected approval
insert into fx select 'req4', request_id from crm.bind_approval(:'ORG', 'social_content', (select v from fx where k = 'a4'), 1, pg_temp.h('post four'), 'post four', null, 'system', null);
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select v from fx where k = 'req4'), 'rejected', 'not on brand');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select reason from crm.approval_check((select v from fx where k = 'req4'), 'social_content', (select v from fx where k = 'a4'), pg_temp.h('post four'))) = 'state_rejected', 'a REJECTED approval covers nothing');

-- failure, retry and exhaustion
insert into fx select 'req5', request_id from crm.bind_approval(:'ORG', 'b2b_proposal', (select v from fx where k = 'a5'), 1, pg_temp.h('proposal one'), 'proposal one', 50000, 'system', null);
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select v from fx where k = 'req5'), 'approved', 'ok');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
insert into fx select 'exec5', execution_id from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req5'), 'b2b_proposal', (select v from fx where k = 'a5'), pg_temp.h('proposal one'), 'b2b_proposal_submit', 'b2b');
select crm.finish_governed_execution(:'ORG', (select v from fx where k = 'exec5'), 'failed', null, '{"error":"502"}');
select pg_temp.check((select (outcome, reason) = ('proceed', 'retry_after_failure') from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req5'), 'b2b_proposal', (select v from fx where k = 'a5'), pg_temp.h('proposal one'), 'b2b_proposal_submit', 'b2b')), 'a FAILED execution may be retried');
select crm.finish_governed_execution(:'ORG', (select v from fx where k = 'exec5'), 'failed', null, '{}');
select crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req5'), 'b2b_proposal', (select v from fx where k = 'a5'), pg_temp.h('proposal one'), 'b2b_proposal_submit', 'b2b');
select crm.finish_governed_execution(:'ORG', (select v from fx where k = 'exec5'), 'failed', null, '{}');
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req5'), 'b2b_proposal', (select v from fx where k = 'a5'), pg_temp.h('proposal one'), 'b2b_proposal_submit', 'b2b')) = 'exhausted', 'after three failed attempts it is EXHAUSTED, not looped forever');
select pg_temp.check((select attempt from crm.governed_executions where id = (select v from fx where k = 'exec5')) = 3, '…the attempts are counted');

-- an uncertain outcome is reconciled, never blindly retried
insert into fx values ('a6', gen_random_uuid());
insert into fx select 'req6', request_id from crm.bind_approval(:'ORG', 'b2b_proposal', (select v from fx where k = 'a6'), 1, pg_temp.h('proposal two'), 'proposal two', 50000, 'system', null);
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select v from fx where k = 'req6'), 'approved', 'ok');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
insert into fx select 'exec6', execution_id from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req6'), 'b2b_proposal', (select v from fx where k = 'a6'), pg_temp.h('proposal two'), 'b2b_proposal_submit', 'b2b');
select crm.finish_governed_execution(:'ORG', (select v from fx where k = 'exec6'), 'unknown', null, '{"timeout":true}');
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req6'), 'b2b_proposal', (select v from fx where k = 'a6'), pg_temp.h('proposal two'), 'b2b_proposal_submit', 'b2b')) = 'needs_reconciliation', 'a timeout after a possible submission is NOT retried: it needs reconciliation');
select pg_temp.check((select outcome from crm.finish_governed_execution(:'ORG', (select v from fx where k = 'exec6'), 'executed', 'ext-77', '{"found_at_provider":true}')) = 'recorded', 'reconciling against the provider settles it as executed');
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req6'), 'b2b_proposal', (select v from fx where k = 'a6'), pg_temp.h('proposal two'), 'b2b_proposal_submit', 'b2b')) = 'already_executed', '…and the proposal is never submitted twice');

-- a worker that died mid-execution
insert into fx values ('a7', gen_random_uuid());
insert into fx select 'req7', request_id from crm.bind_approval(:'ORG', 'b2b_proposal', (select v from fx where k = 'a7'), 1, pg_temp.h('proposal three'), 'p3', 1000, 'system', null);
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
select approvals.decide_approval((select v from fx where k = 'req7'), 'approved', 'ok');
reset role;
set local role service_role;
select set_config('request.jwt.claims', '', true);
insert into fx select 'exec7', execution_id from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req7'), 'b2b_proposal', (select v from fx where k = 'a7'), pg_temp.h('proposal three'), 'b2b_proposal_submit', 'b2b');
reset role;
update crm.governed_executions set started_at = now() - interval '30 minutes' where id = (select v from fx where k = 'exec7');
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select outcome from crm.begin_governed_execution(:'ORG', (select v from fx where k = 'req7'), 'b2b_proposal', (select v from fx where k = 'a7'), pg_temp.h('proposal three'), 'b2b_proposal_submit', 'b2b')) = 'needs_reconciliation', 'a stalled EXECUTING row is flagged for reconciliation, not re-run');
select pg_temp.check((select status from crm.governed_executions where id = (select v from fx where k = 'exec7')) = 'unknown', '…its status honestly says unknown');

-- ═══ D. privileges, tenancy, audit ════════════════════════════════════════
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
do $$
begin
  begin perform * from crm.begin_governed_execution(gen_random_uuid(), gen_random_uuid(), 'social_content', gen_random_uuid(), repeat('a', 64), 'social_publish', 'social');
    raise exception 'FAILED: a session called begin_governed_execution';
  exception when insufficient_privilege then raise notice 'ok  begin_governed_execution is not callable by a session'; end;
  begin perform * from crm.finish_governed_execution(gen_random_uuid(), gen_random_uuid(), 'executed', null, '{}');
    raise exception 'FAILED: a session called finish_governed_execution';
  exception when insufficient_privilege then raise notice 'ok  finish_governed_execution is not callable by a session'; end;
  begin perform * from crm.record_integration_check(gen_random_uuid(), gen_random_uuid(), true, null, null, null, null);
    raise exception 'FAILED: a session recorded an integration check';
  exception when insufficient_privilege then raise notice 'ok  record_integration_check is not callable by a session: nobody can self-declare a connection verified'; end;
  begin perform * from crm.record_acquisition_usage(gen_random_uuid(), 'social', 'action', 1);
    raise exception 'FAILED: a session recorded usage';
  exception when insufficient_privilege then raise notice 'ok  usage cannot be recorded (or erased) by a session'; end;
end $$;
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.acquisition_integrations) = 0, 'organisation B sees none of organisation A''s integrations');
select pg_temp.check((select count(*) from crm.connector_credentials) = 0, '…credentials');
select pg_temp.check((select count(*) from crm.acquisition_policies) = 0, '…policies');
select pg_temp.check((select count(*) from crm.acquisition_usage) = 0, '…usage');
select pg_temp.check((select count(*) from crm.acquisition_decisions) = 0, '…decisions');
select pg_temp.check((select count(*) from crm.approval_bindings) = 0, '…approval bindings');
select pg_temp.check((select count(*) from crm.governed_executions) = 0, '…executions');
select pg_temp.check((select outcome from crm.set_integration_state((select v from fx where k = 'li'), 'DISABLED', 'cross tenant')) = 'not_found', 'org B''s owner cannot change org A''s integration (it does not exist for them)');
select pg_temp.check((select outcome from crm.store_connector_secret((select v from fx where k = 'li'), 'access_token', 'Y3Q=', 'aXYtdmFsdWU=', 'dGFnLXZhbHVl', null, null)) = 'not_found', 'org B''s owner cannot write a credential onto org A''s integration');
select pg_temp.check((select covered from crm.approval_check((select v from fx where k = 'req1'), 'social_content', (select v from fx where k = 'a1'), pg_temp.h('post v1'))) = false, 'org B cannot even see that an approval covers something in org A');
reset role;
select pg_temp.check(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'crm' and c.relname in ('acquisition_integrations', 'connector_credentials', 'acquisition_policies', 'acquisition_usage', 'acquisition_decisions', 'approval_bindings', 'governed_executions')
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert')
          or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete'))
), 'no new table is readable by anon or writable by authenticated');

select pg_temp.check((select count(*) from audit.audit_log where action = 'integration.registered') >= 4, 'registration is audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('integration.check_passed', 'integration.check_failed')) >= 6, 'every adapter check is audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('integration.disabled', 'integration.revoked')) = 2, 'disable and revoke are audited');
select pg_temp.check((select count(*) from audit.audit_log where action = 'acquisition.policy_changed') >= 5, 'a policy change is audited');
select pg_temp.check((select count(*) from audit.audit_log where action like 'governed.execution_%') >= 8, 'every execution step is audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('identity.key_sync_failed', 'identity.touch_failed')) = 0, 'no bookkeeping trigger failed silently');

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;
rollback;
