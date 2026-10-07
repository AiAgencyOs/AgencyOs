-- Second round of the independent SQL review (items 6, 7, 9, 11, 12). Each edit rewrites the LIVE definition and refuses to continue if the text
-- it expects is not there, so a silent no-op cannot pass.
--  6. QA and Admin approval of a build were not bound to a commit: swapping commit_ref after approval kept the approvals. Now a changed commit resets both.
--  7. A reviewer who recorded "I changed the code" could record a second "independent" review. Now that reviewer never counts as independent on that commit.
--  9. A person could ingest an all-passed test report with no evidence. Now evidence (https) is required of everyone.
-- 11. anon has no business reading internal Phase 5/6 tables, whatever the default privileges say.
-- 12. A portal client of the same organization could ask whether the M3/M4 payment or the Phase 7 candidate was verified. Staff only now.

create or replace function projects.freeze_build_lineage()
returns trigger language plpgsql set search_path = '' as $$
declare v_status text;
begin
  select d.status into v_status from projects.deliverables d where d.id = new.deliverable_id;
  if v_status in ('in_review', 'approved', 'superseded')
     and (new.commit_ref is distinct from old.commit_ref
          or new.build_number is distinct from old.build_number
          or new.target_env is distinct from old.target_env
          or new.environment_fingerprint is distinct from old.environment_fingerprint) then
    raise exception 'a build that has been submitted keeps its commit, number and environment: raise a new build'
      using errcode = 'restrict_violation';
  end if;
  -- the verdicts were about THAT commit: a different commit is unreviewed and unapproved again
  if old.commit_ref is not null and new.commit_ref is distinct from old.commit_ref then
    if new.qa_status is not distinct from old.qa_status then new.qa_status := 'not_reviewed'; new.qa_decided_at := null; new.qa_decided_by := null; end if;
    if new.admin_status is not distinct from old.admin_status then new.admin_status := 'pending'; new.admin_decided_at := null; new.admin_decided_by := null; end if;
  end if;
  return new;
end $$;

do $m$
declare d text; n text;
begin
  -- 7
  d := pg_get_functiondef('projects.build_review_status(uuid)'::regprocedure);
  n := replace(d, 'and r.reviewer_changed_code = false and r.reviewer_id is not null;',
    'and r.reviewer_changed_code = false and r.reviewer_id is not null
       and not exists (select 1 from projects.code_reviews c2 where c2.deliverable_id = p_deliverable_id and c2.commit_ref = v_commit and c2.reviewer_id = r.reviewer_id and c2.reviewer_changed_code);');
  if n = d then raise exception 'build_review_status: expected text not found'; end if;
  execute n;
  -- 9
  d := pg_get_functiondef('qa.ingest_test_report(uuid,text,jsonb,text)'::regprocedure);
  n := replace(d, 'if v_actor is null and (p_evidence_url is null', 'if (p_evidence_url is null');
  if n = d then raise exception 'ingest_test_report: expected text not found'; end if;
  execute n;
  -- 12
  foreach n in array array['projects.m3_verified_paid(uuid)', 'projects.m4_verified_paid(uuid)'] loop
    d := pg_get_functiondef(n::regprocedure);
    if replace(d, '(v_actor is null or v_org is distinct', '(v_actor is null or not coalesce((select core.is_internal()), false) or v_org is distinct') = d then
      raise exception '%: expected text not found', n;
    end if;
    execute replace(d, '(v_actor is null or v_org is distinct', '(v_actor is null or not coalesce((select core.is_internal()), false) or v_org is distinct');
  end loop;
  d := pg_get_functiondef('projects.phase_seven_candidate_current(uuid)'::regprocedure);
  n := replace(d, 'or c.organization_id = (select core.current_organization_id())', 'or (c.organization_id = (select core.current_organization_id()) and coalesce((select core.is_internal()), false))');
  if n = d then raise exception 'phase_seven_candidate_current: expected text not found'; end if;
  execute n;
end $m$;

-- 11
do $m$
declare t record;
begin
  for t in select * from (values
    ('projects','phase_five'),('projects','development_baselines'),('projects','code_reviews'),('projects','build_feedback'),('projects','integration_connections'),
    ('projects','phase_five_agent_state'),('projects','phase_five_handoffs'),('projects','development_plans'),('projects','build_runs'),('projects','task_test_evidence'),
    ('projects','routing_decisions'),('projects','technical_documents'),('qa','flaky_tests'),
    ('projects','phase_six'),('projects','qa_intakes'),('projects','phase_six_handoffs'),('qa','master_test_plans'),('qa','risk_items'),('qa','phase6_cases'),
    ('qa','phase6_result_history'),('qa','release_candidates'),('qa','category_results'),('qa','category_result_history'),('qa','readiness_assessments'),
    ('qa','release_exceptions'),('qa','admin_qa_reviews'),('qa','qa_jobs'),('qa','qa_clarifications')) v(s, n) loop
    if to_regclass(t.s || '.' || t.n) is not null then
      execute format('revoke all on %I.%I from public, anon', t.s, t.n);
    end if;
  end loop;
end $m$;

notify pgrst, 'reload schema';
