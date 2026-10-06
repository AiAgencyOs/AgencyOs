-- P6-DEF-02: Triage, Assigned and In progress are distinct states of an OPEN product defect. They are a work_state beside the status machine, not
-- new statuses: every gate that reads status (unresolved_product_defects, blocking_defects, readiness) keeps meaning what it meant.
alter table qa.defects
  add column if not exists work_state text not null default 'triage' check (work_state in ('triage', 'assigned', 'in_progress')),
  add column if not exists assigned_to uuid references core.users(id) on delete set null,
  add column if not exists assigned_at timestamptz,
  add column if not exists work_started_at timestamptz;
alter table qa.defects drop constraint if exists defects_work_state_shape;
alter table qa.defects add constraint defects_work_state_shape check (work_state = 'triage' or assigned_to is not null);

-- a defect that comes back to open (a failed retest, a regression) is assigned again to whoever had it, or back in triage
create or replace function qa.defects_work_state_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'open' and old.status <> 'open' then
    new.work_state := case when new.assigned_to is not null then 'assigned' else 'triage' end;
    new.work_started_at := null;
  end if;
  return new;
end $$;
drop trigger if exists defects_work_state_guard on qa.defects;
create trigger defects_work_state_guard before update of status on qa.defects for each row execute function qa.defects_work_state_guard();

-- people may not set the work state by hand: the doors do
create or replace function qa.defects_direct_write_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.status is distinct from 'open' or new.work_state is distinct from 'triage' or new.assigned_to is not null then
        raise exception 'a defect is raised open and in triage; it is moved by the fix, assignment and retest doors' using errcode = 'restrict_violation';
      end if;
    elsif new.severity is distinct from old.severity
       or new.s_level is distinct from old.s_level
       or new.classification is distinct from old.classification
       or new.duplicate_of is distinct from old.duplicate_of
       or new.phase6 is distinct from old.phase6
       or new.triage_reason is distinct from old.triage_reason
       or new.work_state is distinct from old.work_state
       or new.assigned_to is distinct from old.assigned_to then
      raise exception 'a defect is classified, graded, de-duplicated and assigned through its doors, which record who and why' using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;

create or replace function qa.assign_defect(p_defect_id uuid, p_assignee uuid default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d qa.defects; v_to uuid;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org for update;
  if v_d.id is null then return query select 'not_found'::text; return; end if;
  if v_d.status <> 'open' then return query select 'not_open'::text; return; end if;
  if v_d.classification <> 'product_defect' then return query select 'not_a_product_defect'::text; return; end if;
  v_to := coalesce(p_assignee, v_actor);
  if not exists (select 1 from core.memberships m where m.organization_id = v_org and m.user_id = v_to) then return query select 'assignee_not_in_organization'::text; return; end if;
  update qa.defects set assigned_to = v_to, assigned_at = now(), work_state = 'assigned', work_started_at = null where id = v_d.id;
  perform core.record_audit(v_org, 'defect.assigned', 'defect', v_d.id, null, jsonb_build_object('assignee', v_to));
  return query select 'assigned'::text;
end $$;
revoke all on function qa.assign_defect(uuid, uuid) from public, anon;
grant execute on function qa.assign_defect(uuid, uuid) to authenticated;

create or replace function qa.start_defect_work(p_defect_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d qa.defects;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org for update;
  if v_d.id is null then return query select 'not_found'::text; return; end if;
  if v_d.status <> 'open' then return query select 'not_open'::text; return; end if;
  if v_d.work_state = 'in_progress' then return query select 'already_in_progress'::text; return; end if;
  if v_d.work_state <> 'assigned' then return query select 'not_assigned'::text; return; end if;
  -- the assignee starts it; a delivery manager may start it on their behalf
  if v_d.assigned_to is distinct from v_actor and not coalesce((select core.can_manage_delivery()), false) then return query select 'not_the_assignee'::text; return; end if;
  update qa.defects set work_state = 'in_progress', work_started_at = now() where id = v_d.id;
  perform core.record_audit(v_org, 'defect.work_started', 'defect', v_d.id, null, null);
  return query select 'started'::text;
end $$;
revoke all on function qa.start_defect_work(uuid) from public, anon;
grant execute on function qa.start_defect_work(uuid) to authenticated;
notify pgrst, 'reload schema';
