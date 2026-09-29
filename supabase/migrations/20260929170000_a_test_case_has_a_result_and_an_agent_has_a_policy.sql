-- ═══════════════════════════════════════════════════════════════════════════
-- A test case has a result, and an agent has a policy.
--
-- Six element-level gaps from docs/AGENCYOS_ADMIN_REMAINING_GAPS.md, bucket B
-- (the data did not exist), all of one shape: a screen the Admin Panel PDF
-- draws that the schema could not honestly back.
--
--   SCR-045 Test plan & cases  — a plan has no status, so it cannot be
--                                approved; an item is a category and a reason,
--                                with nowhere for preconditions, steps or the
--                                expected result a tester actually follows.
--   SCR-046 Test runs          — a run is four counts. Which planned case
--                                passed and which failed is not recorded, so
--                                "retest history" per case cannot exist.
--   SCR-048 Compatibility/perf — a run does not say what device, browser or
--                                OS it ran on, so there is no matrix to draw,
--                                and a performance run has nowhere to say
--                                what it measured.
--   SCR-049 Release candidate  — `qa.release_gates` reports `rollback_plan`
--                                as undecided forever because nothing records
--                                one, and a smoke checklist has no row.
--   SCR-062/063 AI workforce   — `ai.agents` is the GLOBAL registry and is not
--                                tenant-writable (20260815380000). Which tools
--                                THIS tenant lets an agent use, and which
--                                projects it is assigned to, are tenant facts
--                                and had no table.
--
-- Rules held here rather than by convention:
--   · a plan is approved by owner or ops_admin — the same two roles ADM-19
--     gives production sign-off (`project.sign_off`) — and an approved plan
--     stops accepting or losing items: what was approved is what is tested.
--   · a per-case result belongs to ONE run and ONE plan item, both in the
--     same project; the run's own counts stay the source of total/passed/
--     failed — a result row is detail beneath a run, never a second total.
--   · the agent policy rows are a RECORD the orchestrator does not yet read.
--     Writing one changes nothing at runtime today; the page says so.
--   · every one of these is a governed write and lands in audit.audit_log
--     from inside the transaction, like every door before it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── SCR-045 · a plan can be approved, and a case says how to run it ───────

alter table qa.test_plans
  add column if not exists status      text not null default 'draft',
  add column if not exists approved_by uuid references core.users(id) on delete set null,
  add column if not exists approved_at timestamptz;

alter table qa.test_plans drop constraint if exists test_plans_status_check;
alter table qa.test_plans
  add constraint test_plans_status_check check (status in ('draft', 'approved'));

alter table qa.test_plans drop constraint if exists test_plans_approval_is_dated;
alter table qa.test_plans
  add constraint test_plans_approval_is_dated check (
    (status = 'draft' and approved_at is null and approved_by is null)
    or (status = 'approved' and approved_at is not null)
  );

comment on column qa.test_plans.status is
  'draft until owner or ops_admin approves it through qa.approve_test_plan. An approved plan accepts no new item and loses none: what was approved is what is tested.';

alter table qa.test_plan_items
  add column if not exists preconditions   text,
  add column if not exists steps           text,
  add column if not exists expected_result text;

comment on column qa.test_plan_items.steps is
  'How a tester runs this case, in their own words. Optional: an agent-drafted plan (Doc 14 section 5) names the category and the reason; a person fills the steps in.';

create or replace function qa.approve_test_plan(p_plan_id uuid)
returns table (
  -- 'approved'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'already_approved' | 'empty_plan'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_status text;
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  -- Owner or ops_admin — the roles holding project.sign_off (ADM-19). A
  -- delivery lead approving the plan for their own delivery is the review
  -- signing its own homework.
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select tp.organization_id, tp.status, to_jsonb(tp)
    into v_org, v_status, v_before
    from qa.test_plans tp
   where tp.id = p_plan_id
     and tp.organization_id = (select core.current_organization_id())
     for update;

  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  if v_status = 'approved' then
    return query select 'already_approved'::text; return;
  end if;

  if not exists (select 1 from qa.test_plan_items i where i.plan_id = p_plan_id) then
    return query select 'empty_plan'::text; return;
  end if;

  update qa.test_plans
     set status = 'approved', approved_by = v_actor, approved_at = now()
   where id = p_plan_id
  returning to_jsonb(qa.test_plans.*) into v_after;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (v_org, 'user', v_actor, 'test_plan.approved', 'test_plan', p_plan_id, v_before, v_after);

  return query select 'approved'::text;
end;
$$;

comment on function qa.approve_test_plan(uuid) is
  'Marks a test plan approved. is_admin() (owner, ops_admin) — the roles ADM-19 gives production sign-off. Refuses empty_plan: approving nothing is not a decision. Writes audit.audit_log in the same transaction.';

revoke all on function qa.approve_test_plan(uuid) from public, anon;
grant execute on function qa.approve_test_plan(uuid) to authenticated;

-- add_test_plan_item gains the three case fields and refuses an approved
-- plan. Dropped and recreated rather than overloaded: PostgREST resolves an
-- rpc by name and named arguments, and two candidates is an ambiguity error.
drop function if exists qa.add_test_plan_item(uuid, uuid, text, text, boolean);

create or replace function qa.add_test_plan_item(
  p_plan_id         uuid,
  p_scope_item_id   uuid,
  p_category        text,
  p_reason          text,
  p_critical_path   boolean default false,
  p_preconditions   text default null,
  p_steps           text default null,
  p_expected_result text default null
)
returns table (
  -- 'added'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'wrong_baseline' |
  --           'bad_category' | 'bad_reason' | 'already_planned' | 'plan_approved'
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
  v_plan_status    text;
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

  select tp.organization_id, tp.scope_version_id, tp.status
    into v_org, v_scope_version, v_plan_status
    from qa.test_plans tp
   where tp.id = p_plan_id
     and tp.organization_id = (select core.current_organization_id());

  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  -- New: an approved plan is what was approved.
  if v_plan_status = 'approved' then
    return query select 'plan_approved'::text, null::uuid; return;
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
    organization_id, plan_id, scope_item_id, category, reason, critical_path,
    preconditions, steps, expected_result
  )
  values (
    v_org, p_plan_id, p_scope_item_id, p_category, trim(p_reason), p_critical_path,
    nullif(trim(coalesce(p_preconditions, '')), ''),
    nullif(trim(coalesce(p_steps, '')), ''),
    nullif(trim(coalesce(p_expected_result, '')), '')
  )
  on conflict (plan_id, scope_item_id, category) do nothing
  returning qa.test_plan_items.id into v_new;

  if v_new is null then
    return query select 'already_planned'::text, null::uuid; return;
  end if;

  return query select 'added'::text, v_new;
end;
$$;

comment on function qa.add_test_plan_item(uuid, uuid, text, text, boolean, text, text, text) is
  'Adds one category of testing for one scope item to a test plan, with optional preconditions, steps and expected result. can_manage_delivery() only. Refuses wrong_baseline when the scope item is outside the plan''s own scope version, and plan_approved once qa.approve_test_plan has run.';

revoke all on function qa.add_test_plan_item(uuid, uuid, text, text, boolean, text, text, text) from public, anon;
grant execute on function qa.add_test_plan_item(uuid, uuid, text, text, boolean, text, text, text) to authenticated;

create or replace function qa.remove_test_plan_item(p_item_id uuid)
returns table (
  -- 'removed'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'plan_approved'
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

  -- New: an approved plan loses no item.
  if exists (
    select 1
      from qa.test_plan_items i
      join qa.test_plans tp on tp.id = i.plan_id
     where i.id = p_item_id
       and i.organization_id = (select core.current_organization_id())
       and tp.status = 'approved'
  ) then
    return query select 'plan_approved'::text; return;
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
  'Removes one item from a test plan — a correction, since Doc 14 defines no revision workflow for a plan. can_manage_delivery() only. Refuses plan_approved: what was approved is what is tested.';

-- ── SCR-046 · a run may carry a result per planned case ──────────────────

create table if not exists qa.test_case_results (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  test_run_id        uuid not null references qa.test_runs(id) on delete cascade,
  test_plan_item_id  uuid not null references qa.test_plan_items(id) on delete cascade,

  status             text not null check (status in ('passed', 'failed', 'skipped', 'blocked')),
  notes              text,
  evidence_url       text,

  executed_by        uuid references core.users(id) on delete set null,
  executed_at        timestamptz not null default now(),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint test_case_results_one_per_case_per_run unique (test_run_id, test_plan_item_id)
);

comment on table qa.test_case_results is
  'What one recorded run found for one planned case (SCR-046). Detail beneath qa.test_runs, never a second total: the run''s own passed/failed/skipped counts stay the source, and a case''s retest history is its rows across runs, newest last.';

create index if not exists test_case_results_run_idx
  on qa.test_case_results (organization_id, test_run_id);
create index if not exists test_case_results_item_idx
  on qa.test_case_results (organization_id, test_plan_item_id, executed_at desc);

drop trigger if exists set_updated_at on qa.test_case_results;
create trigger set_updated_at
  before update on qa.test_case_results
  for each row execute function core.set_updated_at();

alter table qa.test_case_results enable row level security;
alter table qa.test_case_results force row level security;

drop policy if exists test_case_results_select on qa.test_case_results;
create policy test_case_results_select on qa.test_case_results
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- No end-user write policy: qa.record_test_case_results below is the door,
-- the same posture as qa.test_runs and qa.record_test_run.
grant select on qa.test_case_results to authenticated;
grant select, insert, update on qa.test_case_results to service_role;

drop trigger if exists org_match_test_case_results_run on qa.test_case_results;
create trigger org_match_test_case_results_run
  before insert or update of test_run_id, organization_id on qa.test_case_results
  for each row execute function core.enforce_parent_org('test_run_id', 'qa.test_runs');

drop trigger if exists org_match_test_case_results_item on qa.test_case_results;
create trigger org_match_test_case_results_item
  before insert or update of test_plan_item_id, organization_id on qa.test_case_results
  for each row execute function core.enforce_parent_org('test_plan_item_id', 'qa.test_plan_items');

drop trigger if exists freeze_org_test_case_results on qa.test_case_results;
create trigger freeze_org_test_case_results
  before update of organization_id on qa.test_case_results
  for each row execute function core.freeze_organization_id();

drop trigger if exists test_case_results_reject_end_user_delete on qa.test_case_results;
create trigger test_case_results_reject_end_user_delete
  before delete on qa.test_case_results
  for each row execute function core.reject_end_user_delete();

create or replace function qa.record_test_case_results(
  p_test_run_id uuid,
  -- [{ "item_id": uuid, "status": text, "notes": text?, "evidence_url": text? }, ...]
  p_results     jsonb
)
returns table (
  -- 'recorded'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_results' | 'wrong_project'
  outcome  text,
  recorded int
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
  v_row     jsonb;
  v_item    uuid;
  v_status  text;
  v_count   int := 0;
begin
  if v_actor is null then
    return query select 'no_actor'::text, 0; return;
  end if;

  -- can_write(), matching record_test_run: Doc 14 §18 admits manual testing.
  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text, 0; return;
  end if;

  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    return query select 'bad_results'::text, 0; return;
  end if;

  select r.organization_id, r.project_id into v_org, v_project
    from qa.test_runs r
   where r.id = p_test_run_id
     and r.organization_id = (select core.current_organization_id());

  if v_org is null then
    return query select 'not_found'::text, 0; return;
  end if;

  for v_row in select * from jsonb_array_elements(p_results) loop
    v_item   := nullif(v_row->>'item_id', '')::uuid;
    v_status := v_row->>'status';

    if v_item is null or v_status not in ('passed', 'failed', 'skipped', 'blocked') then
      return query select 'bad_results'::text, 0; return;
    end if;

    -- The plan item must belong to a plan on the SAME project as the run:
    -- two foreign keys alone would let a result name a case from another
    -- project's plan.
    if not exists (
      select 1
        from qa.test_plan_items i
        join qa.test_plans tp on tp.id = i.plan_id
       where i.id = v_item
         and i.organization_id = v_org
         and tp.project_id = v_project
    ) then
      return query select 'wrong_project'::text, 0; return;
    end if;

    insert into qa.test_case_results (
      organization_id, test_run_id, test_plan_item_id, status, notes, evidence_url, executed_by
    )
    values (
      v_org, p_test_run_id, v_item, v_status,
      nullif(trim(coalesce(v_row->>'notes', '')), ''),
      nullif(trim(coalesce(v_row->>'evidence_url', '')), ''),
      v_actor
    )
    on conflict (test_run_id, test_plan_item_id) do update
      set status       = excluded.status,
          notes        = excluded.notes,
          evidence_url = excluded.evidence_url,
          executed_by  = excluded.executed_by,
          executed_at  = now();

    v_count := v_count + 1;
  end loop;

  return query select 'recorded'::text, v_count;
end;
$$;

comment on function qa.record_test_case_results(uuid, jsonb) is
  'Records per-case results beneath one test run. can_write() like record_test_run. Refuses wrong_project when a plan item belongs to another project''s plan, and bad_results on any malformed row — all or nothing. The run''s counts are untouched: a result row is detail, not a total.';

revoke all on function qa.record_test_case_results(uuid, jsonb) from public, anon;
grant execute on function qa.record_test_case_results(uuid, jsonb) to authenticated;

-- ── SCR-048 · a run says where it ran and what it measured ────────────────

alter table qa.test_runs
  add column if not exists device     text,
  add column if not exists browser    text,
  add column if not exists os         text,
  add column if not exists perf_notes text;

comment on column qa.test_runs.device is
  'Free text: the device class a compatibility run covered (iPhone 15, Pixel 8, desktop). With browser and os, the cells of SCR-048''s matrix. No thresholds live here — Doc 14 section 16.';

drop function if exists qa.record_test_run(uuid, text, int, int, int, int, text);

create or replace function qa.record_test_run(
  p_deliverable_id uuid,
  p_suite          text,
  p_total          int,
  p_passed         int,
  p_failed         int,
  p_skipped        int default 0,
  p_evidence_url   text default null,
  p_device         text default null,
  p_browser        text default null,
  p_os             text default null,
  p_perf_notes     text default null
)
returns table (
  -- 'recorded'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'not_a_build' | 'bad_suite' | 'bad_counts'
  outcome text,
  id      uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_project uuid;
  v_kind   text;
  v_new    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;

  if p_suite not in (
    'functional', 'ui', 'api', 'integration', 'e2e',
    'regression', 'smoke', 'security', 'performance', 'compatibility'
  ) then
    return query select 'bad_suite'::text, null::uuid; return;
  end if;

  select d.organization_id, d.project_id, d.kind
    into v_org, v_project, v_kind
    from projects.deliverables d
   where d.id = p_deliverable_id
     and d.organization_id = (select core.current_organization_id());

  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  -- The refuse_non_build_test_run trigger would also refuse this; checked
  -- first so the caller gets not_a_build rather than a raised exception.
  if v_kind <> 'build' then
    return query select 'not_a_build'::text, null::uuid; return;
  end if;

  begin
    insert into qa.test_runs (
      organization_id, project_id, deliverable_id, suite,
      total, passed, failed, skipped, evidence_url, executed_by,
      device, browser, os, perf_notes
    )
    values (
      v_org, v_project, p_deliverable_id, p_suite,
      p_total, p_passed, p_failed, coalesce(p_skipped, 0), p_evidence_url, v_actor,
      nullif(trim(coalesce(p_device, '')), ''),
      nullif(trim(coalesce(p_browser, '')), ''),
      nullif(trim(coalesce(p_os, '')), ''),
      nullif(trim(coalesce(p_perf_notes, '')), '')
    )
    returning qa.test_runs.id into v_new;
  exception
    when check_violation then
      return query select 'bad_counts'::text, null::uuid; return;
  end;

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function qa.record_test_run(uuid, text, int, int, int, int, text, text, text, text, text) is
  'Records one test run as evidence against a build deliverable, now with the device, browser and OS it ran on and free-text performance notes. can_write() (owner, ops_admin, delivery_lead, member) — Doc 14 section 18 admits manual testing. bad_counts covers test_runs_counts_add_up; not_a_build covers refuse_non_build_test_run.';

revoke all on function qa.record_test_run(uuid, text, int, int, int, int, text, text, text, text, text) from public, anon;
grant execute on function qa.record_test_run(uuid, text, int, int, int, int, text, text, text, text, text) to authenticated;

-- ── SCR-049 · the release candidate's rollback plan and smoke checklist ───

alter table projects.handovers
  add column if not exists rollback_plan   text,
  add column if not exists smoke_checklist jsonb not null default '[]'::jsonb;

alter table projects.handovers drop constraint if exists handovers_smoke_checklist_is_a_list;
alter table projects.handovers
  add constraint handovers_smoke_checklist_is_a_list check (jsonb_typeof(smoke_checklist) = 'array');

comment on column projects.handovers.smoke_checklist is
  'Array of {label, done_at}. A report for the release gate (SCR-049), not a gate: projects.mark_production_ready does not read it. done_at null means not yet done.';

create or replace function projects.set_handover_rollback_plan(
  p_handover_id   uuid,
  p_rollback_plan text
)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  -- The same roles handovers_write admits.
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select h.organization_id, to_jsonb(h) into v_org, v_before
    from projects.handovers h
   where h.id = p_handover_id
     and h.organization_id = (select core.current_organization_id())
     for update;

  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  update projects.handovers
     set rollback_plan = nullif(trim(coalesce(p_rollback_plan, '')), '')
   where id = p_handover_id
  returning to_jsonb(projects.handovers.*) into v_after;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (v_org, 'user', v_actor, 'handover.rollback_plan_set', 'handover', p_handover_id, v_before, v_after);

  return query select 'set'::text;
end;
$$;

comment on function projects.set_handover_rollback_plan(uuid, text) is
  'Records the rollback plan on a handover (SCR-049). can_manage_delivery(), the same roles handovers_write admits. Blank clears it. Audited.';

revoke all on function projects.set_handover_rollback_plan(uuid, text) from public, anon;
grant execute on function projects.set_handover_rollback_plan(uuid, text) to authenticated;

create or replace function projects.set_handover_smoke_item(
  p_handover_id uuid,
  p_label       text,
  p_done        boolean,
  p_remove      boolean default false
)
returns table (
  -- 'set' | 'removed'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_label'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_label  text := trim(coalesce(p_label, ''));
  v_list   jsonb;
  v_next   jsonb := '[]'::jsonb;
  v_item   jsonb;
  v_seen   boolean := false;
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if length(v_label) = 0 or length(v_label) > 200 then
    return query select 'bad_label'::text; return;
  end if;

  select h.organization_id, h.smoke_checklist, to_jsonb(h)
    into v_org, v_list, v_before
    from projects.handovers h
   where h.id = p_handover_id
     and h.organization_id = (select core.current_organization_id())
     for update;

  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(v_list, '[]'::jsonb)) loop
    if v_item->>'label' = v_label then
      v_seen := true;
      if p_remove then
        continue;
      end if;
      -- A tick already made keeps its moment; an untick clears it.
      v_next := v_next || jsonb_build_object(
        'label', v_label,
        'done_at', case
                     when not p_done then null
                     when v_item->>'done_at' is not null then v_item->'done_at'
                     else to_jsonb(now())
                   end
      );
    else
      v_next := v_next || v_item;
    end if;
  end loop;

  if not v_seen and not p_remove then
    v_next := v_next || jsonb_build_object(
      'label', v_label,
      'done_at', case when p_done then to_jsonb(now()) else null end
    );
  end if;

  update projects.handovers
     set smoke_checklist = v_next
   where id = p_handover_id
  returning to_jsonb(projects.handovers.*) into v_after;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org, 'user', v_actor,
    case when p_remove then 'handover.smoke_item_removed' else 'handover.smoke_item_set' end,
    'handover', p_handover_id, v_before, v_after
  );

  return query select (case when p_remove then 'removed' else 'set' end)::text;
end;
$$;

comment on function projects.set_handover_smoke_item(uuid, text, boolean, boolean) is
  'Adds, ticks, unticks or removes one smoke-checklist item on a handover (SCR-049). The label is the key; a tick already made keeps its done_at. can_manage_delivery(). Audited. A report, not a gate.';

revoke all on function projects.set_handover_smoke_item(uuid, text, boolean, boolean) from public, anon;
grant execute on function projects.set_handover_smoke_item(uuid, text, boolean, boolean) to authenticated;

-- ── SCR-062/063 · this tenant's policy for a global agent ─────────────────
--
-- ai.agents is global and not tenant-writable (20260815380000). What is
-- tenant-owned is the POLICY: which tools this organization lets an agent
-- use, and which projects it is assigned to. Both tables carry
-- organization_id and are written only by the owner — ADM-82 puts agent
-- activation with the owner, and a tool grant is the same kind of decision.
-- Neither is read by the orchestrator yet: resolveTool (src/modules/agents/
-- tools.ts) still decides from the agent definition alone.

create table if not exists ai.agent_tool_permissions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  agent_key        text not null references ai.agents(key) on delete cascade,
  tool_key         text not null check (tool_key ~ '^[a-z][a-zA-Z0-9_.]{1,80}$'),
  allowed          boolean not null default true,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint agent_tool_permissions_one_per_tool unique (organization_id, agent_key, tool_key)
);

comment on table ai.agent_tool_permissions is
  'This tenant''s record of which tools an agent may use (SCR-063). A policy record the orchestrator does not yet read: resolveTool still decides from the agent definition. ai.agents itself is global and not tenant-writable.';

create index if not exists agent_tool_permissions_agent_idx
  on ai.agent_tool_permissions (organization_id, agent_key);

create table if not exists ai.agent_project_assignments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  agent_key        text not null references ai.agents(key) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  assigned_by      uuid references core.users(id) on delete set null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint agent_project_assignments_one_per_project unique (organization_id, agent_key, project_id)
);

comment on table ai.agent_project_assignments is
  'Which projects an agent is assigned to in this tenant (SCR-063). Deactivated rather than deleted, so an assignment that was withdrawn is still visible as one. Not yet read by the runner.';

create index if not exists agent_project_assignments_agent_idx
  on ai.agent_project_assignments (organization_id, agent_key);
create index if not exists agent_project_assignments_project_idx
  on ai.agent_project_assignments (organization_id, project_id) where active;

do $$
declare t text;
begin
  foreach t in array array['agent_tool_permissions', 'agent_project_assignments']
  loop
    execute format('drop trigger if exists set_updated_at on ai.%I', t);
    execute format(
      'create trigger set_updated_at before update on ai.%I for each row execute function core.set_updated_at()', t);

    execute format('alter table ai.%I enable row level security', t);
    execute format('alter table ai.%I force row level security', t);

    execute format('drop policy if exists %I_select on ai.%I', t, t);
    execute format(
      'create policy %I_select on ai.%I for select to authenticated
         using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))', t, t);

    -- Owner only, and only this tenant's rows: is_owner() alone is the
    -- shape 20260815380000 closed, so the tenant predicate is not optional.
    execute format('drop policy if exists %I_write on ai.%I', t, t);
    execute format(
      'create policy %I_write on ai.%I for all to authenticated
         using (organization_id = (select core.current_organization_id()) and (select core.is_owner()))
         with check (organization_id = (select core.current_organization_id()) and (select core.is_owner()))', t, t);

    execute format('grant select, insert, update on ai.%I to authenticated, service_role', t);

    execute format('drop trigger if exists freeze_org_%s on ai.%I', t, t);
    execute format(
      'create trigger freeze_org_%s before update of organization_id on ai.%I
         for each row execute function core.freeze_organization_id()', t, t);
  end loop;
end
$$;

drop trigger if exists org_match_agent_project_assignments_project on ai.agent_project_assignments;
create trigger org_match_agent_project_assignments_project
  before insert or update of project_id, organization_id on ai.agent_project_assignments
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

-- The doors: security INVOKER, so the owner-only policies above decide
-- again, and the audit row is written under the caller's own identity.

create or replace function ai.set_agent_tool_permission(
  p_agent_key text,
  p_tool_key  text,
  p_allowed   boolean,
  p_note      text default null
)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_tool'
  outcome text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after  jsonb;
  v_id     uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if p_tool_key is null or p_tool_key !~ '^[a-z][a-zA-Z0-9_.]{1,80}$' then
    return query select 'bad_tool'::text; return;
  end if;

  if not exists (select 1 from ai.agents a where a.key = p_agent_key) then
    return query select 'not_found'::text; return;
  end if;

  select to_jsonb(p) into v_before
    from ai.agent_tool_permissions p
   where p.organization_id = v_org and p.agent_key = p_agent_key and p.tool_key = p_tool_key;

  insert into ai.agent_tool_permissions (organization_id, agent_key, tool_key, allowed, note)
  values (v_org, p_agent_key, p_tool_key, p_allowed, nullif(trim(coalesce(p_note, '')), ''))
  on conflict (organization_id, agent_key, tool_key) do update
    set allowed = excluded.allowed,
        note    = excluded.note
  returning id, to_jsonb(ai.agent_tool_permissions.*) into v_id, v_after;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org, 'user', v_actor,
    case when p_allowed then 'agent.tool_allowed' else 'agent.tool_denied' end,
    'agent_tool_permission', v_id, v_before, v_after
  );

  return query select 'set'::text;
end;
$$;

comment on function ai.set_agent_tool_permission(text, text, boolean, text) is
  'Records whether THIS tenant lets an agent use a tool (SCR-063). Owner only, and RLS on ai.agent_tool_permissions says so again (security invoker). A policy record: the orchestrator does not read it yet. Audited.';

revoke all on function ai.set_agent_tool_permission(text, text, boolean, text) from public, anon;
grant execute on function ai.set_agent_tool_permission(text, text, boolean, text) to authenticated;

create or replace function ai.set_agent_project_assignment(
  p_agent_key  text,
  p_project_id uuid,
  p_active     boolean
)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found'
  outcome text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after  jsonb;
  v_id     uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if not exists (select 1 from ai.agents a where a.key = p_agent_key) then
    return query select 'not_found'::text; return;
  end if;

  if not exists (
    select 1 from projects.projects p
     where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null
  ) then
    return query select 'not_found'::text; return;
  end if;

  select to_jsonb(a) into v_before
    from ai.agent_project_assignments a
   where a.organization_id = v_org and a.agent_key = p_agent_key and a.project_id = p_project_id;

  insert into ai.agent_project_assignments (organization_id, agent_key, project_id, assigned_by, active)
  values (v_org, p_agent_key, p_project_id, v_actor, p_active)
  on conflict (organization_id, agent_key, project_id) do update
    set active      = excluded.active,
        assigned_by = excluded.assigned_by
  returning id, to_jsonb(ai.agent_project_assignments.*) into v_id, v_after;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org, 'user', v_actor,
    case when p_active then 'agent.project_assigned' else 'agent.project_unassigned' end,
    'agent_project_assignment', v_id, v_before, v_after
  );

  return query select 'set'::text;
end;
$$;

comment on function ai.set_agent_project_assignment(text, uuid, boolean) is
  'Assigns an agent to a project in THIS tenant, or withdraws it (active=false; never deleted). Owner only, and RLS says so again (security invoker). Not yet read by the runner. Audited.';

revoke all on function ai.set_agent_project_assignment(text, uuid, boolean) from public, anon;
grant execute on function ai.set_agent_project_assignment(text, uuid, boolean) to authenticated;
