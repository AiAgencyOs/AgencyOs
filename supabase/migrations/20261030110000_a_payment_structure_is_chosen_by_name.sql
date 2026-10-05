-- ═══════════════════════════════════════════════════════════════════════════
-- A payment structure is chosen by name — Business Phase 1-4 audit, step 1.28
-- ("Payment structure negotiation"), 2026-09-28.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The audit's finding: *"No enum/catalog of approved payment structures
-- (standard/lower-advance/prototype-first/split/deferral) exists anywhere
-- pre-WON."* That is true of a closed, named vocabulary — but
-- `sales.payment_structures` (G-196, 20260904130000) already built almost
-- everything the step needs: an owner-authored, per-organization, named set
-- of milestone schedules, each optionally bounded to an amount band, replaced
-- whole through `sales.set_payment_structure` and frozen onto a quotation's
-- document exactly the way `sales.approved_offers` freezes a discount.
--
-- **What G-196 does not have, and what step 1.28 actually asks for:** a
-- CLOSED set of named kinds a negotiation can select among deliberately
-- ("the client wants a lower advance" → `lower_advance`), rather than only an
-- amount-band default a total happens to fall into. And nothing has ever
-- actually written `document.paymentStructure` onto a proposal — the field is
-- parsed on read (`quotation-standards.ts`) but no function has ever set it.
-- Both gaps are closed here.
--
-- ── why this extends payment_structures instead of a new table ────────────
--
-- The audit's own step 1.28 note invites exactly this deviation, with a
-- condition: justify it against this repository's stated preference for
-- reusing generic engines rather than building a parallel one.
--
-- A brand-new `sales.payment_structure_options` table would have to
-- reimplement, verbatim, everything `sales.payment_structures` already is:
-- owner-only authorship, the "written through a function, not by hand" guard
-- (`sales.payment_write_is_sanctioned`), the milestones-sum-to-100 deferred
-- trigger, the tenancy pair, the RLS split between select and write. That is
-- the exact shape `sales.approved_offers` is for a single discount, extended
-- here to several named structures at once — reusing the EXISTING approvals
-- engine for Task 1 and reusing this EXISTING catalog for Task 2 are the same
-- discipline applied twice. `kind` is one additive, nullable column: existing
-- band-matched structures (and every structure an agency authors without a
-- negotiation in mind) are entirely unaffected.
--
-- ── the five names, and why they are not required ──────────────────────────
--
-- 'standard' | 'lower_advance' | 'prototype_first' | 'split' | 'deferral' are
-- Doc 07's own vocabulary for the shapes a negotiation actually asks for. Not
-- one is seeded: an owner who authors nothing keeps the two corpus families,
-- exactly as G-196 already guarantees, and a `kind` this agency never
-- configures is a `kind` `apply_payment_structure_kind` answers 'no_structure_of_kind'
-- for — a named, correct refusal, not an invented schedule.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the closed vocabulary, in DDL ────────────────────────────────────────

alter table sales.payment_structures
  add column if not exists kind text
    check (kind is null or kind in (
      'standard', 'lower_advance', 'prototype_first', 'split', 'deferral'
    ));

comment on column sales.payment_structures.kind is
  'Business Phase 1-4 audit step 1.28: the closed set a negotiation may select a structure BY NAME from, distinct from the amount-band default sales.payment_structures already resolves. Null on every structure authored before this existed and on any structure an owner authors purely as a band default with no negotiation kind in mind.';

-- One ACTIVE structure per kind per organization — the same reason
-- sales.approved_offers allows only one live offer: several would make the
-- agent (or a human negotiating) CHOOSE between two 'lower_advance'
-- structures, and choosing between concessions is the judgement this whole
-- catalog exists to remove from that moment. Partial on kind is not null, so
-- structures with no kind (the ordinary band-matched case) are unaffected and
-- may stack as freely as they always could.
create unique index if not exists payment_structures_active_kind_key
  on sales.payment_structures (organization_id, kind)
  where active and kind is not null;

-- ── 2. authoring one now names its kind, additively ────────────────────────
--
-- The live signature gains a fifth, optional parameter — same reason
-- 20260929100000 drops and recreates set_proposal_pricing rather than relying
-- on create-or-replace to widen a parameter list in place.
drop function if exists sales.set_payment_structure(uuid, text, jsonb, bigint, bigint);

create or replace function sales.set_payment_structure(
  p_organization_id uuid,
  p_name text,
  p_milestones jsonb,
  p_min_amount_minor bigint default null,
  p_max_amount_minor bigint default null,
  p_kind text default null
)
returns table (outcome text, structure_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_id     uuid;
  v_total  numeric := 0;
  v_count  int;
  v_row    jsonb;
  v_pos    int := 0;
begin
  -- Coalesced, not bare: 20260920100000 fixed every bare `not (select
  -- core.is_owner())` in this schema because a NULL role reads as "not
  -- false", which negates to true and fails OPEN. This function re-lays the
  -- live definition, so it carries the fix forward rather than reintroducing
  -- the 49th occurrence that migration's own guard exists to catch.
  if v_actor is not null and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  if p_kind is not null and p_kind not in (
    'standard', 'lower_advance', 'prototype_first', 'split', 'deferral'
  ) then
    return query select 'invalid_kind'::text, null::uuid;
    return;
  end if;

  if jsonb_typeof(p_milestones) <> 'array' then
    return query select 'invalid_milestones'::text, null::uuid;
    return;
  end if;

  select count(*) into v_count from jsonb_array_elements(p_milestones);
  if v_count < 1 or v_count > 8 then
    return query select 'invalid_milestones'::text, null::uuid;
    return;
  end if;

  for v_row in select * from jsonb_array_elements(p_milestones) loop
    if jsonb_typeof(v_row->'pct') <> 'number'
       or coalesce(btrim(v_row->>'label'), '') = ''
       or length(btrim(v_row->>'label')) > 120
       or (v_row->>'pct')::numeric <= 0
       or (v_row->>'pct')::numeric > 100 then
      return query select 'invalid_milestones'::text, null::uuid;
      return;
    end if;
    v_total := v_total + (v_row->>'pct')::numeric;
  end loop;

  if v_total <> 100 then
    return query select 'does_not_sum'::text, null::uuid;
    return;
  end if;

  if p_min_amount_minor is not null and p_max_amount_minor is not null
     and p_min_amount_minor >= p_max_amount_minor then
    return query select 'invalid_band'::text, null::uuid;
    return;
  end if;

  -- The kind's own uniqueness is checked here, ahead of the write, so a
  -- second 'lower_advance' authored under a different NAME is told why
  -- rather than handed payment_structures_active_kind_key's constraint
  -- violation. Editing the SAME name that already holds a kind is not a
  -- collision — it is the update branch below.
  if p_kind is not null and not exists (
    select 1 from sales.payment_structures s
     where s.organization_id = p_organization_id and s.name = btrim(p_name)
  ) and exists (
    select 1 from sales.payment_structures s
     where s.organization_id = p_organization_id and s.kind = p_kind and s.active
  ) then
    return query select 'kind_already_active'::text, null::uuid;
    return;
  end if;

  perform set_config('sales.payment_write', 'on', true);

  select s.id into v_id
    from sales.payment_structures s
   where s.organization_id = p_organization_id and s.name = btrim(p_name);

  if v_id is null then
    insert into sales.payment_structures (
      organization_id, name, min_amount_minor, max_amount_minor, kind, created_by
    )
    values (p_organization_id, btrim(p_name), p_min_amount_minor, p_max_amount_minor, p_kind, v_actor)
    returning id into v_id;
  else
    update sales.payment_structures
       set min_amount_minor = p_min_amount_minor,
           max_amount_minor = p_max_amount_minor,
           kind             = p_kind,
           active           = true
     where id = v_id;
    delete from sales.payment_milestones m where m.structure_id = v_id;
  end if;

  for v_row in select * from jsonb_array_elements(p_milestones) loop
    insert into sales.payment_milestones (organization_id, structure_id, position, label, pct)
    values (p_organization_id, v_id, v_pos, btrim(v_row->>'label'), (v_row->>'pct')::numeric);
    v_pos := v_pos + 1;
  end loop;

  perform core.record_audit(
    p_organization_id, 'payment_structure.set', 'payment_structure', v_id,
    null,
    jsonb_build_object('name', btrim(p_name), 'milestones', p_milestones, 'kind', p_kind,
                       'min_amount_minor', p_min_amount_minor, 'max_amount_minor', p_max_amount_minor),
    null
  );

  return query select 'set'::text, v_id;
end;
$$;

comment on function sales.set_payment_structure(uuid, text, jsonb, bigint, bigint, text) is
  'Doc 07 section 11''s configurable payment terms, replaced whole rather than edited row by row. Since the Business Phase 1-4 audit (step 1.28): an optional kind from the closed set (standard/lower_advance/prototype_first/split/deferral) names this structure as one a negotiation may select BY NAME, enforced one-active-per-kind by payment_structures_active_kind_key. Owner only, unchanged.';

revoke all on function sales.set_payment_structure(uuid, text, jsonb, bigint, bigint, text) from public;
grant execute on function sales.set_payment_structure(uuid, text, jsonb, bigint, bigint, text) to authenticated, service_role;

-- ── 3. applying one to a draft quotation ────────────────────────────────────
--
-- The shape sales.apply_approved_offer already established for a discount:
-- look up the ONE authorised thing by its name, freeze it onto the DRAFT
-- document, refuse cleanly when there is nothing to apply. This is the first
-- function that ever WRITES document.paymentStructure — quotation-standards.ts
-- has read the field since G-196 and nothing has ever set it.

create or replace function sales.apply_payment_structure_kind(
  p_proposal_id uuid,
  p_kind        text
)
returns table (outcome text, structure_id uuid, name text)
language plpgsql
set search_path = ''
as $$
declare
  v_row       sales.proposals;
  v_structure sales.payment_structures;
  v_milestones jsonb;
begin
  if p_kind not in ('standard', 'lower_advance', 'prototype_first', 'split', 'deferral') then
    return query select 'invalid_kind'::text, null::uuid, null::text;
    return;
  end if;

  select p.* into v_row from sales.proposals p where p.id = p_proposal_id for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_row.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid, null::text;
    return;
  end if;

  select s.* into v_structure
    from sales.payment_structures s
   where s.organization_id = v_row.organization_id
     and s.kind = p_kind
     and s.active;

  if v_structure.id is null then
    -- Named, correct refusal (Master's "do not fake completion"): this
    -- agency has not authored a structure of this kind, so none is applied
    -- and none is invented. The quotation keeps whatever schedule it already
    -- resolves to — the two corpus families, or its own band-matched
    -- structure.
    return query select 'no_structure_of_kind'::text, null::uuid, null::text;
    return;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('label', m.label, 'pct', m.pct) order by m.position), '[]'::jsonb)
    into v_milestones
    from sales.payment_milestones m
   where m.structure_id = v_structure.id;

  update sales.proposals
     set document = coalesce(document, '{}'::jsonb) || jsonb_build_object(
                      'paymentStructure', jsonb_build_object(
                        'name', v_structure.name,
                        'milestones', v_milestones
                      )
                    )
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'payment_structure.applied', 'proposal', v_row.id,
    null,
    jsonb_build_object('structure_id', v_structure.id, 'kind', p_kind, 'name', v_structure.name),
    null
  );

  return query select 'applied'::text, v_structure.id, v_structure.name;
end;
$$;

comment on function sales.apply_payment_structure_kind(uuid, text) is
  'Business Phase 1-4 audit step 1.28: freezes the organization''s ONE active named structure of the given kind onto a DRAFT quotation''s document.paymentStructure, read from there ever since by paymentScheduleFor (G-196) but never before written by any function. Never invents a schedule: no structure of that kind authored by the owner is a named refusal (no_structure_of_kind), not a fabricated one. Callable by internal staff with proposal.draft authority today; if a sales-agent negotiation workflow is ever authorised to propose a payment structure, this is the one door through which it could only ever select a name the owner already authored — never invent milestones of its own.';

insert into core.event_types (type, description, canonical)
values (
  'payment_structure.applied',
  'A named, owner-authored payment structure was applied to a draft quotation (Business Phase 1-4 audit step 1.28).',
  null
)
on conflict (type) do nothing;
