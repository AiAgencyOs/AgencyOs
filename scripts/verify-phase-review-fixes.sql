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


select pg_temp.check(not has_table_privilege('authenticated', 'projects.maintenance_plans', 'insert')
  and not has_table_privilege('authenticated', 'projects.maintenance_plans', 'update')
  and not has_table_privilege('authenticated', 'projects.maintenance_plans', 'delete'), 'a signed-in session has no raw write on a maintenance plan');
select pg_temp.check((select count(*) = 5 and bool_and(pg_get_expr(polqual, polrelid) like '%is_finance%') from pg_policy
  where polrelid in ('finance.maintenance_billing_requests'::regclass, 'finance.maintenance_billing_proposals'::regclass, 'finance.maintenance_billing_decisions'::regclass,
                     'finance.maintenance_billing_links'::regclass, 'finance.maintenance_gate_exceptions'::regclass) and polcmd = 'r'),
  'maintenance billing records are readable by owner, ops_admin and finance only');

select pg_temp.check(projects.proposal_forbidden_path(' .env', 'x') = 'secrets', 'a leading space does not hide .env');
select pg_temp.check(projects.proposal_forbidden_path('app/ .env.local', 'x') = 'secrets', 'a space after a separator does not hide .env');
select pg_temp.check(projects.proposal_forbidden_path('supabase' || chr(92) || 'migrations' || chr(92) || '1.sql', 'x') = 'migrations' and projects.proposal_forbidden_path('src/app.ts', 'x') is null, 'migrations stay agent-gated and ordinary files pass');
rollback;
