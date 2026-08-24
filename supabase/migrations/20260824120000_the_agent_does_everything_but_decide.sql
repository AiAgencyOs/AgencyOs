-- ═══════════════════════════════════════════════════════════════════════════
-- The agent does everything but decide — ADM-96, G-162.
--
-- GRANTED BY THE ADMIN 2026-08-23, in their own words:
--
--     "agent sab kuch kre mai bs pdf approve changes karo"
--
-- — the agent does everything; the owner's two verbs are *approve* and
-- *changes*, exercised against the quotation PDF on their phone and settled
-- in AgencyOS. This migration is the database half of that grant. Three
-- functions change; each is the LIVE definition carried forward verbatim
-- with its edit marked (D16), and one guard is retired by decision rather
-- than revised into decoration.
--
-- What ADM-96 revises, precisely:
--
--   ADM-22 said "it must never state a price". The revised rule: the agent
--   may PROPOSE a price on an internal draft, grounded in the agency's own
--   45-quotation corpus — and no price reaches a client until a person has
--   decided it. The human act moves from *typing the number* to *approving
--   the number*, which is the owner's own phrasing of their job.
--
-- What ADM-96 does NOT move:
--
--   ADM-07 — the owner approves before anything is sent. Unchanged; the
--   approval engine is now the ONLY human gate, which is why nothing in
--   this file weakens it.
--   ADM-74 — a WhatsApp reply settles nothing; the decision happens in
--   AgencyOS, authenticated. Unchanged.
--   The client-facing core of ADM-22 — an agency message that states a
--   price to a CLIENT still requires a human author
--   (`crm.refuse_unread_price` below keeps exactly that clause).
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. The decision leaves a wire, not only a row ──────────────────────────
--
-- G-161's lesson, applied before it repeats: `approvals.decide_approval`
-- updated the row, wrote the audit, and told nobody. Every consequence of a
-- decision — carrying it to the proposal, sending the approved quotation,
-- redrafting from the owner's note — had to be wired to the UI button that
-- happened to call it, so a decision taken anywhere else (or a UI that died
-- between the decide and the carry) left the subject stranded. The event
-- makes the decision observable at the chokepoint itself.

-- `canonical` is NULL, and that is a checked fact rather than an omission:
-- Doc 23 §7's twenty-six canonical events do not name "a decision was taken
-- on an approval request" — the nearest, ChangeRequestApproved, is a
-- different thing — and inventing a mapping to make a coverage number look
-- better is exactly what the vocabulary migration refused (PR #277).
insert into core.event_types (type, description, canonical)
values (
  'approval.decided',
  'A person settled an approval request; the subject''s consequences can now run (ADM-96).',
  null
)
on conflict (type) do nothing;

-- Carried forward VERBATIM from 20260812120011_approval_engine.sql (its only
-- definer), with ONE edit marked below. Everything else — the outcome
-- vocabulary, the role ladder, the client-evidence gate, the qualified
-- predicate the D18 review demanded — is the live text, not a regeneration.
create or replace function approvals.decide_approval(
  p_request_id        uuid,
  p_decision          text,
  p_note              text default null,
  p_evidence_ref      text default null,
  p_client_contact_id uuid default null
)
returns table (
  -- 'decided' | 'not_found' | 'already_decided' | 'forbidden' | 'no_actor'
  -- | 'evidence_required' | 'invalid_decision'
  outcome    text,
  request_id uuid,
  state      text,
  decided_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_role  text := (select core.current_user_role());
  v_org   uuid := (select core.current_organization_id());
  v_req   approvals.approval_requests;
  v_row   approvals.approval_requests;
begin
  if p_decision not in ('approved', 'rejected', 'changes_requested', 'cancelled') then
    return query select 'invalid_decision'::text, p_request_id, null::text, null::timestamptz;
    return;
  end if;

  -- Directive §29, in the one place it can be enforced rather than stated: a
  -- decision needs somebody who made it. The service role has no identity, so
  -- it may raise a request and it may never settle one. This is what stops an
  -- automation from quietly approving its own work.
  if v_actor is null then
    return query select 'no_actor'::text, p_request_id, null::text, null::timestamptz;
    return;
  end if;

  -- The lock is the point. Two people with the request open, one approving and
  -- one rejecting, is the ordinary case rather than the exotic one, and
  -- without this the second write would overwrite the first decision and its
  -- decider. Locked, the second sees a settled row and is told so.
  select r.* into v_req
    from approvals.approval_requests r
   where r.id = p_request_id
   for update;

  if v_req.id is null then
    return query select 'not_found'::text, p_request_id, null::text, null::timestamptz;
    return;
  end if;

  if v_req.organization_id is distinct from v_org then
    -- Answered as not_found rather than forbidden: whether a request exists in
    -- another tenant is not this caller's business either.
    return query select 'not_found'::text, p_request_id, null::text, null::timestamptz;
    return;
  end if;

  if v_req.state <> 'pending' then
    return query select 'already_decided'::text, v_req.id, v_req.state, v_req.decided_at;
    return;
  end if;

  -- The snapshot, not the policy row: see the header. owner outranks
  -- ops_admin outranks delivery_lead, and nothing else may settle anything.
  if not (
    v_role = 'owner'
    or (v_req.required_role = 'ops_admin'     and v_role = 'ops_admin')
    or (v_req.required_role = 'delivery_lead' and v_role in ('ops_admin', 'delivery_lead'))
  ) then
    return query select 'forbidden'::text, v_req.id, v_req.state, null::timestamptz;
    return;
  end if;

  -- ADM-08d. The constraint would refuse this write anyway; refusing it here
  -- means the caller gets a named outcome instead of a 23514 to interpret.
  if v_req.audience = 'client'
     and p_decision in ('approved', 'rejected', 'changes_requested')
     and (p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0)
  then
    return query select 'evidence_required'::text, v_req.id, v_req.state, null::timestamptz;
    return;
  end if;

  update approvals.approval_requests
     set state             = p_decision,
         decided_at        = now(),
         decided_by        = v_actor,
         decision_note     = p_note,
         evidence_ref      = coalesce(p_evidence_ref, evidence_ref),
         client_contact_id = coalesce(p_client_contact_id, client_contact_id)
   where approval_requests.id = v_req.id
     -- Restated on the write even though the row is held, because the lock and
     -- the predicate answer different questions, and D18's review is the
     -- reason this repository restates both.
     --
     -- Qualified for the same reason as the select above: `state` and
     -- `decided_at` are OUT parameters of this function as well as columns of
     -- this table. Unqualified, every settle failed and only the early
     -- returns — forbidden, evidence_required — appeared to work.
     and approval_requests.state = 'pending'
  returning * into v_row;

  perform core.record_audit(
    v_row.organization_id,
    'approval.' || p_decision,
    'approval_request',
    v_row.id,
    to_jsonb(v_req),
    to_jsonb(v_row),
    v_row.correlation_id
  );

  -- ── EDIT (ADM-96, G-162): the one added statement ────────────────────────
  -- Emitted AFTER the audit, inside the same transaction, so a decision and
  -- its wire commit or roll back together — there is no state in which the
  -- row says decided and the outbox never heard, or the outbox heard about a
  -- decision that rolled back. The payload names the SUBJECT, not only the
  -- request, because every subscriber's first question is "is this mine";
  -- `decidedBy` is the authenticated actor, and it matters downstream: the
  -- approved-quotation send authors the client message with this person,
  -- which is what makes a price on the wire a human's (ADM-22's core).
  perform core.emit_event(
    v_row.organization_id,
    'approval.decided',
    'approval_request',
    v_row.id,
    jsonb_build_object(
      'subjectType', v_row.subject_type,
      'subjectId',   v_row.subject_id,
      'decision',    p_decision,
      'decidedBy',   v_actor,
      'note',        p_note,
      'reference',   v_row.reference
    ),
    v_row.correlation_id
  );

  return query select 'decided'::text, v_row.id, v_row.state, v_row.decided_at;
end;
$$;

comment on function approvals.decide_approval(uuid, text, text, text, uuid) is
  'Settles a pending approval request as the authenticated actor, audits the transition, and emits approval.decided naming the subject and the decider (ADM-96) — so the consequences of a decision are event-driven rather than wired to whichever button called this.';


-- ── 2. An internal channel may hear a price from the system ────────────────
--
-- The announcement channel (internal_group, or the owner's own WhatsApp as
-- internal_direct under ADM-95) is the agency talking to itself — the price
-- on it is not an offer to anybody, it is the MECHANISM by which the human
-- takes ownership of the number before any client sees it. Refusing an
-- author-less price there does not protect a client; it silently strips the
-- amount (and, through the handler's gate, the PDF) from exactly the
-- message that asks the owner to decide that amount. Under ADM-96 the agent
-- submits quotations with no human requester, so without this exemption the
-- owner's phone would receive "a quotation needs a decision" with the one
-- fact they need — the number — removed.
--
-- Carried forward VERBATIM from
-- 20260821170000_a_message_nobody_read_may_not_name_a_price.sql, with ONE
-- edit marked. The client-facing clause is untouched: an agency message on a
-- direct or client_account conversation that states a price still requires a
-- named human author. `crm.states_a_price` is not redefined here; the live
-- definition stands.
create or replace function crm.refuse_unread_price()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- An agency message with a human behind it is exactly what ADM-22 wants:
  -- every price quoted per client, by a person. Only the unread path is bound.
  if new.author_type = 'user' and new.author_id is null
     and crm.states_a_price(new.body)
     -- ── EDIT (ADM-96, G-162): internal channels are exempt ────────────────
     -- The agency saying a number to ITSELF is how the number gets an owner.
     -- Only the two internal kinds — a project_group has clients in it and
     -- stays under the original rule.
     and not exists (
       select 1
         from crm.conversations c
        where c.id = new.conversation_id
          and c.kind in ('internal_direct', 'internal_group')
     ) then
    raise exception
      'an automated message may not state a price (ADM-22); a human must author anything that quotes one'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function crm.refuse_unread_price() is
  'Refuses an agency message that states a price with no human author — on client-facing conversations (ADM-22). Internal channels are exempt (ADM-96): the price announced to the owner is how the number acquires its human before any client sees it.';


-- ── 3. The guard whose rule the owner revised ──────────────────────────────
--
-- `sales.refuse_priced_by_nobody` (20260823170000) refused a non-zero price
-- written by an identityless caller onto an agent-drafted quotation. That was
-- ADM-22's letter: the agent scopes, a person prices. ADM-96 revised the
-- rule itself — the agent now prices the DRAFT, and the person's act is the
-- decision — so the guard no longer holds a rule anybody has. Retired rather
-- than rewritten into something decorative, and stated plainly: this is a
-- DECISION, not a loosening that slipped through.
--
-- Where ADM-22's surviving core now lives, layer by layer:
--   * no price reaches a CLIENT without a human —
--     `crm.refuse_unread_price` (above) on every client-facing row, and the
--     approved-quotation send authors the message with the DECIDER;
--   * nothing is sent before a person decides —
--     `sales.send_proposal` refuses any status but `approved`, and
--     `approved` is reachable only through the approval engine
--     (20260815260000: a proposal is approved only through the engine);
--   * a submitted version cannot be repriced quietly —
--     `sales.proposal_items_guard` freezes lines outside `draft`.
drop trigger if exists refuse_priced_by_nobody on sales.proposal_items;
drop function if exists sales.refuse_priced_by_nobody();


-- ── 4. The agent's own description catches up with its grant ───────────────
--
-- The roster (20260821210000) described sales as "drafts the scope ... Never
-- states a price - a human does". Under ADM-96 that sentence is half wrong
-- and the half that matters is unchanged: the agent now PROPOSES the prices
-- on its draft, and still nothing reaches a client until a human decides it.
-- Said on the row the /agents page reads, so the description and the
-- behaviour cannot tell two different stories.
update ai.agents
   set description =
     'Answers a lead, qualifies it, discovers requirements, handles objections and drafts the quotation whole - scope and proposed prices from the agency''s own corpus (ADM-96). No price reaches a client until a human decides it; the send executes that decision.'
 where key = 'sales';
