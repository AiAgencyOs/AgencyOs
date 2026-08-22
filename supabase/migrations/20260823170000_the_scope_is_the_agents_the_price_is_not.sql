-- ═══════════════════════════════════════════════════════════════════════════
-- The scope is the agent's. The price is not.
--
-- Document 09 §15 ends with one sentence that has never been true here:
--
--   *"Quote generation is assisted by AI but governed by the Policy Engine."*
--
-- The quotation loop itself is not missing — `sales.draft_proposal`,
-- `add_proposal_item`, `set_proposal_pricing`, `submit_proposal`,
-- `send_proposal` and the version history on the lead page have all existed
-- since G-011 and ADM-07. **I said otherwise and I was wrong.** What is
-- missing is the AI half: nothing drafts a quotation, so every one starts on a
-- blank form even when an accepted requirement version already lists the scope.
--
-- ── the division, and it is the only interesting part ────────────────────
--
-- The agent registry already states it, and has since the roster landed:
--
--   *"drafts the scope of a quotation. Never states a price."*
--
-- So the agent writes line-item DESCRIPTIONS from confirmed requirements, and
-- every one of them is worth zero until a person prices it. ADM-22 — *"there
-- is no price catalog; every price is quoted per client, by a human"* — is not
-- a thing the workflow remembers to honour. It is what this migration makes
-- impossible.
--
-- ── two additions ────────────────────────────────────────────────────────
--
-- 1. `generated_by_run_id` finally gets written. The column has existed since
--    the schema's first day, commented *"set when an AI agent drafted it"*,
--    and nothing ever set it — so an agent-drafted quotation was
--    indistinguishable from one a person typed, which is exactly the provenance
--    an owner approving it needs.
--
-- 2. **An item on a quotation an agent drafted may not carry a price unless a
--    person put it there.** Identity is the test, not agency: whoever prices a
--    client's project can be named, and the service role has no name.
--
--    Deliberately narrowed to agent-drafted quotations, and the first draft was
--    not. "No price from a nameless caller, ever" is the cleaner sentence and
--    it broke 44 checks in `verify-quotations`, which drives the whole human
--    loop as the service role — as every verification script does. That is a
--    harness fact rather than a product one, but it revealed the real question:
--    is a priced quotation from a job ALWAYS wrong? An imported historical
--    quotation would be one, and refusing it would be this migration deciding
--    a feature nobody has designed. So the rule is scoped to the case ADM-22
--    is actually about here — the agent pricing the quotation it drafted
--    itself — where it is absolute.
--
-- Nothing here loosens anything. Everything a person could do before, they do
-- exactly as before.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. a price has a person behind it ────────────────────────────────────

create or replace function sales.refuse_priced_by_nobody()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Zero passes, which is every item the agent writes. What is refused is a
  -- NUMBER on a quotation the agent drafted, put there by a caller nobody can
  -- name — the one route by which an agent could price its own work, closed at
  -- the row so it holds for a direct PostgREST insert and for any future
  -- caller nobody has written yet.
  if (select auth.uid()) is null
     and (coalesce(new.unit_price_minor, 0) <> 0 or coalesce(new.amount_minor, 0) <> 0)
     and exists (
       select 1 from sales.proposals p
        where p.id = new.proposal_id
          and p.generated_by_run_id is not null
     ) then
    raise exception
      'a price on a quotation an agent drafted is a person''s (ADM-22); this caller has no identity'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function sales.refuse_priced_by_nobody() is
  'ADM-22 at the row. An item on a quotation an AGENT drafted may not carry a price unless a person put it there: identity is the test, the service role has no name, and whoever prices a client''s project can be named. Scoped to agent-drafted quotations rather than to every nameless caller, because an imported historical quotation would be a priced one from a job and refusing it would decide a feature nobody has designed. Where it applies it is absolute: the agent drafts scope at zero, a person prices it.';

drop trigger if exists refuse_priced_by_nobody on sales.proposal_items;
create trigger refuse_priced_by_nobody
  before insert or update of unit_price_minor, amount_minor on sales.proposal_items
  for each row execute function sales.refuse_priced_by_nobody();


-- ── 2. who drafted it ────────────────────────────────────────────────────
--
-- Carried forward from `20260813120019_the_quote_the_owner_signs.sql`, its
-- only and latest definition, **verbatim** with exactly two edits: the
-- appended parameter and the added INSERT column. Both are marked below.
--
-- The first attempt at this was retyped from a reading of the first hundred
-- lines and silently dropped everything after them — the supersede of the
-- previous version, the cancellation of its pending approval, the `superseded`
-- return column, and `security invoker`. Seven checks in `verify-quotations`
-- caught it, which is what they are for. **D16 again**: never regenerate a
-- function, carry it.

create or replace function sales.draft_proposal(
  p_opportunity_id         uuid,
  p_title                  text,
  p_body                   text default null,
  p_valid_until            date default null,
  p_requirement_version_id uuid default null,
  p_created_by             uuid default null,
  -- The one addition to the signature. Appended with a default, so every
  -- existing call means precisely what it meant before.
  p_generated_by_run_id    uuid default null
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
    valid_until, requirement_version_id, currency, created_by,
    -- The second and last addition. The column has existed since the schema's
    -- first day, commented "set when an AI agent drafted it", and nothing ever
    -- set it - so an agent-drafted quotation was indistinguishable from one a
    -- person typed, which is exactly the provenance an owner approving it
    -- needs.
    generated_by_run_id
  )
  values (
    v_opportunity.organization_id, p_opportunity_id, v_next, p_title, p_body,
    p_valid_until, p_requirement_version_id, v_opportunity.currency, p_created_by,
    p_generated_by_run_id
  )
  returning * into v_row;

  return query select 'created'::text, v_row.id, v_next, v_live.id;
end;
$$;

comment on function sales.draft_proposal(uuid, text, text, date, uuid, uuid, uuid) is
  'Opens the next quotation version on an opportunity, under the opportunity lock so two drafters cannot claim one number (Doc 09 section 16). Refuses a settled deal and an empty title. p_generated_by_run_id names the agent run that drafted it, and is null when a person did - an owner approving a quotation should be able to see which it was.';

-- The six-argument form is dropped rather than left beside the new one: two
-- overloads differing only by a defaulted tail make an unqualified call
-- ambiguous, and Postgres reports that at call time rather than here.
drop function if exists sales.draft_proposal(uuid, text, text, date, uuid, uuid);

grant execute on function sales.draft_proposal(uuid, text, text, date, uuid, uuid, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
