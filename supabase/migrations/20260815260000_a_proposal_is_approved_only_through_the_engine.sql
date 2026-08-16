-- ═══════════════════════════════════════════════════════════════════════════
-- A proposal moves through its states only by the sanctioned path, not by hand.
--
-- The third round-3 state-machine-guard finding, on sales.proposals — the same
-- class the deliverables and handovers fixes closed. proposals_guard froze the
-- identity and the terms and kept accepted/rejected/superseded terminal, but it
-- never enforced the status TRANSITION graph, and it omitted 'lapsed' from the
-- terminal set (the lapsed state was added later, to the CHECK, not here).
--
-- proposals_write RLS is core.is_admin() (owner OR ops_admin) and INSERT/UPDATE
-- are granted to authenticated, so an ops_admin could PATCH the row straight
-- over the Data API. Proven live: draft → 'sent' with approval_request_id NULL
-- (bypassing ADM-07's owner sign-off, which an ops_admin can NEVER pass through
-- the engine because the money floor forces required_role='owner' for
-- proposals); draft → 'accepted' (a fabricated client acceptance — and
-- convertToProject reads the latest accepted proposal's total as the PROJECT
-- BUDGET, so a forged total becomes real money); 'lapsed' → 'accepted' (which
-- record_proposal_response refuses as expired, and ADM-78 forbids).
--
-- The sanctioned machine, in lockstep with the owner approval it needs:
--   draft            → pending_approval   submit_proposal (raises a pending
--                                          'proposal' approval, owner-tier)
--   pending_approval → approved           sync_proposal_decision (request approved)
--   pending_approval → draft              sync_proposal_decision (request rejected
--                                          / changes requested; clears the link)
--   approved         → sent               send_proposal (ADM-07's gate)
--   sent             → accepted | rejected record_proposal_response
--   sent             → lapsed             the validity sweep
--   lapsed           → rejected           record_proposal_response (ADM-77 decline)
--   any non-terminal → superseded         a new version supersedes the old
-- The guard now requires exactly that: the engine-mediated states carry an
-- approval_request_id pointing at this proposal's own 'proposal' approval in the
-- matching state, and every other status delta is refused — so submit_proposal,
-- sync_proposal_decision, send_proposal and record_proposal_response are the
-- only ways through, and a direct write cannot forge a send, an approval or an
-- acceptance. A proposal is also created 'draft' and never born settled.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function sales.proposals_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- A proposal is drafted, never born approved/sent/accepted.
    if new.status <> 'draft' then
      raise exception 'a proposal is created as a draft, not % — use draft_proposal', new.status
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  -- Never editable, in any state. The version is allocated under a lock and
  -- the opportunity is the document's whole identity.
  if new.organization_id is distinct from old.organization_id
     or new.opportunity_id is distinct from old.opportunity_id
     or new.version        is distinct from old.version
     or new.created_at     is distinct from old.created_at
  then
    raise exception 'a proposal''s identity is fixed; draft version % instead', old.version + 1
      using errcode = 'restrict_violation';
  end if;

  -- The commercial content, frozen once it leaves draft.
  if old.status <> 'draft' then
    if new.title                  is distinct from old.title
       or new.body                is distinct from old.body
       or new.currency            is distinct from old.currency
       or new.subtotal_minor      is distinct from old.subtotal_minor
       or new.discount_minor      is distinct from old.discount_minor
       or new.tax_minor           is distinct from old.tax_minor
       or new.total_minor         is distinct from old.total_minor
       or new.valid_until         is distinct from old.valid_until
       or new.requirement_version_id is distinct from old.requirement_version_id
    then
      raise exception
        'proposal v% is %; its terms cannot change - draft version % instead',
        old.version, old.status, old.version + 1
        using errcode = 'restrict_violation';
    end if;
  end if;

  -- Settled is settled. accepted/rejected are the client's answer and
  -- superseded is the history §16 asks for; none is a state anything leaves.
  if old.status in ('accepted', 'rejected', 'superseded')
     and new.status is distinct from old.status
  then
    raise exception 'proposal v% is already %', old.version, old.status
      using errcode = 'restrict_violation';
  end if;

  -- The transition graph and its approval linkage: the engine-mediated states
  -- can be reached only when approval_request_id points at this proposal's own
  -- 'proposal' approval request in the matching state, so a direct write cannot
  -- forge an approval, a send or an acceptance.
  if new.status is distinct from old.status then
    if new.status = 'pending_approval' then
      if old.status <> 'draft' then
        raise exception 'a proposal enters review only from draft (was %)', old.status
          using errcode = 'restrict_violation';
      end if;
      if not exists (
        select 1 from approvals.approval_requests r
         where r.id = new.approval_request_id
           and r.organization_id = new.organization_id
           and r.subject_type = 'proposal' and r.subject_id = new.id
           and r.state = 'pending'
      ) then
        raise exception 'a proposal in review must point at its own pending approval — use submit_proposal'
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'approved' then
      if old.status <> 'pending_approval' then
        raise exception 'a proposal is approved only from review (was %)', old.status
          using errcode = 'restrict_violation';
      end if;
      if not exists (
        select 1 from approvals.approval_requests r
         where r.id = new.approval_request_id
           and r.organization_id = new.organization_id
           and r.subject_type = 'proposal' and r.subject_id = new.id
           and r.state = 'approved'
      ) then
        raise exception 'a proposal is approved only when its owner approval is — use sync_proposal_decision'
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'draft' then
      -- The rejected/changes-requested return, from sync_proposal_decision.
      if old.status <> 'pending_approval' then
        raise exception 'a proposal returns to draft only from review (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'sent' then
      -- ADM-07: the owner approves, then it is sent.
      if old.status <> 'approved' then
        raise exception 'a proposal is sent only after it is approved (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'accepted' then
      if old.status <> 'sent' then
        raise exception 'a proposal is accepted only from sent (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'rejected' then
      -- The client's decline, of a sent or a lapsed quote (ADM-77).
      if old.status not in ('sent', 'lapsed') then
        raise exception 'a proposal is declined only from sent or lapsed (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'lapsed' then
      if old.status <> 'sent' then
        raise exception 'a proposal lapses only from sent (was %)', old.status
          using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'superseded' then
      -- A newer version supersedes the old; reachable from any non-terminal
      -- state (the terminals are refused above).
      null;

    else
      raise exception 'a proposal cannot be moved to % by hand', new.status
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function sales.proposals_guard() is
  'Freezes a proposal''s identity and (once out of draft) its terms, keeps accepted/rejected/superseded terminal, and enforces the status transition graph: the engine-mediated states (pending_approval, approved) can be reached only when approval_request_id points at this proposal''s own owner approval in the matching state, and every other delta (draft->sent, draft->accepted, lapsed->accepted, ...) is refused — so submit_proposal / sync_proposal_decision / send_proposal / record_proposal_response are the only ways through, and a direct write cannot forge ADM-07''s owner sign-off or a client acceptance.';

drop trigger if exists proposals_guard on sales.proposals;
create trigger proposals_guard
  before insert or update on sales.proposals
  for each row execute function sales.proposals_guard();
