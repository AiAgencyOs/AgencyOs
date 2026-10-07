-- PM5 spec: a derived Phase 5 state (what the project is WAITING for, never a stored flag that can drift) and the review package the PM prepares
-- before the Admin decides on an exact build. Both are reads over facts that already have doors; neither writes anything.

create or replace function projects.pm_phase_five_state(p_project_id uuid)
returns table (state text, next_gate text, blockers text[])
language plpgsql stable set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_p5 projects.phase_five;
  v_b record;
  v_blockers text[] := '{}';
  v_n int;
begin
  if not coalesce((select core.is_internal()), false) then return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return; end if;
  select * into v_p5 from projects.phase_five f where f.project_id = p_project_id;
  if v_p5.id is null then return query select 'NOT_STARTED'::text, 'Phase 4 complete and M2 verified paid'::text, v_blockers; return; end if;

  select count(*) into v_n from qa.blocking_defects(p_project_id);
  if v_n > 0 then v_blockers := array_append(v_blockers, v_n || ' open blocker defect(s)'); end if;

  if v_p5.state = 'completed' then
    if projects.m3_verified_paid(p_project_id) then return query select 'READY_FOR_PHASE6'::text, 'Phase 6 may start'::text, v_blockers; return; end if;
    return query select 'WAITING_M3'::text, 'An Admin verifies the M3 payment (a client saying paid, a proof or a match does not open Phase 6)'::text, v_blockers; return;
  end if;

  if exists (select 1 from projects.build_feedback f where f.project_id = p_project_id and f.state = 'clarification_needed') then
    return query select 'WAITING_CLARIFICATION'::text, 'The client answers the open clarification'::text, v_blockers; return;
  end if;

  -- the newest build that is not superseded decides what we are waiting for
  select d.id, d.status, dd.qa_status, dd.admin_status into v_b
    from projects.deliverables d left join projects.deliverable_details dd on dd.deliverable_id = d.id
   where d.project_id = p_project_id and d.kind = 'build' and d.status <> 'superseded'
   order by d.version desc limit 1;
  if v_b.id is null then
    if exists (select 1 from projects.tasks t where t.project_id = p_project_id and t.status <> 'todo') then
      return query select 'DEVELOPMENT_ACTIVE'::text, 'A development build for QA'::text, v_blockers; return;
    end if;
    return query select 'READY_TO_START'::text, 'An approved development plan and a started task'::text, v_blockers; return;
  end if;
  if v_b.status = 'approved' then
    return query select 'DEVELOPMENT_ACTIVE'::text, 'Complete Phase 5 (every task done, M2 verified paid)'::text, v_blockers; return;
  end if;
  if v_b.status = 'in_review' then
    return query select 'WAITING_CLIENT_REVIEW'::text, 'The client tests the shared build and decides'::text, v_blockers; return;
  end if;
  if coalesce(v_b.qa_status, 'not_reviewed') <> 'passed' then
    return query select 'WAITING_DEV_QA'::text, 'QA passes this exact build'::text, v_blockers; return;
  end if;
  if coalesce(v_b.admin_status, 'pending') <> 'approved' then
    return query select 'WAITING_ADMIN'::text, 'An Admin approves this exact build'::text, v_blockers; return;
  end if;
  return query select 'DEVELOPMENT_ACTIVE'::text, 'Share the approved build with the client'::text, v_blockers; return;
end $$;
revoke all on function projects.pm_phase_five_state(uuid) from public, anon;
grant execute on function projects.pm_phase_five_state(uuid) to authenticated, service_role;

-- the checklist the PM hands the Admin for ONE exact build: each line says what is true, never what is hoped
create or replace function projects.build_review_package(p_deliverable_id uuid)
returns table (item text, ok boolean, detail text)
language plpgsql stable set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_d projects.deliverables;
  v_commit text;
  v_review record;
  v_gate record;
  v_n int;
begin
  if not coalesce((select core.is_internal()), false) then return; end if;
  select * into v_d from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org and d.kind = 'build';
  if v_d.id is null then return; end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_d.id;
  return query select 'Exact commit'::text, nullif(btrim(coalesce(v_commit, '')), '') is not null, coalesce(v_commit, 'no commit is recorded');
  return query select 'Successful build run on this commit with an artifact hash'::text,
    exists (select 1 from projects.build_runs br where br.deliverable_id = v_d.id and br.commit_ref = v_commit and br.status = 'succeeded' and br.artifact_sha256 is not null), 'projects.build_runs'::text;
  select * into v_review from projects.build_review_status(v_d.id);
  return query select 'Independent code review passed on this commit'::text, v_review.verdict = 'passed', coalesce(v_review.verdict, 'missing');
  select * into v_gate from projects.prototype_send_gate(v_d.id);
  return query select 'QA passed this build'::text, coalesce(v_gate.qa_passed, false), coalesce(v_gate.qa_source, 'not reviewed');
  select count(*) into v_n from qa.blocking_defects(v_d.project_id);
  return query select 'No open blocker or major defect'::text, v_n = 0, v_n || ' open';
  select count(*) into v_n from projects.task_test_gaps(v_d.project_id);
  return query select 'Every planned task has test evidence'::text, v_n = 0, v_n || ' task(s) without evidence';
  return query select 'Locked baseline (scope, UI, prototype)'::text,
    exists (select 1 from projects.development_baselines b where b.project_id = v_d.project_id and b.scope_version_id is not null), 'projects.development_baselines';
  return query select 'Integrations the build depends on are verified or not required'::text,
    not exists (select 1 from projects.integration_connections c where c.project_id = v_d.project_id and not c.is_mock and c.health in ('degraded', 'blocked')),
    'a degraded or blocked integration is listed on the panel';
end $$;
revoke all on function projects.build_review_package(uuid) from public, anon;
grant execute on function projects.build_review_package(uuid) to authenticated, service_role;
notify pgrst, 'reload schema';
