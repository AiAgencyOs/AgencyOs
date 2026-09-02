-- The owner approves the words too — G-182.
--
-- The agent now writes a covering note with every quotation: two to four
-- sentences the client reads above the figures, in the language they have been
-- writing in. `sales.proposals.document` holds it, frozen with everything else
-- the moment the quotation leaves draft.
--
-- This migration does ONE thing: puts it in the approval request's payload, so
-- the announcement carries it and the owner sees the words before deciding.
--
-- ── why that matters more than it looks ───────────────────────────────────
--
-- The note is the only client-facing prose an agent writes about a priced
-- quotation. What makes it permissible under ADM-22 is not that it avoids
-- numbers — though it does, and `quotationLanguageFault` refuses one — it is
-- that **the person who decides the price also decides what is said about
-- it.** That is only true if they can see it, and the announcement is where an
-- owner actually reads a quotation. Written into the document but absent from
-- the payload, the note would be approved in name and unseen in fact.
--
-- ── REGENERATED FROM THE LIVE DEFINITION, not retyped ─────────────────────
--
-- The first draft of this migration was written from memory and silently lost
-- two refusals: the `already_pending` branch and the no-lines guard. That is
-- the near miss PR #113 made and G-126 recorded — a function rewritten by hand
-- drops a branch and every structural test stays green.
--
-- So the body below is `pg_get_functiondef` output with exactly one line
-- added, and a test asserts that every outcome the function could answer
-- before it still can.

create or replace function sales.submit_proposal(p_proposal_id uuid, p_requested_by uuid DEFAULT NULL::uuid, p_summary text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, request_id uuid, status text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
        -- G-182. The words the client will read above the figures, so the
        -- person who decides the price also decides what is said about it.
        -- Read out of the frozen document with ->>, so it is simply absent
        -- for every quotation drafted before the field existed and the
        -- announcement composes exactly as it did.
        'covering_note', v_row.document->>'coveringNote',
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
$function$;

comment on function sales.submit_proposal(uuid, uuid, text) is
  'Moves a DRAFT quotation to pending_approval and raises the approval request that decides it, carrying the version, the totals, the line items and — since G-182 — the covering note the client will read above the figures. The note is in the payload because that is where an owner actually reads a quotation: written into the document but absent from the announcement, it would be approved in name and unseen in fact. Regenerated from the live definition rather than retyped, after a hand-written first draft silently lost two refusals.';
