-- Two leads that were always one — Doc 09 §5/§34, closing a granular gap.
--
-- §5 (CRITICAL): "maintain source history after merge." §34: "Merge duplicate
-- records through controlled workflow." Neither existed — a grep for
-- merge_lead/merge_contact/merge_duplicate across the whole repository
-- returned nothing. Every dedup control this codebase already has (the
-- import matcher's confidence classification, leads_source_ref_key, the
-- live-WhatsApp-ingest insert-or-find) PREVENTS a duplicate at the moment of
-- capture; none of them help the lead that already has two rows — an import
-- from before the matcher existed, two people at an agency independently
-- creating a lead for the same inbound inquiry, or any case the automatic
-- dedup simply did not catch.
--
-- ── the scope this migration draws, stated rather than left implicit ──────
--
-- Two leads for the SAME contact only. A merge across two DIFFERENT contact
-- rows is a harder, different problem — which contact's phone/email/company
-- becomes the record of truth — that this migration does not attempt; it
-- refuses rather than guesses. Doc 09 §5 asks for "match known client
-- identity" as a separate control from lead dedup, and inventing an answer
-- to it here would be exactly the kind of half-built feature this
-- repository's own history (G-231's review, "built and unreachable" as its
-- own defect class) keeps finding costly.
--
-- Neither lead may carry a `sales.opportunities` row — no deal, of either
-- lead's, is touched by this migration at all. A duplicate lead with a deal
-- already open is not the safe, common case (two rows for one inquiry); it
-- is a question about which deal is real, and that question is commercial,
-- not a data-hygiene merge. Refused by name (`has_opportunity`) rather than
-- silently picking one deal to keep.
--
-- ── what actually moves, and the one table that needs care ────────────────
--
-- crm.lead_activities, crm.conversations, sales.objections, crm.meetings,
-- crm.meeting_evidence, and crm.import_records' committed_lead_id: every one
-- of these has no uniqueness tied to lead_id, so reassigning the loser's
-- rows to the winner cannot collide with anything the winner already has.
--
-- crm.qualification_coverage is the one exception — `unique (lead_id, area)`
-- means a winner that already covered an area the loser also covered would
-- collide on a blind reassignment. Handled by only moving the loser's rows
-- for areas the winner has NOT already covered; the rest stay on the loser,
-- which is not deleted, so nothing is lost — a reader tracing the merge can
-- still open the archived lead and see every row it ever had.
--
-- ── what is not deleted ────────────────────────────────────────────────────
--
-- The loser lead row itself: `merged_into_lead_id` and `merged_at` are set,
-- not the row removed, and not its `status` overloaded with a meaning the
-- CHECK constraint's five values were never asked to carry. §5's "maintain
-- source history after merge" is this: every fact the loser lead ever
-- recorded is still in the database, either moved to the winner or still on
-- the loser's own, still-readable row.

alter table crm.leads
  add column if not exists merged_into_lead_id uuid references crm.leads(id) on delete set null,
  add column if not exists merged_at timestamptz;

comment on column crm.leads.merged_into_lead_id is
  'Set by crm.merge_leads (G-316) when this lead was folded into another. Not a status: crm.leads.status keeps whatever value it already had, because a merge is a data-hygiene fact, not a pipeline stage. Null means never merged.';

create index if not exists leads_merged_into_idx
  on crm.leads (merged_into_lead_id) where merged_into_lead_id is not null;

create or replace function crm.merge_leads(
  p_winner_lead_id uuid,
  p_loser_lead_id  uuid,
  p_reason         text
)
returns table (
  -- 'merged'
  -- refusals: 'no_actor' | 'not_owner' | 'reason_required' | 'not_found'
  --   | 'same_lead' | 'already_merged' | 'different_contact' | 'has_opportunity'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_winner crm.leads;
  v_loser  crm.leads;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    return query select 'reason_required'::text; return;
  end if;

  if p_winner_lead_id = p_loser_lead_id then
    return query select 'same_lead'::text; return;
  end if;

  select l.* into v_winner
    from crm.leads l
   where l.id = p_winner_lead_id and l.organization_id = v_org;

  select l.* into v_loser
    from crm.leads l
   where l.id = p_loser_lead_id and l.organization_id = v_org;

  if v_winner.id is null or v_loser.id is null then
    return query select 'not_found'::text; return;
  end if;

  if v_winner.merged_into_lead_id is not null or v_loser.merged_into_lead_id is not null then
    return query select 'already_merged'::text; return;
  end if;

  -- The scope line: only a lead sharing the winner's own contact is a "two
  -- rows for one inquiry" duplicate. Anything else is an identity-matching
  -- question this door refuses rather than guesses at.
  if v_winner.contact_id is distinct from v_loser.contact_id then
    return query select 'different_contact'::text; return;
  end if;

  if exists (
    select 1 from sales.opportunities o
     where o.lead_id in (p_winner_lead_id, p_loser_lead_id)
  ) then
    return query select 'has_opportunity'::text; return;
  end if;

  update crm.lead_activities set lead_id = p_winner_lead_id where lead_id = p_loser_lead_id;
  update crm.conversations set lead_id = p_winner_lead_id where lead_id = p_loser_lead_id;
  update sales.objections set lead_id = p_winner_lead_id where lead_id = p_loser_lead_id;
  update crm.meetings set lead_id = p_winner_lead_id where lead_id = p_loser_lead_id;
  update crm.meeting_evidence set lead_id = p_winner_lead_id where lead_id = p_loser_lead_id;
  update crm.import_records set committed_lead_id = p_winner_lead_id where committed_lead_id = p_loser_lead_id;

  -- The one collision-prone table: move only what the winner does not
  -- already have an answer for (unique (lead_id, area)). What stays behind
  -- stays readable on the archived loser row.
  update crm.qualification_coverage qc
     set lead_id = p_winner_lead_id
   where qc.lead_id = p_loser_lead_id
     and qc.area not in (
       select area from crm.qualification_coverage where lead_id = p_winner_lead_id
     );

  update crm.leads
     set merged_into_lead_id = p_winner_lead_id,
         merged_at = now()
   where id = p_loser_lead_id;

  perform core.record_audit(
    v_org, 'lead.merged', 'lead', p_loser_lead_id, null,
    jsonb_build_object('mergedInto', p_winner_lead_id, 'reason', p_reason)
  );

  return query select 'merged'::text;
end;
$$;

comment on function crm.merge_leads(uuid, uuid, text) is
  'Folds one lead into another — G-316, Doc 09 section 5/34. Owner only. Refuses across two different contacts (a harder identity question, not this door''s job) and refuses when either lead has any sales.opportunities row (deal state is out of scope). Nothing is deleted: activities, conversations, objections, meetings and evidence move to the winner; the loser row is marked merged_into_lead_id/merged_at rather than removed.';

revoke all on function crm.merge_leads(uuid, uuid, text) from public, anon;
grant execute on function crm.merge_leads(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';
