-- Independent review fixes (SQL): secret masking that survives underscores and quotes, internal-only gate
-- readers, organisation checks on three definer helpers, and NULL decisions refused by the five Phase 8 doors.

do $mig$
declare
  v_def text; v_new text;
  v_old_mask text := '\m(api[_-]?key|secret|token|password|passwd)[[:space:]]*[=:][[:space:]]*[^[:space:]]{6,}';
  v_new_mask text := $re$[a-z0-9_.-]*(api[_-]?key|secret|token|password|passwd|authtoken)[a-z0-9_.-]*["']?[[:space:]]*[=:][[:space:]]*["']?[^[:space:]"']{6,}$re$;
  v_fn text;
  r record;
begin
  -- 1. mask_secrets
  v_def := pg_get_functiondef('projects.mask_secrets(text)'::regprocedure);
  if position(v_old_mask in v_def) = 0 then raise exception 'mask_secrets: pattern to replace not found'; end if;
  v_new := replace(v_def, v_old_mask, replace(v_new_mask, '''', ''''''));
  execute v_new;

  -- 2. gate readers: a non-service caller must be internal as well as in the organisation.
  -- Parenthesised: `service <> and org-differs or not internal` would refuse the service role.
  for v_fn in select unnest(array['projects.evaluate_maintenance_gates(uuid)', 'projects.maintenance_priority(uuid)',
                                  'projects.maintenance_work_stall_reasons(uuid,timestamptz)', 'finance.maintenance_financial_gate(uuid)']) loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    v_new := regexp_replace(v_def, '(<> ''service_role'' and )(v_[a-z]+\.organization_id is distinct from \(select core\.current_organization_id\(\)\))( then)',
                            '\1(\2 or not coalesce(core.is_internal(), false))\3');
    if v_new = v_def then raise exception '% : organisation guard not found', v_fn; end if;
    execute v_new;
  end loop;

  -- 3. NULL decisions: "null not in (...)" is null, not true, so the guard never fired
  for r in select * from (values
    ('projects.decide_maintenance_release(uuid,text,text)', 'p_decision not in (''approve'', ''reject'')'),
    ('projects.decide_maintenance_plan_cancellation(uuid,text)', 'p_decision not in (''confirm'', ''withdraw'')'),
    ('projects.settle_portal_handover_request(uuid,text,text,text)', 'p_decision not in (''confirmed'', ''declined'')'),
    ('sales.qualify_phase_eight_opportunity(uuid,text,text)', 'p_decision not in (''qualify'', ''close_no_action'')'),
    ('projects.record_maintenance_plan_acceptance(uuid,text,uuid,text,text,text,text)', 'p_decision not in (''accepted'', ''declined'')'),
    ('sales.record_phase_eight_opportunity(uuid,text,text,jsonb,text,text,text,text,text,uuid)', 'p_agent_key not in (''upsell'', ''customer_success'')')
  ) as t(fn, old) loop
    v_def := pg_get_functiondef(r.fn::regprocedure);
    if position(r.old in v_def) = 0 then raise exception '% : null guard text not found (%)', r.fn, r.old; end if;
    execute replace(v_def, r.old, split_part(r.old, ' ', 1) || ' is null or ' || r.old);
  end loop;
end $mig$;

-- 4. definer helpers that read by a caller-supplied id now check the caller's organisation
create or replace function projects.build_config_current_version(p_project_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select c.version from projects.build_configs c join projects.projects pr on pr.id = c.project_id
   where c.project_id = p_project_id and c.current
     and ((select auth.uid()) is null or pr.organization_id = (select core.current_organization_id()))
$$;

create or replace function projects.build_run_config_stale(p_deliverable_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select not exists (
             select 1 from projects.build_runs br
               join projects.deliverable_details dd on dd.deliverable_id = br.deliverable_id and dd.commit_ref = br.commit_ref
              where br.deliverable_id = d.id and br.status = 'succeeded' and br.artifact_sha256 is not null
                and br.fingerprint ->> 'config_version' ~ '^[0-9]{1,6}$' and (br.fingerprint ->> 'config_version')::int >= c.version)
      from projects.deliverables d
      join projects.projects pr on pr.id = d.project_id
      join projects.build_configs c on c.project_id = d.project_id and c.current
     where d.id = p_deliverable_id
       and ((select auth.uid()) is null or pr.organization_id = (select core.current_organization_id()))), false)
$$;

-- a caller reads another organisation's setting as the default, never as that organisation's value
create or replace function projects.p8_setting(p_org uuid, p_key text)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.int_value from projects.phase_eight_settings s
      where s.organization_id = p_org and s.key = p_key
        and ((select auth.uid()) is null or p_org = (select core.current_organization_id()))),
    case p_key
      when 'sla_response_hours_p1' then 4    when 'sla_response_hours_p2' then 8    when 'sla_response_hours_p3' then 24   when 'sla_response_hours_p4' then 72
      when 'sla_resolution_hours_p1' then 24 when 'sla_resolution_hours_p2' then 72 when 'sla_resolution_hours_p3' then 168 when 'sla_resolution_hours_p4' then 336
      when 'health_open_tickets_watch' then 3
      when 'health_open_tickets_at_risk' then 6
      when 'health_sla_breaches_at_risk' then 2
      when 'health_overdue_invoices_at_risk' then 1
      when 'renewal_window_days' then 45
      when 'checkin_post_handover_days' then 7
      when 'checkin_min_gap_days' then 14
    end);
$$;
