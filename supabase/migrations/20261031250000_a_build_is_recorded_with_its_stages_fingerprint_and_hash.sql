-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 DevOps / Build spec: SOURCE -> ENV VALIDATION -> INSTALL -> LINT/TYPE -> TEST -> BUILD -> ARTIFACT VERIFY -> SMOKE -> STORE -> BUILD RECORD.
-- Every artifact references its commit, environment, toolchain fingerprint and hash. Failures are CLASSIFIED; a transient infrastructure failure
-- may be retried (bounded), a deterministic code/test failure is returned to the specialist and is NOT retried; no secret value is ever logged.
--
--   projects.build_runs    append-only: one row per attempt on one build deliverable's commit
--   projects.record_build_run   the only door (a CI/runner holds it as the service role; an Admin may record by hand)
--   submit_deliverable     a build is not shared without a succeeded run, for the SAME commit, with a verified artifact hash
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.build_runs (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  deliverable_id     uuid not null references projects.deliverables(id) on delete restrict,
  commit_ref         text not null check (length(btrim(commit_ref)) > 0),
  environment        text not null check (environment in ('dev', 'review', 'staging', 'client_test')),
  attempt            int not null default 1 check (attempt between 1 and 3),
  retry_of           uuid references projects.build_runs(id) on delete restrict,
  status             text not null check (status in ('succeeded', 'failed')),
  failure_class      text check (failure_class in ('environment_missing', 'dependency_install_failed', 'lint_type_failed', 'test_failed', 'compile_failed',
                                                   'signing_failed', 'artifact_missing', 'install_failed', 'runtime_crash', 'infra_transient', 'toolchain_incompatible')),
  stages             jsonb not null default '[]'::jsonb check (jsonb_typeof(stages) = 'array'),
  fingerprint        jsonb not null default '{}'::jsonb check (jsonb_typeof(fingerprint) = 'object'),
  artifact_sha256    text check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by        uuid references core.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  check ((status = 'failed') = (failure_class is not null)),
  check (status <> 'succeeded' or (artifact_sha256 is not null and fingerprint <> '{}'::jsonb and jsonb_array_length(stages) > 0)),
  check ((attempt = 1) = (retry_of is null))
);
create index if not exists build_runs_build_idx on projects.build_runs (deliverable_id, created_at desc);
alter table projects.build_runs enable row level security;
drop policy if exists build_runs_read on projects.build_runs;
create policy build_runs_read on projects.build_runs for select to authenticated using (organization_id = (select core.current_organization_id()));
grant select on projects.build_runs to authenticated;
grant all on projects.build_runs to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('deliverable_id', 'projects.deliverables'), ('retry_of', 'projects.build_runs')) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.build_runs', 'build_runs_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.build_runs for each row execute function core.enforce_parent_org(%L, %L)',
                   'build_runs_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_build_runs on projects.build_runs;
create trigger freeze_org_build_runs before update of organization_id on projects.build_runs for each row execute function core.freeze_organization_id();

-- append-only; and the record never carries a secret value (a leaked key in a build log is a leak the moment it is stored)
create or replace function projects.build_runs_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_text text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'a build run is a record of what happened and is never edited or deleted' using errcode = 'restrict_violation';
  end if;
  v_text := coalesce(new.stages::text, '') || ' ' || coalesce(new.fingerprint::text, '');
  if v_text ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-\.]{12,}'
     or v_text ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})' then
    raise exception 'a build run must not carry a secret value: record the name of the variable, never its value' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists build_runs_guard on projects.build_runs;
create trigger build_runs_guard before insert or update or delete on projects.build_runs for each row execute function projects.build_runs_guard();

create or replace function projects.record_build_run(
  p_deliverable_id uuid, p_environment text, p_status text, p_failure_class text default null,
  p_stages jsonb default '[]', p_fingerprint jsonb default '{}', p_artifact_sha256 text default null, p_retry_of uuid default null
)
returns table (outcome text, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_row projects.deliverables;
  v_commit text;
  v_prev projects.build_runs;
  v_attempt int := 1;
  v_new uuid;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text, null::uuid; return; end if;
  if v_actor is not null and not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id;
  if v_row.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_actor is not null and v_row.organization_id is distinct from (select core.current_organization_id()) then return query select 'not_found'::text, null::uuid; return; end if;
  if v_row.kind <> 'build' then return query select 'wrong_kind'::text, null::uuid; return; end if;
  if v_row.status not in ('draft', 'changes_requested') then return query select 'build_already_shared'::text, null::uuid; return; end if;
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_row.id;
  if nullif(btrim(coalesce(v_commit, '')), '') is null then return query select 'no_commit'::text, null::uuid; return; end if;
  -- production is not a Phase 5 environment (also a CHECK on the table)
  if p_environment not in ('dev', 'review', 'staging', 'client_test') then return query select 'bad_environment'::text, null::uuid; return; end if;
  if p_status not in ('succeeded', 'failed') then return query select 'bad_status'::text, null::uuid; return; end if;

  if p_retry_of is not null then
    select * into v_prev from projects.build_runs r where r.id = p_retry_of and r.deliverable_id = v_row.id;
    if v_prev.id is null then return query select 'not_found'::text, null::uuid; return; end if;
    if v_prev.status <> 'failed' then return query select 'nothing_to_retry'::text, null::uuid; return; end if;
    -- a deterministic failure is the specialist's to fix, not the infrastructure's to repeat: only a transient failure retries, and only on the same commit
    if v_prev.failure_class <> 'infra_transient' then return query select 'not_retryable'::text, null::uuid; return; end if;
    if v_prev.commit_ref <> v_commit then return query select 'commit_changed'::text, null::uuid; return; end if;
    if v_prev.attempt >= 3 then return query select 'retries_exhausted'::text, null::uuid; return; end if;
    v_attempt := v_prev.attempt + 1;
  end if;

  insert into projects.build_runs (organization_id, project_id, deliverable_id, commit_ref, environment, attempt, retry_of, status, failure_class, stages, fingerprint, artifact_sha256, recorded_by)
  values (v_row.organization_id, v_row.project_id, v_row.id, v_commit, p_environment, v_attempt, p_retry_of, p_status, p_failure_class, coalesce(p_stages, '[]'), coalesce(p_fingerprint, '{}'), p_artifact_sha256, v_actor)
  returning id into v_new;

  perform core.record_audit(v_row.organization_id, 'build.run_recorded', 'build_run', v_new, null,
    jsonb_build_object('projectId', v_row.project_id, 'deliverableId', v_row.id, 'commit', v_commit, 'status', p_status, 'failureClass', p_failure_class, 'attempt', v_attempt));
  return query select 'recorded'::text, v_new;
end $$;
revoke all on function projects.record_build_run(uuid, text, text, text, jsonb, jsonb, text, uuid) from public, anon;
grant execute on function projects.record_build_run(uuid, text, text, text, jsonb, jsonb, text, uuid) to authenticated, service_role;

CREATE OR REPLACE FUNCTION projects.submit_deliverable(p_deliverable_id uuid, p_requested_by uuid DEFAULT NULL::uuid, p_summary text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, request_id uuid, status text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_row      projects.deliverables;
  v_approval record;
  v_blocking int;
  v_gate     record;
begin
  select d.* into v_row
    from projects.deliverables d
   where d.id = p_deliverable_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_row.status in ('approved', 'superseded') then
    return query select 'settled'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  if v_row.status = 'in_review' then
    return query select 'already_in_review'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  -- W4 (PDF SCR-037): a prototype build goes to the client on the normal path
  -- only when QA passed it AND Admin approved it. `send_prototype_for_client_review`
  -- is the one door that may override, and it does so as the owner with a reason
  -- on the audit trail.
  -- Phase 5: a DEVELOPMENT BUILD goes to the client on the same terms, with NO override door, and only when it resolves to an exact
  -- commit ("a review/client build must always resolve back to an exact commit").
  if v_row.kind = 'build' and not exists (
       select 1 from projects.deliverable_details dd where dd.deliverable_id = v_row.id and nullif(btrim(dd.commit_ref), '') is not null) then
    return query select 'no_commit'::text, null::uuid, v_row.status;
    return;
  end if;

  -- Phase 5 DevOps/Build: the exact commit has a SUCCEEDED build run that produced a hashed artifact in a recorded environment.
  if v_row.kind = 'build' and not exists (
       select 1 from projects.build_runs br
        join projects.deliverable_details dd on dd.deliverable_id = br.deliverable_id and dd.commit_ref = br.commit_ref
       where br.deliverable_id = v_row.id and br.status = 'succeeded' and br.artifact_sha256 is not null) then
    return query select 'no_build_run'::text, null::uuid, v_row.status;
    return;
  end if;

  -- Phase 5 Security & Code Review: the exact commit being shared has a PASSED independent review (projects.build_review_status).
  if v_row.kind = 'build' then
    select * into v_gate from projects.build_review_status(v_row.id);
    if v_gate.verdict is distinct from 'passed' then
      return query select ('review_' || coalesce(v_gate.verdict, 'missing'))::text, null::uuid, v_row.status;
      return;
    end if;
  end if;

  if (v_row.kind = 'build'
      or (v_row.kind = 'prototype' and coalesce(current_setting('app.prototype_send_override', true), '') <> 'on')) then
    select * into v_gate from projects.prototype_send_gate(v_row.id);
    if not coalesce(v_gate.qa_passed, false) then
      return query select 'not_qa_passed'::text, null::uuid, v_row.status;
      return;
    end if;
    if not coalesce(v_gate.admin_approved, false) then
      return query select 'not_admin_approved'::text, null::uuid, v_row.status;
      return;
    end if;
  end if;

  -- ARCHITECTURE.md §4.8. Checked under the same lock that will write the
  -- status, so a blocker raised while somebody was clicking submit still
  -- stops it.
  select count(*) into v_blocking from qa.blocking_defects(p_deliverable_id);

  if v_blocking > 0 then
    return query select 'blocked'::text, null::uuid, v_row.status;
    return;
  end if;

  select * into v_approval
    from approvals.request_approval(
      v_row.organization_id, 'deliverable', v_row.id,
      case when p_requested_by is null then 'system' else 'user' end,
      p_requested_by,
      coalesce(p_summary, v_row.kind || ' v' || v_row.version || ' — ' || v_row.title),
      jsonb_build_object(
        'kind', v_row.kind, 'version', v_row.version, 'title', v_row.title,
        'artifact_url', v_row.artifact_url, 'known_issues', v_row.known_issues
      ),
      null, 'client', null
    );

  if v_approval.outcome = 'no_policy' then
    return query select 'no_policy'::text, null::uuid, v_row.status;
    return;
  end if;

  update projects.deliverables
     set status = 'in_review',
         approval_request_id = v_approval.request_id
   where projects.deliverables.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'deliverable.submitted', 'deliverable', v_row.id,
    to_jsonb(v_row),
    jsonb_build_object('status', 'in_review', 'approval_request_id', v_approval.request_id)
  );

  -- ── the one addition: a generic, kind-agnostic event ────────────────────
  perform core.emit_event(
    v_row.organization_id, 'project.deliverable_submitted', 'deliverable', v_row.id,
    jsonb_build_object('kind', v_row.kind, 'version', v_row.version, 'projectId', v_row.project_id)
  );

  return query select 'submitted'::text, v_approval.request_id, 'in_review'::text;
end;
$function$;

revoke all on function projects.submit_deliverable(uuid, uuid, text) from public, anon;
grant execute on function projects.submit_deliverable(uuid, uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
