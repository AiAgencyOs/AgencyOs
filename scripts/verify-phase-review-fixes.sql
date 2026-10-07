-- Independent review fixes (SQL): masking, NULL decisions, internal-only gate readers, org-checked helpers.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-review-fixes.sql   (rolls back)
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;

select pg_temp.check(projects.mask_secrets('MY_API_KEY=abcdef1234') = '[masked]', 'masks an underscore-prefixed key name');
select pg_temp.check(projects.mask_secrets('x_token: zzzzzz9') = '[masked]', 'masks a prefixed token name');
select pg_temp.check(projects.mask_secrets('{"api_key": "abcdef1234"}') not like '%abcdef1234%', 'masks a quoted JSON value');
select pg_temp.check(projects.mask_secrets('the token was refreshed') = 'the token was refreshed', 'leaves prose alone');

select pg_temp.check((select bool_and(position('is null or ' || v in pg_get_functiondef(f::regprocedure)) > 0) from (values
  ('projects.decide_maintenance_release(uuid,text,text)', 'p_decision'),
  ('projects.decide_maintenance_plan_cancellation(uuid,text)', 'p_decision'),
  ('projects.settle_portal_handover_request(uuid,text,text,text)', 'p_decision'),
  ('sales.qualify_phase_eight_opportunity(uuid,text,text)', 'p_decision'),
  ('projects.record_maintenance_plan_acceptance(uuid,text,uuid,text,text,text,text)', 'p_decision'),
  ('sales.record_phase_eight_opportunity(uuid,text,text,jsonb,text,text,text,text,text,uuid)', 'p_agent_key')) t(f, v)),
  'five doors and the agent-key door refuse a NULL decision');

select pg_temp.check((select bool_and(pg_get_functiondef(f::regprocedure) like '%or not coalesce(core.is_internal(), false)) then%') from (values
  ('projects.evaluate_maintenance_gates(uuid)'), ('projects.maintenance_priority(uuid)'),
  ('projects.maintenance_work_stall_reasons(uuid,timestamptz)'), ('finance.maintenance_financial_gate(uuid)')) t(f)),
  'gate readers require an internal caller');

select pg_temp.check((select bool_and(pg_get_functiondef(f::regprocedure) like '%core.current_organization_id()%') from (values
  ('projects.build_config_current_version(uuid)'), ('projects.build_run_config_stale(uuid)'), ('projects.p8_setting(uuid,text)')) t(f)),
  'build-config and settings helpers check the caller organisation');

rollback;
