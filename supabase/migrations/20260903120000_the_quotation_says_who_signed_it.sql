-- ═══════════════════════════════════════════════════════════════════════════
-- The quotation says who signed it — G-194 (Doc 08, QM-16)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A zero-trust audit read the twenty sections the renderer draws and found the
-- one a client looks for first: the document says which agency it came from
-- (QM-14), who it is for (QM-15) — and nothing at all about WHO. Every one of
-- the 45 quotations in the corpus came from a person. The generated one comes
-- from an institution, which is exactly how a stranger's PDF reads.
--
-- ── whose name is it, honestly? ───────────────────────────────────────────
--
-- Not the drafter. An agent wrote the words, and printing a person's name over
-- a model's paragraph would be the first false sentence in a document whose
-- whole value is that nothing in it is invented.
--
-- The APPROVER. ADM-07 and ADM-96 put the decision with a human and make it
-- the last human act before a client sees anything: nobody else in the process
-- has read the number and said yes to it. So the line the client reads is a
-- record of that, and it can only appear on a document that HAS one — an
-- unapproved copy has no signature because nobody has signed it.
--
-- ── and why it is copied rather than joined ───────────────────────────────
--
-- `approvals.approval_requests.decided_by` already names the person, so the
-- name is a join away, and a join would be wrong twice:
--
--   1. `decided_by` is `on delete set null`. A person leaves the agency, and
--      every quotation they ever signed silently forgets who signed it. The
--      row is a record of an act; the act happened.
--   2. `core.users.full_name` is editable. A rendered quotation is a document
--      a client keeps, and re-rendering it two years later must produce the
--      same page — a name that follows a profile edit is a document that
--      changes after it was sent.
--
-- So the name and the role are COPIED onto the proposal at the moment of
-- approval and frozen there, the same way the total, the title and the
-- document itself are frozen. This is the pattern G-165 used for the document
-- and for the same reason: what the owner approved is what the client reads.

alter table sales.proposals
  add column if not exists approved_by_name text,
  add column if not exists approved_by_role text;

comment on column sales.proposals.approved_by_name is
  'The full name of the person who approved this quotation, COPIED at the moment of approval rather than joined - approvals.approval_requests.decided_by is ''on delete set null'' and core.users.full_name is editable, and a document a client keeps must not change when a profile does. Null on anything never approved, and on an approval by somebody who has no name recorded.';

comment on column sales.proposals.approved_by_role is
  'Their role in the agency at the moment they approved it (owner, ops_admin, ...). Frozen for the same reason as the name: a person promoted next year did not sign this quotation as that.';

-- ── written once, at approval, and never again ─────────────────────────────
--
-- The guard already freezes the commercial content once a proposal leaves
-- draft, and these two columns are written BY the transition that leaves it -
-- so they cannot join that list, which compares against `old` on the same
-- update. The rule they get instead is the stronger one: once set, never
-- changed, in any state. A signature that can be rewritten is not a signature.

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
    -- And never born signed. The signature is the approval's to write.
    if new.approved_by_name is not null or new.approved_by_role is not null then
      raise exception 'a proposal is not created already approved by somebody'
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

  -- ── the signature (G-194) ────────────────────────────────────────────────
  --
  -- Once written, it is a record of something a person did. Not frozen by
  -- status, because the write itself is the status change: frozen by having
  -- happened.
  if (old.approved_by_name is not null and new.approved_by_name is distinct from old.approved_by_name)
     or (old.approved_by_role is not null and new.approved_by_role is distinct from old.approved_by_role)
  then
    raise exception 'who approved proposal v% is a record of what happened, and does not change', old.version
      using errcode = 'restrict_violation';
  end if;

  -- And it can only appear on a proposal that is actually approved. Without
  -- this the column is a free-text field on a draft: a name a client would
  -- read as a sign-off that never happened.
  if (new.approved_by_name is not null or new.approved_by_role is not null)
     and old.approved_by_name is null and old.approved_by_role is null
     and new.status <> 'approved'
  then
    raise exception 'a quotation is signed when it is approved, not while it is %', new.status
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
       -- ── EDIT (G-165): the document is commercial content too ────────────
       -- Understanding, exclusions, assumptions, responsibilities — every
       -- word of it is what the owner approved. A post-approval edit to the
       -- document would be a different quotation wearing an approved stamp.
       or new.document               is distinct from old.document
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
  'Freezes a proposal''s identity and (once out of draft) its terms, records the approver''s name as unchangeable once written (G-194), keeps accepted/rejected/superseded terminal, and enforces the status transition graph: the engine-mediated states (pending_approval, approved) can be reached only when approval_request_id points at this proposal''s own owner approval in the matching state, and every other delta (draft->sent, draft->accepted, lapsed->accepted, ...) is refused - so submit_proposal / sync_proposal_decision / send_proposal / record_proposal_response are the only ways through, and a direct write cannot forge ADM-07''s owner sign-off or a client acceptance.';

-- ── and the one write, in the one place the decision lands ─────────────────
--
-- SECURITY INVOKER, unchanged: this function has always run as its caller and
-- the guard above is what makes that safe. The two reads it gains are of
-- `core.users` and `core.memberships`, which every caller of this function can
-- already see for their own organization.
--
-- A missing name is left NULL rather than filled with an email or an id. The
-- renderer draws the block only when there is a name, so an agency that never
-- recorded one gets the document it had before this migration - which is the
-- honest outcome, and better than a quotation signed `a1f2c3d4-…`.

create or replace function sales.sync_proposal_decision(
  p_proposal_id uuid
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row      sales.proposals;
  v_state    text;
  v_status   text;
  v_decider  uuid;
  v_name     text;
  v_role     text;
begin
  select p.* into v_row
    from sales.proposals p
   where p.id = p_proposal_id
   for update;

  if v_row.id is null then
    return 'not_found';
  end if;

  if v_row.approval_request_id is null then
    return v_row.status;
  end if;

  select r.state, r.decided_by into v_state, v_decider
    from approvals.approval_requests r
   where r.id = v_row.approval_request_id;

  v_status := case v_state
    when 'approved' then 'approved'
    when 'rejected' then 'draft'
    when 'changes_requested' then 'draft'
    else null
  end;

  -- Only from pending_approval. A quote already sent must not be dragged back
  -- by a late sync, and one already superseded is history.
  if v_status is null or v_row.status <> 'pending_approval' then
    return v_row.status;
  end if;

  -- The signature, and only on the way to approved: a rejection returns the
  -- quotation to draft, and nobody has signed a draft.
  if v_status = 'approved' and v_decider is not null then
    select nullif(btrim(u.full_name), ''), m.role
      into v_name, v_role
      from core.users u
      left join core.memberships m
        on m.user_id = u.id
       and m.organization_id = v_row.organization_id
     where u.id = v_decider;
  end if;

  update sales.proposals
     set status = v_status,
         -- Cleared on the way back to draft: the request is settled, and a
         -- draft still pointing at it would make `already_pending` true of a
         -- quote nobody is looking at. G-089's shape, one module along.
         approval_request_id = case when v_status = 'draft' then null else v_row.approval_request_id end,
         -- G-194 — who signed it, as they were when they signed it. Only ever
         -- written here, and the guard refuses every later change.
         approved_by_name = case when v_status = 'approved' then v_name else sales.proposals.approved_by_name end,
         approved_by_role = case when v_status = 'approved' then v_role else sales.proposals.approved_by_role end
   where sales.proposals.id = v_row.id;

  return v_status;
end;
$$;

comment on function sales.sync_proposal_decision(uuid) is
  'Brings the owner''s decision back from the approval engine onto the quotation, and records WHO made it (G-194) - name and role copied at that moment, because the document a client keeps must not change when a profile does. A refusal returns it to draft - what a refusal means in practice - and clears the settled request, because a draft pointing at one would report a pending approval nobody is looking at.';

revoke all on function sales.sync_proposal_decision(uuid) from public;
grant execute on function sales.sync_proposal_decision(uuid) to authenticated, service_role;
