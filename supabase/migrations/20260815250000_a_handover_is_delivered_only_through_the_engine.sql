-- ═══════════════════════════════════════════════════════════════════════════
-- A handover is delivered and accepted only through the engine, not by hand.
--
-- The same class the deliverables fix (20260815210000) closed, on the sibling
-- table projects.handovers — which had NO status guard at all. Its write RLS is
-- can_manage_delivery() (owner, ops_admin, AND delivery_lead) and INSERT/UPDATE
-- are granted to authenticated, so a delivery_lead — trusted to run a delivery,
-- NOT to sign the client's acceptance — could PATCH the row straight over the
-- Data API.
--
-- The sanctioned state machine is `deliver_handover` (refuses an empty package,
-- refuses while an open blocker or major defect stands — §4.8/§20 — and raises a
-- client-audience approval for the acceptance, ADM-08d) and
-- `sync_handover_acceptance` (delivered → accepted only once that request is
-- approved). Without a guard, a delivery_lead could: INSERT a handover already
-- `delivered` with zero items (the empty-package refusal bypassed); or UPDATE it
-- to `accepted` with approval_request_id NULL (a fabricated client acceptance,
-- while an open blocker still stands). Both are load-bearing downstream: the
-- maintenance gate `enforce_post_handover` opens on status in
-- (delivered, accepted), `completion_summary` reports the project delivered, and
-- the client portal shows the client an "Accepted" it never gave.
--
-- The guard mirrors deliverables_guard: a handover is born `preparing`, and the
-- engine-mediated states can be reached only when approval_request_id points at
-- this handover's own client approval request in the matching state — so
-- deliver_handover and sync_handover_acceptance are the only ways in.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.handovers_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A handover is not born delivered or accepted.
    if new.status <> 'preparing' then
      raise exception 'a handover starts in preparing, not % — use deliver_handover', new.status
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  -- accepted is terminal.
  if old.status = 'accepted' and new.status is distinct from old.status then
    raise exception 'a handover is already accepted' using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status then
    if new.status = 'delivered' then
      if old.status <> 'preparing' then
        raise exception 'a handover is delivered only from preparing (was %)', old.status
          using errcode = 'restrict_violation';
      end if;
      if not exists (
        select 1 from approvals.approval_requests r
         where r.id = new.approval_request_id
           and r.organization_id = new.organization_id
           and r.subject_type = 'handover' and r.subject_id = new.id
           and r.state = 'pending'
      ) then
        raise exception 'a delivered handover must point at its own pending client approval — use deliver_handover'
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'accepted' then
      if old.status <> 'delivered' then
        raise exception 'a handover is accepted only from delivered (was %)', old.status
          using errcode = 'restrict_violation';
      end if;
      if not exists (
        select 1 from approvals.approval_requests r
         where r.id = new.approval_request_id
           and r.organization_id = new.organization_id
           and r.subject_type = 'handover' and r.subject_id = new.id
           and r.state = 'approved'
      ) then
        raise exception 'a handover is accepted only when its client approval is — use sync_handover_acceptance'
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'cancelled' then
      -- Cancellable from any non-terminal state (preparing or delivered).
      null;

    else
      -- 'preparing' is only the initial state; nothing returns to it.
      raise exception 'a handover cannot be moved to % by hand', new.status
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function projects.handovers_guard() is
  'Enforces the handover status graph: a handover is born preparing, reaches delivered/accepted only when approval_request_id points at its own client approval request in the matching state (pending for delivered, approved for accepted), and accepted is terminal — so deliver_handover and sync_handover_acceptance are the only ways in, and a direct PATCH cannot fabricate a delivery past the empty-package/QA gate or a client acceptance that never happened.';

drop trigger if exists handovers_guard on projects.handovers;
create trigger handovers_guard
  before insert or update on projects.handovers
  for each row execute function projects.handovers_guard();
