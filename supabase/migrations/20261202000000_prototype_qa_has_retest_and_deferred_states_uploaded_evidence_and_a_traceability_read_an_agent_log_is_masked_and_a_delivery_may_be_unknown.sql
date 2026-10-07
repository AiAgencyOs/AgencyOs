-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 round 4: QA / PM / Finance / Orchestrator rows that stayed open after round 3 (traceability rows P4-QAP-004, 019, 043; P4-PM-036; P4-FIN-042, 057;
-- P4-ORCH-026, T11). Additive: nothing here changes who may approve, verify or pay, and no existing function is rewritten except one text-spliced widening of
-- crm.mark_outbound_delivery (below).
--
--   * QA_RETEST and DEFERRED are states a defect can be IN. They are recorded beside the qa.defects status (which keeps its own CHECK), read through one derived
--     function, and moved by doors: a person asks QA to retest the exact fix build (p4s_request_defect_retest); only an Admin defers a defect, with a reason, and only
--     an Admin brings it back (p4s_defer_defect / p4s_undefer_defect). An agent never defers. Deferring does not edit the QA run, so it cannot make a build pass.
--   * PrototypeQAEvidence (QAP-043) can be an uploaded file: p4s_prototype_qa_evidence names an object in the project-files bucket under
--     <organization>/evidence/<qa run id>/<file>; p4s_attach_qa_evidence re-checks the tenant, the run, the kind of file, the size and the path.
--   * p4s_prototype_traceability(artifact) reads the matrix the upstream records already hold: scope item (requirement) -> feature -> screen -> designed states ->
--     built screen -> the QA check on that screen. A requirement with no screen, a screen not designed and a screen not built are gaps, not blanks.
--   * ai.agent_runs / ai.agent_steps (the model and tool logs) are masked in the database the way build logs are (projects.mask_secrets), string by string.
--   * an agent fallback considered for a disabled specialist is recorded (projects.fallback_records, task-less) by a service-only door.
--   * a message whose delivery is uncertain (the send timed out after it may have gone out) can be recorded `unknown`, with a note; it is settleable to sent or failed
--     and never counted as sent.
--   * the receipt page reads the receipt document and its delivery state in one internal-only function.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. defect lifecycle: QA_RETEST and DEFERRED ─────────────────────────────
alter table projects.p4q_prototype_defects
  add column if not exists retest_requested_at timestamptz,
  add column if not exists retest_requested_by uuid references core.users(id) on delete set null,
  add column if not exists deferred_at timestamptz,
  add column if not exists deferred_by uuid references core.users(id) on delete set null,
  add column if not exists deferral_reason text,
  add column if not exists deferred_until date,
  add column if not exists undeferred_at timestamptz;
alter table projects.p4q_prototype_defects drop constraint if exists p4s_deferral_shape;
alter table projects.p4q_prototype_defects add constraint p4s_deferral_shape check (
  (deferred_at is null) = (deferral_reason is null)
  and (deferral_reason is null or (length(btrim(deferral_reason)) between 10 and 1000 and not projects.p7_has_secret(deferral_reason))));

create or replace function projects.p4s_defect_lifecycle(p_defect_id uuid)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_pd  projects.p4q_prototype_defects;
  v_st  text;
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return null; end if;
  select * into v_pd from projects.p4q_prototype_defects p where p.defect_id = p_defect_id and p.organization_id = v_org;
  if v_pd.defect_id is null then return null; end if;
  select d.status into v_st from qa.defects d where d.id = p_defect_id;
  if v_pd.deferred_at is not null and (v_pd.undeferred_at is null or v_pd.undeferred_at < v_pd.deferred_at) then return 'deferred'; end if;
  if v_st = 'verified' then return 'verified'; end if;
  if v_st = 'wontfix' then return 'wont_fix'; end if;
  if v_st = 'fixed' then
    if v_pd.retest_result = 'pass' then return 'retest_passed'; end if;
    if v_pd.retest_requested_at is not null and v_pd.fix_declared_at is not null and v_pd.retest_requested_at >= v_pd.fix_declared_at then return 'qa_retest'; end if;
    return 'fix_ready';
  end if;
  return 'open';
end $$;
revoke all on function projects.p4s_defect_lifecycle(uuid) from public, anon, service_role;
grant execute on function projects.p4s_defect_lifecycle(uuid) to authenticated;
comment on function projects.p4s_defect_lifecycle(uuid) is 'QAP-019: the lifecycle state of a prototype defect - open, fix_ready, qa_retest, retest_passed, verified, deferred, wont_fix - derived from the qa.defects status and the p4q record, so no state can disagree with the record it is read from.';

-- a person (or the QA agent) asks for the exact fix build to be retested: FIX_READY becomes QA_RETEST
create or replace function projects.p4s_request_defect_retest(p_defect_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_pd    projects.p4q_prototype_defects;
  v_st    text;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text; return; end if;
  select * into v_pd from projects.p4q_prototype_defects p where p.defect_id = p_defect_id for update;
  if v_pd.defect_id is null then return query select 'unknown_defect'::text; return; end if;
  if v_actor is not null and (v_pd.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text; return;
  end if;
  if v_pd.deferred_at is not null and (v_pd.undeferred_at is null or v_pd.undeferred_at < v_pd.deferred_at) then return query select 'deferred'::text; return; end if;
  select d.status into v_st from qa.defects d where d.id = p_defect_id;
  if v_st <> 'fixed' or v_pd.fix_artifact_id is null then return query select 'no_fix_build'::text; return; end if;
  if v_pd.retest_result = 'pass' then return query select 'already_retested'::text; return; end if;
  if v_pd.retest_requested_at is not null and v_pd.retest_requested_at >= v_pd.fix_declared_at then return query select 'already_requested'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update projects.p4q_prototype_defects set retest_requested_at = clock_timestamp(), retest_requested_by = v_actor where defect_id = p_defect_id;
  perform core.record_audit(v_pd.organization_id, 'project.p4s_prototype_retest_requested', 'qa_defect', p_defect_id, null,
                            jsonb_build_object('projectId', v_pd.project_id, 'fixArtifactId', v_pd.fix_artifact_id));
  return query select 'requested'::text;
end $$;
revoke all on function projects.p4s_request_defect_retest(uuid) from public, anon;
grant execute on function projects.p4s_request_defect_retest(uuid) to authenticated, service_role;

-- only an Admin defers a defect, with a reason; an agent never does
create or replace function projects.p4s_defer_defect(p_defect_id uuid, p_reason text, p_until date default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_pd    projects.p4q_prototype_defects;
  v_st    text;
  v_why   text := btrim(coalesce(p_reason, ''));
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  select * into v_pd from projects.p4q_prototype_defects p where p.defect_id = p_defect_id and p.organization_id = (select core.current_organization_id()) for update;
  if v_pd.defect_id is null then return query select 'unknown_defect'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if length(v_why) < 10 then return query select 'reason_required'::text; return; end if;
  if projects.p7_has_secret(v_why) then return query select 'contains_secret'::text; return; end if;
  if p_until is not null and p_until <= current_date then return query select 'until_in_past'::text; return; end if;
  if v_pd.deferred_at is not null and (v_pd.undeferred_at is null or v_pd.undeferred_at < v_pd.deferred_at) then return query select 'already_deferred'::text; return; end if;
  select d.status into v_st from qa.defects d where d.id = p_defect_id;
  if v_st <> 'open' then return query select 'not_open'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update projects.p4q_prototype_defects set deferred_at = clock_timestamp(), deferred_by = v_actor, deferral_reason = left(v_why, 1000), deferred_until = p_until, undeferred_at = null where defect_id = p_defect_id;
  perform core.record_audit(v_pd.organization_id, 'project.p4s_prototype_defect_deferred', 'qa_defect', p_defect_id, null,
                            jsonb_build_object('projectId', v_pd.project_id, 'priority', v_pd.priority, 'until', p_until));
  return query select 'deferred'::text;
end $$;
revoke all on function projects.p4s_defer_defect(uuid, text, date) from public, anon, service_role;
grant execute on function projects.p4s_defer_defect(uuid, text, date) to authenticated;

create or replace function projects.p4s_undefer_defect(p_defect_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_pd    projects.p4q_prototype_defects;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  select * into v_pd from projects.p4q_prototype_defects p where p.defect_id = p_defect_id and p.organization_id = (select core.current_organization_id()) for update;
  if v_pd.defect_id is null then return query select 'unknown_defect'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if v_pd.deferred_at is null or (v_pd.undeferred_at is not null and v_pd.undeferred_at >= v_pd.deferred_at) then return query select 'not_deferred'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update projects.p4q_prototype_defects set undeferred_at = clock_timestamp() where defect_id = p_defect_id;
  perform core.record_audit(v_pd.organization_id, 'project.p4s_prototype_defect_undeferred', 'qa_defect', p_defect_id, null, jsonb_build_object('projectId', v_pd.project_id));
  return query select 'undeferred'::text;
end $$;
revoke all on function projects.p4s_undefer_defect(uuid) from public, anon, service_role;
grant execute on function projects.p4s_undefer_defect(uuid) to authenticated;

-- the board: every prototype defect of a project with its lifecycle state
create or replace function projects.p4s_prototype_defect_board(p_project_id uuid)
returns table (defect_id uuid, title text, priority text, check_key text, screen_key text, lifecycle text, artifact_id uuid, fix_artifact_id uuid, deferral_reason text, deferred_until date)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  select p.defect_id, d.title, p.priority, p.check_key, p.screen_key, projects.p4s_defect_lifecycle(p.defect_id), p.artifact_id, p.fix_artifact_id,
         case when p.deferred_at is not null and (p.undeferred_at is null or p.undeferred_at < p.deferred_at) then p.deferral_reason end,
         case when p.deferred_at is not null and (p.undeferred_at is null or p.undeferred_at < p.deferred_at) then p.deferred_until end
    from projects.p4q_prototype_defects p
    join qa.defects d on d.id = p.defect_id
   where p.project_id = p_project_id and p.organization_id = v_org
   order by p.priority, d.created_at desc;
end $$;
revoke all on function projects.p4s_prototype_defect_board(uuid) from public, anon, service_role;
grant execute on function projects.p4s_prototype_defect_board(uuid) to authenticated;

-- ── 2. uploaded evidence for a prototype QA run ─────────────────────────────
create table if not exists projects.p4s_prototype_qa_evidence (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  run_id           uuid not null references projects.p4q_prototype_qa_runs(id) on delete restrict,
  check_key        text,
  defect_id        uuid references qa.defects(id) on delete restrict,
  kind             text not null check (kind in ('screenshot', 'recording', 'log', 'report', 'other')),
  storage_path     text not null check (length(storage_path) between 1 and 600),
  file_name        text not null check (length(btrim(file_name)) between 1 and 200),
  content_type     text check (content_type is null or length(content_type) <= 150),
  size_bytes       bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  note             text check (note is null or (length(btrim(note)) between 1 and 500 and not projects.p7_has_secret(note))),
  uploaded_by      uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default clock_timestamp(),
  constraint p4s_evidence_path_is_tenant_scoped check (
    split_part(storage_path, '/', 1) = organization_id::text and split_part(storage_path, '/', 2) = 'evidence' and split_part(storage_path, '/', 3) = run_id::text),
  constraint p4s_evidence_kind_of_file check (lower(file_name) ~ '\.(png|jpe?g|gif|webp|heic|txt|log|md|json|csv|xml|html|pdf|zip|har|mp4|mov|webm)$')
);
comment on table projects.p4s_prototype_qa_evidence is 'QAP-043: an uploaded file (screenshot, recording, log, report) that belongs to one prototype QA run, optionally to one of its checks or to a defect it raised. The object lives in the project-files bucket under <organization>/evidence/<run id>/; this row names it. Append-only; written only by p4s_attach_qa_evidence.';
create index if not exists p4s_qa_evidence_run_idx on projects.p4s_prototype_qa_evidence (run_id, created_at);
select projects.p7_guard_fk('p4s_prototype_qa_evidence', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4s_prototype_qa_evidence', 'run_id', 'projects.p4q_prototype_qa_runs');
select projects.p7_guard_fk('p4s_prototype_qa_evidence', 'defect_id', 'qa.defects');
select projects.p7_harden('projects', 'p4s_prototype_qa_evidence');
drop trigger if exists p4s_prototype_qa_evidence_door_only on projects.p4s_prototype_qa_evidence;
create trigger p4s_prototype_qa_evidence_door_only before insert or update or delete on projects.p4s_prototype_qa_evidence for each row execute function projects.p4q_door_only();
drop trigger if exists p4s_qa_evidence_final on projects.p4s_prototype_qa_evidence;
create trigger p4s_qa_evidence_final before update on projects.p4s_prototype_qa_evidence for each row execute function projects.p4q_history_is_final();

create or replace function projects.p4s_attach_qa_evidence(
  p_run_id uuid, p_storage_path text, p_file_name text, p_kind text, p_content_type text default null, p_size_bytes bigint default null,
  p_check_key text default null, p_defect_id uuid default null, p_note text default null)
returns table (outcome text, evidence_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_run   projects.p4q_prototype_qa_runs;
  v_name  text := btrim(coalesce(p_file_name, ''));
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_id    uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'forbidden'::text, null::uuid; return; end if;
  select * into v_run from projects.p4q_prototype_qa_runs r where r.id = p_run_id and r.organization_id = v_org;
  if v_run.id is null then return query select 'unknown_run'::text, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('screenshot', 'recording', 'log', 'report', 'other') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 52428800 then return query select 'bad_size'::text, null::uuid; return; end if;
  if p_storage_path is null or split_part(p_storage_path, '/', 1) <> v_org::text or split_part(p_storage_path, '/', 2) <> 'evidence' or split_part(p_storage_path, '/', 3) <> p_run_id::text then
    return query select 'bad_path'::text, null::uuid; return;
  end if;
  if lower(v_name) !~ '\.(png|jpe?g|gif|webp|heic|txt|log|md|json|csv|xml|html|pdf|zip|har|mp4|mov|webm)$' then return query select 'bad_file_type'::text, null::uuid; return; end if;
  if lower(v_name) ~ '(^|[^a-z])(\.env|id_rsa|credentials|secret|password|private[_-]?key)' or projects.p7_has_secret(v_name) then return query select 'credential_name'::text, null::uuid; return; end if;
  if v_note is not null and projects.p7_has_secret(v_note) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if p_check_key is not null and not exists (select 1 from projects.p4q_prototype_qa_checks c where c.run_id = p_run_id and c.check_key = p_check_key) then return query select 'unknown_check'::text, null::uuid; return; end if;
  if p_defect_id is not null and not exists (select 1 from projects.p4q_prototype_defects d where d.defect_id = p_defect_id and d.run_id = p_run_id) then return query select 'defect_not_from_this_run'::text, null::uuid; return; end if;
  if (select count(*) from projects.p4s_prototype_qa_evidence e where e.run_id = p_run_id) >= 40 then return query select 'too_many_files'::text, null::uuid; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  insert into projects.p4s_prototype_qa_evidence (organization_id, project_id, run_id, check_key, defect_id, kind, storage_path, file_name, content_type, size_bytes, note, uploaded_by)
  values (v_org, v_run.project_id, p_run_id, p_check_key, p_defect_id, p_kind, p_storage_path, left(v_name, 200), left(p_content_type, 150), p_size_bytes, v_note, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'project.p4s_prototype_qa_evidence_attached', 'prototype_qa_run', p_run_id, null, jsonb_build_object('projectId', v_run.project_id, 'evidenceId', v_id, 'kind', p_kind));
  return query select 'attached'::text, v_id;
end $$;
revoke all on function projects.p4s_attach_qa_evidence(uuid, text, text, text, text, bigint, text, uuid, text) from public, anon, service_role;
grant execute on function projects.p4s_attach_qa_evidence(uuid, text, text, text, text, bigint, text, uuid, text) to authenticated;

-- ── 3. the traceability matrix, read from the records upstream already holds ─
create or replace function projects.p4s_prototype_traceability(p_artifact_id uuid)
returns table (scope_item_id uuid, requirement text, feature_id uuid, feature text, screen_key text, screen_designed boolean, designed_states text[], screen_built boolean, built_elements integer, qa_result text, gap text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_art projects.prototype_artifacts;
  v_ui  projects.ui_versions;
  v_sv  uuid;
  v_run uuid;
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  select * into v_art from projects.prototype_artifacts a where a.id = p_artifact_id and a.organization_id = v_org;
  if v_art.id is null then return; end if;
  select * into v_ui from projects.ui_versions u where u.id = v_art.ui_version_id;
  select sv.id into v_sv from projects.scope_versions sv where sv.project_id = v_art.project_id and sv.organization_id = v_org and sv.status = 'active';
  select r.id into v_run from projects.p4q_prototype_qa_runs r where r.artifact_id = p_artifact_id and r.outcome in ('qa_pass', 'qa_changes_required');
  return query
  with items as (
    select si.id, si.title, si.feature_id, f.name as feature_name from projects.scope_items si left join projects.features f on f.id = si.feature_id
     where si.scope_version_id = v_sv and si.inclusion <> 'excluded'),
  pairs as (
    select i.id as scope_item_id, i.title, i.feature_id, i.feature_name, s.screen_key as skey
      from items i left join projects.screen_scope_items ssi on ssi.scope_item_id = i.id left join projects.screens s on s.id = ssi.screen_id and s.project_id = v_art.project_id)
  select p.scope_item_id, p.title, p.feature_id, p.feature_name, p.skey,
         case when p.skey is null then null else exists (select 1 from jsonb_array_elements(v_ui.screens) x where x ->> 'screenKey' = p.skey) end,
         case when p.skey is null then null else (select coalesce(array_agg(st order by st), '{}') from jsonb_array_elements(v_ui.screens) x, jsonb_array_elements_text(coalesce(x -> 'statesAddressed', '[]'::jsonb)) st where x ->> 'screenKey' = p.skey) end,
         case when p.skey is null then null else exists (select 1 from jsonb_array_elements(v_art.screens) x where x ->> 'screenKey' = p.skey) end,
         case when p.skey is null then null else (select coalesce(jsonb_array_length(x -> 'elements'), 0) from jsonb_array_elements(v_art.screens) x where x ->> 'screenKey' = p.skey limit 1) end,
         case when p.skey is null or v_run is null then null else (select c.result from projects.p4q_prototype_qa_checks c where c.run_id = v_run and c.check_key = 'coverage:screen:' || p.skey) end,
         case when p.skey is null then 'no screen covers this requirement'
              when not exists (select 1 from jsonb_array_elements(v_ui.screens) x where x ->> 'screenKey' = p.skey) then 'the screen is not in the locked UI version'
              when not exists (select 1 from jsonb_array_elements(v_art.screens) x where x ->> 'screenKey' = p.skey) then 'the screen is not built in this prototype'
              when v_run is null then 'QA has not run on this build'
              else null end
    from pairs p
   order by p.title, p.skey;
end $$;
revoke all on function projects.p4s_prototype_traceability(uuid) from public, anon, service_role;
grant execute on function projects.p4s_prototype_traceability(uuid) to authenticated;
comment on function projects.p4s_prototype_traceability(uuid) is 'QAP-004: Requirement (active scope item) -> Feature -> Screen -> designed states -> built screen -> the QA check on that screen, read from the records upstream already holds. A requirement no screen covers, and a screen not designed or not built, are rows with a gap, never blanks.';

-- ── 4. the model and tool logs are masked in the database ──────────────────
create or replace function projects.p4s_mask_json(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare r jsonb;
begin
  if p is null then return null; end if;
  case jsonb_typeof(p)
    when 'string' then return to_jsonb(projects.mask_secrets(p #>> '{}'));
    when 'object' then
      select coalesce(jsonb_object_agg(e.k, projects.p4s_mask_json(e.v)), '{}'::jsonb) into r from jsonb_each(p) e(k, v);
      return r;
    when 'array' then
      select coalesce(jsonb_agg(projects.p4s_mask_json(e.v) order by e.ord), '[]'::jsonb) into r from jsonb_array_elements(p) with ordinality e(v, ord);
      return r;
    else return p;
  end case;
end $$;
revoke all on function projects.p4s_mask_json(jsonb) from public, anon;
grant execute on function projects.p4s_mask_json(jsonb) to authenticated, service_role;

create or replace function projects.p4s_mask_agent_run()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.input := projects.p4s_mask_json(new.input);
  new.output := projects.p4s_mask_json(new.output);
  if new.error is not null then new.error := projects.mask_secrets(new.error); end if;
  return new;
end $$;
revoke all on function projects.p4s_mask_agent_run() from public, anon, authenticated, service_role;
drop trigger if exists p4s_mask_agent_run on ai.agent_runs;
create trigger p4s_mask_agent_run before insert or update of input, output, error on ai.agent_runs for each row execute function projects.p4s_mask_agent_run();

create or replace function projects.p4s_mask_agent_step()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.request := projects.p4s_mask_json(new.request);
  new.response := projects.p4s_mask_json(new.response);
  if new.error is not null then new.error := projects.mask_secrets(new.error); end if;
  return new;
end $$;
revoke all on function projects.p4s_mask_agent_step() from public, anon, authenticated, service_role;
drop trigger if exists p4s_mask_agent_step on ai.agent_steps;
create trigger p4s_mask_agent_step before insert or update of request, response, error on ai.agent_steps for each row execute function projects.p4s_mask_agent_step();

-- ── 5. an agent fallback considered for a disabled specialist is recorded ──
create or replace function projects.p4s_record_agent_fallback(p_project_id uuid, p_primary_agent text, p_fallback_agent text, p_reason text, p_violations jsonb default '[]'::jsonb, p_failure_class text default 'disabled_specialist')
returns table (outcome text, fallback_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid; v_outcome text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null then return query select 'not_found'::text, null::uuid; return; end if;
  if p_violations is null or jsonb_typeof(p_violations) <> 'array' or p_reason is null or length(btrim(p_reason)) = 0 then return query select 'bad_input'::text, null::uuid; return; end if;
  if p_primary_agent is not distinct from p_fallback_agent then return query select 'same_agent'::text, null::uuid; return; end if;
  -- a redelivered hop considers the same fallback once, not once per delivery
  select f.id into v_id from projects.fallback_records f
   where f.project_id = p_project_id and f.task_id is null and f.primary_agent = btrim(p_primary_agent) and f.fallback_agent = btrim(p_fallback_agent)
     and f.failure_class is not distinct from p_failure_class and f.created_at > now() - interval '1 day';
  if v_id is not null then return query select 'already_recorded'::text, v_id; return; end if;
  v_outcome := case when jsonb_array_length(p_violations) = 0 then 'accepted' else 'rejected' end;
  begin
    insert into projects.fallback_records (organization_id, project_id, task_id, primary_agent, fallback_agent, failure_class, reason, violations, outcome)
    values (v_org, p_project_id, null, btrim(p_primary_agent), btrim(p_fallback_agent), p_failure_class, left(btrim(p_reason), 500), p_violations, v_outcome) returning id into v_id;
  exception when check_violation or not_null_violation then return query select 'bad_input'::text, null::uuid; return;
  end;
  perform core.record_audit(v_org, 'orchestrator.fallback_' || v_outcome, 'fallback_record', v_id, null,
                            jsonb_build_object('projectId', p_project_id, 'primary', p_primary_agent, 'fallback', p_fallback_agent, 'violations', p_violations));
  return query select v_outcome, v_id;
end $$;
revoke all on function projects.p4s_record_agent_fallback(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function projects.p4s_record_agent_fallback(uuid, text, text, text, jsonb, text) to service_role;

-- ── 6. an uncertain delivery can be recorded `unknown` ─────────────────────
-- Spliced into the LIVE definition (the sanctioned-write line and every other branch stay exactly as they are): `unknown` is accepted with a note, may be settled
-- to sent or failed later, and `sent` stays terminal.
do $mig$
declare
  v_def text;
  v_new text;
  v_a text := $a$if p_status not in ('sent', 'failed') then
    raise exception 'delivery status must be sent or failed, not %', p_status
      using errcode = 'check_violation';
  end if;$a$;
  v_b text := $b$and metadata->>'delivery' in ('pending', 'failed')$b$;
begin
  v_def := pg_get_functiondef('crm.mark_outbound_delivery(uuid,text,text,text)'::regprocedure);
  -- re-applying is a no-op once the live definition already accepts `unknown`
  if position($u$('sent', 'failed', 'unknown')$u$ in v_def) > 0 then return; end if;
  if position(v_a in v_def) = 0 then raise exception 'mark_outbound_delivery: status guard not found'; end if;
  if position(v_b in v_def) = 0 then raise exception 'mark_outbound_delivery: settleable list not found'; end if;
  v_new := replace(v_def, v_a, $n$if p_status not in ('sent', 'failed', 'unknown') then
    raise exception 'delivery status must be sent, failed or unknown, not %', p_status
      using errcode = 'check_violation';
  end if;
  if p_status = 'unknown' and nullif(btrim(coalesce(p_error, '')), '') is null then
    raise exception 'an unknown delivery needs a note saying why it is unknown'
      using errcode = 'check_violation';
  end if;$n$);
  v_new := replace(v_new, v_b, $m$and metadata->>'delivery' in ('pending', 'failed', 'unknown')$m$);
  execute v_new;
end $mig$;

-- ── 7. the receipt page: the document and its delivery state, internal only ─
create or replace function finance.p4s_receipt_page(p_receipt_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_doc jsonb;
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return null; end if;
  v_doc := finance.p4q_receipt_document(p_receipt_id);
  if v_doc is null then return null; end if;
  return jsonb_build_object('document', v_doc, 'deliveries', coalesce((
    select jsonb_agg(jsonb_build_object('channel', d.channel, 'state', d.state, 'evidence', d.evidence, 'attempts', d.attempts, 'updatedAt', d.updated_at) order by d.channel)
      from finance.p4q_receipt_deliveries d where d.receipt_id = p_receipt_id and d.organization_id = v_org), '[]'::jsonb));
end $$;
revoke all on function finance.p4s_receipt_page(uuid) from public, anon, service_role;
grant execute on function finance.p4s_receipt_page(uuid) to authenticated;

notify pgrst, 'reload schema';
