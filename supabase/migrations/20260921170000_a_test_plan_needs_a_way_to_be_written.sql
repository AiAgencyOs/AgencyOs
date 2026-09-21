-- ═══════════════════════════════════════════════════════════════════════════
-- A test plan needs a way to be written.
--
-- Same defect as 20260921160000, one layer up: `qa.test_plans` and
-- `.test_plan_items` (20260822180000) carry a SELECT policy each and nothing
-- else — the table's own design comment says a plan is meant to be drafted
-- by an agent (`drafted_by_agent`) or a person (`drafted_by`), and until the
-- QA agent exists, a person is the only possible author. With no INSERT
-- policy and no door, neither could ever write one. The Admin Panel
-- rebuild's Test Plans screen (SCR-045) is the first caller either table
-- has had.
--
-- `draft_test_plan` requires the scope version to be ACTIVE (frozen) —
-- Doc 14 §3's rule, "QA tests the approved baseline, not an agent's
-- interpretation", holds the same way `add_scope_item` holds §29: by what
-- the door refuses, not by convention. `add_test_plan_item` checks the
-- scope item it cites belongs to the SAME scope version as the plan — the
-- foreign key alone does not enforce that, since `scope_item_id` can point
-- at any scope item in the organization.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function qa.draft_test_plan(p_scope_version_id uuid)
returns table (
  -- 'drafted'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'not_active' | 'already_exists'
  outcome text,
  id      uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid;
  v_project uuid;
  v_status  text;
  v_new     uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;

  select sv.organization_id, sv.project_id, sv.status
    into v_org, v_project, v_status
    from projects.scope_versions sv
   where sv.id = p_scope_version_id
     and sv.organization_id = (select core.current_organization_id());

  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  if v_status <> 'active' then
    return query select 'not_active'::text, null::uuid; return;
  end if;

  if exists (select 1 from qa.test_plans tp where tp.scope_version_id = p_scope_version_id) then
    return query select 'already_exists'::text, null::uuid; return;
  end if;

  insert into qa.test_plans (organization_id, project_id, scope_version_id, drafted_by)
  values (v_org, v_project, p_scope_version_id, v_actor)
  returning qa.test_plans.id into v_new;

  return query select 'drafted'::text, v_new;
end;
$$;

comment on function qa.draft_test_plan(uuid) is
  'Opens a test plan against a FROZEN (active) scope version. can_manage_delivery() only. Refuses not_active — Doc 14 section 3: QA tests the approved baseline, never a draft still being assembled.';

revoke all on function qa.draft_test_plan(uuid) from public, anon;
grant execute on function qa.draft_test_plan(uuid) to authenticated;

create or replace function qa.add_test_plan_item(
  p_plan_id       uuid,
  p_scope_item_id uuid,
  p_category      text,
  p_reason        text,
  p_critical_path boolean default false
)
returns table (
  -- 'added'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'wrong_baseline' |
  --           'bad_category' | 'bad_reason' | 'already_planned'
  outcome text,
  id      uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor          uuid := (select auth.uid());
  v_org            uuid;
  v_scope_version  uuid;
  v_item_version   uuid;
  v_new            uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;

  if p_category not in (
    'functional', 'ui', 'api', 'database', 'integration', 'e2e',
    'regression', 'security', 'performance', 'compatibility', 'smoke'
  ) then
    return query select 'bad_category'::text, null::uuid; return;
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    return query select 'bad_reason'::text, null::uuid; return;
  end if;

  select tp.organization_id, tp.scope_version_id into v_org, v_scope_version
    from qa.test_plans tp
   where tp.id = p_plan_id
     and tp.organization_id = (select core.current_organization_id());

  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  select si.scope_version_id into v_item_version
    from projects.scope_items si
   where si.id = p_scope_item_id
     and si.organization_id = v_org;

  if v_item_version is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  -- The FK alone would accept any scope item in the organization; this is
  -- the check that keeps a plan naming only items from the baseline it was
  -- drafted against.
  if v_item_version <> v_scope_version then
    return query select 'wrong_baseline'::text, null::uuid; return;
  end if;

  insert into qa.test_plan_items (
    organization_id, plan_id, scope_item_id, category, reason, critical_path
  )
  values (v_org, p_plan_id, p_scope_item_id, p_category, trim(p_reason), p_critical_path)
  on conflict (plan_id, scope_item_id, category) do nothing
  returning qa.test_plan_items.id into v_new;

  if v_new is null then
    return query select 'already_planned'::text, null::uuid; return;
  end if;

  return query select 'added'::text, v_new;
end;
$$;

comment on function qa.add_test_plan_item(uuid, uuid, text, text, boolean) is
  'Adds one category of testing for one scope item to a test plan. can_manage_delivery() only. Refuses wrong_baseline when the scope item does not belong to the plan''s own scope version — the FK alone would accept any scope item in the organization, and this is the check that keeps a plan from naming work outside its own baseline.';

revoke all on function qa.add_test_plan_item(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function qa.add_test_plan_item(uuid, uuid, text, text, boolean) to authenticated;

create or replace function qa.remove_test_plan_item(p_item_id uuid)
returns table (
  -- 'removed'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_rows  int;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  delete from qa.test_plan_items
   where id = p_item_id
     and organization_id = (select core.current_organization_id());
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return query select 'not_found'::text; return;
  end if;

  return query select 'removed'::text;
end;
$$;

comment on function qa.remove_test_plan_item(uuid) is
  'Removes one item from a test plan — a correction, since Doc 14 defines no revision workflow for a plan the way scope versions have one. can_manage_delivery() only.';

revoke all on function qa.remove_test_plan_item(uuid) from public, anon;
grant execute on function qa.remove_test_plan_item(uuid) to authenticated;
