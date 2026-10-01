-- ═══════════════════════════════════════════════════════════════════════════
-- R1 / Q-PH56 (owner, round 3, 2026-10-01): completing Phase 5 raises the M3
-- invoice and the PM's Task 3 message; completing Phase 6 raises M4 and the PM's
-- Task 4 message - exactly as Phase 4 does for M2.
--
-- The Phase 4 mechanism, mirrored (20260923160000):
--   * `projects.complete_phase_four` records the fact and emits
--     `project.phase_four_completed` with subject_type = 'project';
--   * the event catalog fans that out to `finance:generateM2Invoice` and
--     `crm:announceTask2Complete`.
-- Here `projects.complete_phase` records a Phase 5 / 6 completion and emits
-- `project.phase_five_completed` / `project.phase_six_completed`, which fan out
-- to `finance:generateM3Invoice` + `crm:announceTask3Complete` and
-- `finance:generateM4Invoice` + `crm:announceTask4Complete`.
--
-- WHAT COMPLETES EACH PHASE, from Development / QA data (the owner left the
-- definition to us; stated here and on the project page):
--   Phase 5 (development) is complete when the project has at least one
--     development task (a task attached to a module or a feature) and EVERY
--     such task is done.
--   Phase 6 (testing) is complete when Phase 5 is complete, at least one test
--     run is recorded, the LATEST run of each suite that has run has no
--     failures, and no blocker or major defect is open on the project.
-- `projects.phase_readiness` answers this read-only (what is missing, in words);
-- `projects.complete_phase` re-checks it under the project's row lock, so the
-- page cannot be out of date. A person with project.write (owner, ops admin,
-- delivery lead) or the service role calls the door; it is idempotent, and the
-- invoice is an ISSUED invoice only - never a verified payment (Finance 12-17).
--
-- Additive and idempotent: applies twice.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.phase_five_completed',
   'Q-PH56. Phase 5 (development) is complete: every development task is done. Triggers Finance''s M3 (30%) invoice and the PM''s Task 3 Complete message.',
   true),
  ('project.phase_six_completed',
   'Q-PH56. Phase 6 (testing) is complete: the latest run of every suite is clean and no blocker or major defect is open. Triggers Finance''s M4 (20%) invoice and the PM''s Task 4 Complete message.',
   true)
on conflict (type) do nothing;

create table if not exists projects.phase_completions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  phase            int not null check (phase in (5, 6)),
  completed_at     timestamptz not null default now(),
  completed_by     uuid references core.users(id) on delete set null,
  -- What the readiness read found at the moment of completion, so the fact
  -- carries its evidence and does not depend on rows that may change later.
  basis            jsonb not null default '{}'::jsonb,
  constraint phase_completions_one_per_phase unique (project_id, phase)
);

comment on table projects.phase_completions is
  'Q-PH56: the fact that Phase 5 or Phase 6 of a project was completed, with the evidence it was completed on. Written only by projects.complete_phase.';

create index if not exists phase_completions_org_idx on projects.phase_completions (organization_id, project_id);

alter table projects.phase_completions enable row level security;
alter table projects.phase_completions force row level security;

drop policy if exists phase_completions_select on projects.phase_completions;
create policy phase_completions_select on projects.phase_completions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

revoke all on table projects.phase_completions from public, anon, authenticated;
grant select on table projects.phase_completions to authenticated;
grant select, insert, update, delete on table projects.phase_completions to service_role;

drop trigger if exists org_match_phase_completions_project on projects.phase_completions;
create trigger org_match_phase_completions_project
  before insert or update of project_id, organization_id on projects.phase_completions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_phase_completions on projects.phase_completions;
create trigger freeze_org_phase_completions
  before update of organization_id on projects.phase_completions
  for each row execute function core.freeze_organization_id();

-- ── what is missing, read-only ─────────────────────────────────────────────

create or replace function projects.phase_readiness(p_project_id uuid, p_phase int)
returns table (
  -- 'ready' | 'not_ready' | 'completed' | 'not_found' | 'invalid_phase'
  outcome text,
  missing text[],
  facts   jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_org      uuid;
  v_missing  text[] := '{}';
  v_total    int;
  v_open     int;
  v_runs     int;
  v_failing  int;
  v_blockers int;
begin
  if p_phase not in (5, 6) then
    return query select 'invalid_phase'::text, '{}'::text[], '{}'::jsonb; return;
  end if;

  select p.organization_id into v_org
    from projects.projects p
   where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then
    return query select 'not_found'::text, '{}'::text[], '{}'::jsonb; return;
  end if;

  if exists (select 1 from projects.phase_completions c where c.project_id = p_project_id and c.phase = p_phase) then
    return query select 'completed'::text, '{}'::text[], '{}'::jsonb; return;
  end if;

  select count(*), count(*) filter (where t.status not in ('done', 'completed'))
    into v_total, v_open
    from projects.tasks t
   where t.project_id = p_project_id
     and (t.module_id is not null or t.feature_id is not null);

  if p_phase = 5 then
    if v_total = 0 then
      v_missing := array_append(v_missing, 'No development task exists yet (a task attached to a module or a feature).');
    elsif v_open > 0 then
      v_missing := array_append(v_missing, format('%s of %s development task%s not done yet.', v_open, v_total, case when v_total = 1 then ' is' else 's are' end));
    end if;
    return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                        v_missing,
                        jsonb_build_object('developmentTasks', v_total, 'openDevelopmentTasks', v_open);
    return;
  end if;

  -- Phase 6
  if not exists (select 1 from projects.phase_completions c where c.project_id = p_project_id and c.phase = 5) then
    v_missing := array_append(v_missing, 'Phase 5 is not complete yet.');
  end if;

  select count(*) into v_runs from qa.test_runs r where r.project_id = p_project_id;
  if v_runs = 0 then
    v_missing := array_append(v_missing, 'No test run has been recorded.');
  end if;

  select count(*) into v_failing
    from (
      select distinct on (r.suite) r.suite, r.failed
        from qa.test_runs r
       where r.project_id = p_project_id
       order by r.suite, r.executed_at desc, r.created_at desc
    ) latest
   where latest.failed > 0;
  if v_failing > 0 then
    v_missing := array_append(v_missing, format('The latest run of %s suite%s has failures.', v_failing, case when v_failing = 1 then '' else 's' end));
  end if;

  select count(*) into v_blockers
    from qa.defects d
   where d.project_id = p_project_id and d.status = 'open' and d.severity in ('blocker', 'major');
  if v_blockers > 0 then
    v_missing := array_append(v_missing, format('%s blocker or major defect%s still open.', v_blockers, case when v_blockers = 1 then ' is' else 's are' end));
  end if;

  return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                      v_missing,
                      jsonb_build_object('testRuns', v_runs, 'suitesWithFailures', v_failing, 'openBlockingDefects', v_blockers);
end;
$$;

comment on function projects.phase_readiness(uuid, int) is
  'Q-PH56: what is still missing before Phase 5 (development) or Phase 6 (testing) can be completed, read from tasks, test runs and defects. Read-only; security invoker, so the caller''s own row security applies.';

revoke all on function projects.phase_readiness(uuid, int) from public, anon;
grant execute on function projects.phase_readiness(uuid, int) to authenticated, service_role;

-- ── the door ───────────────────────────────────────────────────────────────

create or replace function projects.complete_phase(p_project_id uuid, p_phase int)
returns table (
  -- 'completed' | 'already_completed' | 'not_ready'
  -- refusals: 'no_actor' | 'forbidden' | 'not_found' | 'invalid_phase'
  outcome text,
  missing text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_org     uuid;
  v_project projects.projects;
  v_read    record;
  v_id      uuid;
begin
  if v_actor is null and not v_service then
    return query select 'no_actor'::text, '{}'::text[]; return;
  end if;
  if p_phase not in (5, 6) then
    return query select 'invalid_phase'::text, '{}'::text[]; return;
  end if;

  -- The project row is the lock: two completers serialise here, and the second
  -- finds the first one's fact.
  select * into v_project from projects.projects p where p.id = p_project_id and p.deleted_at is null for update;
  if v_project.id is null then
    return query select 'not_found'::text, '{}'::text[]; return;
  end if;

  if v_actor is not null then
    v_org := (select core.current_organization_id());
    -- project.write: owner, ops admin, delivery lead (primary or secondary role).
    if v_project.organization_id is distinct from v_org
       or not (coalesce((select core.is_admin()), false) or coalesce((select core.holds_role('delivery_lead')), false)) then
      return query select 'forbidden'::text, '{}'::text[]; return;
    end if;
  end if;

  select * into v_read from projects.phase_readiness(p_project_id, p_phase);
  if v_read.outcome = 'completed' then
    return query select 'already_completed'::text, '{}'::text[]; return;
  end if;
  if v_read.outcome <> 'ready' then
    return query select 'not_ready'::text, coalesce(v_read.missing, '{}'::text[]); return;
  end if;

  insert into projects.phase_completions (organization_id, project_id, phase, completed_by, basis)
  values (v_project.organization_id, p_project_id, p_phase, v_actor, v_read.facts)
  returning id into v_id;

  perform core.record_audit(
    v_project.organization_id,
    case p_phase when 5 then 'project.phase_five_completed' else 'project.phase_six_completed' end,
    'project', p_project_id, null,
    jsonb_build_object('projectId', p_project_id, 'phase', p_phase, 'basis', v_read.facts)
  );

  perform core.emit_event(
    v_project.organization_id,
    case p_phase when 5 then 'project.phase_five_completed' else 'project.phase_six_completed' end,
    'project', p_project_id,
    jsonb_build_object('projectId', p_project_id, 'phaseCompletionId', v_id, 'phase', p_phase)
  );

  return query select 'completed'::text, '{}'::text[];
end;
$$;

comment on function projects.complete_phase(uuid, int) is
  'Q-PH56: closes Phase 5 or Phase 6 once Development / QA data says it is done, records the evidence, audits it and emits the event that raises M3 / M4 and the PM message - the same shape as projects.complete_phase_four. Owner, ops admin, delivery lead, or the service role.';

revoke all on function projects.complete_phase(uuid, int) from public, anon;
grant execute on function projects.complete_phase(uuid, int) to authenticated, service_role;

notify pgrst, 'reload schema';
