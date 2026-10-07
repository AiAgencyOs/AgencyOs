-- ═════════════════════════════════════════════════════════════════
-- Phase 8D: Phase 8 observability: counts and ages from the existing 8A tables, read-only.
--
-- projects.phase_eight_observability(now) returns one row per (metric, bucket): how many, and the oldest timestamp in the bucket (so the page can show an
-- age). It writes nothing, stores nothing and computes no new status: health is the existing derived read, SLA state is the existing support_sla_state,
-- stages are the stored statuses. Internal staff of the caller's organization only.
--
--   tickets_by_state         support_tickets by status                      oldest = raised_at
--   tickets_by_sla           open tickets by resolution SLA state           oldest = raised_at   (running / breached / not_started)
--   tickets_by_response_sla  open tickets by response SLA state             oldest = raised_at
--   health_distribution      live Phase 8 workspaces by DERIVED health      oldest = workspace started_at
--   recovery_plans           open and in-progress recovery plans by status  oldest = created_at
--   renewals_due             maintenance plans by renewal status            oldest = ends_on
--   opportunities_by_stage   Phase 8 opportunities by stored status         oldest = created_at
-- ═════════════════════════════════════════════════════════════════

create or replace function projects.phase_eight_observability(p_now timestamptz default clock_timestamp())
returns table (metric text, bucket text, n int, oldest_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;

  return query select 'tickets_by_state'::text, t.status, count(*)::int, min(t.raised_at)
    from projects.support_tickets t where t.organization_id = v_org group by t.status;

  return query select 'tickets_by_sla'::text, s.resolution_state, count(*)::int, min(t.raised_at)
    from projects.support_tickets t cross join lateral projects.support_sla_state(t.id, p_now) s
   where t.organization_id = v_org and t.status not in ('closed', 'cancelled') group by s.resolution_state;

  return query select 'tickets_by_response_sla'::text, s.response_state, count(*)::int, min(t.raised_at)
    from projects.support_tickets t cross join lateral projects.support_sla_state(t.id, p_now) s
   where t.organization_id = v_org and t.status not in ('closed', 'cancelled') group by s.response_state;

  return query select 'health_distribution'::text, h.status, count(*)::int, min(w.started_at)
    from projects.phase_eight w cross join lateral projects.customer_health_status(w.project_id, p_now) h
   where w.organization_id = v_org and w.state <> 'closed' group by h.status;

  return query select 'recovery_plans'::text, r.status, count(*)::int, min(r.created_at)
    from projects.recovery_plans r where r.organization_id = v_org and r.status in ('open', 'in_progress') group by r.status;

  return query select 'renewals_due'::text, m.status, count(*)::int, min(m.ends_on)::timestamptz
    from projects.maintenance_plans m where m.organization_id = v_org and m.status in ('renewal_approaching', 'renewal_proposed', 'pending_client', 'expired') group by m.status;

  return query select 'opportunities_by_stage'::text, o.status, count(*)::int, min(o.created_at)
    from sales.phase_eight_opportunities o where o.organization_id = v_org group by o.status;
end $$;
revoke all on function projects.phase_eight_observability(timestamptz) from public, anon, service_role;
grant execute on function projects.phase_eight_observability(timestamptz) to authenticated;

notify pgrst, 'reload schema';
