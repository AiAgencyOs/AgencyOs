-- ═══════════════════════════════════════════════════════════════════════════
-- A deliverable is not born approved: the INSERT vector the transition graph
-- left open.
--
-- 20260815210000 (#181) gave projects.deliverables_guard the status TRANSITION
-- graph, so a delivery_lead can no longer PATCH a deliverable from draft to
-- approved over the Data API. But that trigger fires BEFORE UPDATE only, and
-- the same forgery is reachable one step to the side: a direct INSERT.
--
-- deliverables_write is `organization_id = current_organization_id() AND
-- can_manage_delivery()` — owner, ops_admin AND delivery_lead — and INSERT is
-- granted to authenticated. `status` defaults to 'draft' but the default is
-- overridable, and deliverables_status_check permits 'approved'. So a
-- delivery_lead — trusted to run a delivery, NOT to sign the client's approval
-- of it — could POST /rest/v1/deliverables with status='approved' and
-- approval_request_id NULL, fabricating a client-approved build in one write,
-- skipping the QA blocking-defect gate (§4.8), the whole approval engine and
-- the client's decision (ADM-08d). This is not idle: an approved `build`
-- deliverable is load-bearing downstream —
--   * production_readiness.build_approved reads `kind='build' AND
--     status='approved'`, so mark_production_ready (ADM-19) would pass on a
--     build the client never approved;
--   * G-100 (approval_permits_the_invoice) makes a client milestone invoice
--     issuable once the deliverable is approved, so forged approval unlocks a
--     real bill.
--
-- The transition graph closed the UPDATE door and left the INSERT door open.
-- The sibling guards written since — handovers_guard (20260815250000) and
-- proposals_guard (20260815260000) — both force the initial status on INSERT;
-- deliverables_guard, older, did not, because its trigger never fired on
-- INSERT at all. This gives it the same INSERT branch and widens the trigger
-- to INSERT OR UPDATE, so a deliverable is born 'draft' and reaches every other
-- state only through submit_deliverable / sync_deliverable_decision, exactly as
-- the UPDATE graph already requires.
--
-- The two RPCs that legitimately create a deliverable — add_deliverable and its
-- module-scoped sibling — insert without naming status, so they take the
-- 'draft' default and are unaffected. This closes a hole and moves nothing that
-- was working.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.deliverables_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A deliverable is drafted, never born approved/in_review/superseded. Every
    -- other state is the engine's to grant, in lockstep with a client approval.
    if new.status <> 'draft' then
      raise exception 'a deliverable is created as a draft, not % — use add_deliverable', new.status
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
     or new.project_id   is distinct from old.project_id
     or new.kind         is distinct from old.kind
     or new.version      is distinct from old.version
     or new.title        is distinct from old.title
     or new.artifact_url is distinct from old.artifact_url
     or new.changelog    is distinct from old.changelog
     or new.known_issues is distinct from old.known_issues
     or new.test_access_method is distinct from old.test_access_method
     or new.created_by   is distinct from old.created_by
     or new.created_at   is distinct from old.created_at
  then
    raise exception
      'deliverable %s v% is immutable; submit version % instead',
      old.kind, old.version, old.version + 1
      using errcode = 'restrict_violation';
  end if;

  if old.status in ('approved', 'superseded') and new.status is distinct from old.status then
    raise exception 'deliverable %s v% is already %', old.kind, old.version, old.status
      using errcode = 'restrict_violation';
  end if;

  -- The transition graph and its approval linkage. A deliverable reaches the
  -- engine-mediated states only through submit_deliverable and
  -- sync_deliverable_decision, which move it in lockstep with a client approval
  -- request — so a direct write cannot skip the QA gate, the engine or the
  -- client's decision.
  if new.status is distinct from old.status then
    if new.status = 'in_review' then
      if old.status not in ('draft', 'changes_requested') then
        raise exception 'a deliverable enters review only from draft or changes_requested (was %)', old.status
          using errcode = 'restrict_violation';
      end if;
      if not exists (
        select 1 from approvals.approval_requests r
         where r.id = new.approval_request_id
           and r.organization_id = new.organization_id
           and r.subject_type = 'deliverable' and r.subject_id = new.id
           and r.state = 'pending'
      ) then
        raise exception 'a deliverable in review must point at its own pending client approval — use submit_deliverable'
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'approved' then
      if old.status <> 'in_review' then
        raise exception 'a deliverable is approved only from review (was %)', old.status
          using errcode = 'restrict_violation';
      end if;
      if not exists (
        select 1 from approvals.approval_requests r
         where r.id = new.approval_request_id
           and r.organization_id = new.organization_id
           and r.subject_type = 'deliverable' and r.subject_id = new.id
           and r.state = 'approved'
      ) then
        raise exception 'a deliverable is approved only when its client approval is — use sync_deliverable_decision'
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'changes_requested' then
      if old.status <> 'in_review' then
        raise exception 'changes are requested only from review (was %)', old.status
          using errcode = 'restrict_violation';
      end if;
      if not exists (
        select 1 from approvals.approval_requests r
         where r.id = new.approval_request_id
           and r.organization_id = new.organization_id
           and r.subject_type = 'deliverable' and r.subject_id = new.id
           and r.state in ('rejected', 'changes_requested')
      ) then
        raise exception 'changes are recorded only when the client requests them — use sync_deliverable_decision'
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'superseded' then
      -- sync_deliverable_decision retires earlier versions when a newer one is
      -- approved; reachable from any non-terminal state, so allowed.
      null;

    else
      -- 'draft' is only the initial state; nothing transitions back to it.
      raise exception 'a deliverable cannot be moved to % by hand', new.status
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function projects.deliverables_guard() is
  'Enforces the deliverable status graph on INSERT and UPDATE: a deliverable is born draft and reaches the engine-mediated states (in_review, approved, changes_requested) only when approval_request_id points at its own client approval request in the matching state — so add_deliverable / submit_deliverable / sync_deliverable_decision are the only ways through, and neither a direct PATCH nor a direct INSERT can fabricate a client-approved build that skips the QA gate, the engine or the client''s decision (the INSERT half closes the vector the UPDATE-only transition graph of 20260815210000 left open).';

drop trigger if exists deliverables_guard on projects.deliverables;
create trigger deliverables_guard
  before insert or update on projects.deliverables
  for each row execute function projects.deliverables_guard();
