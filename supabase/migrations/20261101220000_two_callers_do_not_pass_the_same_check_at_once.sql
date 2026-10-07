-- Review item 10: check-then-act races. Each door now takes the lock the check depends on BEFORE it checks.
--  * start_task: the path-conflict check read other tasks while locking only its own row, so two tasks on the same files could both start.
--    It now locks the project row first (all starts in a project are serialized).
--  * qa.hand_off_defect: two callers could both pass "not handed off yet". It now locks the defect row.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('projects.start_task(uuid)'::regprocedure);
  n := replace(d, '  select * into v_task from projects.tasks t where t.id = p_task_id for update;',
'  select t.project_id into v_base from projects.tasks t where t.id = p_task_id;
  if v_base is not null then perform 1 from projects.projects p where p.id = v_base for update; end if;
  v_base := null;
  select * into v_task from projects.tasks t where t.id = p_task_id for update;');
  if n = d then raise exception 'start_task: expected text not found'; end if;
  execute n;

  select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname = 'hand_off_defect' and p.pronamespace = 'qa'::regnamespace;
  n := replace(d, 'select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org;', 'select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org for update;');
  if n = d then raise exception 'hand_off_defect: expected text not found'; end if;
  execute n;
end $m$;
notify pgrst, 'reload schema';
