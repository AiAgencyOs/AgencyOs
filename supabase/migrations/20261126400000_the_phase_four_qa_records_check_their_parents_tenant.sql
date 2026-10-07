-- Integration: six foreign keys of the Phase 4 prototype-QA records pointed at another table of the same tenancy model without the parent-organisation guard
-- (core.unguarded_org_fks() listed them). Each gets the same enforce_parent_org trigger the other keys of these tables already have.
do $mig$
declare r record;
begin
  for r in select * from (values
    ('p4q_prototype_qa_runs', 'previous_run_id', 'projects.p4q_prototype_qa_runs'),
    ('p4q_prototype_defects', 'defect_id', 'qa.defects'),
    ('p4q_prototype_defects', 'reappears_defect_id', 'qa.defects'),
    ('p4q_prototype_defects', 'retest_run_id', 'projects.p4q_prototype_qa_runs'),
    ('p4q_prototype_feedback_classifications', 'change_request_id', 'projects.change_requests'),
    ('p4q_prototype_feedback_classifications', 'clarification_id', 'projects.clarification_requests')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)',
                   r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
end $mig$;
