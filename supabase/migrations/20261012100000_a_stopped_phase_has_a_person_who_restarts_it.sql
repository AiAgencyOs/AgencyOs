-- ═══════════════════════════════════════════════════════
-- A stopped Phase 3 has a person who restarts it.
--
-- Phase 3 can stop itself in three ways on purpose: a client request that is new
-- functionality (`scope_escalation`, Master §17), the client revision limit
-- (`revision_limit_escalation`, Master §16 / PM §4.8 - "stop automatic continuation
-- ... continue only after governed human decision"), and a requirement the designer
-- cannot proceed without (`blocked_requirement`). The stops were built, the audit and
-- the alerts were built, and NOTHING ever left them: driving the whole flow found that
-- the only way out of any of the three was SQL. A phase that can stop but not resume is
-- not a control, it is a dead end that looks like one.
--
-- This is the door. It is an ADMIN's decision (owner or ops_admin, re-checked here), it
-- needs a written reason, it states WHICH way the stop was resolved, and it is history:
-- one immutable row per resolution, so the Admin Panel can answer "who let this continue,
-- when, and why". Each resolution leads to exactly one honest state:
--
--   scope_escalation          declined_continue   -> waiting_client  (design continues on the approved scope)
--                             accepted_change     -> screen_definition (the change was accepted; the list is reopened by a person)
--   revision_limit_escalation allow_more_rounds   -> revision        (the limit is raised by 1-3 rounds, recorded)
--                             proceed_with_current-> waiting_client  (no more rounds; the client chooses from what exists)
--   blocked_requirement       requirement_supplied-> screen_definition
--
-- Nothing here designs, sends or approves anything. It only lets the loop run again.
-- ═══════════════════════════════════════════════════════

create table if not exists projects.phase_three_stop_resolutions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id),
  project_id       uuid not null references projects.projects(id),
  phase_three_id   uuid not null references projects.phase_three(id),
  stopped_state    text not null check (stopped_state in ('scope_escalation', 'revision_limit_escalation', 'blocked_requirement')),
  stop_reason      text,
  resolution       text not null check (resolution in ('declined_continue', 'accepted_change', 'allow_more_rounds', 'proceed_with_current', 'requirement_supplied')),
  resumed_state    text not null,
  extra_rounds     int check (extra_rounds is null or extra_rounds between 1 and 3),
  note             text not null check (length(btrim(note)) between 1 and 2000),
  resolved_by      uuid not null references core.users(id),
  created_at       timestamptz not null default now()
);

comment on table projects.phase_three_stop_resolutions is
  'Master sections 16 and 17, PM 4.8. One immutable row per time a person let a stopped Phase 3 continue: which stop, which resolution, why, and who. The history behind "who allowed more rounds?".';

create index if not exists phase_three_stop_resolutions_phase_idx
  on projects.phase_three_stop_resolutions (phase_three_id, created_at desc);

drop trigger if exists org_match_stop_resolutions_phase on projects.phase_three_stop_resolutions;
create trigger org_match_stop_resolutions_phase
  before insert or update of phase_three_id, organization_id on projects.phase_three_stop_resolutions
  for each row execute function core.enforce_parent_org('phase_three_id', 'projects.phase_three');

drop trigger if exists org_match_stop_resolutions_project on projects.phase_three_stop_resolutions;
create trigger org_match_stop_resolutions_project
  before insert or update of project_id, organization_id on projects.phase_three_stop_resolutions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_stop_resolutions on projects.phase_three_stop_resolutions;
create trigger freeze_org_stop_resolutions
  before update of organization_id on projects.phase_three_stop_resolutions
  for each row execute function core.freeze_organization_id();

create or replace function projects.freeze_stop_resolution()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'a resolution of a stopped phase is history and cannot be edited or removed' using errcode = 'P0001';
end;
$$;

drop trigger if exists freeze_stop_resolution on projects.phase_three_stop_resolutions;
create trigger freeze_stop_resolution
  before update or delete on projects.phase_three_stop_resolutions
  for each row execute function projects.freeze_stop_resolution();

alter table projects.phase_three_stop_resolutions enable row level security;
alter table projects.phase_three_stop_resolutions force row level security;

drop policy if exists stop_resolutions_select on projects.phase_three_stop_resolutions;
create policy stop_resolutions_select on projects.phase_three_stop_resolutions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

revoke all on table projects.phase_three_stop_resolutions from public, anon, authenticated;
grant select on projects.phase_three_stop_resolutions to authenticated, service_role;
grant insert on projects.phase_three_stop_resolutions to service_role;

insert into core.event_types (type, description, canonical) values
  ('project.phase_three_stop_resolved',
   'Master sections 16-17 - a person let a stopped Phase 3 (scope escalation, revision limit or blocked requirement) continue, and said why.',
   false)
on conflict (type) do nothing;

create or replace function projects.resolve_phase_three_stop(
  p_phase_three_id uuid,
  p_resolution     text,
  p_note           text,
  p_extra_rounds   int default null
)
returns table (
  -- 'resolved'
  -- refusals: 'no_actor' | 'forbidden' | 'unknown_phase' | 'not_stopped' | 'bad_resolution'
  --           | 'needs_note' | 'needs_extra_rounds'
  outcome       text,
  resumed_state text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_phase  projects.phase_three;
  v_note   text := btrim(coalesce(p_note, ''));
  v_to     text;
  v_extra  int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::text; return;
  end if;

  select p3.* into v_phase from projects.phase_three p3 where p3.id = p_phase_three_id for update;
  if v_phase.id is null then
    return query select 'unknown_phase'::text, null::text; return;
  end if;

  -- A governed human decision: an admin, in this organization, not just anyone who can write.
  if v_phase.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::text; return;
  end if;

  if v_phase.state not in ('scope_escalation', 'revision_limit_escalation', 'blocked_requirement') then
    return query select 'not_stopped'::text, null::text; return;
  end if;

  if v_note = '' then
    return query select 'needs_note'::text, null::text; return;
  end if;

  v_to := case
    when v_phase.state = 'scope_escalation'          and p_resolution = 'declined_continue'    then 'waiting_client'
    when v_phase.state = 'scope_escalation'          and p_resolution = 'accepted_change'      then 'screen_definition'
    when v_phase.state = 'revision_limit_escalation' and p_resolution = 'allow_more_rounds'    then 'revision'
    when v_phase.state = 'revision_limit_escalation' and p_resolution = 'proceed_with_current' then 'waiting_client'
    when v_phase.state = 'blocked_requirement'       and p_resolution = 'requirement_supplied' then 'screen_definition'
    else null
  end;
  if v_to is null then
    return query select 'bad_resolution'::text, null::text; return;
  end if;

  if p_resolution = 'allow_more_rounds' then
    v_extra := p_extra_rounds;
    if v_extra is null or v_extra < 1 or v_extra > 3 then
      return query select 'needs_extra_rounds'::text, null::text; return;
    end if;
  end if;

  insert into projects.phase_three_stop_resolutions
    (organization_id, project_id, phase_three_id, stopped_state, stop_reason, resolution, resumed_state, extra_rounds, note, resolved_by)
  values
    (v_phase.organization_id, v_phase.project_id, v_phase.id, v_phase.state, v_phase.blocked_reason, p_resolution, v_to, v_extra, v_note, v_actor);

  update projects.phase_three
     set state = v_to,
         blocked_reason = null,
         client_revision_limit = case when p_resolution = 'allow_more_rounds' then least(10, client_revision_limit + v_extra) else client_revision_limit end
   where id = v_phase.id;

  perform core.record_audit(
    v_phase.organization_id, 'phase_three.stop_resolved', 'phase_three', v_phase.id,
    jsonb_build_object('state', v_phase.state),
    jsonb_build_object('state', v_to, 'resolution', p_resolution, 'extraRounds', v_extra)
  );

  perform core.emit_event(
    v_phase.organization_id, 'project.phase_three_stop_resolved', 'phase_three', v_phase.id,
    jsonb_build_object('projectId', v_phase.project_id, 'resolution', p_resolution, 'resumedState', v_to)
  );

  return query select 'resolved'::text, v_to;
end;
$$;

comment on function projects.resolve_phase_three_stop(uuid, text, text, int) is
  'Master 16-17, PM 4.8: the governed human decision that lets a stopped Phase 3 continue. Admin only (re-checked here), a written reason is required, the resolution names exactly which way the stop was answered, and it is recorded as history. It designs and sends nothing.';

revoke all on function projects.resolve_phase_three_stop(uuid, text, text, int) from public, anon;
grant execute on function projects.resolve_phase_three_stop(uuid, text, text, int) to authenticated;

notify pgrst, 'reload schema';
