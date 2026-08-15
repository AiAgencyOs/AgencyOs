-- ═══════════════════════════════════════════════════════════════════════════
-- Cancelling an approval takes authority, not just the right tenant.
--
-- `approvals.cancel_request` is SECURITY DEFINER, granted to `authenticated`,
-- and lives in the PostgREST-exposed `approvals` schema. Its only guard was
-- tenancy: a signed-in caller is bound to its own org. But it never checked the
-- caller's ROLE — unlike `decide_approval`, which enforces the owner > ops_admin
-- > delivery_lead hierarchy. `member` and `contractor` are `is_internal()`, so
-- the `approval_requests` select policy lets them read the whole pending queue
-- and harvest ids; any of them could then POST `/rpc/cancel_request(<id>)` and
-- drive an owner-tier approval — a refund, an invoice, a proposal — to the
-- terminal `cancelled` state, after which `approval_requests_guard` forbids any
-- further transition, so the owner can NEVER approve it. It grants no authority
-- to approve, but it lets the lowest-privilege insider unilaterally withdraw a
-- decision that was the owner's to make — the "write path wider than the
-- capability it stands in for" asymmetry the codebase closes everywhere else.
--
-- Cancelling withdraws a request nobody has decided yet, and that is a manager's
-- act: only owner and ops_admin may. A coarser gate than decide_approval's
-- rung-for-rung hierarchy on purpose — the one internal caller besides the two
-- manager roles is the proposal supersession (`submit_proposal` cancels the
-- prior version's approval when a new one is drafted), and an ops_admin drafting
-- a new version must be able to supersede an OWNER-tier prior approval, which a
-- strict "could you have decided it" rule would forbid. The service role (no
-- actor) still reaches across, exactly as it did, so that supersession and any
-- job path are unaffected.
--
-- `create or replace`, same signature; `forbidden` was already an outcome.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function approvals.cancel_request(
  p_request_id uuid,
  p_reason     text default null
)
returns table (
  -- 'cancelled' | 'not_found' | 'already_decided' | 'forbidden'
  outcome text,
  state   text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   approvals.approval_requests;
begin
  select r.* into v_row
    from approvals.approval_requests r
   where r.id = p_request_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- The same rule request_approval applies: a caller that has an identity is
  -- bound to its own tenant; only a caller with none — the service role
  -- running a job — reaches across. Without it, SECURITY DEFINER would let a
  -- signed-in user cancel another agency's approval by id.
  if v_actor is not null
     and v_row.organization_id is distinct from (select core.current_organization_id())
  then
    return query select 'forbidden'::text, null::text;
    return;
  end if;

  -- And authority, not merely the right tenant: cancelling withdraws a request
  -- nobody has decided, which is a manager's act. Only owner and ops_admin may;
  -- a member, contractor or delivery_lead is refused. The service role (no
  -- actor) is unrestricted, so the proposal supersession still withdraws a
  -- prior version's approval regardless of its tier.
  if v_actor is not null
     and (select core.current_user_role()) not in ('owner', 'ops_admin')
  then
    return query select 'forbidden'::text, null::text;
    return;
  end if;

  if v_row.state <> 'pending' then
    return query select 'already_decided'::text, v_row.state;
    return;
  end if;

  -- `decision_note` rather than a column of its own: approval_requests_decision_shape
  -- requires it null only while pending, and a cancellation's reason is the
  -- one thing a reader of a withdrawn request wants.
  update approvals.approval_requests
     set state         = 'cancelled',
         decided_at    = clock_timestamp(),
         decision_note = coalesce(p_reason, approvals.approval_requests.decision_note)
   where approvals.approval_requests.id = p_request_id;

  perform core.record_audit(
    v_row.organization_id,
    'approval.cancelled',
    'approval_request',
    v_row.id,
    jsonb_build_object('state', v_row.state),
    jsonb_build_object('state', 'cancelled', 'reason', p_reason)
  );

  return query select 'cancelled'::text, 'cancelled'::text;
end;
$$;

comment on function approvals.cancel_request(uuid, text) is
  'Withdraws a pending approval request, with its reason on decision_note. SECURITY DEFINER for the proposal supersession that cancels a prior version''s approval; caller-scoped by BOTH tenant and authority — a session caller must be owner or ops_admin, so a member or contractor cannot cancel an owner-tier approval by id. The service role (no actor) is unrestricted.';

revoke all on function approvals.cancel_request(uuid, text) from public, anon;
grant execute on function approvals.cancel_request(uuid, text) to authenticated, service_role;
