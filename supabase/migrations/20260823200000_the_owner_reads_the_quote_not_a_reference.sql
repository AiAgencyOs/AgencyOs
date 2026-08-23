-- The owner reads the quotation, not a reference to it.
--
-- Document 09 §14 says the approver receives the quotation: its summary, its
-- version, its price and — the part that makes a review a review — what it
-- covers. What they actually received was:
--
--     Quotation needs a decision.
--     Quotation v1 — Delivery app
--     ₹70,000
--     Needs: owner
--     Reference 7QK3M2.
--
-- A total and a title. Enough to know a decision exists, not enough to make
-- one. The owner had to open AgencyOS to see the scope — which is fine as a
-- destination and wrong as a precondition, because the approval sits between
-- the salesperson and the client and every minute of it is the client waiting.
--
-- The scope is the reviewable part. A total tells you how big a decision is;
-- the lines tell you whether it is the right one. "₹70,000" carries no signal
-- that the customer app was quoted and the driver app was forgotten.
--
-- ── what this changes ───────────────────────────────────────────────────────
--
-- One field. `sales.submit_proposal` already builds the approval payload out
-- of the proposal it is holding; this adds `items` to it. Assembled there
-- because that is where the proposal is — the announcer then renders the
-- quotation without reaching across a module boundary into sales tables it has
-- no business reading.
--
-- The event is untouched. `approval.requested` still carries the seven facts
-- it always did, and the announcer reads the payload off the request row,
-- where it already reads `requested_by_id`. The row is the authority; an event
-- shape is a second copy to keep in step.
--
-- ── what this does not change ───────────────────────────────────────────────
--
-- ADM-74 stands untouched and is worth restating because this is exactly the
-- boundary it draws: **the owner still approves in AgencyOS.** WhatsApp is
-- permitted to deliver the request, carry its content and point at the
-- reference. It is not permitted to settle the decision — no reply to this
-- message approves anything, and nothing in this migration makes one.
--
-- What changes is that the owner arrives at AgencyOS already knowing what they
-- are about to approve, instead of arriving to find out.
--
-- ── the price is still a person's ───────────────────────────────────────────
--
-- The rendered quotation states prices, and `crm.refuse_unread_price` refuses
-- an agency message stating a price with no author. That guard is not
-- weakened here and no exemption is added: the announcement is authored by
-- whoever submitted the quotation (`requested_by_id`), which is true rather
-- than convenient. An agent-raised request has no author, and there the
-- announcer keeps doing what it does today — says an amount is involved,
-- names no number, and lands.
--
-- D16: sales.submit_proposal is carried forward verbatim from
-- 20260813120019_the_quote_the_owner_signs.sql with the single marked edit.
create or replace function sales.submit_proposal(
  p_proposal_id  uuid,
  p_requested_by uuid default null,
  p_summary      text default null
)
returns table (
  -- 'submitted' | 'already_pending' | 'not_found' | 'not_draft' | 'no_items'
  -- | 'no_amount' | 'no_policy'
  outcome    text,
  request_id uuid,
  status     text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row      sales.proposals;
  v_approval record;
begin
  select p.* into v_row
    from sales.proposals p
   where p.id = p_proposal_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_row.status = 'pending_approval' then
    return query select 'already_pending'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  if v_row.status <> 'draft' then
    return query select 'not_draft'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  -- A quote with no lines is not a quote, and the same rule already guards
  -- `finance.issue_invoice`. Locked as they are read, and `perform 1` rather
  -- than `count(*)` for two reasons: FOR SHARE is refused outright alongside an
  -- aggregate, and the LIMIT form that reads like the obvious alternative can
  -- lose its one chosen tuple to a concurrent delete and report an empty table
  -- that is not.
  perform 1
     from sales.proposal_items i
    where i.proposal_id = p_proposal_id
      for share;

  if not found then
    return query select 'no_items'::text, null::uuid, v_row.status;
    return;
  end if;

  if v_row.total_minor <= 0 then
    return query select 'no_amount'::text, null::uuid, v_row.status;
    return;
  end if;

  -- §17: the Policy Engine holds the decision, and the amount is what selects
  -- the approver. `approval_policies_money_floor` now refuses any proposal
  -- policy naming below the owner, so ADM-07 holds whatever the ladder says.
  --
  -- Audience 'internal': this is the owner signing off the agency's own price,
  -- not the client answering it. The client's answer is
  -- `record_proposal_response`, further down, and conflating the two would let
  -- a client decision satisfy an internal gate.
  select * into v_approval
    from approvals.request_approval(
      v_row.organization_id,
      'proposal',
      v_row.id,
      case when p_requested_by is null then 'system' else 'user' end,
      p_requested_by,
      coalesce(p_summary, 'Quotation v' || v_row.version || ' — ' || v_row.title),
      jsonb_build_object(
        'version', v_row.version,
        'title', v_row.title,
        'currency', v_row.currency,
        'subtotal_minor', v_row.subtotal_minor,
        'discount_minor', v_row.discount_minor,
        'tax_minor', v_row.tax_minor,
        'total_minor', v_row.total_minor,
        'valid_until', v_row.valid_until,
        'opportunity_id', v_row.opportunity_id,
        -- The only addition. Document 09 §14 wants the owner to see what they
        -- are approving rather than a reference to it, and the lines are the
        -- part a person actually reviews: a total tells you the size of a
        -- decision and the scope tells you whether it is the right one.
        --
        -- Assembled HERE because this is where the proposal is, so the
        -- announcer renders it without reaching across a module into
        -- sales.proposal_items. Empty array rather than null for a quotation
        -- with no lines, so the reader has one shape to handle.
        'items', coalesce(
          (
            select jsonb_agg(
                     jsonb_build_object(
                       'description', i.description,
                       'quantity', i.quantity,
                       'amount_minor', i.amount_minor
                     )
                     order by i.position, i.created_at
                   )
              from sales.proposal_items i
             where i.proposal_id = v_row.id
          ),
          '[]'::jsonb
        )
      ),
      v_row.total_minor,
      'internal',
      null
    );

  if v_approval.outcome = 'no_policy' then
    -- The same refusal submit_deliverable makes, for the same reason: a quote
    -- waiting on nobody is a draft that looks like it is moving.
    return query select 'no_policy'::text, null::uuid, v_row.status;
    return;
  end if;

  update sales.proposals
     set status = 'pending_approval',
         approval_request_id = v_approval.request_id
   where sales.proposals.id = v_row.id;

  return query select 'submitted'::text, v_approval.request_id, 'pending_approval'::text;
end;
$$;

comment on function sales.submit_proposal(uuid, uuid, text) is
  'Sends one draft quotation for internal approval, refusing a quote with no lines and one with no amount. SECURITY INVOKER: the caller must already be able to read and update the proposal. The approval payload carries the quotation''s line items as well as its totals, so the owner reviews the scope in the announcement rather than only its size (Document 09 §14); the approval itself is still settled in AgencyOS, never by a WhatsApp reply (ADM-74).';
