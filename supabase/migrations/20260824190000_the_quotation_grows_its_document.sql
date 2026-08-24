-- ═══════════════════════════════════════════════════════════════════════════
-- The quotation grows its document — G-165, the Master Quotation System
-- landing in the engine (the owner's mandate of 2026-08-24, "proceed").
--
-- Until now a quotation carried a title, priced lines and one boundary
-- paragraph. The Master Quotation System (Parts A–L) defines the rest —
-- understanding, per-line features, exclusions, assumptions, client
-- responsibilities — and the split that keeps it honest: the MODEL writes
-- only what requires reading the requirements; CODE writes what is policy
-- (payment families, timeline bands, the support standard, GST, the
-- change-request rule). This migration is the storage half: one jsonb
-- column, frozen with the rest of the commercial content.
-- ═══════════════════════════════════════════════════════════════════════════

alter table sales.proposals
  add column if not exists document jsonb;

comment on column sales.proposals.document is
  'The quotation''s document sections beyond the lines (G-165): understanding, per-line features, exclusions, assumptions, client responsibilities — the model-authored judgment content. Policy content (payment schedule, timeline band, support, GST, CR rule) is derived in code from the totals and never stored, so a policy change never rewrites an approved document. Frozen outside draft by proposals_guard.';

-- proposals_guard carried forward VERBATIM from 20260815260000 (its live
-- definition), with ONE edit marked: `document` joins the frozen column list.
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


-- ── 2. The line's bullets live on the line (review round, same day) ─────────
--
-- The review confirmed the positional coupling as a real defect: document
-- features indexed by position mis-attach the moment a person inserts or
-- reorders lines on a returned draft, and nothing could tell. Structural
-- fix: the bullets are a column of the line itself.
alter table sales.proposal_items
  add column if not exists features jsonb;

comment on column sales.proposal_items.features is
  'Bullet-level contents of this line (G-165), written at draft time by the drafting job and frozen outside draft by proposal_items_guard. On the ROW so reordering or inserting lines can never mis-attach bullets; a person''s hand-typed line has none, honestly.';

-- add_proposal_item carried forward VERBATIM from 20260813120019 (its live
-- definition), with the two edits marked.
create or replace function sales.add_proposal_item(
  p_proposal_id     uuid,
  p_description     text,
  p_quantity        numeric default 1,
  p_unit_price_minor bigint default 0,
  p_position        int default null,
  -- ── EDIT (G-165 review): the line's own bullets ride the line ────────────
  -- Features stored positionally in the document were re-attached to lines
  -- by index, so a human inserting or reordering lines on a returned draft
  -- shifted every later line's bullets onto the wrong line. On the row, the
  -- coupling cannot break: bullets travel with their line, an admin-typed
  -- line simply has none, and the items guard freezes them with the price.
  p_features        jsonb default null
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
    organization_id, proposal_id, position, description, quantity, unit_price_minor, features
  )
  values (
    v_row.organization_id, p_proposal_id, v_at, p_description, p_quantity, p_unit_price_minor, p_features
  )
  returning * into v_item;

  -- Re-read: the totals were rewritten by the trigger on the insert above.
  select p.* into v_row from sales.proposals p where p.id = p_proposal_id;

  return query select 'added'::text, v_item.id, v_row.subtotal_minor, v_row.total_minor;
end;
$$;

drop function if exists sales.add_proposal_item(uuid, text, numeric, bigint, int);
grant execute on function sales.add_proposal_item(uuid, text, numeric, bigint, int, jsonb) to authenticated, service_role;
