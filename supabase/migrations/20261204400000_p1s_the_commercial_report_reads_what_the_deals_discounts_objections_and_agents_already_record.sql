-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 rest-gaps round 4, step 5 (traceability: docs/phase-1-3-implementation-traceability.md):
--   P1-CRM-045 (sales dashboard)  average deal value, top objections, source -> conversion, per-agent performance
--   P1-CRM-063 (sales analytics)  average deal value, discount impact, trust-offer conversion, repeat-client conversion, nurture conversion, agent performance
--
-- ONE READ. `sales.p1s_commercial_report(days)` counts rows that already exist (opportunities, objections, discount decisions, quotations and the payment
-- structure each one printed, leads, agent runs) over a window and returns them as numbers. It writes nothing, adds no table and keeps no copy, so it cannot
-- disagree with the records it counts. A rate is returned only with the counts it came from, and is null (never zero) when there is nothing to divide:
-- "no deals closed" and "every deal was lost" are different statements.
--
-- Definitions, so the page can print them:
--   closed deal      an opportunity that reached won or lost (closed_at) inside the window
--   discounted deal  a closed deal with a quotation that carries a discount decision that took effect (autonomous or approved)
--   trust offer      a closed deal whose latest quotation printed a payment structure of kind lower_advance, prototype_first, split or deferral
--   repeat deal      a closed deal of kind renewal or upsell
--   nurture lead     a lead with a nurture reason recorded; converted when it also has a won deal
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function sales.p1s_commercial_report(p_days integer default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_days integer := least(greatest(coalesce(p_days, 90), 1), 730);
  v_since timestamptz;
  v_out jsonb;
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then return null; end if;
  v_since := now() - make_interval(days => v_days);

  with closed as (
    select o.id, o.lead_id, o.kind, o.stage, o.value_minor, o.closed_at
      from sales.opportunities o
     where o.organization_id = v_org and o.stage in ('won', 'lost') and o.closed_at >= v_since
  ), disc as (
    select distinct p.opportunity_id
      from sales.discount_decisions d join sales.proposals p on p.id = d.proposal_id
     where d.organization_id = v_org and d.status in ('autonomous', 'approved')
  ), last_prop as (
    select distinct on (p.opportunity_id) p.opportunity_id, p.document -> 'paymentStructure' ->> 'name' as ps_name
      from sales.proposals p where p.organization_id = v_org and p.status not in ('cancelled', 'superseded')
     order by p.opportunity_id, p.version desc
  ), trust as (
    select lp.opportunity_id from last_prop lp join sales.payment_structures s on s.organization_id = v_org and s.name = lp.ps_name
     where s.kind in ('lower_advance', 'prototype_first', 'split', 'deferral')
  ), nurt as (
    select l.id as lead_id from crm.leads l where l.organization_id = v_org and l.nurture_reason is not null and l.deleted_at is null
  )
  select jsonb_build_object(
    'days', v_days,
    'since', v_since,
    'deals', jsonb_build_object(
      'won', (select count(*) from closed where stage = 'won'),
      'lost', (select count(*) from closed where stage = 'lost'),
      'wonValueMinor', (select coalesce(sum(value_minor), 0) from closed where stage = 'won'),
      'avgWonValueMinor', (select round(avg(value_minor)) from closed where stage = 'won')),
    'discount', jsonb_build_object(
      'decisions', (select jsonb_object_agg(s.status, s.n) from (select d.status, count(*) as n from sales.discount_decisions d where d.organization_id = v_org and d.created_at >= v_since group by d.status) s),
      'takenEffectMinor', (select coalesce(sum(d.discount_minor), 0) from sales.discount_decisions d where d.organization_id = v_org and d.created_at >= v_since and d.status in ('autonomous', 'approved')),
      'avgPct', (select round(avg(d.discount_pct), 1) from sales.discount_decisions d where d.organization_id = v_org and d.created_at >= v_since and d.status in ('autonomous', 'approved')),
      'discountedWon', (select count(*) from closed c join disc on disc.opportunity_id = c.id where c.stage = 'won'),
      'discountedLost', (select count(*) from closed c join disc on disc.opportunity_id = c.id where c.stage = 'lost'),
      'plainWon', (select count(*) from closed c where c.stage = 'won' and not exists (select 1 from disc where disc.opportunity_id = c.id)),
      'plainLost', (select count(*) from closed c where c.stage = 'lost' and not exists (select 1 from disc where disc.opportunity_id = c.id))),
    'trustOffer', jsonb_build_object(
      'won', (select count(*) from closed c join trust t on t.opportunity_id = c.id where c.stage = 'won'),
      'lost', (select count(*) from closed c join trust t on t.opportunity_id = c.id where c.stage = 'lost'),
      'standardWon', (select count(*) from closed c where c.stage = 'won' and not exists (select 1 from trust t where t.opportunity_id = c.id)),
      'standardLost', (select count(*) from closed c where c.stage = 'lost' and not exists (select 1 from trust t where t.opportunity_id = c.id))),
    'repeat', jsonb_build_object(
      'won', (select count(*) from closed where stage = 'won' and kind <> 'new'),
      'lost', (select count(*) from closed where stage = 'lost' and kind <> 'new'),
      'newWon', (select count(*) from closed where stage = 'won' and kind = 'new'),
      'newLost', (select count(*) from closed where stage = 'lost' and kind = 'new')),
    'nurture', jsonb_build_object(
      'leads', (select count(*) from nurt),
      'converted', (select count(*) from nurt n where exists (select 1 from sales.opportunities o where o.lead_id = n.lead_id and o.organization_id = v_org and o.stage = 'won'))),
    'objections', coalesce((select jsonb_agg(jsonb_build_object('kind', x.kind, 'raised', x.raised, 'open', x.open_n, 'lost', x.lost_n) order by x.raised desc, x.kind)
                              from (select ob.kind, count(*) as raised, count(*) filter (where ob.outcome is null) as open_n, count(*) filter (where ob.outcome = 'lost') as lost_n
                                      from sales.objections ob where ob.organization_id = v_org and ob.created_at >= v_since group by ob.kind) x), '[]'::jsonb),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('source', x.source, 'leads', x.leads, 'won', x.won) order by x.leads desc, x.source)
                           from (select l.source, count(*) as leads,
                                        count(*) filter (where exists (select 1 from sales.opportunities o where o.lead_id = l.id and o.organization_id = v_org and o.stage = 'won')) as won
                                   from crm.leads l where l.organization_id = v_org and l.deleted_at is null and l.created_at >= v_since group by l.source) x), '[]'::jsonb),
    'agents', coalesce((select jsonb_agg(jsonb_build_object('agent', x.agent_key, 'runs', x.runs, 'succeeded', x.ok, 'failed', x.bad, 'costMinor', x.cost, 'avgLatencyMs', x.lat) order by x.runs desc, x.agent_key)
                          from (select r.agent_key, count(*) as runs, count(*) filter (where r.status = 'succeeded') as ok, count(*) filter (where r.status = 'failed') as bad,
                                       coalesce(sum(r.cost_minor), 0) as cost, round(avg(r.latency_ms)) as lat
                                  from ai.agent_runs r where r.organization_id = v_org and r.created_at >= v_since group by r.agent_key) x), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function sales.p1s_commercial_report(integer) from public, anon;
grant execute on function sales.p1s_commercial_report(integer) to authenticated, service_role;
comment on function sales.p1s_commercial_report(integer) is
  'P1-CRM-045 / P1-CRM-063. Read-only counts over a window of deals, discounts, objections, leads and agent runs, scoped to the caller''s organization (internal members only). Rates are computed by the caller from the counts returned.';
