-- Phase 4 master checklist, P4-INFRA-03: a formal state machine.
--
-- `projects.ui_versions.status` (20260923110000) already names a full
-- 11-value CHECK constraint, but nothing enforces which values may follow
-- which — every door that writes it already checks the row's CURRENT status
-- before writing (each guarded with its own `if v_version.status <> '...'
-- then return 'wrong_state'`), but that guard lives in application code, one
-- door at a time, and a bug in a FUTURE door — or a hand-run UPDATE — could
-- still jump a version straight to `locked` from `draft`. This is the
-- database-layer twin of those door guards, mirroring
-- `20260815210000_a_deliverable_is_approved_only_through_the_engine.sql`'s
-- own transition-graph trigger exactly.
--
-- The graph below is not designed — it is READ, off every door that writes
-- this column today:
--   draft            -> qa_pass | qa_changes_required   (record_ui_version_qa_verdict, 20260923120000)
--   qa_pass          -> admin_review                     (request-admin-review door, 20260923130000)
--   admin_review     -> admin_approved | admin_edit      (sync_ui_version_decision, 20260923130000)
--   admin_approved   -> client_review                    (share_ui_version_with_client, 20260923140000)
--   client_review    -> client_approved | client_change  (record_ui_version_client_decision, 20260923140000)
--   client_change    -> client_approved                  (a second round through the same door)
--   client_approved  -> locked                           (lock_ui_version, 20260923140000)
--
-- `qa_changes_required`, `client_change` and `admin_edit` are TERMINAL for
-- the row they land on — `revise_ui_version` (20260924100000/120000/140000)
-- starts the next round as a NEW row (version + 1), never mutates the old
-- one further. `qa_review` is a declared value no door ever writes; it is
-- not a reachable state and is not given an edge here.

create or replace function projects.enforce_ui_version_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status in ('qa_pass', 'qa_changes_required'))
      or (old.status = 'qa_pass' and new.status = 'admin_review')
      or (old.status = 'admin_review' and new.status in ('admin_approved', 'admin_edit'))
      or (old.status = 'admin_approved' and new.status = 'client_review')
      or (old.status = 'client_review' and new.status in ('client_approved', 'client_change'))
      or (old.status = 'client_change' and new.status = 'client_approved')
      or (old.status = 'client_approved' and new.status = 'locked')
    ) then
      raise exception 'a UI version cannot move from % to % — revise_ui_version starts a new round instead of mutating this one', old.status, new.status
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

comment on function projects.enforce_ui_version_status_transition() is
  'P4-INFRA-03. The database-layer twin of every ui_versions door''s own "if status <> X then wrong_state" guard: pins the transition graph those doors already enforce one at a time, so a future door or a hand-run UPDATE cannot skip QA, Admin review, the client decision or the lock. Read off the doors, not designed — see this migration''s own header for the trace. qa_changes_required/client_change/admin_edit are terminal for a row; revise_ui_version starts the next round as a new row.';

drop trigger if exists ui_versions_status_transition on projects.ui_versions;
create trigger ui_versions_status_transition
  before update on projects.ui_versions
  for each row execute function projects.enforce_ui_version_status_transition();

-- ═══════════════════════════════════════════════════════════════════════════
-- projects.prototype_artifacts gets the status column its own QA lifecycle
-- never had — today it is inferred only from `qa_reviewed_at is null`, which
-- cannot distinguish "not yet reviewed" from any richer future state, and
-- carries no explicit outcome value the way `ui_versions.status` does.
--
-- Deliberately a SMALLER vocabulary than ui_versions: this table has no
-- lifecycle of its own beyond QA coverage (client/admin review states live on
-- the linked `projects.deliverables.status`, already guarded since
-- 20260815210000 — this column must not duplicate that machine).
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.prototype_artifacts
  add column status text not null default 'draft'
    check (status in ('draft', 'qa_pass', 'qa_changes_required'));

update projects.prototype_artifacts
   set status = coalesce(qa_findings ->> 'outcome', case when qa_reviewed_at is not null then 'qa_pass' else 'draft' end)
 where qa_reviewed_at is not null;

comment on column projects.prototype_artifacts.status is
  'P4-INFRA-03. draft until QA reviews it, then qa_pass/qa_changes_required — written by record_prototype_qa_verdict in lockstep with qa_findings/qa_reviewed_at. Client/admin review status lives on the linked deliverables row, not here.';

create or replace function projects.enforce_prototype_artifact_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not (old.status = 'draft' and new.status in ('qa_pass', 'qa_changes_required')) then
      raise exception 'a prototype artifact cannot move from % to % — revise_prototype_build starts a new round instead of mutating this one', old.status, new.status
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists prototype_artifacts_status_transition on projects.prototype_artifacts;
create trigger prototype_artifacts_status_transition
  before update on projects.prototype_artifacts
  for each row execute function projects.enforce_prototype_artifact_status_transition();

create or replace function projects.record_prototype_qa_verdict(
  p_prototype_artifact_id uuid,
  p_outcome               text,
  p_findings              jsonb
)
returns table (
  -- 'recorded' | 'already_reviewed' | 'unknown_artifact' | 'bad_outcome'
  -- | 'no_actor' | 'forbidden'
  outcome               text,
  prototype_artifact_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_artifact projects.prototype_artifacts;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if p_outcome not in ('qa_pass', 'qa_changes_required') then
    return query select 'bad_outcome'::text, null::uuid; return;
  end if;

  select a.* into v_artifact
    from projects.prototype_artifacts a
   where a.id = p_prototype_artifact_id
   for update;

  if v_artifact.id is null then
    return query select 'unknown_artifact'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_artifact.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_artifact.qa_reviewed_at is not null then
    -- Master §22's idempotent-replay shape: a redelivered event must not
    -- overwrite an existing verdict with a second, possibly different one.
    return query select 'already_reviewed'::text, v_artifact.id; return;
  end if;

  update projects.prototype_artifacts
     set status = p_outcome,
         qa_findings = p_findings,
         qa_reviewed_at = now()
   where id = v_artifact.id;

  perform core.record_audit(
    v_artifact.organization_id, 'project.prototype_qa_reviewed', 'prototype_artifact', v_artifact.id, null,
    jsonb_build_object('projectId', v_artifact.project_id, 'outcome', p_outcome)
  );

  perform core.emit_event(
    v_artifact.organization_id, 'project.prototype_qa_reviewed',
    'prototype_artifact', v_artifact.id,
    jsonb_build_object('projectId', v_artifact.project_id, 'deliverableId', v_artifact.deliverable_id, 'outcome', p_outcome)
  );

  return query select 'recorded'::text, v_artifact.id;
end;
$$;

comment on function projects.record_prototype_qa_verdict(uuid, text, jsonb) is
  'QAP section 7. Independent Prototype QA reached a coverage verdict on a build: qa_pass or qa_changes_required. Decided by quality_assurance, never by ui_prototype (ADM-82). P4-INFRA-03: now writes status alongside qa_findings/qa_reviewed_at, guarded by prototype_artifacts_status_transition.';
