-- The no-advance exception can be asked for — G-230's dead branch, closed.
--
-- `sales.won_gate_verdict` (20260911120000) has read
-- `payload->>'kind' = 'payment_exception'` on the accepted proposal's approval
-- since the WON gate was built, and its own comment said plainly that nothing
-- writes it: "the no-advance exception path is ADM-72's open question."  That
-- citation was wrong on its face — ADM-72 was granted months earlier, for an
-- unrelated question (whether a project may be created without a quotation,
-- PR #104/#114) — and no decision record for the actual question ("should a
-- no-advance close ever be approved, and by whom") exists anywhere in
-- roadmap.json. With `won_requires_payment_evidence` switched on, this made
-- the exception half of "payment OR authorized exception" permanently
-- unreachable: no caller anywhere could ever construct the row the gate reads.
--
-- ── the decision this migration makes, stated rather than left implicit ────
--
-- Route the exception through the approval engine that already exists rather
-- than inventing a parallel one. `approvals.request_approval` /
-- `approvals.decide_approval` already carry every property this needs — an
-- org-scoped, policy-tiered, human-only decision, auditable, idempotent on
-- retry, refusing a self-approval from the service role. This migration adds
-- exactly one door — `sales.request_payment_exception` — that raises the
-- request in the shape the gate already reads: `subject_type = 'proposal'`,
-- `subject_id` = the accepted version, `payload.kind = 'payment_exception'`.
-- Deciding it (approve/reject) needs no new code at all — that is what
-- `approvals.decide_approval` already does for every other proposal approval.
--
-- Reusing `subject_type = 'proposal'` means the exception resolves against
-- whichever policy tier the organization already configured for proposals —
-- the same ladder `submit_proposal`'s money-floor approval uses. This is a
-- deliberate simplification: it does not introduce a *separate* "who may
-- approve a no-advance close" tier, and Doc 09 §14's other open question — an
-- upstream policy toggle for whether no-advance selling is permitted at all,
-- as opposed to approved case-by-case at the WON gate — is NOT answered here
-- and stays open. What this migration closes is narrower and load-bearing on
-- its own: the exception path existed in every reader's imagination and in
-- the gate's own SQL, but no caller could ever produce the row it looked for.
--
-- Any internal role may ask (mirrors `lead.write`'s existing reach in
-- `setOpportunityStage`); only the resolved policy's required_role may settle
-- it, exactly as every other proposal approval already works.

create or replace function sales.request_payment_exception(
  p_opportunity_id uuid,
  p_reason         text
)
returns table (
  -- 'requested' | 'already_pending' | 'no_policy'
  -- refusals: 'no_actor' | 'not_found' | 'no_accepted_quotation' | 'reason_required'
  outcome       text,
  request_id    uuid,
  state         text,
  required_role text,
  sla_due_at    timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_opp      sales.opportunities;
  v_accepted sales.proposals;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  if not coalesce((select core.is_internal()), false) then
    return query select 'no_actor'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    return query select 'reason_required'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  select o.* into v_opp
    from sales.opportunities o
   where o.id = p_opportunity_id and o.organization_id = v_org;

  if v_opp.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  -- The same selector sales.won_gate_verdict uses (and convertToProject and
  -- record_won_handoff fall back to): the newest accepted version. Asking for
  -- an exception against any other version would authorize a close the gate
  -- was never going to check against.
  select p.* into v_accepted
    from sales.proposals p
   where p.opportunity_id = v_opp.id
     and p.status = 'accepted'
   order by p.version desc
   limit 1;

  if v_accepted.id is null then
    return query select 'no_accepted_quotation'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  return query
    select r.outcome, r.request_id, r.state, r.required_role, r.sla_due_at
      from approvals.request_approval(
        v_org, 'proposal', v_accepted.id, 'user', v_actor,
        p_reason,
        jsonb_build_object('kind', 'payment_exception', 'reason', p_reason),
        v_accepted.total_minor, 'internal', null
      ) r;
end;
$$;

comment on function sales.request_payment_exception(uuid, text) is
  'Raises the no-advance payment-exception approval that sales.won_gate_verdict has read since G-230 but nothing could ever write. Resolves against the accepted proposal''s own version and the organization''s already-configured proposal policy tier; settling it is approvals.decide_approval, unchanged. Does not answer Doc 09 §14''s separate open question of an upstream policy toggle for whether no-advance selling is permitted at all.';

revoke all on function sales.request_payment_exception(uuid, text) from public, anon;
grant execute on function sales.request_payment_exception(uuid, text) to authenticated;

notify pgrst, 'reload schema';
