-- A run names its tester and environment and keeps its evidence; a case can be
-- edited; a requirement without a case says why; a device can be unsupported —
-- theme W5 (QA, release, communication): SCR-044, SCR-045, SCR-046, SCR-048.
--
-- What the rendered audit (docs/pdf-gap/C.md) found PARTIAL or MISSING, and
-- what this migration gives each:
--
--   1. SCR-046 "Tester" and "Build/environment": qa.test_runs gains
--      `tester_id` (who actually ran the suite, which may not be the person who
--      keyed the result in) and `environment` (development | staging |
--      production | other, the vocabulary projects.environments already uses).
--      Both are set when the run is opened or recorded; a closed run is
--      evidence and is still never edited.
--   2. SCR-046 "Screenshots/logs": qa.test_run_evidence, a list appended and
--      never edited, written through qa.add_run_evidence. It is allowed on a
--      closed run — the evidence of a run arrives after it, and adding a
--      screenshot does not rewrite the run.
--   3. SCR-045 "create/update/delete": qa.update_test_plan_item edits a case
--      (reason, critical path, preconditions, steps, expected result). Refused
--      on an approved plan, as remove is.
--   4. SCR-045 "Every accepted requirement should have coverage or explicit
--      rationale": qa.test_coverage_waivers and qa.waive_test_coverage /
--      qa.restore_test_coverage — a scope item of the plan's own baseline with
--      no case may carry a written reason instead.
--   5. SCR-048 "Unsupported devices/configurations must be explicitly
--      recorded": qa.device_configurations, and qa.add_device_configuration /
--      qa.set_device_support — a device (with an optional browser) registered
--      as supported or as unsupported WITH a reason. The same door is the real
--      "Add Device".
--
-- Every table: organization_id, RLS enabled and forced, internal select, NO
-- direct write grant to authenticated (writes are the security-definer doors
-- below, which re-check the role and audit through core.record_audit), tenancy
-- triggers on every org-scoped FK, freeze trigger.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. a run names its tester and its environment
-- ═══════════════════════════════════════════════════════════════════════════

alter table qa.test_runs
  add column if not exists tester_id   uuid references core.users(id) on delete set null,
  add column if not exists environment text;

alter table qa.test_runs drop constraint if exists test_runs_environment_named;
alter table qa.test_runs
  add constraint test_runs_environment_named
  check (environment is null or environment in ('development', 'staging', 'production', 'other'));

comment on column qa.test_runs.tester_id is
  'SCR-046: who ran the suite. Defaults to whoever recorded it (executed_by); a run keyed in for somebody else names them here. Set when the run is opened or recorded, never edited afterwards.';
comment on column qa.test_runs.environment is
  'SCR-046: where the build ran when it was tested — development, staging, production or other (the vocabulary of projects.environments). Doc 14 §31: evidence must identify the build AND the environment.';

-- ── open, now with a tester and an environment ─────────────────────────────

drop function if exists qa.open_test_run(uuid, text, uuid, text, text, text);

create or replace function qa.open_test_run(
  p_deliverable_id uuid,
  p_suite          text,
  p_rerun_of       uuid default null,
  p_device         text default null,
  p_browser        text default null,
  p_os             text default null,
  p_environment    text default null,
  p_tester_id      uuid default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid;
  v_project uuid;
  v_kind    text;
  v_new     uuid;
  v_env     text := nullif(trim(coalesce(p_environment, '')), '');
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
  if v_env is not null and v_env not in ('development', 'staging', 'production', 'other') then
    return query select 'bad_environment'::text, null::uuid; return;
  end if;

  select d.organization_id, d.project_id, d.kind
    into v_org, v_project, v_kind
    from projects.deliverables d
   where d.id = p_deliverable_id
     and d.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_kind <> 'build' then
    return query select 'not_a_build'::text, null::uuid; return;
  end if;

  if p_tester_id is not null and not exists (
    select 1 from core.memberships m
     where m.user_id = p_tester_id and m.organization_id = v_org and m.status = 'active'
  ) then
    return query select 'tester_not_found'::text, null::uuid; return;
  end if;

  if p_rerun_of is not null and not exists (
    select 1 from qa.test_runs r where r.id = p_rerun_of and r.organization_id = v_org and r.project_id = v_project
  ) then
    return query select 'rerun_not_found'::text, null::uuid; return;
  end if;

  insert into qa.test_runs (
    organization_id, project_id, deliverable_id, suite,
    total, passed, failed, skipped, blocked, executed_by,
    status, started_at, rerun_of, device, browser, os, environment, tester_id
  )
  values (
    v_org, v_project, p_deliverable_id, p_suite,
    0, 0, 0, 0, 0, v_actor,
    'open', now(), p_rerun_of,
    nullif(trim(coalesce(p_device, '')), ''),
    nullif(trim(coalesce(p_browser, '')), ''),
    nullif(trim(coalesce(p_os, '')), ''),
    v_env,
    coalesce(p_tester_id, v_actor)
  )
  returning qa.test_runs.id into v_new;

  perform core.record_audit(
    v_org, 'test_run.opened', 'test_run', v_new, null,
    jsonb_build_object('suite', p_suite, 'deliverable_id', p_deliverable_id, 'rerun_of', p_rerun_of,
                       'environment', v_env, 'tester_id', coalesce(p_tester_id, v_actor))
  );

  return query select 'opened'::text, v_new;
end;
$$;

comment on function qa.open_test_run(uuid, text, uuid, text, text, text, text, uuid) is
  'SCR-046: opens a test run (status open, started_at now, counts 0) against a build, now naming the environment it runs in and the tester (default: the caller). can_write(). rerun_of names the run whose failures this one re-executes. Audits test_run.opened.';

revoke all on function qa.open_test_run(uuid, text, uuid, text, text, text, text, uuid) from public, anon;
grant execute on function qa.open_test_run(uuid, text, uuid, text, text, text, text, uuid) to authenticated, service_role;

-- ── a rerun carries the environment and the tester of the run it repeats ───

create or replace function qa.rerun_test_run(p_run_id uuid)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run qa.test_runs;
  v_out record;
begin
  select * into v_run from qa.test_runs r
   where r.id = p_run_id and r.organization_id = (select core.current_organization_id());
  if v_run.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_run.status <> 'closed' then
    return query select 'not_closed'::text, null::uuid; return;
  end if;
  if v_run.failed = 0 and v_run.blocked = 0 then
    return query select 'nothing_failed'::text, null::uuid; return;
  end if;

  select * into v_out from qa.open_test_run(
    v_run.deliverable_id, v_run.suite, v_run.id, v_run.device, v_run.browser, v_run.os, v_run.environment, null
  );
  return query select v_out.outcome, v_out.id;
end;
$$;

comment on function qa.rerun_test_run(uuid) is
  'SCR-046: opens a new run of the same suite against the same build and environment with rerun_of set, for a closed run that had failed or blocked cases. The caller is the new run''s tester. Refuses not_closed and nothing_failed.';

revoke all on function qa.rerun_test_run(uuid) from public, anon;
grant execute on function qa.rerun_test_run(uuid) to authenticated, service_role;

-- ── record a whole run, now with environment and tester ────────────────────

drop function if exists qa.record_test_run(uuid, text, int, int, int, int, text, text, text, text, text);

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
  p_perf_notes     text default null,
  p_environment    text default null,
  p_tester_id      uuid default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid;
  v_project uuid;
  v_kind    text;
  v_new     uuid;
  v_env     text := nullif(trim(coalesce(p_environment, '')), '');
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
  if v_env is not null and v_env not in ('development', 'staging', 'production', 'other') then
    return query select 'bad_environment'::text, null::uuid; return;
  end if;

  select d.organization_id, d.project_id, d.kind
    into v_org, v_project, v_kind
    from projects.deliverables d
   where d.id = p_deliverable_id
     and d.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_kind <> 'build' then
    return query select 'not_a_build'::text, null::uuid; return;
  end if;

  if p_tester_id is not null and not exists (
    select 1 from core.memberships m
     where m.user_id = p_tester_id and m.organization_id = v_org and m.status = 'active'
  ) then
    return query select 'tester_not_found'::text, null::uuid; return;
  end if;

  begin
    insert into qa.test_runs (
      organization_id, project_id, deliverable_id, suite,
      total, passed, failed, skipped, evidence_url, executed_by,
      device, browser, os, perf_notes, environment, tester_id
    )
    values (
      v_org, v_project, p_deliverable_id, p_suite,
      p_total, p_passed, p_failed, coalesce(p_skipped, 0), p_evidence_url, v_actor,
      nullif(trim(coalesce(p_device, '')), ''),
      nullif(trim(coalesce(p_browser, '')), ''),
      nullif(trim(coalesce(p_os, '')), ''),
      nullif(trim(coalesce(p_perf_notes, '')), ''),
      v_env,
      coalesce(p_tester_id, v_actor)
    )
    returning qa.test_runs.id into v_new;
  exception
    when check_violation then
      return query select 'bad_counts'::text, null::uuid; return;
  end;

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function qa.record_test_run(uuid, text, int, int, int, int, text, text, text, text, text, text, uuid) is
  'Records one whole test run as evidence against a build deliverable, with its device, browser, OS, performance notes, the environment it ran in and its tester (default: the caller). can_write(). bad_counts covers test_runs_counts_add_up; not_a_build covers refuse_non_build_test_run; bad_environment and tester_not_found are the two new refusals.';

revoke all on function qa.record_test_run(uuid, text, int, int, int, int, text, text, text, text, text, text, uuid) from public, anon;
grant execute on function qa.record_test_run(uuid, text, int, int, int, int, text, text, text, text, text, text, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. a run keeps more than one piece of evidence
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.test_run_evidence (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  run_id          uuid not null references qa.test_runs(id) on delete cascade,
  kind            text not null check (kind in ('screenshot', 'log', 'report', 'recording', 'note')),
  label           text check (label is null or length(btrim(label)) between 1 and 160),
  -- A link for everything but a note; the words for a note.
  value           text not null check (length(btrim(value)) between 1 and 2000),
  added_by        uuid references core.users(id) on delete set null,
  added_at        timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table qa.test_run_evidence is
  'SCR-046: the screenshots, logs, reports and notes that show what a run found — appended by whoever has them, never edited or deleted. The run''s own evidence_url is the first of these and stays where it is. A file itself lives in storage; this row is its link.';

create index if not exists test_run_evidence_run_idx
  on qa.test_run_evidence (organization_id, run_id, added_at);

drop trigger if exists set_updated_at on qa.test_run_evidence;
create trigger set_updated_at before update on qa.test_run_evidence
  for each row execute function core.set_updated_at();

alter table qa.test_run_evidence enable row level security;
alter table qa.test_run_evidence force row level security;

drop policy if exists test_run_evidence_select on qa.test_run_evidence;
create policy test_run_evidence_select on qa.test_run_evidence
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists org_match_test_run_evidence_run on qa.test_run_evidence;
create trigger org_match_test_run_evidence_run
  before insert or update of run_id, organization_id on qa.test_run_evidence
  for each row execute function core.enforce_parent_org('run_id', 'qa.test_runs');

drop trigger if exists freeze_org_test_run_evidence on qa.test_run_evidence;
create trigger freeze_org_test_run_evidence
  before update of organization_id on qa.test_run_evidence
  for each row execute function core.freeze_organization_id();

grant select on qa.test_run_evidence to authenticated, service_role;

create or replace function qa.add_run_evidence(
  p_run_id uuid,
  p_kind   text,
  p_value  text,
  p_label  text default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_value text := btrim(coalesce(p_value, ''));
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
  v_new   uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if p_kind not in ('screenshot', 'log', 'report', 'recording', 'note') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if length(v_value) = 0 or length(v_value) > 2000
     or (p_kind <> 'note' and v_value !~* '^https?://[^[:space:]]+$') then
    return query select 'bad_value'::text, null::uuid; return;
  end if;
  if v_label is not null and length(v_label) > 160 then
    return query select 'bad_label'::text, null::uuid; return;
  end if;

  select r.organization_id into v_org
    from qa.test_runs r
   where r.id = p_run_id and r.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  insert into qa.test_run_evidence (organization_id, run_id, kind, label, value, added_by)
  values (v_org, p_run_id, p_kind, v_label, v_value, v_actor)
  returning qa.test_run_evidence.id into v_new;

  perform core.record_audit(
    v_org, 'test_run.evidence_added', 'test_run', p_run_id, null,
    jsonb_build_object('evidence_id', v_new, 'kind', p_kind)
  );

  return query select 'added'::text, v_new;
end;
$$;

comment on function qa.add_run_evidence(uuid, text, text, text) is
  'SCR-046: appends one piece of evidence to a run — a screenshot, log, report or recording link (http/https), or a note. Allowed on an open or a closed run: adding evidence does not rewrite the run. can_write(). Audits test_run.evidence_added.';

revoke all on function qa.add_run_evidence(uuid, text, text, text) from public, anon;
grant execute on function qa.add_run_evidence(uuid, text, text, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. a case can be edited
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function qa.update_test_plan_item(
  p_item_id        uuid,
  p_reason         text,
  p_critical_path  boolean,
  p_preconditions  text default null,
  p_steps          text default null,
  p_expected_result text default null
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_before jsonb;
  v_org    uuid;
  v_status text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if length(v_reason) = 0 or length(v_reason) > 600 then
    return query select 'bad_reason'::text; return;
  end if;

  select i.organization_id, tp.status,
         jsonb_build_object('reason', i.reason, 'critical_path', i.critical_path,
                            'preconditions', i.preconditions, 'steps', i.steps, 'expected_result', i.expected_result)
    into v_org, v_status, v_before
    from qa.test_plan_items i
    join qa.test_plans tp on tp.id = i.plan_id
   where i.id = p_item_id
     and i.organization_id = (select core.current_organization_id())
   for update of i;
  if v_org is null then
    return query select 'not_found'::text; return;
  end if;
  if v_status = 'approved' then
    return query select 'plan_approved'::text; return;
  end if;

  update qa.test_plan_items
     set reason          = v_reason,
         critical_path   = coalesce(p_critical_path, false),
         preconditions   = nullif(btrim(coalesce(p_preconditions, '')), ''),
         steps           = nullif(btrim(coalesce(p_steps, '')), ''),
         expected_result = nullif(btrim(coalesce(p_expected_result, '')), '')
   where id = p_item_id;

  perform core.record_audit(
    v_org, 'test_case.updated', 'test_case', p_item_id, v_before,
    jsonb_build_object('reason', v_reason, 'critical_path', coalesce(p_critical_path, false),
                       'preconditions', nullif(btrim(coalesce(p_preconditions, '')), ''),
                       'steps', nullif(btrim(coalesce(p_steps, '')), ''),
                       'expected_result', nullif(btrim(coalesce(p_expected_result, '')), ''))
  );

  return query select 'updated'::text;
end;
$$;

comment on function qa.update_test_plan_item(uuid, text, boolean, text, text, text) is
  'SCR-045: edits one case of a draft plan — why it applies, whether it is on the critical path, its preconditions, steps and expected result. The scope item and category are the case''s identity and do not change (remove and add instead). Refuses plan_approved. can_manage_delivery(). Audits test_case.updated with before and after.';

revoke all on function qa.update_test_plan_item(uuid, text, boolean, text, text, text) from public, anon;
grant execute on function qa.update_test_plan_item(uuid, text, boolean, text, text, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. a requirement without a case says why
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.test_coverage_waivers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  plan_id         uuid not null references qa.test_plans(id) on delete cascade,
  scope_item_id   uuid not null references projects.scope_items(id) on delete cascade,
  reason          text not null check (length(btrim(reason)) between 1 and 600),
  waived_by       uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (plan_id, scope_item_id)
);

comment on table qa.test_coverage_waivers is
  'SCR-045 guardrail: "every accepted requirement should have coverage or an explicit rationale". A scope item of the plan''s own baseline with no case may carry the reason it needs none. Removed (restored to uncovered) through qa.restore_test_coverage; both are audited.';

alter table qa.test_coverage_waivers enable row level security;
alter table qa.test_coverage_waivers force row level security;

drop policy if exists test_coverage_waivers_select on qa.test_coverage_waivers;
create policy test_coverage_waivers_select on qa.test_coverage_waivers
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists org_match_test_coverage_waivers_plan on qa.test_coverage_waivers;
create trigger org_match_test_coverage_waivers_plan
  before insert or update of plan_id, organization_id on qa.test_coverage_waivers
  for each row execute function core.enforce_parent_org('plan_id', 'qa.test_plans');

drop trigger if exists org_match_test_coverage_waivers_scope_item on qa.test_coverage_waivers;
create trigger org_match_test_coverage_waivers_scope_item
  before insert or update of scope_item_id, organization_id on qa.test_coverage_waivers
  for each row execute function core.enforce_parent_org('scope_item_id', 'projects.scope_items');

drop trigger if exists freeze_org_test_coverage_waivers on qa.test_coverage_waivers;
create trigger freeze_org_test_coverage_waivers
  before update of organization_id on qa.test_coverage_waivers
  for each row execute function core.freeze_organization_id();

grant select on qa.test_coverage_waivers to authenticated, service_role;

create or replace function qa.waive_test_coverage(
  p_plan_id       uuid,
  p_scope_item_id uuid,
  p_reason        text
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_scope  uuid;
  v_item   uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if length(v_reason) = 0 or length(v_reason) > 600 then
    return query select 'bad_reason'::text; return;
  end if;

  select tp.organization_id, tp.scope_version_id into v_org, v_scope
    from qa.test_plans tp
   where tp.id = p_plan_id and tp.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  select si.id into v_item
    from projects.scope_items si
   where si.id = p_scope_item_id and si.organization_id = v_org and si.scope_version_id = v_scope;
  if v_item is null then
    return query select 'wrong_baseline'::text; return;
  end if;

  if exists (select 1 from qa.test_plan_items i where i.plan_id = p_plan_id and i.scope_item_id = p_scope_item_id) then
    return query select 'already_covered'::text; return;
  end if;

  insert into qa.test_coverage_waivers (organization_id, plan_id, scope_item_id, reason, waived_by)
  values (v_org, p_plan_id, p_scope_item_id, v_reason, v_actor)
  on conflict (plan_id, scope_item_id) do update set reason = excluded.reason, waived_by = excluded.waived_by;

  perform core.record_audit(
    v_org, 'test_coverage.waived', 'test_plan', p_plan_id, null,
    jsonb_build_object('scope_item_id', p_scope_item_id, 'reason', v_reason)
  );

  return query select 'waived'::text;
end;
$$;

comment on function qa.waive_test_coverage(uuid, uuid, text) is
  'SCR-045: records why one scope item of the plan''s own baseline needs no test case. Refuses wrong_baseline and already_covered (a case exists). can_manage_delivery(). Audits test_coverage.waived.';

revoke all on function qa.waive_test_coverage(uuid, uuid, text) from public, anon;
grant execute on function qa.waive_test_coverage(uuid, uuid, text) to authenticated, service_role;

create or replace function qa.restore_test_coverage(p_plan_id uuid, p_scope_item_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_rows  int;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select tp.organization_id into v_org
    from qa.test_plans tp
   where tp.id = p_plan_id and tp.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  delete from qa.test_coverage_waivers w where w.plan_id = p_plan_id and w.scope_item_id = p_scope_item_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return query select 'not_found'::text; return;
  end if;

  perform core.record_audit(v_org, 'test_coverage.restored', 'test_plan', p_plan_id, null,
    jsonb_build_object('scope_item_id', p_scope_item_id));
  return query select 'restored'::text;
end;
$$;

comment on function qa.restore_test_coverage(uuid, uuid) is
  'SCR-045: withdraws a coverage waiver, so the scope item is uncovered again. can_manage_delivery(). Audits test_coverage.restored.';

revoke all on function qa.restore_test_coverage(uuid, uuid) from public, anon;
grant execute on function qa.restore_test_coverage(uuid, uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. a device, and a configuration that is explicitly unsupported
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.device_configurations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 120),
  platform        text not null check (platform in ('android', 'ios', 'web', 'tablet', 'tv', 'other')),
  os              text check (os is null or length(btrim(os)) between 1 and 120),
  -- A browser narrows the record to one cell of the device x browser matrix;
  -- null means the device as a whole.
  browser         text check (browser is null or length(btrim(browser)) between 1 and 120),
  status          text not null default 'supported' check (status in ('supported', 'unsupported')),
  reason          text check (reason is null or length(btrim(reason)) between 1 and 600),
  created_by      uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- SCR-048 guardrail: an unsupported configuration is never silent.
  constraint device_configurations_unsupported_says_why
    check (status <> 'unsupported' or reason is not null)
);

comment on table qa.device_configurations is
  'SCR-044/048: the devices the agency tests on, and the device/browser configurations it explicitly does NOT support (with the reason). The matrix and the device tiles read this beside what test runs recorded, so an untested cell is told apart from a refused one.';

create unique index if not exists device_configurations_identity_key
  on qa.device_configurations (organization_id, lower(name), lower(coalesce(os, '')), lower(coalesce(browser, '')));

drop trigger if exists set_updated_at on qa.device_configurations;
create trigger set_updated_at before update on qa.device_configurations
  for each row execute function core.set_updated_at();

alter table qa.device_configurations enable row level security;
alter table qa.device_configurations force row level security;

drop policy if exists device_configurations_select on qa.device_configurations;
create policy device_configurations_select on qa.device_configurations
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists freeze_org_device_configurations on qa.device_configurations;
create trigger freeze_org_device_configurations
  before update of organization_id on qa.device_configurations
  for each row execute function core.freeze_organization_id();

grant select on qa.device_configurations to authenticated, service_role;

create or replace function qa.add_device_configuration(
  p_name     text,
  p_platform text,
  p_os       text default null,
  p_browser  text default null,
  p_status   text default 'supported',
  p_reason   text default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_name   text := btrim(coalesce(p_name, ''));
  v_os     text := nullif(btrim(coalesce(p_os, '')), '');
  v_br     text := nullif(btrim(coalesce(p_browser, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_new    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if length(v_name) = 0 or length(v_name) > 120 then
    return query select 'bad_name'::text, null::uuid; return;
  end if;
  if p_platform not in ('android', 'ios', 'web', 'tablet', 'tv', 'other') then
    return query select 'bad_platform'::text, null::uuid; return;
  end if;
  if p_status not in ('supported', 'unsupported') then
    return query select 'bad_status'::text, null::uuid; return;
  end if;
  if p_status = 'unsupported' and v_reason is null then
    return query select 'reason_required'::text, null::uuid; return;
  end if;

  begin
    insert into qa.device_configurations (organization_id, name, platform, os, browser, status, reason, created_by)
    values (v_org, v_name, p_platform, v_os, v_br, p_status, case when p_status = 'unsupported' then v_reason else null end, v_actor)
    returning qa.device_configurations.id into v_new;
  exception
    when unique_violation then
      return query select 'already_recorded'::text, null::uuid; return;
  end;

  perform core.record_audit(
    v_org, 'device.recorded', 'device_configuration', v_new, null,
    jsonb_build_object('name', v_name, 'platform', p_platform, 'os', v_os, 'browser', v_br, 'status', p_status, 'reason', v_reason)
  );

  return query select 'added'::text, v_new;
end;
$$;

comment on function qa.add_device_configuration(text, text, text, text, text, text) is
  'SCR-044/048: registers a device (optionally narrowed to one browser) as supported, or as explicitly unsupported with a reason. Refuses reason_required, already_recorded. can_manage_delivery(). Audits device.recorded.';

revoke all on function qa.add_device_configuration(text, text, text, text, text, text) from public, anon;
grant execute on function qa.add_device_configuration(text, text, text, text, text, text) to authenticated, service_role;

create or replace function qa.set_device_support(
  p_device_id uuid,
  p_status    text,
  p_reason    text default null
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_row    qa.device_configurations;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if p_status not in ('supported', 'unsupported') then
    return query select 'bad_status'::text; return;
  end if;
  if p_status = 'unsupported' and v_reason is null then
    return query select 'reason_required'::text; return;
  end if;

  select * into v_row from qa.device_configurations d
   where d.id = p_device_id and d.organization_id = (select core.current_organization_id())
   for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;

  update qa.device_configurations
     set status = p_status,
         reason = case when p_status = 'unsupported' then v_reason else null end
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'device.support_changed', 'device_configuration', v_row.id,
    jsonb_build_object('status', v_row.status, 'reason', v_row.reason),
    jsonb_build_object('status', p_status, 'reason', v_reason)
  );

  return query select 'set'::text;
end;
$$;

comment on function qa.set_device_support(uuid, text, text) is
  'SCR-048: marks a registered device or configuration supported, or unsupported with a reason (required). can_manage_delivery(). Audits device.support_changed with before and after.';

revoke all on function qa.set_device_support(uuid, text, text) from public, anon;
grant execute on function qa.set_device_support(uuid, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
