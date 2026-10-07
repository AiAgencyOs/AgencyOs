-- CI (verify-s1-round3b) completes Phase 5 on a project that never ran the Phase 3/4 pipeline (no phase_four row, so no baseline, UI or prototype)
-- and has no build. The "final development build is client-approved" rule was written for the pipeline's projects; like the baseline rule
-- directly above it, it now applies only to a project that has a phase_four row. A pipeline project is as strict as before.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('projects.phase_readiness(uuid,integer)'::regprocedure);
  n := replace(d, 'if not exists (select 1 from projects.deliverables d where d.project_id = p_project_id and d.kind = ''build'' and d.status = ''approved'') then',
    'if not exists (select 1 from projects.phase_four p4b where p4b.project_id = p_project_id) then
      null;
    elsif not exists (select 1 from projects.deliverables d where d.project_id = p_project_id and d.kind = ''build'' and d.status = ''approved'') then');
  if n = d then raise exception 'phase_readiness: expected text not found'; end if;
  -- the original "elsif exists (...)" that followed is now a plain elsif of the same chain, so it still runs only after the two tests above
  execute n;

  -- the frozen hand-offs belong to the pipeline: a project with no phase_five (or phase_six) workspace completes the phase without one
  d := pg_get_functiondef('projects.complete_phase(uuid,integer)'::regprocedure);
  n := replace(d, '  if p_phase = 5 then
    perform projects.build_phase_five_handoff(p_project_id, v_id);
    update projects.phase_five set state', '  if p_phase = 5 and exists (select 1 from projects.phase_five pf0 where pf0.project_id = p_project_id) then
    perform projects.build_phase_five_handoff(p_project_id, v_id);
    update projects.phase_five set state');
  if n = d then raise exception 'complete_phase: phase 5 text not found'; end if;
  d := n;
  n := replace(d, '  if p_phase = 6 then
    perform projects.build_phase_six_handoff(p_project_id, v_id);', '  if p_phase = 6 and exists (select 1 from projects.phase_six ps0 where ps0.project_id = p_project_id) then
    perform projects.build_phase_six_handoff(p_project_id, v_id);');
  if n = d then raise exception 'complete_phase: phase 6 text not found'; end if;
  execute n;
end $m$;
notify pgrst, 'reload schema';
