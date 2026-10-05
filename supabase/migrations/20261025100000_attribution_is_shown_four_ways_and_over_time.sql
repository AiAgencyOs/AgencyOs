-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, follow-up — attribution shown four ways, and over time.
--
-- Slice 11 credited a lead to the channel that FOUND it and showed last-touch
-- and touched-by counts beside it. The specification also asks how credit moves
-- when it is shared. `acquisition_attribution_models` shows the same leads under
-- first touch, last touch, linear (every channel that touched the lead shares
-- one credit equally) and position-based (40% first, 40% last, 20% shared by
-- the middle; two channels split 50/50; one channel takes it all). The four
-- columns each sum to the number of leads, so no model can invent credit.
-- `acquisition_trend` is the same first-touch view by week.
-- Both are STABLE reads for an INTERNAL session of its own organisation only;
-- with no session they answer with nothing (an all-organisation aggregate
-- would mix tenants).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.acquisition_attribution_models(p_days integer default 90)
returns table (channel text, first_touch numeric, last_touch numeric, linear numeric, position_based numeric)
language sql stable security definer set search_path = '' as $$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org, coalesce((select core.is_internal()), false) as internal),
  leads_w as (
    select l.id from crm.leads l, caller k
     where l.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 730)))
       and l.merged_into_lead_id is null and k.uid is not null and k.internal and l.organization_id = k.org
  ),
  seq as (
    select t.lead_id, crm._acq_channel(t.channel) as ch,
           row_number() over (partition by t.lead_id order by t.occurred_at, t.recorded_at, t.id) as rn
      from crm.lead_touchpoints t join leads_w w on w.id = t.lead_id
  ),
  firsts as (select lead_id, ch from seq where rn = 1),
  lasts as (select distinct on (lead_id) lead_id, ch from seq order by lead_id, rn desc),
  chans as (select lead_id, ch, min(rn) as pos from seq group by lead_id, ch),
  n as (select lead_id, count(*) as k from chans group by lead_id),
  pos as (
    select c.lead_id, c.ch,
           case when n.k = 1 then 1.0
                when f.ch = l.ch then case when c.ch = f.ch then 0.8 else 0.2 / (n.k - 1) end
                when n.k = 2 then 0.5
                when c.ch = f.ch or c.ch = l.ch then 0.4
                else 0.2 / (n.k - 2)
           end as w
      from chans c join n using (lead_id) join firsts f using (lead_id) join lasts l using (lead_id)
  ),
  allch as (select unnest(array['meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other']) as ch)
  select a.ch,
         coalesce((select count(*) from firsts f where f.ch = a.ch), 0)::numeric,
         coalesce((select count(*) from lasts l where l.ch = a.ch), 0)::numeric,
         coalesce((select sum(1.0 / n.k) from chans c join n using (lead_id) where c.ch = a.ch), 0)::numeric(12, 3),
         coalesce((select sum(p.w) from pos p where p.ch = a.ch), 0)::numeric(12, 3)
    from allch a
   order by array_position(array['meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other'], a.ch);
$$;
revoke all on function crm.acquisition_attribution_models(integer) from public, anon;
grant execute on function crm.acquisition_attribution_models(integer) to authenticated, service_role;
comment on function crm.acquisition_attribution_models(integer) is 'The same leads credited under first, last, linear and position-based (40/20/40) attribution. Each column sums to the number of leads that have a touch.';

create or replace function crm.acquisition_trend(p_weeks integer default 12)
returns table (week_start date, channel text, leads bigint, qualified bigint)
language sql stable security definer set search_path = '' as $$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org, coalesce((select core.is_internal()), false) as internal),
  w as (select greatest(1, least(coalesce(p_weeks, 12), 52)) as n),
  leads_w as (
    select l.id, l.created_at, l.qualified_at from crm.leads l, caller k, w
     where l.created_at >= date_trunc('week', now()) - make_interval(weeks => w.n - 1)
       and l.merged_into_lead_id is null and k.uid is not null and k.internal and l.organization_id = k.org
  ),
  ft as (
    select distinct on (t.lead_id) t.lead_id, crm._acq_channel(t.channel) as ch
      from crm.lead_touchpoints t join leads_w lw on lw.id = t.lead_id order by t.lead_id, t.occurred_at, t.recorded_at, t.id
  )
  select date_trunc('week', lw.created_at)::date, coalesce(ft.ch, 'other'), count(*)::bigint, count(*) filter (where lw.qualified_at is not null)::bigint
    from leads_w lw left join ft on ft.lead_id = lw.id
   group by 1, 2 order by 1, 2;
$$;
revoke all on function crm.acquisition_trend(integer) from public, anon;
grant execute on function crm.acquisition_trend(integer) to authenticated, service_role;

notify pgrst, 'reload schema';
