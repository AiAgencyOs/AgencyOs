-- ═══════════════════════════════════════════════════════════════════════════
-- Evidence needs a way in.
--
-- Same defect as scope_items and test_plan_items, one table further down the
-- same chain: `qa.test_runs` (20260821240000) carries a SELECT policy, two
-- triggers refusing an update or an end-user delete, and no INSERT policy or
-- door anywhere. `qa.release_gates`'s `critical_tests_pass` gate has read
-- `qa.test_runs` since the day both were written and has answered
-- `undecided` every single time, because nothing could ever put a row there
-- to read. The Admin Panel rebuild's Test Runs screen (SCR-046) is the first
-- caller either has had.
--
-- `can_write()` rather than `can_manage_delivery()`: Doc 14 §18 admits manual
-- testing explicitly, and recording what a manual run found is the same act
-- `projects.tasks` already lets a `member` do, not a delivery-management
-- decision. The CHECK constraints already on the table (`test_runs_counts_add_up`,
-- `test_runs_agent_evidence_is_external`) are not re-validated here — a
-- violating insert fails at the constraint, the same as any other write, and
-- this door only translates that into an outcome a caller can branch on.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function qa.record_test_run(
  p_deliverable_id uuid,
  p_suite          text,
  p_total          int,
  p_passed         int,
  p_failed         int,
  p_skipped        int default 0,
  p_evidence_url   text default null
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
      total, passed, failed, skipped, evidence_url, executed_by
    )
    values (
      v_org, v_project, p_deliverable_id, p_suite,
      p_total, p_passed, p_failed, coalesce(p_skipped, 0), p_evidence_url, v_actor
    )
    returning qa.test_runs.id into v_new;
  exception
    when check_violation then
      return query select 'bad_counts'::text, null::uuid; return;
  end;

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function qa.record_test_run(uuid, text, int, int, int, int, text) is
  'Records one test run as evidence against a build deliverable. can_write() (owner, ops_admin, delivery_lead, member) — Doc 14 section 18 admits manual testing, and this is that. bad_counts covers both test_runs_counts_add_up and an invalid suite/category the table''s own CHECK constraints would refuse; not_a_build covers what refuse_non_build_test_run would otherwise raise as an exception.';

revoke all on function qa.record_test_run(uuid, text, int, int, int, int, text) from public, anon;
grant execute on function qa.record_test_run(uuid, text, int, int, int, int, text) to authenticated;
