-- ═══════════════════════════════════════════════════════════════════════════
-- Nobody answered.
--
-- Gap G-096, and the half of ADM-08c that was left unbuilt when the approval
-- engine landed: *"an unanswered request expires and escalates to the owner.
-- It is never auto-approved."* The state existed, the deadline existed, and
-- nothing walked them — so `/approvals` marked a request overdue in red and
-- said, honestly, that nobody had been told.
--
-- ── the escalation is a new request, not a rewritten one ──────────────────
--
-- The original is settled `expired` and stays exactly as it was: it records
-- that this person, at this level, did not answer in the time their own policy
-- allowed. A fresh request carries `escalated_from` back to it, so a chain of
-- silence reads as one story rather than three unrelated rows.
--
-- Rewriting the original instead — moving its required_role up and clearing
-- its deadline — would have been fewer rows and would have destroyed the only
-- evidence that anybody missed anything.
--
-- ── it cannot approve anything, and that is structural ────────────────────
--
-- Directive §29: absence of a response is never approval. This function writes
-- `expired` and inserts a new `pending`. There is no code path from here to
-- `approved`, and `decide_approval` — the only thing that can write it —
-- refuses a caller with no identity, which a cron tick is.
--
-- ── the owner is where it stops ───────────────────────────────────────────
--
-- An escalation names `owner` because there is nowhere above it in the role
-- model, so an escalated request cannot escalate again into an infinite
-- ladder: the guard is that `required_role = 'owner'` is already the top, and
-- a request that has been escalated once is not escalated twice
-- (`escalated_from is null` in the claim).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function approvals.expire_overdue(p_limit int default 50)
returns table (
  expired_id     uuid,
  escalation_id  uuid,
  subject_type   text,
  organization_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row approvals.approval_requests;
  v_new approvals.approval_requests;
begin
  for v_row in
    select r.*
      from approvals.approval_requests r
     where r.state = 'pending'
       and r.sla_due_at < now()
       -- Once. An escalation that goes unanswered is the owner's silence, and
       -- there is nobody above the owner to tell.
       and r.escalated_from is null
     order by r.sla_due_at
     limit p_limit
     -- Two cron invocations overlapping must not both expire the same request
     -- and raise two escalations. The second steps over a held row.
     for update skip locked
  loop
    update approvals.approval_requests
       set state = 'expired',
           decided_at = now(),
           decision_note = 'No answer within the deadline this request was raised under'
     where approvals.approval_requests.id = v_row.id
       -- Restated: the row is held, and the predicate says what was true when
       -- the decision to expire it was taken.
       and approvals.approval_requests.state = 'pending';

    -- The partial unique index allows this only because the original is no
    -- longer pending: one open request per subject, still.
    insert into approvals.approval_requests (
      organization_id, subject_type, subject_id, policy_id, required_role,
      requested_by_type, requested_by_id, audience, summary, payload,
      amount_minor, sla_due_at, correlation_id, escalated_from
    )
    values (
      v_row.organization_id, v_row.subject_type, v_row.subject_id, v_row.policy_id,
      'owner',
      'system', null, v_row.audience,
      coalesce(v_row.summary, v_row.subject_type) || ' — escalated, unanswered since '
        || to_char(v_row.sla_due_at, 'DD Mon HH24:MI'),
      v_row.payload, v_row.amount_minor,
      -- The escalation gets the same window the original had, measured from
      -- now: the owner is not given less time than the person who missed it.
      now() + (v_row.sla_due_at - v_row.created_at),
      v_row.correlation_id, v_row.id
    )
    returning * into v_new;

    perform core.record_audit(
      v_row.organization_id,
      'approval.expired',
      'approval_request',
      v_row.id,
      to_jsonb(v_row),
      jsonb_build_object('state', 'expired', 'escalated_to', v_new.id)
    );

    expired_id := v_row.id;
    escalation_id := v_new.id;
    subject_type := v_row.subject_type;
    organization_id := v_row.organization_id;
    return next;
  end loop;
end;
$$;

comment on function approvals.expire_overdue(int) is
  'Settles every pending request past its own deadline as expired and raises a fresh one against the owner, linked by escalated_from. ADM-08c. It cannot approve anything: there is no path from here to approved, and the only function that writes it refuses a caller with no identity. Escalates once — there is nobody above the owner.';

revoke all on function approvals.expire_overdue(int) from public;
grant execute on function approvals.expire_overdue(int) to service_role;
