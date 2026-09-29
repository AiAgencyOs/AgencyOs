-- A release is paid for, and a run has a life — bucket F, stream F-E
-- (SCR-044–061: QA & Release, Finance, Communication).
--
-- Decision 2026-09-30: launch is gated on the verified final payment (owner override with reason)
-- Decision 2026-09-30: budget vs actual reopened
--
-- What this migration adds, and the PDF screen each piece answers:
--
--   1. qa.test_runs gains a LIFE (SCR-046): status open|closed, started_at /
--      ended_at, a blocked count, and rerun_of. A run is opened, worked, and
--      closed once; a closed run is still evidence and is still never edited
--      (the 20260821240000 trigger is narrowed to allow exactly the one
--      open → closed transition and nothing else). qa.defects gains run_id so
--      a bug names the run that found it.
--   2. qa.retest_assignments (SCR-044/046/047): who is asked to verify a fix.
--   3. qa.performance_budgets and qa.metric_results (SCR-048): a target per
--      metric per project, and what a run measured, so the panel can compare
--      instead of reading free text.
--   4. qa.stability_incidents (SCR-048): opened, resolved, with a severity.
--   5. qa.suite_schedules (SCR-048): a cron expression per suite; the tick
--      opens a run when one is due. Nothing here executes tests — the panel
--      has no test runner — so a fired schedule is an OPEN run a person or an
--      agent fills and closes.
--   6. projects.handovers.deployment_dependencies (SCR-049).
--   7. THE PAYMENT GATE (SCR-049, decision F1): projects.mark_production_ready
--      refuses `payment_unverified` unless the final priced milestone's live
--      invoice is paid, net-verified, or carries a verified claim — or an
--      owner has recorded an override with a reason in
--      projects.release_payment_overrides (audited release.payment_overridden).
--      The plan named the door `projects.sign_off_release`; the door this
--      repository has is `projects.mark_production_ready` (ADM-19), so the gate
--      is added there rather than to a second door.
--   8. finance.gst_exports (SCR-056): every GSTR-1/3B file the routes produced.
--   9. crm.announcements.scheduled_for (SCR-059) and the tick's publisher.
--  10. crm.campaigns.scheduled_for (SCR-059): the worker does not claim a
--      recipient before the hour the planner named. create_campaign takes it.
--  11. core.requeue_job_with_reason (SCR-060): the requeue, with the words.
--      (Escalating a failed delivery uses stream F-A's core.escalations and
--      its core.escalate door — migration 20261001100000 — with
--      subject_type 'delivery' and the message id as the key.)
--
-- Every table: organization_id, RLS enabled and forced, internal select,
-- role-named writes, tenancy triggers on every org-scoped FK, freeze trigger,
-- grants. Every governed write audits through core.record_audit.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. a test run has a life
-- ═══════════════════════════════════════════════════════════════════════════

alter table qa.test_runs
  add column if not exists status     text not null default 'closed',
  add column if not exists started_at timestamptz,
  add column if not exists ended_at   timestamptz,
  add column if not exists blocked    int not null default 0,
  add column if not exists rerun_of   uuid references qa.test_runs(id) on delete set null;

-- Every run recorded before today was recorded complete: it was closed at
-- the moment it was executed. The evidence trigger is stepped around for
-- exactly this backfill of two timestamps that add nothing the row did not
-- already say; no count moves.
alter table qa.test_runs disable trigger refuse_test_run_rewrite;
update qa.test_runs
   set started_at = coalesce(started_at, executed_at),
       ended_at   = coalesce(ended_at, executed_at)
 where status = 'closed' and (started_at is null or ended_at is null);
alter table qa.test_runs enable trigger refuse_test_run_rewrite;

alter table qa.test_runs drop constraint if exists test_runs_status_named;
alter table qa.test_runs
  add constraint test_runs_status_named check (status in ('open', 'closed'));

alter table qa.test_runs drop constraint if exists test_runs_blocked_non_negative;
alter table qa.test_runs
  add constraint test_runs_blocked_non_negative check (blocked >= 0);

-- Blocked is its own column, the same reason skipped is: a blocked case is
-- not a pass and is not a fail. The counts still add up.
alter table qa.test_runs drop constraint if exists test_runs_counts_add_up;
alter table qa.test_runs
  add constraint test_runs_counts_add_up check (passed + failed + skipped + blocked = total);

alter table qa.test_runs drop constraint if exists test_runs_closed_has_end;
alter table qa.test_runs
  add constraint test_runs_closed_has_end check (status <> 'closed' or ended_at is not null);

comment on column qa.test_runs.status is
  'SCR-046: open while the run is being worked, closed once its counts are final. A closed run is evidence and is never edited; an open run may be closed exactly once (qa.close_test_run).';
comment on column qa.test_runs.blocked is
  'SCR-046: cases that could not be executed because something stood in the way. Not a pass, not a fail, not skipped — its own column, and it adds up with the others.';
comment on column qa.test_runs.rerun_of is
  'SCR-046: the run whose failed cases this one re-executes (qa.rerun_test_run).';

create index if not exists test_runs_org_status_idx
  on qa.test_runs (organization_id, status, executed_at desc);

drop trigger if exists org_match_test_runs_rerun on qa.test_runs;
create trigger org_match_test_runs_rerun
  before insert or update of rerun_of, organization_id on qa.test_runs
  for each row execute function core.enforce_parent_org('rerun_of', 'qa.test_runs');

-- Evidence is still not editable. The one transition a run may make is open
-- → closed, and only once: a closed row refuses every update exactly as
-- 20260821240000 wrote it.
create or replace function qa.refuse_test_run_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'open' and new.status in ('open', 'closed') then
    return new;
  end if;
  raise exception 'a test run is evidence and is never edited; record another run (Doc 14 §31)'
    using errcode = 'check_violation';
end;
$$;

alter table qa.defects
  add column if not exists run_id uuid references qa.test_runs(id) on delete set null;

comment on column qa.defects.run_id is
  'SCR-046/047: the test run that found this defect, when one did.';

create index if not exists defects_run_idx on qa.defects (organization_id, run_id);

drop trigger if exists org_match_defects_run on qa.defects;
create trigger org_match_defects_run
  before insert or update of run_id, organization_id on qa.defects
  for each row execute function core.enforce_parent_org('run_id', 'qa.test_runs');

-- ── open ─────────────────────────────────────────────────────────────────

create or replace function qa.open_test_run(
  p_deliverable_id uuid,
  p_suite          text,
  p_rerun_of       uuid default null,
  p_device         text default null,
  p_browser        text default null,
  p_os             text default null
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
  if v_kind <> 'build' then
    return query select 'not_a_build'::text, null::uuid; return;
  end if;

  if p_rerun_of is not null and not exists (
    select 1 from qa.test_runs r where r.id = p_rerun_of and r.organization_id = v_org and r.project_id = v_project
  ) then
    return query select 'rerun_not_found'::text, null::uuid; return;
  end if;

  insert into qa.test_runs (
    organization_id, project_id, deliverable_id, suite,
    total, passed, failed, skipped, blocked, executed_by,
    status, started_at, rerun_of, device, browser, os
  )
  values (
    v_org, v_project, p_deliverable_id, p_suite,
    0, 0, 0, 0, 0, v_actor,
    'open', now(), p_rerun_of,
    nullif(trim(coalesce(p_device, '')), ''),
    nullif(trim(coalesce(p_browser, '')), ''),
    nullif(trim(coalesce(p_os, '')), '')
  )
  returning qa.test_runs.id into v_new;

  perform core.record_audit(
    v_org, 'test_run.opened', 'test_run', v_new, null,
    jsonb_build_object('suite', p_suite, 'deliverable_id', p_deliverable_id, 'rerun_of', p_rerun_of)
  );

  return query select 'opened'::text, v_new;
end;
$$;

comment on function qa.open_test_run(uuid, text, uuid, text, text, text) is
  'SCR-046: opens a test run (status open, started_at now, counts 0) against a build. can_write() like record_test_run. rerun_of names the run whose failures this one re-executes. Audits test_run.opened.';

revoke all on function qa.open_test_run(uuid, text, uuid, text, text, text) from public, anon;
grant execute on function qa.open_test_run(uuid, text, uuid, text, text, text) to authenticated, service_role;

-- ── close ────────────────────────────────────────────────────────────────

create or replace function qa.close_test_run(
  p_run_id       uuid,
  p_passed       int,
  p_failed       int,
  p_skipped      int default 0,
  p_blocked      int default 0,
  p_evidence_url text default null,
  p_perf_notes   text default null
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_run   qa.test_runs;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select * into v_run from qa.test_runs r
   where r.id = p_run_id and r.organization_id = (select core.current_organization_id())
   for update;
  if v_run.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_run.status <> 'open' then
    return query select 'not_open'::text; return;
  end if;
  if coalesce(p_passed, -1) < 0 or coalesce(p_failed, -1) < 0
     or coalesce(p_skipped, -1) < 0 or coalesce(p_blocked, -1) < 0 then
    return query select 'bad_counts'::text; return;
  end if;

  update qa.test_runs
     set status       = 'closed',
         ended_at     = now(),
         executed_at  = coalesce(started_at, executed_at),
         passed       = p_passed,
         failed       = p_failed,
         skipped      = p_skipped,
         blocked      = p_blocked,
         total        = p_passed + p_failed + p_skipped + p_blocked,
         evidence_url = coalesce(nullif(trim(coalesce(p_evidence_url, '')), ''), evidence_url),
         perf_notes   = coalesce(nullif(trim(coalesce(p_perf_notes, '')), ''), perf_notes)
   where id = v_run.id;

  perform core.record_audit(
    v_run.organization_id, 'test_run.closed', 'test_run', v_run.id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'closed', 'passed', p_passed, 'failed', p_failed,
                       'skipped', p_skipped, 'blocked', p_blocked)
  );

  return query select 'closed'::text;
end;
$$;

comment on function qa.close_test_run(uuid, int, int, int, int, text, text) is
  'SCR-046: closes an open run with its final counts (passed, failed, skipped, blocked; total is their sum) and ended_at. Once. A closed run refuses (not_open). Audits test_run.closed.';

revoke all on function qa.close_test_run(uuid, int, int, int, int, text, text) from public, anon;
grant execute on function qa.close_test_run(uuid, int, int, int, int, text, text) to authenticated, service_role;

-- ── rerun failed cases ───────────────────────────────────────────────────

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

  select * into v_out from qa.open_test_run(v_run.deliverable_id, v_run.suite, v_run.id, v_run.device, v_run.browser, v_run.os);
  return query select v_out.outcome, v_out.id;
end;
$$;

comment on function qa.rerun_test_run(uuid) is
  'SCR-046: opens a new run of the same suite against the same build with rerun_of set, for a closed run that had failed or blocked cases. Refuses not_closed and nothing_failed.';

revoke all on function qa.rerun_test_run(uuid) from public, anon;
grant execute on function qa.rerun_test_run(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. retest assignments
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.retest_assignments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  defect_id       uuid not null references qa.defects(id) on delete cascade,
  retester_id     uuid not null references core.users(id) on delete cascade,
  assigned_by     uuid references core.users(id) on delete set null,
  note            text check (note is null or length(btrim(note)) between 1 and 600),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table qa.retest_assignments is
  'SCR-044/046/047: who was asked to verify a fixed defect, by whom, with a note. Appended, never edited; the newest row is the standing assignment.';

create index if not exists retest_assignments_defect_idx
  on qa.retest_assignments (organization_id, defect_id, created_at desc);

drop trigger if exists set_updated_at on qa.retest_assignments;
create trigger set_updated_at before update on qa.retest_assignments
  for each row execute function core.set_updated_at();

alter table qa.retest_assignments enable row level security;
alter table qa.retest_assignments force row level security;

drop policy if exists retest_assignments_select on qa.retest_assignments;
create policy retest_assignments_select on qa.retest_assignments
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- can_write(): owner, ops_admin, delivery_lead, member — the roles that settle a defect.
drop policy if exists retest_assignments_insert on qa.retest_assignments;
create policy retest_assignments_insert on qa.retest_assignments
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop trigger if exists org_match_retest_assignments_defect on qa.retest_assignments;
create trigger org_match_retest_assignments_defect
  before insert or update of defect_id, organization_id on qa.retest_assignments
  for each row execute function core.enforce_parent_org('defect_id', 'qa.defects');

drop trigger if exists freeze_org_retest_assignments on qa.retest_assignments;
create trigger freeze_org_retest_assignments
  before update of organization_id on qa.retest_assignments
  for each row execute function core.freeze_organization_id();

grant select, insert on qa.retest_assignments to authenticated, service_role;

create or replace function qa.assign_retest(
  p_defect_id   uuid,
  p_retester_id uuid,
  p_note        text default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_defect qa.defects;
  v_new    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;

  select * into v_defect from qa.defects d
   where d.id = p_defect_id and d.organization_id = (select core.current_organization_id())
   for update;
  if v_defect.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_defect.status <> 'fixed' then
    return query select 'not_fixed'::text, null::uuid; return;
  end if;
  if not exists (
    select 1 from core.memberships m
     where m.user_id = p_retester_id
       and m.organization_id = v_defect.organization_id
       and m.status = 'active'
  ) then
    return query select 'not_a_member'::text, null::uuid; return;
  end if;

  insert into qa.retest_assignments (organization_id, defect_id, retester_id, assigned_by, note)
  values (v_defect.organization_id, v_defect.id, p_retester_id, v_actor, nullif(trim(coalesce(p_note, '')), ''))
  returning qa.retest_assignments.id into v_new;

  update qa.defects set assignee_id = p_retester_id, updated_at = now() where id = v_defect.id;

  perform core.record_audit(
    v_defect.organization_id, 'defect.retest_assigned', 'defect', v_defect.id,
    jsonb_build_object('assignee_id', v_defect.assignee_id),
    jsonb_build_object('retester_id', p_retester_id, 'assignment_id', v_new)
  );

  return query select 'assigned'::text, v_new;
end;
$$;

comment on function qa.assign_retest(uuid, uuid, text) is
  'SCR-044: asks a member to verify a fixed defect — writes qa.retest_assignments and moves the defect''s assignee. can_write(). Refuses not_fixed (only a fixed defect is retested) and not_a_member. Audits defect.retest_assigned.';

revoke all on function qa.assign_retest(uuid, uuid, text) from public, anon;
grant execute on function qa.assign_retest(uuid, uuid, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. performance budgets and metric results
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.performance_budgets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  metric          text not null check (length(btrim(metric)) between 1 and 80),
  target          numeric(14, 3) not null check (target >= 0),
  unit            text not null check (length(btrim(unit)) between 1 and 20),
  -- lower_is_better: a latency budget is "at most"; a score budget is "at least".
  lower_is_better boolean not null default true,
  set_by          uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint performance_budgets_one_per_metric unique (project_id, metric)
);

comment on table qa.performance_budgets is
  'SCR-048: the target a project holds a metric to (LCP 2.5 s, TTFB 600 ms, Lighthouse score 90). Doc 14 §16 says targets are project-specific: they are, per row.';

create index if not exists performance_budgets_project_idx
  on qa.performance_budgets (organization_id, project_id);

drop trigger if exists set_updated_at on qa.performance_budgets;
create trigger set_updated_at before update on qa.performance_budgets
  for each row execute function core.set_updated_at();

alter table qa.performance_budgets enable row level security;
alter table qa.performance_budgets force row level security;

drop policy if exists performance_budgets_select on qa.performance_budgets;
create policy performance_budgets_select on qa.performance_budgets
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- can_manage_delivery-shaped: owner, ops_admin, delivery_lead set a budget.
drop policy if exists performance_budgets_write on qa.performance_budgets;
create policy performance_budgets_write on qa.performance_budgets
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin', 'delivery_lead'))
  with check (organization_id = (select core.current_organization_id())
              and (select core.current_user_role()) in ('owner', 'ops_admin', 'delivery_lead'));

drop trigger if exists org_match_performance_budgets_project on qa.performance_budgets;
create trigger org_match_performance_budgets_project
  before insert or update of project_id, organization_id on qa.performance_budgets
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_performance_budgets on qa.performance_budgets;
create trigger freeze_org_performance_budgets
  before update of organization_id on qa.performance_budgets
  for each row execute function core.freeze_organization_id();

grant select, insert, update, delete on qa.performance_budgets to authenticated, service_role;

create table if not exists qa.metric_results (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  run_id          uuid not null references qa.test_runs(id) on delete cascade,
  metric          text not null check (length(btrim(metric)) between 1 and 80),
  value           numeric(14, 3) not null,
  unit            text not null check (length(btrim(unit)) between 1 and 20),
  recorded_by     uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table qa.metric_results is
  'SCR-048: what one run measured for one metric. Compared against qa.performance_budgets by a reader; never a verdict of its own.';

create index if not exists metric_results_run_idx
  on qa.metric_results (organization_id, run_id, metric);

drop trigger if exists set_updated_at on qa.metric_results;
create trigger set_updated_at before update on qa.metric_results
  for each row execute function core.set_updated_at();

alter table qa.metric_results enable row level security;
alter table qa.metric_results force row level security;

drop policy if exists metric_results_select on qa.metric_results;
create policy metric_results_select on qa.metric_results
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- can_write(): the same roles that record a run may attach its metrics.
drop policy if exists metric_results_insert on qa.metric_results;
create policy metric_results_insert on qa.metric_results
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop trigger if exists org_match_metric_results_run on qa.metric_results;
create trigger org_match_metric_results_run
  before insert or update of run_id, organization_id on qa.metric_results
  for each row execute function core.enforce_parent_org('run_id', 'qa.test_runs');

drop trigger if exists freeze_org_metric_results on qa.metric_results;
create trigger freeze_org_metric_results
  before update of organization_id on qa.metric_results
  for each row execute function core.freeze_organization_id();

grant select, insert on qa.metric_results to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. stability incidents
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.stability_incidents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  severity        text not null check (severity in ('low', 'medium', 'high', 'critical')),
  summary         text not null check (length(btrim(summary)) between 1 and 2000),
  opened_at       timestamptz not null default now(),
  opened_by       uuid references core.users(id) on delete set null,
  resolved_at     timestamptz,
  resolved_by     uuid references core.users(id) on delete set null,
  resolution      text check (resolution is null or length(btrim(resolution)) between 1 and 2000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint stability_incidents_resolved_says_how
    check (resolved_at is null or resolution is not null)
);

comment on table qa.stability_incidents is
  'SCR-048: an outage, crash or degradation on a project — opened with a severity and a summary, resolved with words. Never deleted.';

create index if not exists stability_incidents_project_idx
  on qa.stability_incidents (organization_id, project_id, resolved_at, opened_at desc);

drop trigger if exists set_updated_at on qa.stability_incidents;
create trigger set_updated_at before update on qa.stability_incidents
  for each row execute function core.set_updated_at();

alter table qa.stability_incidents enable row level security;
alter table qa.stability_incidents force row level security;

drop policy if exists stability_incidents_select on qa.stability_incidents;
create policy stability_incidents_select on qa.stability_incidents
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists stability_incidents_write on qa.stability_incidents;
create policy stability_incidents_write on qa.stability_incidents
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop trigger if exists org_match_stability_incidents_project on qa.stability_incidents;
create trigger org_match_stability_incidents_project
  before insert or update of project_id, organization_id on qa.stability_incidents
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_stability_incidents on qa.stability_incidents;
create trigger freeze_org_stability_incidents
  before update of organization_id on qa.stability_incidents
  for each row execute function core.freeze_organization_id();

grant select, insert, update on qa.stability_incidents to authenticated, service_role;

create or replace function qa.resolve_stability_incident(p_incident_id uuid, p_resolution text)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row qa.stability_incidents;
begin
  if (select auth.uid()) is null then
    return query select 'no_actor'::text; return;
  end if;
  if length(btrim(coalesce(p_resolution, ''))) < 1 then
    return query select 'no_resolution'::text; return;
  end if;
  select * into v_row from qa.stability_incidents i
   where i.id = p_incident_id and i.organization_id = (select core.current_organization_id())
   for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.resolved_at is not null then
    return query select 'already_resolved'::text; return;
  end if;

  update qa.stability_incidents
     set resolved_at = now(), resolved_by = (select auth.uid()), resolution = btrim(p_resolution)
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'stability_incident.resolved', 'stability_incident', v_row.id,
    jsonb_build_object('severity', v_row.severity, 'opened_at', v_row.opened_at),
    jsonb_build_object('resolution', btrim(p_resolution))
  );
  return query select 'resolved'::text;
end;
$$;

comment on function qa.resolve_stability_incident(uuid, text) is
  'SCR-048: resolves an open incident with words. security invoker — stability_incidents_write (can_write) decides. Audits stability_incident.resolved.';

revoke all on function qa.resolve_stability_incident(uuid, text) from public, anon;
grant execute on function qa.resolve_stability_incident(uuid, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. suite schedules, fired by the cron tick
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.suite_schedules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  -- The build the scheduled run is opened against — the latest build when
  -- the schedule was written; a person moves it when a new build lands.
  deliverable_id  uuid not null references projects.deliverables(id) on delete cascade,
  suite           text not null check (suite in (
                    'functional', 'ui', 'api', 'integration', 'e2e',
                    'regression', 'smoke', 'security', 'performance', 'compatibility')),
  -- Five-field cron, minute hour day month weekday, in the agency's zone.
  cron            text not null check (length(btrim(cron)) between 9 and 120),
  active          boolean not null default true,
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  last_run_id     uuid references qa.test_runs(id) on delete set null,
  created_by      uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint suite_schedules_one_per_suite unique (project_id, suite)
);

comment on table qa.suite_schedules is
  'SCR-048: a suite that is due on a cron expression. The tick (qa.fire_suite_schedule, service role) OPENS a run when one is due — nothing here executes tests; the panel has no runner — and a person or an agent fills and closes it.';

create index if not exists suite_schedules_due_idx
  on qa.suite_schedules (active, next_run_at);

drop trigger if exists set_updated_at on qa.suite_schedules;
create trigger set_updated_at before update on qa.suite_schedules
  for each row execute function core.set_updated_at();

alter table qa.suite_schedules enable row level security;
alter table qa.suite_schedules force row level security;

drop policy if exists suite_schedules_select on qa.suite_schedules;
create policy suite_schedules_select on qa.suite_schedules
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists suite_schedules_write on qa.suite_schedules;
create policy suite_schedules_write on qa.suite_schedules
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin', 'delivery_lead'))
  with check (organization_id = (select core.current_organization_id())
              and (select core.current_user_role()) in ('owner', 'ops_admin', 'delivery_lead'));

drop trigger if exists org_match_suite_schedules_project on qa.suite_schedules;
create trigger org_match_suite_schedules_project
  before insert or update of project_id, organization_id on qa.suite_schedules
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_suite_schedules_deliverable on qa.suite_schedules;
create trigger org_match_suite_schedules_deliverable
  before insert or update of deliverable_id, organization_id on qa.suite_schedules
  for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');

drop trigger if exists org_match_suite_schedules_run on qa.suite_schedules;
create trigger org_match_suite_schedules_run
  before insert or update of last_run_id, organization_id on qa.suite_schedules
  for each row execute function core.enforce_parent_org('last_run_id', 'qa.test_runs');

drop trigger if exists freeze_org_suite_schedules on qa.suite_schedules;
create trigger freeze_org_suite_schedules
  before update of organization_id on qa.suite_schedules
  for each row execute function core.freeze_organization_id();

grant select, insert, update, delete on qa.suite_schedules to authenticated, service_role;

-- The tick's door. The next occurrence is computed by the runner (the cron
-- parser lives in src/modules/qa/cron.ts, in the agency's zone) and handed
-- in, so the database keeps no second cron parser.
create or replace function qa.fire_suite_schedule(p_schedule_id uuid, p_next_run_at timestamptz)
returns table (outcome text, run_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_s    qa.suite_schedules;
  v_kind text;
  v_new  uuid;
begin
  select * into v_s from qa.suite_schedules s where s.id = p_schedule_id for update skip locked;
  if v_s.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if not v_s.active or v_s.next_run_at is null or v_s.next_run_at > now() then
    return query select 'not_due'::text, null::uuid; return;
  end if;

  select d.kind into v_kind from projects.deliverables d where d.id = v_s.deliverable_id;
  if v_kind is distinct from 'build' then
    update qa.suite_schedules set active = false where id = v_s.id;
    return query select 'not_a_build'::text, null::uuid; return;
  end if;

  insert into qa.test_runs (
    organization_id, project_id, deliverable_id, suite,
    total, passed, failed, skipped, blocked, status, started_at
  )
  values (v_s.organization_id, v_s.project_id, v_s.deliverable_id, v_s.suite, 0, 0, 0, 0, 0, 'open', now())
  returning qa.test_runs.id into v_new;

  update qa.suite_schedules
     set last_run_at = now(), last_run_id = v_new, next_run_at = p_next_run_at
   where id = v_s.id;

  perform core.record_audit(
    v_s.organization_id, 'suite_schedule.fired', 'suite_schedule', v_s.id, null,
    jsonb_build_object('suite', v_s.suite, 'run_id', v_new, 'next_run_at', p_next_run_at)
  );

  return query select 'fired'::text, v_new;
end;
$$;

comment on function qa.fire_suite_schedule(uuid, timestamptz) is
  'SCR-048: the cron tick''s door — opens a run for a due schedule and advances next_run_at to what the runner computed. service_role only. Audits suite_schedule.fired.';

revoke all on function qa.fire_suite_schedule(uuid, timestamptz) from public, anon, authenticated;
grant execute on function qa.fire_suite_schedule(uuid, timestamptz) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. deployment dependencies on the release candidate
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.handovers
  add column if not exists deployment_dependencies jsonb not null default '[]'::jsonb;

comment on column projects.handovers.deployment_dependencies is
  'SCR-049: [{"label": text, "status": "pending"|"ready", "updated_at": iso}] — what the deployment waits on (DNS, a vendor key, a client sign-off). A report beside the gate; mark_production_ready does not read it.';

create or replace function projects.set_deployment_dependency(
  p_handover_id uuid,
  p_label       text,
  p_status      text default 'pending',
  p_remove      boolean default false
)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row   projects.handovers;
  v_label text := btrim(coalesce(p_label, ''));
  v_next  jsonb;
begin
  if (select auth.uid()) is null then
    return query select 'no_actor'::text; return;
  end if;
  if length(v_label) < 1 or length(v_label) > 200 then
    return query select 'bad_label'::text; return;
  end if;
  if p_status not in ('pending', 'ready') then
    return query select 'bad_status'::text; return;
  end if;

  select * into v_row from projects.handovers h
   where h.id = p_handover_id and h.organization_id = (select core.current_organization_id())
   for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;

  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_next
    from jsonb_array_elements(v_row.deployment_dependencies) e
   where e->>'label' <> v_label;
  if not p_remove then
    v_next := v_next || jsonb_build_array(jsonb_build_object('label', v_label, 'status', p_status, 'updated_at', now()));
  end if;

  update projects.handovers set deployment_dependencies = v_next, updated_at = now() where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'handover.deployment_dependency_set', 'handover', v_row.id,
    jsonb_build_object('dependencies', v_row.deployment_dependencies),
    jsonb_build_object('dependencies', v_next)
  );

  return query select (case when p_remove then 'removed' else 'set' end)::text;
end;
$$;

comment on function projects.set_deployment_dependency(uuid, text, text, boolean) is
  'SCR-049: adds, updates or removes one deployment dependency on the handover. security invoker — the handovers update policy decides. Audits handover.deployment_dependency_set.';

revoke all on function projects.set_deployment_dependency(uuid, text, text, boolean) from public, anon;
grant execute on function projects.set_deployment_dependency(uuid, text, text, boolean) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. the payment gate — decision F1 of 2026-09-30
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.release_payment_overrides (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  overridden_by   uuid references core.users(id) on delete set null,
  reason          text not null check (length(btrim(reason)) between 10 and 2000),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table projects.release_payment_overrides is
  'Decision 2026-09-30 (F1): an owner''s recorded reason for signing a release off while the final payment is not verified. One row is enough; every row is kept. Written only by projects.override_release_payment.';

create index if not exists release_payment_overrides_project_idx
  on projects.release_payment_overrides (organization_id, project_id, created_at desc);

drop trigger if exists set_updated_at on projects.release_payment_overrides;
create trigger set_updated_at before update on projects.release_payment_overrides
  for each row execute function core.set_updated_at();

alter table projects.release_payment_overrides enable row level security;
alter table projects.release_payment_overrides force row level security;

drop policy if exists release_payment_overrides_select on projects.release_payment_overrides;
create policy release_payment_overrides_select on projects.release_payment_overrides
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- Owner only. Nothing else writes here, and nothing updates or deletes.
drop policy if exists release_payment_overrides_insert on projects.release_payment_overrides;
create policy release_payment_overrides_insert on projects.release_payment_overrides
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.is_owner()));

drop trigger if exists org_match_release_payment_overrides_project on projects.release_payment_overrides;
create trigger org_match_release_payment_overrides_project
  before insert or update of project_id, organization_id on projects.release_payment_overrides
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_release_payment_overrides on projects.release_payment_overrides;
create trigger freeze_org_release_payment_overrides
  before update of organization_id on projects.release_payment_overrides
  for each row execute function core.freeze_organization_id();

grant select, insert on projects.release_payment_overrides to authenticated, service_role;

-- The fact the gate reads. The FINAL priced milestone is the priced one
-- (payment_percent not null, as finance.project_payment_progress counts them)
-- with the highest position. Its live (non-void) invoice is verified when
-- the invoice is paid, its net verified amount covers the total, or a
-- payment claim on it is verified.
create or replace function projects.final_payment_state(p_project_id uuid)
returns table (
  -- 'no_priced_milestone' | 'no_invoice' | 'unverified' | 'verified' | 'overridden'
  state          text,
  milestone_id   uuid,
  milestone_name text,
  invoice_id     uuid,
  invoice_number text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_m   record;
  v_inv record;
begin
  select m.id, m.name into v_m
    from projects.milestones m
   where m.project_id = p_project_id
     and m.payment_percent is not null
   order by m.position desc
   limit 1;

  if v_m.id is null then
    return query select 'no_priced_milestone'::text, null::uuid, null::text, null::uuid, null::text; return;
  end if;

  if exists (select 1 from projects.release_payment_overrides o where o.project_id = p_project_id) then
    return query select 'overridden'::text, v_m.id, v_m.name, null::uuid, null::text; return;
  end if;

  select i.id, i.number, i.status, i.total_minor into v_inv
    from finance.invoices i
   where i.milestone_id = v_m.id and i.status <> 'void'
   order by i.created_at desc
   limit 1;

  if v_inv.id is null then
    return query select 'no_invoice'::text, v_m.id, v_m.name, null::uuid, null::text; return;
  end if;

  if v_inv.status = 'paid'
     or finance.net_verified_minor(v_inv.id) >= v_inv.total_minor
     or exists (select 1 from finance.payment_submissions s where s.invoice_id = v_inv.id and s.status = 'verified') then
    return query select 'verified'::text, v_m.id, v_m.name, v_inv.id, v_inv.number; return;
  end if;

  return query select 'unverified'::text, v_m.id, v_m.name, v_inv.id, v_inv.number;
end;
$$;

comment on function projects.final_payment_state(uuid) is
  'Decision F1: whether the final priced milestone''s invoice is paid, net-verified or carries a verified claim — or an owner override stands. What mark_production_ready reads before it signs off.';

revoke all on function projects.final_payment_state(uuid) from public, anon;
grant execute on function projects.final_payment_state(uuid) to authenticated, service_role;

create or replace function projects.override_release_payment(p_project_id uuid, p_reason text)
returns table (outcome text, id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_state text;
  v_new   uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    return query select 'no_reason'::text, null::uuid; return;
  end if;

  select p.organization_id into v_org from projects.projects p
   where p.id = p_project_id and p.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  select s.state into v_state from projects.final_payment_state(p_project_id) s;
  if v_state in ('verified', 'no_priced_milestone') then
    return query select 'nothing_to_override'::text, null::uuid; return;
  end if;
  if v_state = 'overridden' then
    return query select 'already_overridden'::text, null::uuid; return;
  end if;

  insert into projects.release_payment_overrides (organization_id, project_id, overridden_by, reason)
  values (v_org, p_project_id, v_actor, btrim(p_reason))
  returning projects.release_payment_overrides.id into v_new;

  perform core.record_audit(
    v_org, 'release.payment_overridden', 'project', p_project_id,
    jsonb_build_object('payment_state', v_state),
    jsonb_build_object('override_id', v_new, 'reason', btrim(p_reason))
  );

  return query select 'overridden'::text, v_new;
end;
$$;

comment on function projects.override_release_payment(uuid, text) is
  'Decision F1: the owner''s override of the payment gate, with a reason of at least ten characters. Owner only (is_owner, and the insert policy again). Refuses nothing_to_override when the payment is verified. Audits release.payment_overridden.';

revoke all on function projects.override_release_payment(uuid, text) from public, anon;
grant execute on function projects.override_release_payment(uuid, text) to authenticated;

-- mark_production_ready gains one refusal, after the hold and before ADM-19's
-- three: 'payment_unverified', with the invoice number (or 'no invoice') as
-- the unmet line. Otherwise identical to 20260929190000. The plan called this
-- door projects.sign_off_release; the repository's door is this one.
create or replace function projects.mark_production_ready(p_project_id uuid)
returns table (
  -- 'ready' | 'already_ready' | 'not_found' | 'not_ready' | 'held' | 'payment_unverified'
  outcome text,
  unmet   text[]
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ready_at    timestamptz;
  v_hold_reason text;
  v_state       record;
  v_payment     record;
  v_unmet       text[] := '{}';
begin
  if core.current_organization_id() is not null
     and core.current_user_role() not in ('owner', 'ops_admin') then
    return query select 'not_found'::text, '{}'::text[];
    return;
  end if;

  select p.production_ready_at, p.release_hold_reason
    into v_ready_at, v_hold_reason
    from projects.projects p
   where p.id = p_project_id
     for update;

  if not found then
    return query select 'not_found'::text, '{}'::text[];
    return;
  end if;

  if v_ready_at is not null then
    return query select 'already_ready'::text, '{}'::text[];
    return;
  end if;

  if v_hold_reason is not null then
    return query select 'held'::text, array[v_hold_reason];
    return;
  end if;

  -- Decision F1 (2026-09-30): launch is gated on the verified final payment.
  select * into v_payment from projects.final_payment_state(p_project_id);
  if v_payment.state in ('no_invoice', 'unverified') then
    return query select 'payment_unverified'::text,
      array[coalesce(v_payment.invoice_number, 'no invoice'), coalesce(v_payment.milestone_name, '')];
    return;
  end if;

  select * into v_state from projects.production_readiness(p_project_id);

  if not v_state.no_open_blockers then
    v_unmet := v_unmet || 'open_blockers'::text;
  end if;
  if not v_state.no_open_majors then
    v_unmet := v_unmet || 'open_majors'::text;
  end if;
  if not v_state.build_approved then
    v_unmet := v_unmet || 'no_approved_build'::text;
  end if;

  if array_length(v_unmet, 1) is not null then
    return query select 'not_ready'::text, v_unmet;
    return;
  end if;

  update projects.projects
     set production_ready_at = now(),
         updated_at          = now()
   where id = p_project_id;

  return query select 'ready'::text, '{}'::text[];
end;
$$;

comment on function projects.mark_production_ready(uuid) is
  'Marks a project production ready when ADM-19''s conditions hold (no open blockers or majors, an approved build), no release hold stands (SCR-044: held), and the final priced milestone''s invoice is paid, net-verified or carries a verified claim — or an owner override is recorded (decision F1 of 2026-09-30: payment_unverified otherwise, unmet = [invoice number, milestone]). Caller-scoped: owner or ops_admin; the service role is unrestricted. Answers not_found to a caller who may not sign off.';

revoke all on function projects.mark_production_ready(uuid) from public, anon;
grant execute on function projects.mark_production_ready(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. GST export history
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance.gst_exports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  kind            text not null check (kind in ('gstr1', 'gstr3b')),
  period_label    text not null check (length(btrim(period_label)) between 1 and 80),
  return_period   text not null check (return_period ~ '^[0-9]{6}$'),
  counts          jsonb not null default '{}'::jsonb,
  omitted         jsonb not null default '[]'::jsonb,
  exported_by     uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table finance.gst_exports is
  'SCR-056: every GSTR-1 / GSTR-3B file the panel produced — which return period, the counts in the file, and the invoice numbers it OMITTED. Written by app/api/finance/gst/gstr-export.ts beside the gst.exported audit row.';

create index if not exists gst_exports_org_idx
  on finance.gst_exports (organization_id, created_at desc);

drop trigger if exists set_updated_at on finance.gst_exports;
create trigger set_updated_at before update on finance.gst_exports
  for each row execute function core.set_updated_at();

alter table finance.gst_exports enable row level security;
alter table finance.gst_exports force row level security;

-- The same roles finance.invoices_select admits: owner, ops_admin, finance.
drop policy if exists gst_exports_select on finance.gst_exports;
create policy gst_exports_select on finance.gst_exports
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin', 'finance'));

drop policy if exists gst_exports_insert on finance.gst_exports;
create policy gst_exports_insert on finance.gst_exports
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.current_user_role()) in ('owner', 'ops_admin', 'finance'));

drop trigger if exists freeze_org_gst_exports on finance.gst_exports;
create trigger freeze_org_gst_exports
  before update of organization_id on finance.gst_exports
  for each row execute function core.freeze_organization_id();

grant select, insert on finance.gst_exports to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. scheduled announcements
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.announcements
  add column if not exists scheduled_for timestamptz;

comment on column crm.announcements.scheduled_for is
  'SCR-059: a draft with a moment set is published by the cron tick (crm.publish_due_announcements) at or after it. Cleared when published by hand.';

create index if not exists announcements_due_idx
  on crm.announcements (status, scheduled_for);

create or replace function crm.schedule_announcement(p_announcement_id uuid, p_scheduled_for timestamptz)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row crm.announcements;
begin
  if (select auth.uid()) is null or not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_row from crm.announcements a
   where a.id = p_announcement_id and a.organization_id = (select core.current_organization_id())
   for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.status <> 'draft' then
    return query select 'not_a_draft'::text; return;
  end if;
  if p_scheduled_for is not null and p_scheduled_for <= now() then
    return query select 'in_the_past'::text; return;
  end if;

  update crm.announcements set scheduled_for = p_scheduled_for where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'announcement.scheduled', 'announcement', v_row.id,
    jsonb_build_object('scheduled_for', v_row.scheduled_for),
    jsonb_build_object('scheduled_for', p_scheduled_for, 'title', v_row.title)
  );
  return query select (case when p_scheduled_for is null then 'unscheduled' else 'scheduled' end)::text;
end;
$$;

comment on function crm.schedule_announcement(uuid, timestamptz) is
  'SCR-059: sets (or clears, with null) the moment a draft announcement is published by the tick. Owner only; a moment in the past refuses. Audits announcement.scheduled.';

revoke all on function crm.schedule_announcement(uuid, timestamptz) from public, anon;
grant execute on function crm.schedule_announcement(uuid, timestamptz) to authenticated;

create or replace function crm.publish_due_announcements(p_limit int default 50)
returns table (announcement_id uuid, organization_id uuid, title text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row crm.announcements;
begin
  for v_row in
    select a.* from crm.announcements a
     where a.status = 'draft' and a.scheduled_for is not null and a.scheduled_for <= now()
     order by a.scheduled_for asc
     limit greatest(1, least(coalesce(p_limit, 50), 500))
     for update skip locked
  loop
    update crm.announcements
       set status = 'published', published_at = now(), scheduled_for = null
     where id = v_row.id;

    perform core.record_audit(
      v_row.organization_id, 'announcement.published', 'announcement', v_row.id,
      jsonb_build_object('status', 'draft', 'scheduled_for', v_row.scheduled_for),
      jsonb_build_object('status', 'published', 'audience', v_row.audience, 'title', v_row.title, 'by', 'schedule')
    );

    return query select v_row.id, v_row.organization_id, v_row.title;
  end loop;
end;
$$;

comment on function crm.publish_due_announcements(int) is
  'SCR-059: the tick''s publisher — every draft whose scheduled_for has passed becomes published, audited as by the schedule. service_role only. Records; sends nothing.';

revoke all on function crm.publish_due_announcements(int) from public, anon, authenticated;
grant execute on function crm.publish_due_announcements(int) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. a campaign may be scheduled
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.campaigns
  add column if not exists scheduled_for timestamptz;

comment on column crm.campaigns.scheduled_for is
  'SCR-059: the worker claims no recipient of this campaign before this moment. Null means as soon as approved.';

drop function if exists crm.create_campaign(text, uuid, jsonb);

create or replace function crm.create_campaign(
  p_name          text,
  p_template_id   uuid,
  p_audience      jsonb,
  p_scheduled_for timestamptz default null
)
returns table (outcome text, campaign_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_template crm.whatsapp_templates;
  v_id       uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if p_scheduled_for is not null and p_scheduled_for <= now() then
    return query select 'in_the_past'::text, null::uuid; return;
  end if;

  select * into v_template from crm.whatsapp_templates
   where id = p_template_id and organization_id = v_org;
  if v_template.id is null then
    return query select 'template_not_found'::text, null::uuid; return;
  end if;
  if v_template.status <> 'approved' or not v_template.active then
    return query select 'template_not_approved'::text, null::uuid; return;
  end if;

  insert into crm.campaigns (organization_id, name, template_id, audience, created_by, scheduled_for)
  values (v_org, btrim(p_name), v_template.id, coalesce(p_audience, '{}'::jsonb), v_actor, p_scheduled_for)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'campaign.created', 'campaign', v_id, null,
    jsonb_build_object('name', btrim(p_name), 'template_id', v_template.id,
                       'template_name', v_template.template_name, 'audience', coalesce(p_audience, '{}'::jsonb),
                       'scheduled_for', p_scheduled_for)
  );

  return query select 'created'::text, v_id;
end;
$$;

comment on function crm.create_campaign(text, uuid, jsonb, timestamptz) is
  'SCR-059 (owner decision 2026-09-30): saves a campaign draft — name, approved template, audience filter as typed, and an optional moment before which the worker sends nothing. Owner/ops_admin (SECURITY INVOKER, campaigns_write decides again). Audits campaign.created.';

revoke all on function crm.create_campaign(text, uuid, jsonb, timestamptz) from public, anon;
grant execute on function crm.create_campaign(text, uuid, jsonb, timestamptz) to authenticated, service_role;

-- The claim honours the schedule: a campaign whose hour has not come is
-- skipped, and its rows wait. Otherwise identical to 20260930140000.
create or replace function crm.claim_campaign_recipient()
returns table (
  recipient_id    uuid,
  campaign_id     uuid,
  organization_id uuid,
  lead_id         uuid,
  conversation_id uuid,
  template_id     uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_recipient crm.campaign_recipients;
  v_campaign  crm.campaigns;
begin
  select r.* into v_recipient
    from crm.campaign_recipients r
    join crm.campaigns c on c.id = r.campaign_id
   where r.status = 'pending'
     and c.status in ('approved', 'running')
     and (c.scheduled_for is null or c.scheduled_for <= now())
     and (r.claimed_at is null or r.claimed_at < now() - interval '10 minutes')
   order by c.approved_at asc nulls last, r.created_at asc
   limit 1
   for update of r skip locked;

  if v_recipient.id is null then
    return;
  end if;

  update crm.campaign_recipients set claimed_at = now() where id = v_recipient.id;

  select * into v_campaign from crm.campaigns where id = v_recipient.campaign_id for update;
  if v_campaign.status = 'approved' then
    update crm.campaigns set status = 'running', started_at = now() where id = v_campaign.id;
    perform core.record_audit(
      v_campaign.organization_id, 'campaign.started', 'campaign', v_campaign.id,
      jsonb_build_object('status', 'approved'),
      jsonb_build_object('status', 'running', 'recipients', v_campaign.recipients_count)
    );
  end if;

  return query select v_recipient.id, v_campaign.id, v_campaign.organization_id,
                      v_recipient.lead_id, v_recipient.conversation_id, v_campaign.template_id;
end;
$$;

comment on function crm.claim_campaign_recipient() is
  'SCR-059: the cron worker''s claim — one pending recipient of an approved or running campaign whose scheduled_for (if any) has passed, FOR UPDATE SKIP LOCKED, stamped claimed_at so a dead worker''s claim expires. The first claim moves the campaign approved → running and audits campaign.started. service_role only.';

revoke all on function crm.claim_campaign_recipient() from public, anon, authenticated;
grant execute on function crm.claim_campaign_recipient() to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. requeue, with the words
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.requeue_job_with_reason(p_job_id uuid, p_reason text)
returns table (outcome text, job_status text, attempts int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org uuid;
  v_out record;
begin
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    return query select 'no_reason'::text, null::text, null::int; return;
  end if;

  select j.organization_id into v_org from core.jobs j where j.id = p_job_id;

  select * into v_out from core.requeue_job(p_job_id);

  if v_out.outcome = 'requeued' and v_org is not null then
    perform core.record_audit(
      v_org, 'job.requeued_with_reason', 'job', p_job_id,
      jsonb_build_object('attempts_before', v_out.attempts),
      jsonb_build_object('reason', btrim(p_reason))
    );
  end if;

  return query select v_out.outcome, v_out.job_status, v_out.attempts;
end;
$$;

comment on function core.requeue_job_with_reason(uuid, text) is
  'SCR-060: core.requeue_job with the operator''s reason recorded in audit.audit_log (job.requeued_with_reason). The requeue itself is decided by core.requeue_job exactly as before.';

revoke all on function core.requeue_job_with_reason(uuid, text) from public, anon;
grant execute on function core.requeue_job_with_reason(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
