-- ═══════════════════════════════════════════════════════════════════════════
-- The nine Phase 6 QA specialists PROPOSE; an independent person decides.
--
-- STUB-PROVEN ONLY: nothing here has run on a real model, a browser, a device, a load tool or a security scanner. What exists is the record a specialist
-- run would leave and the doors around it:
--   * qa.specialist_requests  - who asked a specialist to look at a QA job (or a release candidate), and for which agent. The requester is the person
--                               who may NOT accept what comes back (creator != validator, enforced in the database).
--   * qa.specialist_findings  - a PROPOSED case result / category observation / gate summary / exception request. Status is 'proposed' and only that;
--                               the row is append-only. A proposal is never a result: the case row is not touched.
--   * qa.specialist_finding_decisions - the one decision a person makes on a finding (accepted or rejected); append-only, one per finding, so a
--                               rejection is final.
--   * qa.record_specialist_finding   - service-role only. Refuses: another organization, an agent that is not the job's category agent, a commit that
--                               is not the plan's, a 'pass' with no evidence, a 'pass' on a critical case, a pass/fail claim about an environment the job
--                               never had (held job, or an environment the plan does not list), a gate summary from anyone but release_readiness, a
--                               secret value, and raw exploit detail in a security finding.
--   * qa.request_specialist_run      - a person with delivery rights asks; records who.
--   * qa.accept_specialist_finding / qa.reject_specialist_finding - an INDEPENDENT person. Acceptance calls the EXISTING qa.record_case_result as the
--                               same caller (auth.uid() and the organization claim are request settings, so the nested SECURITY DEFINER call sees the
--                               acceptor, and that door's own rules - the exact commit, builder != recorder, evidence for a pass - apply unchanged).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.specialist_requests (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  agent_key         text not null check (agent_key ~ '^[a-z_]+$' and agent_key in ('functional_test', 'ui_journey_test', 'api_integration_test', 'database_test', 'security_test', 'performance_test', 'compatibility_test', 'regression_test', 'release_readiness')),
  job_id            uuid references qa.qa_jobs(id) on delete cascade,
  candidate_id      uuid references qa.release_candidates(id) on delete cascade,
  requested_by      uuid not null references core.users(id) on delete restrict,
  created_at        timestamptz not null default now(),
  -- a request is about exactly one thing: a scheduled QA job, or (release_readiness only) a release candidate
  check ((job_id is null) <> (candidate_id is null)),
  check ((agent_key = 'release_readiness') = (candidate_id is not null))
);

create table if not exists qa.specialist_findings (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  request_id         uuid not null references qa.specialist_requests(id) on delete cascade,
  job_id             uuid references qa.qa_jobs(id) on delete cascade,
  candidate_id       uuid references qa.release_candidates(id) on delete cascade,
  plan_id            uuid not null references qa.master_test_plans(id) on delete cascade,
  case_id            uuid references qa.phase6_cases(id) on delete cascade,
  category           text not null check (category in ('functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression', 'release')),
  agent_key          text not null check (agent_key ~ '^[a-z_]+$' and agent_key in ('functional_test', 'ui_journey_test', 'api_integration_test', 'database_test', 'security_test', 'performance_test', 'compatibility_test', 'regression_test', 'release_readiness')),
  kind               text not null check (kind in ('case_result', 'category_observation', 'gate_summary', 'exception_request')),
  proposed_result    text check (proposed_result in ('pass', 'fail', 'blocked', 'not_tested')),
  reason             text not null check (length(btrim(reason)) > 0 and length(reason) <= 2000),
  detail             text check (detail is null or length(detail) <= 4000),
  evidence_refs      text[] not null default '{}' check (cardinality(evidence_refs) <= 20),
  commit_ref         text not null check (length(btrim(commit_ref)) > 0),
  claimed_environment text check (claimed_environment is null or length(btrim(claimed_environment)) > 0),
  requested_by       uuid not null references core.users(id) on delete restrict,
  status             text not null default 'proposed' check (status = 'proposed'),
  created_at         timestamptz not null default now(),
  check ((job_id is null) <> (candidate_id is null)),
  check ((agent_key = 'release_readiness') = (candidate_id is not null)),
  check ((kind = 'case_result') = (case_id is not null)),
  check ((kind in ('case_result', 'category_observation')) = (proposed_result is not null)),
  check (kind not in ('gate_summary', 'exception_request') or agent_key = 'release_readiness'),
  check (agent_key <> 'release_readiness' or kind in ('gate_summary', 'exception_request')),
  -- a pass without evidence is not a proposal at all
  check (proposed_result is distinct from 'pass' or cardinality(evidence_refs) > 0)
);
create unique index if not exists specialist_findings_once on qa.specialist_findings (request_id, kind, coalesce(case_id::text, md5(reason)));
create index if not exists specialist_findings_job_idx on qa.specialist_findings (project_id, created_at desc);

create table if not exists qa.specialist_finding_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  finding_id       uuid not null unique references qa.specialist_findings(id) on delete cascade,
  decision         text not null check (decision in ('accepted', 'rejected')),
  decided_by       uuid not null references core.users(id) on delete restrict,
  note             text,
  recorded_outcome text not null,
  decided_at       timestamptz not null default now(),
  check (decision = 'accepted' or (note is not null and length(btrim(note)) > 0))
);

do $$
declare r record;
begin
  for r in select * from (values
    ('specialist_requests', 'project_id', 'projects.projects'), ('specialist_requests', 'job_id', 'qa.qa_jobs'), ('specialist_requests', 'candidate_id', 'qa.release_candidates'),
    ('specialist_findings', 'project_id', 'projects.projects'), ('specialist_findings', 'request_id', 'qa.specialist_requests'), ('specialist_findings', 'job_id', 'qa.qa_jobs'),
    ('specialist_findings', 'candidate_id', 'qa.release_candidates'), ('specialist_findings', 'plan_id', 'qa.master_test_plans'), ('specialist_findings', 'case_id', 'qa.phase6_cases'),
    ('specialist_finding_decisions', 'finding_id', 'qa.specialist_findings')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on qa.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on qa.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['specialist_requests', 'specialist_findings', 'specialist_finding_decisions']) as tbl loop
    execute format('alter table qa.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on qa.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on qa.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('revoke all on qa.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on qa.%I from authenticated', r.tbl);
    execute format('grant select on qa.%I to authenticated', r.tbl);
    execute format('grant all on qa.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on qa.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on qa.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
    -- a proposal, a request and a decision are history: never edited, never deleted
    execute format('drop trigger if exists %I on qa.%I', r.tbl || '_append_only', r.tbl);
    execute format('create trigger %I before update or delete on qa.%I for each row execute function qa.release_history_append_only()', r.tbl || '_append_only', r.tbl);
  end loop;
end $$;

-- ── a person with delivery rights asks a specialist to look at a scheduled QA job (or release_readiness at a candidate) ──
create or replace function qa.request_specialist_run(p_job_id uuid default null, p_candidate_id uuid default null)
returns table (outcome text, request_id uuid, agent_key text, project_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_job qa.qa_jobs; v_cand qa.release_candidates; v_agent text; v_project uuid; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid, null::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid, null::text, null::uuid; return; end if;
  if (p_job_id is null) = (p_candidate_id is null) then return query select 'name_one_subject'::text, null::uuid, null::text, null::uuid; return; end if;
  if p_job_id is not null then
    select * into v_job from qa.qa_jobs j where j.id = p_job_id and j.organization_id = v_org;
    if v_job.id is null then return query select 'not_found'::text, null::uuid, null::text, null::uuid; return; end if;
    if v_job.status = 'cancelled' then return query select 'job_cancelled'::text, null::uuid, null::text, null::uuid; return; end if;
    v_agent := v_job.specialist; v_project := v_job.project_id;
  else
    select * into v_cand from qa.release_candidates c where c.id = p_candidate_id and c.organization_id = v_org;
    if v_cand.id is null then return query select 'not_found'::text, null::uuid, null::text, null::uuid; return; end if;
    if v_cand.status in ('stale', 'superseded') then return query select 'candidate_not_current'::text, null::uuid, null::text, null::uuid; return; end if;
    v_agent := 'release_readiness'; v_project := v_cand.project_id;
  end if;
  insert into qa.specialist_requests (organization_id, project_id, agent_key, job_id, candidate_id, requested_by)
  values (v_org, v_project, v_agent, p_job_id, p_candidate_id, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'qa.specialist_requested', 'specialist_request', v_id, null, jsonb_build_object('agent', v_agent, 'jobId', p_job_id, 'candidateId', p_candidate_id));
  return query select 'requested'::text, v_id, v_agent, v_project;
end $$;
revoke all on function qa.request_specialist_run(uuid, uuid) from public, anon;
grant execute on function qa.request_specialist_run(uuid, uuid) to authenticated;

-- ── the ONE door a specialist run writes through (service role only) ──
create or replace function qa.record_specialist_finding(
  p_request_id uuid, p_organization_id uuid, p_agent_key text, p_kind text, p_case_id uuid, p_proposed_result text, p_reason text,
  p_detail text, p_evidence_refs text[], p_commit_ref text, p_claimed_environment text default null)
returns table (outcome text, finding_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_req qa.specialist_requests; v_job qa.qa_jobs; v_cand qa.release_candidates; v_plan qa.master_test_plans; v_case qa.phase6_cases;
  v_category text; v_plan_id uuid; v_id uuid; v_text text; v_refs text[] := coalesce(p_evidence_refs, '{}');
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_req from qa.specialist_requests r where r.id = p_request_id;
  if v_req.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  -- the organization is the JOB's (the runner's), never one a payload names
  if v_req.organization_id is distinct from p_organization_id then return query select 'wrong_organization'::text, null::uuid; return; end if;
  if p_agent_key is distinct from v_req.agent_key then return query select 'wrong_agent'::text, null::uuid; return; end if;
  if p_kind not in ('case_result', 'category_observation', 'gate_summary', 'exception_request') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_proposed_result is not null and p_proposed_result not in ('pass', 'fail', 'blocked', 'not_tested') then return query select 'bad_result'::text, null::uuid; return; end if;
  if (p_kind in ('case_result', 'category_observation')) <> (p_proposed_result is not null) then return query select 'bad_result'::text, null::uuid; return; end if;
  -- only release_readiness writes summaries and exception requests; it writes nothing else
  if (p_kind in ('gate_summary', 'exception_request')) <> (v_req.agent_key = 'release_readiness') then return query select 'kind_not_for_this_agent'::text, null::uuid; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 2000 or length(coalesce(p_detail, '')) > 4000 or cardinality(v_refs) > 20 or p_commit_ref is null or length(btrim(p_commit_ref)) = 0 then
    return query select 'bad_input'::text, null::uuid; return;
  end if;

  -- no secret value anywhere in the text
  v_text := coalesce(p_reason, '') || E'\n' || coalesce(p_detail, '') || E'\n' || array_to_string(v_refs, E'\n') || E'\n' || coalesce(p_claimed_environment, '');
  if v_text ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-.]{12,}'
     or v_text ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})' then
    return query select 'secret_in_text'::text, null::uuid; return;
  end if;
  -- a security finding names the weakness and the fix, never the exploit
  if v_req.agent_key = 'security_test' and v_text ~* '(<script|union\s+select|\mor\s+1\s*=\s*1|\.\./\.\./|;\s*drop\s+table|\$\{jndi:|javascript:|onerror\s*=)' then
    return query select 'exploit_detail_refused'::text, null::uuid; return;
  end if;

  if v_req.job_id is not null then
    select * into v_job from qa.qa_jobs j where j.id = v_req.job_id;
    if v_job.id is null or v_job.organization_id is distinct from p_organization_id then return query select 'wrong_organization'::text, null::uuid; return; end if;
    if v_job.specialist is distinct from p_agent_key then return query select 'wrong_agent'::text, null::uuid; return; end if;
    if v_job.status = 'cancelled' then return query select 'job_cancelled'::text, null::uuid; return; end if;
    v_plan_id := v_job.plan_id; v_category := v_job.category;
  else
    select * into v_cand from qa.release_candidates c where c.id = v_req.candidate_id;
    if v_cand.id is null or v_cand.organization_id is distinct from p_organization_id then return query select 'wrong_organization'::text, null::uuid; return; end if;
    if v_cand.status in ('stale', 'superseded') then return query select 'candidate_not_current'::text, null::uuid; return; end if;
    v_plan_id := v_cand.plan_id; v_category := 'release';
  end if;
  select * into v_plan from qa.master_test_plans p where p.id = v_plan_id;
  if v_plan.id is null or v_plan.organization_id is distinct from p_organization_id then return query select 'wrong_organization'::text, null::uuid; return; end if;
  if v_plan.status <> 'approved' then return query select 'plan_not_approved'::text, null::uuid; return; end if;
  -- evidence about any other commit is not evidence about this one
  if p_commit_ref is distinct from v_plan.commit_ref or (v_cand.id is not null and p_commit_ref is distinct from v_cand.commit_ref) then
    return query select 'wrong_commit'::text, null::uuid; return;
  end if;

  if p_kind = 'case_result' then
    select * into v_case from qa.phase6_cases c where c.id = p_case_id;
    if v_case.id is null or v_case.organization_id is distinct from p_organization_id then return query select 'case_not_found'::text, null::uuid; return; end if;
    if v_case.plan_id is distinct from v_plan_id or v_case.category is distinct from v_category then return query select 'case_not_in_job'::text, null::uuid; return; end if;
  elsif p_case_id is not null then
    return query select 'bad_input'::text, null::uuid; return;
  end if;

  if p_proposed_result = 'pass' then
    if cardinality(v_refs) = 0 or exists (select 1 from unnest(v_refs) e where length(btrim(e)) = 0) then return query select 'evidence_required'::text, null::uuid; return; end if;
    -- a critical case is passed by a person, never by a proposal
    if v_case.id is not null and v_case.priority = 'critical' then return query select 'critical_pass_is_a_persons'::text, null::uuid; return; end if;
  end if;

  -- a device / browser / load result needs the environment it claims; a job that is HELD never had one
  if p_proposed_result in ('pass', 'fail') and v_job.id is not null then
    if v_job.status = 'held' then return query select 'job_is_held'::text, null::uuid; return; end if;
    if v_category in ('ui_e2e', 'performance', 'compatibility') and (p_claimed_environment is null or length(btrim(p_claimed_environment)) = 0) then
      return query select 'environment_required'::text, null::uuid; return;
    end if;
    if p_claimed_environment is not null and not (p_claimed_environment = any (v_plan.environments)) then
      return query select 'environment_not_available'::text, null::uuid; return;
    end if;
  end if;

  insert into qa.specialist_findings (organization_id, project_id, request_id, job_id, candidate_id, plan_id, case_id, category, agent_key, kind, proposed_result, reason, detail, evidence_refs, commit_ref, claimed_environment, requested_by)
  values (v_req.organization_id, v_req.project_id, v_req.id, v_req.job_id, v_req.candidate_id, v_plan_id, p_case_id, v_category, p_agent_key, p_kind, p_proposed_result, btrim(p_reason), p_detail, v_refs, p_commit_ref, nullif(btrim(coalesce(p_claimed_environment, '')), ''), v_req.requested_by)
  on conflict (request_id, kind, (coalesce(case_id::text, md5(reason)))) do nothing returning id into v_id;
  if v_id is null then return query select 'already_proposed'::text, null::uuid; return; end if;
  return query select 'proposed'::text, v_id;
end $$;
revoke all on function qa.record_specialist_finding(uuid, uuid, text, text, uuid, text, text, text, text[], text, text) from public, anon, authenticated;
grant execute on function qa.record_specialist_finding(uuid, uuid, text, text, uuid, text, text, text, text[], text, text) to service_role;

-- ── an INDEPENDENT person turns an accepted proposal into a real result, through the existing result door ──
create or replace function qa.accept_specialist_finding(p_finding_id uuid, p_note text default null)
returns table (outcome text, case_outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_f qa.specialist_findings; v_case qa.phase6_cases; v_plan qa.master_test_plans; v_out text := 'accepted_as_note'; v_defect uuid; v_ref text;
begin
  if v_actor is null then return query select 'no_actor'::text, null::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::text; return; end if;
  select * into v_f from qa.specialist_findings f where f.id = p_finding_id and f.organization_id = v_org for update;
  if v_f.id is null then return query select 'not_found'::text, null::text; return; end if;
  if exists (select 1 from qa.specialist_finding_decisions d where d.finding_id = v_f.id) then return query select 'already_decided'::text, null::text; return; end if;
  -- creator != validator: whoever asked for the work does not accept it
  if v_f.requested_by = v_actor then return query select 'self_acceptance'::text, null::text; return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = v_f.plan_id;
  if v_plan.status <> 'approved' or v_plan.commit_ref is distinct from v_f.commit_ref then return query select 'stale_finding'::text, null::text; return; end if;

  if v_f.kind = 'case_result' and v_f.proposed_result in ('pass', 'fail', 'blocked') then
    select * into v_case from qa.phase6_cases c where c.id = v_f.case_id;
    if v_f.proposed_result = 'pass' and v_case.priority = 'critical' then return query select 'critical_pass_is_a_persons'::text, null::text; return; end if;
    v_ref := nullif(btrim(array_to_string(v_f.evidence_refs, ' ')), '');
    -- the EXISTING door, as the same caller: its evidence, commit, independence and plan rules decide; a refusal is returned and nothing is decided
    select r.outcome, r.defect_id into v_out, v_defect from qa.record_case_result(v_f.case_id, v_f.proposed_result, v_ref, v_f.reason) r;
    if v_out is distinct from 'recorded' then return query select 'refused_by_result_door'::text, v_out; return; end if;
  elsif v_f.kind = 'case_result' then
    v_out := 'nothing_to_record';
  end if;

  insert into qa.specialist_finding_decisions (organization_id, finding_id, decision, decided_by, note, recorded_outcome)
  values (v_org, v_f.id, 'accepted', v_actor, nullif(btrim(coalesce(p_note, '')), ''), v_out);
  perform core.record_audit(v_org, 'qa.specialist_finding_accepted', 'specialist_finding', v_f.id, null, jsonb_build_object('agent', v_f.agent_key, 'kind', v_f.kind, 'result', v_f.proposed_result, 'recorded', v_out));
  return query select 'accepted'::text, v_out;
end $$;
revoke all on function qa.accept_specialist_finding(uuid, text) from public, anon;
grant execute on function qa.accept_specialist_finding(uuid, text) to authenticated;

create or replace function qa.reject_specialist_finding(p_finding_id uuid, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_f qa.specialist_findings;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 then return query select 'reason_required'::text; return; end if;
  select * into v_f from qa.specialist_findings f where f.id = p_finding_id and f.organization_id = v_org for update;
  if v_f.id is null then return query select 'not_found'::text; return; end if;
  if exists (select 1 from qa.specialist_finding_decisions d where d.finding_id = v_f.id) then return query select 'already_decided'::text; return; end if;
  -- a requester cannot bury an unwelcome finding either
  if v_f.requested_by = v_actor then return query select 'self_acceptance'::text; return; end if;
  insert into qa.specialist_finding_decisions (organization_id, finding_id, decision, decided_by, note, recorded_outcome)
  values (v_org, v_f.id, 'rejected', v_actor, btrim(p_note), 'rejected');
  perform core.record_audit(v_org, 'qa.specialist_finding_rejected', 'specialist_finding', v_f.id, null, jsonb_build_object('agent', v_f.agent_key, 'kind', v_f.kind));
  return query select 'rejected'::text;
end $$;
revoke all on function qa.reject_specialist_finding(uuid, text) from public, anon;
grant execute on function qa.reject_specialist_finding(uuid, text) to authenticated;

notify pgrst, 'reload schema';
