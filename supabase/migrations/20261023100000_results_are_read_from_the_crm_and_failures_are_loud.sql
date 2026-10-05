-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 11 — Results are read from the CRM, goals are
-- measured against what the Admin set, and what is failing is loud.
--
-- WHAT THE AUDIT FOUND. Each engine had its own numbers (slices 6-10), but
-- nothing answered the questions the specification's analytics section asks
-- across ALL five: which channel produced the qualified leads and the wins,
-- what did each cost, is a channel on pace for the Admin's goal, which
-- attribution view are we using, and - the one that matters on a Monday - what
-- is broken right now. A dashboard assembled in the browser from five tables
-- would also be five places for the numbers to disagree.
--
-- WHAT THIS ADDS (reading only; nothing here acts, writes or sends).
--  1. `acquisition_funnel`: by channel over a window - leads, qualified,
--     completed meetings, sent quotations, won, revenue (kept PER CURRENCY, never
--     summed across them), spend from the usage ledger, and the cost of each
--     step. The channel a lead is credited to is its FIRST touch, and the same
--     rows carry last-touch and "touched by" counts so the two views can be
--     compared instead of argued about. A cost with nothing to divide by is null.
--  2. `acquisition_goal_progress`: this month's qualified leads and spend against
--     the Admin's monthly goal and budget, with the pace the month implies.
--  3. `acquisition_failures`: one list of what is wrong - executions that failed,
--     stalled or have an unknown outcome; approved work nobody applied; pages not
--     verified; connections degraded or revoked; critical campaign findings; open
--     alerts from the acquisition workers; subtasks that failed; stops in force.
--  4. `acquisition_recommendations`: ADVICE, never action - behind pace, a cost
--     far above its sibling, a channel acting without producing a lead (tracking
--     may be broken), a budget nearly used - each with the numbers it rests on
--     and silent when the sample is too small to judge.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm._acq_channel(p text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case when p in ('meta_ads', 'email', 'social', 'google_ads', 'b2b') then p else 'other' end;
$$;

create or replace function crm.acquisition_funnel(p_days integer default 90)
returns table (
  channel text, leads bigint, qualified bigint, meetings bigint, quotes bigint, won bigint, revenue jsonb,
  spend_minor bigint, cost_per_lead_minor bigint, cost_per_qualified_minor bigint, cost_per_won_minor bigint,
  last_touch_leads bigint, touched_leads bigint, won_last_touch bigint, insufficient_data boolean
)
language sql stable security definer set search_path = '' as $$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org),
  win as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 730))) as since),
  leads_w as (
    select l.id, l.organization_id, l.qualified_at
      from crm.leads l, caller k, win w
     where l.created_at >= w.since and l.merged_into_lead_id is null and (k.uid is null or l.organization_id = k.org)
  ),
  ft as (
    select distinct on (t.lead_id) t.lead_id, crm._acq_channel(t.channel) as ch
      from crm.lead_touchpoints t join leads_w lw on lw.id = t.lead_id order by t.lead_id, t.occurred_at, t.recorded_at, t.id
  ),
  lt as (
    select distinct on (t.lead_id) t.lead_id, crm._acq_channel(t.channel) as ch
      from crm.lead_touchpoints t join leads_w lw on lw.id = t.lead_id order by t.lead_id, t.occurred_at desc, t.recorded_at desc, t.id desc
  ),
  touched as (
    select distinct crm._acq_channel(t.channel) as ch, t.lead_id from crm.lead_touchpoints t join leads_w lw on lw.id = t.lead_id
  ),
  per_lead as (
    select lw.id, coalesce(ft.ch, 'other') as ch, coalesce(lt.ch, 'other') as lch, lw.qualified_at is not null as q,
           exists (select 1 from crm.meetings m where m.lead_id = lw.id and m.status = 'completed') as mtg,
           exists (select 1 from sales.proposals p join sales.opportunities op on op.id = p.opportunity_id where op.lead_id = lw.id and p.status in ('sent', 'accepted')) as quo,
           crm.lead_outcome(lw.id) = 'WON' as w,
           (select op.currency from sales.opportunities op where op.lead_id = lw.id and op.stage = 'won' order by op.created_at desc limit 1) as cur,
           (select op.value_minor from sales.opportunities op where op.lead_id = lw.id and op.stage = 'won' order by op.created_at desc limit 1) as val
      from leads_w lw left join ft on ft.lead_id = lw.id left join lt on lt.lead_id = lw.id
  ),
  rev as (
    select ch, jsonb_object_agg(cur, s) as revenue from (select ch, cur, sum(val)::bigint as s from per_lead where w and cur is not null and val is not null group by ch, cur) x group by ch
  ),
  spend as (
    select crm._acq_channel(u.channel) as ch, sum(u.amount)::bigint as s from crm.acquisition_usage u, caller k, win w
     where u.metric = 'spend_minor' and u.occurred_at >= w.since and (k.uid is null or u.organization_id = k.org) group by 1
  ),
  chans as (select unnest(array['meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other']) as ch)
  select c.ch,
         coalesce(count(p.id), 0)::bigint,
         coalesce(count(p.id) filter (where p.q), 0)::bigint,
         coalesce(count(p.id) filter (where p.mtg), 0)::bigint,
         coalesce(count(p.id) filter (where p.quo), 0)::bigint,
         coalesce(count(p.id) filter (where p.w), 0)::bigint,
         coalesce((select r.revenue from rev r where r.ch = c.ch), '{}'::jsonb),
         coalesce((select s.s from spend s where s.ch = c.ch), 0)::bigint,
         case when count(p.id) > 0 and coalesce((select s.s from spend s where s.ch = c.ch), 0) > 0 then ((select s.s from spend s where s.ch = c.ch) / count(p.id))::bigint end,
         case when count(p.id) filter (where p.q) > 0 and coalesce((select s.s from spend s where s.ch = c.ch), 0) > 0 then ((select s.s from spend s where s.ch = c.ch) / count(p.id) filter (where p.q))::bigint end,
         case when count(p.id) filter (where p.w) > 0 and coalesce((select s.s from spend s where s.ch = c.ch), 0) > 0 then ((select s.s from spend s where s.ch = c.ch) / count(p.id) filter (where p.w))::bigint end,
         (select count(*) from per_lead x where x.lch = c.ch)::bigint,
         (select count(*) from touched t where t.ch = c.ch)::bigint,
         (select count(*) from per_lead x where x.lch = c.ch and x.w)::bigint,
         coalesce(count(p.id), 0) < 10
    from chans c left join per_lead p on p.ch = c.ch
   group by c.ch
   order by array_position(array['meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other'], c.ch);
$$;
revoke all on function crm.acquisition_funnel(integer) from public, anon;
grant execute on function crm.acquisition_funnel(integer) to authenticated, service_role;
comment on function crm.acquisition_funnel(integer) is 'Results by the channel of each lead''s FIRST touch, with last-touch and touched-by counts alongside so the views can be compared. Revenue is per currency. A cost with nothing to divide by is null; under ten leads is marked too thin to judge.';

create or replace function crm.acquisition_goal_progress()
returns table (channel text, enabled boolean, paused boolean, qualified_target integer, qualified_this_month bigint, pace_pct integer, on_pace boolean,
               budget_minor bigint, spend_this_month_minor bigint, budget_used_pct integer, days_elapsed integer, days_in_month integer)
language sql stable security definer set search_path = '' as $$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org),
  m as (
    select date_trunc('month', now() at time zone 'utc') at time zone 'utc' as start,
           greatest(1, extract(day from (now() at time zone 'utc'))::integer) as elapsed,
           extract(day from (date_trunc('month', now() at time zone 'utc') + interval '1 month - 1 day'))::integer as total
  ),
  ft as (
    select distinct on (t.lead_id) t.lead_id, crm._acq_channel(t.channel) as ch
      from crm.lead_touchpoints t, caller k where (k.uid is null or t.organization_id = k.org) order by t.lead_id, t.occurred_at, t.recorded_at, t.id
  ),
  q as (
    select ft.ch, count(*)::bigint as n from crm.leads l join ft on ft.lead_id = l.id, m
     where l.qualified_at >= m.start and l.merged_into_lead_id is null group by ft.ch
  ),
  sp as (
    select crm._acq_channel(u.channel) as ch, sum(u.amount)::bigint as s from crm.acquisition_usage u, caller k, m
     where u.metric = 'spend_minor' and u.occurred_at >= m.start and (k.uid is null or u.organization_id = k.org) group by 1
  )
  select c.channel, c.enabled, c.paused, c.monthly_qualified_target, coalesce(q.n, 0)::bigint,
         case when c.monthly_qualified_target is not null and c.monthly_qualified_target > 0
              then round(100.0 * (coalesce(q.n, 0)::numeric * m.total / m.elapsed) / c.monthly_qualified_target)::integer end,
         case when c.monthly_qualified_target is not null and c.monthly_qualified_target > 0
              then (coalesce(q.n, 0)::numeric * m.total / m.elapsed) >= c.monthly_qualified_target * 0.8 end,
         c.monthly_budget_minor, coalesce(sp.s, 0)::bigint,
         case when c.monthly_budget_minor is not null and c.monthly_budget_minor > 0 then round(100.0 * coalesce(sp.s, 0) / c.monthly_budget_minor)::integer end,
         m.elapsed, m.total
    from crm.acquisition_channels c cross join m
    left join q on q.ch = c.channel left join sp on sp.ch = c.channel
   where (select k.uid from caller k) is null or c.organization_id = (select k.org from caller k)
   order by array_position(array['meta_ads', 'email', 'social', 'google_ads', 'b2b'], c.channel);
$$;
revoke all on function crm.acquisition_goal_progress() from public, anon;
grant execute on function crm.acquisition_goal_progress() to authenticated, service_role;
comment on function crm.acquisition_goal_progress() is 'This month''s qualified leads and spend against the Admin''s goal and budget. pace_pct projects the month from the days elapsed; on_pace means the projection is within 80% of the goal. Null when no goal is set - never a guess.';

-- ── what is wrong, in one list ─────────────────────────────────────────────

create or replace function crm.acquisition_failures(p_limit integer default 100)
returns table (kind text, severity text, channel text, ref_id uuid, summary text, since timestamptz, advice text)
language sql stable security definer set search_path = '' as $$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org),
  rows_ as (
    -- executions that failed, stalled, or whose outcome is unknown
    select 'execution_' || e.status as kind,
           case when e.status = 'unknown' or (e.status = 'failed' and e.attempt >= 3) then 'critical' else 'warning' end as severity,
           e.channel as channel, e.id as ref_id,
           e.action_type || ' ' || e.status || ' (attempt ' || e.attempt || ')' as summary, coalesce(e.finished_at, e.started_at) as since,
           case e.status when 'unknown' then 'Check the platform before anything else: it may have gone through. It will not be run again.'
                         else 'A retry is allowed up to three attempts; after that it needs a person.' end as advice
      from crm.governed_executions e, caller k
     where e.status in ('failed', 'unknown') and (k.uid is null or e.organization_id = k.org)
    union all
    select 'execution_stalled', 'critical', e.channel, e.id, e.action_type || ' has been executing for over 10 minutes', e.started_at,
           'Its worker may have died. The next attempt will mark it unknown and ask for a check.'
      from crm.governed_executions e, caller k where e.status = 'executing' and e.started_at < now() - interval '10 minutes' and (k.uid is null or e.organization_id = k.org)
    union all
    -- approved and not applied
    select 'approved_not_applied', 'warning', 'meta_ads', v.id, 'An approved ad change has waited over a day to be applied', v.state_changed_at,
           'No connector applies it automatically yet: apply it by hand exactly as approved.'
      from crm.ad_campaign_versions v join approvals.approval_requests a on a.id = v.approval_request_id, caller k
     where v.state = 'ADMIN_REVIEW' and a.state = 'approved' and v.state_changed_at < now() - interval '1 day' and (k.uid is null or v.organization_id = k.org)
    union all
    select 'approved_not_applied', 'warning', 'google_ads', v.id, 'An approved landing page has waited over a day to be deployed', v.state_changed_at,
           'No deployer exists yet: upload exactly the approved page, then re-check it.'
      from crm.landing_page_versions v join approvals.approval_requests a on a.id = v.approval_request_id, caller k
     where v.state = 'ADMIN_REVIEW' and a.state = 'approved' and v.state_changed_at < now() - interval '1 day' and (k.uid is null or v.organization_id = k.org)
    union all
    select 'approved_not_applied', 'warning', 'b2b', v.id, 'An approved marketplace proposal has waited over a day to be sent', v.state_changed_at,
           'Send it on the platform exactly as approved, then record it.'
      from crm.b2b_proposal_versions v join approvals.approval_requests a on a.id = v.approval_request_id, caller k
     where v.state = 'ADMIN_REVIEW' and a.state = 'approved' and v.state_changed_at < now() - interval '1 day' and (k.uid is null or v.organization_id = k.org)
    union all
    -- pages
    select 'landing_not_verified', 'critical', 'google_ads', v.id, 'A deployed landing page does not match what was approved', v.state_changed_at,
           'Ads cannot launch to it. Check the public address, or redeploy exactly the approved page.'
      from crm.landing_page_versions v, caller k where v.state = 'VERIFY_FAILED' and (k.uid is null or v.organization_id = k.org)
    union all
    select 'landing_not_verified', 'warning', 'google_ads', v.id, 'A deployed landing page has not been verified for over an hour', v.state_changed_at,
           'It is not usable by an ad until the public address has been checked.'
      from crm.landing_page_versions v, caller k where v.state = 'DEPLOYED' and v.state_changed_at < now() - interval '1 hour' and (k.uid is null or v.organization_id = k.org)
    union all
    -- connections
    select 'connection_' || lower(i.status), case when i.status = 'REVOKED' then 'critical' else 'warning' end,
           case i.integration_type when 'ads' then i.provider when 'social' then 'social' when 'marketplace' then 'b2b' when 'directory' then 'b2b' when 'email' then 'email' end,
           i.id, i.provider || ' is ' || lower(i.status) || coalesce(' - ' || i.last_error, ''), coalesce(i.last_failure_at, i.updated_at),
           'Reconnect it under Connections. Work that needs it is refused until it is active.'
      from crm.acquisition_integrations i, caller k where i.status in ('DEGRADED', 'REVOKED') and (k.uid is null or i.organization_id = k.org)
    union all
    -- campaigns
    select 'campaign_' || h.kind, h.severity, c.platform, h.id, h.kind || ' on "' || c.name || '"', h.created_at, h.recommended_action
      from crm.campaign_health_records h join crm.ad_campaigns c on c.id = h.campaign_id, caller k
     where h.severity = 'critical' and h.assessed_on >= (now() at time zone 'utc')::date - 7 and (k.uid is null or h.organization_id = k.org)
    union all
    -- subtasks that failed
    select 'subtask_failed', 'warning', null, s.id, s.kind || ' task failed' || coalesce(': ' || left(s.failure_reason, 120), ''), s.updated_at,
           'It returned to the conversation owner. Re-request it if it is still needed.'
      from crm.subtask_requests s, caller k where s.status = 'FAILED' and s.updated_at >= now() - interval '14 days' and (k.uid is null or s.organization_id = k.org)
    union all
    -- alerts raised by the acquisition workers, not yet acknowledged
    select 'worker_alert', a.severity, case a.source when 'social_publishing' then 'social' when 'ad_operations' then 'meta_ads' when 'landing_pages' then 'google_ads' when 'b2b_operations' then 'b2b' end,
           a.id, a.summary, a.last_seen_at, 'Acknowledge it once it has been dealt with.'
      from core.alerts a, caller k where a.source in ('social_publishing', 'ad_operations', 'landing_pages', 'b2b_operations') and a.acknowledged_at is null and (k.uid is null or a.organization_id = k.org)
    union all
    -- stops in force
    select 'channel_paused', 'info', c.channel, null::uuid, c.channel || ' is paused' || coalesce(': ' || c.pause_reason, ''), c.paused_at, 'Nothing new goes out on it until it is resumed.'
      from crm.acquisition_channels c, caller k where c.paused and (k.uid is null or c.organization_id = k.org)
    union all
    select 'duplicate_reviews_open', 'info', null, null, count(*)::text || ' possible duplicate people are waiting for a decision', min(d.created_at), 'Open Identity and decide each: confirmed, kept separate or dismissed.'
      from crm.duplicate_reviews d, caller k where d.status = 'open' and (k.uid is null or d.organization_id = k.org) having count(*) > 0
  )
  select r.kind, r.severity, r.channel, r.ref_id, r.summary, r.since, r.advice from rows_ r
   order by case r.severity when 'critical' then 0 when 'warning' then 1 else 2 end, r.since desc nulls last
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
revoke all on function crm.acquisition_failures(integer) from public, anon;
grant execute on function crm.acquisition_failures(integer) to authenticated, service_role;
comment on function crm.acquisition_failures(integer) is 'Everything that is wrong across the five engines, critical first. Reading only: a finding changes nothing.';

-- ── advice, never action ───────────────────────────────────────────────────

create or replace function crm.acquisition_recommendations(p_days integer default 90)
returns table (channel text, recommendation text, basis jsonb)
language sql stable security definer set search_path = '' as $$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org),
       f as (select * from crm.acquisition_funnel(p_days)),
       g as (select * from crm.acquisition_goal_progress()),
       -- the actions each channel took in the last 30 days, for THIS organisation only (a session sees its own; the engine sees all)
       act as (select crm._acq_channel(u.channel) as ch, coalesce(sum(u.amount), 0)::bigint as n from crm.acquisition_usage u, caller k
                where u.metric = 'action' and u.occurred_at >= now() - interval '30 days' and (k.uid is null or u.organization_id = k.org) group by 1),
       sib as (select channel, cost_per_qualified_minor from f where channel in ('meta_ads', 'google_ads') and not insufficient_data and cost_per_qualified_minor is not null)
  select r.channel, r.recommendation, r.basis from (
    select g.channel, 'behind_pace_for_the_monthly_goal' as recommendation,
           jsonb_build_object('target', g.qualified_target, 'qualified_so_far', g.qualified_this_month, 'pace_pct', g.pace_pct, 'days_elapsed', g.days_elapsed) as basis
      from g where g.enabled and not g.paused and g.on_pace is false and g.days_elapsed >= 10
    union all
    select g.channel, 'budget_nearly_used', jsonb_build_object('budget_used_pct', g.budget_used_pct, 'days_elapsed', g.days_elapsed, 'days_in_month', g.days_in_month)
      from g where g.budget_used_pct >= 90 and g.days_elapsed < g.days_in_month
    union all
    select s.channel, 'cost_per_qualified_far_above_its_sibling',
           jsonb_build_object('cost_per_qualified_minor', s.cost_per_qualified_minor, 'sibling_minor', (select min(o.cost_per_qualified_minor) from sib o where o.channel <> s.channel))
      from sib s where s.cost_per_qualified_minor > 2 * (select min(o.cost_per_qualified_minor) from sib o where o.channel <> s.channel)
    union all
    select f.channel, 'acting_without_producing_a_lead_check_tracking',
           jsonb_build_object('actions', (select a.n from act a where a.ch = f.channel), 'leads', f.leads)
      from f where f.channel <> 'other' and f.leads = 0 and coalesce((select a.n from act a where a.ch = f.channel), 0) >= 10
    union all
    select f.channel, 'too_early_to_judge', jsonb_build_object('leads', f.leads)
      from f where f.channel <> 'other' and f.leads between 1 and 9
  ) r;
$$;
revoke all on function crm.acquisition_recommendations(integer) from public, anon;
grant execute on function crm.acquisition_recommendations(integer) to authenticated, service_role;
comment on function crm.acquisition_recommendations(integer) is 'Advice with the numbers it rests on. It acts on nothing, and is silent when the sample is too small to judge (it says so instead).';

notify pgrst, 'reload schema';
