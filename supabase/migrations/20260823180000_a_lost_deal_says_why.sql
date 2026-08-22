-- ═══════════════════════════════════════════════════════════════════════════
-- A lost deal says why.
--
-- Document 09 §38's acceptance criteria contains one line: *"LOST requires a
-- reason."* It is true of `setOpportunityStage` and **only** of it —
-- `service.ts` refuses an empty reason and the row does not, so a write
-- straight through PostgREST settles a deal as lost with nothing recorded.
-- The same half-a-check shape this repository keeps finding in itself: a rule
-- held by two layers and enforced by one.
--
-- ── and a free-text reason cannot be counted ─────────────────────────────
--
-- §37 asks for *"lost reason distribution"*, §30's dashboard for *"top lost
-- reasons"*, and neither is possible from prose. Ten leads lost for the same
-- cause, described ten ways, group into ten rows of one.
--
-- §25 names the categories, so they are not invented here:
--
--   price too high · no budget · chose competitor · project postponed ·
--   no response · not a fit · requirements changed · trust not established ·
--   timeline mismatch · client cancelled · other
--
-- **Both are kept.** The category is what a report groups by; the sentence is
-- what a person reads. Replacing the words with a dropdown would lose the only
-- part of a lost deal anybody learns from.
--
-- ── what history is not asked to become ──────────────────────────────────
--
-- The constraint is added `not valid`. Every new or changed row must satisfy
-- it; the rows already lost are left exactly as they are.
--
-- Backfilling them to `other` was the alternative and it is the wrong one:
-- ADM-76's principle is that **a record invented now is indistinguishable from
-- one made at the time**, and a report reading "37 lost: other" would be
-- reading a column this migration wrote, not a judgement anybody made.
-- `not valid` is the honest version of "from here on".
-- ═══════════════════════════════════════════════════════════════════════════

alter table sales.opportunities
  add column if not exists lost_category text
    check (lost_category is null or lost_category in (
      -- Document 09 §25, in the order it lists them.
      'price_too_high',
      'no_budget',
      'chose_competitor',
      'project_postponed',
      'no_response',
      'not_a_fit',
      'requirements_changed',
      'trust_not_established',
      'timeline_mismatch',
      'client_cancelled',
      'other'
    ));

comment on column sales.opportunities.lost_category is
  'Document 09 section 25''s eleven, so section 37''s "lost reason distribution" and section 30''s "top lost reasons" are countable. Kept BESIDE lost_reason rather than replacing it: the category is what a report groups by, the sentence is what a person reads, and a dropdown alone would lose the only part of a lost deal anybody learns from.';

-- ── the line §38 asks for, at the row ────────────────────────────────────

alter table sales.opportunities
  drop constraint if exists opportunities_lost_says_why;

alter table sales.opportunities
  add constraint opportunities_lost_says_why check (
    stage <> 'lost'
    or (lost_category is not null and length(btrim(coalesce(lost_reason, ''))) > 0)
  ) not valid;

comment on constraint opportunities_lost_says_why on sales.opportunities is
  'Document 09 section 38: "LOST requires a reason." Both halves - the category a report counts and the sentence a person reads. NOT VALID on purpose: it binds every new and changed row and leaves the already-lost ones alone, because backfilling them to "other" would write a judgement nobody made (ADM-76). setOpportunityStage refused an empty reason before this and the row did not, so a direct PostgREST write settled a deal with nothing recorded.';

create index if not exists opportunities_lost_category_idx
  on sales.opportunities (organization_id, lost_category)
  where stage = 'lost';


-- ── a reopened deal drops the category too ───────────────────────────────
--
-- Carried forward from `20260813120029_a_deal_can_be_repriced.sql`, its only
-- and latest definition, with one added line. Without it a reopened deal keeps
-- the category it was lost under, and every report of why deals are lost
-- counts a deal that is back in the pipeline — which is the exact defect
-- G-089 closed for `closed_at` and `lost_reason`.

create or replace function sales.clear_settlement_on_reopen()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Leaving a terminal stage is the only way a deal reopens. Written against
  -- "was terminal, now is not" rather than against `lost` specifically, so
  -- opening `won` later is a change to the transition map alone.
  if old.stage in ('won', 'lost')
     and new.stage not in ('won', 'lost')
  then
    new.closed_at     := null;
    new.lost_reason   := null;
    new.lost_category := null;
  end if;

  return new;
end;
$$;

comment on function sales.clear_settlement_on_reopen() is
  'Clears closed_at, lost_reason and lost_category when a deal leaves a terminal stage (G-089). setOpportunityStage already did this; the trigger covers every other path, including a write straight through PostgREST, which would otherwise leave a discovery deal carrying the day it closed and why it was lost - counted by every report of why deals are lost.';


-- ── and the distribution §37 asks for ────────────────────────────────────
--
-- Beside `crm.sales_funnel` rather than inside it: the funnel counts leads
-- through stages, and this counts DEALS by outcome. One function returning
-- both would be one function answering two questions, and the second would
-- have to repeat the first's cohort to mean anything.

create or replace function sales.lost_reasons(
  p_from timestamptz default (now() - interval '90 days'),
  p_to timestamptz default now(),
  p_organization_id uuid default null
)
returns table (
  lost_category text,
  deals         int,
  share         numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_total int;
begin
  -- The tenant pin `crm.sales_funnel` and `crm.reactivation_priority` use: an
  -- authenticated caller reads its own organization whatever it passes.
  v_org := case
    when (select auth.uid()) is not null then (select core.current_organization_id())
    else p_organization_id
  end;

  if v_org is null then
    return;
  end if;

  select count(*)::int into v_total
    from sales.opportunities o
   where o.organization_id = v_org
     and o.stage = 'lost'
     and o.closed_at >= p_from
     and o.closed_at < p_to;

  if v_total = 0 then
    return;
  end if;

  return query
  select
    -- Null is its own row rather than folded into `other`. A deal lost before
    -- this migration has no category, and calling that "other" would be the
    -- backfill the constraint deliberately refused.
    coalesce(o.lost_category, 'not recorded'),
    count(*)::int,
    round((count(*)::numeric / v_total) * 100, 1)
    from sales.opportunities o
   where o.organization_id = v_org
     and o.stage = 'lost'
     and o.closed_at >= p_from
     and o.closed_at < p_to
   group by 1
   order by 2 desc, 1;
end;
$$;

comment on function sales.lost_reasons(timestamptz, timestamptz, uuid) is
  'Document 09 section 37''s "lost reason distribution" and section 30''s "top lost reasons": deals closed lost in a window, grouped by section 25''s categories, with each share of the total. A deal lost before the category existed appears as "not recorded" rather than as "other" - calling it other would be the backfill opportunities_lost_says_why deliberately refused. Returns NOTHING when no deal was lost, rather than a row of zeroes: a share of nothing is not 0 percent. An authenticated caller is pinned to its own organization; read-only.';

grant execute on function sales.lost_reasons(timestamptz, timestamptz, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
