-- ═══════════════════════════════════════════════════════════════════════════
-- P604 Functional Test Agent: the parts of the contract that need NO model, built as records and derived reads.
--
--   §5  "For each requirement or feature, establish a direct test or record an explicit reason why a direct functional test is not applicable."
--       qa.functional_feature_exclusions (a person's recorded reason, append-only) + qa.functional_coverage (derived, per included requirement).
--   §6  the case record: requirement link (phase6_cases.scope_item_id), build (the plan's commit), environment, role/persona, preconditions, actual
--       result, NOT_APPLICABLE with its reason. qa.functional_case_profiles holds what phase6_cases does not. NOT_APPLICABLE is NOT a fifth case status
--       (the four-state check on phase6_cases is deliberate); it is an applicability recorded here with its reason, and it never turns a case green.
--   §7  the twelve scenario kinds. A case is profiled with ONE primary kind, so coverage can say which kinds each requirement has and which are missing.
--   §17 the failure class of a failed or blocked case (product code, environment, data, integration, permission, requirement ambiguity, test defect).
--   §18 qa.functional_handoff: the structured handoff to Master QA, derived from rows. It never declares production readiness (declares_production_ready is
--       false by construction); its recommendation is about FUNCTIONAL evidence only.
--   §20 qa.functional_definition_of_done: the eleven conditions, each read from rows, each with its detail. It is advice to the independent person who
--       decides; it gates nothing and records nothing.
--
-- NOT built, and not claimed: the model that executes the cases, the isolated QA tenant, the browser. Those need a funded model and an environment (P6-M002).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function qa.functional_scenario_kinds()
returns text[] language sql immutable set search_path = '' as $$
  select array['happy_path', 'invalid_input', 'boundary_value', 'duplicate_action', 'interrupted_flow', 'slow_dependency', 'dependency_unavailable',
               'stale_state', 'wrong_role', 'cross_context', 'retry_after_failure', 'fixed_defect_regression']
$$;
grant execute on function qa.functional_scenario_kinds() to authenticated, service_role;

create table if not exists qa.functional_case_profiles (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  plan_id               uuid not null references qa.master_test_plans(id) on delete cascade,
  case_id               uuid not null unique references qa.phase6_cases(id) on delete cascade,
  scenario_kind         text not null check (scenario_kind = any (qa.functional_scenario_kinds())),
  layer                 text not null check (layer in ('feature', 'business_rule', 'validation', 'state', 'role', 'workflow', 'integration', 'recovery')),
  role_persona          text check (role_persona is null or (length(btrim(role_persona)) > 0 and length(role_persona) <= 200)),
  environment           text check (environment is null or (length(btrim(environment)) > 0 and length(environment) <= 200)),
  preconditions         text check (preconditions is null or length(preconditions) <= 2000),
  actual_result         text check (actual_result is null or length(actual_result) <= 4000),
  failure_class         text check (failure_class in ('product_code', 'environment', 'data', 'integration', 'permission', 'requirement_ambiguity', 'test_defect')),
  not_applicable_reason text check (not_applicable_reason is null or (length(btrim(not_applicable_reason)) > 0 and length(not_applicable_reason) <= 2000)),
  recorded_by           uuid not null references core.users(id) on delete restrict,
  recorded_at           timestamptz not null default clock_timestamp(),
  updated_at            timestamptz not null default clock_timestamp()
);
create index if not exists functional_case_profiles_plan_idx on qa.functional_case_profiles (plan_id);

-- a person's recorded reason why a requirement has no direct functional test. History: never edited, never deleted.
create table if not exists qa.functional_feature_exclusions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references qa.master_test_plans(id) on delete cascade,
  scope_item_id    uuid not null references projects.scope_items(id) on delete restrict,
  reason           text not null check (length(btrim(reason)) > 0 and length(reason) <= 2000),
  recorded_by      uuid not null references core.users(id) on delete restrict,
  recorded_at      timestamptz not null default clock_timestamp(),
  unique (plan_id, scope_item_id)
);

do $$
declare r record;
begin
  for r in select * from (values
    ('functional_case_profiles', 'project_id', 'projects.projects'), ('functional_case_profiles', 'plan_id', 'qa.master_test_plans'), ('functional_case_profiles', 'case_id', 'qa.phase6_cases'),
    ('functional_feature_exclusions', 'plan_id', 'qa.master_test_plans'), ('functional_feature_exclusions', 'scope_item_id', 'projects.scope_items')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on qa.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on qa.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['functional_case_profiles', 'functional_feature_exclusions']) as tbl loop
    execute format('alter table qa.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on qa.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on qa.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('revoke all on qa.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on qa.%I from authenticated', r.tbl);
    execute format('grant select on qa.%I to authenticated', r.tbl);
    execute format('grant all on qa.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on qa.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on qa.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
  drop trigger if exists functional_feature_exclusions_append_only on qa.functional_feature_exclusions;
  create trigger functional_feature_exclusions_append_only before update or delete on qa.functional_feature_exclusions for each row execute function qa.release_history_append_only();
end $$;

-- a profile moves through its door only: a service-role write is held to the same rule, and a profile is never deleted
create or replace function qa.functional_case_profiles_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a functional case profile is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('qa.functional_sanctioned', true), '') <> 'on' then
    raise exception 'a functional case profile is recorded through its door, never by an edit' using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' and (new.case_id is distinct from old.case_id or new.plan_id is distinct from old.plan_id or new.project_id is distinct from old.project_id) then
    raise exception 'a functional case profile stays with its case' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists functional_case_profiles_guard on qa.functional_case_profiles;
create trigger functional_case_profiles_guard before insert or update or delete on qa.functional_case_profiles for each row execute function qa.functional_case_profiles_guard();

-- ── the doors ──────────────────────────────────────────────────────────────
create or replace function qa.record_functional_case_profile(
  p_case_id uuid, p_scenario_kind text, p_layer text, p_role text default null, p_environment text default null, p_preconditions text default null,
  p_actual_result text default null, p_failure_class text default null, p_not_applicable_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_case qa.phase6_cases; v_plan qa.master_test_plans; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_case from qa.phase6_cases c where c.id = p_case_id and c.organization_id = v_org for update;
  if v_case.id is null then return query select 'not_found'::text; return; end if;
  if v_case.category <> 'functional' then return query select 'not_a_functional_case'::text; return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = v_case.plan_id;
  if v_plan.status = 'superseded' then return query select 'plan_superseded'::text; return; end if;
  if p_scenario_kind is null or not (p_scenario_kind = any (qa.functional_scenario_kinds())) then return query select 'bad_scenario_kind'::text; return; end if;
  if p_layer is null or p_layer not in ('feature', 'business_rule', 'validation', 'state', 'role', 'workflow', 'integration', 'recovery') then return query select 'bad_layer'::text; return; end if;
  if p_failure_class is not null and p_failure_class not in ('product_code', 'environment', 'data', 'integration', 'permission', 'requirement_ambiguity', 'test_defect') then return query select 'bad_failure_class'::text; return; end if;
  -- a failure class describes a failure: it needs a failed or blocked case
  if p_failure_class is not null and v_case.status not in ('fail', 'blocked') then return query select 'failure_class_needs_a_failed_or_blocked_case'::text; return; end if;
  if p_not_applicable_reason is not null and length(btrim(p_not_applicable_reason)) = 0 then return query select 'not_applicable_needs_a_reason'::text; return; end if;
  -- NOT_APPLICABLE never rescues a result: a case that passed or failed was applicable
  if p_not_applicable_reason is not null and v_case.status in ('pass', 'fail') then return query select 'a_tested_case_is_applicable'::text; return; end if;
  if p_environment is not null and cardinality(v_plan.environments) > 0 and not (p_environment = any (v_plan.environments)) then return query select 'environment_not_in_plan'::text; return; end if;
  if projects.p8c_has_secret(coalesce(p_role, '') || ' ' || coalesce(p_preconditions, '') || ' ' || coalesce(p_actual_result, '') || ' ' || coalesce(p_not_applicable_reason, '')) then return query select 'secret_in_text'::text; return; end if;
  perform set_config('qa.functional_sanctioned', 'on', true);
  begin
    insert into qa.functional_case_profiles (organization_id, project_id, plan_id, case_id, scenario_kind, layer, role_persona, environment, preconditions, actual_result, failure_class, not_applicable_reason, recorded_by)
    values (v_org, v_case.project_id, v_case.plan_id, v_case.id, p_scenario_kind, p_layer, nullif(btrim(p_role), ''), nullif(btrim(p_environment), ''), nullif(btrim(p_preconditions), ''), nullif(btrim(p_actual_result), ''),
            p_failure_class, nullif(btrim(p_not_applicable_reason), ''), v_actor)
    on conflict (case_id) do update set scenario_kind = excluded.scenario_kind, layer = excluded.layer, role_persona = excluded.role_persona, environment = excluded.environment,
      preconditions = excluded.preconditions, actual_result = excluded.actual_result, failure_class = excluded.failure_class, not_applicable_reason = excluded.not_applicable_reason,
      recorded_by = excluded.recorded_by, updated_at = clock_timestamp()
    returning id into v_id;
  exception when check_violation then perform set_config('qa.functional_sanctioned', 'off', true); return query select 'invalid'::text; return; end;
  perform set_config('qa.functional_sanctioned', 'off', true);
  perform core.record_audit(v_org, 'qa.functional_case_profiled', 'phase6_case', v_case.id, null, jsonb_build_object('kind', p_scenario_kind, 'layer', p_layer, 'failureClass', p_failure_class, 'notApplicable', p_not_applicable_reason is not null));
  return query select 'recorded'::text;
end $$;
revoke all on function qa.record_functional_case_profile(uuid, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function qa.record_functional_case_profile(uuid, text, text, text, text, text, text, text, text) to authenticated;

create or replace function qa.record_functional_exclusion(p_plan_id uuid, p_scope_item_id uuid, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan qa.master_test_plans; v_base projects.development_baselines; v_si projects.scope_items;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = p_plan_id and p.organization_id = v_org;
  if v_plan.id is null then return query select 'not_found'::text; return; end if;
  if v_plan.status = 'superseded' then return query select 'plan_superseded'::text; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then return query select 'reason_required'::text; return; end if;
  if projects.p8c_has_secret(p_reason) then return query select 'secret_in_text'::text; return; end if;
  select * into v_base from projects.development_baselines b where b.project_id = v_plan.project_id;
  select * into v_si from projects.scope_items s where s.id = p_scope_item_id and s.organization_id = v_org;
  if v_si.id is null or v_si.scope_version_id is distinct from v_base.scope_version_id or v_si.inclusion <> 'included' then return query select 'not_an_included_requirement'::text; return; end if;
  -- a requirement that already has a direct functional case does not need an exclusion
  if exists (select 1 from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = 'functional' and c.scope_item_id = p_scope_item_id) then return query select 'has_a_direct_functional_case'::text; return; end if;
  if exists (select 1 from qa.functional_feature_exclusions e where e.plan_id = p_plan_id and e.scope_item_id = p_scope_item_id) then return query select 'already_recorded'::text; return; end if;
  insert into qa.functional_feature_exclusions (organization_id, plan_id, scope_item_id, reason, recorded_by) values (v_org, p_plan_id, p_scope_item_id, btrim(p_reason), v_actor);
  perform core.record_audit(v_org, 'qa.functional_exclusion_recorded', 'master_test_plan', p_plan_id, null, jsonb_build_object('scopeItemId', p_scope_item_id));
  return query select 'recorded'::text;
end $$;
revoke all on function qa.record_functional_exclusion(uuid, uuid, text) from public, anon;
grant execute on function qa.record_functional_exclusion(uuid, uuid, text) to authenticated;

-- ── derived reads ──────────────────────────────────────────────────────────
-- per included requirement: which scenario kinds its direct functional cases cover, which are missing, or why it has no direct test
create or replace function qa.functional_coverage(p_plan_id uuid)
returns table (scope_item_id uuid, title text, direct_cases int, kinds_covered text[], kinds_missing text[], excluded_reason text, coverage text)
language plpgsql stable security definer set search_path = '' as $$
declare v_plan qa.master_test_plans; v_base projects.development_baselines;
begin
  select * into v_plan from qa.master_test_plans p where p.id = p_plan_id;
  if v_plan.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and (v_plan.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;
  select * into v_base from projects.development_baselines b where b.project_id = v_plan.project_id;
  return query
    select si.id, si.title::text,
           coalesce(x.n, 0)::int,
           coalesce(x.kinds, '{}'::text[]),
           array(select k from unnest(qa.functional_scenario_kinds()) k where not (k = any (coalesce(x.kinds, '{}'::text[])))),
           e.reason,
           case when e.id is not null then 'excluded'
                when coalesce(x.n, 0) = 0 then 'uncovered'
                when 'happy_path' = any (coalesce(x.kinds, '{}'::text[]))
                     and coalesce(x.kinds, '{}'::text[]) && array['invalid_input', 'boundary_value', 'duplicate_action', 'dependency_unavailable', 'stale_state', 'wrong_role', 'retry_after_failure'] then 'minimum_met'
                else 'partial' end
      from projects.scope_items si
      left join lateral (
        select count(*)::int as n, array_agg(distinct p.scenario_kind) filter (where p.id is not null and p.not_applicable_reason is null) as kinds
          from qa.phase6_cases c left join qa.functional_case_profiles p on p.case_id = c.id
         where c.plan_id = p_plan_id and c.category = 'functional' and c.scope_item_id = si.id
      ) x on true
      left join qa.functional_feature_exclusions e on e.plan_id = p_plan_id and e.scope_item_id = si.id
     where si.scope_version_id = v_base.scope_version_id and si.inclusion = 'included'
     order by si.title, si.id;
end $$;
revoke all on function qa.functional_coverage(uuid) from public, anon;
grant execute on function qa.functional_coverage(uuid) to authenticated, service_role;

-- P604 section 20, read from rows. Advice for the independent person who decides; it records and gates nothing.
create or replace function qa.functional_definition_of_done(p_plan_id uuid)
returns table (item text, satisfied boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan qa.master_test_plans; v_n int; v_m int; v_hard boolean;
begin
  select * into v_plan from qa.master_test_plans p where p.id = p_plan_id;
  if v_plan.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and (v_plan.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;

  select count(*) into v_n from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = 'functional' and c.result_commit is not null and c.result_commit is distinct from v_plan.commit_ref;
  return query select 'exact_build'::text, v_plan.status = 'approved' and v_n = 0,
    case when v_plan.status <> 'approved' then 'the plan is ' || v_plan.status when v_n = 0 then 'every recorded result is for the plan''s exact commit' else v_n || ' result(s) are for another commit and are stale' end;

  select count(*) into v_n from qa.functional_coverage(p_plan_id) f where f.coverage = 'uncovered';
  return query select 'coverage'::text, v_n = 0, case when v_n = 0 then 'every included requirement has a direct functional case or a recorded reason' else v_n || ' included requirement(s) have neither a direct functional case nor a recorded reason' end;

  select count(*) into v_n from qa.functional_coverage(p_plan_id) f where f.coverage = 'partial';
  return query select 'scenario_minimum'::text, v_n = 0, case when v_n = 0 then 'every covered requirement has a happy path and at least one negative scenario' else v_n || ' covered requirement(s) lack a happy path or any negative scenario' end;

  select count(*) into v_n from qa.phase6_cases c left join qa.functional_case_profiles p on p.case_id = c.id
   where c.plan_id = p_plan_id and c.category = 'functional' and c.status in ('planned', 'ready', 'running') and p.not_applicable_reason is null;
  return query select 'all_executed'::text, v_n = 0, case when v_n = 0 then 'no applicable functional case is waiting to run' else v_n || ' applicable functional case(s) have no result' end;

  select count(*) into v_n from qa.phase6_cases c left join qa.functional_case_profiles p on p.case_id = c.id
   where c.plan_id = p_plan_id and c.category = 'functional' and c.priority = 'critical' and c.status not in ('pass', 'fail') and p.not_applicable_reason is null;
  return query select 'critical_journeys_executed'::text, v_n = 0, case when v_n = 0 then 'every critical functional case has a pass or a fail' else v_n || ' critical functional case(s) were not executed to a result' end;

  v_hard := exists (select 1 from qa.risk_items r where r.plan_id = p_plan_id and r.kind in ('authorization', 'authentication', 'tenant_data'));
  select count(*) into v_n from qa.phase6_cases c join qa.functional_case_profiles p on p.case_id = c.id
   where c.plan_id = p_plan_id and c.category = 'functional' and p.scenario_kind in ('wrong_role', 'cross_context') and c.status in ('pass', 'fail') and p.not_applicable_reason is null;
  return query select 'role_paths_checked'::text, (not v_hard) or v_n > 0,
    case when not v_hard then 'the risk matrix names no authorization, authentication or tenant risk' when v_n > 0 then v_n || ' wrong-role or cross-context case(s) have a result' else 'the risk matrix names an access risk and no wrong-role or cross-context case has a result' end;

  select count(*) into v_n from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = 'functional' and c.status = 'fail' and c.defect_id is null;
  return query select 'defects_recorded'::text, v_n = 0, case when v_n = 0 then 'every failed functional case has its defect' else v_n || ' failed case(s) have no defect' end;

  select count(*) into v_n from qa.phase6_cases c left join qa.functional_case_profiles p on p.case_id = c.id
   where c.plan_id = p_plan_id and c.category = 'functional' and c.status in ('fail', 'blocked') and p.failure_class is null;
  return query select 'failures_classified'::text, v_n = 0, case when v_n = 0 then 'every failed or blocked case states its failure class' else v_n || ' failed or blocked case(s) have no failure class' end;

  select count(*) into v_n from qa.phase6_cases c join qa.defects d on d.id = c.defect_id where c.plan_id = p_plan_id and c.category = 'functional' and d.status in ('open', 'fixed', 'needs_evidence');
  select count(*) into v_m from qa.phase6_cases c join qa.defects d on d.id = c.defect_id where c.plan_id = p_plan_id and c.category = 'functional' and d.status = 'fixed';
  return query select 'fixes_retested'::text, v_n = 0, case when v_n = 0 then 'every functional defect is verified or closed' else v_n || ' functional defect(s) are not yet verified (' || v_m || ' fixed, awaiting an independent retest)' end;

  select count(*) into v_n from qa.phase6_cases c join qa.defects d on d.id = c.defect_id
   where c.plan_id = p_plan_id and c.category = 'functional' and d.status = 'verified'
     and not exists (select 1 from qa.regression_links l where l.defect_id = d.id and l.state = 'verified');
  return query select 'targeted_regression'::text, v_n = 0, case when v_n = 0 then 'every verified functional defect has a verified regression test' else v_n || ' verified defect(s) have no verified regression test' end;

  select count(*) into v_n from qa.phase6_cases c join qa.defects d on d.id = c.defect_id
   where c.plan_id = p_plan_id and c.category = 'functional' and d.s_level <= 1 and d.status not in ('verified', 'wontfix', 'not_reproduced');
  return query select 'no_s0_s1_blocker'::text, v_n = 0, case when v_n = 0 then 'no unresolved S0/S1 functional defect' else v_n || ' unresolved S0/S1 functional defect(s)' end;

  select count(*) into v_n from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = 'functional' and c.status = 'blocked';
  select count(*) into v_m from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = 'functional' and c.status = 'skipped_with_reason';
  return query select 'skips_and_blocks_visible'::text, true, v_n || ' blocked and ' || v_m || ' skipped case(s), each with its stated reason (a skip is never a pass)';
end $$;
revoke all on function qa.functional_definition_of_done(uuid) from public, anon;
grant execute on function qa.functional_definition_of_done(uuid) to authenticated, service_role;

-- P604 section 18: the structured handoff to Master QA. Derived, stored nowhere, never a readiness declaration.
create or replace function qa.functional_handoff(p_plan_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_plan qa.master_test_plans; v_in projects.qa_intakes; v_res jsonb; v_dod jsonb; v_rec text;
  v_pass int; v_fail int; v_blocked int; v_na int; v_skipped int; v_notrun int; v_unresolved_fail int; v_s01 boolean; v_all boolean; v_exec boolean;
begin
  select * into v_plan from qa.master_test_plans p where p.id = p_plan_id;
  if v_plan.id is null then return null; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and (v_plan.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return null; end if;
  select * into v_in from projects.qa_intakes i where i.id = v_plan.intake_id;

  select coalesce(jsonb_agg(jsonb_build_object('item', d.item, 'satisfied', d.satisfied, 'detail', d.detail)), '[]'::jsonb) into v_dod from qa.functional_definition_of_done(p_plan_id) d;
  select count(*) filter (where c.status = 'pass' and p.not_applicable_reason is null),
         count(*) filter (where c.status = 'fail'),
         count(*) filter (where c.status = 'blocked' and p.not_applicable_reason is null),
         count(*) filter (where p.not_applicable_reason is not null),
         count(*) filter (where c.status = 'skipped_with_reason' and p.not_applicable_reason is null),
         count(*) filter (where c.status in ('planned', 'ready', 'running', 'invalidated') and p.not_applicable_reason is null)
    into v_pass, v_fail, v_blocked, v_na, v_skipped, v_notrun
    from qa.phase6_cases c left join qa.functional_case_profiles p on p.case_id = c.id where c.plan_id = p_plan_id and c.category = 'functional';
  select count(*) into v_unresolved_fail from qa.phase6_cases c join qa.defects d on d.id = c.defect_id
   where c.plan_id = p_plan_id and c.category = 'functional' and c.status = 'fail' and d.status not in ('verified', 'wontfix', 'not_reproduced');
  v_s01 := coalesce((select d.satisfied from qa.functional_definition_of_done(p_plan_id) d where d.item = 'no_s0_s1_blocker'), false);
  v_all := not exists (select 1 from qa.functional_definition_of_done(p_plan_id) d where not d.satisfied);
  v_exec := coalesce((select d.satisfied from qa.functional_definition_of_done(p_plan_id) d where d.item = 'all_executed'), false);

  -- the recommendation is about FUNCTIONAL evidence, in a fixed order of severity; only a full definition of done with nothing blocked recommends a pass
  v_rec := case when v_unresolved_fail > 0 or not v_s01 then 'not_recommended'
                when v_blocked > 0 or v_skipped > 0 then 'blocked'
                when not v_exec or v_notrun > 0 then 'incomplete'
                when v_all then 'functional_pass_recommended'
                else 'incomplete' end;

  v_res := jsonb_build_object(
    'planId', v_plan.id, 'projectId', v_plan.project_id, 'planVersion', v_plan.version, 'planStatus', v_plan.status,
    'build', jsonb_build_object('commit', v_plan.commit_ref, 'artifactSha256', v_in.artifact_sha256),
    'environments', to_jsonb(v_plan.environments),
    'requirements', (select jsonb_build_object('included', count(*), 'covered', count(*) filter (where f.coverage in ('minimum_met', 'partial')),
                                              'excluded', count(*) filter (where f.coverage = 'excluded'), 'uncovered', count(*) filter (where f.coverage = 'uncovered')) from qa.functional_coverage(p_plan_id) f),
    'totals', jsonb_build_object('pass', v_pass, 'fail', v_fail, 'blocked', v_blocked, 'not_applicable', v_na, 'skipped_with_reason', v_skipped, 'not_run', v_notrun),
    'criticalCases', (select jsonb_build_object('total', count(*), 'passed', count(*) filter (where c.status = 'pass'), 'failed', count(*) filter (where c.status = 'fail'),
                                                'notExecuted', count(*) filter (where c.status not in ('pass', 'fail'))) from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = 'functional' and c.priority = 'critical'),
    'defectsBySeverity', (select coalesce(jsonb_object_agg('S' || x.s_level, x.n), '{}'::jsonb) from (
        select d.s_level, count(*) as n from qa.phase6_cases c join qa.defects d on d.id = c.defect_id where c.plan_id = p_plan_id and c.category = 'functional' group by d.s_level) x),
    'retests', (select jsonb_build_object('awaitingRetest', count(*) filter (where d.status = 'fixed'), 'verified', count(*) filter (where d.status = 'verified'),
                                          'stillOpen', count(*) filter (where d.status in ('open', 'needs_evidence'))) from qa.phase6_cases c join qa.defects d on d.id = c.defect_id where c.plan_id = p_plan_id and c.category = 'functional'),
    'regression', (select jsonb_build_object('verifiedRegressionTests', count(*)) from qa.regression_links l join qa.defects d on d.id = l.defect_id join qa.phase6_cases c on c.defect_id = d.id
                    where c.plan_id = p_plan_id and c.category = 'functional' and l.state = 'verified'),
    'knownLimitations', coalesce(v_in.external_dependencies, '[]'::jsonb),
    'unresolvedBlockers', (select coalesce(jsonb_agg(jsonb_build_object('caseId', c.id, 'title', c.title, 'reason', c.reason, 'failureClass', p.failure_class)), '[]'::jsonb)
                             from qa.phase6_cases c left join qa.functional_case_profiles p on p.case_id = c.id where c.plan_id = p_plan_id and c.category = 'functional' and c.status = 'blocked'),
    'definitionOfDone', v_dod,
    'recommendation', v_rec,
    'declares_production_ready', false,
    'note', 'Functional evidence for Master QA only. Production readiness is decided from every category together, by an independent person.');
  return v_res;
end $$;
revoke all on function qa.functional_handoff(uuid) from public, anon;
grant execute on function qa.functional_handoff(uuid) to authenticated, service_role;
