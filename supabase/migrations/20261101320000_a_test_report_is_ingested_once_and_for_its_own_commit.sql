-- Test Automation spec (TA5-I19, TA5-T001): a repeated delivery of the same report must not make a second run, and a report that names a commit
-- is accepted only for the commit of the build it is ingested against (a report for an older commit says nothing about this code).
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('qa.ingest_test_report(uuid,text,jsonb,text)'::regprocedure);
  n := replace(d, '  if p_report is null or jsonb_typeof(p_report) <> ''object'' or jsonb_typeof(p_report->''tests'') <> ''array'' or jsonb_array_length(p_report->''tests'') = 0 then',
'  -- a replayed delivery answers with the run it already made
  select r.id, r.passed, r.failed into v_prev_run, v_prev_passed, v_prev_failed from qa.test_runs r
   where r.deliverable_id = v_row.id and r.suite = p_suite and r.evidence_url = p_evidence_url order by r.created_at limit 1;
  if v_prev_run is not null then return query select ''already_ingested''::text, v_prev_run, v_prev_passed, v_prev_failed, 0; return; end if;
  -- a report that names its commit is for THAT commit
  if p_report is not null and jsonb_typeof(p_report) = ''object'' and p_report ? ''commit'' and (p_report->>''commit'') is distinct from
       (select dd.commit_ref from projects.deliverable_details dd where dd.deliverable_id = v_row.id) then
    return query select ''stale_report''::text, null::uuid, 0, 0, 0; return;
  end if;

  if p_report is null or jsonb_typeof(p_report) <> ''object'' or jsonb_typeof(p_report->''tests'') <> ''array'' or jsonb_array_length(p_report->''tests'') = 0 then');
  if n = d then raise exception 'ingest_test_report: expected text not found'; end if;
  d := n;
  n := replace(d, '  v_run uuid;
  t record;', '  v_run uuid;
  v_prev_run uuid; v_prev_passed int; v_prev_failed int;
  t record;');
  if n = d then raise exception 'ingest_test_report: declare block not found'; end if;
  execute n;
end $m$;
notify pgrst, 'reload schema';
