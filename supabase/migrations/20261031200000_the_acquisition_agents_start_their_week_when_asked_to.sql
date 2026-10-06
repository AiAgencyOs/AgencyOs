-- ═══════════════════════════════════════════════════════════════════════════
-- The acquisition agents start their week when the owner has asked them to - the weekly autopilot (ADM-114)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The owner asked for the agents to do the analysing themselves. What that means here, and what it does not:
--
--   * OPT-IN, per organisation, by an admin, off until then (`crm.set_acquisition_autopilot`).
--   * Once a week, from Monday 09:00 in the organisation's own timezone, each ENABLED agent whose channel is in the plan and not stopped is
--     given one standing task: read the results, judge by qualified leads and won deals, and prepare drafts for a person to approve.
--     It queues the same job a person's "Ask the agent" queues (`ads.assist`, `email.assist`, `social.assist`, `marketplace.assist`), so every
--     guard those jobs have applies unchanged: the agent's own tools (draft, score, check, submit-for-approval; nothing that sends, publishes,
--     launches, deploys, prices or approves), the owner's tool permissions, the emergency stops, the cost ceilings.
--   * ONCE per agent per ISO week, whatever the clock does: the job's dedupe key carries the week.
--   * Nothing here can make anything happen on a platform. A person still approves every exact version.
--
-- Service role only. A signed-in session cannot run it for anyone.

create table if not exists crm.acquisition_autopilot (
  organization_id uuid primary key references core.organizations(id) on delete cascade,
  enabled boolean not null default false,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table crm.acquisition_autopilot is
  'Whether the acquisition agents are given a standing weekly task (Monday 09:00 in the organisation''s timezone). Off until an admin turns it on. Queues drafts for approval only.';

drop trigger if exists freeze_org_acquisition_autopilot on crm.acquisition_autopilot;
create trigger freeze_org_acquisition_autopilot
  before update of organization_id on crm.acquisition_autopilot
  for each row execute function core.freeze_organization_id();
drop trigger if exists set_updated_at on crm.acquisition_autopilot;
create trigger set_updated_at before update on crm.acquisition_autopilot
  for each row execute function core.set_updated_at();

alter table crm.acquisition_autopilot enable row level security;
alter table crm.acquisition_autopilot force row level security;
drop policy if exists acquisition_autopilot_select on crm.acquisition_autopilot;
create policy acquisition_autopilot_select on crm.acquisition_autopilot
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.acquisition_autopilot from public, anon, authenticated;
grant select on crm.acquisition_autopilot to authenticated;
grant select, insert, update on crm.acquisition_autopilot to service_role;

create or replace function crm.set_acquisition_autopilot(p_organization_id uuid, p_enabled boolean)
returns table(outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before boolean;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text; return; end if;
  if (select auth.uid()) is not null and not coalesce((select core.is_internal()), false) then return query select 'forbidden'::text; return; end if;
  if p_enabled is null then return query select 'invalid'::text; return; end if;
  if not exists (select 1 from core.organizations o where o.id = p_organization_id) then return query select 'not_found'::text; return; end if;

  select a.enabled into v_before from crm.acquisition_autopilot a where a.organization_id = p_organization_id;
  insert into crm.acquisition_autopilot (organization_id, enabled, changed_by, changed_at)
  values (p_organization_id, p_enabled, (select auth.uid()), now())
  on conflict (organization_id) do update set enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = now();

  perform core.record_audit(p_organization_id, 'agent.autopilot_' || case when p_enabled then 'enabled' else 'disabled' end, 'organization', p_organization_id,
    jsonb_build_object('enabled', coalesce(v_before, false)), jsonb_build_object('enabled', p_enabled));
  return query select 'saved'::text;
end;
$$;
revoke all on function crm.set_acquisition_autopilot(uuid, boolean) from public, anon;
grant execute on function crm.set_acquisition_autopilot(uuid, boolean) to authenticated, service_role;

create or replace function crm.run_acquisition_autopilot(p_now timestamptz default now())
returns table(organizations integer, queued integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  a record;
  v_tz text;
  v_local timestamp;
  v_week text;
  v_orgs integer := 0;
  v_queued integer := 0;
  v_open integer;
  c text;
  v_job uuid;
begin
  if (select auth.uid()) is not null then return query select 0, 0; return; end if;

  for o in select p.organization_id as id, g.timezone from crm.acquisition_autopilot p join core.organizations g on g.id = p.organization_id where p.enabled loop
    v_orgs := v_orgs + 1;
    v_tz := coalesce(nullif(o.timezone, ''), 'UTC');
    if not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = v_tz) then v_tz := 'UTC'; end if;
    v_local := p_now at time zone v_tz;
    -- the week opens Monday 09:00 local; a tick that comes late in the week still starts it (the dedupe key makes it once)
    if extract(isodow from v_local) = 1 and extract(hour from v_local) < 9 then continue; end if;
    v_week := to_char(v_local, 'IYYY-"W"IW');

    for a in
      select * from (values
        ('ad_manager', 'ads.assist', array['meta_ads', 'google_ads'],
         'Weekly review. Read the results and the campaigns and landing pages first. Judge channels by qualified leads and won deals, not clicks. If one of your own drafts failed its check, draft a corrected next version of it and check again. If nothing is live or waiting for approval and the data supports a change, draft ONE improved campaign version. Submit for approval only what passes its check. Report what the numbers say, what you drafted, and what a person must decide. If there is too little data to judge, say so and change nothing.'),
        ('email_outreach', 'email.assist', array['email'],
         'Weekly review. Read the prospects, their recorded facts and the results. For a prospect that has facts but no score, score it with only the factors those facts support. Record a new fact only from a public page you can cite. Do not invent a prospect or a fact. Report who is ready for a person to approve outreach, who needs more research, and what a person must decide. If there are no prospects, say so.'),
        ('social_media', 'social.assist', array['social'],
         'Weekly review. Read the content queue and the results first, so you do not repeat a post that is already waiting or published. Draft up to three posts for the coming week, each with one objective and a different format, tied to the active target services and the ICP. Run the review on each, fix what it names, and submit only those that pass. Report what you drafted and what a person must approve.'),
        ('marketplace_opportunity', 'marketplace.assist', array['b2b'],
         'Weekly review. Read the opportunities, their scores and their proposals. Report which shortlisted opportunities have no proposal draft yet and, for those a person shortlisted, draft a tailored proposal with no price, check it and submit it if it passes. Never record an opportunity you were not given. Report what a person must decide (shortlisting, price, sending).')
      ) as t(agent, kind, channels, task)
    loop
      if not exists (select 1 from ai.agents g where g.key = a.agent and g.enabled) then continue; end if;
      v_open := 0;
      foreach c in array a.channels loop
        if crm.acquisition_blocked(o.id, c) is null
           and exists (select 1 from crm.acquisition_channels ch where ch.organization_id = o.id and ch.channel = c and ch.enabled) then
          v_open := v_open + 1;
        end if;
      end loop;
      if v_open = 0 then continue; end if;

      insert into core.jobs (organization_id, kind, payload, dedupe_key, correlation_id)
      values (o.id, a.kind, jsonb_build_object('task', a.task, 'requestedBy', null, 'autopilot', true),
              'autopilot:' || a.kind || ':' || v_week || ':' || o.id::text, gen_random_uuid())
      on conflict do nothing
      returning id into v_job;
      if v_job is not null then
        v_queued := v_queued + 1;
        perform core.record_audit(o.id, 'agent.autopilot_queued', 'job', v_job, null, jsonb_build_object('agent', a.agent, 'kind', a.kind, 'week', v_week));
        v_job := null;
      end if;
    end loop;
  end loop;
  return query select v_orgs, v_queued;
end;
$$;
revoke all on function crm.run_acquisition_autopilot(timestamptz) from public, anon, authenticated;
grant execute on function crm.run_acquisition_autopilot(timestamptz) to service_role;
