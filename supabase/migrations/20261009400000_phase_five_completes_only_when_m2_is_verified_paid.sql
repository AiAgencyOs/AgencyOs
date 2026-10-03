-- ═══════════════════════════════════════════════════════════════════════════
-- R1-3 (owner, round 3b, 2026-10-01): "Completing Phase 5 requires the M2
-- invoice to be verified paid."
--
-- The basis is the verified one (finance/verified-basis.ts, PDF SCR-050): the
-- project's M2 invoice (the live invoice on the milestone at position 2) counts
-- only when `status = 'paid'` - which, since 20260813120015, follows
-- `verified_minor` and is set only by finance.verify_payment_submission - AND
-- `verified_minor >= total_minor`. An issued invoice, a recorded payment or a
-- proof upload is not enough.
--
--   * `projects.m2_verified_paid(project)`  security definer, returns only a
--     boolean (no invoice figure leaks to a role that cannot read invoices), and
--     answers false for a project outside the caller's organization.
--   * `projects.phase_readiness` lists 'M2 not verified paid' as missing for
--     Phase 5, with `m2VerifiedPaid` in its facts.
--   * `projects.complete_phase` already refuses on anything but 'ready' under
--     the project's row lock, so it now refuses with `not_ready` + that message.
--
-- A Phase 5 completion that already exists is untouched. Additive and
-- idempotent: applies twice.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.m2_verified_paid(p_project_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
begin
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return false; end if;
  -- Tenancy: a person answers only for their own organization.
  if not v_service and (v_actor is null or v_org is distinct from (select core.current_organization_id())) then
    return false;
  end if;
  return exists (
    select 1
      from projects.milestones m
      join finance.invoices i on i.milestone_id = m.id and i.status <> 'void'
     where m.project_id = p_project_id
       and m.position = 2
       and i.organization_id = v_org
       and i.status = 'paid'
       and i.verified_minor >= i.total_minor
  );
end;
$$;

comment on function projects.m2_verified_paid(uuid) is
  'R1-3: whether the project''s M2 invoice (milestone position 2) is verified paid - status paid and verified_minor covering the total. A boolean only, so the readiness read works for roles that cannot read invoices. False for another organization''s project.';

revoke all on function projects.m2_verified_paid(uuid) from public, anon;
grant execute on function projects.m2_verified_paid(uuid) to authenticated, service_role;

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
  v_m2       boolean;
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
    -- R1-3: the M2 invoice must be verified paid (the verified basis).
    v_m2 := projects.m2_verified_paid(p_project_id);
    if not v_m2 then
      v_missing := array_append(v_missing, 'M2 not verified paid');
    end if;
    return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                        v_missing,
                        jsonb_build_object('developmentTasks', v_total, 'openDevelopmentTasks', v_open, 'm2VerifiedPaid', v_m2);
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
  'Q-PH56 + R1-3: what is still missing before Phase 5 (development: every development task done AND the M2 invoice verified paid) or Phase 6 (testing) can be completed. Read-only; security invoker, so the caller''s own row security applies (the M2 answer comes from the boolean-only projects.m2_verified_paid).';

revoke all on function projects.phase_readiness(uuid, int) from public, anon;
grant execute on function projects.phase_readiness(uuid, int) to authenticated, service_role;

notify pgrst, 'reload schema';
