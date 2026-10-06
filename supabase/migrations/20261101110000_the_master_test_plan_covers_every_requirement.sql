-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 Master Test Plan (P601 §11-§13, §25, P603): versioned, risk-based, requirement-covering, evidence bound to the EXACT commit.
--
--   qa.master_test_plans   one version per plan over ONE validated intake and ONE commit; frozen once approved; only an Admin approves
--   qa.risk_items          the risk matrix; payment / authentication / authorization / tenant data / destructive work CANNOT be recorded low or shallow
--   qa.phase6_cases        requirement -> acceptance criterion -> test case -> category -> result on a commit; states are P601 §25 verbatim
--   qa.phase6_result_history  every recorded result, append-only (an INVALIDATED result is history, never erased)
--   qa.plan_problems       the plan's gaps, named: requirement without a case, required category without a case, critical journey without an end-to-end case,
--                          no risk matrix, a plan for a commit that is no longer the intake's
-- Results: PASS needs evidence; a critical case is never silently SKIPPED; BLOCKED and SKIPPED_WITH_REASON need a reason; a FAIL raises a defect;
-- whoever PRODUCED the build cannot record its result; a result on any other commit is refused; changing the commit INVALIDATES old results.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function qa.phase6_categories()
returns text[] language sql immutable set search_path = '' as $$
  select array['functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression']
$$;
grant execute on function qa.phase6_categories() to authenticated, service_role;

create table if not exists qa.master_test_plans (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  intake_id            uuid not null references projects.qa_intakes(id) on delete restrict,
  version              int not null check (version > 0),
  status               text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  commit_ref           text not null check (length(btrim(commit_ref)) > 0),
  required_categories  text[] not null check (cardinality(required_categories) > 0 and required_categories <@ array['functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression']),
  critical_journeys    text[] not null default '{}',
  environments         text[] not null default '{}',
  test_data_strategy   text,
  performance_method   text,
  compatibility_matrix jsonb not null default '[]'::jsonb check (jsonb_typeof(compatibility_matrix) = 'array'),
  created_by           uuid references core.users(id) on delete set null,
  approved_by          uuid references core.users(id) on delete set null,
  approved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (project_id, version),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);
create unique index if not exists master_test_plans_one_approved on qa.master_test_plans (project_id) where status = 'approved';

create table if not exists qa.risk_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references qa.master_test_plans(id) on delete cascade,
  area             text not null check (length(btrim(area)) > 0),
  kind             text not null check (kind in ('payment', 'authentication', 'authorization', 'tenant_data', 'destructive', 'integration', 'late_change', 'escaped_defect', 'general')),
  level            text not null check (level in ('low', 'medium', 'high', 'critical')),
  depth            text not null check (depth in ('standard', 'deep')),
  reason           text not null check (length(btrim(reason)) > 0),
  created_at       timestamptz not null default now(),
  -- "Do not silently reduce depth on authentication, authorization, tenant isolation, payment, data destruction": a CHECK, not a convention
  check (kind not in ('payment', 'authentication', 'authorization', 'tenant_data', 'destructive') or (level in ('high', 'critical') and depth = 'deep')),
  -- anything recorded high/critical is tested deep
  check (level not in ('high', 'critical') or depth = 'deep')
);

create table if not exists qa.phase6_cases (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  plan_id              uuid not null references qa.master_test_plans(id) on delete cascade,
  scope_item_id        uuid references projects.scope_items(id) on delete restrict,
  title                text not null check (length(btrim(title)) > 0),
  acceptance_criterion text not null check (length(btrim(acceptance_criterion)) > 0),
  category             text not null check (category in ('functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression')),
  priority             text not null default 'medium' check (priority in ('critical', 'high', 'medium', 'low')),
  journey              text,
  steps                text,
  expected             text,
  status               text not null default 'planned' check (status in ('planned', 'ready', 'running', 'pass', 'fail', 'blocked', 'skipped_with_reason', 'invalidated')),
  result_commit        text,
  evidence_ref         text,
  reason               text,
  defect_id            uuid references qa.defects(id) on delete set null,
  executed_by          uuid references core.users(id) on delete set null,
  executed_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (status <> 'pass' or (evidence_ref is not null and length(btrim(evidence_ref)) > 0 and result_commit is not null and executed_at is not null)),
  check (status not in ('blocked', 'skipped_with_reason') or (reason is not null and length(btrim(reason)) > 0)),
  check (status <> 'fail' or (defect_id is not null and result_commit is not null)),
  -- a critical case is never silently skipped
  check (status <> 'skipped_with_reason' or priority <> 'critical')
);
create index if not exists phase6_cases_plan_idx on qa.phase6_cases (plan_id, category);

create table if not exists qa.phase6_result_history (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  case_id          uuid not null references qa.phase6_cases(id) on delete cascade,
  status           text not null,
  result_commit    text,
  evidence_ref     text,
  reason           text,
  recorded_by      uuid references core.users(id) on delete set null,
  recorded_at      timestamptz not null default now()
);

do $$
declare r record;
begin
  for r in select * from (values
    ('master_test_plans', 'project_id', 'projects.projects'), ('master_test_plans', 'intake_id', 'projects.qa_intakes'),
    ('risk_items', 'plan_id', 'qa.master_test_plans'),
    ('phase6_cases', 'project_id', 'projects.projects'), ('phase6_cases', 'plan_id', 'qa.master_test_plans'), ('phase6_cases', 'scope_item_id', 'projects.scope_items'), ('phase6_cases', 'defect_id', 'qa.defects'),
    ('phase6_result_history', 'case_id', 'qa.phase6_cases')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on qa.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on qa.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['master_test_plans', 'risk_items', 'phase6_cases', 'phase6_result_history']) as tbl loop
    execute format('alter table qa.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on qa.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on qa.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('grant select on qa.%I to authenticated', r.tbl);
    execute format('grant all on qa.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on qa.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on qa.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
  for r in select unnest(array['master_test_plans', 'phase6_cases']) as tbl loop
    execute format('drop trigger if exists %I on qa.%I', r.tbl || '_updated_at', r.tbl);
    execute format('create trigger %I before update on qa.%I for each row execute function core.set_updated_at()', r.tbl || '_updated_at', r.tbl);
  end loop;
end $$;

-- history and the risk matrix of an approved plan are facts
create or replace function qa.phase6_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a recorded Phase 6 result is history and is never edited or deleted' using errcode = 'restrict_violation'; end $$;
drop trigger if exists phase6_result_history_append_only on qa.phase6_result_history;
create trigger phase6_result_history_append_only before update or delete on qa.phase6_result_history for each row execute function qa.phase6_append_only();

create or replace function qa.master_test_plans_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a Master Test Plan is never deleted' using errcode = 'restrict_violation'; end if;
  if old.status in ('approved', 'superseded')
     and (new.required_categories is distinct from old.required_categories or new.critical_journeys is distinct from old.critical_journeys
          or new.commit_ref is distinct from old.commit_ref or new.intake_id is distinct from old.intake_id or new.version is distinct from old.version
          or new.environments is distinct from old.environments or new.compatibility_matrix is distinct from old.compatibility_matrix
          or (old.status = 'superseded' and new.status is distinct from old.status)
          or (old.status = 'approved' and new.status not in ('approved', 'superseded'))) then
    raise exception 'an approved Master Test Plan is never edited: a changed plan is a new version' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists master_test_plans_guard on qa.master_test_plans;
create trigger master_test_plans_guard before update or delete on qa.master_test_plans for each row execute function qa.master_test_plans_guard();

-- cases and risks join only a DRAFT plan; results are recorded through the door, never typed into the row
create or replace function qa.phase6_cases_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_status text;
begin
  if tg_op = 'DELETE' then raise exception 'a test case is never deleted: it is history' using errcode = 'restrict_violation'; end if;
  select p.status into v_status from qa.master_test_plans p where p.id = coalesce(new.plan_id, old.plan_id);
  if tg_op = 'INSERT' and v_status <> 'draft' then
    raise exception 'cases join a draft plan only: an approved plan is changed by a new version' using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' then
    if new.plan_id is distinct from old.plan_id or new.project_id is distinct from old.project_id or new.scope_item_id is distinct from old.scope_item_id
       or new.acceptance_criterion is distinct from old.acceptance_criterion or new.category is distinct from old.category or new.priority is distinct from old.priority
       or new.title is distinct from old.title then
      raise exception 'what a test case is about is never edited after the fact' using errcode = 'restrict_violation';
    end if;
    if (new.status is distinct from old.status or new.evidence_ref is distinct from old.evidence_ref or new.result_commit is distinct from old.result_commit)
       and coalesce(current_setting('qa.phase6_sanctioned', true), '') <> 'on' then
      raise exception 'a result is recorded through the result door, never typed into the row' using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists phase6_cases_guard on qa.phase6_cases;
create trigger phase6_cases_guard before insert or update or delete on qa.phase6_cases for each row execute function qa.phase6_cases_guard();

create or replace function qa.risk_items_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_status text;
begin
  select p.status into v_status from qa.master_test_plans p where p.id = coalesce(new.plan_id, old.plan_id);
  if v_status <> 'draft' then raise exception 'the risk matrix of an approved plan is a fact: a change is a new plan version' using errcode = 'restrict_violation'; end if;
  return coalesce(new, old);
end $$;
drop trigger if exists risk_items_guard on qa.risk_items;
create trigger risk_items_guard before insert or update or delete on qa.risk_items for each row execute function qa.risk_items_guard();

insert into core.event_types (type, description, canonical) values
  ('project.master_test_plan_approved',
   'An Admin approved a Master Test Plan: every requirement, required category and critical journey has a case, the risk matrix exists, and it is about the intake''s exact commit.',
   true)
on conflict (type) do nothing;

-- ── doors ──────────────────────────────────────────────────────────────────
create or replace function qa.create_master_test_plan(
  p_project_id uuid, p_required_categories text[], p_critical_journeys text[] default '{}', p_environments text[] default '{}',
  p_test_data_strategy text default null, p_performance_method text default null, p_compatibility_matrix jsonb default '[]'
)
returns table (outcome text, plan_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_in projects.qa_intakes; v_next int; v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_in from projects.qa_intakes i where i.project_id = p_project_id and i.organization_id = v_org;
  if v_in.id is null then return query select 'no_intake'::text, null::uuid; return; end if;
  -- a plan is written only over an intake that VALIDATED: never a guessed build
  if v_in.status <> 'valid' then return query select 'intake_not_valid'::text, null::uuid; return; end if;
  perform 1 from projects.projects p where p.id = p_project_id for update;
  select coalesce(max(version), 0) + 1 into v_next from qa.master_test_plans where project_id = p_project_id;
  begin
    insert into qa.master_test_plans (organization_id, project_id, intake_id, version, commit_ref, required_categories, critical_journeys, environments, test_data_strategy, performance_method, compatibility_matrix, created_by)
    values (v_org, p_project_id, v_in.id, v_next, v_in.commit_ref, p_required_categories, coalesce(p_critical_journeys, '{}'), coalesce(p_environments, '{}'), p_test_data_strategy, p_performance_method, coalesce(p_compatibility_matrix, '[]'), v_actor)
    returning id into v_new;
  exception when check_violation then return query select 'invalid'::text, null::uuid; return; end;
  return query select 'created'::text, v_new;
end $$;
revoke all on function qa.create_master_test_plan(uuid, text[], text[], text[], text, text, jsonb) from public, anon;
grant execute on function qa.create_master_test_plan(uuid, text[], text[], text[], text, text, jsonb) to authenticated;

create or replace function qa.add_risk_item(p_plan_id uuid, p_area text, p_kind text, p_level text, p_depth text, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if not exists (select 1 from qa.master_test_plans p where p.id = p_plan_id and p.organization_id = v_org) then return query select 'not_found'::text; return; end if;
  begin
    insert into qa.risk_items (organization_id, plan_id, area, kind, level, depth, reason) values (v_org, p_plan_id, p_area, p_kind, p_level, p_depth, p_reason);
  exception
    when check_violation then return query select 'depth_cannot_be_reduced'::text; return;
    when restrict_violation then return query select 'plan_not_draft'::text; return;
  end;
  return query select 'added'::text;
end $$;
revoke all on function qa.add_risk_item(uuid, text, text, text, text, text) from public, anon;
grant execute on function qa.add_risk_item(uuid, text, text, text, text, text) to authenticated;

create or replace function qa.add_phase6_case(p_plan_id uuid, p_title text, p_acceptance_criterion text, p_category text, p_priority text default 'medium',
                                             p_scope_item_id uuid default null, p_journey text default null, p_steps text default null, p_expected text default null)
returns table (outcome text, case_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_plan qa.master_test_plans; v_new uuid;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = p_plan_id and p.organization_id = v_org;
  if v_plan.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_plan.status <> 'draft' then return query select 'plan_not_draft'::text, null::uuid; return; end if;
  if not (p_category = any (v_plan.required_categories)) then return query select 'category_not_in_plan'::text, null::uuid; return; end if;
  begin
    insert into qa.phase6_cases (organization_id, project_id, plan_id, scope_item_id, title, acceptance_criterion, category, priority, journey, steps, expected)
    values (v_org, v_plan.project_id, v_plan.id, p_scope_item_id, p_title, p_acceptance_criterion, p_category, p_priority, p_journey, p_steps, p_expected) returning id into v_new;
  exception when check_violation then return query select 'invalid'::text, null::uuid; return; end;
  return query select 'added'::text, v_new;
end $$;
revoke all on function qa.add_phase6_case(uuid, text, text, text, text, uuid, text, text, text) from public, anon;
grant execute on function qa.add_phase6_case(uuid, text, text, text, text, uuid, text, text, text) to authenticated;

create or replace function qa.plan_problems(p_plan_id uuid)
returns table (problem text)
language plpgsql stable set search_path = '' as $$
declare v_plan qa.master_test_plans; v_in projects.qa_intakes; v_base projects.development_baselines;
begin
  select * into v_plan from qa.master_test_plans p where p.id = p_plan_id;
  if v_plan.id is null then return; end if;
  select * into v_in from projects.qa_intakes i where i.id = v_plan.intake_id;
  select * into v_base from projects.development_baselines b where b.project_id = v_plan.project_id;
  if v_in.status is distinct from 'valid' then return query select 'The QA intake is not valid.'::text; end if;
  if v_plan.commit_ref is distinct from v_in.commit_ref then return query select 'The plan is for a commit that is no longer the intake''s commit.'::text; end if;
  if not exists (select 1 from qa.risk_items r where r.plan_id = p_plan_id) then return query select 'No risk matrix: risk-based planning needs at least one recorded risk.'::text; end if;

  -- every included requirement (scope item of the baseline's scope version) has a case
  return query
    select format('Requirement not covered: "%s" has no test case.', si.title)
      from projects.scope_items si
     where si.scope_version_id = v_base.scope_version_id and si.inclusion = 'included'
       and not exists (select 1 from qa.phase6_cases c where c.plan_id = p_plan_id and c.scope_item_id = si.id);
  -- every required category has a case
  return query
    select format('Required category "%s" has no test case.', cat)
      from unnest(v_plan.required_categories) cat
     where not exists (select 1 from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = cat);
  -- every critical journey has an end-to-end case
  return query
    select format('Critical journey "%s" has no end-to-end case.', j)
      from unnest(v_plan.critical_journeys) j
     where not exists (select 1 from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = 'ui_e2e' and c.journey = j);
  -- a high/critical risk area needs a deep case in its category family
  return query
    select format('High-risk %s ("%s") has no critical or high priority case.', r.kind, r.area)
      from qa.risk_items r
     where r.plan_id = p_plan_id and r.level in ('high', 'critical')
       and not exists (select 1 from qa.phase6_cases c where c.plan_id = p_plan_id and c.priority in ('critical', 'high'));
end $$;
revoke all on function qa.plan_problems(uuid) from public, anon;
grant execute on function qa.plan_problems(uuid) to authenticated, service_role;

create or replace function qa.approve_master_test_plan(p_plan_id uuid)
returns table (outcome text, problems text[])
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan qa.master_test_plans; v_problems text[];
begin
  if v_actor is null then return query select 'no_actor'::text, '{}'::text[]; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, '{}'::text[]; return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = p_plan_id and p.organization_id = v_org for update;
  if v_plan.id is null then return query select 'not_found'::text, '{}'::text[]; return; end if;
  if v_plan.status = 'approved' then return query select 'already_approved'::text, '{}'::text[]; return; end if;
  if v_plan.status <> 'draft' then return query select 'not_draft'::text, '{}'::text[]; return; end if;
  select coalesce(array_agg(c.problem), '{}') into v_problems from qa.plan_problems(p_plan_id) c;
  if cardinality(v_problems) > 0 then return query select 'not_approvable'::text, v_problems; return; end if;
  update qa.master_test_plans set status = 'superseded' where project_id = v_plan.project_id and status = 'approved';
  update qa.master_test_plans set status = 'approved', approved_by = v_actor, approved_at = now() where id = v_plan.id;
  update projects.phase_six set state = 'plan_ready' where project_id = v_plan.project_id and state in ('intake_validating', 'blocked');
  perform core.record_audit(v_org, 'qa.master_test_plan_approved', 'master_test_plan', v_plan.id, null, jsonb_build_object('projectId', v_plan.project_id, 'version', v_plan.version, 'commit', v_plan.commit_ref));
  perform core.emit_event(v_org, 'project.master_test_plan_approved', 'master_test_plan', v_plan.id, jsonb_build_object('projectId', v_plan.project_id, 'version', v_plan.version));
  return query select 'approved'::text, '{}'::text[];
end $$;
revoke all on function qa.approve_master_test_plan(uuid) from public, anon;
grant execute on function qa.approve_master_test_plan(uuid) to authenticated;

-- the result door: an independent person records PASS / FAIL / BLOCKED / SKIPPED_WITH_REASON for the plan's exact commit
create or replace function qa.record_case_result(p_case_id uuid, p_status text, p_evidence_ref text default null, p_reason text default null)
returns table (outcome text, defect_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_case qa.phase6_cases; v_plan qa.master_test_plans; v_producer uuid; v_commit text; v_defect uuid; v_sev text; v_build uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_status not in ('pass', 'fail', 'blocked', 'skipped_with_reason', 'running') then return query select 'bad_status'::text, null::uuid; return; end if;
  select * into v_case from qa.phase6_cases c where c.id = p_case_id and c.organization_id = v_org for update;
  if v_case.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = v_case.plan_id;
  if v_plan.status <> 'approved' then return query select 'plan_not_approved'::text, null::uuid; return; end if;

  select i.build_deliverable_id into v_build from projects.qa_intakes i where i.id = v_plan.intake_id;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_build;
  -- evidence about any other commit is not evidence about this one
  if v_commit is distinct from v_plan.commit_ref then return query select 'stale_plan'::text, null::uuid; return; end if;
  -- creator != validator
  select d.created_by into v_producer from projects.deliverables d where d.id = v_build;
  if v_producer is not null and v_producer = v_actor then return query select 'self_review'::text, null::uuid; return; end if;

  if p_status = 'pass' and (p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0) then return query select 'evidence_required'::text, null::uuid; return; end if;
  if p_status in ('blocked', 'skipped_with_reason') and (p_reason is null or length(btrim(p_reason)) = 0) then return query select 'reason_required'::text, null::uuid; return; end if;
  if p_status = 'skipped_with_reason' and v_case.priority = 'critical' then return query select 'critical_cannot_be_skipped'::text, null::uuid; return; end if;

  perform set_config('qa.phase6_sanctioned', 'on', true);
  if p_status = 'fail' then
    v_sev := case v_case.priority when 'critical' then 'blocker' when 'high' then 'major' when 'medium' then 'minor' else 'trivial' end;
    insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, expected, actual, reported_by, build_id)
    values (v_case.organization_id, v_case.project_id, v_build, v_sev, left('Phase 6: ' || v_case.title, 200), coalesce(v_case.steps, v_case.title), v_case.expected, p_reason, v_actor, v_build)
    returning id into v_defect;
  end if;
  update qa.phase6_cases
     set status = p_status, result_commit = v_commit, evidence_ref = p_evidence_ref, reason = p_reason,
         defect_id = case when p_status = 'fail' then v_defect else qa.phase6_cases.defect_id end, executed_by = v_actor, executed_at = now()
   where id = v_case.id;
  insert into qa.phase6_result_history (organization_id, case_id, status, result_commit, evidence_ref, reason, recorded_by)
  values (v_case.organization_id, v_case.id, p_status, v_commit, p_evidence_ref, p_reason, v_actor);
  update projects.phase_six set state = 'testing' where project_id = v_case.project_id and state = 'plan_ready';
  return query select 'recorded'::text, v_defect;
end $$;
revoke all on function qa.record_case_result(uuid, text, text, text) from public, anon;
grant execute on function qa.record_case_result(uuid, text, text, text) to authenticated;

-- a changed commit makes every earlier result stale: it becomes INVALIDATED (and the old result stays in history)
create or replace function qa.invalidate_stale_results(p_project_id uuid)
returns table (outcome text, invalidated int)
language plpgsql security definer set search_path = '' as $$
declare v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_in projects.qa_intakes; v_commit text; v_n int;
begin
  if (select auth.uid()) is null and not v_service then return query select 'no_actor'::text, 0; return; end if;
  if (select auth.uid()) is not null and not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, 0; return; end if;
  select * into v_in from projects.qa_intakes i where i.project_id = p_project_id;
  if v_in.id is null then return query select 'no_intake'::text, 0; return; end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_in.build_deliverable_id;
  perform set_config('qa.phase6_sanctioned', 'on', true);
  with stale as (
    update qa.phase6_cases c set status = 'invalidated'
     where c.project_id = p_project_id and c.status in ('pass', 'fail', 'blocked', 'skipped_with_reason') and c.result_commit is distinct from v_commit
    returning c.id, c.organization_id, c.result_commit
  )
  insert into qa.phase6_result_history (organization_id, case_id, status, result_commit, reason)
  select organization_id, id, 'invalidated', result_commit, 'the build under test changed' from stale;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    update projects.qa_intakes set status = 'stale' where id = v_in.id and v_commit is distinct from v_in.commit_ref;
  end if;
  return query select 'invalidated'::text, v_n;
end $$;
revoke all on function qa.invalidate_stale_results(uuid) from public, anon;
grant execute on function qa.invalidate_stale_results(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
