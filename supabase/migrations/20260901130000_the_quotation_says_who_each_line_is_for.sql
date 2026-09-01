-- The quotation says who each line is for — G-178.
--
-- A zero-trust audit found that the quotation could not say what it was made
-- of. The brief asks a quotation to identify modules, user roles, and the
-- backend / frontend / admin split; the scope schema had a flat list of priced
-- lines and no way to express any of it. A role could appear only as prose
-- inside a description, which made the commonest scope dispute in the corpus
-- unrepresentable: *we thought the admin could do that too.*
--
-- ── why a column and not another jsonb key ────────────────────────────────
--
-- `serves` is a property of a LINE, and the lines already live in
-- `sales.proposal_items` with `features` beside them for exactly this reason.
-- Putting it in `proposals.document` instead would mean a second copy of every
-- line description to hang it off — two descriptions of one piece of work,
-- which is the drift this schema has avoided everywhere else.
--
-- Same shape as `features`, deliberately: jsonb array of text, nullable,
-- written through `add_proposal_item` at draft time and frozen with the rest
-- of the quotation the moment it leaves draft. A quotation drafted before this
-- column existed has null here and renders exactly as it did.
--
-- ── what this column does NOT do ──────────────────────────────────────────
--
-- It holds no authority. The rule that a line may only name a role the
-- quotation declared is enforced in `quotationScopeSchema` at the write,
-- because the roles themselves live in the document and the database cannot
-- see them from here. This column stores the answer; it does not check it.

alter table sales.proposal_items
  add column if not exists serves jsonb;

comment on column sales.proposal_items.serves is
  'Which of the quotation''s declared roles this line is for (G-178) — a jsonb array of role names, matching the names in proposals.document.roles. Null for a quotation drafted before the column existed, and for a line whose audience the requirements never established. The referential rule (a line may only name a declared role) is held by quotationScopeSchema at the write, because the roles live in the document where this table cannot see them.';

-- ── the writer takes it ───────────────────────────────────────────────────
--
-- DROPPED and recreated rather than replaced. `create or replace` with a
-- different argument list creates an OVERLOAD, and a six-argument call would
-- then be ambiguous between the two — a runtime error at the first draft
-- rather than a failure here.
--
-- Everything else is the function as it stood: the FOR UPDATE, the not_found
-- and not_draft answers that turn a trigger exception into something a page
-- can render, the position default, and the re-read that returns the totals
-- the insert trigger just rewrote. `p_serves` is appended with a null default,
-- exactly as `p_features` was, so every existing caller behaves identically.

drop function if exists sales.add_proposal_item(uuid, text, numeric, bigint, integer, jsonb);

create function sales.add_proposal_item(
  p_proposal_id uuid,
  p_description text,
  p_quantity numeric default 1,
  p_unit_price_minor bigint default 0,
  p_position integer default null,
  p_features jsonb default null,
  p_serves jsonb default null
)
returns table (outcome text, item_id uuid, subtotal_minor bigint, total_minor bigint)
language plpgsql
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
    organization_id, proposal_id, position, description, quantity, unit_price_minor, features, serves
  )
  values (
    v_row.organization_id, p_proposal_id, v_at, p_description, p_quantity, p_unit_price_minor,
    p_features, p_serves
  )
  returning * into v_item;

  -- Re-read: the totals were rewritten by the trigger on the insert above.
  select p.* into v_row from sales.proposals p where p.id = p_proposal_id;

  return query select 'added'::text, v_item.id, v_row.subtotal_minor, v_row.total_minor;
end;
$$;

comment on function sales.add_proposal_item(uuid, text, numeric, bigint, integer, jsonb, jsonb) is
  'Adds one line to a DRAFT quotation, under a row lock, answering not_found or not_draft rather than letting proposals_guard raise. G-178 appends p_serves — which of the quotation''s declared roles this line is for — with a null default, so every caller written before it behaves identically.';
