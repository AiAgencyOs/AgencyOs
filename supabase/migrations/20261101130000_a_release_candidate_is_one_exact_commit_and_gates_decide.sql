-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 release candidate, readiness, hard gates, exceptions, Admin QA review, Phase 7 intake (P601 §31-§37, §40, §42; P613).
--
--   qa.release_candidates   ONE exact commit + build + artifact hash; a different commit is a NEW candidate (approval never transfers)
--   qa.category_results     the verdict per QA category on the candidate's commit; PASS only when every case of that category passed; independent; evidenced
--   qa.evaluate_hard_gates  15 gates read from rows, never from a score; a failed mandatory gate blocks REGARDLESS of score
--   qa.readiness_assessments  append-only: weighted dimensions -> a score and band. SCORE IS A SUMMARY, NOT AUTHORITY
--   qa.release_exceptions   human-only (owner), only for gates policy allows, with owner/mitigation/containment and an EXPIRY (an expired one satisfies nothing)
--   qa.admin_qa_reviews     append-only: approve / request_fix / request_retest / block, tied to the EXACT candidate
--   projects.phase_six_handoffs  the frozen Phase 7 intake, written with Phase6Completed. Phase 6 DEPLOYS NOTHING.
--   phase_readiness(...,6)  Phase6Completed needs an Admin-approved candidate whose commit is still the build's, every gate satisfied NOW,
--                           no unresolved S0/S1, every FIX_READY retested
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.release_candidates (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  plan_id               uuid not null references qa.master_test_plans(id) on delete restrict,
  intake_id             uuid not null references projects.qa_intakes(id) on delete restrict,
  version               int not null check (version > 0),
  status                text not null default 'draft' check (status in ('draft', 'admin_review', 'approved', 'blocked', 'superseded', 'stale')),
  commit_ref            text not null check (length(btrim(commit_ref)) > 0),
  build_deliverable_id  uuid not null references projects.deliverables(id) on delete restrict,
  artifact_sha256       text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  config_version        text,
  rollback_plan         text,
  rollback_owner        text,
  observability_notes   text,
  known_limitations     jsonb not null default '[]'::jsonb check (jsonb_typeof(known_limitations) = 'array'),
  created_by            uuid references core.users(id) on delete set null,
  approved_by           uuid references core.users(id) on delete set null,
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (project_id, version),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);
create unique index if not exists release_candidates_one_approved on qa.release_candidates (project_id) where status = 'approved';

create table if not exists qa.category_results (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  candidate_id     uuid not null references qa.release_candidates(id) on delete cascade,
  category         text not null check (category in ('functional', 'ui_e2e', 'api', 'integration', 'database', 'security', 'performance', 'compatibility', 'regression')),
  status           text not null check (status in ('pass', 'fail', 'blocked')),
  commit_ref       text not null,
  evidence_ref     text,
  reason           text,
  recorded_by      uuid references core.users(id) on delete set null,
  recorded_at      timestamptz not null default now(),
  unique (candidate_id, category),
  check (status <> 'pass' or (evidence_ref is not null and length(btrim(evidence_ref)) > 0)),
  check (status = 'pass' or (reason is not null and length(btrim(reason)) > 0))
);

create table if not exists qa.category_result_history (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references core.organizations(id) on delete cascade,
  candidate_id uuid not null references qa.release_candidates(id) on delete cascade, category text not null, status text not null, commit_ref text not null,
  evidence_ref text, reason text, recorded_by uuid references core.users(id) on delete set null, recorded_at timestamptz not null default now()
);

create table if not exists qa.readiness_assessments (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  candidate_id        uuid not null references qa.release_candidates(id) on delete cascade,
  commit_ref          text not null,
  score               int not null check (score between 0 and 100),
  band                text not null check (band in ('strong', 'controlled', 'material_risk', 'not_ready')),
  dimensions          jsonb not null,
  gates               jsonb not null,
  all_gates_satisfied boolean not null,
  result              text not null check (result in ('ready', 'blocked')),
  evaluated_by        uuid references core.users(id) on delete set null,
  evaluated_at        timestamptz not null default now(),
  -- THE RULE: a candidate with an unsatisfied mandatory gate is never 'ready', whatever its score
  check (result <> 'ready' or (all_gates_satisfied and score >= 70))
);

create table if not exists qa.release_exceptions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  candidate_id      uuid not null references qa.release_candidates(id) on delete cascade,
  gate              text not null check (gate in ('performance', 'compatibility', 'observability', 'deployment_config')),
  risk              text not null check (length(btrim(risk)) > 0),
  business_reason   text not null check (length(btrim(business_reason)) > 0),
  mitigation        text not null check (length(btrim(mitigation)) > 0),
  client_impact     text,
  owner             text not null check (length(btrim(owner)) > 0),
  containment_plan  text not null check (length(btrim(containment_plan)) > 0),
  expires_at        timestamptz not null,
  status            text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  requested_by      uuid references core.users(id) on delete set null,
  approved_by       uuid references core.users(id) on delete set null,
  approved_at       timestamptz,
  policy_version    int not null default 1,
  created_at        timestamptz not null default now(),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);

create table if not exists qa.admin_qa_reviews (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  candidate_id     uuid not null references qa.release_candidates(id) on delete cascade,
  commit_ref       text not null,
  decision         text not null check (decision in ('approve', 'request_fix', 'request_retest', 'block')),
  note             text,
  decided_by       uuid not null references core.users(id) on delete restrict,
  decided_at       timestamptz not null default now(),
  check (decision = 'approve' or (note is not null and length(btrim(note)) > 0))
);

do $$
declare r record;
begin
  for r in select * from (values
    ('release_candidates', 'project_id', 'projects.projects'), ('release_candidates', 'plan_id', 'qa.master_test_plans'), ('release_candidates', 'intake_id', 'projects.qa_intakes'), ('release_candidates', 'build_deliverable_id', 'projects.deliverables'),
    ('category_results', 'candidate_id', 'qa.release_candidates'), ('category_result_history', 'candidate_id', 'qa.release_candidates'),
    ('readiness_assessments', 'candidate_id', 'qa.release_candidates'), ('release_exceptions', 'candidate_id', 'qa.release_candidates'), ('admin_qa_reviews', 'candidate_id', 'qa.release_candidates')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on qa.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on qa.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['release_candidates', 'category_results', 'category_result_history', 'readiness_assessments', 'release_exceptions', 'admin_qa_reviews']) as tbl loop
    execute format('alter table qa.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on qa.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on qa.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('grant select on qa.%I to authenticated', r.tbl);
    execute format('grant all on qa.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on qa.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on qa.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
  for r in select unnest(array['release_candidates']) as tbl loop
    execute format('drop trigger if exists %I on qa.%I', r.tbl || '_updated_at', r.tbl);
    execute format('create trigger %I before update on qa.%I for each row execute function core.set_updated_at()', r.tbl || '_updated_at', r.tbl);
  end loop;
end $$;

-- records that are history: never edited, never deleted
create or replace function qa.release_history_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a % record is history and is never edited or deleted', tg_table_name using errcode = 'restrict_violation'; end $$;
do $$
declare t text;
begin
  for t in select unnest(array['category_result_history', 'readiness_assessments', 'admin_qa_reviews']) loop
    execute format('drop trigger if exists %I on qa.%I', t || '_append_only', t);
    execute format('create trigger %I before update or delete on qa.%I for each row execute function qa.release_history_append_only()', t || '_append_only', t);
  end loop;
end $$;

-- the candidate's identity is frozen: a different commit is a different candidate
create or replace function qa.release_candidates_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a release candidate is never deleted' using errcode = 'restrict_violation'; end if;
  if new.commit_ref is distinct from old.commit_ref or new.build_deliverable_id is distinct from old.build_deliverable_id or new.artifact_sha256 is distinct from old.artifact_sha256
     or new.plan_id is distinct from old.plan_id or new.version is distinct from old.version or new.project_id is distinct from old.project_id then
    raise exception 'a release candidate is one exact commit and build: a different commit is a new candidate' using errcode = 'restrict_violation';
  end if;
  if old.status = 'approved' and new.status not in ('approved', 'superseded', 'stale') then
    raise exception 'an approved candidate is only ever superseded or marked stale' using errcode = 'restrict_violation';
  end if;
  if new.status = 'approved' and old.status <> 'approved' and coalesce(current_setting('qa.release_sanctioned', true), '') <> 'on' then
    raise exception 'a candidate is approved through the Admin review door, never by a status edit' using errcode = 'restrict_violation';
  end if;
  -- the readiness facts of an approved candidate (rollback, observability, limitations, config) are as approved
  if old.status = 'approved' and (new.rollback_plan is distinct from old.rollback_plan or new.observability_notes is distinct from old.observability_notes
     or new.config_version is distinct from old.config_version or new.known_limitations is distinct from old.known_limitations) then
    raise exception 'an approved candidate''s prerequisites are never edited: raise a new candidate' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists release_candidates_guard on qa.release_candidates;
create trigger release_candidates_guard before update or delete on qa.release_candidates for each row execute function qa.release_candidates_guard();

-- an exception is a human act; once approved it is a fact (it can only expire)
create or replace function qa.release_exceptions_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a release exception is audit history' using errcode = 'restrict_violation'; end if;
  if old.status = 'approved' and (new.gate is distinct from old.gate or new.candidate_id is distinct from old.candidate_id or new.expires_at is distinct from old.expires_at
     or new.mitigation is distinct from old.mitigation or new.status is distinct from old.status) then
    raise exception 'an approved release exception is never edited' using errcode = 'restrict_violation';
  end if;
  if new.status = 'approved' and old.status <> 'approved' and coalesce(current_setting('qa.release_sanctioned', true), '') <> 'on' then
    raise exception 'an exception is approved by a person through the exception door' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists release_exceptions_guard on qa.release_exceptions;
create trigger release_exceptions_guard before update or delete on qa.release_exceptions for each row execute function qa.release_exceptions_guard();

insert into core.event_types (type, description, canonical) values
  ('project.release_candidate_created', 'An exact release candidate (one commit, one build, one artifact hash) was frozen for Phase 6 QA.', true),
  ('project.release_readiness_evaluated', 'A readiness assessment was recorded for a release candidate (score, band and the hard gates as they stood).', true),
  ('project.release_exception_requested', 'A release exception was requested for a gate policy allows. Only a person (the owner) can approve it.', true),
  ('project.release_candidate_approved', 'An Admin approved the exact release candidate. Phase 6 may complete only on this approval, and only while the commit is unchanged.', true)
on conflict (type) do nothing;

-- ── candidate ──────────────────────────────────────────────────────────────
create or replace function qa.create_release_candidate(p_project_id uuid, p_config_version text default null, p_rollback_plan text default null, p_rollback_owner text default null,
                                                       p_observability_notes text default null, p_known_limitations jsonb default '[]')
returns table (outcome text, candidate_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_plan qa.master_test_plans; v_in projects.qa_intakes; v_commit text; v_hash text; v_next int; v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_plan from qa.master_test_plans p where p.project_id = p_project_id and p.organization_id = v_org and p.status = 'approved';
  if v_plan.id is null then return query select 'no_approved_plan'::text, null::uuid; return; end if;
  select * into v_in from projects.qa_intakes i where i.id = v_plan.intake_id;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_in.build_deliverable_id;
  -- REL6-T001: a candidate with no exact source commit is invalid; the commit must be the one the plan and intake are about
  if v_commit is null or length(btrim(v_commit)) = 0 then return query select 'no_commit'::text, null::uuid; return; end if;
  if v_commit is distinct from v_plan.commit_ref then return query select 'plan_is_for_another_commit'::text, null::uuid; return; end if;
  select br.artifact_sha256 into v_hash from projects.build_runs br where br.deliverable_id = v_in.build_deliverable_id and br.commit_ref = v_commit and br.status = 'succeeded' and br.artifact_sha256 is not null order by br.created_at desc limit 1;
  if v_hash is null then return query select 'no_artifact'::text, null::uuid; return; end if;
  perform 1 from projects.projects p where p.id = p_project_id for update;
  -- a new candidate supersedes the earlier ones: an approval never transfers to different code
  update qa.release_candidates set status = 'superseded' where project_id = p_project_id and status in ('draft', 'admin_review', 'blocked', 'approved') and commit_ref is distinct from v_commit;
  if exists (select 1 from qa.release_candidates c where c.project_id = p_project_id and c.commit_ref = v_commit and c.status in ('draft', 'admin_review', 'blocked', 'approved')) then
    return query select 'candidate_exists_for_this_commit'::text, (select c.id from qa.release_candidates c where c.project_id = p_project_id and c.commit_ref = v_commit and c.status in ('draft', 'admin_review', 'blocked', 'approved') limit 1); return;
  end if;
  select coalesce(max(version), 0) + 1 into v_next from qa.release_candidates where project_id = p_project_id;
  insert into qa.release_candidates (organization_id, project_id, plan_id, intake_id, version, commit_ref, build_deliverable_id, artifact_sha256, config_version, rollback_plan, rollback_owner, observability_notes, known_limitations, created_by)
  values (v_org, p_project_id, v_plan.id, v_in.id, v_next, v_commit, v_in.build_deliverable_id, v_hash, p_config_version, p_rollback_plan, p_rollback_owner, p_observability_notes, coalesce(p_known_limitations, '[]'), v_actor)
  returning id into v_new;
  perform core.record_audit(v_org, 'release_candidate.created', 'release_candidate', v_new, null, jsonb_build_object('projectId', p_project_id, 'version', v_next, 'commit', v_commit, 'artifact', v_hash));
  perform core.emit_event(v_org, 'project.release_candidate_created', 'release_candidate', v_new, jsonb_build_object('projectId', p_project_id, 'version', v_next));
  return query select 'created'::text, v_new;
end $$;
revoke all on function qa.create_release_candidate(uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function qa.create_release_candidate(uuid, text, text, text, text, jsonb) to authenticated;

-- ── category results ───────────────────────────────────────────────────────
create or replace function qa.record_category_result(p_candidate_id uuid, p_category text, p_status text, p_evidence_ref text default null, p_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_c qa.release_candidates; v_plan qa.master_test_plans; v_commit text; v_producer uuid; v_open int;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  if p_status not in ('pass', 'fail', 'blocked') then return query select 'bad_status'::text; return; end if;
  select * into v_c from qa.release_candidates c where c.id = p_candidate_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status in ('approved', 'superseded', 'stale') then return query select 'candidate_closed'::text; return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = v_c.plan_id;
  if not (p_category = any (v_plan.required_categories)) then return query select 'category_not_in_plan'::text; return; end if;
  -- the evidence is about the candidate's commit, and the build must still be that commit
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_c.build_deliverable_id;
  if v_commit is distinct from v_c.commit_ref then return query select 'candidate_is_stale'::text; return; end if;
  select d.created_by into v_producer from projects.deliverables d where d.id = v_c.build_deliverable_id;
  if v_producer is not null and v_producer = v_actor then return query select 'self_review'::text; return; end if;
  if p_status = 'pass' and (p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0) then return query select 'evidence_required'::text; return; end if;
  if p_status <> 'pass' and (p_reason is null or length(btrim(p_reason)) = 0) then return query select 'reason_required'::text; return; end if;
  -- a category passes only when EVERY case of that category passed on this commit: blocked, skipped, failed or invalidated cases are not a pass
  if p_status = 'pass' then
    select count(*) into v_open from qa.phase6_cases c where c.plan_id = v_c.plan_id and c.category = p_category and not (c.status = 'pass' and c.result_commit = v_c.commit_ref);
    if v_open > 0 then return query select 'cases_not_passing'::text; return; end if;
    if not exists (select 1 from qa.phase6_cases c where c.plan_id = v_c.plan_id and c.category = p_category) then return query select 'no_cases'::text; return; end if;
  end if;
  insert into qa.category_results (organization_id, candidate_id, category, status, commit_ref, evidence_ref, reason, recorded_by)
  values (v_org, v_c.id, p_category, p_status, v_c.commit_ref, p_evidence_ref, p_reason, v_actor)
  on conflict (candidate_id, category) do update set status = excluded.status, commit_ref = excluded.commit_ref, evidence_ref = excluded.evidence_ref, reason = excluded.reason, recorded_by = excluded.recorded_by, recorded_at = now();
  insert into qa.category_result_history (organization_id, candidate_id, category, status, commit_ref, evidence_ref, reason, recorded_by) values (v_org, v_c.id, p_category, p_status, v_c.commit_ref, p_evidence_ref, p_reason, v_actor);
  return query select 'recorded'::text;
end $$;
revoke all on function qa.record_category_result(uuid, text, text, text, text) from public, anon;
grant execute on function qa.record_category_result(uuid, text, text, text, text) to authenticated;

-- ── hard gates ─────────────────────────────────────────────────────────────
create or replace function qa.evaluate_hard_gates(p_candidate_id uuid)
returns table (gate text, passed boolean, detail text, exceptionable boolean, exceptioned boolean, satisfied boolean)
language plpgsql stable set search_path = '' as $$
declare
  v_c qa.release_candidates; v_plan qa.master_test_plans; v_commit text; v_n int; v_run_hash text; v_cat record; v_client boolean;
  g text; v_pass boolean; v_detail text; v_exc boolean; v_exceptionable boolean;
begin
  select * into v_c from qa.release_candidates c where c.id = p_candidate_id;
  if v_c.id is null then return; end if;
  select * into v_plan from qa.master_test_plans p where p.id = v_c.plan_id;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_c.build_deliverable_id;

  for g in select unnest(array['build_succeeds', 'critical_tests', 'no_s0_s1', 'security', 'database_migration', 'regression', 'performance', 'compatibility', 'unique_artifact',
                               'evidence_current', 'rollback', 'observability', 'deployment_config', 'client_acceptance', 'admin_approval']) loop
    v_pass := false; v_detail := ''; v_exceptionable := g in ('performance', 'compatibility', 'observability', 'deployment_config');

    if g = 'build_succeeds' then
      select br.artifact_sha256 into v_run_hash from projects.build_runs br where br.deliverable_id = v_c.build_deliverable_id and br.commit_ref = v_c.commit_ref and br.status = 'succeeded' order by br.created_at desc limit 1;
      v_pass := v_run_hash is not null and v_run_hash = v_c.artifact_sha256 and v_commit = v_c.commit_ref;
      v_detail := case when v_pass then 'the exact commit built and produced the candidate''s artifact' else 'no succeeded build run matches the candidate''s commit and artifact hash' end;
    elsif g = 'critical_tests' then
      select count(*) into v_n from qa.phase6_cases c where c.plan_id = v_c.plan_id and c.priority = 'critical' and not (c.status = 'pass' and c.result_commit = v_c.commit_ref);
      v_pass := v_n = 0 and exists (select 1 from qa.phase6_cases c where c.plan_id = v_c.plan_id and c.priority = 'critical');
      v_detail := case when v_pass then 'every critical case passed on this commit' else format('%s critical case(s) are not passing on this commit (blocked, skipped, failed and invalidated are not a pass)', v_n) end;
    elsif g = 'no_s0_s1' then
      select count(*) into v_n from qa.unresolved_product_defects(v_c.project_id) u where u.s_level <= 1;
      v_pass := v_n = 0;
      v_detail := case when v_pass then 'no unresolved S0/S1 product defect' else format('%s unresolved S0/S1 product defect(s)', v_n) end;
    elsif g in ('security', 'database_migration', 'regression', 'performance', 'compatibility') then
      -- security is mandatory whatever the plan says; the others are required when the approved plan requires them
      declare v_cat_name text := case g when 'database_migration' then 'database' else g end; v_required boolean;
      begin
        v_required := g = 'security' or v_cat_name = any (v_plan.required_categories);
        select r.status, r.commit_ref into v_cat from qa.category_results r where r.candidate_id = v_c.id and r.category = v_cat_name;
        if not v_required then v_pass := true; v_detail := 'not required by the approved plan';
        elsif v_cat.status = 'pass' and v_cat.commit_ref = v_c.commit_ref then v_pass := true; v_detail := v_cat_name || ' passed on this commit';
        elsif v_cat.status is null then v_detail := v_cat_name || ' has no result (unknown is not a pass)';
        elsif v_cat.commit_ref is distinct from v_c.commit_ref then v_detail := v_cat_name || ' evidence is from another commit';
        else v_detail := v_cat_name || ' is ' || v_cat.status; end if;
      end;
    elsif g = 'unique_artifact' then
      v_pass := v_c.artifact_sha256 is not null and not exists (select 1 from qa.release_candidates o where o.project_id = v_c.project_id and o.id <> v_c.id and o.artifact_sha256 = v_c.artifact_sha256 and o.commit_ref <> v_c.commit_ref and o.status <> 'superseded');
      v_detail := case when v_pass then 'the artifact is uniquely identified by its hash' else 'the artifact hash is shared with a different commit' end;
    elsif g = 'evidence_current' then
      select count(*) into v_n from qa.category_results r where r.candidate_id = v_c.id and r.commit_ref is distinct from v_c.commit_ref;
      v_pass := v_n = 0 and v_commit = v_c.commit_ref;
      v_detail := case when v_pass then 'all recorded evidence is for this exact commit, which is still the build''s' else 'evidence from another commit is present, or the build''s commit changed' end;
    elsif g = 'rollback' then
      v_pass := coalesce(btrim(v_c.rollback_plan), '') <> '' and coalesce(btrim(v_c.rollback_owner), '') <> '';
      v_detail := case when v_pass then 'a rollback plan with an owner exists for Phase 7' else 'no rollback plan and owner' end;
    elsif g = 'observability' then
      v_pass := coalesce(btrim(v_c.observability_notes), '') <> '';
      v_detail := case when v_pass then 'monitoring and logging prerequisites are recorded' else 'no monitoring/logging prerequisites recorded' end;
    elsif g = 'deployment_config' then
      v_pass := coalesce(btrim(v_c.config_version), '') <> '';
      v_detail := case when v_pass then 'the production configuration version is named' else 'no configuration version named for Phase 7' end;
    elsif g = 'client_acceptance' then
      select exists (select 1 from projects.deliverables d join projects.deliverable_details dd on dd.deliverable_id = d.id
                      where d.id = v_c.build_deliverable_id and d.status = 'approved' and dd.commit_ref = v_c.commit_ref) into v_client;
      v_pass := v_client;
      v_detail := case when v_pass then 'the client''s approval is tied to this exact build and commit' else 'the client approval is not tied to this build' end;
    elsif g = 'admin_approval' then
      v_pass := v_c.status = 'approved';
      v_detail := case when v_pass then 'an Admin approved this exact candidate' else 'awaiting the Admin''s approval of this exact candidate' end;
    end if;

    -- a valid (approved, unexpired, for THIS candidate and gate) human exception satisfies only a gate policy allows to be excepted
    v_exc := v_exceptionable and not v_pass and exists (select 1 from qa.release_exceptions e where e.candidate_id = v_c.id and e.gate = g and e.status = 'approved' and e.expires_at > now());
    return query select g, v_pass, v_detail, v_exceptionable, v_exc, (v_pass or v_exc);
  end loop;
end $$;
revoke all on function qa.evaluate_hard_gates(uuid) from public, anon;
grant execute on function qa.evaluate_hard_gates(uuid) to authenticated, service_role;

-- ── readiness (a summary; never authority) ────────────────────────────────
create or replace function qa.evaluate_readiness(p_candidate_id uuid)
returns table (outcome text, assessment_id uuid, score int, band text, result text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid; v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_c qa.release_candidates; v_plan qa.master_test_plans; v_dims jsonb := '[]'::jsonb; v_gates jsonb; v_all boolean; v_score int := 0; v_band text; v_result text; v_new uuid;
  d record; v_pts int; v_status text; v_cat record; v_docs int; v_stale int; v_s2 int;
begin
  select * into v_c from qa.release_candidates c where c.id = p_candidate_id;
  if v_c.id is null then return query select 'not_found'::text, null::uuid, 0, null::text, null::text; return; end if;
  if v_actor is null and not v_service then return query select 'no_actor'::text, null::uuid, 0, null::text, null::text; return; end if;
  if v_actor is not null and (v_c.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'not_authorized'::text, null::uuid, 0, null::text, null::text; return;
  end if;
  v_org := v_c.organization_id;
  select * into v_plan from qa.master_test_plans p where p.id = v_c.plan_id;

  -- configured weights (policy version 1); a dimension with nothing proven scores NOTHING (unknown and blocked are not full score)
  for d in select * from (values
      ('functional', 15, 'functional'), ('critical_e2e', 15, 'ui_e2e'), ('regression', 10, 'regression'), ('security', 15, 'security'),
      ('performance', 8, 'performance'), ('compatibility', 7, 'compatibility')) as t(name, weight, cat) loop
    select r.status, r.commit_ref into v_cat from qa.category_results r where r.candidate_id = v_c.id and r.category = d.cat;
    if not (d.cat = any (v_plan.required_categories)) and d.cat <> 'security' then v_status := 'not_required'; v_pts := d.weight;
    elsif v_cat.status = 'pass' and v_cat.commit_ref = v_c.commit_ref then v_status := 'pass'; v_pts := d.weight;
    else v_status := coalesce(v_cat.status, 'unknown'); v_pts := 0; end if;
    v_dims := v_dims || jsonb_build_object('name', d.name, 'weight', d.weight, 'status', v_status, 'points', v_pts);
    v_score := v_score + v_pts;
  end loop;
  select count(*) into v_s2 from qa.unresolved_product_defects(v_c.project_id) u where u.s_level <= 2;
  v_pts := case when v_s2 = 0 then 12 else 0 end;
  v_dims := v_dims || jsonb_build_object('name', 'defect_health', 'weight', 12, 'status', case when v_s2 = 0 then 'pass' else 'fail' end, 'points', v_pts); v_score := v_score + v_pts;
  v_pts := case when exists (select 1 from qa.evaluate_hard_gates(v_c.id) g where g.gate = 'build_succeeds' and g.passed) and exists (select 1 from qa.evaluate_hard_gates(v_c.id) g where g.gate = 'unique_artifact' and g.passed) then 8 else 0 end;
  v_dims := v_dims || jsonb_build_object('name', 'build_release', 'weight', 8, 'status', case when v_pts = 8 then 'pass' else 'fail' end, 'points', v_pts); v_score := v_score + v_pts;
  v_pts := case when coalesce(btrim(v_c.observability_notes), '') <> '' then 5 else 0 end;
  v_dims := v_dims || jsonb_build_object('name', 'observability', 'weight', 5, 'status', case when v_pts = 5 then 'pass' else 'unknown' end, 'points', v_pts); v_score := v_score + v_pts;
  select count(*) into v_docs from projects.technical_documents t where t.project_id = v_c.project_id and t.derived;
  select count(*) into v_stale from projects.stale_documents(v_c.project_id);
  v_pts := case when v_docs > 0 and v_stale = 0 then 5 else 0 end;
  v_dims := v_dims || jsonb_build_object('name', 'documentation', 'weight', 5, 'status', case when v_pts = 5 then 'pass' else 'unknown' end, 'points', v_pts); v_score := v_score + v_pts;

  select jsonb_agg(jsonb_build_object('gate', g.gate, 'passed', g.passed, 'exceptioned', g.exceptioned, 'satisfied', g.satisfied, 'detail', g.detail) order by g.gate),
         -- the Admin's approval is the LAST gate and the thing under review: it is not required for an assessment to be 'ready' FOR review
         bool_and(g.satisfied or g.gate = 'admin_approval')
    into v_gates, v_all from qa.evaluate_hard_gates(v_c.id) g;

  v_band := case when v_score >= 90 then 'strong' when v_score >= 80 then 'controlled' when v_score >= 70 then 'material_risk' else 'not_ready' end;
  -- THE RULE: gates decide; the score only summarises. A 97 with a failed security gate is BLOCKED.
  v_result := case when v_all and v_score >= 70 then 'ready' else 'blocked' end;

  insert into qa.readiness_assessments (organization_id, candidate_id, commit_ref, score, band, dimensions, gates, all_gates_satisfied, result, evaluated_by)
  values (v_org, v_c.id, v_c.commit_ref, v_score, v_band, v_dims, v_gates, v_all, v_result, v_actor) returning id into v_new;
  perform core.emit_event(v_org, 'project.release_readiness_evaluated', 'release_candidate', v_c.id, jsonb_build_object('projectId', v_c.project_id, 'score', v_score, 'result', v_result));
  return query select 'evaluated'::text, v_new, v_score, v_band, v_result;
end $$;
revoke all on function qa.evaluate_readiness(uuid) from public, anon;
grant execute on function qa.evaluate_readiness(uuid) to authenticated, service_role;

-- ── exceptions: human only ────────────────────────────────────────────────
create or replace function qa.request_release_exception(p_candidate_id uuid, p_gate text, p_risk text, p_business_reason text, p_mitigation text, p_owner text, p_containment_plan text, p_expires_at timestamptz, p_client_impact text default null)
returns table (outcome text, exception_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c qa.release_candidates; v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_c from qa.release_candidates c where c.id = p_candidate_id and c.organization_id = v_org;
  if v_c.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_c.status in ('approved', 'superseded', 'stale') then return query select 'candidate_closed'::text, null::uuid; return; end if;
  -- the gates policy lets nobody except: build, critical tests, S0/S1, security, DB migration, regression, unique artifact, current evidence, rollback, client acceptance
  if p_gate not in ('performance', 'compatibility', 'observability', 'deployment_config') then return query select 'gate_cannot_be_excepted'::text, null::uuid; return; end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '90 days' then return query select 'expiry_required_within_90_days'::text, null::uuid; return; end if;
  begin
    insert into qa.release_exceptions (organization_id, candidate_id, gate, risk, business_reason, mitigation, client_impact, owner, containment_plan, expires_at, requested_by)
    values (v_org, v_c.id, p_gate, p_risk, p_business_reason, p_mitigation, p_client_impact, p_owner, p_containment_plan, p_expires_at, v_actor) returning id into v_new;
  exception when check_violation then return query select 'incomplete_request'::text, null::uuid; return; end;
  perform core.emit_event(v_org, 'project.release_exception_requested', 'release_exception', v_new, jsonb_build_object('projectId', v_c.project_id, 'gate', p_gate));
  return query select 'requested'::text, v_new;
end $$;
revoke all on function qa.request_release_exception(uuid, text, text, text, text, text, text, timestamptz, text) from public, anon;
grant execute on function qa.request_release_exception(uuid, text, text, text, text, text, text, timestamptz, text) to authenticated;

create or replace function qa.approve_release_exception(p_exception_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_e qa.release_exceptions;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  -- no silent AI-created exception: only a signed-in OWNER approves one, and never the person who asked for it
  if not coalesce((select core.is_owner()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_e from qa.release_exceptions e where e.id = p_exception_id and e.organization_id = v_org for update;
  if v_e.id is null then return query select 'not_found'::text; return; end if;
  if v_e.status = 'approved' then return query select 'already_approved'::text; return; end if;
  if v_e.status <> 'requested' then return query select 'not_requested'::text; return; end if;
  if v_e.requested_by is not distinct from v_actor then return query select 'requester_cannot_approve'::text; return; end if;
  if v_e.expires_at <= now() then return query select 'expired'::text; return; end if;
  perform set_config('qa.release_sanctioned', 'on', true);
  update qa.release_exceptions set status = 'approved', approved_by = v_actor, approved_at = now() where id = v_e.id;
  perform core.record_audit(v_org, 'release_exception.approved', 'release_exception', v_e.id, null, jsonb_build_object('gate', v_e.gate, 'candidateId', v_e.candidate_id, 'expiresAt', v_e.expires_at));
  return query select 'approved'::text;
end $$;
revoke all on function qa.approve_release_exception(uuid) from public, anon;
grant execute on function qa.approve_release_exception(uuid) to authenticated;

-- ── review ─────────────────────────────────────────────────────────────────
create or replace function qa.submit_candidate_for_review(p_candidate_id uuid)
returns table (outcome text, result text, score int)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_c qa.release_candidates; v_a record;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text, null::text, 0; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::text, 0; return; end if;
  select * into v_c from qa.release_candidates c where c.id = p_candidate_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text, null::text, 0; return; end if;
  if v_c.status not in ('draft', 'blocked') then return query select 'wrong_state'::text, null::text, 0; return; end if;
  select * into v_a from qa.evaluate_readiness(v_c.id);
  if v_a.result = 'ready' then
    update qa.release_candidates set status = 'admin_review' where id = v_c.id;
    update projects.phase_six set state = 'admin_review' where project_id = v_c.project_id and state not in ('phase6_completed', 'm4_due', 'phase7_financially_ready');
    return query select 'in_review'::text, v_a.result, v_a.score; return;
  end if;
  update qa.release_candidates set status = 'blocked' where id = v_c.id;
  update projects.phase_six set state = 'final_verification' where project_id = v_c.project_id and state in ('testing', 'defect_fix_loop', 'plan_ready');
  return query select 'blocked'::text, v_a.result, v_a.score;
end $$;
revoke all on function qa.submit_candidate_for_review(uuid) from public, anon;
grant execute on function qa.submit_candidate_for_review(uuid) to authenticated;

create or replace function qa.decide_release_candidate(p_candidate_id uuid, p_decision text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c qa.release_candidates; v_a record; v_new_defect uuid;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  -- Admin approval is HUMAN authority; a QA agent does not impersonate the Admin
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('approve', 'request_fix', 'request_retest', 'block') then return query select 'bad_decision'::text; return; end if;
  if p_decision <> 'approve' and (p_note is null or length(btrim(p_note)) = 0) then return query select 'note_required'::text; return; end if;
  select * into v_c from qa.release_candidates c where c.id = p_candidate_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  -- REL6-T009/T023: a decision about a superseded, stale or not-in-review candidate is refused
  if v_c.status <> 'admin_review' then return query select 'wrong_candidate'::text; return; end if;

  if p_decision = 'approve' then
    -- the approval re-checks everything NOW: it is not the assessment of an hour ago and it is never a score
    select * into v_a from qa.evaluate_readiness(v_c.id);
    if v_a.result <> 'ready' then return query select 'not_ready'::text; return; end if;
    perform set_config('qa.release_sanctioned', 'on', true);
    update qa.release_candidates set status = 'approved', approved_by = v_actor, approved_at = now() where id = v_c.id;
    insert into qa.admin_qa_reviews (organization_id, candidate_id, commit_ref, decision, note, decided_by) values (v_org, v_c.id, v_c.commit_ref, 'approve', p_note, v_actor);
    perform core.record_audit(v_org, 'release_candidate.approved', 'release_candidate', v_c.id, null, jsonb_build_object('projectId', v_c.project_id, 'commit', v_c.commit_ref, 'version', v_c.version));
    perform core.emit_event(v_org, 'project.release_candidate_approved', 'release_candidate', v_c.id, jsonb_build_object('projectId', v_c.project_id, 'version', v_c.version));
    return query select 'approved'::text; return;
  end if;

  insert into qa.admin_qa_reviews (organization_id, candidate_id, commit_ref, decision, note, decided_by) values (v_org, v_c.id, v_c.commit_ref, p_decision, p_note, v_actor);
  if p_decision in ('request_fix', 'request_retest') then
    -- ADMIN REVIEW -> EDIT/RETEST REQUEST -> DEFECT -> FIX -> RETEST -> a NEW/UPDATED candidate -> readiness again -> Admin again
    insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by, build_id, phase6, found_commit)
    values (v_org, v_c.project_id, v_c.build_deliverable_id, 'major', left('Admin ' || replace(p_decision, '_', ' ') || ': ' || p_note, 200), p_note, v_actor, v_c.build_deliverable_id, true, v_c.commit_ref)
    returning id into v_new_defect;
    update projects.phase_six set state = 'defect_fix_loop' where project_id = v_c.project_id and state = 'admin_review';
  end if;
  update qa.release_candidates set status = 'blocked' where id = v_c.id;
  return query select (case p_decision when 'block' then 'blocked' else 'sent_back' end)::text;
end $$;
revoke all on function qa.decide_release_candidate(uuid, text, text) from public, anon;
grant execute on function qa.decide_release_candidate(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
CREATE OR REPLACE FUNCTION qa.plan_problems(p_plan_id uuid)
 RETURNS TABLE(problem text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare v_plan qa.master_test_plans; v_in projects.qa_intakes; v_base projects.development_baselines;
begin
  select * into v_plan from qa.master_test_plans p where p.id = p_plan_id;
  if v_plan.id is null then return; end if;
  select * into v_in from projects.qa_intakes i where i.id = v_plan.intake_id;
  select * into v_base from projects.development_baselines b where b.project_id = v_plan.project_id;
  if v_in.status is distinct from 'valid' then return query select 'The QA intake is not valid.'::text; end if;
  if v_plan.commit_ref is distinct from v_in.commit_ref then return query select 'The plan is for a commit that is no longer the intake''s commit.'::text; end if;
  -- the categories no release can do without are never optional: functional, critical end-to-end, security
  return query
    select format('Mandatory category "%s" is missing from the plan.', cat)
      from unnest(array['functional', 'ui_e2e', 'security']) cat
     where not (cat = any (v_plan.required_categories));
  if not exists (select 1 from qa.risk_items r where r.plan_id = p_plan_id) then return query select 'No risk matrix: risk-based planning needs at least one recorded risk.'::text; end if;

  -- every included requirement (scope item of the baseline's scope version) has a case
  return query
    select format('Requirement not covered: "%s" has no test case.', si.title)
      from projects.scope_items si
     where si.scope_version_id = v_base.scope_version_id and si.inclusion = 'included'
       and not exists (select 1 from qa.phase6_cases c where c.plan_id = p_plan_id and c.scope_item_id = si.id);
  -- every required category has a case
  return query
    select format('Required category "%s" has no test case.', cat)
      from unnest(v_plan.required_categories) cat
     where not exists (select 1 from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = cat);
  -- every critical journey has an end-to-end case
  return query
    select format('Critical journey "%s" has no end-to-end case.', j)
      from unnest(v_plan.critical_journeys) j
     where not exists (select 1 from qa.phase6_cases c where c.plan_id = p_plan_id and c.category = 'ui_e2e' and c.journey = j);
  -- a high/critical risk area needs a deep case in its category family
  return query
    select format('High-risk %s ("%s") has no critical or high priority case.', r.kind, r.area)
      from qa.risk_items r
     where r.plan_id = p_plan_id and r.level in ('high', 'critical')
       and not exists (select 1 from qa.phase6_cases c where c.plan_id = p_plan_id and c.priority in ('critical', 'high'));
end $function$;

revoke all on function qa.plan_problems(uuid) from public, anon;
grant execute on function qa.plan_problems(uuid) to authenticated, service_role;
