-- ═══════════════════════════════════════════════════════════════════════════
-- A deliverable is approved only through the engine; a project is signed off
-- only by the role that may.
--
-- Two authorization holes an audit found in the delivery state machine, both of
-- the same shape as the ones already closed this run: a DB write path that is
-- reachable directly over PostgREST and trusted the application to enforce a
-- rule it did not enforce itself.
--
-- ── 1. projects.deliverables_guard did not enforce the transition graph ────
--
-- Unlike qa.defects_guard and approvals.approval_requests_guard, the deliverable
-- guard only froze the immutable fields and blocked LEAVING approved/superseded.
-- It never checked that a status CHANGE was a legal one. `projects_write` RLS
-- admits `can_manage_delivery()` (owner, ops_admin, delivery_lead) and the table
-- grants UPDATE to authenticated, so a delivery_lead could PATCH a deliverable
-- straight from `draft` to `approved` with a single write — skipping the QA
-- blocking-defect gate (ARCHITECTURE §4.8), the whole approval engine, and the
-- client's decision (ADM-08d). And `approved` is load-bearing downstream: it
-- satisfies `finance.issue_invoice`'s G-100 gate (a milestone whose
-- `requires_deliverable_id` resolves to an approved deliverable becomes
-- billable) and `projects.production_readiness.build_approved`. So one direct
-- write could make a client invoice issuable and a project markable production
-- ready for a build the client never saw and that still had an open blocker.
--
-- The sanctioned path moves a deliverable in lockstep with a client approval
-- request: `submit_deliverable` sets `in_review` and links a freshly-created
-- PENDING request (after the blocking-defect check); `sync_deliverable_decision`
-- sets `approved` / `changes_requested` only once that linked request has
-- settled. The guard now requires exactly that linkage, so the engine-mediated
-- states cannot be reached by hand. The two sanctioned functions still pass —
-- they set status and approval_request_id together, or move in step with the
-- request they already point at — and version-supersession (a system action on
-- earlier versions) stays allowed.
--
-- ── 2. projects.mark_production_ready had no in-DB role check ──────────────
--
-- ADM-19's sign-off is `project.sign_off`, which the capability model grants to
-- owner and ops_admin and DELIBERATELY withholds from delivery_lead — "a
-- delivery lead declaring their own work production ready is the review signing
-- its own homework." The TS wrapper enforces it, but the function is SECURITY
-- INVOKER, granted to authenticated, and its write is gated only by
-- `projects_write` RLS = `can_manage_delivery()` — which INCLUDES delivery_lead.
-- So a delivery_lead could skip the wrapper and sign off its own project by
-- calling the RPC directly. The function now makes the same check
-- `decide_approval` does: a session caller must be owner or ops_admin, answered
-- `not_found` otherwise so nothing leaks; the service role is unrestricted.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.deliverables_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
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
  'Freezes a deliverable''s content, keeps approved/superseded terminal, and enforces the status transition graph: the engine-mediated states (in_review, approved, changes_requested) can be reached only when approval_request_id points at this deliverable''s own client approval request in the matching state — so submit_deliverable and sync_deliverable_decision are the only ways in, and a direct PATCH cannot approve a build past the QA gate, the approval engine and the client (§4.8, ADM-08d).';

create or replace function projects.mark_production_ready(p_project_id uuid)
returns table (
  -- 'ready' | 'already_ready' | 'not_found' | 'not_ready'
  outcome text,
  unmet   text[]
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ready_at timestamptz;
  v_state    record;
  v_unmet    text[] := '{}';
begin
  -- ADM-19's sign-off is project.sign_off (owner, ops_admin) — deliberately not
  -- delivery_lead, who would otherwise sign off their own work. RLS on the write
  -- below (can_manage_delivery) admits delivery_lead, so the role is checked
  -- here too: a session caller who is not owner/ops_admin is answered not_found,
  -- so a direct RPC cannot slip past the wrapper's capability gate. The service
  -- role (null current_organization_id) is unrestricted.
  if core.current_organization_id() is not null
     and core.current_user_role() not in ('owner', 'ops_admin') then
    return query select 'not_found'::text, '{}'::text[];
    return;
  end if;

  select p.production_ready_at into v_ready_at
    from projects.projects p
   where p.id = p_project_id
     for update;

  if not found then
    return query select 'not_found'::text, '{}'::text[];
    return;
  end if;

  -- Marking a marked project is the answer, not an error, and it must not move
  -- the date: the moment it became ready is the moment it first did.
  if v_ready_at is not null then
    return query select 'already_ready'::text, '{}'::text[];
    return;
  end if;

  select * into v_state from projects.production_readiness(p_project_id);

  if not v_state.no_open_blockers then
    v_unmet := v_unmet || 'open_blockers'::text;
  end if;
  if not v_state.no_open_majors then
    v_unmet := v_unmet || 'open_majors'::text;
  end if;
  if not v_state.build_approved then
    v_unmet := v_unmet || 'no_approved_build'::text;
  end if;

  -- No override. ADM-19 gave two conditions and did not offer a way past them,
  -- and unlike a project start — which the owner may force because a client is
  -- waiting — nothing downstream is blocked by a project that is not yet
  -- production ready. Adding an escape hatch nobody asked for would be
  -- inventing policy.
  if array_length(v_unmet, 1) is not null then
    return query select 'not_ready'::text, v_unmet;
    return;
  end if;

  update projects.projects
     set production_ready_at = now(),
         updated_at          = now()
   where id = p_project_id;

  -- The audit row is written by the G-093 trigger, from inside this
  -- transaction, and records the whole row.

  return query select 'ready'::text, '{}'::text[];
end;
$$;

comment on function projects.mark_production_ready(uuid) is
  'Marks a project production ready when ADM-19''s conditions hold (no open blockers or majors, an approved build). No override. Caller-scoped: a session caller must hold project.sign_off (owner or ops_admin, checked by role here as well as in the wrapper, because RLS on the write admits delivery_lead too); the service role is unrestricted. Answers not_found to a caller who may not sign off, so nothing leaks.';

revoke all on function projects.mark_production_ready(uuid) from public, anon;
grant execute on function projects.mark_production_ready(uuid) to authenticated, service_role;
