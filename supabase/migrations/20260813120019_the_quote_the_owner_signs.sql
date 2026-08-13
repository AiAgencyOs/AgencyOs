-- ═══════════════════════════════════════════════════════════════════════════
-- The quote the owner signs.
--
-- Gap G-011, decision ADM-07. `sales.proposals` and `sales.proposal_items`
-- have had tables, RLS, indexes and a version column since the first day of
-- this repository and **no code at all** — no service, no action, no query, no
-- page. The capability matrix has carried `proposal.draft`, `proposal.approve`
-- and `proposal.send` for just as long, and nothing has ever checked one.
--
-- ADM-07, in the Admin's words: **staff draft, the owner approves, then it is
-- sent.** A proposal carries a price, so it goes through the approval queue
-- before it reaches a client.
--
-- ── what the documentation asks for, and what is built here ───────────────
--
-- Document 09 §15–§18 and §22 are the specification. What they ask:
--
--   §12  the quotation references the confirmed requirement version
--   §15  a quote carries scope, price, discount, taxes, a validity period
--   §16  every material commercial change creates a new version; earlier
--        versions remain historical; **only one is current**; acceptance and
--        approval each reference the exact version
--   §17  out-of-range price, excess discount and high value need Admin
--        approval, and the Policy Engine stores the decision
--   §18  delivery records when it was sent, through which conversation, and
--        with what message reference — and **"do not mark accepted simply
--        because quote was delivered"**
--   §22  acceptance stores its timestamp, the client identity, the accepted
--        version and the accepted terms
--
-- What is deliberately NOT built here, because no rule has been written for
-- it: the negotiation engine (§20) and its limits (§21), objection tracking
-- (§19), and quote generation from pricing rules (§15's inputs). Those are
-- G-012, G-013 and their own decisions. This builds the spine those hang off:
-- a versioned commercial document that is drafted, approved, sent, and
-- answered — each step refusing what it must.
--
-- ── the approval engine is the reviewer, again ────────────────────────────
--
-- `submit_proposal` raises an approval request with subject_type 'proposal'.
-- That subject type has existed since the engine was built (ADM-08) and had no
-- caller; the deliverable loop became the first, and this is the second — and
-- the first that carries **money**, which is what the policy ladder was built
-- to resolve. §17's "high-value project → approval threshold if configured"
-- is `approval_policies.min_amount_minor` doing exactly its job.
--
-- ── why the money floor gains a third subject type ────────────────────────
--
-- `approval_policies_money_floor` says money never drops below the role that
-- already holds it: a refund policy may not name below owner, an invoice
-- policy may not name below ops_admin. `proposal.approve` resolves to **owner
-- and nobody else** in src/lib/authz/permissions.ts, and ADM-07 says the owner
-- approves. So a proposal policy naming an ops_admin would be a policy row
-- quietly undoing a decision the Admin gave and a capability the matrix has
-- never granted. It is refused in DDL, where the other two are refused,
-- rather than by a service that could forget.
--
-- Existing rows: `upsertPolicy` has no caller anywhere in the application —
-- no action, no page, no script — so the only proposal policies that can
-- exist are ones written by a test or a verification run against a scratch
-- database. They are tightened rather than tripped over, which is a change in
-- the safe direction and is recorded by the policy audit trigger.
--
-- ── the audit trail is the trigger's, not this file's ─────────────────────
--
-- No function below calls `core.record_audit`. G-093 (ADM-51) settled that
-- these rows are audited by `audit.record_row_change`, from inside the
-- transaction and on **every** path — including a write made straight through
-- PostgREST by something nobody has written yet. `sales.proposals` joins that
-- trigger's table list, and its status vocabulary joins the trigger's action
-- vocabulary. One mechanism, not two.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. What a quote has to carry
-- ═══════════════════════════════════════════════════════════════════════════

alter table sales.proposals
  -- §15: "Discount if applicable". A separate column rather than pre-subtracted
  -- into the subtotal, because §17 gates on *excess discount* and a discount
  -- folded into a price cannot be gated on at all.
  add column if not exists discount_minor bigint not null default 0
    check (discount_minor >= 0),

  -- §15: "Validity period". A date rather than an interval: every quote this
  -- agency sends says "valid until the 30th", not "valid for 14 days".
  add column if not exists valid_until date,

  -- §12: "Quotation references the confirmed requirement version." Nullable,
  -- because a quote for a returning client can precede any extraction — but
  -- when it is set, this is the scope the price was built against.
  --
  -- `on delete set null` rather than cascade or restrict: requirement versions
  -- are append-only and are not deleted, so this arm is reached only when an
  -- organization is torn down, and losing the quote with it would be worse
  -- than losing the link.
  add column if not exists requirement_version_id uuid
    references crm.requirement_versions(id) on delete set null,

  -- The engine's request that is reviewing it, once submitted.
  add column if not exists approval_request_id uuid
    references approvals.approval_requests(id) on delete set null,

  -- §18: "Link quote to conversation", "Record message/document reference".
  -- Where it went and what carried it — the evidence that it was actually
  -- delivered, as opposed to marked delivered.
  add column if not exists conversation_id uuid
    references crm.conversations(id) on delete set null,
  add column if not exists sent_message_ref text,

  -- §22: "Store client identity" and the acceptance timestamp. `decided_at`
  -- already existed and is kept as the moment the client answered either way;
  -- this is who answered, when the answer was recorded by a staff member with
  -- the evidence in hand.
  add column if not exists responded_by_contact_id uuid
    references crm.contacts(id) on delete set null,
  add column if not exists response_note text,

  add column if not exists created_by uuid references core.users(id) on delete set null;

comment on column sales.proposals.discount_minor is
  'Discount applied to the subtotal (Document 09 §15). Held apart from the line prices so §17''s excess-discount approval has something to gate on.';
comment on column sales.proposals.valid_until is
  'The last day the quote binds (Document 09 §15). record_proposal_response refuses an acceptance after it; nothing expires the row itself, which is G-111.';
comment on column sales.proposals.requirement_version_id is
  'The confirmed requirement version this price was built against (Document 09 §12).';
comment on column sales.proposals.conversation_id is
  'The conversation the quote was sent through (Document 09 §18).';
comment on column sales.proposals.sent_message_ref is
  'The provider''s reference for the message that carried it (Document 09 §18) - the evidence it was delivered rather than marked delivered.';
comment on column sales.proposals.responded_by_contact_id is
  'The client contact whose answer this is (Document 09 §22).';

-- ── the totals are arithmetic, not a claim ────────────────────────────────
--
-- These four columns arrived as caller-supplied defaults of 0. That is a
-- money bug waiting to be written: a caller that posts total_minor = 100 with
-- line items summing to 10,000,000 does not merely display a wrong number —
-- `submit_proposal` hands the total to the approval engine, and the engine
-- resolves **which role must approve** from it. A trusted total is a
-- self-service downgrade of the approver.
--
-- So the subtotal is summed from the items by trigger, and the identity below
-- is a constraint. Neither is a service's responsibility any more.
alter table sales.proposals
  drop constraint if exists proposals_total_is_arithmetic;

alter table sales.proposals
  add constraint proposals_total_is_arithmetic
    check (total_minor = subtotal_minor - discount_minor + tax_minor);

alter table sales.proposals
  drop constraint if exists proposals_discount_within_subtotal;

alter table sales.proposals
  add constraint proposals_discount_within_subtotal
    check (discount_minor <= subtotal_minor);

-- ── the state machine ─────────────────────────────────────────────────────
--
-- 'superseded' joins the vocabulary for §16: V2 is generated, V1 remains
-- historical. The original six are unchanged.
alter table sales.proposals
  drop constraint if exists proposals_status_check;

alter table sales.proposals
  add constraint proposals_status_check
    check (status in ('draft', 'pending_approval', 'approved', 'sent',
                      'accepted', 'rejected', 'superseded'));

-- §16: "Only one version is marked current/active."
--
-- Made unrepresentable rather than merely intended — the D22 lesson. A live
-- version is one that is still on its way to an answer; 'accepted', 'rejected'
-- and 'superseded' are settled and may pile up as the history §16 asks for.
create unique index if not exists proposals_live_version_key
  on sales.proposals (opportunity_id)
  where status in ('draft', 'pending_approval', 'approved', 'sent');

create index if not exists proposals_approval_request_idx
  on sales.proposals (approval_request_id)
  where approval_request_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. A line item's amount is its own arithmetic
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Same argument one level down. `amount_minor` defaulted to 0 while quantity
-- and unit price sat beside it, so the three could disagree and the subtotal
-- would faithfully sum the disagreement.
--
-- A trigger rather than a generated column: making `amount_minor` GENERATED
-- means dropping and re-adding the column, and a destructive change to a
-- money table is not worth saving a trigger.

create or replace function sales.proposal_item_amount()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- round() and not trunc(): a quantity of 1.5 at a unit price of 333 is 500
  -- rather than 499, which is what an invoice for the same line would say.
  new.amount_minor := round(new.quantity * new.unit_price_minor);
  return new;
end;
$$;

comment on function sales.proposal_item_amount() is
  'Derives proposal_items.amount_minor from quantity x unit price, so a caller cannot post a line whose amount disagrees with its own numbers.';

drop trigger if exists proposal_item_amount on sales.proposal_items;
create trigger proposal_item_amount
  before insert or update on sales.proposal_items
  for each row execute function sales.proposal_item_amount();

-- ── and the parent's subtotal is the sum of them ──────────────────────────

create or replace function sales.proposal_totals()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_proposal uuid := coalesce(new.proposal_id, old.proposal_id);
  v_subtotal bigint;
begin
  select coalesce(sum(i.amount_minor), 0) into v_subtotal
    from sales.proposal_items i
   where i.proposal_id = v_proposal;

  -- The identity `proposals_total_is_arithmetic` asserts, written once here
  -- and checked by the constraint on the way in.
  update sales.proposals p
     set subtotal_minor = v_subtotal,
         total_minor    = v_subtotal - p.discount_minor + p.tax_minor
   where p.id = v_proposal;

  return null;
end;
$$;

comment on function sales.proposal_totals() is
  'Re-sums a proposal''s subtotal and total from its line items after any item change. The totals are arithmetic rather than a caller''s claim, because submit_proposal hands the total to the approval engine and the engine resolves the required approver from it.';

drop trigger if exists proposal_totals on sales.proposal_items;
create trigger proposal_totals
  after insert or update or delete on sales.proposal_items
  for each row execute function sales.proposal_totals();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. A version stops being editable the moment it is submitted
-- ═══════════════════════════════════════════════════════════════════════════
--
-- §16: "Approval references the exact version", "Acceptance references the
-- exact version." Both sentences are false if the version can be edited after
-- the fact, and the deliverable loop learned this a day ago: an approval that
-- names something which no longer exists is not a record of anything.
--
-- Draft is freely editable — that is what a draft is. Everything after it is
-- frozen apart from the columns that record what happened *to* it.

create or replace function sales.proposals_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
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

  -- Settled is settled. 'accepted' and 'rejected' are the client's answer and
  -- 'superseded' is the history §16 asks for; none of the three is a state
  -- anything moves out of.
  if old.status in ('accepted', 'rejected', 'superseded')
     and new.status is distinct from old.status
  then
    raise exception 'proposal v% is already %', old.version, old.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function sales.proposals_guard() is
  'Freezes a proposal''s terms once it leaves draft, and refuses to move a settled one. Document 09 §16 says approval and acceptance each reference the exact version; both sentences are false if the version can be edited afterwards.';

drop trigger if exists proposals_guard on sales.proposals;
create trigger proposals_guard
  before update on sales.proposals
  for each row execute function sales.proposals_guard();

-- ── items follow their parent ─────────────────────────────────────────────
--
-- Freezing the totals is not enough on its own: without this, the lines behind
-- a frozen total could still be rewritten, and the money a client agreed to
-- would be described by rows that no longer say what they said.

create or replace function sales.proposal_items_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status  text;
  v_version int;
begin
  select p.status, p.version into v_status, v_version
    from sales.proposals p
   where p.id = coalesce(new.proposal_id, old.proposal_id);

  -- No parent means the proposal is being deleted and this is the cascade.
  if v_status is null then
    return coalesce(new, old);
  end if;

  if v_status <> 'draft' then
    raise exception
      'proposal v% is %; its lines cannot change - draft version % instead',
      v_version, v_status, v_version + 1
      using errcode = 'restrict_violation';
  end if;

  return coalesce(new, old);
end;
$$;

comment on function sales.proposal_items_guard() is
  'A line item may only be written while its proposal is a draft. Without it, freezing the totals would leave the lines behind them rewritable.';

drop trigger if exists proposal_items_guard on sales.proposal_items;
create trigger proposal_items_guard
  before insert or update or delete on sales.proposal_items
  for each row execute function sales.proposal_items_guard();

-- proposal_items had no updated_at and needs none; it has no such column.
-- proposals already carries the set_updated_at trigger from the sales
-- migration that created it.

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. The money floor gains its third subject type
-- ═══════════════════════════════════════════════════════════════════════════

-- Tightened rather than tripped over. See the header: no application path can
-- have written one of these, and strengthening is the safe direction.
update approvals.approval_policies
   set required_role = 'owner'
 where subject_type = 'proposal'
   and required_role <> 'owner';

alter table approvals.approval_policies
  drop constraint if exists approval_policies_money_floor;

alter table approvals.approval_policies
  add constraint approval_policies_money_floor check (
    case
      when subject_type = 'refund'   then required_role = 'owner'
      when subject_type = 'proposal' then required_role = 'owner'
      when subject_type = 'invoice'  then required_role in ('owner', 'ops_admin')
      else true
    end
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 4b. Cancelling a request — the operation the engine described and never built
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `approval_requests_guard` says, in its own words, *"Editing a pending
-- request in place would move the question after it was asked. Cancel it and
-- raise another."* and `reject_delete` says *"approval requests are never
-- deleted; cancel them"*. Both point at an operation that does not exist:
-- `approval_requests` has a select policy and **no write policy at all**, so
-- every write goes through a SECURITY DEFINER function, and the only two are
-- `request_approval` and `decide_approval`.
--
-- Superseding a quotation is the first caller that needs it (§16: V2 is
-- generated, so V1's pending question is moot). Written here rather than in
-- sales, because a module reaching into another module's table is what
-- ARCHITECTURE.md §3.2 forbids — and an invoker-rights UPDATE from sales
-- would not have failed, it would have matched zero rows and reported success.
--
-- Cancelling is not deciding. It records no approver and satisfies no gate:
-- `state = 'cancelled'` is refused by every consumer that looks for
-- 'approved'. That is why it needs no role check beyond the tenant — an
-- ops_admin withdrawing their own quote's question is not approving anything.

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
  'Withdraws a pending approval request - the operation approval_requests_guard and reject_delete both tell callers to use and which had no implementation. SECURITY DEFINER because approval_requests has no write policy by design, with request_approval''s tenancy rule restated. Cancelling is not deciding: it names no approver and satisfies no gate.';

revoke all on function approvals.cancel_request(uuid, text) from public;
grant execute on function approvals.cancel_request(uuid, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Drafting a version
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function sales.draft_proposal(
  p_opportunity_id         uuid,
  p_title                  text,
  p_body                   text default null,
  p_valid_until            date default null,
  p_requirement_version_id uuid default null,
  p_created_by             uuid default null
)
returns table (
  -- 'created' | 'not_found' | 'settled'
  outcome     text,
  proposal_id uuid,
  version     int,
  superseded  uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_opportunity sales.opportunities;
  v_next        int;
  v_live        sales.proposals;
  v_row         sales.proposals;
begin
  -- The lock is on the opportunity, so two people drafting at the same moment
  -- serialise: one allocates v2 and the other v3, and neither loses
  -- `proposals_live_version_key` to the other. The same reason
  -- add_deliverable locks the project.
  select o.* into v_opportunity
    from sales.opportunities o
   where o.id = p_opportunity_id
   for update;

  if v_opportunity.id is null then
    return query select 'not_found'::text, null::uuid, null::int, null::uuid;
    return;
  end if;

  -- A won or lost deal is not one that takes new quotes. Refused here rather
  -- than left to look like it worked, because a quote drafted against a
  -- settled deal is invisible in every pipeline view there is.
  if v_opportunity.stage in ('won', 'lost') then
    return query select 'settled'::text, null::uuid, null::int, null::uuid;
    return;
  end if;

  select coalesce(max(p.version), 0) + 1 into v_next
    from sales.proposals p
   where p.opportunity_id = p_opportunity_id;

  -- §16: V2 is generated, V1 remains historical. The earlier live version is
  -- superseded rather than deleted, and this is what keeps
  -- `proposals_live_version_key` satisfiable — one live version, always.
  --
  -- Superseding a *sent* quote is deliberate and is what §16 describes: the
  -- client asked for a change, so the number they were looking at is no
  -- longer the number on the table.
  select p.* into v_live
    from sales.proposals p
   where p.opportunity_id = p_opportunity_id
     and p.status in ('draft', 'pending_approval', 'approved', 'sent')
   for update;

  if v_live.id is not null then
    update sales.proposals
       set status = 'superseded'
     where sales.proposals.id = v_live.id;

    -- A version on its way out takes its pending question with it. Leaving the
    -- request open would put a quote in the owner's queue that can never be
    -- sent, and ADM-08's whole point is that the queue means something.
    --
    -- Through the engine's own function, not with an UPDATE from here: sales
    -- has no write policy on that table, so an UPDATE would have matched zero
    -- rows and reported success.
    if v_live.approval_request_id is not null then
      perform approvals.cancel_request(
        v_live.approval_request_id,
        'Superseded by quotation v' || v_next
      );
    end if;
  end if;

  insert into sales.proposals (
    organization_id, opportunity_id, version, title, body,
    valid_until, requirement_version_id, currency, created_by
  )
  values (
    v_opportunity.organization_id, p_opportunity_id, v_next, p_title, p_body,
    p_valid_until, p_requirement_version_id, v_opportunity.currency, p_created_by
  )
  returning * into v_row;

  return query select 'created'::text, v_row.id, v_next, v_live.id;
end;
$$;

comment on function sales.draft_proposal(uuid, text, text, date, uuid, uuid) is
  'Drafts the next quotation version against a deal, allocating the number under the opportunity''s lock and superseding the version that was live (Document 09 §16). Cancels the superseded version''s pending approval, so the owner''s queue never holds a quote that can no longer be sent.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Its lines and its pricing
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function sales.add_proposal_item(
  p_proposal_id     uuid,
  p_description     text,
  p_quantity        numeric default 1,
  p_unit_price_minor bigint default 0,
  p_position        int default null
)
returns table (
  -- 'added' | 'not_found' | 'not_draft'
  outcome text,
  item_id uuid,
  subtotal_minor bigint,
  total_minor    bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row   sales.proposals;
  v_item  sales.proposal_items;
  v_at    int;
begin
  select p.* into v_row
    from sales.proposals p
   where p.id = p_proposal_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::bigint, null::bigint;
    return;
  end if;

  -- The guard would raise on the insert anyway; answering here turns a
  -- restrict_violation into an outcome a page can render.
  if v_row.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid, v_row.subtotal_minor, v_row.total_minor;
    return;
  end if;

  select coalesce(p_position, coalesce(max(i.position), -1) + 1) into v_at
    from sales.proposal_items i
   where i.proposal_id = p_proposal_id;

  insert into sales.proposal_items (
    organization_id, proposal_id, position, description, quantity, unit_price_minor
  )
  values (
    v_row.organization_id, p_proposal_id, v_at, p_description, p_quantity, p_unit_price_minor
  )
  returning * into v_item;

  -- Re-read: the totals were rewritten by the trigger on the insert above.
  select p.* into v_row from sales.proposals p where p.id = p_proposal_id;

  return query select 'added'::text, v_item.id, v_row.subtotal_minor, v_row.total_minor;
end;
$$;

comment on function sales.add_proposal_item(uuid, text, numeric, bigint, int) is
  'Adds a line to a draft quotation and hands back the totals the item trigger recomputed. Refuses anything but a draft.';

create or replace function sales.set_proposal_pricing(
  p_proposal_id   uuid,
  p_discount_minor bigint default null,
  p_tax_minor      bigint default null
)
returns table (
  -- 'priced' | 'not_found' | 'not_draft' | 'discount_exceeds_subtotal'
  outcome        text,
  subtotal_minor bigint,
  discount_minor bigint,
  tax_minor      bigint,
  total_minor    bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row      sales.proposals;
  v_discount bigint;
  v_tax      bigint;
begin
  select p.* into v_row
    from sales.proposals p
   where p.id = p_proposal_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::bigint, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  if v_row.status <> 'draft' then
    return query select 'not_draft'::text, v_row.subtotal_minor, v_row.discount_minor,
                        v_row.tax_minor, v_row.total_minor;
    return;
  end if;

  v_discount := coalesce(p_discount_minor, v_row.discount_minor);
  v_tax      := coalesce(p_tax_minor, v_row.tax_minor);

  -- `proposals_discount_within_subtotal` would refuse this as a constraint
  -- violation. Answered as an outcome instead: a discount larger than the work
  -- is a typo somebody needs to see, not a 500.
  if v_discount > v_row.subtotal_minor then
    return query select 'discount_exceeds_subtotal'::text, v_row.subtotal_minor,
                        v_row.discount_minor, v_row.tax_minor, v_row.total_minor;
    return;
  end if;

  update sales.proposals
     set discount_minor = v_discount,
         tax_minor      = v_tax,
         total_minor    = v_row.subtotal_minor - v_discount + v_tax
   where sales.proposals.id = p_proposal_id
  returning * into v_row;

  return query select 'priced'::text, v_row.subtotal_minor, v_row.discount_minor,
                      v_row.tax_minor, v_row.total_minor;
end;
$$;

comment on function sales.set_proposal_pricing(uuid, bigint, bigint) is
  'Sets the discount and tax on a draft quotation (Document 09 §15) and re-derives the total. A discount larger than the subtotal is an outcome rather than a constraint violation, because it is a typo somebody needs to see.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Sending it to the owner
-- ═══════════════════════════════════════════════════════════════════════════

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
        'opportunity_id', v_row.opportunity_id
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
  'Puts a quotation in front of the owner by raising an internal-audience approval request carrying its total, so the policy ladder resolves the approver from the money (Document 09 §17, ADM-07). Refuses a quote with no lines, no amount, or no policy to answer it.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. What the owner said
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * A pull rather than a trigger on approval_requests, for the reason
 * sync_deliverable_decision states: a trigger there would make settling any
 * approval reach into every module that ever raises one.
 *
 * A refusal returns the quote to `draft` rather than inventing a rejected-
 * by-the-owner state. That is what the owner refusing means in practice —
 * staff revise the price and resubmit — and the record of *what* was refused
 * survives regardless, because the approval request keeps the payload
 * snapshot taken above.
 */
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
  v_row    sales.proposals;
  v_state  text;
  v_status text;
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

  select r.state into v_state
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

  update sales.proposals
     set status = v_status,
         -- Cleared on the way back to draft: the request is settled, and a
         -- draft still pointing at it would make `already_pending` true of a
         -- quote nobody is looking at. G-089's shape, one module along.
         approval_request_id = case when v_status = 'draft' then null else v_row.approval_request_id end
   where sales.proposals.id = v_row.id;

  return v_status;
end;
$$;

comment on function sales.sync_proposal_decision(uuid) is
  'Brings the owner''s decision back from the approval engine onto the quotation. A refusal returns it to draft - what a refusal means in practice - and clears the settled request, because a draft pointing at one would report a pending approval nobody is looking at.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. Sending it to the client
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function sales.send_proposal(
  p_proposal_id   uuid,
  p_conversation_id uuid default null,
  p_message_ref   text default null
)
returns table (
  -- 'sent' | 'not_found' | 'not_approved' | 'already_sent'
  outcome text,
  status  text,
  sent_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row sales.proposals;
  v_now timestamptz := clock_timestamp();
begin
  select p.* into v_row
    from sales.proposals p
   where p.id = p_proposal_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  if v_row.status = 'sent' then
    return query select 'already_sent'::text, v_row.status, v_row.sent_at;
    return;
  end if;

  -- ADM-07's gate, and the only one this function makes: **the owner approves,
  -- then it is sent.** Checked under the lock rather than from the caller's
  -- earlier read, because an approval that is withdrawn between a check and a
  -- write is exactly the gap this repository has closed eight times.
  if v_row.status <> 'approved' then
    return query select 'not_approved'::text, v_row.status, null::timestamptz;
    return;
  end if;

  update sales.proposals
     set status          = 'sent',
         sent_at         = v_now,
         conversation_id = coalesce(p_conversation_id, sales.proposals.conversation_id),
         sent_message_ref = coalesce(p_message_ref, sales.proposals.sent_message_ref)
   where sales.proposals.id = v_row.id;

  -- Nothing subscribes to this yet (src/lib/events/catalog.ts lists only
  -- handlers that exist). It is emitted because this is the moment the agency
  -- made a priced offer, and an event with no subscribers is published and
  -- costs nothing.
  perform core.emit_event(
    v_row.organization_id, 'proposal.sent', 'proposal', v_row.id,
    jsonb_build_object(
      'opportunityId', v_row.opportunity_id,
      'version', v_row.version,
      'totalMinor', v_row.total_minor,
      'currency', v_row.currency,
      'conversationId', p_conversation_id
    )
  );

  return query select 'sent'::text, 'sent'::text, v_now;
end;
$$;

comment on function sales.send_proposal(uuid, uuid, text) is
  'Delivers an approved quotation and records when, through which conversation, and with what message reference (Document 09 §18). Refuses anything the owner has not approved - ADM-07''s gate, checked under the row lock.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. What the client said
-- ═══════════════════════════════════════════════════════════════════════════
--
-- §18, in as many words: **"Do not mark accepted simply because quote was
-- delivered."** Acceptance is its own act, from `sent` and nowhere else, and
-- it carries who said it and where they said it.
--
-- §22 wants the accepted version, the timestamp and the client identity. It
-- also puts acceptance *before* payment and WON — ACCEPTANCE → PAYMENT →
-- WON — so this deliberately does not move the deal's stage. A quote accepted
-- is not a deal won, and inventing that arrow would mark deals won on a
-- promise.

create or replace function sales.record_proposal_response(
  p_proposal_id  uuid,
  p_response     text,
  p_contact_id   uuid default null,
  p_note         text default null
)
returns table (
  -- 'recorded' | 'not_found' | 'not_sent' | 'expired' | 'invalid_response'
  outcome    text,
  status     text,
  decided_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row sales.proposals;
  v_now timestamptz := clock_timestamp();
begin
  if p_response not in ('accepted', 'rejected') then
    return query select 'invalid_response'::text, null::text, null::timestamptz;
    return;
  end if;

  select p.* into v_row
    from sales.proposals p
   where p.id = p_proposal_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text, null::timestamptz;
    return;
  end if;

  if v_row.status <> 'sent' then
    return query select 'not_sent'::text, v_row.status, null::timestamptz;
    return;
  end if;

  -- §15's validity period, enforced where it means something. A quote whose
  -- date has passed cannot be *accepted* — that is what a validity period is —
  -- but it can still be refused, and nothing expires the row on a timer.
  -- Whether a lapsed quote should move to a state of its own is G-111.
  if p_response = 'accepted'
     and v_row.valid_until is not null
     and v_row.valid_until < (v_now at time zone 'utc')::date
  then
    return query select 'expired'::text, v_row.status, null::timestamptz;
    return;
  end if;

  update sales.proposals
     set status                  = p_response,
         decided_at              = v_now,
         responded_by_contact_id = coalesce(p_contact_id, sales.proposals.responded_by_contact_id),
         response_note           = coalesce(p_note, sales.proposals.response_note)
   where sales.proposals.id = v_row.id;

  perform core.emit_event(
    v_row.organization_id, 'proposal.' || p_response, 'proposal', v_row.id,
    jsonb_build_object(
      'opportunityId', v_row.opportunity_id,
      'version', v_row.version,
      'totalMinor', v_row.total_minor,
      'currency', v_row.currency,
      'contactId', p_contact_id
    )
  );

  return query select 'recorded'::text, p_response, v_now;
end;
$$;

comment on function sales.record_proposal_response(uuid, text, uuid, text) is
  'Records the client''s answer to a quotation that was actually sent (Document 09 §18: delivery is not acceptance; §22: the answer names the exact version). Refuses acceptance after the validity date. Deliberately does not move the deal stage - §22 puts payment between acceptance and WON.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. The history is written by the trigger
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `audit.record_row_change` carried forward **from its own latest definition**
-- (20260813120013) with one marked case added. Regenerating it from an earlier
-- migration is how D16 was silently reverted, and G-100's header says so.

create or replace function audit.record_row_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_action  text;
  v_subject text;
  v_before  jsonb;
  v_after   jsonb;
  v_org     uuid;
begin
  v_after := to_jsonb(new);
  v_before := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;

  v_org := (v_after->>'organization_id')::uuid;

  if v_org is null then
    raise exception 'audit.record_row_change: % has no organization_id', tg_table_name;
  end if;

  case tg_table_name
    when 'leads' then
      v_subject := 'lead';
      v_action :=
        case
          when tg_op = 'INSERT' then 'lead.created'
          when new.status = 'converted' and old.status is distinct from 'converted' then 'lead.converted'
          when new.status is distinct from old.status then 'lead.status_changed'
          when new.qualification is distinct from old.qualification then 'lead.qualification_updated'
          when new.next_follow_up_at is distinct from old.next_follow_up_at then 'lead.follow_up_scheduled'
          else 'lead.updated'
        end;

    when 'lead_activities' then
      v_subject := 'lead';
      v_action := 'lead.note_added';

    when 'requirement_versions' then
      v_subject := 'requirement_version';
      v_action :=
        case
          when tg_op = 'INSERT' then 'requirement.proposed'
          when new.status is distinct from old.status then 'requirement.' || new.status
          else 'requirement.updated'
        end;

    when 'client_accounts' then
      v_subject := 'client_account';
      v_action := case when tg_op = 'INSERT' then 'client_account.created' else 'client_account.updated' end;

    when 'opportunities' then
      v_subject := 'opportunity';
      v_action :=
        case
          when tg_op = 'INSERT' then 'opportunity.created'
          when new.stage = 'won' and old.stage is distinct from 'won' then 'opportunity.won'
          when new.stage is distinct from old.stage then 'opportunity.stage_changed'
          when new.value_minor is distinct from old.value_minor then 'opportunity.value_changed'
          else 'opportunity.updated'
        end;

    -- G-011. The status vocabulary is already the business vocabulary — the
    -- states a quote moves through are exactly the events worth reading in a
    -- log — so the derivation is the status itself. `proposal.repriced` is
    -- named separately because a discount or tax change on a draft is the one
    -- material money edit that leaves the status alone, and it is the edit
    -- Document 09 §17 gates approval on.
    when 'proposals' then
      v_subject := 'proposal';
      v_action :=
        case
          when tg_op = 'INSERT' then 'proposal.drafted'
          when new.status is distinct from old.status then 'proposal.' || new.status
          when new.total_minor is distinct from old.total_minor then 'proposal.repriced'
          else 'proposal.updated'
        end;

    when 'projects' then
      v_subject := 'project';
      v_action :=
        case
          when tg_op = 'INSERT' then 'project.created'
          when new.status is distinct from old.status then 'project.status_changed'
          else 'project.updated'
        end;

    when 'defects' then
      v_subject := 'defect';
      v_action :=
        case
          when tg_op = 'INSERT' then 'defect.raised'
          when new.status is distinct from old.status then 'defect.' || new.status
          else 'defect.updated'
        end;

    else
      raise exception 'audit.record_row_change: no vocabulary for table %', tg_table_name;
  end case;

  if tg_op = 'UPDATE' and (v_before - 'updated_at') = (v_after - 'updated_at') then
    return null;
  end if;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org,
    case when (select auth.uid()) is null then 'system' else 'user' end,
    (select auth.uid()),
    v_action,
    v_subject,
    (v_after->>'id')::uuid,
    v_before,
    v_after
  );

  return null;
end;
$$;

drop trigger if exists audit_row_change on sales.proposals;
create trigger audit_row_change
  after insert or update on sales.proposals
  for each row execute function audit.record_row_change();

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. Grants
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SECURITY INVOKER throughout, so `proposals_write` — which the capability
-- migration already narrowed to core.is_admin(), the owner and ops_admin
-- holding proposal.draft and proposal.send — is what decides. The grants below
-- add no reach of their own.

revoke all on function sales.draft_proposal(uuid, text, text, date, uuid, uuid) from public;
revoke all on function sales.add_proposal_item(uuid, text, numeric, bigint, int) from public;
revoke all on function sales.set_proposal_pricing(uuid, bigint, bigint) from public;
revoke all on function sales.submit_proposal(uuid, uuid, text) from public;
revoke all on function sales.sync_proposal_decision(uuid) from public;
revoke all on function sales.send_proposal(uuid, uuid, text) from public;
revoke all on function sales.record_proposal_response(uuid, text, uuid, text) from public;

grant execute on function sales.draft_proposal(uuid, text, text, date, uuid, uuid) to authenticated, service_role;
grant execute on function sales.add_proposal_item(uuid, text, numeric, bigint, int) to authenticated, service_role;
grant execute on function sales.set_proposal_pricing(uuid, bigint, bigint) to authenticated, service_role;
grant execute on function sales.submit_proposal(uuid, uuid, text) to authenticated, service_role;
grant execute on function sales.sync_proposal_decision(uuid) to authenticated, service_role;
grant execute on function sales.send_proposal(uuid, uuid, text) to authenticated, service_role;
grant execute on function sales.record_proposal_response(uuid, text, uuid, text) to authenticated, service_role;

grant select, insert, update on sales.proposals to authenticated, service_role;
grant select, insert, update, delete on sales.proposal_items to authenticated, service_role;
