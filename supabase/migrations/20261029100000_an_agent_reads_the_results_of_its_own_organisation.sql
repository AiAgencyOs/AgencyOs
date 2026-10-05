-- ═══════════════════════════════════════════════════════════════════════════
-- An acquisition agent reads the results of ITS organisation (ADM-113)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The results doors (`acquisition_funnel` and friends) answer only a signed-in
-- internal person for their own organisation: the independent review closed a
-- "service role sees every tenant" branch, deliberately. An agent runs on the
-- service role, so it cannot use them, and it must not be given a way to ask
-- about another organisation either.
--
-- This door is the agent's read: service role only (revoked from every request
-- role), one organisation named by the caller, counted from the CRM by first
-- touch exactly as the screen counts it, and a cost with nothing to divide by is
-- null rather than a guess. It writes nothing.

create or replace function crm.agent_results(p_organization_id uuid, p_days integer default 30)
returns table(channel text, leads bigint, qualified bigint, won bigint, spend_minor bigint, cost_per_qualified_minor bigint, insufficient_data boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with win as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365))) as since),
  ok as (select (select auth.uid()) is null and exists (select 1 from core.organizations o where o.id = p_organization_id) as yes),
  leads_w as (
    select l.id, l.qualified_at
      from crm.leads l, win w, ok
     where ok.yes and l.organization_id = p_organization_id and l.created_at >= w.since and l.merged_into_lead_id is null
  ),
  ft as (
    select distinct on (t.lead_id) t.lead_id, crm._acq_channel(t.channel) as ch
      from crm.lead_touchpoints t join leads_w lw on lw.id = t.lead_id
     order by t.lead_id, t.occurred_at, t.recorded_at, t.id
  ),
  per_lead as (
    select lw.id, coalesce(ft.ch, 'other') as ch, lw.qualified_at is not null as q, crm.lead_outcome(lw.id) = 'WON' as w
      from leads_w lw left join ft on ft.lead_id = lw.id
  ),
  spend as (
    select crm._acq_channel(u.channel) as ch, sum(u.amount)::bigint as s
      from crm.acquisition_usage u, win w, ok
     where ok.yes and u.organization_id = p_organization_id and u.metric = 'spend_minor' and u.occurred_at >= w.since
     group by 1
  ),
  chans as (select unnest(array['meta_ads', 'email', 'social', 'google_ads', 'b2b']) as ch)
  select c.ch,
         coalesce(count(p.id), 0)::bigint,
         coalesce(count(p.id) filter (where p.q), 0)::bigint,
         coalesce(count(p.id) filter (where p.w), 0)::bigint,
         coalesce((select s.s from spend s where s.ch = c.ch), 0)::bigint,
         case when count(p.id) filter (where p.q) > 0 and coalesce((select s.s from spend s where s.ch = c.ch), 0) > 0
              then ((select s.s from spend s where s.ch = c.ch) / count(p.id) filter (where p.q))::bigint end,
         coalesce(count(p.id), 0) < 10
    from chans c left join per_lead p on p.ch = c.ch
   group by c.ch
   order by array_position(array['meta_ads', 'email', 'social', 'google_ads', 'b2b'], c.ch);
$$;
revoke all on function crm.agent_results(uuid, integer) from public, anon, authenticated;
grant execute on function crm.agent_results(uuid, integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- A person asks an acquisition agent to do a piece of work
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `core.jobs` accepts an insert from a signed-in session for ONE kind only (requirement extraction), on purpose. So the request is a
-- door: admin-only, one organisation, one of the four agents, a bounded task in the person's own words, refused while the agent is off or
-- every channel it works on is stopped, and queued ONCE per identical task. It queues work; it performs none. The agent that picks it up
-- holds draft / check / submit-for-approval tools and nothing that sends, publishes, launches, deploys, prices or approves.

create or replace function crm.request_agent_task(p_organization_id uuid, p_agent text, p_task text)
returns table(outcome text, job_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task text := btrim(coalesce(p_task, ''));
  v_kind text;
  v_channels text[];
  v_enabled boolean;
  v_open integer := 0;
  c text;
  v_job uuid;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  if (select auth.uid()) is not null and not coalesce((select core.is_internal()), false) then return query select 'forbidden'::text, null::uuid; return; end if;

  select k.kind, k.channels into v_kind, v_channels
    from (values ('ad_manager', 'ads.assist', array['meta_ads', 'google_ads']), ('email_outreach', 'email.assist', array['email']),
                 ('social_media', 'social.assist', array['social']), ('marketplace_opportunity', 'marketplace.assist', array['b2b'])) as k(agent, kind, channels)
   where k.agent = p_agent;
  if v_kind is null then return query select 'unknown_agent'::text, null::uuid; return; end if;
  if length(v_task) not between 5 and 3000 then return query select 'invalid'::text, null::uuid; return; end if;

  select a.enabled into v_enabled from ai.agents a where a.key = p_agent;
  if v_enabled is distinct from true then return query select 'agent_disabled'::text, null::uuid; return; end if;

  foreach c in array v_channels loop
    if crm.acquisition_blocked(p_organization_id, c) is null then v_open := v_open + 1; end if;
  end loop;
  if v_open = 0 then return query select 'stopped'::text, null::uuid; return; end if;

  insert into core.jobs (organization_id, kind, payload, dedupe_key, correlation_id)
  values (p_organization_id, v_kind, jsonb_build_object('task', v_task, 'requestedBy', (select auth.uid())),
          v_kind || ':' || current_date::text || ':' || encode(sha256(convert_to(p_organization_id::text || v_task, 'UTF8')), 'hex'), gen_random_uuid())
  on conflict do nothing
  returning id into v_job;
  if v_job is null then return query select 'already_queued'::text, null::uuid; return; end if;

  perform core.record_audit(p_organization_id, 'agent.task_requested', 'job', v_job, null, jsonb_build_object('agent', p_agent, 'kind', v_kind));
  return query select 'queued'::text, v_job;
end;
$$;
revoke all on function crm.request_agent_task(uuid, text, text) from public, anon;
grant execute on function crm.request_agent_task(uuid, text, text) to authenticated, service_role;
