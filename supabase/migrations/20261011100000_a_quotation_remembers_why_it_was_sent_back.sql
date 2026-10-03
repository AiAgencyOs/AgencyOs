-- A quotation sent back for changes keeps the owner's reason ON the quotation.
--
-- The reason lived only on the approval request (decision_note). The request is
-- cleared from the draft the moment it settles, so the quotation list and the
-- lead panel could say a version had been sent back and never say why; the
-- revision learner and the agent's next draft read it from a join that is gone
-- by then. Written only by sync_proposal_decision, from the decision itself.

alter table sales.proposals
  add column if not exists sent_back_note text,
  add column if not exists sent_back_at timestamptz;

comment on column sales.proposals.sent_back_note is
  'The owner''s note when this version was rejected or sent back for changes. Written by sync_proposal_decision from the approval decision; null for a version that was never sent back.';

create or replace function sales.sync_proposal_decision(p_proposal_id uuid)
 returns text
 language plpgsql
 set search_path to ''
as $function$
declare
  v_row      sales.proposals;
  v_state    text;
  v_status   text;
  v_decider  uuid;
  v_note     text;
  v_at       timestamptz;
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

  select r.state, r.decided_by, nullif(btrim(r.decision_note), ''), r.decided_at
    into v_state, v_decider, v_note, v_at
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
         approval_request_id = case when v_status = 'draft' then null else v_row.approval_request_id end,
         approved_by_name = case when v_status = 'approved' then v_name else sales.proposals.approved_by_name end,
         approved_by_role = case when v_status = 'approved' then v_role else sales.proposals.approved_by_role end,
         -- The reason travels with the version it was given about. Set on the
         -- way back to draft; an approval leaves any earlier note alone.
         sent_back_note = case when v_status = 'draft' then v_note else sales.proposals.sent_back_note end,
         sent_back_at   = case when v_status = 'draft' then coalesce(v_at, now()) else sales.proposals.sent_back_at end
   where sales.proposals.id = v_row.id;

  return v_status;
end;
$function$;
