-- ═══════════════════════════════════════════════════════════════════════════
-- The week in lead generation is told once - the scheduled digest
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The last unbuilt item of the results area that needs no credential. Once a week, for each organisation that has set lead generation up, one
-- in-app alert (info) says what the CRM counted for the past seven days by first touch, and what is waiting for a person. It reads the same
-- numbers `agent_results` reads; a cost with nothing to divide by is left out, never guessed; fewer than ten leads in a channel is said to be
-- too few to judge. It sends nothing outside the application.
--
-- Told ONCE per ISO week per organisation, whatever the alert's state: the fingerprint is looked up in any state, so acknowledging last
-- Monday's digest does not make this Monday's tick raise it twice.
--
-- Service role only. A signed-in session cannot run it for anyone.

create or replace function crm.run_acquisition_digest(p_now timestamptz default now())
returns table(organizations integer, told integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  v_fp text := 'acquisition-digest:' || to_char(p_now, 'IYYY-"W"IW');
  v_orgs integer := 0;
  v_told integer := 0;
  v_text text;
  v_line text;
  v_wait integer;
  r record;
begin
  if (select auth.uid()) is not null then return query select 0, 0; return; end if;

  for o in select distinct c.organization_id as id from crm.acquisition_channels c loop
    v_orgs := v_orgs + 1;
    if exists (select 1 from core.alerts a where a.organization_id = o.id and a.fingerprint = v_fp) then continue; end if;

    v_text := '';
    for r in select * from crm.agent_results(o.id, 7) loop
      if r.leads > 0 or r.spend_minor > 0 then
        v_line := r.channel || ': ' || r.leads || ' lead' || case when r.leads = 1 then '' else 's' end || ', ' || r.qualified || ' qualified, ' || r.won || ' won'
          || case when r.spend_minor > 0 then ', spend ' || r.spend_minor || ' (minor units)' else '' end
          || case when r.cost_per_qualified_minor is not null then ', cost per qualified ' || r.cost_per_qualified_minor else '' end
          || case when r.insufficient_data then ' (too few leads to judge)' else '' end;
        v_text := v_text || case when v_text = '' then '' else '; ' end || v_line;
      end if;
    end loop;

    select (select count(*) from crm.content_versions v where v.organization_id = o.id and v.state = 'ADMIN_REVIEW')
         + (select count(*) from crm.ad_campaign_versions v where v.organization_id = o.id and v.state = 'ADMIN_REVIEW')
         + (select count(*) from crm.landing_page_versions v where v.organization_id = o.id and v.state = 'ADMIN_REVIEW')
         + (select count(*) from crm.b2b_proposal_versions v where v.organization_id = o.id and v.state = 'ADMIN_REVIEW')
      into v_wait;

    if v_text = '' and v_wait = 0 then continue; end if;   -- nothing happened and nothing waits: no digest is a real answer

    perform core.raise_alert(o.id, 'acquisition', 'info',
      'Lead generation, last 7 days (by first touch): ' || case when v_text = '' then 'no leads or spend recorded' else v_text end
        || '. Waiting for a person to approve: ' || v_wait || '.',
      v_fp);
    v_told := v_told + 1;
  end loop;
  return query select v_orgs, v_told;
end;
$$;
revoke all on function crm.run_acquisition_digest(timestamptz) from public, anon, authenticated;
grant execute on function crm.run_acquisition_digest(timestamptz) to service_role;
