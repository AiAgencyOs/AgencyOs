-- Review item 8 (the part with one right answer): requirement coverage is measured against the baseline's scope version. With no baseline that
-- query returned no rows, so a plan approved with ZERO requirement coverage. Now it is a problem.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('qa.plan_problems(uuid)'::regprocedure);
  n := replace(d, '  -- every included requirement (scope item of the baseline''s scope version) has a case',
'  if v_base.id is null then return query select ''There is no locked development baseline, so requirement coverage cannot be measured.''::text; end if;
  -- every included requirement (scope item of the baseline''s scope version) has a case');
  if n = d then raise exception 'plan_problems: expected text not found'; end if;
  execute n;
end $m$;
notify pgrst, 'reload schema';
