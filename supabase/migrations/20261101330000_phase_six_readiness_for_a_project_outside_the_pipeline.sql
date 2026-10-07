-- CI (verify-r1-round3): Phase 6 readiness was rewritten for the QA pipeline (intake, Master Test Plan, release candidate, hard gates). A project that
-- never entered that pipeline (no phase_five or phase_six workspace) keeps the rule it always had: a test run exists, the latest run of every suite is clean, and no
-- blocker or major defect is unverified (M3 payment gates the QA pipeline's Phase 6, not this one). A pipeline project is exactly as strict as before.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('projects.phase_readiness(uuid,integer)'::regprocedure);
  n := replace(d, '  -- Phase 6 (P601 §40): Phase6Completed needs',
'  if p_phase = 6 and not exists (select 1 from projects.phase_six ps0 where ps0.project_id = p_project_id)
     and not exists (select 1 from projects.phase_five pf0 where pf0.project_id = p_project_id) then
    if not exists (select 1 from projects.phase_completions c where c.project_id = p_project_id and c.phase = 5) then
      v_missing := array_append(v_missing, ''Phase 5 is not complete yet.'');
    end if;
    select count(*) into v_runs from qa.test_runs r where r.project_id = p_project_id;
    if v_runs = 0 then
      v_missing := array_append(v_missing, ''No test run has been recorded.'');
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
      v_missing := array_append(v_missing, format(''The latest run of %s suite%s has failures.'', v_failing, case when v_failing = 1 then '''' else ''s'' end));
    end if;
    select count(*) into v_blockers
      from qa.defects d
     where d.project_id = p_project_id and d.status in (''open'', ''fixed'', ''needs_evidence'', ''not_reproduced'') and d.severity in (''blocker'', ''major'');
    if v_blockers > 0 then
      v_missing := array_append(v_missing, format(''%s blocker or major defect%s not verified fixed.'', v_blockers, case when v_blockers = 1 then '' is'' else ''s are'' end));
    end if;
    return query select case when cardinality(v_missing) = 0 then ''ready'' else ''not_ready'' end::text,
                        v_missing,
                        jsonb_build_object(''testRuns'', v_runs, ''suitesWithFailures'', v_failing, ''openBlockingDefects'', v_blockers);
    return;
  end if;

  -- Phase 6 (P601 §40): Phase6Completed needs');
  if n = d then raise exception 'phase_readiness: expected text not found'; end if;
  execute n;
end $m$;
notify pgrst, 'reload schema';
