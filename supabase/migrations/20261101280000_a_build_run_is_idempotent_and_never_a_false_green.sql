-- Build pipeline hardening (P509 review): idempotent recording, no false green, no deploy dressed as a build, a person's success needs evidence.
alter table projects.build_runs
  add column if not exists idempotency_key text,
  add column if not exists manual boolean not null default false,
  add column if not exists evidence_url text;
create unique index if not exists build_runs_idempotency_key on projects.build_runs (deliverable_id, idempotency_key) where idempotency_key is not null;

drop function if exists projects.record_build_run(uuid, text, text, text, jsonb, jsonb, text, uuid);
CREATE OR REPLACE FUNCTION projects.record_build_run(p_deliverable_id uuid, p_environment text, p_status text, p_failure_class text DEFAULT NULL::text, p_stages jsonb DEFAULT '[]'::jsonb, p_fingerprint jsonb DEFAULT '{}'::jsonb, p_artifact_sha256 text DEFAULT NULL::text, p_retry_of uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_evidence_url text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, run_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_row projects.deliverables;
  v_commit text;
  v_prev projects.build_runs;
  v_attempt int := 1;
  v_new uuid;
  v_existing uuid;
  v_stage jsonb;
  v_names text[] := '{}';
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

  -- a replayed request (same idempotency key on the same build) answers with the run it already made
  if p_idempotency_key is not null then
    select r.id into v_existing from projects.build_runs r where r.deliverable_id = v_row.id and r.idempotency_key = p_idempotency_key;
    if v_existing is not null then return query select 'already_recorded'::text, v_existing; return; end if;
  end if;

  -- the stage list is a record of what ran: every stage is named and has a known status; a succeeded run hides no failed required stage and
  -- contains the stages that make an artifact an artifact
  if jsonb_typeof(coalesce(p_stages, '[]'::jsonb)) <> 'array' then return query select 'bad_stages'::text, null::uuid; return; end if;
  for v_stage in select * from jsonb_array_elements(coalesce(p_stages, '[]'::jsonb)) loop
    if jsonb_typeof(v_stage) <> 'object' or nullif(btrim(coalesce(v_stage ->> 'name', '')), '') is null
       or coalesce(v_stage ->> 'status', '') not in ('passed', 'ok', 'failed', 'skipped', 'blocked') then
      return query select 'bad_stages'::text, null::uuid; return;
    end if;
    v_names := v_names || (v_stage ->> 'name');
    if p_status = 'succeeded' and coalesce((v_stage ->> 'required')::boolean, true) and v_stage ->> 'status' in ('failed', 'blocked') then
      return query select 'failed_required_stage'::text, null::uuid; return;
    end if;
  end loop;
  if p_status = 'succeeded' and not (v_names @> array['build', 'artifact_verify']) then return query select 'missing_mandatory_stages'::text, null::uuid; return; end if;
  -- a build never deploys or publishes: nothing in the recorded command says it does
  if lower(coalesce(p_fingerprint ->> 'command', '') || ' ' || coalesce(p_fingerprint ->> 'build_command', '') || ' ' || coalesce(p_stages::text, ''))
       ~ '(vercel +(deploy|--prod)|gh +release|fastlane +(supply|pilot|deliver)|npm +publish|kubectl +apply|terraform +apply|git +push|--deploy)' then
    return query select 'deploy_is_not_a_build'::text, null::uuid; return;
  end if;
  if p_fingerprint ? 'commit' and p_fingerprint ->> 'commit' is distinct from v_commit then return query select 'fingerprint_commit_mismatch'::text, null::uuid; return; end if;
  -- a person does not stand in for the build worker: a hand-recorded SUCCESS names the evidence it rests on and is marked manual
  if v_actor is not null and p_status = 'succeeded' and (p_evidence_url is null or p_evidence_url !~ '^https://') then
    return query select 'manual_success_needs_evidence'::text, null::uuid; return;
  end if;

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

  insert into projects.build_runs (organization_id, project_id, deliverable_id, commit_ref, environment, attempt, retry_of, status, failure_class, stages, fingerprint, artifact_sha256, recorded_by, idempotency_key, manual, evidence_url)
  values (v_row.organization_id, v_row.project_id, v_row.id, v_commit, p_environment, v_attempt, p_retry_of, p_status, p_failure_class, coalesce(p_stages, '[]'), coalesce(p_fingerprint, '{}'), p_artifact_sha256, v_actor, p_idempotency_key, v_actor is not null, p_evidence_url)
  returning id into v_new;

  perform core.record_audit(v_row.organization_id, 'build.run_recorded', 'build_run', v_new, null,
    jsonb_build_object('projectId', v_row.project_id, 'deliverableId', v_row.id, 'commit', v_commit, 'status', p_status, 'failureClass', p_failure_class, 'attempt', v_attempt));
  return query select 'recorded'::text, v_new;
end $function$

;
revoke all on function projects.record_build_run(uuid, text, text, text, jsonb, jsonb, text, uuid, text, text) from public, anon;
grant execute on function projects.record_build_run(uuid, text, text, text, jsonb, jsonb, text, uuid, text, text) to authenticated, service_role;
notify pgrst, 'reload schema';
