-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 rest-gaps round 4, step 4 (traceability: docs/phase-1-3-implementation-traceability.md):
--   P1-BLUEPRINT-021 (A15 Negotiation workspace)     one queue of the deals that are being negotiated: rounds, the objection, the version in play, the policy
--                                                    limits, what the approval is waiting on, and the next action
--   P1-BLUEPRINT-035 (A29 Incidents / recovery)      one queue of what needs a person after something went wrong: failed or uncertain agent tasks, security
--                                                    incidents, escalations, dead jobs and an open outage, each with a severity, an age and a runbook key
--
-- Both are READS. They write nothing, change no state and add no table: every row comes from a record that already exists, so the workspace can never disagree
-- with the thing it summarises. The actions on a row (retry, reassign, reconcile, resolve, close) stay behind the doors that already own them; the page only
-- links to or renders those controls. Security-definer, internal members only, scoped to the caller's organization.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A15: the negotiation queue ──────────────────────────────────────────────
create or replace function sales.p1s_negotiation_queue(p_limit integer default 100)
returns table (
  opportunity_id uuid, opportunity_name text, lead_id uuid, stage text,
  proposal_id uuid, proposal_version integer, proposal_status text, total_minor bigint, discount_minor bigint, policy_version text,
  rounds integer, open_objections integer, latest_objection_kind text, latest_concern text, latest_objection_at timestamptz,
  pending_discount_decisions integer, approval_state text, acceptance_unclear boolean, round_cap integer, at_round_cap boolean,
  next_action text, last_activity_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_cap integer;
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then return; end if;
  select nullif(o.settings ->> 'negotiation_max_rounds', '')::integer into v_cap from core.organizations o where o.id = v_org and (o.settings ->> 'negotiation_max_rounds') ~ '^[0-9]+$';
  return query
  with opp as (
    select o.id, o.name, o.lead_id, o.stage
      from sales.opportunities o
     where o.organization_id = v_org and o.stage not in ('won', 'lost')
  ), latest as (
    select distinct on (p.opportunity_id) p.opportunity_id, p.id, p.version, p.status, p.total_minor, p.discount_minor, p.policy_version, p.approval_request_id, p.updated_at
      from sales.proposals p
     where p.organization_id = v_org and p.opportunity_id in (select id from opp)
     order by p.opportunity_id, p.version desc
  ), obj as (
    select ob.lead_id, count(*)::integer as rounds, (count(*) filter (where ob.outcome is null))::integer as open_n, max(ob.created_at) as last_at
      from sales.objections ob where ob.organization_id = v_org group by ob.lead_id
  ), last_obj as (
    select distinct on (ob.lead_id) ob.lead_id, ob.kind, ob.concern, ob.created_at
      from sales.objections ob where ob.organization_id = v_org order by ob.lead_id, ob.created_at desc
  ), dd as (
    select d.proposal_id, count(*)::integer as pending_n from sales.discount_decisions d
     where d.organization_id = v_org and d.status = 'pending_approval' group by d.proposal_id
  ), clar as (
    select c.opportunity_id from sales.p1o_acceptance_clarifications c where c.organization_id = v_org and c.state = 'open'
  ), base as (
    select opp.id as oid, opp.name, opp.lead_id, opp.stage,
           l.id as pid, l.version, l.status as pstatus, l.total_minor, l.discount_minor, l.policy_version,
           coalesce(obj.rounds, 0) as rounds, coalesce(obj.open_n, 0) as open_n,
           lo.kind as lo_kind, lo.concern as lo_concern, lo.created_at as lo_at,
           coalesce(dd.pending_n, 0) as pending_n,
           (select a.state from approvals.approval_requests a where a.id = l.approval_request_id) as astate,
           exists (select 1 from clar where clar.opportunity_id = opp.id) as unclear,
           greatest(l.updated_at, obj.last_at) as activity
      from opp
      left join latest l on l.opportunity_id = opp.id
      left join obj on obj.lead_id = opp.lead_id
      left join last_obj lo on lo.lead_id = opp.lead_id
      left join dd on dd.proposal_id = l.id
  )
  select b.oid, b.name, b.lead_id, b.stage, b.pid, b.version, b.pstatus, b.total_minor, b.discount_minor, b.policy_version,
         b.rounds, b.open_n, b.lo_kind, b.lo_concern, b.lo_at, b.pending_n, b.astate, b.unclear, v_cap,
         (v_cap is not null and b.rounds >= v_cap),
         case
           when b.unclear then 'Ask the client which version they mean; nothing is accepted yet'
           when b.open_n > 0 then 'Answer the open objection'
           when b.pending_n > 0 then 'A discount is waiting for approval'
           when b.pstatus = 'draft' then 'Finish the draft and submit it'
           when b.pstatus = 'pending_approval' then 'Waiting for the quotation approval'
           when b.pstatus = 'approved' then 'Send the approved quotation'
           when b.pstatus = 'sent' then 'Waiting for the client'
           when b.pstatus = 'lapsed' then 'The quotation lapsed: re-issue it or close the deal'
           when b.pstatus = 'accepted' then 'Accepted: record the payment and hand over'
           when b.pstatus is null then 'No quotation yet'
           else 'Review the deal'
         end,
         b.activity
    from base b
   where b.rounds > 0 or b.pstatus in ('sent', 'pending_approval', 'approved', 'lapsed') or b.stage = 'negotiation'
   order by (b.open_n > 0 or b.unclear) desc, b.activity desc nulls last
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;
revoke all on function sales.p1s_negotiation_queue(integer) from public, anon;
grant execute on function sales.p1s_negotiation_queue(integer) to authenticated, service_role;

-- ── A29: the incident / recovery queue ──────────────────────────────────────
create or replace function ai.p1s_incident_queue(p_include_closed boolean default false, p_limit integer default 200)
returns table (
  incident_key text, source text, source_id uuid, source_task_id uuid, severity text, title text, state text, owner_label text,
  opened_at timestamptz, age_minutes integer, uncertain_side_effect boolean, outage_provider text, runbook_key text, detail text, correlation_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then return; end if;
  return query
  with h as (
    -- agent tasks that failed for good, were refused, or may have done something we cannot see; a task a person already reconciled is not uncertain
    select 'handoff:' || x.id::text as k, 'task'::text as src, x.id as sid, x.id as tid,
           case when x.side_effect_uncertain or x.priority in ('urgent', 'high') then 'high' else 'medium' end as sev,
           left(x.objective, 160) as ttl,
           case when x.status in ('completed', 'cancelled') then 'closed' else 'open' end as st,
           (x.from_agent || ' -> ' || x.to_agent) as owner,
           x.created_at as at, x.side_effect_uncertain as unc, null::text as prov,
           case when x.side_effect_uncertain then 'uncertain_side_effect' when x.status = 'rejected' then 'task_rejected' else 'task_failed' end as rb,
           left(coalesce(x.blocker, x.previous_failure_summary, x.status), 300) as det, x.correlation_id as corr
      from ai.handoffs x
     where x.organization_id = v_org
       and ((x.side_effect_uncertain and x.status not in ('completed', 'cancelled'))
         or (x.status in ('failed_permanent', 'rejected') and (p_include_closed or x.created_at > now() - interval '14 days')))
  ), s as (
    select 'security:' || i.id::text, 'security'::text, i.id, null::uuid,
           i.severity, left(i.summary, 160),
           case when i.resolved_at is null then 'open' else 'closed' end,
           coalesce((select u.email from core.users u where u.id = i.opened_by), 'unassigned'),
           i.opened_at, false, null::text, 'security_incident', left(i.kind, 300), null::uuid
      from security.incidents i
     where i.organization_id = v_org and (i.resolved_at is null or p_include_closed)
  ), e as (
    select 'escalation:' || x.id::text, 'escalation'::text, x.id, null::uuid,
           'medium', left(x.title, 160),
           case when x.state = 'resolved' then 'closed' else 'open' end,
           'to ' || x.to_role,
           x.created_at, false, null::text, 'escalation', left(x.reason, 300), null::uuid
      from core.escalations x
     where x.organization_id = v_org and (x.state <> 'resolved' or p_include_closed)
  ), j as (
    select 'job:' || x.id::text, 'job'::text, x.id, null::uuid,
           'medium', left(x.kind, 160), 'open', 'job runner',
           x.updated_at, false, null::text, 'dead_job', left(coalesce(x.last_error, 'out of attempts'), 300), x.correlation_id
      from core.jobs x
     where x.organization_id = v_org and x.status = 'dead' and x.updated_at > now() - interval '14 days'
  ), o as (
    select 'outage:' || b.provider, 'outage'::text, b.id, null::uuid,
           'high', ('Provider "' || b.provider || '" is ' || case when b.state = 'open' then 'unavailable (circuit open)' else 'being probed' end),
           'open', 'circuit breaker',
           coalesce(b.opened_at, b.updated_at), false, b.provider, 'provider_outage',
           left(coalesce(b.forced_reason, b.last_error_class, 'repeated failures'), 300), null::uuid
      from core.p13_circuit_breakers b
     where b.organization_id = v_org and b.state <> 'closed'
  ), u as (
    select * from h union all select * from s union all select * from e union all select * from j union all select * from o
  )
  select u.k, u.src, u.sid, u.tid, u.sev, u.ttl, u.st, u.owner, u.at, (extract(epoch from (now() - u.at)) / 60)::integer, u.unc, u.prov, u.rb, u.det, u.corr
    from u
   order by (u.st = 'open') desc,
            case u.sev when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
            u.at desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;
revoke all on function ai.p1s_incident_queue(boolean, integer) from public, anon;
grant execute on function ai.p1s_incident_queue(boolean, integer) to authenticated, service_role;
