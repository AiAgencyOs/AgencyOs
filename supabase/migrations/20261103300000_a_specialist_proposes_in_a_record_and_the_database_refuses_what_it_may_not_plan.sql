-- The remaining development specialists (frontend, backend, database, mobile, integration, devops/build, security review, bug fix, refactor/
-- performance) PROPOSE; a person and QA decide. A proposal is a plan: which files it would touch, which tests it would write, the risks and the
-- evidence a result would have to carry. It is never code in a repository, never a test result, never an approval, so nothing here can count as
-- evidence of anything.
--
-- The ONE write path is projects.record_specialist_proposal (service role only). It refuses, in the database and not only in the application:
--   * a task that is not in the job's organization;
--   * an agent that is not the task's required_capability, or a task that was never routed to that agent (no handoff);
--   * a planned file outside the task's affected_paths (read from the TASK row, never from the caller), or a path that touches secrets or .env
--     (and migrations, for every agent but the database developer);
--   * a forbidden action in the text: deploy, merge to a protected branch, approve or verify its own work, change scope, verify a payment, a secret;
--   * a proposal that does not plan the evidence the routed envelope requires (read from the HANDOFF row);
--   * per-agent rules: a bug fix must cite a defect linked to the task, a security review proposes findings and never edits files, only the
--     mobile and refactor specialists may honestly say NOT_REQUIRED, and a detail key the agent has no business with is refused.

create table if not exists projects.specialist_proposals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  task_id         uuid not null references projects.tasks(id) on delete cascade,
  handoff_id      uuid not null references ai.handoffs(id) on delete cascade,
  agent_key       text not null check (agent_key ~ '^[a-z_]+$'),
  outcome         text not null default 'proposal' check (outcome in ('proposal', 'not_required')),
  plan_summary    text not null check (length(btrim(plan_summary)) > 0 and length(plan_summary) <= 4000),
  planned_files   text[] not null default '{}' check (cardinality(planned_files) <= 40),
  planned_tests   text[] not null default '{}' check (cardinality(planned_tests) <= 40),
  risks           text[] not null default '{}' check (cardinality(risks) <= 40),
  evidence_plan   text[] not null default '{}' check (cardinality(evidence_plan) <= 12),
  detail          jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 20000),
  status          text not null default 'proposed' check (status in ('proposed')),
  agent_run_id    uuid,
  content_hash    text not null,
  created_at      timestamptz not null default now(),
  unique (task_id, agent_key, content_hash)
);
create index if not exists specialist_proposals_task_idx on projects.specialist_proposals (organization_id, task_id, created_at desc);
alter table projects.specialist_proposals enable row level security;
drop policy if exists specialist_proposals_read on projects.specialist_proposals;
create policy specialist_proposals_read on projects.specialist_proposals for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.specialist_proposals from public, anon;
revoke insert, update, delete on projects.specialist_proposals from authenticated;
grant select on projects.specialist_proposals to authenticated;
grant all on projects.specialist_proposals to service_role;
create trigger specialist_proposals_parent_org_project before insert or update of project_id on projects.specialist_proposals
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger specialist_proposals_parent_org_task before insert or update of task_id on projects.specialist_proposals
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');
create trigger specialist_proposals_parent_org_handoff before insert or update of handoff_id on projects.specialist_proposals
  for each row execute function core.enforce_parent_org('handoff_id', 'ai.handoffs');
create trigger freeze_org_specialist_proposals before update of organization_id on projects.specialist_proposals
  for each row execute function core.freeze_organization_id();

-- append-only: a proposal is never edited; it is deleted only by a parent's cascade (trigger depth > 1), never by a direct DELETE
create or replace function projects.specialist_proposals_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'a specialist proposal is a record of what was proposed: it is never edited' using errcode = 'restrict_violation';
  end if;
  if pg_trigger_depth() <= 1 then
    raise exception 'a specialist proposal is a record of what was proposed: it is never deleted' using errcode = 'restrict_violation';
  end if;
  return old;
end $$;
create trigger specialist_proposals_no_update before update on projects.specialist_proposals
  for each row execute function projects.specialist_proposals_append_only();
create trigger specialist_proposals_no_delete before delete on projects.specialist_proposals
  for each row execute function projects.specialist_proposals_append_only();

-- ── the pure rules, one definition each (src/modules/projects/specialist-proposals.ts mirrors them; a test holds the two equal) ─────────────────

-- is a planned file inside one of the task's affected paths? An affected path is a file, a directory, or a glob (cut at its first wildcard
-- segment). A path with a parent segment, an absolute path or an empty list of affected paths is never inside.
create or replace function projects.path_within_affected(p_file text, p_affected text[])
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  v_file text := regexp_replace(btrim(replace(coalesce(p_file, ''), E'\\', '/')), '^\./+', '');
  v_a text;
  v_base text;
  v_seg text;
begin
  if v_file = '' or v_file like '/%' or v_file ~ '(^|/)\.\.(/|$)' or v_file ~ '[*?]' then return false; end if;
  foreach v_a in array coalesce(p_affected, '{}'::text[]) loop
    v_a := regexp_replace(btrim(replace(coalesce(v_a, ''), E'\\', '/')), '^\./+', '');
    v_base := '';
    foreach v_seg in array string_to_array(v_a, '/') loop
      exit when v_seg ~ '[*?\[{]';
      continue when v_seg = '' or v_seg = '.';
      v_base := case when v_base = '' then v_seg else v_base || '/' || v_seg end;
    end loop;
    if v_base = '' then
      -- a wildcard at the root means the whole repository; an empty affected path means nothing
      if v_a <> '' and v_a ~ '[*?\[{]' then return true; end if;
      continue;
    end if;
    if v_file = v_base or left(v_file, length(v_base) + 1) = v_base || '/' then return true; end if;
  end loop;
  return false;
end $$;

-- secrets, .env and key material are never a planned file; migrations are the database developer's only
create or replace function projects.proposal_forbidden_path(p_file text, p_agent text)
returns text language plpgsql immutable set search_path = '' as $$
declare v_f text := lower(replace(coalesce(p_file, ''), E'\\', '/'));
begin
  if v_f ~ '(^|/)\.env[^/]*$' or v_f ~ '(^|/)secrets?(/|\.|$)' or v_f ~ '\.(pem|key|p12|pfx)$' or v_f ~ '(^|/)id_(rsa|ed25519)' then return 'secrets'; end if;
  if v_f ~ '(^|/)supabase/migrations(/|$)' and p_agent <> 'database_developer' then return 'migrations'; end if;
  return null;
end $$;

-- the actions no specialist may plan (the envelope's forbiddenActions), as patterns over the plan text. \y is Postgres' word boundary.
create or replace function projects.proposal_forbidden_action(p_text text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if p_text ~* '\y(deploy|deploys|deploying|deployed|release|releasing|publish|publishing|push|pushing)\y[^.\n]{0,40}\y(prod|production|live|app ?store|play ?store)\y' then return 'deploy'; end if;
  if p_text ~* '\ymerg\w*\y[^.\n]{0,40}\y(main|master|production|protected|release)\y' then return 'merge'; end if;
  if p_text ~* '\y(self[- ]?(approv|verif)\w*|(approv|verif)\w*\y[^.\n]{0,20}\y(own|my|its own))' then return 'self_approval'; end if;
  if p_text ~* '\y(chang\w*|expand\w*|widen\w*|extend\w*)\y[^.\n]{0,20}\y(scope|baseline)\y' then return 'scope'; end if;
  if p_text ~* '\y(verif\w*|confirm\w*)\y[^.\n]{0,20}\ypayments?\y|\y(issu\w*|process\w*)\y[^.\n]{0,10}\yrefunds?\y' then return 'payment'; end if;
  if p_text ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-.]{12,}' or p_text ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})' then return 'secret'; end if;
  return null;
end $$;

-- ── the door ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function projects.record_specialist_proposal(
  p_organization_id uuid, p_task_id uuid, p_agent_key text, p_handoff_id uuid, p_outcome text,
  p_summary text, p_planned_files text[], p_planned_tests text[], p_risks text[], p_evidence_plan text[], p_detail jsonb default '{}'::jsonb, p_run_id uuid default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_task projects.tasks;
  v_handoff ai.handoffs;
  v_required text[];
  v_file text;
  v_why text;
  v_allowed text[];
  v_text text;
  v_id uuid;
  v_f jsonb;
  v_defect uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  if p_agent_key not in ('frontend_developer', 'backend_developer', 'database_developer', 'mobile_developer', 'integration', 'devops_build', 'security_review', 'bug_fix', 'refactor_performance') then
    return query select 'not_a_specialist'::text; return;
  end if;
  -- the task must be in the JOB's organization: another tenant's task is simply not found
  select * into v_task from projects.tasks t where t.id = p_task_id and t.organization_id = p_organization_id;
  if v_task.id is null then return query select 'not_found'::text; return; end if;
  if v_task.required_capability is distinct from p_agent_key then return query select 'wrong_agent'::text; return; end if;
  -- ... and routed to this agent: a handoff for this task, in this organization, to this agent
  select * into v_handoff from ai.handoffs h
   where h.id = p_handoff_id and h.organization_id = p_organization_id and h.to_agent = p_agent_key and h.subject_type = 'development_task' and h.subject_id = v_task.id;
  if v_handoff.id is null then return query select 'not_routed'::text; return; end if;
  if p_outcome not in ('proposal', 'not_required') then return query select 'bad_input'::text; return; end if;
  if p_summary is null or length(btrim(p_summary)) = 0 then return query select 'bad_input'::text; return; end if;
  p_planned_files := coalesce(p_planned_files, '{}'); p_planned_tests := coalesce(p_planned_tests, '{}');
  p_risks := coalesce(p_risks, '{}'); p_evidence_plan := coalesce(p_evidence_plan, '{}'); p_detail := coalesce(p_detail, '{}'::jsonb);
  if jsonb_typeof(p_detail) <> 'object' then return query select 'bad_input'::text; return; end if;

  -- forbidden actions, anywhere in what it wrote
  v_text := concat_ws(E'\n', p_summary, array_to_string(p_planned_files, E'\n'), array_to_string(p_planned_tests, E'\n'), array_to_string(p_risks, E'\n'), array_to_string(p_evidence_plan, E'\n'), p_detail::text);
  v_why := projects.proposal_forbidden_action(v_text);
  if v_why is not null then return query select 'forbidden_action'::text; return; end if;

  -- the honest NOT_REQUIRED: only where a specialist can legitimately have nothing to do, and then with no plan at all
  if p_outcome = 'not_required' then
    if p_agent_key not in ('mobile_developer', 'refactor_performance') then return query select 'not_required_not_allowed'::text; return; end if;
    if cardinality(p_planned_files) > 0 or cardinality(p_planned_tests) > 0 then return query select 'not_required_has_a_plan'::text; return; end if;
  else
    if cardinality(p_planned_files) = 0 and p_agent_key <> 'security_review' then return query select 'empty_plan'::text; return; end if;
    -- every planned file: inside the task's own affected paths, and not a path no specialist touches
    foreach v_file in array p_planned_files loop
      if length(v_file) > 300 or v_file ~ '[[:cntrl:]]' then return query select 'bad_input'::text; return; end if;
      if projects.proposal_forbidden_path(v_file, p_agent_key) is not null then return query select 'forbidden_path'::text; return; end if;
      if not projects.path_within_affected(v_file, v_task.affected_paths) then return query select 'outside_affected_paths'::text; return; end if;
    end loop;
    -- a security review proposes findings and never edits
    if p_agent_key = 'security_review' and cardinality(p_planned_files) > 0 then return query select 'review_must_not_edit'::text; return; end if;
    -- the evidence a result must carry comes from the routed envelope on the handoff row
    select coalesce(array_agg(e), '{}') into v_required from jsonb_array_elements_text(coalesce(v_handoff.context->'envelope'->'requiredEvidence', '[]'::jsonb)) e;
    if cardinality(v_required) = 0 or not (v_required <@ p_evidence_plan) then return query select 'missing_evidence'::text; return; end if;
  end if;

  -- per-agent detail: only the keys that agent has a reason to carry
  v_allowed := case p_agent_key
    when 'bug_fix' then array['defectId', 'rootCause']
    when 'security_review' then array['findings']
    when 'database_developer' then array['migrations']
    when 'refactor_performance' then array['measurement']
    when 'mobile_developer' then array['target']
    else array[]::text[] end;
  if exists (select 1 from jsonb_object_keys(p_detail) k where k <> all (v_allowed)) then return query select 'detail_not_allowed'::text; return; end if;
  if p_agent_key = 'bug_fix' and p_outcome = 'proposal' then
    begin v_defect := (p_detail->>'defectId')::uuid; exception when others then v_defect := null; end;
    if v_defect is null or not exists (select 1 from qa.defects d where d.id = v_defect and d.organization_id = p_organization_id and d.task_id = v_task.id) then
      return query select 'defect_required'::text; return;
    end if;
  end if;
  if p_agent_key = 'security_review' and p_outcome = 'proposal' then
    if jsonb_typeof(p_detail->'findings') is distinct from 'array' then return query select 'bad_input'::text; return; end if;
    for v_f in select * from jsonb_array_elements(p_detail->'findings') loop
      if jsonb_typeof(v_f) <> 'object' or (v_f->>'severity') is null or (v_f->>'severity') not in ('critical', 'high', 'medium', 'low', 'info') then
        return query select 'bad_input'::text; return;
      end if;
    end loop;
  end if;
  if p_agent_key = 'database_developer' and p_detail ? 'migrations' then
    if jsonb_typeof(p_detail->'migrations') is distinct from 'array'
       or exists (select 1 from jsonb_array_elements_text(p_detail->'migrations') m where m <> all (p_planned_files)) then
      return query select 'bad_input'::text; return;
    end if;
  end if;

  begin
    insert into projects.specialist_proposals (organization_id, project_id, task_id, handoff_id, agent_key, outcome, plan_summary, planned_files, planned_tests, risks, evidence_plan, detail, agent_run_id, content_hash)
    values (v_task.organization_id, v_task.project_id, v_task.id, v_handoff.id, p_agent_key, p_outcome, btrim(p_summary), p_planned_files, p_planned_tests, p_risks, p_evidence_plan, p_detail, p_run_id,
            md5(concat_ws('|', p_outcome, p_summary, array_to_string(p_planned_files, ','), array_to_string(p_planned_tests, ','), array_to_string(p_risks, ','), p_detail::text)))
    on conflict (task_id, agent_key, content_hash) do nothing returning id into v_id;
  exception when check_violation then return query select 'bad_input'::text; return;
  end;
  if v_id is null then return query select 'already_proposed'::text; return; end if;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_specialist_proposal(uuid, uuid, text, uuid, text, text, text[], text[], text[], text[], jsonb, uuid) from public, anon, authenticated;
grant execute on function projects.record_specialist_proposal(uuid, uuid, text, uuid, text, text, text[], text[], text[], text[], jsonb, uuid) to service_role;
revoke all on function projects.path_within_affected(text, text[]) from public, anon;
grant execute on function projects.path_within_affected(text, text[]) to authenticated, service_role;
revoke all on function projects.proposal_forbidden_path(text, text) from public, anon;
grant execute on function projects.proposal_forbidden_path(text, text) to authenticated, service_role;
revoke all on function projects.proposal_forbidden_action(text) from public, anon;
grant execute on function projects.proposal_forbidden_action(text) to authenticated, service_role;

notify pgrst, 'reload schema';
